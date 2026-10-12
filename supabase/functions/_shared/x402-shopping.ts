import { createClient } from 'npm:@supabase/supabase-js@2.99.1'
import { x402PermissionCors } from './x402-permission-rules.ts'
import { availableAgentColors, assertDefaultAgentOptions } from './x402-shopping-rules.ts'
import { prepareX402Quote } from './x402-quote.ts'
import { x402NewPaymentsEnabled } from './x402-facilitator.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const errors = new Set(['forbidden', 'invalid_request', 'purchase_outside_policy', 'physical_color_unavailable',
  'purchase_request_conflict', 'purchase_count_limit', 'delivery_changed', 'conflicting_cart', 'manufacturing_unsupported',
  'crypto_creator_consent_required', 'delegated_checkout_failed', 'purchase_policy_unavailable', 'purchase_amount_or_scope_limit',
  'x402_disabled', 'x402_not_configured', 'x402_quote_not_ready', 'x402_capability_unavailable', 'rpc_unavailable', 'x402_sponsor_unavailable', 'printkub_funding_disabled'])
const uuid = (value: unknown) => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('invalid_request')
  return value
}

export function shoppingHandler(catalog: boolean) {
  return async (req: Request) => {
    const cors = x402PermissionCors(req.headers.get('Origin'), (Deno.env.get('PRINTKUB_ALLOWED_ORIGINS') || '').split(',').map(s => s.trim()).filter(Boolean))
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors.headers })
    if (!cors.allowed) return json({ success: false, error: 'origin_not_allowed' }, 403)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors.headers })
    if (req.method !== 'POST') return json({ success: false, error: 'method_not_allowed' }, 405)
    try {
      const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: req.headers.get('Authorization') || '' } },
        auth: { persistSession: false, autoRefreshToken: false },
      })
      const { data: { user }, error } = await client.auth.getUser()
      if (error || !user) return json({ success: false, error: 'unauthorized' }, 401)
      if (Number(req.headers.get('Content-Length') || 0) > 16384) return json({ success: false, error: 'request_too_large' }, 413)
      const raw = await req.text()
      if (new TextEncoder().encode(raw).length > 16384) return json({ success: false, error: 'request_too_large' }, 413)
      let body
      try { body = JSON.parse(raw) } catch { throw new Error('invalid_request') }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_request')
      const allowedKeys = catalog ? ['action', 'productId'] : body.action === 'status' ? ['action', 'requestId']
        : ['action', 'requestId', 'productId', 'quantity', 'options']
      if (Object.keys(body).some(key => !allowedKeys.includes(key))) throw new Error('invalid_request')
      const call = async (name: string, args: Record<string, unknown>, service = false) => {
        const target = service ? createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
          auth: { persistSession: false, autoRefreshToken: false },
        }) : client
        const { data, error } = await target.rpc(name, args)
        if (error) throw new Error(errors.has(error.message) ? error.message : error.code === 'P0002' ? 'purchase_policy_unavailable' : 'shopping_unavailable')
        return data
      }
      if (catalog) {
        if (!['list', 'get'].includes(body.action)) throw new Error('invalid_request')
        const products = await call('x402_agent_catalog', { p_product_id: body.action === 'get' ? uuid(body.productId) : null })
        return json({ success: true, products: products.map((product: Record<string, unknown>) => {
          if (!product.manufacturing_supported) return { ...product, unavailable_reason: 'manufacturing_unsupported' }
          try { assertDefaultAgentOptions(product.default_options); return product }
          catch { return { ...product, manufacturing_supported: false, unavailable_reason: 'physical_color_unavailable' } }
        }) })
      }
      const requestId = uuid(body.requestId)
      if (body.action === 'status') {
        const receipt = await call('x402_delegated_status', { p_request_id: requestId })
        if (!receipt) throw new Error('forbidden')
        return json({ success: true, receipt })
      }
      if (body.action !== 'buy' || body.quantity !== 1) throw new Error('invalid_request')
      if (!x402NewPaymentsEnabled() || Deno.env.get('X402_PERMISSIONS_ENABLED') !== 'true') throw new Error('x402_disabled')
      assertDefaultAgentOptions(body.options)
      const prepared = await call('prepare_x402_delegated_purchase', { p_principal: user.id, p_request_id: requestId,
        p_product_id: uuid(body.productId), p_quantity: body.quantity, p_options: body.options, p_available_colors: availableAgentColors() }, true)
      if (!prepared.grant_id) {
        const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
        // Concurrent retries may have completed authorization while preparing.
        const { data: current, error: readError } = await admin.from('x402_delegated_purchases').select('grant_id').eq('id', prepared.purchase_id).single()
        if (readError) throw new Error('shopping_unavailable')
        if (!current.grant_id) {
          try { await prepareX402Quote(admin, prepared.job_id, prepared.agent_id) }
          catch (error) {
            const { data: retry, error: retryError } = await admin.from('x402_delegated_purchases').select('grant_id').eq('id', prepared.purchase_id).single()
            if (retryError || !retry?.grant_id) throw error
          }
        }
        await call('authorize_x402_delegated_purchase', { p_principal: user.id, p_purchase_id: prepared.purchase_id }, true)
      }
      return json({ success: true, receipt: await call('x402_delegated_status', { p_request_id: requestId }) })
    } catch (error) {
      const reason = error instanceof Error && errors.has(error.message) ? error.message : 'shopping_unavailable'
      return json({ success: false, error: reason }, reason === 'forbidden' ? 403 : reason === 'invalid_request' ? 400 : reason === 'shopping_unavailable' ? 503 : 409)
    }
  }
}
