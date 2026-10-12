import type { X402Purchase } from './x402-payment-rules.ts'

// Shared by status and the worker. Recovery has no signing/settlement port.
export async function recoverX402Payment<R>(purchase: X402Purchase, ports: {
  find(): Promise<{ signature: string; receipt: R } | null>
  evidence(receipt: R, signature: string): Promise<{ error: unknown }>
  update(action: string, data: Record<string, unknown>): Promise<void>
}): Promise<void> {
  if (!purchase.attempt || !['settling', 'pending'].includes(purchase.attempt.status)) return
  const found = await ports.find()
  if (!found) return
  const evidence = await ports.evidence(found.receipt, found.signature)
  if (!purchase.attempt.signature) {
    await ports.update('pending', { signature: found.signature,
      provider_response: { recoveredBy: 'finalized-message-and-agent-signature' } })
  }
  await ports.update(evidence.error === null ? 'confirm' : 'fail_finalized', evidence.error === null
    ? { signature: found.signature, receipt: evidence }
    : { evidence: { commitment: 'finalized', network: purchase.network, signature: found.signature, error: evidence.error } })
}

// Cursor advances only after the entire page has been checked. Any RPC error
// replays the page, including a temporarily missing receipt. Completed cycles
// restart at the head, so new arrivals are eventually revisited.
export async function scanX402Page<R>(ports: {
  rows(): Promise<Array<{ signature: string }>>
  receipt(signature: string): Promise<R | null>
  matches(receipt: R, signature: string): Promise<boolean>
}, limit: number) {
  const rows = await ports.rows()
  for (const row of rows) {
    const receipt = await ports.receipt(row.signature)
    if (!receipt) throw new Error('rpc_unavailable')
    if (await ports.matches(receipt, row.signature)) return { found: { signature: row.signature, receipt }, before: null, complete: false }
  }
  return { found: null, before: rows.length === limit ? rows[rows.length - 1].signature : null, complete: rows.length < limit }
}
