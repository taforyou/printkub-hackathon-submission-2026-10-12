// Bootstrap exception: authenticate a bounded, single-use wallet signature,
// then issue a session ONLY for the server-created isolated agent identity.
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.99.1'
import { PublicKey } from 'npm:@solana/web3.js@1.98.1'
import { x402PermissionCors, verifyX402WalletSignature } from '../_shared/x402-permission-rules.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
serve(async req => {
  const cors = x402PermissionCors(req.headers.get('Origin'),
    (Deno.env.get('PRINTKUB_ALLOWED_ORIGINS') || '').split(',').map(value => value.trim()).filter(Boolean))
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors.headers })
  if (!cors.allowed) return json({ success: false, error: 'origin_not_allowed' }, 403)
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors.headers })
  if (req.method !== 'POST') return json({ success: false, error: 'method_not_allowed' }, 405)
  try {
    const raw = await req.text()
    if (new TextEncoder().encode(raw).length > 2048) throw new Error()
    const body = JSON.parse(raw)
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const domain = Deno.env.get('X402_AGENT_AUTH_DOMAIN') || ''
    const origins = (Deno.env.get('PRINTKUB_ALLOWED_ORIGINS') || '').split(',').map(value => value.trim())
    if (!domain.startsWith('https://') || new URL(domain).origin !== domain || !origins.includes(domain)) throw new Error()
    if (body.action === 'challenge' && typeof body.linkId === 'string' && UUID.test(body.linkId)) {
      const { data: challenge, error } = await admin.rpc('issue_x402_agent_login', { p_link_id: body.linkId, p_allow_enrollment: Deno.env.get('X402_PERMISSIONS_ENABLED') === 'true' })
      if (error || !challenge || challenge.auth_domain !== domain) throw new Error()
      return json({ success: true, challenge })
    }
    if (body.action !== 'login' || typeof body.challengeId !== 'string' || !UUID.test(body.challengeId)) throw new Error()
    const { data: challenge, error } = await admin.rpc('consume_x402_agent_login', { p_challenge_id: body.challengeId })
    if (error || !challenge || challenge.auth_domain !== domain) throw new Error()
    const wallet = new PublicKey(challenge.wallet_address)
    if (!PublicKey.isOnCurve(wallet.toBytes())
      || !await verifyX402WalletSignature(challenge.message, wallet.toBytes(), body.signatureBase64)) throw new Error()
    const { data: agent, error: completionError } = await admin.rpc('complete_x402_agent_login', { p_challenge_id: challenge.id, p_allow_enrollment: Deno.env.get('X402_PERMISSIONS_ENABLED') === 'true' })
    if (completionError || !agent) throw new Error()
    const { data: identity, error: identityError } = await admin.auth.admin.getUserById(agent.auth_user_id)
    const user = identity.user
    if (identityError || !user?.email || user.app_metadata.printkub_x402_agent !== true
      || !user.app_metadata.printkub_x402_owner || user.app_metadata.printkub_provider
      || user.app_metadata.provider !== 'email') throw new Error()
    const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: 'magiclink', email: user.email })
    if (linkError || !link.properties?.hashed_token || link.user.id !== agent.auth_user_id) throw new Error()
    // Auth exchanges the one-time token here; it is never exposed separately.
    const sessionClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: login, error: loginError } = await sessionClient.auth.verifyOtp({
      token_hash: link.properties.hashed_token, type: 'magiclink',
    })
    if (loginError || !login.session || login.user?.id !== agent.auth_user_id) throw new Error()
    return json({ success: true, agent, session: { access_token: login.session.access_token } })
  } catch {
    // Never log raw Auth/provider errors, signature proofs, or session tokens.
    return json({ success: false, error: 'agent_authentication_failed' }, 401)
  }
})
