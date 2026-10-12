import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.99.1'
import { sendAdminNotification } from './order-email.ts'

// Called on every confirmed status lookup, so reopening a paid order also
// repairs missed delivery. A failed email must never undo a verified payment.
export async function notifyX402Order(
  admin: SupabaseClient,
  attemptId: string,
  orderNo: string,
  send = sendAdminNotification,
): Promise<boolean> {
  const claimedAt = new Date().toISOString()
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString()
  const { data: claimed, error } = await admin.from('x402_payment_attempts')
    .update({ email_claimed_at: claimedAt })
    .eq('id', attemptId).eq('status', 'confirmed').is('email_sent_at', null)
    .or(`email_claimed_at.is.null,email_claimed_at.lt.${staleBefore}`)
    .select('quote_id,confirmed_at').maybeSingle()
  if (error) throw new Error('notification_claim_failed')
  if (!claimed) {
    const { data, error: lookupError } = await admin.from('x402_payment_attempts')
      .select('email_sent_at').eq('id', attemptId).single()
    if (lookupError) throw new Error('notification_lookup_failed')
    return !!data.email_sent_at
  }
  try {
    const { data: quote, error: quoteError } = await admin.from('x402_payment_quotes')
      .select('total_thb').eq('id', claimed.quote_id).single()
    if (quoteError || !quote) throw new Error('notification_quote_failed')
    await send(admin, orderNo, Math.round(Number(quote.total_thb) * 100),
      'USDC · Solana Devnet · x402', claimed.confirmed_at, `x402-order-${attemptId}`)
    const { data: saved, error: saveError } = await admin.from('x402_payment_attempts')
      .update({ email_sent_at: new Date().toISOString(), email_claimed_at: null })
      .eq('id', attemptId).eq('email_claimed_at', claimedAt).select('id').maybeSingle()
    if (saveError || !saved) throw new Error('notification_save_failed')
    return true
  } catch (error) {
    const { error: releaseError } = await admin.from('x402_payment_attempts')
      .update({ email_claimed_at: null }).eq('id', attemptId).eq('email_claimed_at', claimedAt)
    if (releaseError) console.error('[x402-order-email] notification_release_failed')
    throw error
  }
}
