// Public Circle-issued native USDC addresses, not secrets.
// Source: https://developers.circle.com/stablecoins/usdc-contract-addresses
export const CRYPTO_NETWORKS = {
  'solana-devnet': {
    family: 'SOL', network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', decimals: 6,
    genesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    cluster: 'devnet', explorer: 'https://explorer.solana.com', implemented: true,
  },
  'ethereum-sepolia': {
    family: 'EVM', network: 'eip155:11155111', chainId: 11155111,
    asset: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', decimals: 6, implemented: false,
  },
  'arbitrum-sepolia': {
    family: 'EVM', network: 'eip155:421614', chainId: 421614,
    asset: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', decimals: 6, implemented: false,
  },
} as const
