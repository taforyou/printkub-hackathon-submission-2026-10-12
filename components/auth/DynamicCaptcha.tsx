'use client'

import { useEffect, useRef, useState } from 'react'
import { CaptchaProviderEnum, type CaptchaSettingsResult } from '@dynamic-labs-sdk/client'
import { useLocale } from '@/lib/i18n/LocaleContext'
import { useTheme } from '@/lib/theme/ThemeContext'

type CaptchaApi = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string | number
  remove: (id: string | number) => void
}
type CaptchaWindow = Window & {
  hcaptcha?: CaptchaApi
  turnstile?: CaptchaApi
  printkubHcaptchaReady?: () => void
  printkubTurnstileReady?: () => void
}

const scripts = new Map<string, Promise<CaptchaApi>>()

function loadCaptcha(provider: CaptchaProviderEnum): Promise<CaptchaApi> {
  const existing = scripts.get(provider)
  if (existing) return existing
  const browser = window as CaptchaWindow
  const hcaptcha = provider === CaptchaProviderEnum.Hcaptcha
  const callback = hcaptcha ? 'printkubHcaptchaReady' : 'printkubTurnstileReady'
  const script = document.createElement('script')
  const promise = new Promise<CaptchaApi>((resolve, reject) => {
    const timeout = window.setTimeout(fail, 20000)
    function fail() {
      window.clearTimeout(timeout)
      delete browser[callback]
      script.remove()
      scripts.delete(provider)
      reject(new Error('captcha_unavailable'))
    }
    browser[callback] = () => {
      const api = hcaptcha ? browser.hcaptcha : browser.turnstile
      if (!api) return fail()
      window.clearTimeout(timeout)
      delete browser[callback]
      resolve(api)
    }
    script.src = hcaptcha
      ? `https://js.hcaptcha.com/1/api.js?render=explicit&recaptchacompat=off&onload=${callback}`
      : `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=${callback}`
    script.async = true
    script.onerror = fail
    document.head.appendChild(script)
  })
  scripts.set(provider, promise)
  return promise
}

export function DynamicCaptcha({ settings, onToken }: {
  settings: CaptchaSettingsResult | undefined
  onToken: (token: string | null) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const { t, locale } = useLocale()
  const { theme } = useTheme()
  const provider = settings?.provider
  const siteKey = settings?.siteKey
  const supported = provider === CaptchaProviderEnum.Hcaptcha || provider === CaptchaProviderEnum.CloudflareTurnstile

  useEffect(() => {
    if (!supported || !provider || !siteKey) return
    let active = true
    let api: CaptchaApi | undefined
    let widget: string | number | undefined
    const invalidate = () => { if (active) onToken(null) }
    void loadCaptcha(provider).then(loaded => {
      if (!active || !container.current) return
      api = loaded
      widget = api.render(container.current, {
        sitekey: siteKey,
        theme,
        ...(provider === CaptchaProviderEnum.Hcaptcha ? { hl: locale, size: 'compact' } : { language: locale, size: 'flexible' }),
        callback: (token: string) => { if (active) { setFailed(false); onToken(token) } },
        'expired-callback': invalidate,
        'timeout-callback': invalidate,
        'chalexpired-callback': invalidate,
        'error-callback': () => { if (active) { onToken(null); setFailed(true) } },
      })
    }).catch(() => { if (active) { onToken(null); setFailed(true) } })
    return () => {
      active = false
      onToken(null)
      if (api && widget !== undefined) api.remove(widget)
    }
  }, [supported, provider, siteKey, locale, theme, retry, onToken])

  const unavailable = !supported || !siteKey || failed
  return <div className="mt-3">
    <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">{t.auth.dynamicCaptchaHint}</p>
    <div ref={container} />
    {unavailable && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{t.auth.dynamicCaptchaError}</p>}
    {failed && <button className="mt-2 min-h-11 text-sm underline" onClick={() => { setFailed(false); setRetry(value => value + 1) }}>{t.auth.dynamicRetry}</button>}
  </div>
}
