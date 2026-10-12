interface PublicKeyLike { toBase58(): string }
interface Instruction {
  programId: PublicKeyLike
  keys: Array<{ pubkey: PublicKeyLike; isSigner: boolean; isWritable: boolean }>
  data: Uint8Array
}
interface SignedTransaction {
  serializeMessage(): { toString(encoding: 'base64'): string }
  feePayer?: PublicKeyLike
  signatures: unknown[]
  signature: unknown
  verifySignatures(): boolean
  recentBlockhash?: string
  instructions: Instruction[]
  compileMessage(): {
    accountKeys: PublicKeyLike[]
    isAccountSigner(index: number): boolean
    isAccountWritable(index: number): boolean
  }
}

const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
export const MAX_WALLET_PRIORITY_FEE_LAMPORTS = BigInt(100000) // 0.0001 SOL
const MAX_COMPUTE_UNITS = 1400000

function sameInstruction(actual: Instruction, expected: Instruction): boolean {
  return actual.programId.toBase58() === expected.programId.toBase58()
    && actual.data.length === expected.data.length
    && actual.data.every((byte, index) => byte === expected.data[index])
    && actual.keys.length === expected.keys.length
    && actual.keys.every((key, index) => {
      const wanted = expected.keys[index]
      return key.pubkey.toBase58() === wanted.pubkey.toBase58()
        && key.isSigner === wanted.isSigner && key.isWritable === wanted.isWritable
    })
}

// Permit only the two standard, account-free compute-budget instructions.
// Bound the total priority fee, reject duplicates/unknown opcodes, and retain
// every payment instruction and account permission in its original order.
export function equivalentPaymentMessage(actual: SignedTransaction, expected: SignedTransaction): boolean {
  const core: Instruction[] = []
  const seen = new Set<number>()
  let units = MAX_COMPUTE_UNITS
  let price = BigInt(0)
  for (const instruction of actual.instructions) {
    if (instruction.programId.toBase58() !== COMPUTE_BUDGET_PROGRAM) {
      core.push(instruction)
      continue
    }
    if (instruction.keys.length || seen.has(instruction.data[0])) return false
    const data = new DataView(instruction.data.buffer, instruction.data.byteOffset, instruction.data.byteLength)
    if (instruction.data[0] === 2 && instruction.data.length === 5) {
      units = data.getUint32(1, true)
      if (units < 1 || units > MAX_COMPUTE_UNITS) return false
    } else if (instruction.data[0] === 3 && instruction.data.length === 9) {
      price = data.getBigUint64(1, true)
    } else return false
    seen.add(instruction.data[0])
  }
  const priorityFee = (BigInt(units) * price + BigInt(999999)) / BigInt(1000000)
  if (priorityFee > MAX_WALLET_PRIORITY_FEE_LAMPORTS) return false
  if (core.length !== expected.instructions.length || !core.every((instruction, index) => sameInstruction(instruction, expected.instructions[index]))) return false
  // Reject extra message accounts, even if none of the instructions uses them.
  const expectedMessage = expected.compileMessage()
  const allowedAccounts = new Map(expectedMessage.accountKeys.map((key, index) => [key.toBase58(), {
    signer: expectedMessage.isAccountSigner(index), writable: expectedMessage.isAccountWritable(index),
  }]))
  if (seen.size) allowedAccounts.set(COMPUTE_BUDGET_PROGRAM, { signer: false, writable: false })
  const actualMessage = actual.compileMessage()
  return actualMessage.accountKeys.length === allowedAccounts.size && actualMessage.accountKeys.every((key, index) => {
    const permissions = allowedAccounts.get(key.toBase58())
    return !!permissions && actualMessage.isAccountSigner(index) === permissions.signer
      && actualMessage.isAccountWritable(index) === permissions.writable
  })
}

export function walletMessageDiagnostic(actual: SignedTransaction, expected: SignedTransaction) {
  return {
    blockhashChanged: actual.recentBlockhash !== expected.recentBlockhash,
    computeBudgetInstructions: actual.instructions.filter(instruction => instruction.programId.toBase58() === COMPUTE_BUDGET_PROGRAM).length,
    equivalentPayment: equivalentPaymentMessage(actual, expected),
  }
}

export function signedTransactionError(tx: SignedTransaction, expected: {
  message: string | null; payer: string; transaction?: SignedTransaction
}): string | null {
  if (!expected.message) return 'transaction_message_mismatch'
  if (tx.serializeMessage().toString('base64') !== expected.message
    && (!expected.transaction || !equivalentPaymentMessage(tx, expected.transaction))) return 'transaction_message_mismatch'
  if (tx.signatures.length !== 1 || tx.feePayer?.toBase58() !== expected.payer) return 'transaction_signer_mismatch'
  if (!tx.signature || !tx.verifySignatures()) return 'transaction_signature_invalid'
  return null
}

export function simulationError(error: unknown): string | null {
  if (error === null) return null
  if (error === 'BlockhashNotFound') return 'transaction_blockhash_expired'
  if (error === 'InsufficientFundsForFee') return 'insufficient_sol'
  if (error === 'SignatureFailure') return 'transaction_signature_invalid'
  return 'transaction_simulation_failed'
}

// Do not log provider messages, program logs, transaction bytes, or addresses.
export function simulationDiagnostic(error: unknown): Record<string, string | number> {
  if (error === null) return { simulationKind: 'success' }
  if (['BlockhashNotFound', 'InsufficientFundsForFee', 'SignatureFailure', 'AccountNotFound', 'ProgramAccountNotFound'].includes(String(error))) {
    return { simulationKind: String(error) }
  }
  if (error && typeof error === 'object' && 'InstructionError' in error && Array.isArray(error.InstructionError)) {
    const [index, detail] = error.InstructionError
    const result: Record<string, string | number> = { simulationKind: 'InstructionError' }
    if (Number.isInteger(index) && index >= 0) result.instructionIndex = index
    if (detail && typeof detail === 'object' && Number.isInteger(detail.Custom)) result.customCode = detail.Custom
    return result
  }
  return { simulationKind: 'unknown' }
}
