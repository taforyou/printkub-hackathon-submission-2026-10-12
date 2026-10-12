import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.99.1'
import type { X402Purchase } from './x402-payment-rules.ts'
import { recoverX402Payment, scanX402Page } from './x402-recovery-rules.ts'
import { lookupX402Receipt, correlateX402Receipt, x402Receipt, x402CheckNetwork, x402Rpc } from './x402-solana.ts'
import { savedPrintkubSignature, broadcastPrintkubSignature } from './x402-printkub-sponsor.ts'
import { recoverSponsorTransaction } from './x402-sponsor-rules.ts'

export async function reconcileX402(admin: SupabaseClient, purchase: X402Purchase,
  scan?: { before: string | null; save(before: string | null, complete: boolean): Promise<void> }) {
  if (!purchase.attempt || !['settling','pending'].includes(purchase.attempt.status)) return
  const { data: attempt, error } = await admin.from('x402_payment_attempts')
    .select('signed_transaction_base64,provider_response').eq('id', purchase.attempt.id).single()
  if (error || !attempt?.signed_transaction_base64) throw new Error('x402_attempt_locked')
  const partial = attempt.signed_transaction_base64
  await x402CheckNetwork()
  await recoverX402Payment(purchase, {
    find: async () => {
      const local = await savedPrintkubSignature(admin, purchase, partial)
      if (local) {
        // Expiry/absence never proves a failed payment or releases allocation.
        return await recoverSponsorTransaction(local, {
          lookup: lookupX402Receipt,
          blockhashValid: async blockhash => (await x402Rpc<{ value: boolean }>('isBlockhashValid', [blockhash, { commitment: 'confirmed' }])).value,
          broadcast: broadcastPrintkubSignature,
        })
      }
      if (purchase.attempt!.signature) {
        const signature = purchase.attempt!.signature
        const receipt = await lookupX402Receipt(signature)
        return receipt ? { signature, receipt } : null
      }
      const hint = attempt.provider_response?.transaction
      if (typeof hint === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(hint)) {
        const receipt = await lookupX402Receipt(hint)
        if (receipt) {
          try { await x402Receipt(receipt, hint, partial, purchase); return { signature: hint, receipt } }
          catch { /* a provider hint is not proof */ }
        }
      }
      if (!scan) return await correlateX402Receipt(partial, purchase)
      const page = await scanX402Page({
        rows: () => x402Rpc<Array<{ signature: string }>>('getSignaturesForAddress',
          [purchase.source_token_account, { commitment: 'finalized', limit: 10, ...(scan.before ? { before: scan.before } : {}) }]),
        receipt: lookupX402Receipt,
        matches: async (receipt, signature) => {
          try { await x402Receipt(receipt, signature, partial, purchase); return true } catch { return false }
        },
      }, 10)
      // A matching receipt is saved/finalized first. A failed database write
      // leaves the page intact and the worker rediscovers the same transfer.
      if (!page.found) await scan.save(page.before, page.complete)
      return page.found
    },
    evidence: (receipt, signature) => x402Receipt(receipt, signature, partial, purchase),
    update: async (action, data) => {
      const { error } = await admin.rpc('update_x402_payment_attempt', {
        p_attempt_id: purchase.attempt!.id, p_action: action, p_data: data,
      })
      if (error) throw new Error('x402_attempt_locked')
    },
  })
}
