'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useLocale } from '@/lib/i18n/LocaleContext'
import { approveX402Grant, createX402Budget, revokeX402Grant, x402Budgets, x402OrderState, x402QuotePreview, x402PaymentStatus, linkedX402Agents } from '@/lib/payment/x402Permissions'
import type { X402ApprovedPurchase, X402Budget, X402PaymentQuote, X402LinkedAgent } from '@/lib/types/database'
import { formatUsdcAtomic, usdcAtomic } from '@/supabase/functions/_shared/x402-permission-rules'

type Limits = NonNullable<Awaited<ReturnType<typeof x402OrderState>>['limits']>
const INPUT = 'w-full rounded-xl border border-gray-300 bg-white p-3 text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100'
const BUTTON = 'rounded-xl bg-orange-500 px-4 py-3 font-semibold text-white hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50'
const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : ''

export function AgentPaymentApproval({ orderNo }: { orderNo: string }) {
  const { t, locale } = useLocale()
  const copy = t.x402Permission
  const [purchases, setPurchases] = useState<X402ApprovedPurchase[]>([])
  const [enabled, setEnabled] = useState(false)
  const [limits, setLimits] = useState<Limits | null>(null)
  const [agents, setAgents] = useState<X402LinkedAgent[]>([])
  const [agentId, setAgentId] = useState('')
  const [quote, setQuote] = useState<X402PaymentQuote | null>(null)
  const [budgets, setBudgets] = useState<X402Budget[]>([])
  const [budgetId, setBudgetId] = useState('')
  const [capUsdc, setCapUsdc] = useState('2')
  const [limitUsdc, setLimitUsdc] = useState('10')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState<'approved' | 'revoked' | 'revokedPending' | ''>('')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let active = true
    Promise.all([x402OrderState(orderNo), linkedX402Agents()]).then(([result, linked]) => {
      if (active) setAgents(linked.agents)
      if (!active) return
      setPurchases(result.purchases)
      setEnabled(result.new_permissions_enabled)
      setLimits(result.limits)
      if (result.limits) {
        setCapUsdc(formatUsdcAtomic(result.limits.max_order_atomic))
        setLimitUsdc(formatUsdcAtomic(result.limits.total_budget_atomic))
      }
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '') })
      .finally(() => { if (active) setBusy(false) })
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => { active = false; clearInterval(timer) }
  }, [orderNo])

  const refresh = async () => {
    setConsent(false)
    for (const purchase of purchases) {
      if (purchase.attempt && ['settling', 'pending'].includes(purchase.attempt.status)) await x402PaymentStatus(purchase.grant_id)
    }
    const [result, linked] = await Promise.all([x402OrderState(orderNo), linkedX402Agents()])
    setAgents(linked.agents)
    setPurchases(result.purchases)
    setEnabled(result.new_permissions_enabled)
    setLimits(result.limits)
  }
  const run = async (operation: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await operation() } catch (reason) { setError(reason instanceof Error ? reason.message : 'permissions_unavailable') }
    finally { setBusy(false) }
  }
  const budget = budgets.find(item => item.id === budgetId)
  let canApprove = false
  try {
    canApprove = !!(enabled && limits && quote && budget && consent && !busy
      && agents.some(agent => agent.agent_id === agentId && !agent.revoked_at)
      && quote.agent_id === agentId && Date.parse(quote.expires_at) > now && Date.parse(budget.expires_at) > now
      && BigInt(quote.amount_atomic) <= BigInt(usdcAtomic(capUsdc))
      && BigInt(usdcAtomic(capUsdc)) <= BigInt(limits.max_order_atomic)
      && BigInt(quote.amount_atomic) <= BigInt(budget.limit_atomic) - BigInt(budget.reserved_atomic) - BigInt(budget.spent_atomic))
  } catch { /* incomplete/invalid numeric input cannot authorize spending */ }
  const date = (value: string) => new Date(value).toLocaleString(locale === 'th' ? 'th-TH' : 'en-GB')
  const message = ['x402_quote_not_ready', 'x402_not_configured', 'x402_capability_unavailable', 'x402_asset_unavailable', 'x402_token_account_unavailable'].includes(error) ? copy.quoteNotReady
    : ['permissions_disabled', 'x402_disabled'].includes(error) ? copy.disabled
      : error === 'unauthorized' || error === 'not_authenticated' ? copy.sessionError
        : error === 'amount_limit' || error === 'invalid_amount' ? copy.amountError
          : ['purchase_unavailable', 'order_unavailable', 'x402_grant_not_approvable'].includes(error) ? copy.orderError : copy.error
  const activePurchase = purchases.some(item => item.attempt || (item.grant_status === 'approved' && Date.parse(item.expires_at) > now))

  return <div className="mx-auto max-w-3xl space-y-6 text-gray-900 dark:text-gray-100">
    <header><h1 className="text-2xl font-bold">{copy.title}</h1><p className="mt-2 text-gray-600 dark:text-gray-300">{copy.subtitle}</p></header>
    <p className="rounded-xl border border-orange-200 bg-orange-50 p-4 dark:border-orange-900 dark:bg-orange-950/40">{copy.scope}</p>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p>{t.cryptoPayment.orderLabel}: <strong>{orderNo}</strong></p>
      <button type="button" disabled={busy} onClick={() => void run(refresh)} className={BUTTON}>{copy.refresh}</button>
    </div>
    {busy && <p role="status">{t.common.loading}</p>}
    {error && <p role="alert" className="rounded-xl bg-red-50 p-4 text-red-800 dark:bg-red-950 dark:text-red-200">{message}</p>}
    {notice && <p role="status" className="rounded-xl bg-green-50 p-4 text-green-800 dark:bg-green-950 dark:text-green-200">{copy[notice]}</p>}
    {!enabled && !busy && <p role="status">{copy.disabled}</p>}
    {purchases.map(purchase => <section key={purchase.grant_id} className="space-y-3 rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
      <h2 className="font-bold">{copy.savedGrant}</h2>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div><dt>{copy.grantId}</dt><dd className="break-all font-mono">{purchase.grant_id}</dd></div>
        <div><dt>{copy.agentId}</dt><dd className="break-all font-mono">{purchase.agent_id}</dd></div>
        <div><dt>{copy.agentWallet}</dt><dd className="break-all font-mono">{purchase.payer}</dd></div>
        <div><dt>{copy.amount}</dt><dd>{formatUsdcAtomic(purchase.amount_atomic)} USDC · Solana Devnet</dd></div>
        <div><dt>{copy.status}</dt><dd>{copy.grantStatuses[purchase.grant_status]}</dd></div>
        <div><dt>{copy.expires}</dt><dd>{date(purchase.expires_at)}</dd></div>
        {purchase.attempt && <div><dt>{copy.attempt}</dt><dd>{copy.attemptStatuses[purchase.attempt.status]}</dd></div>}
        {purchase.attempt?.signature && <div><dt>{t.cryptoPayment.signature}</dt><dd className="break-all font-mono">{purchase.attempt.signature}</dd></div>}
      </dl>
      {purchase.attempt && ['reserved', 'settling', 'pending'].includes(purchase.attempt.status) && <p>{copy.pending}</p>}
      {purchase.grant_status === 'approved' && <button type="button" disabled={busy} className={BUTTON} onClick={() => void run(async () => {
        const result = await revokeX402Grant(purchase.grant_id)
        setNotice(result.revocation.settlement_pending ? 'revokedPending' : 'revoked')
        await refresh()
      })}>{copy.revoke}</button>}
    </section>)}
    {!activePurchase && <section className="space-y-4 rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
      <h2 className="font-bold">{copy.prepare}</h2>
      <label className="block">{t.x402Wallet.choose}<select className={`${INPUT} mt-1`} value={agentId} disabled={busy || !enabled} onChange={event => {
        setAgentId(event.target.value); setQuote(null); setBudgets([]); setBudgetId(''); setConsent(false)
      }}><option value="">{t.x402Wallet.choose}</option>
        {agents.filter(agent => agent.agent_id && agent.wallet_verified_at && !agent.revoked_at).map(agent =>
          <option key={agent.id} value={agent.agent_id!}>{agent.wallet_address}</option>)}
      </select></label>
      {!agents.some(agent => agent.agent_id && !agent.revoked_at) && <p>{t.x402Wallet.empty}</p>}
      <Link href="/profile" className="inline-block text-orange-600 underline dark:text-orange-400">{t.x402Wallet.profile}</Link>
      <button type="button" className={BUTTON} disabled={busy || !enabled || !agentId} onClick={() => void run(async () => {
        setConsent(false); setQuote(null)
        const [preview, available] = await Promise.all([x402QuotePreview(orderNo, agentId), x402Budgets(agentId)])
        setQuote(preview.quote); setBudgets(available.budgets)
        setBudgetId(available.budgets.find(item => Date.parse(item.expires_at) > Date.now())?.id || '')
      })}>{copy.review}</button>
      {quote && <>
        <div className="space-y-2 rounded-xl bg-gray-50 p-4 dark:bg-gray-900">
          <h3 className="font-bold">{copy.reviewTitle}</h3>
          <p>{copy.agentWallet}: <span className="break-all font-mono">{quote.payer}</span></p>
          <p>{copy.amount}: <strong>{formatUsdcAtomic(quote.amount_atomic)} USDC</strong> · Solana Devnet</p>
          <p>{t.cryptoPayment.total}: ฿{quote.total_thb}</p>
          <p>{copy.shipping}: ฿{text(quote.purchase_snapshot.order.shipping_cost) || '0'}</p>
          <p>{copy.discount}: ฿{text(quote.purchase_snapshot.order.discount_amount) || '0'}</p>
          <p>{copy.delivery}: {quote.purchase_snapshot.order.delivery_method === 'pickup' ? copy.pickup : copy.shippingDelivery}</p>
          {quote.purchase_snapshot.order.delivery_method !== 'pickup' && <p>{copy.address}: {[
            'recipient_name', 'shipping_address_line1', 'shipping_address_line2', 'shipping_subdistrict',
            'shipping_district', 'shipping_province', 'shipping_postal_code',
          ].map(key => text(quote.purchase_snapshot.order[key])).filter(Boolean).join(' ')}</p>}
          <ul className="list-inside list-disc">{quote.purchase_snapshot.items.map(item => <li key={text(item.id)}>
            {[text(item.product_name), `${copy.quantity} ${text(item.quantity)}`, text(item.material), text(item.color)].filter(Boolean).join(' · ')}
          </li>)}</ul>
          <Link href="/order-history" className="underline">{copy.reviewDesigns}</Link>
          <p>{copy.recipient}: <span className="break-all font-mono">{quote.recipient}</span></p>
          <p>{copy.expires}: {date(quote.expires_at)}</p>
          <details><summary className="cursor-pointer">{copy.details}</summary><p className="mt-2 break-all">{copy.mint}: {quote.mint}</p><p className="break-all">{copy.snapshot}: {quote.snapshot_hash}</p></details>
        </div>
        <label className="block">{copy.budget}<select className={`${INPUT} mt-1`} value={budgetId} disabled={busy} onChange={event => { setBudgetId(event.target.value); setConsent(false) }}>
          <option value="">{copy.chooseBudget}</option>
          {budgets.filter(item => Date.parse(item.expires_at) > now).map(item => <option key={item.id} value={item.id}>
            {formatUsdcAtomic(item.limit_atomic)} USDC · {date(item.expires_at)} · {item.id}
          </option>)}
        </select></label>
        {budget && <p>{copy.remaining}: {formatUsdcAtomic((BigInt(budget.limit_atomic) - BigInt(budget.reserved_atomic) - BigInt(budget.spent_atomic)).toString())} USDC</p>}
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-0 flex-1">{copy.newBudget}<input type="text" inputMode="decimal" value={limitUsdc} disabled={busy} className={`${INPUT} mt-1`} onChange={event => { setLimitUsdc(event.target.value); setConsent(false) }} /></label>
          <button type="button" disabled={busy || !enabled} className={BUTTON} onClick={() => void run(async () => {
            const result = await createX402Budget(agentId, limitUsdc)
            const available = await x402Budgets(agentId)
            setBudgets(available.budgets); setBudgetId(result.budget.id); setConsent(false)
          })}>{copy.createBudget}</button>
        </div>
        <p className="text-sm">{copy.budgetHint}</p>
        <label className="block">{copy.cap}<input type="text" inputMode="decimal" value={capUsdc} disabled={busy} className={`${INPUT} mt-1`} onChange={event => { setCapUsdc(event.target.value); setConsent(false) }} /></label>
        {limits && <p>{copy.lifetime}: {limits.grant_ttl_seconds} {copy.seconds}</p>}
        <label className="flex items-start gap-3"><input type="checkbox" checked={consent} disabled={busy || !enabled} onChange={event => setConsent(event.target.checked)} className="mt-1 h-5 w-5 shrink-0 accent-orange-500" /><span>{copy.consent}</span></label>
        <button type="button" disabled={!canApprove} className={BUTTON} onClick={() => void run(async () => {
          if (!quote || !limits || !canApprove) return
          await approveX402Grant(quote.id, budgetId, capUsdc, limits.grant_ttl_seconds)
          setConsent(false); setQuote(null); setNotice('approved')
          await refresh()
        })}>{copy.approve}</button>
      </>}
    </section>}
    <Link href="/order-history" className="inline-block text-orange-600 underline dark:text-orange-400">{t.cryptoPayment.history}</Link>
  </div>
}
