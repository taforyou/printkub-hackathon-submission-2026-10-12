// Dynamic API credentials use `solana`; SDK WalletAccount objects use `SOL`.
// Accept the legacy credential spelling too, without trusting client accounts.
export function verifiedSolanaAddresses(credentials: unknown): string[] {
  if (!Array.isArray(credentials)) return []
  return credentials.flatMap(value =>
    value && typeof value === 'object' && value.format === 'blockchain'
      && (value.chain === 'solana' || value.chain === 'SOL')
      && typeof value.address === 'string' && value.address.length > 0
      ? [value.address] : [])
}
