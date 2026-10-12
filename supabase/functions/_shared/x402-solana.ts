import { PublicKey, TransactionMessage, VersionedTransaction } from 'npm:@solana/web3.js@1.98.1'
import { getAssociatedTokenAddressSync } from 'npm:@solana/spl-token@0.4.14'
import { Buffer } from 'node:buffer'
import bs58 from 'npm:bs58@6.0.0'
import { SOLANA_DEVNET_GENESIS, SOLANA_TEST_USDC, TOKEN_PROGRAM } from './solana-payment-rules.ts'
import { assertX402Transaction, sameJson, x402FinalizedEvidence, type X402Purchase, type X402Transaction } from './x402-payment-rules.ts'

export async function x402Rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const endpoint = new URL(Deno.env.get('CRYPTO_SOLANA_DEVNET_RPC_URL') || '')
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('x402_not_configured')
  const key = Deno.env.get('CRYPTO_SOLANA_DEVNET_RPC_API_KEY')
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  if (!response.ok) throw new Error('rpc_unavailable')
  const body = await response.json()
  if (body.error || !Object.hasOwn(body, 'result')) throw new Error('rpc_unavailable')
  return body.result as T
}
export async function x402CheckNetwork() {
  if (await x402Rpc<string>('getGenesisHash') !== SOLANA_DEVNET_GENESIS) throw new Error('wrong_network')
}
export function x402Accounts(payerAddress: string, recipientAddress: string) {
  const payer = new PublicKey(payerAddress), recipient = new PublicKey(recipientAddress), mint = new PublicKey(SOLANA_TEST_USDC)
  if (!PublicKey.isOnCurve(payer.toBytes()) || !PublicKey.isOnCurve(recipient.toBytes()) || payer.equals(recipient)) throw new Error('x402_quote_invalid')
  return { source: getAssociatedTokenAddressSync(mint, payer).toBase58(), destination: getAssociatedTokenAddressSync(mint, recipient).toBase58() }
}
export async function x402CheckAccounts(payer: string, recipient: string) {
  const accounts = x402Accounts(payer, recipient)
  const result = await x402Rpc<{ value: Array<{ owner: string; data: { parsed?: { type: string; info: Record<string, unknown> } } } | null> }>(
    'getMultipleAccounts', [[SOLANA_TEST_USDC, accounts.source, accounts.destination], { encoding: 'jsonParsed', commitment: 'finalized' }])
  const [mint, source, destination] = result.value
  if (mint?.owner !== TOKEN_PROGRAM || mint.data.parsed?.type !== 'mint' || mint.data.parsed.info.decimals !== 6
    || mint.data.parsed.info.isInitialized !== true) throw new Error('x402_asset_unavailable')
  for (const [account, owner] of [[source, payer], [destination, recipient]] as const) {
    const info = account?.data.parsed?.info
    if (account?.owner !== TOKEN_PROGRAM || account.data.parsed?.type !== 'account'
      || info?.mint !== SOLANA_TEST_USDC || info.owner !== owner || info.state !== 'initialized') {
      throw new Error('x402_token_account_unavailable')
    }
  }
  // Rent/ATA creation is explicitly outside sponsorship: both ATAs must exist.
  return accounts
}

export function decodeX402Transaction(base64: string): { tx: VersionedTransaction; shape: X402Transaction } {
  if (typeof base64 !== 'string' || base64.length > 1644 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('x402_transaction_invalid')
  try {
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.length > 1232 || bytes.toString('base64') !== base64) throw new Error()
    const tx = VersionedTransaction.deserialize(bytes)
    if (tx.version !== 0 || tx.message.addressTableLookups.length || !Buffer.from(tx.serialize()).equals(bytes)) throw new Error()
    const message = TransactionMessage.decompile(tx.message)
    const count = tx.message.header.numRequiredSignatures
    const keys = tx.message.staticAccountKeys.slice(0, count)
    return { tx, shape: { version: tx.version, hasLookups: false, feePayer: message.payerKey.toBase58(),
      signers: keys.map(key => key.toBase58()), publicKeys: keys.map(key => key.toBytes()), signatures: tx.signatures,
      accountKeys: tx.message.staticAccountKeys.map(key => key.toBase58()),
      message: tx.message.serialize(), instructions: message.instructions.map(ix => ({ programId: ix.programId.toBase58(),
        keys: ix.keys.map(key => key.pubkey.toBase58()), data: ix.data })) } }
  } catch { throw new Error('x402_transaction_invalid') }
}
export async function x402MessageHash(message: Uint8Array): Promise<string> {
  return Buffer.from(await crypto.subtle.digest('SHA-256', new Uint8Array(message).buffer)).toString('hex')
}
export async function validateX402Payment(base64: string, purchase: X402Purchase) {
  const parsed = decodeX402Transaction(base64)
  const accounts = x402Accounts(purchase.payer, purchase.recipient)
  if (accounts.source !== purchase.source_token_account || accounts.destination !== purchase.recipient_token_account) throw new Error('x402_quote_invalid')
  if (purchase.payment_requirements.extra.fundingMode === 'printkub'
    && x402Accounts(String(purchase.payment_requirements.extra.feePayer), purchase.payer).source !== purchase.payment_requirements.extra.fundingSource) {
    throw new Error('x402_quote_invalid')
  }
  await assertX402Transaction(parsed.shape, purchase)
  return { ...parsed, messageHash: await x402MessageHash(parsed.shape.message) }
}

interface RawReceipt {
  slot: number; transaction: [string, string]
  meta: { err: unknown; postTokenBalances?: Array<{ accountIndex: number; mint: string; owner?: string }> } | null
}
// Correlate the fully sponsor-signed transaction with the persisted agent proof.
// The agent's signature is NOT the Solana transaction id (the sponsor signs first).
export async function x402Receipt(receipt: RawReceipt, signature: string, partialBase64: string, purchase: X402Purchase) {
  if (!receipt.meta || !Object.hasOwn(receipt.meta, 'err') || receipt.transaction?.[1] !== 'base64'
    || !Number.isSafeInteger(receipt.slot) || receipt.slot < 0) throw new Error('x402_receipt_invalid')
  const full = decodeX402Transaction(receipt.transaction[0]), partial = await validateX402Payment(partialBase64, purchase)
  return await x402FinalizedEvidence(full.shape, partial.shape, purchase, signature, bs58.decode(signature), receipt.slot, receipt.meta)
}

export async function lookupX402Receipt(signature: string): Promise<RawReceipt | null> {
  return await x402Rpc<RawReceipt | null>('getTransaction', [signature, { encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0 }])
}
// Bounded deterministic recovery after a lost provider tx id. Missing history
// never releases a reservation; further scans/background work belong to chunk 5.
export async function correlateX402Receipt(partialBase64: string, purchase: X402Purchase) {
  const partial = decodeX402Transaction(partialBase64)
  let before: string | undefined
  for (let page = 0; page < 3; page++) {
    const rows = await x402Rpc<Array<{ signature: string; memo: string | null }>>('getSignaturesForAddress',
      [purchase.source_token_account, { commitment: 'finalized', limit: 100, ...(before ? { before } : {}) }])
    for (const row of rows) {
      // RPC memo text can have a length prefix. It is only a search hint; the
      // actual message and both signatures must match before saving identity.
      if (!row.memo?.includes(`printkub-x402:${purchase.quote_id}`)) continue
      const receipt = await lookupX402Receipt(row.signature)
      if (!receipt) continue
      try {
        const full = decodeX402Transaction(receipt.transaction[0])
        if (!sameJson([...full.shape.message], [...partial.shape.message])) continue
        await x402Receipt(receipt, row.signature, partialBase64, purchase)
        return { signature: row.signature, receipt }
      } catch { /* unrelated transaction is never recorded as this purchase */ }
    }
    if (rows.length < 100) break
    before = rows[rows.length - 1].signature
  }
  return null
}
