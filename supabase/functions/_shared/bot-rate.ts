import { parseBotRate, validObservation } from './solana-payment-rules.ts'

interface RateSnapshot {
  rate: string
  observationDate: string
  retrievedAt: string
  series: string
  field: string
}
let cached: RateSnapshot | null = null

export async function getBotReferenceRate(): Promise<RateSnapshot> {
  const enabled = Deno.env.get('BOT_ENABLE') || 'false'
  if (enabled === 'false') {
    const now = Date.now()
    // Explicit fixed pricing mode: never consult BOT configuration or its cache.
    return {
      rate: '33',
      observationDate: new Date(now + 7 * 3600000).toISOString().slice(0, 10),
      retrievedAt: new Date(now).toISOString(),
      series: 'FIXED_USDC_THB',
      field: 'fixed_rate',
    }
  }
  if (enabled !== 'true') throw new Error('bot_not_configured')
  const endpoint = Deno.env.get('BOT_API_URL') || ''
  const apiKey = Deno.env.get('BOT_API_KEY') || ''
  const field = Deno.env.get('BOT_RATE_FIELD') || 'rate'
  const series = Deno.env.get('BOT_RATE_SERIES') || 'DAILY_REF_RATE'
  const maxAge = Number(Deno.env.get('BOT_MAX_OBSERVATION_AGE_DAYS') || '7')
  const headerName = Deno.env.get('BOT_API_KEY_HEADER') || 'x-ibm-client-id'
  if (!endpoint || !apiKey || !['x-ibm-client-id', 'x-api-key', 'Authorization'].includes(headerName)
    || !Number.isInteger(maxAge) || maxAge < 1 || maxAge > 14) throw new Error('bot_not_configured')
  const url = new URL(endpoint)
  // This first adapter supports only BOT's THB per USD reference-rate series.
  // Commercial-bank buy/sell feeds require a separate explicit adapter.
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.bot.or.th')
    || !url.pathname.includes('/Stat-ReferenceRate/v2/DAILY_REF_RATE')
    || url.username || url.password) throw new Error('bot_endpoint_unsupported')
  const now = Date.now()
  if (cached && now - Date.parse(cached.retrievedAt) < 5 * 60000
    && validObservation(cached.observationDate, maxAge, now)) return cached
  const today = new Date(now + 7 * 3600000).toISOString().slice(0, 10)
  const start = new Date(now + 7 * 3600000 - maxAge * 86400000).toISOString().slice(0, 10)
  url.searchParams.set('start_period', start)
  url.searchParams.set('end_period', today)
  try {
    const headers: Record<string, string> = { accept: 'application/json', [headerName]: apiKey }
    const clientSecret = Deno.env.get('BOT_API_CLIENT_SECRET')
    if (clientSecret) headers['x-ibm-client-secret'] = clientSecret
    const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error('bot_rate_unavailable')
    const rate = parseBotRate(await response.json(), field, maxAge, now)
    cached = { ...rate, retrievedAt: new Date(now).toISOString(), series, field }
    return cached
  } catch {
    // Outages may reuse only an observation still inside the configured age.
    if (cached && validObservation(cached.observationDate, maxAge, now)) return cached
    throw new Error('bot_rate_unavailable')
  }
}
