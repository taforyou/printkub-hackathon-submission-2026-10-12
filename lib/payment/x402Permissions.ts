'use client'

import { invokeAuthenticatedFunction, FunctionRequestError } from '@/lib/auth/invokeAuthenticatedFunction'
import { supabase } from '@/lib/supabase'
import type { X402ApprovedPurchase, X402Budget, X402Grant, X402GrantRevocation, X402PaymentQuote, X402LinkedAgent, X402PurchasePolicy, X402PolicySetup, X402ProductOptions, X402PolicyDelivery, X402RunnerSetup } from '@/lib/types/database'

export async function x402PermissionRequest<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  try {
    const { data } = await invokeAuthenticatedFunction(supabase, 'x402-permissions', { ...body, action })
    if (!data?.success) throw new Error(data?.error || 'permissions_unavailable')
    return data as T
  } catch (error) {
    if (error instanceof FunctionRequestError) {
      throw new Error(typeof error.detail.error === 'string' ? error.detail.error : error.status === 401 ? 'unauthorized' : 'permissions_unavailable')
    }
    throw error
  }
}

export const x402OrderState = (orderNo: string) => x402PermissionRequest<{
  purchases: X402ApprovedPurchase[]; new_permissions_enabled: boolean
  limits: { max_order_atomic: string; total_budget_atomic: string; grant_ttl_seconds: number } | null
}>('order_state', { orderNo })
export const x402QuotePreview = (orderNo: string, agentId: string) =>
  x402PermissionRequest<{ quote: X402PaymentQuote }>('preview', { orderNo, agentId })
export const x402Budgets = (agentId: string) => x402PermissionRequest<{ budgets: X402Budget[] }>('budgets', { agentId })
export const createX402Budget = (agentId: string, limitUsdc: string) =>
  x402PermissionRequest<{ budget: X402Budget }>('create_budget', { agentId, limitUsdc })
export const approveX402Grant = (quoteId: string, budgetId: string, capUsdc: string, ttlSeconds: number) =>
  x402PermissionRequest<{ grant: X402Grant }>('approve', { quoteId, budgetId, capUsdc, ttlSeconds })
export const revokeX402Grant = (grantId: string) =>
  x402PermissionRequest<{ revocation: X402GrantRevocation }>('revoke', { grantId })

/** Read/reconcile only. This customer helper never submits a payment payload. */
export async function x402PaymentStatus(grantId: string): Promise<X402ApprovedPurchase> {
  try {
    const { data } = await invokeAuthenticatedFunction(supabase, 'x402-pay', { action: 'status', grantId })
    if (!data?.success || !data.purchase) throw new Error(data?.error || 'permissions_unavailable')
    return data.purchase as X402ApprovedPurchase
  } catch (error) {
    if (error instanceof FunctionRequestError) throw new Error(typeof error.detail.error === 'string' ? error.detail.error : 'permissions_unavailable')
    throw error
  }
}

export const linkedX402Agents = () =>
  x402PermissionRequest<{ agents: X402LinkedAgent[] }>('linked_agents')
export const linkX402Wallet = (walletAddress: string) =>
  x402PermissionRequest<{ linkId: string }>('link_wallet', { walletAddress })
export const unlinkX402Wallet = (linkId: string) =>
  x402PermissionRequest<{ revoked: boolean }>('unlink_wallet', { linkId })

export const x402PolicySetup = () => x402PermissionRequest<X402PolicySetup>('policy_setup')
export const x402RunnerSetup = () => x402PermissionRequest<X402RunnerSetup>('runner_setup')
export const myX402Policies = () => x402PermissionRequest<{ policies: X402PurchasePolicy[] }>('policies')
export const revokeX402Policy = (policyId: string) => x402PermissionRequest<{ revoked: boolean }>('revoke_policy', { policyId })
export const createX402Policy = (body: {
  agentId: string; options: X402ProductOptions; delivery: X402PolicyDelivery; recipient: string
  maxOrderUsdc: string; budgetUsdc: string; maxOrders: number; expiresAt: string; consentVersion: 'standing-purchase-v1'
}) => x402PermissionRequest<{ policyId: string }>('create_policy', body)
