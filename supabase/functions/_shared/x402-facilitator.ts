import { HTTPFacilitatorClient } from 'npm:@x402/core@2.28.0/server'
import { cdpX402Jwt } from './cdp-x402-auth.ts'
import { PublicKey } from 'npm:@solana/web3.js@1.98.1'
import { SOLANA_DEVNET_NETWORK, SOLANA_TEST_USDC } from './solana-payment-rules.ts'
import { x402Sponsor } from './x402-payment-rules.ts'
import { printkubSponsorKey, printkubSponsorMode } from './x402-printkub-sponsor.ts'

export const CDP_X402_URL = 'https://api.cdp.coinbase.com/platform/v2/x402'

export function x402NewPaymentsEnabled(): boolean {
  return Deno.env.get('X402_PAYMENTS_ENABLED') === 'true' && Deno.env.get('CRYPTO_CHECKOUT_ENABLED') === 'true'
}
export function x402Facilitator() {
  const url = Deno.env.get('X402_FACILITATOR_URL') || ''
  const apiKeyId = Deno.env.get('CDP_API_KEY_ID') || ''
  const apiKeySecret = Deno.env.get('CDP_API_KEY_SECRET') || ''
  if (url !== CDP_X402_URL || !apiKeyId || !apiKeySecret
    || Deno.env.get('X402_SUPPORTED_NETWORKS') !== SOLANA_DEVNET_NETWORK
    || Deno.env.get('X402_SUPPORTED_ASSETS') !== SOLANA_TEST_USDC
    || Deno.env.get('X402_FACILITATOR_POLICY_CONFIRMED') !== 'true') throw new Error('x402_not_configured')
  return new HTTPFacilitatorClient({ url, timeoutMs: 20000, createAuthHeaders: async () => {
    const headers = async (operation: 'supported' | 'verify' | 'settle') =>
      ({ Authorization: `Bearer ${await cdpX402Jwt(apiKeyId, apiKeySecret, operation)}` })
    const [supported, verify, settle] = await Promise.all([headers('supported'), headers('verify'), headers('settle')])
    return { supported, verify, settle }
  } })
}

export async function x402Capability(client?: HTTPFacilitatorClient): Promise<string> {
  try {
    if (printkubSponsorMode()) return printkubSponsorKey().publicKey.toBase58()
    const sponsor = new PublicKey(x402Sponsor(await (client || x402Facilitator()).getSupported()))
    if (!PublicKey.isOnCurve(sponsor.toBytes())) throw new Error()
    return sponsor.toBase58()
  } catch { throw new Error('x402_capability_unavailable') }
}
