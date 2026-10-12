// Narrow CDP REST JWT adapter. Native Web Crypto avoids resolving the full
// wallet SDK dependency graph in Supabase's server-side function bundler.
// Contract: https://docs.cdp.coinbase.com/get-started/authentication/jwt-authentication
type Operation = 'supported' | 'verify' | 'settle'
const HOST = 'api.cdp.coinbase.com'
const PATH = '/platform/v2/x402'
const METHODS: Record<Operation, string> = { supported: 'GET', verify: 'POST', settle: 'POST' }
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const base64url = (bytes: Uint8Array) => base64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error()
  const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0))
  if (base64(bytes) !== value) throw new Error()
  return bytes
}
function sequence(bytes: Uint8Array): Uint8Array {
  const length = bytes.length
  const prefix = length < 128 ? [0x30, length] : length < 256 ? [0x30, 0x81, length] : [0x30, 0x82, length >> 8, length & 255]
  return Uint8Array.from([...prefix, ...bytes])
}
function pkcs8FromSec1(bytes: Uint8Array): Uint8Array {
  const length = bytes.length
  const octetPrefix = length < 128 ? [0x04, length] : length < 256 ? [0x04, 0x81, length] : [0x04, 0x82, length >> 8, length & 255]
  // version 0; id-ecPublicKey + prime256v1; OCTET STRING containing ECPrivateKey.
  return sequence(Uint8Array.from([0x02, 0x01, 0x00,
    0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, ...octetPrefix, ...bytes]))
}
async function signingKey(secret: string): Promise<{ key: CryptoKey; alg: 'EdDSA' | 'ES256' }> {
  const pem = secret.replace(/\\n/g, '\n').trim()
  if (pem.startsWith('-----BEGIN ')) {
    const match = /^-----BEGIN (PRIVATE KEY|EC PRIVATE KEY)-----\s+([A-Za-z0-9+/=\s]+)\s+-----END \1-----$/.exec(pem)
    if (!match) throw new Error()
    const der = decodeBase64(match[2].replace(/\s/g, ''))
    const pkcs8 = match[1] === 'EC PRIVATE KEY' ? pkcs8FromSec1(der) : der
    const key = await crypto.subtle.importKey('pkcs8', new Uint8Array(pkcs8).buffer,
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    return { key, alg: 'ES256' }
  }
  const bytes = decodeBase64(secret)
  if (bytes.length !== 64) throw new Error()
  const key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519',
    d: base64url(bytes.slice(0, 32)), x: base64url(bytes.slice(32)) }, { name: 'Ed25519' }, false, ['sign'])
  return { key, alg: 'EdDSA' }
}

export async function cdpX402Jwt(apiKeyId: string, secret: string, operation: Operation,
  now = Math.floor(Date.now() / 1000)): Promise<string> {
  try {
    if (!apiKeyId || apiKeyId.length > 300 || /\s/.test(apiKeyId) || !secret || secret.length > 4096
      || !Object.hasOwn(METHODS, operation) || !Number.isSafeInteger(now) || now < 0) throw new Error()
    const { key, alg } = await signingKey(secret)
    const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    const header = base64url(jsonBytes({ alg, kid: apiKeyId, typ: 'JWT', nonce }))
    const payload = base64url(jsonBytes({ sub: apiKeyId, iss: 'cdp',
      uris: [`${METHODS[operation]} ${HOST}${PATH}/${operation}`], iat: now, nbf: now, exp: now + 120 }))
    const input = `${header}.${payload}`
    const signature = await crypto.subtle.sign(alg === 'EdDSA' ? 'Ed25519' : { name: 'ECDSA', hash: 'SHA-256' },
      key, new TextEncoder().encode(input).buffer)
    if (signature.byteLength !== 64) throw new Error()
    return `${input}.${base64url(new Uint8Array(signature))}`
  } catch { throw new Error('x402_not_configured') }
}
