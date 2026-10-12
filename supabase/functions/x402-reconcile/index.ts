import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.99.1'
import { reconcileX402 } from '../_shared/x402-recovery.ts'
import { notifyX402Order } from '../_shared/x402-order-email.ts'
import type { X402Purchase } from '../_shared/x402-payment-rules.ts'

// JWT gateway stays on. The scheduler has its own Auth identity and an
// owner-controlled app_metadata claim; browser/customer/agent JWTs are denied.
serve(async req => {
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
  if (req.method !== 'POST') return json({ success: false, error: 'method_not_allowed' }, 405)
  const requestId = crypto.randomUUID()
  try {
    const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') || '' } },
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data: { user }, error } = await client.auth.getUser()
    if (error || !user) return json({ success: false, error: 'unauthorized', requestId }, 401)
    if (user.app_metadata?.printkub_x402_recovery !== true) return json({ success: false, error: 'forbidden', requestId }, 403)
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data: batch, error: claimError } = await admin.rpc('claim_x402_recovery_batch')
    if (claimError || !Array.isArray(batch)) throw new Error('claim_failed')
    let checked = 0, unresolved = 0
    for (const attempt of batch) {
      const progress = async (before: string | null, complete: boolean, reason = 'pending') => {
        const { data, error } = await admin.rpc('save_x402_recovery_progress', {
          p_attempt_id: attempt.id, p_claim_id: attempt.recovery_claim_id,
          p_before: before, p_cycle_complete: complete, p_reason: reason,
        })
        if (error || data !== true) throw new Error('progress_failed')
      }
      try {
        const { data, error } = await admin.rpc('x402_recovery_purchase', { p_attempt_id: attempt.id })
        if (error || !data) throw new Error('purchase_unavailable')
        const purchase = data as X402Purchase
        if (purchase.attempt?.status === 'reserved') {
          const { error } = await admin.rpc('abandon_x402_reserved', { p_attempt_id: attempt.id })
          if (error) throw new Error('reservation_locked')
        } else {
          await reconcileX402(admin, purchase, {
            before: attempt.recovery_scan_before, save: (before, complete) => progress(before, complete),
          })
        }
        const { data: latest, error: readError } = await admin.rpc('x402_recovery_purchase', { p_attempt_id: attempt.id })
        if (readError || !latest) throw new Error('purchase_unavailable')
        if (latest.attempt?.status === 'confirmed') {
          try { await notifyX402Order(admin, attempt.id, latest.order_no) }
          catch { await progress(attempt.recovery_scan_before, false, 'notification_pending'); unresolved++ }
        } else if (latest.attempt?.status !== 'failed_proven') unresolved++
        checked++
      } catch {
        unresolved++
        // Safe diagnostics only: no RPC URL, payload, token or customer details.
        console.error('[x402-reconcile]', JSON.stringify({ requestId, attemptId: attempt.id, reason: 'recovery_pending' }))
      } finally {
        const { error } = await admin.rpc('release_x402_recovery', {
          p_attempt_id: attempt.id, p_claim_id: attempt.recovery_claim_id,
        })
        if (error) console.error('[x402-reconcile]', JSON.stringify({ requestId, reason: 'lease_release_pending' }))
      }
    }
    return json({ success: true, requestId, claimed: batch.length, checked, unresolved })
  } catch {
    console.error('[x402-reconcile]', JSON.stringify({ requestId, reason: 'worker_unavailable' }))
    return json({ success: false, requestId, error: 'worker_unavailable' }, 503)
  }
})
