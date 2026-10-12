'use client'

import { useEffect, useState } from 'react'
import { Check, Copy, Laptop } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleContext'
import { x402RunnerSetup } from '@/lib/payment/x402Permissions'
import { formatUsdcAtomic } from '@/supabase/functions/_shared/x402-permission-rules'
import type { X402LinkedAgent, X402PurchasePolicy, X402RunnerSetup } from '@/lib/types/database'

function RunnerCopyButton({ value, label, disabled }: { value: string; label: string; disabled: boolean }) {
  const { t } = useLocale()
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 2500)
    return () => clearTimeout(timer)
  }, [state])
  return <span className="inline-flex shrink-0 items-center gap-2">
    <button type="button" disabled={disabled}
      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-orange-500 px-4 py-3 text-sm font-semibold text-white hover:bg-orange-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500 disabled:cursor-not-allowed disabled:opacity-50"
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); setState('copied') }
        catch { setState('failed') }
      }}>
      {state === 'copied' ? <Check aria-hidden="true" className="h-4 w-4" /> : <Copy aria-hidden="true" className="h-4 w-4" />}
      {label}
    </button>
    <span role="status" className="text-xs">{state === 'copied' ? t.x402Runner.copied : state === 'failed' ? t.x402Runner.copyFailed : ''}</span>
  </span>
}

export function AgentRunnerSetup({ agent, policies, compact = false }: { agent: X402LinkedAgent; policies: X402PurchasePolicy[]; compact?: boolean }) {
  const { t } = useLocale()
  const copy = t.x402Runner
  const [setup, setSetup] = useState<X402RunnerSetup | null>(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    let active = true
    x402RunnerSetup().then(result => { if (active) setSetup(result) })
      .catch(() => { if (active) setSetup(null) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [revision])
  // Stop exporting policy limits after expiry, including when the page stays open.
  const policy = policies.find(item => item.agent_id === agent.agent_id && !item.revoked_at && new Date(item.expires_at).getTime() > now)
  const values: [string, string | null][] = [
    ['X402_RUNNER_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL || null],
    ['X402_RUNNER_ANON_KEY', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || null],
    ['X402_RUNNER_LINK_ID', agent.id],
    ['X402_RUNNER_AUTH_USER_ID', agent.auth_user_id],
    ['X402_RUNNER_AUTH_DOMAIN', setup?.authDomain || null],
    ['X402_RUNNER_RECIPIENT', setup?.recipient || null],
    ['X402_RUNNER_SPONSOR', setup?.sponsor || null],
    ['X402_RUNNER_RPC_URL', 'https://api.devnet.solana.com'],
    ['X402_RUNNER_MAX_ORDER_USDC', policy ? formatUsdcAtomic(policy.max_order_atomic) : null],
    ['X402_RUNNER_TOTAL_USDC', policy ? formatUsdcAtomic(policy.budget_atomic) : null],
    // Funding mode is fixed to agent; do not expose/export a user setting.
  ]
  const dotenv = values.map(([name, value]) => value === null ? `# ${name}: ${copy.unavailable}`
    : `${name}=${JSON.stringify(value)}`).join('\n')
    + `\n\n# ${copy.keyHint}\n# X402_RUNNER_KEY_FILE=\n# ${copy.stateHint}\n# X402_RUNNER_STATE_DIR=\n`
  const ready = !loading && values.every(([, value]) => value !== null && value !== '')
    && !policy?.printkub_funded
  if (compact) return <div className="space-y-2">
    <RunnerCopyButton value={dotenv} label={copy.copyEnv} disabled={!ready} />
    <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{ready ? copy.envHint : copy.envNotReady}</p>
  </div>
  return <div className="space-y-4 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h4 className="font-semibold">{copy.title}</h4>
      <RunnerCopyButton value={dotenv} label={copy.copyEnv} disabled={!ready} />
    </div>
    <p className="break-all font-mono text-xs">{agent.wallet_address}</p>
    <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300">{copy.hint}</p>
    <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300">{copy.envHint}</p>
    <div className="space-y-3 rounded-xl border-2 border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-700 dark:bg-red-950/40 dark:text-red-100">
      <h5 className="flex items-center gap-2 font-semibold"><Laptop aria-hidden="true" className="h-5 w-5 shrink-0" />{copy.localTitle}</h5>
      <p><code className="break-all">X402_RUNNER_KEY_FILE</code> — {copy.keyHint}</p>
      <p><code className="break-all">X402_RUNNER_STATE_DIR</code> — {copy.stateHint}</p>
      <p>{copy.localHint}</p>
      <p className="font-semibold">{copy.beforeRun}</p>
    </div>
    {loading && <p role="status" className="text-sm">{t.common.loading}</p>}
    {!loading && (!setup || !setup.sponsor || !setup.recipient) && <div className="space-y-2 text-sm text-amber-800 dark:text-amber-200">
      <p>{copy.serverMissing}</p>
      <button type="button" className="underline" onClick={() => { setLoading(true); setRevision(value => value + 1) }}>{copy.reload}</button>
    </div>}
    <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300">{copy.refreshHint}</p>
    {!policy && <p className="text-sm text-amber-800 dark:text-amber-200">{copy.policyMissing}</p>}
    {policy?.printkub_funded && <p role="status" className="text-sm text-amber-800 dark:text-amber-200">{t.x402Standing.legacyFundingDisabled}</p>}
    <dl className="space-y-3">
      {values.map(([name, value]) => <div key={name} className="min-w-0 rounded-lg bg-gray-50 p-3 dark:bg-gray-900/50">
        <dt className="break-all font-mono text-xs font-semibold">{name}</dt>
        <dd className="mt-1 flex items-start justify-between gap-3">
          <span className={`min-w-0 break-all text-sm ${value ? 'select-all font-mono' : 'text-gray-500 dark:text-gray-400'}`}>{value || copy.unavailable}</span>
        </dd>
      </div>)}
    </dl>
    <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300">{setup?.sponsorMode === 'printkub' ? copy.printkubSponsorHint : copy.sponsorHint}</p>
    <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300">{copy.rpcHint}</p>
    <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300">{copy.limitsHint}</p>

  </div>
}
