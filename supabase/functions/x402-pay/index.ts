import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.99.1'
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from 'npm:@x402/core@2.28.0/http'
import type { PaymentPayload, PaymentRequirements } from 'npm:@x402/core@2.28.0/types'
import { x402PermissionCors, usdcAtomic } from '../_shared/x402-permission-rules.ts'
import { assertX402Payload, assertX402Requirements, dispatchX402Once, type X402Purchase } from '../_shared/x402-payment-rules.ts'
import { x402Capability, x402Facilitator, x402NewPaymentsEnabled } from '../_shared/x402-facilitator.ts'
import { x402CheckAccounts, x402CheckNetwork, x402Rpc, validateX402Payment } from '../_shared/x402-solana.ts'
import { reconcileX402 } from '../_shared/x402-recovery.ts'
import { notifyX402Order } from '../_shared/x402-order-email.ts'
import { printkubSponsorMode, preparePrintkubSignature, broadcastPrintkubSignature } from '../_shared/x402-printkub-sponsor.ts'
import { assertAgentFunding } from '../_shared/x402-agent-rules.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SAFE = new Set(['purchase_policy_unavailable', 'invalid_request','unauthorized','purchase_unavailable','agent_unavailable','x402_disabled',
  'x402_not_configured','x402_capability_unavailable','x402_quote_invalid','x402_payload_mismatch','x402_transaction_invalid',
  'x402_signature_invalid','x402_grant_not_payable','x402_attempt_locked','x402_receipt_invalid',
  'x402_asset_unavailable','x402_token_account_unavailable','x402_payment_invalid',
  'insufficient_usdc','wrong_network','rpc_unavailable','amount_limit','x402_sponsor_unavailable','x402_sponsor_budget_exhausted','printkub_funding_disabled'])

serve(async req => {
  const cors = x402PermissionCors(req.headers.get('Origin'), (Deno.env.get('PRINTKUB_ALLOWED_ORIGINS') || '').split(',').map(s => s.trim()).filter(Boolean))
  const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(value), { status, headers: { ...cors.headers, ...headers } })
  if (!cors.allowed) return json({ success: false, error: 'origin_not_allowed' }, 403)
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors.headers })
  if (req.method !== 'POST') return json({ success: false, error: 'method_not_allowed' }, 405)
  const requestId = crypto.randomUUID()
  let action = 'unknown'
  try {
    const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') || '' } }, auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: { user }, error: authError } = await client.auth.getUser()
    if (authError || !user) return json({ success: false, error: 'unauthorized', requestId }, 401)
    if (Number(req.headers.get('Content-Length') || 0) > 2048) throw new Error('invalid_request')
    const raw = await req.text()
    if (new TextEncoder().encode(raw).length > 2048) throw new Error('invalid_request')
    let body: { action: string; grantId: string }
    try {
      body = JSON.parse(raw)
      if (!body || !['pay', 'status'].includes(body.action) || typeof body.grantId !== 'string' || !UUID.test(body.grantId)) throw new Error()
    } catch { throw new Error('invalid_request') }
    action = body.action
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const call = async (name: string, args: Record<string, unknown>, service = false) => {
      const { data, error } = await (service ? admin : client).rpc(name, args)
      if (error || !data) throw new Error(error && SAFE.has(error.message) ? error.message : 'x402_attempt_locked')
      return data
    }
    const view = async (): Promise<X402Purchase> => {
      const { data, error } = await client.rpc('x402_purchase_view', { p_grant_id: body.grantId })
      if (error || !data) throw new Error('purchase_unavailable')
      return data as X402Purchase
    }
    let purchase = await view()
    const respond = async () => {
      purchase = await view()
      if (purchase.attempt?.status === 'confirmed') {
        try { await notifyX402Order(admin, purchase.attempt.id, purchase.order_no) }
        catch { console.error('[x402-pay]', JSON.stringify({ requestId, action, reason: 'notification_pending' })) }
        const response = { success: true, transaction: purchase.attempt.signature!, network: purchase.network as `${string}:${string}`,
          payer: String(purchase.payment_requirements.extra.feePayer) }
        return json({ success: true, purchase }, 200, { 'PAYMENT-RESPONSE': encodePaymentResponseHeader(response) })
      }
      if (action === 'pay' && purchase.attempt?.status === 'failed_proven') {
        return json({ success: false, error: 'x402_payment_failed', purchase }, 409)
      }
      const pending = purchase.attempt && ['reserved', 'settling', 'pending'].includes(purchase.attempt.status)
      return json({ success: true, purchase }, pending ? 202 : 200, pending ? { 'Retry-After': '5' } : {})
    }
    const readAndReconcile = async () => {
      try { await reconcileX402(admin, purchase) } catch {
        console.error('[x402-pay]', JSON.stringify({ requestId, action, reason: 'reconciliation_pending' }))
      }
      return await respond()
    }
    if (action === 'status') return await readAndReconcile()

    // Customer sessions may read/reconcile their order but never pay as the agent.
    const { data: agent, error: agentError } = await admin.from('x402_agents').select('id,revoked_at')
      .eq('auth_user_id', user.id).single()
    const { data: grant, error: grantError } = await admin.from('x402_grants').select('agent_id,budget_id,status,expires_at')
      .eq('id', body.grantId).single()
    if (agentError || grantError || !agent || !grant || grant.agent_id !== agent.id) throw new Error('agent_unavailable')
    const idempotency = req.headers.get('Idempotency-Key') || ''
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotency)) throw new Error('invalid_request')
    const header = req.headers.get('PAYMENT-SIGNATURE')
    if (header !== null && (header.length === 0 || header.length > 8192)) throw new Error('invalid_request')
    let payload: PaymentPayload | null = null
    let transaction: string | null = null
    if (header !== null) {
      try { payload = decodePaymentSignatureHeader(header) } catch { throw new Error('x402_payment_invalid') }
      transaction = assertX402Payload(payload, purchase)
    }
    if (purchase.attempt) {
      if (purchase.attempt.idempotency_key !== idempotency) throw new Error('x402_attempt_locked')
      if (transaction) {
        const { data: saved, error } = await admin.from('x402_payment_attempts').select('signed_transaction_base64')
          .eq('id', purchase.attempt.id).single()
        if (error || !saved || (saved.signed_transaction_base64 && saved.signed_transaction_base64 !== transaction)) throw new Error('x402_payload_mismatch')
      }
      // A reserved attempt can continue with a valid payload below, but an
      // already-dispatched one always follows read/reconciliation only.
      if (purchase.attempt.status !== 'reserved' || !transaction) return await readAndReconcile()
    }
    if (!x402NewPaymentsEnabled()) throw new Error('x402_disabled')
    assertAgentFunding(purchase)
    if (agent.revoked_at || grant.status !== 'approved' || Date.parse(grant.expires_at) <= Date.now()) throw new Error('x402_grant_not_payable')
    assertX402Requirements(purchase)
    let max: string
    try { max = usdcAtomic(Deno.env.get('X402_AGENT_MAX_ORDER_USDC') || '2') } catch { throw new Error('x402_not_configured') }
    if (BigInt(purchase.amount_atomic) > BigInt(max)) throw new Error('amount_limit')
    const { data: quote, error: quoteError } = await admin.from('x402_payment_quotes').select('expires_at').eq('id', purchase.quote_id).single()
    const { data: budget, error: budgetError } = await admin.from('x402_budgets').select('expires_at').eq('id', grant.budget_id).single()
    if (quoteError || budgetError || !quote || !budget || Date.parse(quote.expires_at) <= Date.now() || Date.parse(budget.expires_at) <= Date.now()) throw new Error('x402_grant_not_payable')
    const local = printkubSponsorMode()
    if (local !== (purchase.payment_requirements.extra.sponsorMode === 'printkub')) throw new Error('x402_capability_unavailable')
    const facilitator = local ? null : x402Facilitator()
    await x402CheckNetwork()
    if (await x402Capability(facilitator || undefined) !== purchase.payment_requirements.extra.feePayer) throw new Error('x402_capability_unavailable')
    if (!payload || !transaction) {
      // An unsigned challenge never reserves funds or changes order state.
      const challenge = { x402Version: 2, resource: { url: purchase.resource_url,
        description: 'Pay the customer-approved PrintKub order', mimeType: 'application/json' },
        accepts: [purchase.payment_requirements as PaymentRequirements] }
      return json(challenge, 402, { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(challenge) })
    }
    const checked = await validateX402Payment(transaction, purchase)
    await x402CheckAccounts(purchase.payer, purchase.recipient)
    const balance = await x402Rpc<{ value: { amount: string; decimals: number } }>('getTokenAccountBalance',
      [purchase.source_token_account, { commitment: 'finalized' }])
    if (balance.value.decimals !== 6 || BigInt(balance.value.amount) < BigInt(purchase.amount_atomic)) throw new Error('insufficient_usdc')
    const lifetime = await x402Rpc<{ value: boolean }>('isBlockhashValid', [checked.tx.message.recentBlockhash, { commitment: 'confirmed' }])
    if (!lifetime.value) throw new Error('x402_transaction_invalid')
    if (facilitator) {
      const verification = await facilitator.verify(payload, purchase.payment_requirements as PaymentRequirements)
      if (!verification.isValid) throw new Error('x402_payment_invalid')
    }
    const signed = local ? await preparePrintkubSignature(purchase, transaction) : null
    // SQL rechecks all consent/snapshot/budget conditions after external verify.
    purchase = await call('reserve_x402_payment', { p_grant_id: body.grantId, p_idempotency_key: idempotency })
    const attemptId = purchase.attempt!.id
    await dispatchX402Once({
      claim: () => signed ? call('claim_x402_printkub_settlement', { p_attempt_id: attemptId,
        p_partial: transaction, p_message_hash: checked.messageHash, p_signed: signed.transaction, p_signature: signed.signature }, true)
        : call('claim_x402_settlement', { p_attempt_id: attemptId,
          p_signed_transaction: transaction, p_message_hash: checked.messageHash }, true),
      settle: () => signed ? broadcastPrintkubSignature(signed.transaction, signed.signature)
        : facilitator!.settle(payload!, purchase.payment_requirements as PaymentRequirements),
      save: async result => {
        // Provider success alone never marks an order paid. Payer attribution may
        // identify the sponsor, so identity comes only from the immutable quote.
        if (result.network !== purchase.network || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(result.transaction)) throw new Error('x402_payment_invalid')
        // Persist the response immediately as a lookup hint; pin the transaction
        // only when its finalized message and signatures match the saved proof.
        const { error } = await admin.rpc('record_x402_provider_response', { p_attempt_id: attemptId,
          p_response: { success: result.success, network: result.network, transaction: result.transaction } })
        if (error) throw new Error('x402_attempt_locked')
      },
    })
    purchase = await view()
    return await readAndReconcile()
  } catch (error) {
    const reason = error instanceof Error && SAFE.has(error.message) ? error.message : 'x402_unavailable'
    console.error('[x402-pay]', JSON.stringify({ requestId, action, reason }))
    const status = reason === 'unauthorized' ? 401 : reason === 'agent_unavailable' ? 403
      : ['invalid_request','x402_payment_invalid','x402_transaction_invalid','x402_signature_invalid','x402_payload_mismatch'].includes(reason) ? 400
        : ['x402_disabled','x402_not_configured','x402_capability_unavailable','rpc_unavailable','x402_unavailable'].includes(reason) ? 503 : 409
    return json({ success: false, error: reason, requestId }, status)
  }
})
