import { MEMO_PROGRAM, TOKEN_PROGRAM, SOLANA_DEVNET_NETWORK, SOLANA_TEST_USDC } from './solana-payment-rules.ts'

export interface X402Requirements {
  scheme: string; network: string; asset: string; amount: string; payTo: string
  maxTimeoutSeconds: number; extra: Record<string, unknown>
}
export interface X402Purchase {
  grant_id: string; quote_id: string; order_no: string; payer: string; source_token_account: string
  recipient: string; recipient_token_account: string; network: string; mint: string; amount_atomic: string
  resource_url: string; payment_requirements: X402Requirements; grant_status: string; expires_at: string
  attempt: { id: string; status: string; idempotency_key: string; signature: string | null } | null
}
export interface X402Instruction {
  programId: string; keys: string[]; data: Uint8Array
}
export interface X402Transaction {
  version: number | 'legacy'; hasLookups: boolean; feePayer: string; signers: string[]
  publicKeys: Uint8Array[]; signatures: Uint8Array[]; message: Uint8Array; instructions: X402Instruction[]
  accountKeys: string[]
}
const COMPUTE = 'ComputeBudget111111111111111111111111111111'

export function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => sameJson(value, right[index]))
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
}

export function x402Sponsor(supported: unknown): string {
  const kinds = (supported as { kinds?: Array<{ x402Version?: number; scheme?: string; network?: string; extra?: { feePayer?: unknown } }> })?.kinds
  const matches = Array.isArray(kinds) ? kinds.filter(kind => kind?.x402Version === 2 && kind.scheme === 'exact' && kind.network === SOLANA_DEVNET_NETWORK) : []
  const sponsors = [...new Set(matches.map(kind => kind.extra?.feePayer))]
  if (sponsors.length !== 1 || typeof sponsors[0] !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(sponsors[0])) {
    throw new Error('x402_capability_unavailable')
  }
  return sponsors[0]
}

export function assertX402Requirements(p: X402Purchase): void {
  const r = p.payment_requirements
  const funded = r.extra.fundingMode === 'printkub'
  if (p.network !== SOLANA_DEVNET_NETWORK || p.mint !== SOLANA_TEST_USDC || !/^[1-9][0-9]{0,18}$/.test(p.amount_atomic)
    || BigInt(p.amount_atomic) > BigInt('9223372036854775807') || p.payer === p.recipient
    || r.scheme !== 'exact' || r.network !== p.network || r.asset !== p.mint || r.amount !== p.amount_atomic
    || r.payTo !== p.recipient || r.maxTimeoutSeconds !== 60
    || typeof r.extra.feePayer !== 'string' || r.extra.feePayer === p.payer
    || r.extra.memo !== `printkub-x402:${p.quote_id}`
    || (r.extra.sponsorMode !== undefined && r.extra.sponsorMode !== 'printkub')
    || (r.extra.sponsorMode === 'printkub' && !['agent', 'printkub'].includes(String(r.extra.fundingMode)))
    || (r.extra.sponsorMode === undefined && (r.extra.fundingMode !== undefined || r.extra.fundingSource !== undefined))
    || (funded && (r.extra.sponsorMode !== 'printkub' || r.extra.feePayer === p.recipient
      || typeof r.extra.fundingSource !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.extra.fundingSource)
      || r.extra.fundingSource === p.source_token_account || r.extra.fundingSource === p.recipient_token_account))
    || (!funded && r.extra.fundingSource !== undefined)) throw new Error('x402_quote_invalid')
}

export function assertX402Payload(payload: unknown, p: X402Purchase): string {
  assertX402Requirements(p)
  const value = payload as { x402Version?: unknown; accepted?: unknown; resource?: { url?: unknown }; payload?: { transaction?: unknown }; extensions?: unknown }
  if (!value || value.x402Version !== 2 || !sameJson(value.accepted, p.payment_requirements)
    || value.resource?.url !== p.resource_url || value.extensions !== undefined
    || !value.payload || Object.keys(value.payload).length !== 1 || typeof value.payload.transaction !== 'string') {
    throw new Error('x402_payload_mismatch')
  }
  return value.payload.transaction
}

function unsignedLE(bytes: Uint8Array): bigint {
  return [...bytes].reverse().reduce((value, byte) => value * BigInt(256) + BigInt(byte), BigInt(0))
}
// Deliberately narrower than general exact-SVM: v0, no ALTs/CPI/wallet-injected
// instructions, two signers and purchase memo. PrintKub funding adds exactly
// one treasury TransferChecked immediately before the merchant transfer.
export async function assertX402Transaction(tx: X402Transaction, p: X402Purchase, fullySigned = false): Promise<void> {
  assertX402Requirements(p)
  const sponsor = p.payment_requirements.extra.feePayer
  const funded = p.payment_requirements.extra.fundingMode === 'printkub'
  if (tx.version !== 0 || tx.hasLookups || tx.feePayer !== sponsor || tx.signers.length !== 2
    || tx.signers[0] !== sponsor || tx.signers[1] !== p.payer || tx.signatures.length !== 2
    || tx.publicKeys.length !== 2 || tx.instructions.length !== (funded ? 5 : 4)
    || tx.instructions.some((ix, index) => ix.programId === sponsor
      || (ix.keys.includes(String(sponsor)) && !(funded && index === 2)))) throw new Error('x402_transaction_invalid')
  const [limit, price] = tx.instructions
  const transfer = tx.instructions[funded ? 3 : 2], memo = tx.instructions[funded ? 4 : 3]
  if (funded) {
    const funding = tx.instructions[2]
    if (funding.programId !== TOKEN_PROGRAM || !sameJson(funding.keys,
      [p.payment_requirements.extra.fundingSource, p.mint, p.source_token_account, sponsor])
      || funding.data.length !== 10 || funding.data[0] !== 12 || funding.data[9] !== 6
      || unsignedLE(funding.data.slice(1, 9)).toString() !== p.amount_atomic) throw new Error('x402_transaction_invalid')
  }
  if (limit.programId !== COMPUTE || limit.keys.length || limit.data.length !== 5 || limit.data[0] !== 2
    || unsignedLE(limit.data.slice(1)) < BigInt(1) || unsignedLE(limit.data.slice(1)) > BigInt(40000)
    || price.programId !== COMPUTE || price.keys.length || price.data.length !== 9 || price.data[0] !== 3
    || unsignedLE(price.data.slice(1)) > BigInt(50000)
    || transfer.programId !== TOKEN_PROGRAM || !sameJson(transfer.keys, [p.source_token_account, p.mint, p.recipient_token_account, p.payer])
    || transfer.data.length !== 10 || transfer.data[0] !== 12 || transfer.data[9] !== 6
    || unsignedLE(transfer.data.slice(1, 9)).toString() !== p.amount_atomic
    || memo.programId !== MEMO_PROGRAM || memo.keys.length
    || !sameJson([...memo.data], [...new TextEncoder().encode(`printkub-x402:${p.quote_id}`)])) {
    throw new Error('x402_transaction_invalid')
  }
  for (let i = 0; i < 2; i++) {
    const signature = tx.signatures[i]
    if (signature.length !== 64) throw new Error('x402_transaction_invalid')
    if (i === 0 && !fullySigned) {
      if (signature.some(byte => byte !== 0)) throw new Error('x402_transaction_invalid')
    } else {
      const key = await crypto.subtle.importKey('raw', new Uint8Array(tx.publicKeys[i]).buffer, 'Ed25519', false, ['verify'])
      if (!await crypto.subtle.verify('Ed25519', key, new Uint8Array(signature).buffer, new Uint8Array(tx.message).buffer)) {
        throw new Error('x402_signature_invalid')
      }
    }
  }
}

export async function x402FinalizedEvidence(full: X402Transaction, partial: X402Transaction, p: X402Purchase,
  signature: string, signatureBytes: Uint8Array, slot: number,
  meta: { err: unknown; postTokenBalances?: Array<{ accountIndex: number; mint: string; owner?: string }> } | null) {
  if (!meta || !Object.hasOwn(meta, 'err') || !Number.isSafeInteger(slot) || slot < 0
    || !sameJson([...full.signatures[0]], [...signatureBytes]) || !sameJson([...full.message], [...partial.message])
    || !sameJson([...full.signatures[1]], [...partial.signatures[1]])) throw new Error('x402_receipt_invalid')
  await assertX402Transaction(full, p, true)
  if (meta.err !== null) return { error: meta.err }
  const index = full.accountKeys.indexOf(p.recipient_token_account)
  if (index < 0 || !meta.postTokenBalances?.some(balance => balance.accountIndex === index
    && balance.owner === p.recipient && balance.mint === p.mint)) throw new Error('x402_receipt_invalid')
  return { error: null, commitment: 'finalized', network: p.network, signature, payer: p.payer,
    source: p.source_token_account, destination: p.recipient_token_account, recipient: p.recipient,
    mint: p.mint, amount_atomic: p.amount_atomic, memo: `printkub-x402:${p.quote_id}`, slot }
}

// A lost response, false success, HTTP error or missing tx id never proves that
// no broadcast happened. The durable claim is never retried through /settle.
export async function dispatchX402Once<T>(ports: {
  claim(): Promise<{ dispatch: boolean }>; settle(): Promise<T>; save(result: T): Promise<void>
}): Promise<void> {
  const claim = await ports.claim()
  if (!claim.dispatch) return
  try { await ports.save(await ports.settle()) } catch { /* durable settling state is reconciled, never released here */ }
}
