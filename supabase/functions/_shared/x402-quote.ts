import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.99.1'
import { getBotReferenceRate } from './bot-rate.ts'
import { x402Capability, x402Facilitator, x402NewPaymentsEnabled, CDP_X402_URL } from './x402-facilitator.ts'
import { x402CheckAccounts, x402CheckNetwork } from './x402-solana.ts'
import { SOLANA_TEST_USDC } from './solana-payment-rules.ts'
import { printkubSponsorMode } from './x402-printkub-sponsor.ts'

export async function prepareX402Quote(admin: SupabaseClient, jobId: string, agentId: string) {
  if (!x402NewPaymentsEnabled() || Deno.env.get('X402_PERMISSIONS_ENABLED') !== 'true') throw new Error('x402_disabled')
  if ((Deno.env.get('CRYPTO_SOLANA_COMMITMENT') || 'finalized') !== 'finalized'
    || (Deno.env.get('CRYPTO_FX_SURCHARGE_BPS') || '100') !== '100'
    || (Deno.env.get('CRYPTO_SOLANA_DEVNET_USDC_MINT') || SOLANA_TEST_USDC) !== SOLANA_TEST_USDC) throw new Error('x402_not_configured')
  const recipient = Deno.env.get('CRYPTO_SOLANA_DEVNET_RECIPIENT') || ''
  const ttl = Number(Deno.env.get('CRYPTO_QUOTE_TTL_SECONDS') || '900')
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 1800) throw new Error('x402_not_configured')
  const { data: agent, error } = await admin.from('x402_agents').select('wallet_address,revoked_at').eq('id', agentId).single()
  if (error || !agent || agent.revoked_at) throw new Error('agent_unavailable')
  const local = printkubSponsorMode()
  const facilitator = local ? undefined : x402Facilitator()
  await x402CheckNetwork()
  const sponsor = await x402Capability(facilitator)
  if (sponsor === agent.wallet_address) throw new Error('x402_capability_unavailable')
  const { source, destination } = await x402CheckAccounts(agent.wallet_address, recipient)
  const rate = await getBotReferenceRate()
  const resource = `${Deno.env.get('SUPABASE_URL')}/functions/v1/x402-pay`
  if (new URL(resource).protocol !== 'https:') throw new Error('x402_not_configured')
  const result = await admin.rpc('prepare_x402_payment_quote', { p_job_id: jobId, p_agent_id: agentId,
    p_source_token_account: source, p_recipient: recipient, p_recipient_token_account: destination,
    p_rate_snapshot: { ...rate, facilitator: { url: local ? resource : CDP_X402_URL,
      ...(local ? { mode: 'printkub' } : {}),
      version: 2, scheme: 'exact', feePayer: sponsor,
      checkedAt: new Date().toISOString(), asset: SOLANA_TEST_USDC, ataPolicy: 'existing-only' } },
    p_resource_url: resource, p_fee_payer: sponsor, p_ttl: ttl })
  if (result.error?.message === 'printkub_funding_disabled') throw new Error('printkub_funding_disabled')
  if (result.error || !result.data) throw new Error('x402_quote_not_ready')
}
