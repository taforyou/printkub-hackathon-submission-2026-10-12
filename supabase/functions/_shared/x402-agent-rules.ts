import { assertX402Requirements, sameJson, type X402Purchase } from './x402-payment-rules.ts'

export interface X402SignerPolicy {
  endpoint: string; payer: string; recipient: string; sponsor: string
  maxOrderAtomic: string; totalAtomic: string
  /** Historical journal field; new executions always default to agent. */
  fundingMode?: 'agent' | 'printkub'
}
export interface X402Execution {
  grantId: string; quoteId: string; amountAtomic: string; purchase: X402Purchase
  idempotencyKey: string; transaction: string | null; submitted: boolean
}

// Only agent-paid order USDC is enabled. Legacy treasury-funded transactions
// remain valid for receipt verification/recovery, never for new signing.
export function agentFundingMode(legacySetting?: string): 'agent' {
  if (legacySetting && legacySetting !== 'agent') throw new Error('printkub_funding_disabled')
  return 'agent'
}

export function assertAgentFunding(p: X402Purchase) {
  assertX402Requirements(p)
  if (p.payment_requirements.extra.fundingMode === 'printkub' || p.payment_requirements.extra.fundingSource !== undefined) {
    throw new Error('printkub_funding_disabled')
  }
}

export function assertAgentPurchase(p: X402Purchase, policy: X402SignerPolicy, grantId: string, now = Date.now()) {
  assertAgentFunding(p)
  if (p.grant_id !== grantId || p.resource_url !== policy.endpoint || p.payer !== policy.payer
    || p.recipient !== policy.recipient || p.payment_requirements.extra.feePayer !== policy.sponsor
    || (p.payment_requirements.extra.fundingMode || 'agent') !== (policy.fundingMode || 'agent')
    || p.grant_status !== 'approved' || !Number.isFinite(Date.parse(p.expires_at)) || Date.parse(p.expires_at) <= now
    || BigInt(p.amount_atomic) > BigInt(policy.maxOrderAtomic)) throw new Error('agent_policy_rejected')
}
export function assertAgentChallenge(challenge: unknown, p: X402Purchase) {
  const c = challenge as { x402Version?: unknown; resource?: { url?: unknown }; accepts?: unknown[]; extensions?: unknown }
  if (!c || c.x402Version !== 2 || c.resource?.url !== p.resource_url || c.extensions !== undefined
    || !Array.isArray(c.accepts) || c.accepts.length !== 1 || !sameJson(c.accepts[0], p.payment_requirements)) {
    throw new Error('agent_challenge_rejected')
  }
}
// Failed/uncertain executions still count. Resetting this ledger is a new
// spending authorization requiring owner review, never automatic recovery.
export function assertAgentBudget(entries: X402Execution[], p: X402Purchase, policy: X402SignerPolicy) {
  if (entries.some(entry => !/^[1-9][0-9]{0,18}$/.test(entry.amountAtomic))) throw new Error('agent_journal_invalid')
  const used = entries.reduce((sum, entry) => sum + BigInt(entry.amountAtomic), BigInt(0))
  if (used > BigInt(policy.totalAtomic) || BigInt(p.amount_atomic) > BigInt(policy.totalAtomic) - used) {
    throw new Error('agent_budget_exhausted')
  }
}

// Persist proof before making the first signed HTTP request. A lost response
// resumes the identical proof/key, never builds a fresh transaction.
export async function executeAgentPayment(entry: X402Execution, ports: {
  sign(): Promise<string>; save(entry: X402Execution): Promise<void>
  pay(entry: X402Execution): Promise<unknown>; status(): Promise<unknown>
}, hasAttempt: boolean) {
  if (hasAttempt) return await ports.status()
  if (!entry.transaction) {
    entry.transaction = await ports.sign()
    await ports.save(entry)
  }
  entry.submitted = true
  await ports.save(entry)
  return await ports.pay(entry)
}

export function assertAgentWalletChallenge(c: { id: string; wallet_address: string; auth_domain: string; message: string; expires_at: string },
  domain: string, principal: string, wallet: string, now = Date.now(), purpose = 'Verify wallet ownership only. This message does not authorize a payment.') {
  const lines = typeof c?.message === 'string' ? c.message.split('\n') : []
  const issued = lines[7]?.slice('Issued: '.length), expires = lines[8]?.slice('Expires: '.length)
  if (lines.length !== 10 || c.wallet_address !== wallet || c.auth_domain !== domain
    || lines[0] !== 'PrintKub x402 agent wallet verification' || lines[1] !== `Domain: ${domain}`
    || lines[2] !== 'Environment: solana-devnet' || lines[3] !== `Principal: ${principal}`
    || lines[4] !== `Wallet: ${wallet}` || lines[5] !== `Challenge: ${c.id}`
    || !/^Nonce: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lines[6])
    || !lines[7]?.startsWith('Issued: ') || !lines[8]?.startsWith('Expires: ')
    || !Number.isFinite(Date.parse(issued)) || Date.parse(issued) > now + 30000
    || !Number.isFinite(Date.parse(expires)) || Date.parse(expires) !== Date.parse(c.expires_at)
    || Date.parse(expires) <= now || Date.parse(expires) - Date.parse(issued) !== 300000
    || lines[9] !== `Purpose: ${purpose}`) {
    throw new Error('wallet_challenge_rejected')
  }
}
