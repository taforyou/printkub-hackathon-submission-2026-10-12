export const PRINTKUB_SPONSOR = 'GvFb1w7CEXSSdrW1BPqiLiCCgcMQuVXA4WmoSxYzJEhR'
export const PRINTKUB_SPONSOR_FEE_LAMPORTS = 12000

export function sponsorMode(value: string | undefined): 'cdp' | 'printkub' {
  if (!value || value === 'cdp') return 'cdp'
  if (value === 'printkub') return value
  throw new Error('x402_not_configured')
}

export function assertSponsorAllowance(amount: string, used: string, limit: string, fees: number, feeLimit: number) {
  if (![amount, used, limit].every(value => /^(0|[1-9][0-9]{0,18})$/.test(value))
    || BigInt(limit) > BigInt(100000000)
    || !Number.isSafeInteger(fees) || fees < 0 || !Number.isSafeInteger(feeLimit) || feeLimit < 0 || feeLimit > 10000000) {
    throw new Error('x402_not_configured')
  }
  if (BigInt(used) + BigInt(amount) > BigInt(limit) || fees + PRINTKUB_SPONSOR_FEE_LAMPORTS > feeLimit) {
    throw new Error('x402_sponsor_budget_exhausted')
  }
}

export async function recoverSponsorTransaction<R>(saved: { transaction: string; signature: string; blockhash: string }, ports: {
  lookup(signature: string): Promise<R | null>
  blockhashValid(blockhash: string): Promise<boolean>
  broadcast(transaction: string, signature: string): Promise<unknown>
}): Promise<{ signature: string; receipt: R } | null> {
  const receipt = await ports.lookup(saved.signature)
  if (receipt) return { signature: saved.signature, receipt }
  if (await ports.blockhashValid(saved.blockhash)) {
    try { await ports.broadcast(saved.transaction, saved.signature) }
    catch { /* Reconcile this same identity after a lost response. */ }
  }
  return null
}
