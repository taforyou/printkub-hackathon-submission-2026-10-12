// Pure rules, shared with the deterministic payment/order smoke suite.
import { CRYPTO_NETWORKS } from './crypto-networks.ts'
export const SOLANA_DEVNET_GENESIS = CRYPTO_NETWORKS['solana-devnet'].genesis
export const SOLANA_DEVNET_NETWORK = CRYPTO_NETWORKS['solana-devnet'].network
export const SOLANA_TEST_USDC = CRYPTO_NETWORKS['solana-devnet'].asset
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'

export function decimalFraction(value: string): { units: bigint; scale: bigint } {
  if (!/^\d{1,12}(\.\d{1,12})?$/.test(value)) throw new Error('invalid_decimal')
  const [whole, fraction = ''] = value.split('.')
  return { units: BigInt(whole + fraction), scale: BigInt(10) ** BigInt(fraction.length) }
}

export function quoteAtomic(totalThb: string, rate: string): string {
  const total = decimalFraction(totalThb)
  const fx = decimalFraction(rate)
  if (total.units <= BigInt(0) || fx.units <= BigInt(0)) throw new Error('invalid_rate')
  const numerator = total.units * fx.scale * BigInt(1010000)
  const denominator = total.scale * fx.units
  return ((numerator + denominator - BigInt(1)) / denominator).toString()
}

export function validObservation(date: string, maxAgeDays: number, now = Date.now()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 14) return false
  const stamp = Date.parse(`${date}T00:00:00+07:00`)
  const today = new Date(now + 7 * 3600000).toISOString().slice(0, 10)
  return Number.isFinite(stamp) && new Date(stamp + 7 * 3600000).toISOString().slice(0, 10) === date
    && date <= today && now - stamp <= maxAgeDays * 86400000
}

function atPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) =>
    current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, value)
}

export function parseBotRate(payload: unknown, field: string, maxAge: number, now = Date.now()) {
  // BOT v2 returns result.data.data_detail; explicit field paths also support
  // an owner-selected response contract without guessing a different series.
  const detail = atPath(payload, 'result.data.data_detail')
  if (!Array.isArray(detail) || !field || !/^[A-Za-z0-9_.]+$/.test(field)) throw new Error('bot_response_invalid')
  const rows = detail.flatMap(row => {
    const period = atPath(row, 'period')
    const raw = atPath(row, field)
    const rate = typeof raw === 'number' || typeof raw === 'string' ? String(raw) : ''
    if (typeof period !== 'string' || !validObservation(period, maxAge, now)) return []
    try { if (decimalFraction(rate).units <= BigInt(0)) return [] } catch { return [] }
    return [{ rate, observationDate: period }]
  }).sort((a, b) => b.observationDate.localeCompare(a.observationDate))
  if (!rows.length) throw new Error('bot_rate_unavailable')
  return rows[0]
}

interface ParsedInstruction {
  programId?: string
  parsed?: string | { type?: string; info?: Record<string, unknown> }
}
interface ParsedReceipt {
  meta?: { err?: unknown; postTokenBalances?: Array<{ accountIndex: number; mint: string; owner?: string }> } | null
  transaction?: { signatures?: string[]; message?: {
    accountKeys?: Array<{ pubkey: string; signer: boolean }>
    instructions?: ParsedInstruction[]
  } }
}
export function verifySolanaReceipt(receipt: ParsedReceipt, expected: {
  signature: string; payer: string; source: string; destination: string; recipient: string; amount: string; quoteId: string
}): boolean {
  if (!receipt.meta || receipt.meta.err !== null || receipt.transaction?.signatures?.[0] !== expected.signature) return false
  const message = receipt.transaction.message
  if (message?.accountKeys?.[0]?.pubkey !== expected.payer || !message.accountKeys[0].signer) return false
  const instructions = message.instructions || []
  const transfers = instructions.filter(ix => ix.programId === TOKEN_PROGRAM && typeof ix.parsed === 'object'
    && ix.parsed?.type === 'transferChecked')
  if (transfers.length !== 1) return false
  const parsed = transfers[0].parsed
  if (typeof parsed !== 'object') return false
  const info = parsed.info || {}
  const token = info.tokenAmount as { amount?: string; decimals?: number } | undefined
  if (info.source !== expected.source || info.destination !== expected.destination || info.authority !== expected.payer
    || info.mint !== SOLANA_TEST_USDC || token?.amount !== expected.amount || token.decimals !== 6) return false
  const destinationIndex = message.accountKeys.findIndex(key => key.pubkey === expected.destination)
  if (!receipt.meta.postTokenBalances?.some(balance => balance.accountIndex === destinationIndex
    && balance.owner === expected.recipient && balance.mint === SOLANA_TEST_USDC)) return false
  return instructions.some(ix => ix.programId === MEMO_PROGRAM && ix.parsed === `printkub-payment:${expected.quoteId}`)
}
