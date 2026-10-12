'use client'

import dynamic from 'next/dynamic'
import { useSyncExternalStore, type ReactNode } from 'react'
import { FEATURE_FLAGS } from '@/lib/config/featureFlags'

const RuntimeProvider = dynamic(() => import('@/lib/dynamic/DynamicRuntime').then(module => module.DynamicRuntime), { ssr: false })
const subscribe = () => () => {}

export function DynamicProviderGate({ children }: { children: ReactNode }) {
  const mounted = useSyncExternalStore(subscribe, () => true, () => false)
  if (!FEATURE_FLAGS.dynamicAuth || !process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID || !mounted) return children
  return <RuntimeProvider>{children}</RuntimeProvider>
}
