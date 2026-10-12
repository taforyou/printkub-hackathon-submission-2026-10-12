// Owner-run isolated payment tool. Never import into a browser/model runtime.
import { createClient } from 'npm:@supabase/supabase-js@2.99.1'
import { Keypair, PublicKey, ComputeBudgetProgram, TransactionMessage, TransactionInstruction, VersionedTransaction } from 'npm:@solana/web3.js@1.98.1'
import { createTransferCheckedInstruction } from 'npm:@solana/spl-token@0.4.14'
import { Buffer } from 'node:buffer'
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from 'npm:@x402/core@2.28.0/http'
import { assertAgentPurchase, assertAgentChallenge, assertAgentBudget, executeAgentPayment, assertAgentWalletChallenge,
  agentFundingMode, type X402SignerPolicy, type X402Execution } from '../../supabase/functions/_shared/x402-agent-rules.ts'
import { validateX402Payment, x402Accounts } from '../../supabase/functions/_shared/x402-solana.ts'
import { usdcAtomic } from '../../supabase/functions/_shared/x402-permission-rules.ts'
import { MEMO_PROGRAM, SOLANA_DEVNET_GENESIS } from '../../supabase/functions/_shared/solana-payment-rules.ts'
import type { X402Purchase } from '../../supabase/functions/_shared/x402-payment-rules.ts'

// Only locally constructed diagnostics may be printed. Never expose external
// error messages, response bodies, configuration values, or signing material.
class RunnerError extends Error {}
let stage = 'configuration'

function env(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new RunnerError(`configuration_missing:${name}`)
  return value
}
interface Journal { version: 1; policy: X402SignerPolicy; entries: X402Execution[]; requests?: { requestId: string; productId: string; options: unknown }[] }
async function main() {
  const [action, target] = Deno.args
  let grantId = target
  const purchaseRequestId = action === 'buy' ? Deno.args[Deno.args.indexOf('--request-id') + 1] : action === 'purchase-status' ? target : null
  if (!['pay','status','verify-wallet','recover','list-products','get-product','buy','purchase-status'].includes(action)
    || (['pay','status'].includes(action) && !/^[0-9a-f-]{36}$/i.test(grantId || ''))) throw new Error('invalid_action')
  if (['get-product', 'buy', 'purchase-status'].includes(action) && !/^[0-9a-f-]{36}$/i.test(target || '')) throw new Error('invalid_action')
  if (action === 'buy' && (Deno.args.indexOf('--request-id') < 0 || !/^[0-9a-f-]{36}$/i.test(purchaseRequestId || '')
    || Deno.args.indexOf('--quantity') < 0 || Deno.args[Deno.args.indexOf('--quantity') + 1] !== '1')) throw new Error('invalid_action')
  const project = new URL(env('X402_RUNNER_SUPABASE_URL'))
  if (project.protocol !== 'https:' || project.username || project.password || project.pathname !== '/') throw new Error('invalid_project')
  const client = createClient(project.origin, env('X402_RUNNER_ANON_KEY'), { auth: { autoRefreshToken: false, persistSession: false } })
  // Recovery remains a separate scheduler identity without a wallet key.
  let signer: Keypair | null = null
  let accessToken: string
  if (action === 'recover') {
    stage = 'recovery_login'
    const { data: login, error } = await client.auth.signInWithPassword({
      email: env('X402_RUNNER_EMAIL'), password: env('X402_RUNNER_PASSWORD'),
    })
    if (error || !login.session) throw new Error('authentication_failed')
    accessToken = login.session.access_token
  } else {
    const keyPath = env('X402_RUNNER_KEY_FILE')
    const linkId = env('X402_RUNNER_LINK_ID')
    const authDomain = env('X402_RUNNER_AUTH_DOMAIN')
    const authUserId = env('X402_RUNNER_AUTH_USER_ID')
    stage = 'key_file_metadata'
    const keyInfo = await Deno.lstat(keyPath)
    if (!keyInfo.isFile || keyInfo.isSymlink || keyInfo.mode === null || (keyInfo.mode & 0o077) !== 0) throw new RunnerError('private_key_permissions_required')
    stage = 'key_file_read'
    const keyBytes = JSON.parse(await Deno.readTextFile(keyPath))
    if (!Array.isArray(keyBytes) || keyBytes.length !== 64 || !keyBytes.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) throw new RunnerError('invalid_key_file')
    stage = 'keypair_loading'
    signer = Keypair.fromSecretKey(new Uint8Array(keyBytes))
    const authRequest = async (action: 'challenge' | 'login', body: unknown) => {
      stage = `wallet_${action}_request`
      const response = await fetch(`${project.origin}/functions/v1/authenticate-x402-agent`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
        headers: { apikey: env('X402_RUNNER_ANON_KEY'), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      if (!response.ok) throw new RunnerError(`authentication_http_${response.status}`)
      stage = `wallet_${action}_response`
      const result = await response.json()
      if (!result?.success) throw new RunnerError('authentication_failed')
      return result
    }
    const { challenge } = await authRequest('challenge', { action: 'challenge', linkId })
    stage = 'wallet_challenge_validation'
    assertAgentWalletChallenge(challenge, authDomain, authUserId,
      signer.publicKey.toBase58(), Date.now(), 'Sign in to the linked PrintKub agent only. This message does not authorize a payment.')
    stage = 'wallet_challenge_signing'
    const privateKey = await crypto.subtle.importKey('pkcs8', new Uint8Array(Buffer.concat([
      Buffer.from('302e020100300506032b657004220420','hex'), Buffer.from(signer.secretKey.slice(0,32)),
    ])).buffer, 'Ed25519', false, ['sign'])
    const signature = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(challenge.message))
    const login = await authRequest('login', { action: 'login', challengeId: challenge.id, signatureBase64: Buffer.from(signature).toString('base64') })
    stage = 'wallet_login_validation'
    if (!login.session?.access_token || login.agent?.auth_user_id !== authUserId
      || login.agent?.wallet_address !== signer.publicKey.toBase58()) throw new RunnerError('authentication_failed')
    accessToken = login.session.access_token
    if (action === 'verify-wallet') {
      console.log(JSON.stringify({ verified: true, agentId: login.agent.id })); return
    }
  }
  stage = action
  const endpoint = `${project.origin}/functions/v1/x402-pay`
  async function request(name: string, body: unknown, extra: Record<string, string> = {}) {
    const response = await fetch(`${project.origin}/functions/v1/${name}`, { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${accessToken}`,
        apikey: env('X402_RUNNER_ANON_KEY'), 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) })
    return { response, body: await response.json() }
  }
  if (action === 'recover') {
    const result = await request('x402-reconcile', {})
    if (!result.response.ok || result.body.success !== true) throw new Error('recovery_unavailable')
    console.log(JSON.stringify(result.body)); return
  }
  if (action === 'list-products' || action === 'get-product') {
    const result = await request('agent-catalog', { action: action === 'list-products' ? 'list' : 'get', productId: target })
    if (!result.response.ok || !result.body.success) throw new RunnerError('catalog_unavailable')
    console.log(JSON.stringify({ products: result.body.products })); return
  }
  const purchaseReceipt = async () => {
    const result = await request('x402-purchase', { action: 'status', requestId: purchaseRequestId })
    if (!result.response.ok || !result.body.receipt) throw new RunnerError('purchase_status_unavailable')
    return result.body.receipt
  }
  if (action === 'purchase-status') {
    console.log(JSON.stringify(await purchaseReceipt())); return
  }
  const status = async () => {
    const result = await request('x402-pay', { action: 'status', grantId })
    if (!result.response.ok || !result.body.purchase) throw new Error('status_unavailable')
    return result.body.purchase as X402Purchase
  }
  if (action === 'status') {
    const purchase = await status()
    console.log(JSON.stringify({ grantId, status: purchase.attempt?.status || 'unstarted', signature: purchase.attempt?.signature || null })); return
  }
  if (!signer) throw new Error('authentication_failed')
  const paymentSigner = signer
  // This retired setting is optional and needs no extra Deno env permission.
  // Reject it when readable; backend/quote checks also reject funded purchases.
  let legacyFundingMode: string | undefined
  try { legacyFundingMode = Deno.env.get('X402_RUNNER_FUNDING_MODE') }
  catch (error) { if (!(error instanceof Deno.errors.NotCapable)) throw error }
  try { agentFundingMode(legacyFundingMode) }
  catch { throw new RunnerError('printkub_funding_disabled') }
  const policy: X402SignerPolicy = { endpoint, payer: signer.publicKey.toBase58(), recipient: env('X402_RUNNER_RECIPIENT'),
    sponsor: env('X402_RUNNER_SPONSOR'), maxOrderAtomic: usdcAtomic(env('X402_RUNNER_MAX_ORDER_USDC')),
    totalAtomic: usdcAtomic(env('X402_RUNNER_TOTAL_USDC')) }
  const directory = env('X402_RUNNER_STATE_DIR')
  const stateInfo = await Deno.lstat(directory)
  if (!stateInfo.isDirectory || stateInfo.isSymlink || stateInfo.mode === null || (stateInfo.mode & 0o077) !== 0) throw new Error('private_state_permissions_required')
  // Pre-provision an owner-only directory on a durable POSIX volume. A crash
  // leaves the lock: an operator proves the process stopped before removing it.
  await Deno.mkdir(`${directory}/lock`, { mode: 0o700 })
  try {
    let journal: Journal
    try { journal = JSON.parse(await Deno.readTextFile(`${directory}/journal.json`)) }
    catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; journal = { version: 1, policy, entries: [] } }
    if (journal.version !== 1 || JSON.stringify(journal.policy) !== JSON.stringify(policy) || !Array.isArray(journal.entries)) throw new Error('journal_policy_mismatch')
    const save = async () => {
      const bytes = new TextEncoder().encode(JSON.stringify(journal))
      const file = await Deno.open(`${directory}/journal.next`, { write: true, create: true, truncate: true, mode: 0o600 })
      try {
        let written = 0
        while (written < bytes.length) written += await file.write(bytes.subarray(written))
        await file.sync()
      } finally { file.close() }
      await Deno.rename(`${directory}/journal.next`, `${directory}/journal.json`)
      const dir = await Deno.open(directory, { read: true })
      try { await dir.sync() } finally { dir.close() }
    }
    if (action === 'buy') {
      journal.requests ||= []
      let saved = journal.requests.find(item => item.requestId === purchaseRequestId)
      if (saved && saved.productId !== target) throw new RunnerError('purchase_request_conflict')
      if (!saved) {
        const catalog = await request('agent-catalog', { action: 'get', productId: target })
        const product = catalog.body.products?.find((item: { id: string }) => item.id === target)
        if (!catalog.response.ok || !product?.manufacturing_supported) throw new RunnerError('manufacturing_unsupported')
        saved = { requestId: purchaseRequestId!, productId: target, options: product.default_options }
        journal.requests.push(saved)
        await save() // Persist the immutable request BEFORE creating an order.
      }
      const result = await request('x402-purchase', { action: 'buy', requestId: saved.requestId,
        productId: saved.productId, quantity: 1, options: saved.options })
      if (!result.response.ok || !result.body.receipt?.grant_id) {
        const reasons = new Set(['purchase_outside_policy', 'physical_color_unavailable', 'purchase_request_conflict', 'purchase_count_limit',
          'delivery_changed', 'conflicting_cart', 'manufacturing_unsupported', 'purchase_policy_unavailable', 'purchase_amount_or_scope_limit'])
        throw new RunnerError(reasons.has(result.body.error) ? result.body.error : 'purchase_preparation_pending')
      }
      grantId = result.body.receipt.grant_id
    }
    const purchase = await status()
    if (purchase.attempt) {
      console.log(JSON.stringify(action === 'buy' ? await purchaseReceipt() : { grantId, status: purchase.attempt.status, signature: purchase.attempt.signature })); return
    }
    assertAgentPurchase(purchase, policy, grantId)
    const accounts = x402Accounts(purchase.payer, purchase.recipient)
    if (accounts.source !== purchase.source_token_account || accounts.destination !== purchase.recipient_token_account) throw new Error('agent_policy_rejected')
    let entry = journal.entries.find(e => e.grantId === grantId)
    if (entry && (entry.quoteId !== purchase.quote_id || entry.amountAtomic !== purchase.amount_atomic
      || JSON.stringify(entry.purchase.payment_requirements) !== JSON.stringify(purchase.payment_requirements))) throw new Error('journal_purchase_mismatch')
    if (!entry) {
      assertAgentBudget(journal.entries, purchase, policy)
      entry = { grantId, quoteId: purchase.quote_id, amountAtomic: purchase.amount_atomic, purchase,
        idempotencyKey: crypto.randomUUID(), transaction: null, submitted: false }
      journal.entries.push(entry); await save()
    }
    const execution = entry
    await executeAgentPayment(execution, {
      save: async () => { await save() }, status,
      sign: async () => {
        const challenge = await request('x402-pay', { action: 'pay', grantId }, { 'Idempotency-Key': execution.idempotencyKey })
        const header = challenge.response.headers.get('PAYMENT-REQUIRED')
        if (challenge.response.status !== 402 || !header || header.length > 8192) throw new Error('challenge_unavailable')
        assertAgentChallenge(decodePaymentRequiredHeader(header), purchase)
        assertAgentPurchase(purchase, policy, grantId)
        const rpc = new URL(env('X402_RUNNER_RPC_URL'))
        if (rpc.protocol !== 'https:' || rpc.username || rpc.password) throw new Error('rpc_configuration_invalid')
        const call = async (method: string) => {
          const response = await fetch(rpc, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: method === 'getLatestBlockhash' ? [{ commitment: 'confirmed' }] : [] }) })
          const body = await response.json()
          if (!response.ok || body.error) throw new Error('rpc_unavailable')
          return body.result
        }
        if (await call('getGenesisHash') !== SOLANA_DEVNET_GENESIS) throw new Error('wrong_network')
        const latest = await call('getLatestBlockhash')
        const tx = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(policy.sponsor), recentBlockhash: latest.value.blockhash,
          instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 40000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
            /* Archived treasury funding instruction; the agent pays order USDC.
            ...(purchase.payment_requirements.extra.fundingMode === 'printkub' ? [createTransferCheckedInstruction(
              new PublicKey(String(purchase.payment_requirements.extra.fundingSource)), new PublicKey(purchase.mint),
              new PublicKey(accounts.source), new PublicKey(policy.sponsor), BigInt(purchase.amount_atomic), 6)] : []),
            */
            createTransferCheckedInstruction(new PublicKey(accounts.source), new PublicKey(purchase.mint), new PublicKey(accounts.destination), signer.publicKey, BigInt(purchase.amount_atomic), 6),
            new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from(`printkub-x402:${purchase.quote_id}`) })],
        }).compileToV0Message())
        tx.sign([paymentSigner])
        const serialized = Buffer.from(tx.serialize()).toString('base64')
        await validateX402Payment(serialized, purchase)
        return serialized
      },
      pay: async e => {
        // Revalidate persisted proof; never submit arbitrary journal bytes.
        await validateX402Payment(e.transaction!, purchase)
        const result = await request('x402-pay', { action: 'pay', grantId }, {
          'Idempotency-Key': e.idempotencyKey, 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader({
            x402Version: 2, resource: { url: purchase.resource_url }, accepted: purchase.payment_requirements,
            payload: { transaction: e.transaction! },
          }),
        })
        if (![200,202].includes(result.response.status) || !result.body.purchase) {
          const reasons = new Set(['x402_sponsor_unavailable', 'x402_sponsor_budget_exhausted', 'printkub_funding_disabled'])
          throw new RunnerError(reasons.has(result.body.error) ? result.body.error : 'payment_unresolved')
        }
        console.log(JSON.stringify(action === 'buy' ? await purchaseReceipt() : { grantId, status: result.body.purchase.attempt?.status, signature: result.body.purchase.attempt?.signature || null }))
        return result.body
      },
    }, false)
  } finally { await Deno.remove(`${directory}/lock`) }
}
try { await main() } catch (error) {
  // External error text may contain credentials or raw transaction data.
  const reason = error instanceof RunnerError ? error.message
    : error instanceof Deno.errors.NotFound ? 'file_not_found'
    : error instanceof Deno.errors.PermissionDenied ? 'filesystem_permission_denied'
    : error instanceof Deno.errors.NotCapable ? 'deno_permission_denied'
    : 'operation_failed'
  console.error(`x402 tool could not complete (stage=${stage}; reason=${reason}).`)
  if (['pay', 'status', 'buy', 'purchase-status'].includes(Deno.args[0])) {
    console.error('Retain the journal and use status/recovery.')
  }
  Deno.exitCode = 1
}
