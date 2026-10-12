'use client'

import { useEffect, useState } from 'react'
import { AgentSpendingPermission } from '@/components/payment/AgentSpendingPermission'
import { AgentRunnerSetup } from '@/components/payment/AgentRunnerSetup'
import { Clock3, ShieldCheck, Sparkles, CircleX } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleContext'
import { linkedX402Agents, linkX402Wallet, unlinkX402Wallet } from '@/lib/payment/x402Permissions'
import type { X402LinkedAgent, X402PurchasePolicy } from '@/lib/types/database'

export function AgentWalletSettings() {
  const { t, locale } = useLocale()
  const copy = t.x402Wallet
  const [agents, setAgents] = useState<X402LinkedAgent[]>([])
  const [policies, setPolicies] = useState<X402PurchasePolicy[]>([])
  const [wallet, setWallet] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    linkedX402Agents().then(result => { if (active) setAgents(result.agents) })
      .catch(() => { if (active) setError(copy.error) })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [copy.error])
  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      await operation()
      setAgents((await linkedX402Agents()).agents)
    } catch { setError(copy.error) }
    finally { setBusy(false) }
  }
  const input = 'w-full rounded-xl border border-gray-300 bg-white p-3 text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100'
  const button = 'rounded-xl bg-orange-500 px-4 py-3 font-semibold text-white hover:bg-orange-600 disabled:opacity-50'
  return <section className="mb-6 space-y-4 rounded-xl bg-white p-6 text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-lg font-semibold">{copy.title}</h2>
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300/30 bg-emerald-300/10 px-2.5 py-1 text-[10px] font-semibold tracking-wide text-emerald-700 dark:text-emerald-200">
        <Sparkles aria-hidden="true" className="h-3 w-3" />{t.auth.dynamicHackathonLabel}
      </span>
    </div>
    <p className="text-sm text-gray-600 dark:text-gray-300">{copy.hint}</p>
    {error && <p role="alert" className="text-red-600 dark:text-red-400">{error}</p>}
    {busy && <p role="status">{t.common.loading}</p>}
    <label className="block" htmlFor="agent-public-wallet">{copy.wallet}</label>
    <input id="agent-public-wallet" className={input} value={wallet} disabled={busy} autoComplete="off" spellCheck={false}
      onChange={event => setWallet(event.target.value.trim())} />
    <button type="button" className={button} disabled={busy || !wallet} onClick={() => void run(async () => {
      await linkX402Wallet(wallet); setWallet('')
    })}>{copy.link}</button>
    {agents.map(agent => <div key={agent.id} className={`space-y-3 rounded-xl border p-4 ${!agent.revoked_at && agent.wallet_verified_at
      ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950/30'
      : 'border-gray-200 dark:border-gray-700'}`}>
      <p className="break-all font-mono text-sm">{agent.wallet_address}</p>
      <p className={`flex items-center gap-2 font-semibold ${agent.revoked_at ? 'text-gray-500 dark:text-gray-400'
        : agent.wallet_verified_at ? 'text-emerald-800 dark:text-emerald-200' : 'text-amber-800 dark:text-amber-200'}`}>
        {agent.revoked_at ? <CircleX aria-hidden="true" className="h-5 w-5 shrink-0" />
          : agent.wallet_verified_at ? <ShieldCheck aria-hidden="true" className="h-5 w-5 shrink-0" />
            : <Clock3 aria-hidden="true" className="h-5 w-5 shrink-0" />}
        {agent.revoked_at ? copy.revoked : agent.wallet_verified_at ? copy.verified : copy.pending}
      </p>
      {!agent.revoked_at && <>
        <p className="text-sm">{agent.wallet_verified_at ? copy.verifiedHint : copy.runnerHint}</p>
        {agent.wallet_verified_at && <p className="text-sm text-gray-600 dark:text-gray-300">
          {copy.verifiedAt}: {new Date(agent.wallet_verified_at).toLocaleString(locale === 'th' ? 'th-TH' : 'en-GB')}
        </p>}
        <dl className="space-y-2 text-sm">
          {agent.wallet_verified_at && agent.agent_id && <div><dt>{copy.agentId}</dt><dd className="break-all font-mono">{agent.agent_id}</dd><dd className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t.x402Runner.referenceOnly}</dd></div>}
          <div><dt>{copy.linkId}</dt><dd className="break-all font-mono select-all">{agent.id}</dd></div>
          <div><dt>{copy.principal}</dt><dd className="break-all font-mono select-all">{agent.auth_user_id}</dd></div>
        </dl>
        {agent.wallet_verified_at && agent.agent_id && <AgentRunnerSetup agent={agent} policies={policies} />}
        <button type="button" className="block rounded-xl border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700" disabled={busy} onClick={() => {
          if (window.confirm(copy.revokeConfirm)) void run(() => unlinkX402Wallet(agent.id))
        }}>{copy.revoke}</button>
      </>}
    </div>)}
    <AgentSpendingPermission agents={agents} onPoliciesChange={setPolicies} />
  </section>
}
