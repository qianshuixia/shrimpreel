// Stripe。Checkout Sessions（积分包 mode=payment，订阅套餐 mode=subscription）+ Stripe-Signature（HMAC-SHA256）验签。
// 文档：https://docs.stripe.com/api/checkout/sessions/create
//       https://docs.stripe.com/webhooks#verify-manually
// API 请求固定 Stripe-Version；webhook 的 payload 版本由 webhook 端点决定，可能和这里不同，
// 所以付款类事件（checkout.session.*、invoice.paid）先用固定版本重新取对象（expandStripeEvent），再归一化。
import { findPlan, site } from '#/config/site'
import { ApiError, cleanSecret, constantTimeEqual, hmacSha256, parseJsonRecord } from '../util'
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
  SubscriptionRef,
  SubscriptionStatus,
} from './types'
import { WebhookVerificationError } from './types'

export const STRIPE_API_VERSION = '2026-09-30.endive'
const STRIPE_API = 'https://api.stripe.com/v1'

type Json = Record<string, unknown>

// 调用 Stripe REST API（表单编码）。失败统一转成 502，原因写进 message（只有管理员看得到）；401/403 不带 Stripe 的原文，里面有打码的 Key
export function stripeClient(env: Env) {
  const apiKey = cleanSecret(env.STRIPE_SECRET_KEY)
  return async function call(
    method: 'GET' | 'POST',
    path: string,
    params?: Json,
    options: { idempotencyKey?: string; notFound?: 'null' } = {},
  ): Promise<Json | null> {
    if (!apiKey) throw new ApiError(503, 'payment_not_configured', 'STRIPE_SECRET_KEY missing')
    const query = method === 'GET' && params ? `?${formEncode(params)}` : ''
    const response = await fetch(`${STRIPE_API}${path}${query}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Stripe-Version': STRIPE_API_VERSION,
        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      },
      body: method === 'POST' ? formEncode(params ?? {}) : undefined,
    })
    const json = (await response.json().catch(() => null)) as Json | null
    if (response.ok) return json ?? {}
    if (response.status === 404 && options.notFound === 'null') return null
    const error = record(json?.error)
    const detail = response.status === 401 || response.status === 403 ? '' : [str(error.code), str(error.message)].filter(Boolean).join(': ')
    const resource = path.split('/')[1]
    throw new StripeApiError(response.status, str(error.code), `Stripe ${method} ${resource} failed (HTTP ${response.status}) ${detail}`.trim())
  }
}

class StripeApiError extends ApiError {
  constructor(
    readonly httpStatus: number,
    readonly stripeCode: string | null,
    message: string,
  ) {
    super(502, 'payment_provider_error', message)
  }
}

export function createStripeProvider(env: Env): PaymentProvider {
  const call = stripeClient(env)
  const products = parseJsonRecord(env.STRIPE_PRODUCTS)
  const setCancel = (subscription: SubscriptionRef, cancel: boolean) =>
    call('POST', `/subscriptions/${encodeURIComponent(subscription.providerSubscriptionId)}`, { cancel_at_period_end: cancel })
  return {
    id: 'stripe',
    // STRIPE_PRODUCTS 存的是 Price ID（price_...），订阅套餐要用 recurring 价格
    async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
      if (!cleanSecret(env.STRIPE_SECRET_KEY)) throw new ApiError(503, 'payment_not_configured', 'STRIPE_SECRET_KEY missing')
      const priceId = products[input.order.packageId]
      if (!priceId) throw new ApiError(503, 'payment_not_configured', `No Stripe price for ${input.order.packageId}`)
      const subscription = !!findPlan(input.order.packageId)
      // metadata 同时写在 session 和之后生成的 PaymentIntent / Subscription 上：退款事件和续费账单只能从后者取到订单号
      const metadata = { orderId: input.order.id, userId: input.user.id, packageId: input.order.packageId, site: site.domain }
      const session = await call(
        'POST',
        '/checkout/sessions',
        {
          mode: subscription ? 'subscription' : 'payment',
          line_items: [{ price: priceId, quantity: 1 }],
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          client_reference_id: input.order.id,
          customer_email: input.user.email,
          metadata,
          ...(subscription ? { subscription_data: { metadata } } : { payment_intent_data: { metadata } }),
        },
        // 同一订单重复提交时 Stripe 返回同一个 session
        { idempotencyKey: `checkout:${input.order.id}` },
      )
      const url = str(session?.url)
      if (!url) throw new ApiError(502, 'payment_provider_error', 'Stripe checkout returned no url')
      return { url, sessionId: str(session?.id) }
    },
    // 按 PaymentIntent 退款，可多次部分退款，累计不超过实收。退款从 Stripe 余额扣，余额不足时卡退款挂起为 pending，
    // 积分在 refund 变成 succeeded 的 webhook 到达时回收 https://docs.stripe.com/refunds
    async refund(input: RefundRequest): Promise<RefundRequestResult> {
      try {
        const refund = await call('POST', '/refunds', {
          payment_intent: input.providerPaymentId,
          ...(input.fullAmount ? {} : { amount: input.amountCents }),
          reason: 'requested_by_customer',
          metadata: { orderId: input.orderId, note: input.reason.slice(0, 500) },
        })
        return { refundId: str(refund?.id), status: str(refund?.status) ?? 'pending' }
      } catch (error) {
        // 已全额退过、超出可退金额、被拒付的付款：业务冲突，原因透传给后台
        if (error instanceof StripeApiError && error.httpStatus === 400 && error.stripeCode) {
          throw new ApiError(409, 'payment_provider_conflict', `Stripe refund: ${error.message}`)
        }
        throw error
      }
    },
    // 积分包：session.payment_status = paid 即到账；订阅：取 session 生成的首张账单，status = paid 才算到账。
    // 两者都走 normalizeStripeEvent，入账前核对规则和 webhook 一致
    // https://docs.stripe.com/api/checkout/sessions/retrieve
    async fetchPaidEvent(order): Promise<PaidLookup | null> {
      if (!order.providerSessionId) return null
      const session = await getCheckoutSession(call, order.providerSessionId)
      if (!session) return null
      if (session.mode === 'subscription') {
        const invoiceId = idOf(session.invoice)
        if (session.status !== 'complete' || !invoiceId) return null
        const invoice = await getInvoice(call, invoiceId)
        if (!invoice || invoice.status !== 'paid') return null
        const event = normalizeStripeEvent({ id: `reconcile:${invoicePaymentIntent(invoice) ?? invoiceId}`, type: 'invoice.paid', data: { object: invoice } })
        return event.kind === 'paid' ? { event: { ...event, eventType: 'reconcile' }, raw: invoice } : null
      }
      if (session.payment_status !== 'paid') return null
      const paymentId = idOf(session.payment_intent) ?? str(session.id)
      const event = normalizeStripeEvent({ id: `reconcile:${paymentId}`, type: 'checkout.session.completed', data: { object: session } })
      return event.kind === 'paid' ? { event: { ...event, eventType: 'reconcile' }, raw: session } : null
    },
    // https://docs.stripe.com/api/subscriptions/update
    async cancelSubscription(subscription) {
      await setCancel(subscription, true)
    },
    async resumeSubscription(subscription) {
      await setCancel(subscription, false)
    },
    // 客户门户要先在 Stripe 后台保存一次配置（Settings → Billing → Customer portal）
    // https://docs.stripe.com/api/customer_portal/sessions/create
    async portalUrl(subscription, returnUrl) {
      let customerId = subscription.providerCustomerId
      if (!customerId) {
        const found = await call('GET', `/subscriptions/${encodeURIComponent(subscription.providerSubscriptionId)}`)
        customerId = idOf(found?.customer)
      }
      if (!customerId) throw new ApiError(502, 'payment_provider_error', 'Stripe subscription has no customer')
      const session = await call('POST', '/billing_portal/sessions', { customer: customerId, return_url: returnUrl })
      const url = str(session?.url)
      if (!url) throw new ApiError(502, 'payment_provider_error', 'Stripe portal returned no url')
      return url
    },
  }
}

type StripeCall = ReturnType<typeof stripeClient>

// line_items 不在 session 对象里，要展开才能拿到实际购买的 Price
const getCheckoutSession = (call: StripeCall, id: string) =>
  call('GET', `/checkout/sessions/${encodeURIComponent(id)}`, { expand: ['line_items'] }, { notFound: 'null' })

// 账单的 payments 默认不返回，要展开才能拿到 PaymentIntent（退款事件按它找订单）
const getInvoice = (call: StripeCall, id: string) =>
  call('GET', `/invoices/${encodeURIComponent(id)}`, { expand: ['payments'] }, { notFound: 'null' })

// webhook 收到付款类事件时，用固定 API 版本重新取对象并展开需要的字段；其他事件原样返回。
// 对象已被删除（404）时沿用 payload 里的对象
export async function expandStripeEvent(env: Env, event: Json): Promise<Json> {
  const type = String(event.type ?? '')
  const object = record(record(event.data).object)
  const id = str(object.id)
  if (!id) return event
  const call = stripeClient(env)
  let fresh: Json | null = null
  if (type.startsWith('checkout.session.') && type !== 'checkout.session.expired') fresh = await getCheckoutSession(call, id)
  else if (type === 'invoice.paid') fresh = await getInvoice(call, id)
  else if (type === 'charge.dispute.created' || type === 'charge.dispute.closed' || type === 'radar.early_fraud_warning.created') {
    // payment_intent 可能为 null（只有 charge）：取 Charge 补上，订单是按 payment_intent 存的
    const chargeId = idOf(object.charge)
    if (!idOf(object.payment_intent) && chargeId) {
      const charge = await call('GET', `/charges/${encodeURIComponent(chargeId)}`, undefined, { notFound: 'null' })
      const paymentIntent = idOf(charge?.payment_intent)
      if (paymentIntent) return { ...event, data: { ...record(event.data), object: { ...object, payment_intent: paymentIntent } } }
    }
  }
  return fresh ? { ...event, data: { ...record(event.data), object: fresh } } : event
}

const TOLERANCE_SECONDS = 5 * 60

// Stripe-Signature: t=<秒>,v1=<hex>[,v1=<hex>]；签名内容是 `${t}.${原始请求体}`，密钥是 whsec_... 整串。
// 轮换密钥期间会带多个 v1，任一匹配即可。livemode 必须和 STRIPE_ENVIRONMENT 一致
export async function verifyStripeWebhook(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string | undefined,
  environment: string | undefined,
  nowMs = Date.now(),
): Promise<Json> {
  const cleaned = cleanSecret(secret)
  if (!cleaned) throw new WebhookVerificationError('STRIPE_WEBHOOK_SECRET missing')
  if (!signatureHeader) throw new WebhookVerificationError('missing stripe-signature header')
  const parts = signatureHeader.split(',').map((part) => {
    const index = part.indexOf('=')
    return [part.slice(0, index).trim(), part.slice(index + 1).trim()] as const
  })
  const timestamp = parts.find(([key]) => key === 't')?.[1]
  const signatures = parts.filter(([key, value]) => key === 'v1' && value).map(([, value]) => value)
  if (!timestamp || !signatures.length) throw new WebhookVerificationError('missing stripe-signature header')
  const age = Math.floor(nowMs / 1000) - Number(timestamp)
  if (!/^\d+$/.test(timestamp) || Math.abs(age) > TOLERANCE_SECONDS) throw new WebhookVerificationError('timestamp outside tolerance')
  const expected = toHex(await hmacSha256(cleaned, `${timestamp}.${rawBody}`))
  if (!signatures.some((signature) => constantTimeEqual(signature, expected))) throw new WebhookVerificationError('invalid signature')
  const payload = JSON.parse(rawBody) as Json
  if ((payload.livemode === true) !== (environment === 'live')) {
    throw new WebhookVerificationError(`livemode mismatch (STRIPE_ENVIRONMENT=${environment || 'test'})`)
  }
  return payload
}

export function normalizeStripeEvent(event: Json): PaymentEvent {
  const eventType = String(event.type ?? '')
  // evt_ 在重试时保持不变，用作幂等键
  const eventId = String(event.id ?? '')
  const object = record(record(event.data).object)
  const metadata = record(object.metadata)
  switch (eventType) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      // 订阅的首付由 invoice.paid 入账（带订阅号和周期）；银行转账等异步付款在 completed 时还是 unpaid，等 async_payment_succeeded
      if (object.mode !== 'payment' || object.payment_status !== 'paid') return { kind: 'ignored', eventId, eventType }
      const currency = upper(object.currency)
      const cents = int(object.amount_total)
      return {
        kind: 'paid',
        eventId,
        eventType,
        orderId: str(metadata.orderId) ?? str(object.client_reference_id),
        providerOrderId: str(object.id),
        providerPaymentId: idOf(object.payment_intent),
        paidAmount: cents !== null && currency ? minorToDisplay(cents, currency) : null,
        paidCurrency: currency,
        paidAmountCents: cents,
        productId: singlePrice(record(object.line_items).data, (item) => idOf(item.price)),
        discounted: (int(record(object.total_details).amount_discount) ?? 0) > 0,
        site: str(metadata.site),
        subscription: null,
      }
    }
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired':
      return { kind: 'failed', eventId, eventType, orderId: str(metadata.orderId) ?? str(object.client_reference_id) }
    case 'invoice.paid': {
      // 首付和每次续费都会生成一张订阅账单；不是订阅产生的账单（后台手开的）不处理
      const details = record(record(object.parent).subscription_details)
      const subscriptionId = idOf(details.subscription) ?? idOf(object.subscription)
      if (!subscriptionId) return { kind: 'ignored', eventId, eventType }
      const subMetadata = record(details.metadata)
      const lines = array(record(object.lines).data)
      const line = lines.find((item) => record(item.parent).type === 'subscription_item_details') ?? lines[0] ?? {}
      const period = record(line.period)
      const currency = upper(object.currency)
      const cents = int(object.amount_paid)
      return {
        kind: 'paid',
        eventId,
        eventType,
        orderId: str(subMetadata.orderId),
        providerOrderId: str(object.id),
        // payments 没展开时退回账单号：续费仍能按它建单，只是该期的退款事件要靠 metadata.orderId 找订单
        providerPaymentId: invoicePaymentIntent(object) ?? str(object.id),
        paidAmount: cents !== null && currency ? minorToDisplay(cents, currency) : null,
        paidCurrency: currency,
        paidAmountCents: cents,
        // 只有首付核对 Price；续费按订阅锁定的价格扣款，后台换了 STRIPE_PRODUCTS 里的 Price 也不影响老订阅，只核对金额
        productId: object.billing_reason === 'subscription_create' ? linePrice(line) : null,
        discounted: array(object.discounts).length > 0 || array(object.total_discount_amounts).some((d) => (int(d.amount) ?? 0) > 0),
        site: str(subMetadata.site),
        subscription: {
          providerSubscriptionId: subscriptionId,
          providerCustomerId: idOf(object.customer),
          periodStart: isoFromUnix(period.start),
          periodEnd: isoFromUnix(period.end),
        },
      }
    }
    case 'refund.created':
    case 'refund.updated':
      // 卡退款通常创建即 succeeded；余额不足挂起的退款等变成 succeeded 再回收积分。同一笔退款的多个事件靠 refund id 只回收一次
      if (object.status !== 'succeeded') return { kind: 'ignored', eventId, eventType }
      return {
        kind: 'refunded',
        eventId,
        eventType,
        orderId: str(metadata.orderId),
        providerPaymentId: idOf(object.payment_intent),
        refundId: str(object.id),
        refundAmountCents: int(object.amount),
        originalAmountCents: null,
      }
    // 拒付：Dispute 对象带 charge 和可能为 null 的 payment_intent（webhook 路由先用 expandStripeEvent 补上），订单靠 payment_intent 反查。
    // created 时的 status 可能是 warning_needs_response（询单，资金还没扣）或 needs_response；closed 的终态：
    // won / lost 按结果，warning_closed（询单关闭）和 prevented（被阻止成为拒付）资金留在商户，按 closed 处理
    // https://docs.stripe.com/api/disputes/object  https://docs.stripe.com/disputes/api
    case 'charge.dispute.created':
    case 'charge.dispute.closed': {
      const disputeId = str(object.id)
      if (!disputeId) return { kind: 'ignored', eventId, eventType }
      const stage: DisputeStage | null = eventType === 'charge.dispute.created' ? 'opened' : (STRIPE_DISPUTE_CLOSED[String(object.status)] ?? null)
      if (!stage) return { kind: 'ignored', eventId, eventType }
      return {
        kind: 'disputed',
        eventId,
        eventType,
        orderId: null,
        providerPaymentId: idOf(object.payment_intent),
        disputeId,
        stage,
        amountCents: int(object.amount),
        reason: str(object.reason),
      }
    }
    // 发卡行欺诈预警：https://docs.stripe.com/api/radar/early_fraud_warnings/object （actionable = 还没拒付也没全额退款）
    case 'radar.early_fraud_warning.created':
      if (object.actionable === false) return { kind: 'ignored', eventId, eventType }
      return { kind: 'fraud_warning', eventId, eventType, orderId: null, providerPaymentId: idOf(object.payment_intent) }
    default:
      // 订阅状态：created / updated / deleted 等事件的对象都是完整订阅，统一按其中的状态处理
      // https://docs.stripe.com/billing/subscriptions/webhooks
      if (eventType.startsWith('customer.subscription.') && str(object.id)) {
        const item = array(record(object.items).data)[0] ?? {}
        return {
          kind: 'subscription',
          eventId,
          eventType,
          orderId: str(metadata.orderId),
          providerSubscriptionId: str(object.id)!,
          status: STRIPE_STATUS[String(object.status)] ?? null,
          // 按日期取消（cancel_at）也视为到期取消：不会再续费
          cancelAtPeriodEnd: typeof object.cancel_at_period_end === 'boolean' ? object.cancel_at_period_end || object.cancel_at != null : null,
          periodStart: isoFromUnix(item.current_period_start ?? object.current_period_start),
          periodEnd: isoFromUnix(item.current_period_end ?? object.current_period_end),
          providerCustomerId: idOf(object.customer),
          productId: idOf(item.price),
          occurredAt: isoFromUnix(event.created),
          site: str(metadata.site),
        }
      }
      return { kind: 'ignored', eventId, eventType }
  }
}

const STRIPE_DISPUTE_CLOSED: Record<string, DisputeStage> = { won: 'won', lost: 'lost', warning_closed: 'closed', prevented: 'closed' }

// unpaid：重试用尽仍未付款（按后台设置保留订阅）；incomplete（首付未完成）、paused 不改本地状态
const STRIPE_STATUS: Record<string, SubscriptionStatus> = {
  active: 'active',
  trialing: 'active',
  past_due: 'past_due',
  unpaid: 'past_due',
  canceled: 'canceled',
  incomplete_expired: 'expired',
}

function invoicePaymentIntent(invoice: Json) {
  const payments = array(record(invoice.payments).data)
  const paid = payments.find((payment) => payment.status === 'paid') ?? payments[0]
  return idOf(record(paid?.payment).payment_intent) ?? idOf(invoice.payment_intent)
}

function linePrice(line: Json) {
  return idOf(record(record(line.pricing).price_details).price) ?? idOf(line.price)
}

// 模板每单只买一个商品；不是恰好一行时返回 null，交给金额核对
function singlePrice(items: unknown, pick: (item: Json) => string | null) {
  const list = array(items)
  return list.length === 1 ? pick(list[0]!) : null
}

// Stripe 的表单编码：嵌套对象写成 a[b]=c，数组写成 a[0][b]=c
export function formEncode(params: Json) {
  const out = new URLSearchParams()
  const walk = (value: unknown, key: string) => {
    if (value === undefined || value === null) return
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${key}[${index}]`))
    else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, `${key}[${k}]`)
    else out.append(key, String(value))
  }
  for (const [key, value] of Object.entries(params)) walk(value, key)
  return out.toString()
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// 可展开字段：未展开是 ID 字符串，展开后是带 id 的对象
function idOf(value: unknown) {
  return typeof value === 'string' && value ? value : str(record(value).id)
}

function isoFromUnix(value: unknown) {
  const seconds = int(value)
  return seconds === null ? null : new Date(seconds * 1000).toISOString()
}

function upper(value: unknown) {
  return typeof value === 'string' && value ? value.toUpperCase() : null
}

function str(value: unknown) {
  return typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : null
}

function record(value: unknown) {
  return (value && typeof value === 'object' ? value : {}) as Json
}

function array(value: unknown) {
  return Array.isArray(value) ? (value as unknown[]).map(record) : []
}

function int(value: unknown) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value ? Number(value) : NaN
  return Number.isInteger(n) ? n : null
}
