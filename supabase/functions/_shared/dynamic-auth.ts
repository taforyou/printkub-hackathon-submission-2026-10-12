import { createRemoteJWKSet, jwtVerify } from 'https://esm.sh/jose@5.10.0'
import { verifiedSolanaAddresses } from './dynamic-wallets.ts'

const environmentId = Deno.env.get('DYNAMIC_ENVIRONMENT_ID') || ''
const issuer = Deno.env.get('DYNAMIC_ISSUER') || `app.dynamicauth.com/${environmentId}`
const audience = Deno.env.get('DYNAMIC_AUDIENCE') || ''
const jwks = createRemoteJWKSet(new URL(
  `https://app.dynamicauth.com/api/v0/sdk/${encodeURIComponent(environmentId)}/.well-known/jwks`,
))

export async function verifyDynamicAccessToken(token: string) {
  if (!environmentId || !audience) throw new Error('dynamic_not_configured')
  const { payload, protectedHeader } = await jwtVerify(token, jwks, {
    algorithms: ['RS256'], issuer, audience, clockTolerance: 5,
    requiredClaims: ['sub', 'exp', 'iat', 'scope'],
  })
  const now = Math.floor(Date.now() / 1000)
  if (!protectedHeader.kid || (payload.environment_id !== undefined && payload.environment_id !== environmentId)
    || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 200
    || typeof payload.iat !== 'number' || payload.iat > now + 5
    || typeof payload.scope !== 'string' || !payload.scope.split(/\s+/).includes('user:basic')
    || payload.scope.split(/\s+/).some(scope => ['device:register', 'deviceRegistration', 'requiresAdditionalAuth', 'userDataForm'].includes(scope))) {
    throw new Error('dynamic_auth_incomplete')
  }
  // Access tokens can omit profile claims. Resolve them on Dynamic's trusted
  // endpoint using this verified access token, never the client-only ID token.
  const response = await fetch(`https://app.dynamicauth.com/api/v0/sdk/${encodeURIComponent(environmentId)}/users`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error('dynamic_profile_unavailable')
  const profile = await response.json()
  if (profile.id !== payload.sub || profile.projectEnvironmentId !== environmentId
    || typeof profile.scope !== 'string' || !profile.scope.split(/\s+/).includes('user:basic')
    || profile.scope.split(/\s+/).includes('device:register')) throw new Error('dynamic_identity_mismatch')
  // Collected email alone is not proof. Require a verified email credential.
  const credentials = Array.isArray(profile.verifiedCredentials) ? profile.verifiedCredentials : []
  const email = typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : null
  const verifiedEmail = email && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)
    && credentials.some((value: Record<string, unknown>) => value && typeof value === 'object'
      && value.format === 'email' && typeof value.email === 'string'
      && value.email.trim().toLowerCase() === email) ? email : null
  if (email && !verifiedEmail) throw new Error('dynamic_email_unverified')
  return { environmentId, subject: payload.sub, verifiedEmail, verifiedSolanaAddresses: verifiedSolanaAddresses(credentials) }
}
