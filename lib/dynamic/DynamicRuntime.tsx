'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DynamicProvider, useOnEvent } from '@dynamic-labs-sdk/react-hooks'
import {
  checkUserScopes, isDeviceRegistrationRequired, detectDeviceRegistrationRedirect,
  getDeviceRegistrationTokenFromUrl, completeDeviceRegistration, clearDeviceRegistrationRedirectParams,
} from '@dynamic-labs-sdk/client'
import { createWaasWalletAccounts, getChainsMissingWaasWalletAccounts } from '@dynamic-labs-sdk/client/waas'
import { dynamicClient, dynamicInitialization } from '@/lib/dynamic/dynamicClient'
import { DynamicReadyContext } from '@/lib/dynamic/DynamicReadyContext'
import { supabase } from '@/lib/supabase'
import { useLocale } from '@/lib/i18n/LocaleContext'

let bootstrap: Promise<void> | null = null
export function bootstrapEmbeddedWallets() {
  if (bootstrap) return bootstrap
  const user = dynamicClient.user
  if (!user || isDeviceRegistrationRequired(user) || !checkUserScopes({ user, scopes: ['user:basic'] })) return Promise.resolve()
  const chains = getChainsMissingWaasWalletAccounts().filter(chain => chain === 'EVM' || chain === 'SOL')
  if (!chains.length) return Promise.resolve()
  bootstrap = createWaasWalletAccounts({ chains }).finally(() => { bootstrap = null })
  return bootstrap
}

async function reconcileDynamicSession() {
  const { data: { session } } = await supabase.auth.getSession()
  if (session?.user.app_metadata?.printkub_provider !== 'dynamic') return
  const user = dynamicClient.user
  if (!user || user.id !== session.user.app_metadata.dynamic_subject
    || session.user.app_metadata.dynamic_environment_id !== process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID) {
    await supabase.auth.signOut()
  }
}

function Lifecycle() {
  const [failed, setFailed] = useState(false)
  const { t } = useLocale()
  const createWallets = () => { void bootstrapEmbeddedWallets().then(() => setFailed(false)).catch(() => setFailed(true)) }
  useOnEvent({ event: 'userChanged', listener: async ({ user }) => {
    try {
      await reconcileDynamicSession()
      if (user) createWallets()
    } catch { setFailed(true) }
  } })
  useOnEvent({ event: 'deviceRegistrationCompleted', listener: createWallets })
  useOnEvent({ event: 'deviceRegistrationCompletedInAnotherTab', listener: createWallets })
  useEffect(() => {
    let active = true
    void dynamicInitialization.then(async () => {
      const url = window.location.href
      if (detectDeviceRegistrationRedirect({ url })) {
        await completeDeviceRegistration({ deviceToken: getDeviceRegistrationTokenFromUrl({ url }) })
        clearDeviceRegistrationRedirectParams()
      }
      await reconcileDynamicSession()
      await bootstrapEmbeddedWallets()
    }).catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [])
  return failed ? <div role="alert" className="fixed bottom-4 left-4 right-4 z-[110] rounded-lg bg-orange-50 p-4 text-orange-900 dark:bg-orange-950 dark:text-orange-100">
    {t.auth.dynamicWalletError} <button className="underline" onClick={createWallets}>{t.auth.dynamicRetry}</button>
  </div> : null
}

export function DynamicRuntime({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())
  return <QueryClientProvider client={queryClient}>
    <DynamicProvider client={dynamicClient}>
      <DynamicReadyContext.Provider value={true}>
        <Lifecycle />
        {children}
      </DynamicReadyContext.Provider>
    </DynamicProvider>
  </QueryClientProvider>
}
