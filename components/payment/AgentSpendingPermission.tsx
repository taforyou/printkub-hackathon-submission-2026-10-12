'use client'

import { useEffect, useState } from 'react'
import { AgentRunnerSetup } from '@/components/payment/AgentRunnerSetup'
import { FILAMENT_COLORS } from '@/lib/config/printConfig'
import { useLocale } from '@/lib/i18n/LocaleContext'
import { createX402Policy, myX402Policies, revokeX402Policy, x402PolicySetup } from '@/lib/payment/x402Permissions'
import { formatUsdcAtomic, usdcAtomic } from '@/supabase/functions/_shared/x402-permission-rules'
import type { X402LinkedAgent, X402PolicySetup, X402PurchasePolicy } from '@/lib/types/database'

export function AgentSpendingPermission({ agents, onPoliciesChange }: {
  agents: X402LinkedAgent[]; onPoliciesChange: (policies: X402PurchasePolicy[]) => void
}) {
  const { t, locale } = useLocale()
  const copy = t.x402Standing
  const [setup, setSetup] = useState<X402PolicySetup | null>(null)
  const [policies, setPolicies] = useState<X402PurchasePolicy[]>([])
  const [agentId, setAgentId] = useState('')
  const [cap, setCap] = useState('')
  const [budget, setBudget] = useState('')
  const [orders, setOrders] = useState('1')
  const [expiry, setExpiry] = useState('')
  const [consent, setConsent] = useState(false)
  // Archived option: PrintKub-funded product purchases are disabled.
  // const [printkubFunded, setPrintkubFunded] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const errorMessage = (reason: unknown) => {
    const code = reason instanceof Error ? reason.message : ''
    const messages: Record<string, string> = {
      active_policy_exists: copy.existingError,
      delivery_not_approved: copy.deliveryError,
      amount_limit: copy.limitError,
      invalid_amount: copy.amountError,
      invalid_purchase_policy: copy.policyError,
      permissions_disabled: copy.disabledError,
      permissions_not_configured: copy.configError,
      permissions_unavailable: copy.backendError,
      unauthorized: copy.authError,
      not_authenticated: copy.authError,
      agent_unavailable: copy.agentError,
      purchase_unavailable: copy.agentError,
      forbidden: copy.agentError,
      printkub_funding_disabled: copy.legacyFundingDisabled,
    }
    return messages[code] ? `${messages[code]} (${code})` : copy.error
  }
  const verified = agents.filter(a => a.agent_id && a.wallet_verified_at && !a.revoked_at)
  useEffect(() => {
    let active = true
    Promise.all([x402PolicySetup(), myX402Policies()]).then(([settings, result]) => {
      if (active) { setSetup(settings); setPolicies(result.policies); onPoliciesChange(result.policies) }
    }).catch(() => { if (active) setError(copy.error) })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [copy.error, onPoliciesChange])
  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setError(''); setSaved(false)
    let completed = false
    try {
      await operation()
      completed = true
      const result = await myX402Policies()
      setPolicies(result.policies); onPoliciesChange(result.policies)
    }
    catch (reason) { setError(completed ? copy.refreshError : errorMessage(reason)) }
    finally { setBusy(false) }
  }
  const colorName = (id: string) => FILAMENT_COLORS.find(color => color.id === id)?.name[locale] || id
  const input = 'h-12 w-full min-w-0 rounded-xl border border-gray-300 bg-white px-3 text-base text-gray-900 outline-none transition-colors focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:[color-scheme:dark]'
  const field = 'flex min-w-0 flex-col gap-2 text-sm font-medium'
  return <div id="agent-spending-permission" className="space-y-4 border-t border-gray-200 pt-5 dark:border-gray-700">
    <div className="space-y-2">
      <h3 className="text-lg font-semibold">{copy.title}</h3>
      <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300">{copy.hint}</p>
      <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300">{copy.paymentHint}</p>
      <p className="rounded-xl bg-orange-50 p-4 text-sm leading-relaxed text-orange-900 dark:bg-orange-950/40 dark:text-orange-100">{copy.setupSteps}</p>
    </div>
    {error && <p role="alert" className="text-red-600 dark:text-red-400">{error}</p>}
    {busy && <p role="status">{t.common.loading}</p>}
    {policies.map(policy => <div key={policy.id} className="space-y-2 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
      <p>{policy.revoked_at ? copy.revoked : new Date(policy.expires_at).getTime() <= Date.now() ? copy.expired : copy.active}</p>
      <p>{copy.cap}: {formatUsdcAtomic(policy.max_order_atomic)} USDC · {copy.budget}: {formatUsdcAtomic(policy.budget_atomic)} USDC</p>
      {policy.printkub_funded && <p role="status" className="text-sm text-amber-800 dark:text-amber-200">{copy.legacyFundingDisabled}</p>}
      <p>{copy.orders}: {policy.prepared_orders}/{policy.max_orders} · {copy.expiry}: {new Date(policy.expires_at).toLocaleString()}</p>
      {!policy.revoked_at && new Date(policy.expires_at).getTime() > Date.now() && verified.filter(agent => agent.agent_id === policy.agent_id).map(agent =>
        <AgentRunnerSetup key={agent.id} agent={agent} policies={[policy]} compact />)}
      {!policy.revoked_at && <button type="button" disabled={busy} className="rounded-xl border border-gray-300 px-4 py-2 disabled:opacity-50 dark:border-gray-600"
        onClick={() => void run(() => revokeX402Policy(policy.id))}>{copy.revoke}</button>}
    </div>)}
    {setup && <form className="space-y-5" onSubmit={event => {
      event.preventDefault()
      if (!consent || !setup.delivery || !agentId || !expiry) return
      const expiresAt = new Date(expiry).getTime()
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60000 || expiresAt > Date.now() + 30 * 86400000) {
        setError(copy.expiryError); setSaved(false); return
      }
      try {
        if (BigInt(usdcAtomic(cap)) > BigInt(usdcAtomic(budget))) { setError(copy.budgetError); setSaved(false); return }
      } catch { setError(copy.amountError); setSaved(false); return }
      void run(async () => {
        await createX402Policy({ agentId, options: setup.product.options, delivery: setup.delivery!, recipient: setup.recipient,
          maxOrderUsdc: cap, budgetUsdc: budget, maxOrders: Number(orders), expiresAt: new Date(expiry).toISOString(), consentVersion: setup.consentVersion })
        setConsent(false); setSaved(true)
      })
    }}>
      <div className="space-y-2 rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-semibold">{setup.product.title}</p>
          <span className="rounded-full bg-white px-2.5 py-1 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">{copy.quantity}</span>
        </div>
        <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300">{copy.theme}: {'mappings' in setup.product.options
          ? [...new Set(setup.product.options.mappings.map(m => m.mappedColorId))].map(colorName).join(', ')
          : colorName(setup.product.options.colorId)} · PLA</p>
      </div>
      {setup.delivery?.method === 'shipping' ? <div className="space-y-1 rounded-xl border border-gray-200 p-4 text-sm leading-relaxed dark:border-gray-700">
        <p className="font-medium">{copy.delivery}</p><p>{setup.delivery.address.recipient_name} · {setup.delivery.phone}</p>
        <p className="text-gray-600 dark:text-gray-300">{[setup.delivery.address.line1, setup.delivery.address.line2, setup.delivery.address.subdistrict, setup.delivery.address.district,
          setup.delivery.address.province, setup.delivery.address.postal_code].filter(Boolean).join(' ')}</p>
      </div> : <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-relaxed text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">{copy.addressRequired}</p>}
      <label className={field}><span>{copy.agent}</span><select required className={`${input} truncate`} value={agentId} disabled={busy} onChange={event => setAgentId(event.target.value)}>
        <option value="">{t.x402Wallet.choose}</option>
        {verified.map(agent => <option key={agent.id} value={agent.agent_id!}>{agent.wallet_address}</option>)}
      </select></label>
      {/* Archived PrintKub-funded option; order USDC always comes from the agent.
      <label className="flex items-start gap-3 text-sm leading-relaxed">
        <input type="checkbox" checked={printkubFunded} disabled={busy || !setup.printkubFundingAvailable}
          onChange={event => { setPrintkubFunded(event.target.checked); setConsent(false) }} />
        <span>{copy.printkubPays}</span>
      </label>
      */}
      <div className="space-y-2">
        <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
          <label className={field}><span className="flex-1">{copy.capLabel}</span><input required aria-describedby="agent-spending-limits-hint" className={input} value={cap} disabled={busy} inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" onChange={event => setCap(event.target.value)} /></label>
          <label className={field}><span className="flex-1">{copy.budget}</span><input required aria-describedby="agent-spending-limits-hint" className={input} value={budget} disabled={busy} inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" onChange={event => setBudget(event.target.value)} /></label>
          <label className={field}><span className="flex-1">{copy.orders}</span><input required type="number" min="1" max="20" className={input} value={orders} disabled={busy} onChange={event => setOrders(event.target.value)} /></label>
          <label className={field}><span className="flex-1">{copy.expiry}</span><input required type="datetime-local" className={input} value={expiry} disabled={busy} onChange={event => setExpiry(event.target.value)} /></label>
        </div>
        <p id="agent-spending-limits-hint" className="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{copy.limitsHint}</p>
        <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{copy.expiryHint}</p>
      </div>
      <div className="space-y-4 border-t border-gray-200 pt-5 dark:border-gray-700">
        <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-gray-50 p-4 text-sm leading-relaxed dark:bg-gray-900/50"><input type="checkbox" checked={consent} disabled={busy} className="mt-0.5 h-4 w-4 shrink-0 accent-orange-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500" onChange={event => setConsent(event.target.checked)} /><span>{copy.consent}</span></label>
        {error && <p role="alert" className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-700 dark:bg-red-950/40 dark:text-red-100">{error}</p>}
        {saved && <p role="status" className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100">{copy.saved}</p>}
        <button type="submit" disabled={busy || !consent || !agentId || !setup.delivery || !cap || !budget || !expiry}
          className="min-h-12 w-full rounded-xl bg-orange-500 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-orange-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-500 dark:disabled:bg-gray-700 dark:disabled:text-gray-400">{copy.enable}</button>
      </div>
    </form>}
  </div>
}
