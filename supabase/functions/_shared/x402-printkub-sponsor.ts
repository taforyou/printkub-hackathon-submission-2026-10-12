import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.99.1'
import { Keypair } from 'npm:@solana/web3.js@1.98.1'
import { Buffer } from 'node:buffer'
import bs58 from 'npm:bs58@6.0.0'
import { PRINTKUB_SPONSOR, PRINTKUB_SPONSOR_FEE_LAMPORTS, sponsorMode } from './x402-sponsor-rules.ts'
import { assertX402Transaction, sameJson, type X402Purchase } from './x402-payment-rules.ts'
import { decodeX402Transaction, validateX402Payment, x402CheckAccounts, x402CheckNetwork, x402Rpc } from './x402-solana.ts'
import { SOLANA_DEVNET_NETWORK, SOLANA_TEST_USDC } from './solana-payment-rules.ts'
import { assertAgentFunding } from './x402-agent-rules.ts'

export const printkubSponsorMode = () => sponsorMode(Deno.env.get('X402_SPONSOR_MODE')) === 'printkub'

// Public address is shared with the runner; signing material stays backend-only.
export function printkubSponsorKey(): Keypair {
  try {
    if (!printkubSponsorMode() || (Deno.env.get('X402_RUNNER_SPONSOR') || PRINTKUB_SPONSOR) !== PRINTKUB_SPONSOR
      || Deno.env.get('X402_SUPPORTED_NETWORKS') !== SOLANA_DEVNET_NETWORK
      || Deno.env.get('X402_SUPPORTED_ASSETS') !== SOLANA_TEST_USDC) throw new Error()
    const bytes = JSON.parse(Deno.env.get('X402_SPONSOR_SECRET_KEY') || '')
    if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) throw new Error()
    const key = Keypair.fromSecretKey(Uint8Array.from(bytes))
    if (key.publicKey.toBase58() !== PRINTKUB_SPONSOR) throw new Error()
    return key
  } catch { throw new Error('x402_not_configured') }
}

/* Archived treasury-funded purchase availability. Product funding is disabled.
export async function printkubFundingAvailable(admin: SupabaseClient): Promise<boolean> {
  if (!printkubSponsorMode()) return false
  try {
    printkubSponsorKey()
    const { data, error } = await admin.from('x402_sponsor_budget')
      .select('enabled,usdc_limit_atomic,allocated_atomic,fee_limit_lamports,allocated_fee_lamports').eq('id', true).single()
    if (error || !data?.enabled || !Deno.env.get('CRYPTO_SOLANA_DEVNET_RECIPIENT')
      || Deno.env.get('CRYPTO_SOLANA_DEVNET_RECIPIENT') === PRINTKUB_SPONSOR) return false
    assertSponsorAllowance('1', String(data.allocated_atomic), String(data.usdc_limit_atomic),
      Number(data.allocated_fee_lamports), Number(data.fee_limit_lamports))
    return true
  } catch { return false }
}
*/

export async function preparePrintkubSignature(purchase: X402Purchase, partial: string) {
  assertAgentFunding(purchase)
  const signer = printkubSponsorKey()
  if (purchase.payment_requirements.extra.sponsorMode !== 'printkub'
    || purchase.payment_requirements.extra.feePayer !== signer.publicKey.toBase58()) throw new Error('x402_capability_unavailable')
  await x402CheckNetwork()
  const checked = await validateX402Payment(partial, purchase)
  await x402CheckAccounts(purchase.payer, purchase.recipient)
  // Archived product funding: await x402CheckAccounts(signer.publicKey.toBase58(), purchase.payer)
  checked.tx.sign([signer])
  const transaction = Buffer.from(checked.tx.serialize()).toString('base64')
  await assertX402Transaction(decodeX402Transaction(transaction).shape, purchase, true)
  const fee = await x402Rpc<{ value: number | null }>('getFeeForMessage',
    [Buffer.from(checked.tx.message.serialize()).toString('base64'), { commitment: 'confirmed' }])
  if (fee.value === null || !Number.isSafeInteger(fee.value) || fee.value < 0
    || fee.value > PRINTKUB_SPONSOR_FEE_LAMPORTS) throw new Error('x402_transaction_invalid')
  const simulation = await x402Rpc<{ value: { err: unknown } }>('simulateTransaction',
    [transaction, { encoding: 'base64', sigVerify: true, replaceRecentBlockhash: false, commitment: 'confirmed' }])
  if (simulation.value.err !== null) throw new Error('x402_payment_invalid')
  return { transaction, signature: bs58.encode(checked.tx.signatures[0]) }
}

export async function broadcastPrintkubSignature(transaction: string, signature: string) {
  const result = await x402Rpc<string>('sendTransaction', [transaction,
    { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 }])
  if (result !== signature) throw new Error('x402_receipt_invalid')
  return { success: true, network: SOLANA_DEVNET_NETWORK, transaction: signature }
}

// Recovery may only resend the persisted, fully signed transaction. It never
// loads a private key, creates new instructions, or allocates another budget.
export async function savedPrintkubSignature(admin: SupabaseClient, purchase: X402Purchase, partial: string) {
  if (purchase.payment_requirements.extra.sponsorMode !== 'printkub' || !purchase.attempt) return null
  const { data, error } = await admin.from('x402_sponsor_payments')
    .select('signed_transaction_base64,signature').eq('attempt_id', purchase.attempt.id).single()
  if (error || !data) throw new Error('x402_attempt_locked')
  const parsed = decodeX402Transaction(data.signed_transaction_base64)
  const original = await validateX402Payment(partial, purchase)
  if (!sameJson([...parsed.shape.message], [...original.shape.message])
    || !sameJson([...parsed.shape.signatures[1]], [...original.shape.signatures[1]])) throw new Error('x402_receipt_invalid')
  await assertX402Transaction(parsed.shape, purchase, true)
  if (bs58.encode(parsed.tx.signatures[0]) !== data.signature) throw new Error('x402_receipt_invalid')
  return { transaction: data.signed_transaction_base64 as string, signature: data.signature as string,
    blockhash: parsed.tx.message.recentBlockhash }
}
