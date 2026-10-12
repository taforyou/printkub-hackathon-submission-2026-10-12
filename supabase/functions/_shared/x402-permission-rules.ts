// Pure helpers shared with deterministic order/payment smoke tests.
export function x402PermissionCors(origin: string | null, allowedOrigins: string[]) {
  const allowed = origin === null || allowedOrigins.includes(origin)
  return {
    allowed,
    headers: {
      ...(origin && allowed ? { 'Access-Control-Allow-Origin': origin } : {}),
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, payment-signature, idempotency-key',
      'Access-Control-Expose-Headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Vary': 'Origin',
    },
  }
}

export function usdcAtomic(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,6})?$/.test(value)) throw new Error('invalid_amount')
  const [whole, fraction = ''] = value.split('.')
  const amount = BigInt(whole) * BigInt(1000000) + BigInt(fraction.padEnd(6, '0'))
  if (amount <= BigInt(0) || amount > BigInt('9223372036854775807')) throw new Error('invalid_amount')
  return amount.toString()
}

export function formatUsdcAtomic(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('invalid_amount')
  const amount = BigInt(value)
  const fraction = (amount % BigInt(1000000)).toString().padStart(6, '0').replace(/0+$/, '')
  return `${amount / BigInt(1000000)}${fraction ? `.${fraction}` : ''}`
}

export async function verifyX402WalletSignature(message: string, publicKeyBytes: Uint8Array, signatureBase64: unknown): Promise<boolean> {
  if (publicKeyBytes.length !== 32 || typeof signatureBase64 !== 'string'
    || !/^[A-Za-z0-9+/]{86}==$/.test(signatureBase64)) return false
  try {
    const signature = Uint8Array.from(atob(signatureBase64), character => character.charCodeAt(0))
    if (signature.length !== 64 || btoa(String.fromCharCode(...signature)) !== signatureBase64) return false
    const key = await crypto.subtle.importKey('raw', new Uint8Array(publicKeyBytes).buffer, { name: 'Ed25519' }, false, ['verify'])
    return await crypto.subtle.verify('Ed25519', key, signature.buffer, new TextEncoder().encode(message).buffer)
  } catch {
    return false
  }
}
