// Dodo Payments（Merchant of Record）。Checkout Sessions API + Standard Webhooks 签名。
// 文档：https://docs.dodopayments.com/developer-resources/checkout-session
//       https://docs.dodopayments.com/developer-resources/webhooks
import { site } from '#/config/site'
import { ApiError, base64Decode, base64Encode, cleanSecret, constantTimeEqual, hmacSha256, parseJsonRecord } from '../util'
import { minorToDisplay } from './amount'
import type {
  CheckoutInput,
  CheckoutResult,
  DisputeStage,
  PaidLookup,
  PaymentEvent,
  PaymentProvider,
  RefundRequest,
  RefundRequestResult,
  SubscriptionCharge,
  SubscriptionRef,
  SubscriptionStatus,
} from './types'
import { WebhookVerificationError } from './types'

export const dodoBaseUrl = (env: Env) => (env.DODO_ENVIRONMENT === 'live' ? 'https://live.dodopayments.com' : 'https://test.dodopayments.com')

export function createDodoProvider(env: Env): PaymentProvider {
  const apiKey = cleanSecret(env.DODO_API_KEY)
  const products = parseJsonRecord(env.DODO_PRODUCTS)
  const baseUrl = dodoBaseUrl(env)
  // 订阅管理接口：失败统一转成 502（4xx 原因写进 message，只有管理员看得到）
  const call = async (method: string, path: string, body?: unknown) => {
    if (!apiKey) throw new ApiError(503, 'payment_not_configured', 'DODO_API_KEY missing')
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok) {
      const message = typeof json?.message === 'string' ? json.message : ''
      throw new ApiError(502, 'payment_provider_error', `Dodo ${method} ${path.split('/')[1]} failed (HTTP ${response.status}) ${message}`.trim())
    }
    return json ?? {}
  }
  const setCancel = (subscription: SubscriptionRef, cancel: boolean) =>
    call('PATCH', `/subscriptions/${encodeURIComponent(subscription.providerSubscriptionId)}`, { cancel_at_next_billing_date: cancel })
  return {
    id: 'dodo',
    async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
      if (!apiKey) throw new ApiError(503, 'payment_not_configured', 'DODO_API_KEY missing')
      const productId = products[input.order.packageId]
      if (!productId) throw new ApiError(503, 'payment_not_configured', `No Dodo product for ${input.order.packageId}`)
      const response = await fetch(`${baseUrl}/checkouts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_cart: [{ product_id: productId, quantity: 1 }],
          customer: { email: input.user.email, name: input.user.name ?? input.user.email },
          return_url: input.successUrl,
          metadata: { orderId: input.order.id, userId: input.user.id, packageId: input.order.packageId, site: site.domain },
        }),
      })
      const body = (await response.json().catch(() => null)) as { session_id?: string; checkout_url?: string } | null
      if (!response.ok || !body?.checkout_url) {
        throw new ApiError(502, 'payment_provider_error', `Dodo checkout failed (HTTP ${response.status})`)
      }
      return { url: body.checkout_url, sessionId: body.session_id ?? null }
    },
    // 部分退款按商品行传 amount（Dodo 规定单位固定为 USD 美分，与支付币种无关）；同一笔支付同时只能有一笔退款在处理。
    // 退款从商户钱包余额扣（支付入账时已扣手续费），余额不足直接拒绝，所以全额退款往往需要账上有其他收入
    // https://docs.dodopayments.com/api-reference/refunds/post-refunds
    // https://docs.dodopayments.com/features/transactions/refunds#when-your-balance-cant-cover-a-refund
    async refund(input: RefundRequest): Promise<RefundRequestResult> {
      if (!apiKey) throw new ApiError(503, 'payment_not_configured', 'DODO_API_KEY missing')
      const productId = products[input.packageId]
      if (!input.fullAmount && (!productId || input.currency !== 'USD')) {
        throw new ApiError(409, 'partial_refund_unsupported', 'Dodo partial refunds need a USD product mapping')
      }
      const response = await fetch(`${baseUrl}/refunds`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payment_id: input.providerPaymentId,
          reason: input.reason,
          metadata: { orderId: input.orderId },
          ...(input.fullAmount ? {} : { items: [{ item_id: productId, amount: input.amountCents, tax_inclusive: true }] }),
        }),
      })
      const body = (await response.json().catch(() => null)) as { refund_id?: string; status?: string; message?: string } | null
      // 409 是业务冲突，原样透传给后台。实测（test 模式）：钱包余额不足时返回 "Insufficient funds in wallet"
      if (response.status === 409) throw new ApiError(409, 'payment_provider_conflict', `Dodo refund: ${body?.message ?? 'conflict'}`)
      if (!response.ok) {
        throw new ApiError(502, 'payment_provider_error', `Dodo refund failed (HTTP ${response.status}): ${body?.message ?? ''}`.trim())
      }
      return { refundId: body?.refund_id ?? null, status: body?.status ?? 'pending' }
    },
    // 先查 checkout session 拿到 payment_id 和支付状态，成功后再取 Payment 对象（字段与 payment.succeeded webhook 的 data 相同），
    // 走同一个 normalizeDodoEvent，入账前核对规则完全一致
    // https://docs.dodopayments.com/api-reference/checkout-sessions/get-checkout-session
    // https://docs.dodopayments.com/api-reference/payments/get-payments-1
    async fetchPaidEvent(order): Promise<PaidLookup | null> {
      if (!apiKey) throw new ApiError(503, 'payment_not_configured', 'DODO_API_KEY missing')
      if (!order.providerSessionId) return null
      const get = async (path: string) => {
        const response = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${apiKey}` } })
        if (response.status === 404) return null
        if (!response.ok) throw new ApiError(502, 'payment_provider_error', `Dodo GET ${path.split('/')[1]} failed (HTTP ${response.status})`)
        return (await response.json()) as Record<string, unknown>
      }
      const session = await get(`/checkouts/${encodeURIComponent(order.providerSessionId)}`)
      const paymentId = str(session?.payment_id)
      if (!paymentId || session?.payment_status !== 'succeeded') return null
      const payment = await get(`/payments/${encodeURIComponent(paymentId)}`)
      if (!payment || payment.status !== 'succeeded') return null
      const event = normalizeDodoEvent({ type: 'payment.succeeded', __webhookId: `reconcile:${paymentId}`, data: payment })
      return event.kind === 'paid' ? { event: { ...event, eventType: 'reconcile' }, raw: payment } : null
    },
    // https://docs.dodopayments.com/api-reference/subscriptions/patch-subscriptions
    async cancelSubscription(subscription) {
      await setCancel(subscription, true)
    },
    async resumeSubscription(subscription) {
      await setCancel(subscription, false)
    },
    // https://docs.dodopayments.com/api-reference/customers/create-customer-portal-session
    async portalUrl(subscription, returnUrl) {
      let customerId = subscription.providerCustomerId
      if (!customerId) {
        const found = await call('GET', `/subscriptions/${encodeURIComponent(subscription.providerSubscriptionId)}`)
        customerId = str(record(found.customer).customer_id)
      }
      if (!customerId) throw new ApiError(502, 'payment_provider_error', 'Dodo subscription has no customer')
      const session = await call(
        'POST',
        `/customers/${encodeURIComponent(customerId)}/customer-portal/session?return_url=${encodeURIComponent(returnUrl)}`,
      )
      const link = str(session.link)
      if (!link) throw new ApiError(502, 'payment_provider_error', 'Dodo portal returned no link')
      return link
    },
  }
}

const TOLERANCE_SECONDS = 5 * 60

export async function verifyDodoWebhook(
  rawBody: string,
  headers: Headers,
  secret: string | undefined,
  nowMs = Date.now(),
): Promise<Record<string, unknown>> {
  const cleaned = cleanSecret(secret)
  if (!cleaned) throw new WebhookVerificationError('DODO_WEBHOOK_SECRET missing')
  const id = headers.get('webhook-id')
  const timestamp = headers.get('webhook-timestamp')
  const signatureHeader = headers.get('webhook-signature')
  if (!id || !timestamp || !signatureHeader) throw new WebhookVerificationError('missing webhook headers')
  const age = Math.floor(nowMs / 1000) - Number(timestamp)
  if (!Number.isFinite(age) || Math.abs(age) > TOLERANCE_SECONDS) throw new WebhookVerificationError('timestamp outside tolerance')
  const key = base64Decode(cleaned.startsWith('whsec_') ? cleaned.slice(6) : cleaned)
  const expected = base64Encode(await hmacSha256(key, `${id}.${timestamp}.${rawBody}`))
  const matched = signatureHeader
    .split(' ')
    .map((part) => part.split(','))
    .some(([version, signature]) => version === 'v1' && !!signature && constantTimeEqual(signature, expected))
  if (!matched) throw new WebhookVerificationError('invalid signature')
  const payload = JSON.parse(rawBody) as Record<string, unknown>
  // Standard Webhooks 的 webhook-id 对同一事件的重试保持不变，用作幂等键
  return { ...payload, __webhookId: id }
}

export function normalizeDodoEvent(payload: Record<string, unknown>): PaymentEvent {
  const eventType = String(payload.type ?? '')
  const eventId = String(payload.__webhookId ?? '')
  const data = (payload.data ?? {}) as Record<string, unknown>
  const metadata = (data.metadata ?? {}) as Record<string, unknown>
  const orderId = str(metadata.orderId)
  const currency = str(data.currency)
  // Dodo 金额是最小货币单位的整数（total_amount、refund.amount）
  switch (eventType) {
    case 'payment.succeeded': {
      const cents = int(data.total_amount)
      return {
        kind: 'paid',
        eventId,
        eventType,
        orderId,
        providerOrderId: str(data.checkout_session_id),
        providerPaymentId: str(data.payment_id),
        paidAmount: cents !== null && currency ? minorToDisplay(cents, currency) : str(data.total_amount),
        paidCurrency: currency,
        paidAmountCents: cents,
        // 订阅扣款的 product_cart 为 null，商品由订阅锁定，只核对金额
        productId: firstProductId(data.product_cart),
        discounted: !!data.discount_id || (Array.isArray(data.discounts) && data.discounts.length > 0),
        site: str(metadata.site),
        subscription: dodoSubscriptionCharge(data),
      }
    }
    case 'payment.failed':
    case 'payment.cancelled':
      return { kind: 'failed', eventId, eventType, orderId }
    case 'refund.succeeded':
      // 退款对象自带 metadata（通常为空），订单靠 payment_id 反查；is_partial=false 视为全额
      return {
        kind: 'refunded',
        eventId,
        eventType,
        orderId,
        providerPaymentId: str(data.payment_id),
        refundId: str(data.refund_id),
        refundAmountCents: data.is_partial === true ? int(data.amount) : null,
        originalAmountCents: null,
      }
    // 争议（拒付）：data 是 Dispute 对象，字段 dispute_id、payment_id、amount（字符串，文档没写单位，所以不当作分使用）、
    // dispute_stage（pre_dispute / dispute / pre_arbitration）、reason。
    // opened 回收积分；won 补回；lost / accepted（商户接受，资金退回持卡人）/ expired（超时未回应）记为失败；
    // cancelled（持卡人撤销，资金留在商户）按 closed 补回；challenged（已提交证据）不改变资金，忽略
    // https://docs.dodopayments.com/developer-resources/webhooks/intents/dispute
    case 'dispute.opened':
    case 'dispute.won':
    case 'dispute.lost':
    case 'dispute.accepted':
    case 'dispute.expired':
    case 'dispute.cancelled': {
      const disputeId = str(data.dispute_id)
      if (!disputeId) return { kind: 'ignored', eventId, eventType }
      return {
        kind: 'disputed',
        eventId,
        eventType,
        orderId,
        providerPaymentId: str(data.payment_id),
        disputeId,
        stage: DODO_DISPUTE_STAGE[eventType]!,
        amountCents: null,
        reason: str(data.reason) ?? str(data.remarks),
      }
    }
    default:
      // 订阅事件的 data 是完整的订阅对象，各类事件统一按其中的状态处理
      // https://docs.dodopayments.com/developer-resources/subscription-integration-guide
      if (eventType.startsWith('subscription.') && str(data.subscription_id)) {
        return {
          kind: 'subscription',
          eventId,
          eventType,
          orderId,
          providerSubscriptionId: str(data.subscription_id)!,
          status: DODO_STATUS[String(data.status)] ?? null,
          cancelAtPeriodEnd: typeof data.cancel_at_next_billing_date === 'boolean' ? data.cancel_at_next_billing_date : null,
          periodStart: str(data.previous_billing_date),
          periodEnd: str(data.next_billing_date),
          providerCustomerId: str(record(data.customer).customer_id),
          productId: str(data.product_id),
          occurredAt: str(payload.timestamp),
          site: str(metadata.site),
        }
      }
      return { kind: 'ignored', eventId, eventType }
  }
}

const DODO_DISPUTE_STAGE: Record<string, DisputeStage> = {
  'dispute.opened': 'opened',
  'dispute.won': 'won',
  'dispute.lost': 'lost',
  'dispute.accepted': 'lost',
  'dispute.expired': 'lost',
  'dispute.cancelled': 'closed',
}

// on_hold：续费扣款失败，等买家更新付款方式；paused 不改本地状态（不续费也不终止，模板不主动暂停）
const DODO_STATUS: Record<string, SubscriptionStatus> = {
  active: 'active',
  on_hold: 'past_due',
  past_due: 'past_due',
  cancelled: 'canceled',
  expired: 'expired',
  failed: 'expired',
}

// 订阅扣款（首付和续费）：Payment 带 subscription_id，service_periods 给出这次扣款覆盖的周期
// https://docs.dodopayments.com/api-reference/payments/get-payments-1
function dodoSubscriptionCharge(data: Record<string, unknown>): SubscriptionCharge | null {
  const subscriptionId = str(data.subscription_id)
  if (!subscriptionId) return null
  const periods = Array.isArray(data.service_periods) ? (data.service_periods as unknown[]).map(record) : []
  const period = periods.find((p) => str(p.subscription_id) === subscriptionId) ?? periods[0]
  return {
    providerSubscriptionId: subscriptionId,
    providerCustomerId: str(record(data.customer).customer_id),
    periodStart: str(period?.starts_at),
    periodEnd: str(period?.ends_at),
  }
}

// 模板每单只买一个商品；购物车不是恰好一行时返回 null，交给金额核对
function firstProductId(cart: unknown) {
  if (!Array.isArray(cart) || cart.length !== 1) return null
  return str((cart[0] as Record<string, unknown> | null)?.product_id)
}

function str(value: unknown) {
  return typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : null
}

function record(value: unknown) {
  return (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
}

function int(value: unknown) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value ? Number(value) : NaN
  return Number.isInteger(n) ? n : null
}
