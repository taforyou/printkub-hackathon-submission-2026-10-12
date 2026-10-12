import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.99.1'
import { PublicKey } from 'npm:@solana/web3.js@1.98.1'
import { x402PermissionCors, usdcAtomic, verifyX402WalletSignature } from '../_shared/x402-permission-rules.ts'
import { prepareX402Quote } from '../_shared/x402-quote.ts'
import { assertDefaultAgentOptions, X402_POLICY_CONSENT } from '../_shared/x402-shopping-rules.ts'
import { x402NewPaymentsEnabled, x402Capability } from '../_shared/x402-facilitator.ts'
import { x402DeliveryDiagnostic } from '../_shared/x402-delivery-diagnostics.ts'
import { normalizeX402DeliveryPhone } from '../_shared/x402-delivery.ts'
import { printkubSponsorMode } from '../_shared/x402-printkub-sponsor.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NEW_ACTIONS = new Set(['link_wallet', 'admin_enroll', 'wallet_challenge', 'verify_wallet', 'create_budget', 'approve', 'create_policy'])
const SAFE_ERRORS = new Set(['invalid_purchase_policy', 'delivery_not_approved', 'active_policy_exists', 'physical_color_unavailable', 'purchase_outside_policy', 'manufacturing_unsupported', 'forbidden', 'dedicated_agent_required', 'x402_agent_unavailable',
  'agent_link_limit', 'wallet_already_linked', 'wallet_challenge_limit', 'wallet_challenge_unavailable', 'invalid_x402_budget', 'invalid_x402_grant',
  'x402_grant_not_approvable', 'not_authenticated', 'x402_quote_not_ready', 'invalid_amount', 'invalid_request',
  'wallet_signature_invalid', 'permissions_disabled', 'permissions_not_configured', 'order_unavailable',
  'purchase_unavailable', 'amount_limit', 'agent_unavailable', 'x402_disabled', 'x402_not_configured',
  'x402_capability_unavailable', 'x402_asset_unavailable', 'x402_token_account_unavailable', 'wrong_network', 'rpc_unavailable', 'x402_sponsor_unavailable', 'printkub_funding_disabled'])

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('invalid_request')
  return value
}
function authDomain(): string {
  const domain = Deno.env.get('X402_AGENT_AUTH_DOMAIN') || ''
  try {
    const parsed = new URL(domain)
    const origins = (Deno.env.get('PRINTKUB_ALLOWED_ORIGINS') || '').split(',').map(value => value.trim())
    if (parsed.protocol !== 'https:' || parsed.origin !== domain || !origins.includes(domain)) throw new Error()
    return domain
  } catch { throw new Error('permissions_not_configured') }
}
function spendingLimit(value: unknown, setting: string, fallback: string): string {
  const amount = usdcAtomic(value)
  let limit: string
  try { limit = usdcAtomic(Deno.env.get(setting) || fallback) } catch { throw new Error('permissions_not_configured') }
  if (BigInt(amount) > BigInt(limit)) throw new Error('amount_limit')
  return amount
}

serve(async req => {
  const cors = x402PermissionCors(req.headers.get('Origin'),
    (Deno.env.get('PRINTKUB_ALLOWED_ORIGINS') || '').split(',').map(value => value.trim()).filter(Boolean))
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: cors.headers })
  if (!cors.allowed) return json({ success: false, error: 'origin_not_allowed' }, 403)
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors.headers })
  if (req.method !== 'POST') return json({ success: false, error: 'method_not_allowed' }, 405)
  const requestId = crypto.randomUUID()
  let action = 'unknown'
  let deliveryGate: string | null = null
  try {
    const authorization = req.headers.get('Authorization') || ''
    const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: { user }, error: authError } = await client.auth.getUser()
    if (authError || !user) return json({ success: false, error: 'unauthorized', requestId }, 401)
    if (Number(req.headers.get('Content-Length') || 0) > 8192) return json({ success: false, error: 'request_too_large' }, 413)
    const raw = await req.text()
    if (new TextEncoder().encode(raw).length > 8192) return json({ success: false, error: 'request_too_large' }, 413)
    let body: Record<string, unknown>
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
      body = parsed
    } catch { throw new Error('invalid_request') }
    const actions = ['link_wallet', 'linked_agents', 'unlink_wallet', 'admin_enroll', 'admin_revoke_agent', 'agent_state', 'wallet_challenge', 'verify_wallet', 'order_state',
      'preview', 'budgets', 'create_budget', 'approve', 'revoke', 'purchase', 'policy_setup', 'policies', 'create_policy', 'revoke_policy', 'runner_setup']
    if (typeof body.action !== 'string' || !actions.includes(body.action)) throw new Error('invalid_request')
    action = body.action
    const enabled = Deno.env.get('X402_PERMISSIONS_ENABLED') === 'true'
    if (NEW_ACTIONS.has(action) && !enabled) throw new Error('permissions_disabled')
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const call = async (name: string, args: Record<string, unknown> = {}, service = false) => {
      const { data, error } = await (service ? admin : client).rpc(name, args)
      if (error) {
        if (name === 'create_my_x402_policy' && error.message === 'delivery_not_approved') {
          deliveryGate = x402DeliveryDiagnostic(error.details)
        }
        const reason = action === 'link_wallet' && error.code === '23505' ? 'wallet_already_linked'
          : SAFE_ERRORS.has(error.message) ? error.message
          : error.code === 'P0002' ? 'purchase_unavailable'
            : error.code === '23505' ? 'purchase_unavailable' : 'permissions_unavailable'
        throw new Error(reason)
      }
      return data
    }
    if (action === 'runner_setup') {
      if (user.app_metadata.printkub_x402_agent || user.app_metadata.printkub_x402_recovery) throw new Error('forbidden')
      // Public setup values only. Never return provider credentials, sessions,
      // service-role keys or the configured RPC URL (it may contain an API key).
      const agents = await call('my_linked_x402_agents')
      if (!agents.some((agent: { wallet_verified_at: string | null; revoked_at: string | null }) => agent.wallet_verified_at && !agent.revoked_at)) throw new Error('forbidden')
      let sponsor: string | null = null
      try { sponsor = await x402Capability() } catch { /* Keep other setup values available. */ }
      return json({ success: true, authDomain: authDomain(),
        recipient: Deno.env.get('CRYPTO_SOLANA_DEVNET_RECIPIENT') || null, sponsor,
        sponsorMode: printkubSponsorMode() ? 'printkub' : 'cdp' })
    }
    if (action === 'policies') return json({ success: true, policies: await call('my_x402_policies') })
    if (action === 'revoke_policy') return json({ success: true, revoked: await call('revoke_my_x402_policy', { p_policy_id: uuid(body.policyId) }) })
    if (action === 'policy_setup') {
      if (user.app_metadata.printkub_x402_agent || user.app_metadata.printkub_x402_recovery) throw new Error('forbidden')
      const { data: product, error } = await client.from('creator_catalog_products').select('id,title,customization,default_color,default_color_mappings')
        .eq('id', '458c809e-c99e-473a-8952-8b850fa7fe65').eq('creator_id', '645ce058-830f-4f0d-a2a1-8cf69e153fc1').single()
      if (error || !product) throw new Error('purchase_unavailable')
      const options = product.customization ? null : product.default_color_mappings
        ? { materialId: 'PLA', priceMode: 'default', mappings: product.default_color_mappings.mappings }
        : { materialId: 'PLA', priceMode: 'default', colorId: product.default_color }
      assertDefaultAgentOptions(options)
      const { data: profile, error: profileError } = await client.from('user_profiles')
        .select('has_shipping_address,shipping_phone,phone,recipient_name,display_name,address_line1,address_line2,subdistrict,district,province,postal_code').eq('id', user.id).single()
      if (profileError || !profile) throw new Error('purchase_unavailable')
      const delivery = profile.has_shipping_address ? { method: 'shipping', phone: normalizeX402DeliveryPhone(profile.shipping_phone ?? profile.phone),
        address: { recipient_name: profile.recipient_name ?? profile.display_name, line1: profile.address_line1,
          line2: profile.address_line2, subdistrict: profile.subdistrict, district: profile.district, province: profile.province, postal_code: profile.postal_code } } : null
      return json({ success: true, product: { id: product.id, title: product.title, options }, delivery,
        recipient: Deno.env.get('CRYPTO_SOLANA_DEVNET_RECIPIENT') || '', consentVersion: X402_POLICY_CONSENT })
    }
    if (action === 'create_policy') {
      if (body.consentVersion !== X402_POLICY_CONSENT) throw new Error('invalid_purchase_policy')
      if (body.printkubFunded !== undefined && typeof body.printkubFunded !== 'boolean') throw new Error('invalid_request')
      if (body.printkubFunded === true) throw new Error('printkub_funding_disabled')
      assertDefaultAgentOptions(body.options)
      const cap = spendingLimit(body.maxOrderUsdc, 'X402_AGENT_MAX_ORDER_USDC', '2')
      const budget = spendingLimit(body.budgetUsdc, 'X402_AGENT_TOTAL_BUDGET_USDC', '10')
      const recipient = Deno.env.get('CRYPTO_SOLANA_DEVNET_RECIPIENT') || ''
      if (body.recipient !== recipient || !recipient) throw new Error('permissions_not_configured')
      if (typeof body.expiresAt !== 'string' || !Number.isFinite(Date.parse(body.expiresAt))
        || !Number.isInteger(body.maxOrders)) throw new Error('invalid_request')
      const policyId = await call('create_my_x402_policy', { p_agent_id: uuid(body.agentId), p_options: body.options,
        p_delivery: body.delivery, p_recipient: recipient, p_max_order_atomic: cap, p_budget_atomic: budget,
        p_max_orders: body.maxOrders, p_expires_at: body.expiresAt, p_consent_version: X402_POLICY_CONSENT,
        p_printkub_funded: false })
      return json({ success: true, policyId })
    }
    if (action === 'linked_agents') {
      return json({ success: true, agents: await call('my_linked_x402_agents') })
    }
    if (action === 'unlink_wallet') {
      return json({ success: true, revoked: await call('revoke_my_x402_agent', { p_link_id: uuid(body.linkId) }) })
    }
    if (action === 'link_wallet') {
      if (user.app_metadata.printkub_x402_agent || user.app_metadata.printkub_x402_recovery) throw new Error('forbidden')
      let wallet: PublicKey
      try {
        if (typeof body.walletAddress !== 'string') throw new Error()
        wallet = new PublicKey(body.walletAddress)
        if (!PublicKey.isOnCurve(wallet.toBytes())) throw new Error()
      } catch { throw new Error('invalid_request') }
      const domain = authDomain()
      const { data: links, error: linksError } = await admin.from('x402_customer_agents')
        .select('id').eq('customer_id', user.id)
      if (linksError) throw new Error('permissions_unavailable')
      if ((links || []).length >= 20) throw new Error('agent_link_limit')
      const { data: existing, error: lookupError } = await admin.from('x402_customer_agents')
        .select('id,customer_id').eq('wallet_address', wallet.toBase58()).is('revoked_at', null).maybeSingle()
      if (lookupError) throw new Error('permissions_unavailable')
      if (existing) {
        if (existing.customer_id !== user.id) throw new Error('wallet_already_linked')
        return json({ success: true, linkId: existing.id })
      }
      // Internal random identity: never resolve a customer by contact email,
      // issue a password, or return this principal's session to the browser.
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email: `x402_${crypto.randomUUID()}@auth.printkub.invalid`, email_confirm: true,
        app_metadata: { printkub_x402_agent: true, printkub_x402_owner: user.id },
      })
      if (createError || !created.user) throw new Error('permissions_unavailable')
      let linkId
      try {
        linkId = await call('link_my_x402_agent', { p_auth_user_id: created.user.id,
          p_wallet_address: wallet.toBase58(), p_auth_domain: domain })
      } catch (error) {
        // The SQL transaction rolled back; discard the unused Auth principal.
        await admin.auth.admin.deleteUser(created.user.id)
        throw error
      }
      return json({ success: true, linkId })
    }
    if (action === 'admin_enroll') {
      let wallet: PublicKey
      try {
        if (typeof body.walletAddress !== 'string') throw new Error()
        wallet = new PublicKey(body.walletAddress)
        if (!PublicKey.isOnCurve(wallet.toBytes())) throw new Error()
      } catch { throw new Error('invalid_request') }
      const enrollment = await call('enroll_x402_agent', { p_auth_user_id: uuid(body.authUserId),
        p_wallet_address: wallet.toBase58(), p_auth_domain: authDomain() })
      return json({ success: true, enrollment })
    }
    if (action === 'admin_revoke_agent') {
      const revoked = await call('revoke_x402_agent', { p_auth_user_id: uuid(body.authUserId) })
      return json({ success: true, revoked })
    }
    if (action === 'agent_state') {
      const { data: agent, error } = await admin.from('x402_agents')
        .select('id,wallet_address,wallet_verified_at,revoked_at').eq('auth_user_id', user.id).maybeSingle()
      if (error) throw new Error('permissions_unavailable')
      return json({ success: true, agent })
    }
    if (action === 'wallet_challenge') {
      const domain = authDomain()
      const challenge = await call('issue_x402_wallet_challenge')
      if (!challenge || challenge.auth_domain !== domain) throw new Error('permissions_not_configured')
      return json({ success: true, challenge })
    }
    if (action === 'verify_wallet') {
      const domain = authDomain()
      const challenge = await call('begin_x402_wallet_verification', { p_challenge_id: uuid(body.challengeId) })
      let verified = false
      try {
        const key = new PublicKey(challenge.wallet_address)
        verified = challenge.auth_domain === domain && PublicKey.isOnCurve(key.toBytes())
          && await verifyX402WalletSignature(challenge.message, key.toBytes(), body.signatureBase64)
      } catch { /* invalid wallet/signature: release this bounded verification attempt */ }
      const agent = await call('finish_x402_wallet_verification', { p_challenge_id: challenge.id,
        p_verification_token: challenge.verification_token, p_verified: verified }, true)
      if (!verified || !agent) throw new Error('wallet_signature_invalid')
      return json({ success: true, agent })
    }
    if (action === 'purchase') {
      const purchase = await call('x402_purchase_view', { p_grant_id: uuid(body.grantId) })
      if (!purchase) throw new Error('purchase_unavailable')
      return json({ success: true, purchase })
    }
    if (action === 'revoke') {
      const revocation = await call('revoke_x402_grant', { p_grant_id: uuid(body.grantId) })
      return json({ success: true, revocation })
    }
    if (action === 'budgets') {
      return json({ success: true, budgets: await call('my_x402_budgets', { p_agent_id: uuid(body.agentId) }) })
    }
    if (action === 'create_budget') {
      const limit = spendingLimit(body.limitUsdc, 'X402_AGENT_TOTAL_BUDGET_USDC', '10')
      const budget = await call('create_x402_budget', { p_agent_id: uuid(body.agentId), p_limit_atomic: limit, p_ttl: 3600 })
      return json({ success: true, budget })
    }
    if (action === 'approve') {
      const cap = spendingLimit(body.capUsdc, 'X402_AGENT_MAX_ORDER_USDC', '2')
      const configuredTtl = Number(Deno.env.get('X402_AGENT_GRANT_TTL_SECONDS') || '600')
      if (!Number.isInteger(configuredTtl) || configuredTtl < 60 || configuredTtl > 1800) throw new Error('permissions_not_configured')
      const ttl = body.ttlSeconds
      if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 60 || ttl > configuredTtl) throw new Error('invalid_request')
      const grant = await call('approve_x402_grant', { p_quote_id: uuid(body.quoteId), p_budget_id: uuid(body.budgetId),
        p_cap_atomic: cap, p_ttl: ttl })
      return json({ success: true, grant })
    }
    if (typeof body.orderNo !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(body.orderNo)) throw new Error('invalid_request')
    const { data: order, error: orderError } = await admin.from('print_jobs')
      .select('id,checkout_payment_provider').eq('job_number', body.orderNo).eq('user_id', user.id).single()
    if (orderError || !order || order.checkout_payment_provider !== 'crypto') throw new Error('order_unavailable')
    if (action === 'order_state') {
      const { data: grants, error } = await admin.from('x402_grants').select('id')
        .eq('job_id', order.id).eq('customer_id', user.id).order('approved_at', { ascending: false }).limit(20)
      if (error) throw new Error('permissions_unavailable')
      const purchases = []
      for (const grant of grants || []) {
        const purchase = await call('x402_purchase_view', { p_grant_id: grant.id })
        if (purchase) purchases.push(purchase)
      }
      let limits = null
      try {
        const ttl = Number(Deno.env.get('X402_AGENT_GRANT_TTL_SECONDS') || '600')
        if (!Number.isInteger(ttl) || ttl < 60 || ttl > 1800) throw new Error()
        limits = { max_order_atomic: usdcAtomic(Deno.env.get('X402_AGENT_MAX_ORDER_USDC') || '2'),
          total_budget_atomic: usdcAtomic(Deno.env.get('X402_AGENT_TOTAL_BUDGET_USDC') || '10'), grant_ttl_seconds: ttl }
      } catch { /* reads and revocation survive invalid new-permission configuration */ }
      return json({ success: true, purchases, new_permissions_enabled: enabled && x402NewPaymentsEnabled() && !!limits, limits })
    }
    const agentId = uuid(body.agentId)
    if (!enabled) throw new Error('permissions_disabled')
    // Owner was resolved above. Provider/chain checks precede the service quote
    // RPC; the final projection still derives the customer from auth.uid().
    const { data: selectedAgent, error: selectedError } = await admin.from('x402_agents')
      .select('auth_user_id').eq('id', agentId).single()
    if (selectedError || !selectedAgent) throw new Error('agent_unavailable')
    const { data: ownership, error: ownershipError } = await admin.from('x402_customer_agents')
      .select('customer_id,revoked_at').eq('auth_user_id', selectedAgent.auth_user_id).maybeSingle()
    if (ownershipError || (ownership && (ownership.customer_id !== user.id || ownership.revoked_at))) throw new Error('agent_unavailable')
    await prepareX402Quote(admin, order.id, agentId)
    const preview = await call('my_x402_available_quote', { p_order_no: body.orderNo, p_agent_id: agentId })
    if (!preview) throw new Error('x402_quote_not_ready')
    return json({ success: true, quote: preview })
  } catch (error) {
    const reason = error instanceof Error && SAFE_ERRORS.has(error.message) ? error.message : 'permissions_unavailable'
    console.error('[x402-permissions]', JSON.stringify({ requestId, action, reason,
      ...(reason === 'delivery_not_approved' ? { deliveryGate: deliveryGate || 'delivery_diagnostics_unavailable' } : {}) }))
    const status = reason === 'forbidden' ? 403 : reason === 'not_authenticated' ? 401
      : ['invalid_request', 'invalid_amount', 'amount_limit', 'wallet_signature_invalid'].includes(reason) ? 400
        : ['permissions_disabled', 'permissions_not_configured', 'permissions_unavailable', 'x402_disabled', 'x402_not_configured',
          'x402_capability_unavailable', 'rpc_unavailable'].includes(reason) ? 503 : 409
    return json({ success: false, error: reason, requestId }, status)
  }
})
