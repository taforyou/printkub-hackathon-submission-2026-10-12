import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifyDynamicAccessToken } from '../_shared/dynamic-auth.ts'
import { sha256 } from '../_shared/auth-hash.ts'
import { authCors } from '../_shared/auth-cors.ts'

serve(async (req: Request) => {
  const { allowed, headers } = authCors(req)
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers })
  if (!allowed) return reply(403, { error: 'origin_not_allowed' })
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' })
  if (Deno.env.get('DYNAMIC_AUTH_ENABLED') !== 'true') return reply(503, { error: 'dynamic_disabled' })
  const requestId = crypto.randomUUID()
  let stage = 'request'
  try {
    const body = await req.text()
    if (body.length > 24000) return reply(413, { error: 'request_too_large' })
    const { accessToken } = JSON.parse(body)
    if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 20000) return reply(400, { error: 'invalid_request' })
    stage = 'verify_token'
    const identity = await verifyDynamicAccessToken(accessToken)
    stage = 'server_config'
    if (!Deno.env.get('SUPABASE_URL') || !Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) throw new Error('dynamic_not_configured')
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const key = { p_environment_id: identity.environmentId, p_subject: identity.subject }
    stage = 'login_limit'
    const { error: limitError } = await admin.rpc('limit_dynamic_login', key)
    if (limitError) {
      if (limitError.message.includes('login_rate_limited')) return reply(429, { error: 'login_rate_limited' })
      throw limitError
    }
    stage = 'identity_lookup'
    const { data: existingUserId, error: lookupError } = await admin.rpc('find_dynamic_auth_user', key)
    if (lookupError) throw lookupError
    // Contact emails can repeat; only the verified environment/subject resolves a user.
    let userId = existingUserId
    if (!userId) {
      stage = 'create_user'
      const internalEmail = `dynamic_${await sha256(JSON.stringify([identity.environmentId, identity.subject]))}@auth.printkub.invalid`
      const { error: createError } = await admin.auth.admin.createUser({
        email: internalEmail, email_confirm: true,
        app_metadata: { printkub_provider: 'dynamic', dynamic_environment_id: identity.environmentId, dynamic_subject: identity.subject },
      })
      // The creation trigger records the stable identity atomically with Auth.
      // A concurrent first login or an interrupted provisioning can reuse it.
      const found = await admin.rpc('find_dynamic_auth_user', key)
      userId = found.data
      if (found.error || !userId) throw createError || found.error || new Error('identity_creation_failed')
    }
    stage = 'provision_profile'
    const { data: provisionedId, error: profileError } = await admin.rpc('provision_dynamic_profile', {
      ...key, p_verified_email: identity.verifiedEmail,
    })
    if (profileError) throw profileError
    if (provisionedId !== userId) throw new Error('identity_mismatch')
    stage = 'load_user'
    const { data: authData, error: authError } = await admin.auth.admin.getUserById(userId)
    if (authError || !authData.user?.email) throw authError || new Error('identity_missing')
    stage = 'generate_session'
    const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: 'magiclink', email: authData.user.email })
    if (linkError || link?.user?.id !== userId || !link?.properties?.hashed_token) throw linkError || new Error('session_exchange_failed')
    return reply(200, { success: true, userId, sessionData: { tokenHash: link.properties.hashed_token, verificationType: 'magiclink' } })
  } catch (error) {
    // Log only known labels/codes, never raw errors, tokens, claims or profiles.
    const failure = error as { code?: unknown; claim?: unknown; message?: unknown; status?: unknown } | null
    const knownReasons = ['dynamic_not_configured', 'dynamic_auth_incomplete', 'dynamic_profile_unavailable',
      'dynamic_identity_mismatch', 'dynamic_email_unverified', 'identity_creation_failed',
      'identity_mismatch', 'identity_missing', 'session_exchange_failed']
    const knownCodes = ['ERR_JWT_CLAIM_VALIDATION_FAILED', 'ERR_JWT_EXPIRED', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
      'ERR_JWKS_NO_MATCHING_KEY', 'ERR_JWKS_TIMEOUT', 'ERR_JWS_INVALID', 'ERR_JWT_INVALID',
      'PGRST202', '42P01', '42883', '42501', '23505', 'P0001',
      'unexpected_failure', 'validation_failed', 'email_address_invalid', 'email_exists', 'over_request_rate_limit']
    const reason = typeof failure?.message === 'string' && knownReasons.includes(failure.message) ? failure.message : 'unexpected_failure'
    const code = typeof failure?.code === 'string' && knownCodes.includes(failure.code) ? failure.code : undefined
    const claim = typeof failure?.claim === 'string' && ['iss', 'aud', 'sub', 'exp', 'iat', 'scope', 'nbf'].includes(failure.claim)
      ? failure.claim : undefined
    const status = typeof failure?.status === 'number' && Number.isInteger(failure.status)
      && failure.status >= 400 && failure.status <= 599 ? failure.status : undefined
    console.error('[authenticate-dynamic-user]', JSON.stringify({ requestId, stage, reason, code, claim, status }))
    if (stage === 'request') return reply(400, { error: 'invalid_request', requestId })
    if (reason === 'dynamic_not_configured') return reply(503, { error: 'dynamic_not_configured', requestId })
    if (stage === 'verify_token') return reply(401, { error: 'dynamic_auth_failed', requestId })
    return reply(500, { error: 'dynamic_session_failed', requestId })
  }
})
