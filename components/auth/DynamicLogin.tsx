'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, CheckCircle2, QrCode, Sparkles } from 'lucide-react'
import { useInitStatus, useUser, useGetWalletAccounts, useOnEvent, useGetWalletOptionsCatalogue } from '@dynamic-labs-sdk/react-hooks'
import { checkUserScopes, isDeviceRegistrationRequired, getCaptchaSettings, isCaptchaRequired, setCaptchaToken, logout, connectAndVerifyWithWalletProvider, getWalletAccounts, type WithWalletProviderConnectionOption } from '@dynamic-labs-sdk/client'
import { connectAndVerifyWithWalletConnectEvm } from '@dynamic-labs-sdk/evm/wallet-connect'
import { connectAndVerifyWithWalletConnectSolana } from '@dynamic-labs-sdk/solana/wallet-connect'
import { isSolanaWalletAccount } from '@dynamic-labs-sdk/solana'
import QRCode from 'qrcode'
import { dynamicClient, dynamicInitialization } from '@/lib/dynamic/dynamicClient'
import { bootstrapEmbeddedWallets } from '@/lib/dynamic/DynamicRuntime'
import { authenticateDynamicUser } from '@/lib/supabase'
import { DynamicCaptcha } from '@/components/auth/DynamicCaptcha'
import { useLocale } from '@/lib/i18n/LocaleContext'

export function DynamicLogin({ onSuccess, exchangeSession = true }: { onSuccess: () => void; exchangeSession?: boolean }) {
  const { t } = useLocale()
  const { data: status } = useInitStatus()
  const { data: user } = useUser()
  const { data: accounts = [] } = useGetWalletAccounts()
  const hasPaymentWallet = accounts.some(wallet => isSolanaWalletAccount(wallet) && !!wallet.verifiedCredentialId)
  const captchaSettings = status === 'finished' ? getCaptchaSettings() : undefined
  const captchaRequired = status === 'finished' && isCaptchaRequired()
  const [captchaToken, setChallengeToken] = useState<string | null>(null)
  const [captchaAttempt, setCaptchaAttempt] = useState(0)
  const [walletChain, setWalletChain] = useState<'EVM' | 'SOL'>('SOL')
  const catalogue = useGetWalletOptionsCatalogue({ queryParams: { enabled: status === 'finished' } })
  const browserWallets = (catalogue.data || []).flatMap(wallet => {
    const connection = wallet.connectionOptions.find((option): option is WithWalletProviderConnectionOption =>
      option.type === 'withWalletProvider' && option.chain === walletChain
      && (option.source === 'selfAnnounced' || option.source === 'windowInjected'))
    return connection ? [{ wallet, connection }] : []
  }).sort((a, b) => Number(b.wallet.key === 'phantom') - Number(a.wallet.key === 'phantom'))
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [uri, setUri] = useState<string | null>(null)
  const [actionRequested, setActionRequested] = useState(false)
  const generation = useRef(0)
  const running = useRef(false)
  const attemptedSubject = useRef<string | null>(null)
  useOnEvent({ event: 'walletConnectUserActionRequested', listener: () => setActionRequested(true) })

  const run = useCallback(async (action: () => Promise<void>, failureMessage = t.auth.dynamicError) => {
    if (running.current) return
    running.current = true
    setBusy(true); setError(null)
    try { await action() } catch {
      setError(failureMessage)
    } finally { running.current = false; setBusy(false) }
  }, [t.auth.dynamicError])
  const finish = useCallback(async () => {
    const currentUser = dynamicClient.user
    if (!currentUser || !dynamicClient.token || isDeviceRegistrationRequired(currentUser)
      || !checkUserScopes({ user: currentUser, scopes: ['user:basic'] })) throw new Error('auth_incomplete')
    if (!exchangeSession && !getWalletAccounts().some(wallet => isSolanaWalletAccount(wallet) && !!wallet.verifiedCredentialId)) throw new Error('wallet_not_verified')
    if (exchangeSession) await authenticateDynamicUser(dynamicClient.token, currentUser.id)
    onSuccess()
  }, [onSuccess, exchangeSession])
  // Attempt once per identity. A failed exchange remains available for manual retry.
  useEffect(() => {
    if (status !== 'finished' || busy || !user || isDeviceRegistrationRequired(user)
      || !checkUserScopes({ user, scopes: ['user:basic'] }) || !dynamicClient.token
      || (!exchangeSession && !hasPaymentWallet) || attemptedSubject.current === user.id) return
    attemptedSubject.current = user.id
    void run(finish, t.auth.dynamicSessionError)
  }, [status, busy, user, run, finish, t.auth.dynamicSessionError, exchangeSession, hasPaymentWallet])
  const runWallet = (action: () => Promise<void>) => run(async () => {
    await dynamicInitialization
    if (isCaptchaRequired()) {
      if (!captchaToken) throw new Error('captcha_required')
      // The SDK consumes this token in walletsSignin; Dynamic verifies it server-side.
      setCaptchaToken({ captchaToken })
    }
    try { await action() } finally {
      setCaptchaToken({ captchaToken: '' })
      setChallengeToken(null)
      setCaptchaAttempt(attempt => attempt + 1)
    }
  })
  const connect = (chain: 'EVM' | 'SOL') => runWallet(async () => {
    setCopied(false); setActionRequested(false)
    const currentGeneration = ++generation.current
    await dynamicInitialization
    const connection = await (chain === 'EVM' ? connectAndVerifyWithWalletConnectEvm() : connectAndVerifyWithWalletConnectSolana())
    setUri(connection.uri)
    setQr(await QRCode.toDataURL(connection.uri, { margin: 4, color: { dark: '#000000', light: '#FFFFFF' } }))
    try {
      await connection.approval()
    } finally {
      if (generation.current === currentGeneration) {
        setQr(null); setUri(null); setActionRequested(false)
      }
    }
    // Completion can require device registration. Keep the form open for it.
  })
  const connectBrowserWallet = (walletProviderKey: string) => runWallet(async () => {
    await dynamicInitialization
    await connectAndVerifyWithWalletProvider({ walletProviderKey })
  })
  const pending = busy
  const walletDisabled = pending || (captchaRequired && !captchaToken)
  const buttonClass = 'flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-violet-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:opacity-50'
  const secondaryClass = 'flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-white/15 bg-black/30 px-4 py-3 text-sm font-medium text-white transition-colors hover:border-violet-400/60 hover:bg-violet-500/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:opacity-50'
  return <section className="dynamic-login-space relative isolate mt-5 overflow-hidden rounded-2xl border border-violet-400/30 p-4 text-white sm:p-5" aria-busy={pending}>
    <span className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-emerald-300/30 bg-emerald-300/10 px-2.5 py-1 text-[10px] font-semibold tracking-wide text-emerald-200">
      <Sparkles aria-hidden="true" className="h-3 w-3" />{t.auth.dynamicHackathonLabel}
    </span>
    <h3 className="text-sm font-semibold text-white">{exchangeSession ? t.auth.dynamicLoginTitle : t.cryptoPayment.connectWallet}</h3>
    {error && <p role="alert" className="mt-3 rounded-xl border border-rose-400/30 bg-rose-950/80 p-3 text-sm text-rose-200">{error}</p>}
    {status !== 'finished' ? <p role="status" className="mt-3 text-sm">{status === 'failed' ? t.auth.dynamicError : t.auth.dynamicLoading}</p> : user ? <>
      {isDeviceRegistrationRequired(user) ? <p role="status" className="mt-3 text-sm">{t.auth.dynamicRegisterDevice}</p> : <>
        <div className="mt-3 rounded-xl border border-white/10 bg-black/30 p-3">
          <p className="flex items-center gap-2 text-sm font-medium"><CheckCircle2 aria-hidden="true" className="h-4 w-4 text-emerald-300" />{t.auth.dynamicConnected}</p>
          {accounts.map(wallet => <p key={wallet.id} className="mt-1 break-all text-xs text-violet-100/80">{wallet.address}</p>)}
          <p className="mt-2 text-xs text-violet-100/80">{exchangeSession ? t.auth.dynamicSessionHint : t.cryptoPayment.walletConnectionHint}</p>
        </div>
        <button disabled={pending || (!exchangeSession && !hasPaymentWallet) || !checkUserScopes({ user, scopes: ['user:basic'] })} className={`${buttonClass} mt-3`} onClick={() => void run(finish, t.auth.dynamicSessionError)}>{pending ? t.common.signingIn : (exchangeSession ? t.auth.dynamicContinue : t.cryptoPayment.connectWallet)}</button>
        {!checkUserScopes({ user, scopes: ['user:basic'] }) && <p role="status" className="mt-2 text-sm">{t.auth.dynamicIncomplete}</p>}
        <details className="mt-3 text-xs text-violet-100/80">
          <summary className="cursor-pointer">{t.auth.dynamicRetryWallets}</summary>
          <button disabled={pending} className="mt-2 min-h-11 underline" onClick={() => void run(bootstrapEmbeddedWallets)}>{t.auth.dynamicRetry}</button>
        </details>
      </>}
      {exchangeSession && <button disabled={pending} className={`${secondaryClass} mt-3`} onClick={() => void run(async () => { await logout(); attemptedSubject.current = null; setChallengeToken(null); setCaptchaAttempt(attempt => attempt + 1); setQr(null); setUri(null); setActionRequested(false) })}>{t.auth.dynamicChangeAccount}</button>}
    </> : <>
      <p className="mt-2 text-xs leading-relaxed text-violet-100/80">{t.auth.dynamicWalletHint}</p>
      {captchaRequired && <DynamicCaptcha key={captchaAttempt} settings={captchaSettings} onToken={setChallengeToken} />}
      {!qr && <>
        <div role="group" aria-label={t.auth.dynamicChooseNetwork} className="mt-4 flex gap-1 rounded-xl border border-white/10 bg-black/40 p-1">
          {(['SOL', 'EVM'] as const).map(chain => <button key={chain} aria-pressed={walletChain === chain} disabled={pending} onClick={() => { setWalletChain(chain); setError(null) }} className={`min-h-11 flex-1 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-50 ${walletChain === chain ? 'bg-gradient-to-r from-violet-600 to-purple-600 text-white shadow-sm' : 'text-violet-200 hover:bg-white/5'}`}>
            {chain === 'SOL' ? 'Solana' : 'Ethereum'}
          </button>)}
        </div>
        <div className="mt-3 space-y-2">
          {browserWallets.map(({ wallet, connection }) => <button key={wallet.key} disabled={walletDisabled} className={`${secondaryClass.replace('justify-center', 'justify-between')} text-left`} onClick={() => void connectBrowserWallet(connection.walletProviderKey)}>
            <span className="flex min-w-0 items-center gap-3">
              {/* SDK metadata supplies the brand icon; connection uses its live provider key. */}
              <img src={wallet.iconUrl} alt="" className="h-9 w-9 shrink-0 rounded-lg" />
              <span className="min-w-0"><span className="block truncate font-semibold">{wallet.name}</span><span className="mt-0.5 block text-xs text-violet-100/80">{t.auth.dynamicDetectedWallet}</span></span>
            </span>
            <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0" />
          </button>)}
          {catalogue.isLoading ? <p role="status" className="p-3 text-xs text-violet-100/80">{t.auth.dynamicDetectingWallets}</p>
            : !browserWallets.length && <p role="status" className="rounded-xl border border-white/10 bg-black/30 p-3 text-xs leading-relaxed text-violet-100/80">{t.auth.dynamicNoBrowserWallet}</p>}
          <button disabled={walletDisabled} className={`${secondaryClass.replace('justify-center', 'justify-between')} text-left`} onClick={() => void connect(walletChain)}>
            <span className="flex items-center gap-3"><QrCode aria-hidden="true" className="h-9 w-9 rounded-lg bg-blue-50 p-2 text-blue-600" /><span><span className="block font-semibold">WalletConnect</span><span className="mt-0.5 block text-xs text-violet-100/80">{t.auth.dynamicWalletConnectHint}</span></span></span>
            <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0" />
          </button>
        </div>
      </>}
      {pending && !qr && <p role="status" className="mt-3 text-sm">{t.auth.dynamicWorking}</p>}
      <p className="mt-3 text-xs text-violet-100/80">{t.auth.dynamicWalletSignatureHint}</p>
    </>}
    {qr && !user && <div className="mt-3 rounded-xl border border-gray-200 bg-white p-4 text-center text-gray-900">
      <p className="text-sm font-semibold">{t.auth.dynamicScanQr}</p>
      <img src={qr} alt={t.auth.dynamicScanQr} className="mx-auto my-3 h-auto w-56 max-w-full" />
      <p className="text-xs leading-relaxed">{t.auth.dynamicQrHint}</p>
      <button className="mt-3 min-h-11 text-sm underline" onClick={() => {
        if (uri) void navigator.clipboard.writeText(uri).then(() => setCopied(true)).catch(() => setError(t.auth.dynamicError))
      }}>{copied ? t.auth.dynamicCopySuccess : t.auth.dynamicCopyUri}</button>
      {copied && <span role="status" className="sr-only">{t.auth.dynamicCopySuccess}</span>}
    </div>}
    {actionRequested && !user && <p role="status" className="mt-2 text-sm">{t.auth.dynamicApproveWallet}</p>}
    <p className="mt-4 text-xs leading-relaxed text-violet-100/80">{exchangeSession ? t.auth.dynamicSeparateAccount : t.cryptoPayment.walletConnectionHint}</p>
  </section>
}
