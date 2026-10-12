'use client'

import { createDynamicClient, initializeClient } from '@dynamic-labs-sdk/client'
import { addWaasEvmExtension } from '@dynamic-labs-sdk/evm/waas'
import { addWaasSolanaExtension } from '@dynamic-labs-sdk/solana/waas'
import { addEIP6963Extension } from '@dynamic-labs-sdk/evm/eip6963'
import { addEvmWindowInjectedExtension } from '@dynamic-labs-sdk/evm/window-injected'
import { addSolanaWalletStandardExtension } from '@dynamic-labs-sdk/solana/walletStandard'
import { addWalletConnectEvmExtension } from '@dynamic-labs-sdk/evm/wallet-connect'
import { addWalletConnectSolanaExtension } from '@dynamic-labs-sdk/solana/wallet-connect'
import { FEATURE_FLAGS } from '@/lib/config/featureFlags'

// This module is imported only by the browser-only runtime, never by layout.tsx.
const environmentId = process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID
if (typeof window === 'undefined' || !FEATURE_FLAGS.dynamicAuth || !environmentId) {
  throw new Error('Dynamic is unavailable')
}

export const dynamicClient = createDynamicClient({
  autoInitialize: false,
  environmentId,
  metadata: { name: 'PrintKub', universalLink: window.location.origin },
  transformers: {
    networksData: networks => networks.filter(network => network.testnet && (
      (network.chain === 'EVM' && ['11155111', '421614'].includes(network.networkId))
      || (network.chain === 'SOL' && network.cluster === 'devnet')
    )),
  },
})

addWaasEvmExtension()
addWaasSolanaExtension()
// Browser-wallet discovery uses each chain's standard; WalletConnect stays available.
addEIP6963Extension()
addEvmWindowInjectedExtension()
addSolanaWalletStandardExtension()
// WalletConnect restores sessions using initialized project settings.
export const dynamicInitialization = initializeClient().then(async () => {
  await Promise.all([addWalletConnectEvmExtension(), addWalletConnectSolanaExtension()])
})

// Record failures in the mounted UI without an unhandled module-load rejection.
void dynamicInitialization.catch(() => {})
