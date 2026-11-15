// Waffo Pancake（Merchant of Record）。只用 WebCrypto，不依赖 Node SDK，可直接跑在 Workers。
// 签名协议参考 @waffo/pancake-ts：RSA-SHA256 over `POST\n{path}\n{timestampSec}\n{base64(sha256(body))}`
import { findPlan, site } from '#/config/site'
import { ApiError, base64Decode, base64Encode, cleanSecret, parseJsonRecord, sha256Hex } from '../util'
import { displayToMinor, minorToDisplay } from './amount'
import type {
  CheckoutInput,
  CheckoutResult,
  PaidEvent,
  PaidLookup,
  PaymentEvent,
  PaymentProvider,
  RefundRequest,
  RefundRequestResult,
  SubscriptionStatus,
} from './types'
import { WebhookVerificationError } from './types'

const BASE_URL = 'https://api.waffo.ai'
const TOKEN_PATH = '/v1/actions/auth/issue-session-token'
const SESSION_PATH = '/v1/actions/checkout/create-session'
const REFUND_PATH = '/v1/actions/refund-ticket/create-ticket'
const GRAPHQL_PATH = '/v1/graphql'
const CANCEL_SUBSCRIPTION_PATH = '/v1/actions/subscription-order/cancel-order'

// 实测（test 环境）：payments 按 orderMerchantExternalId 过滤，不需要 storeId；status 有 succeeded / canceled，
// 金额是展示格式字符串，snapshotAmountDetails.total 为含税实收
const PAYMENTS_QUERY = `query ($ref: String!) {
  payments(filter: { orderMerchantExternalId: { eq: $ref } }, limit: 10) {
    id orderId status orderMerchantExternalId snapshotAmountDetails { total currency }
  }
}`

export function createWaffoProvider(env: Env): PaymentProvider {
  const merchantId = cleanSecret(env.WAFFO_MERCHANT_ID)
  const privateKey = cleanSecret(env.WAFFO_PRIVATE_KEY)
  const products = parseJsonRecord(env.WAFFO_PRODUCTS)
  return {
    id: 'waffo',
    async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
      if (!merchantId || !privateKey) throw new ApiError(503, 'payment_not_configured', 'Waffo credentials missing')
      const productId = products[input.order.packageId]
      if (!productId) throw new ApiError(503, 'payment_not_configured', `No Waffo product for ${input.order.packageId}`)
      const key = importSigningKey(privateKey)
      const [token, session] = await Promise.all([
        signedPost<{ token: string }>(merchantId, key, TOKEN_PATH, { productId, buyerIdentity: input.user.id }),
        signedPost<{ sessionId: string; checkoutUrl: string }>(merchantId, key, SESSION_PATH, {
          productId,
          currency: input.order.currency,
          buyerEmail: input.user.email,
          successUrl: input.successUrl,
          expiresInSeconds: 30 * 60,
          orderMerchantExternalId: input.order.id,
          metadata: { orderId: input.order.id, userId: input.user.id, packageId: input.order.packageId, site: site.domain },
        }),
      ])
      if (!token.token || !session.checkoutUrl) throw new ApiError(502, 'payment_provider_error', 'Invalid Waffo response')
      return { url: `${session.checkoutUrl}#token=${token.token}`, sessionId: session.sessionId ?? null }
    },
    // Waffo 规则：支付成功 14 天内、每笔支付只能有一次退款（可部分），API 提交的退款自动审批
    // https://docs.waffo.ai/api-reference/endpoints/refunds/create-refund-ticket
    async refund(input: RefundRequest): Promise<RefundRequestResult> {
      if (!merchantId || !privateKey) throw new ApiError(503, 'payment_not_configured', 'Waffo credentials missing')
      const { ticket } = await signedPost<{ ticket?: { id?: string; status?: string } }>(merchantId, importSigningKey(privateKey), REFUND_PATH, {
        paymentId: input.providerPaymentId,
        reason: input.reason,
        requestedAmount: { amount: minorToDisplay(input.amountCents, input.currency), currency: input.currency },
        // 同一订单同一金额的重复提交在 60 秒幂等窗口内命中同一个请求
        refundTicketMerchantExternalId: `${input.orderId}:${input.amountCents}`,
      })
      return { refundId: null, ticketId: ticket?.id ?? null, status: ticket?.status ?? 'processing' }
    },
    // 按创建收银台时传的 orderMerchantExternalId（= 本站订单号）查付款；查询不带幂等键，避免 60 秒内拿到缓存的旧结果
    async fetchPaidEvent(order): Promise<PaidLookup | null> {
      if (!merchantId || !privateKey) throw new ApiError(503, 'payment_not_configured', 'Waffo credentials missing')
      const data = await signedPost<{ payments?: unknown }>(
        merchantId,
        importSigningKey(privateKey),
        GRAPHQL_PATH,
        { query: PAYMENTS_QUERY, variables: { ref: order.id } },
        { idempotent: false },
      )
      const payments = Array.isArray(data.payments) ? (data.payments as Array<Record<string, unknown>>) : []
      const paid = payments.find((pay) => pay.status === 'succeeded' && pay.orderMerchantExternalId === order.id)
      if (!paid) return null
      const event = waffoPaidEventFromPayment(paid, order.id)
      // 订阅首单：Waffo 的订阅就是这张 ORD_ 订单（续费也挂在它下面），查到的付款按订阅首付入账
      if (findPlan(order.packageId) && event.providerOrderId) event.subscription = { providerSubscriptionId: event.providerOrderId }
      return { event, raw: paid }
    },
    // 商户取消：active 到当期结束才终止（状态先变 canceling），past_due 立即终止
    // https://docs.waffo.ai/api-reference/endpoints/subscriptions/cancel-subscription
    async cancelSubscription(subscription) {
      if (!merchantId || !privateKey) throw new ApiError(503, 'payment_not_configured', 'Waffo credentials missing')
      await signedPost(merchantId, importSigningKey(privateKey), CANCEL_SUBSCRIPTION_PATH, { orderId: subscription.providerSubscriptionId })
    },
    // 撤销取消（reactivate-order）只接受买家的 session token，商户 API Key 调不了，所以不实现 resumeSubscription，
    // 由买家在客户门户里恢复。门户 token 按下单时的 buyerIdentity（= 本站用户 ID）签发
    // https://docs.waffo.ai/guides/customer-portal-sso
    async portalUrl(subscription) {
      if (!merchantId || !privateKey) throw new ApiError(503, 'payment_not_configured', 'Waffo credentials missing')
      const storeId = cleanSecret(env.WAFFO_STORE_ID)
      if (!storeId) throw new ApiError(503, 'payment_not_configured', 'WAFFO_STORE_ID missing')
      const data = await signedPost<{ token?: string; portalUrl?: string }>(
        merchantId,
        importSigningKey(privateKey),
        TOKEN_PATH,
        { storeId, buyerIdentity: subscription.user.id, purpose: 'portal' },
        { idempotent: false },
      )
      if (!data.token || !data.portalUrl) throw new ApiError(502, 'payment_provider_error', 'Invalid Waffo portal response')
      return `${data.portalUrl}#token=${data.token}`
    },
  }
}

// GraphQL Payment → paid 事件。商品和站点在下单时由服务端绑定到 orderMerchantExternalId，这里只能核对金额和币种
export function waffoPaidEventFromPayment(pay: Record<string, unknown>, orderId: string): PaidEvent {
  const amounts = record(pay.snapshotAmountDetails)
  const currency = str(amounts.currency)
  return {
    kind: 'paid',
    eventId: `reconcile:${str(pay.id) ?? orderId}`,
    eventType: 'reconcile',
    orderId,
    providerOrderId: str(pay.orderId),
    providerPaymentId: str(pay.id),
    paidAmount: str(amounts.total),
    paidCurrency: currency,
    paidAmountCents: displayToMinor(amounts.total, currency),
  }
}

async function signedPost<T>(
  merchantId: string,
  key: Promise<CryptoKey>,
  path: string,
  body: unknown,
  options: { idempotent?: boolean } = {},
): Promise<T> {
  const bodyText = JSON.stringify(body)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const bodyHash = base64Encode(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bodyText)))
  const signature = base64Encode(
    await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      await key,
      new TextEncoder().encode(`POST\n${path}\n${timestamp}\n${bodyHash}`),
    ),
  )
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Merchant-Id': merchantId,
      'X-Timestamp': timestamp,
      'X-Signature': signature,
      // 60 秒窗口：同一请求的网络重试命中幂等，过期后重新下单能拿到新 token
      ...(options.idempotent === false
        ? {}
        : { 'X-Idempotency-Key': await sha256Hex(`${merchantId}:${path}:${bodyText}:${Math.floor(Number(timestamp) / 60)}`) }),
    },
    body: bodyText,
    signal: AbortSignal.timeout(20_000),
  })
  let envelope: { data?: unknown; errors?: Array<{ message?: string }> }
  try {
    envelope = (await response.json()) as typeof envelope
  } catch {
    throw new ApiError(502, 'payment_provider_error', `Waffo ${path} returned non-JSON (${response.status})`)
  }
  if (!response.ok || envelope.errors?.length || !envelope.data || typeof envelope.data !== 'object') {
    const message = envelope.errors?.[0]?.message ?? `HTTP ${response.status}`
    // 409 是业务冲突（如该支付已有退款单在处理），原样透传，便于后台看懂
    if (response.status === 409) throw new ApiError(409, 'payment_provider_conflict', `Waffo ${path}: ${message}`)
    throw new ApiError(502, 'payment_provider_error', `Waffo ${path}: ${message}`)
  }
  return envelope.data as T
}

function importSigningKey(raw: string) {
  const normalized = raw.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim()
  const isPkcs1 = normalized.includes('BEGIN RSA PRIVATE KEY')
  const der = base64Decode(normalized.replace(/-----(BEGIN|END) (RSA )?PRIVATE KEY-----/g, '').replace(/\s+/g, ''))
  return crypto.subtle.importKey(
    'pkcs8',
    (isPkcs1 ? pkcs1ToPkcs8(der) : der).buffer as ArrayBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

function derLength(length: number) {
  if (length < 128) return [length]
  const bytes: number[] = []
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff)
  return [0x80 | bytes.length, ...bytes]
}

function der(tag: number, content: Uint8Array) {
  return Uint8Array.from([tag, ...derLength(content.length), ...content])
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function pkcs1ToPkcs8(pkcs1: Uint8Array) {
  const rsaOid = Uint8Array.of(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01)
  const algorithm = der(0x30, concat(der(0x06, rsaOid), der(0x05, new Uint8Array())))
  return der(0x30, concat(der(0x02, Uint8Array.of(0)), algorithm, der(0x04, pkcs1)))
}

// ---------- Webhook ----------
// Waffo 用平台公钥签名（test / prod 两把），商户侧无需配置 webhook secret。

const TEST_PUBLIC_KEY = `MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxnmRY6yMMA3lVqmAU6ZG
b1sjL/+r/z6E+ZjkXaDAKiqOhk9rpazni0bNsGXwmftTPk9jy2wn+j6JHODD/WH/
SCnSfvKkLIjy4Hk7BuCgB174C0ydan7J+KgXLkOwgCAxxB68t2tezldwo74ZpXgn
F49opzMvQ9prEwIAWOE+kV9iK6gx/AckSMtHIHpUesoPDkldpmFHlB2qpf1vsFTZ
5kD6DmGl+2GIVK01aChy2lk8pLv0yUMu18v44sLkO5M44TkGPJD9qG09wrvVG2wp
OTVCn1n5pP8P+HRLcgzbUB3OlZVfdFurn6EZwtyL4ZD9kdkQ4EZE/9inKcp3c1h4
xwIDAQAB`

const PROD_PUBLIC_KEY = `MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAz+xApdTIb4ua+DgZKQ54
iBsD82ybyhGCLRETONW4Jgbb3A8DUM1LqBk6r/CmTOCHqLalTQHNigvP3R5zkDNX
iRJz6gA4MJ/+8K0+mnEE2RISQzN+Qu65TNd6svb+INm/kMaftY4uIXr6y6kchtTJ
dwnQhcKdAL2v7h7IFnkVelQsKxDdb2PqX8xX/qwd01iXvMcpCCaXovUwZsxH2QN5
ZKBTseJivbhUeyJCco4fdUyxOMHe2ybCVhyvim2uxAl1nkvL5L8RCWMCAV55LLo0
9OhmLahz/DYNu13YLVP6dvIT09ZFBYU6Owj1NxdinTynlJCFS9VYwBgmftosSE1U
dwIDAQAB`

const TOLERANCE_MS = 45 * 60 * 1000
const FUTURE_TOLERANCE_MS = 60 * 1000

export type WaffoEnvironment = 'test' | 'prod'

export interface WaffoVerifyOptions {
  nowMs?: number
  publicKey?: CryptoKey // 测试用：注入自签公钥
}

export async function verifyWaffoWebhook(
  rawBody: string,
  signatureHeader: string | null | undefined,
  environment: WaffoEnvironment,
  options: WaffoVerifyOptions = {},
): Promise<Record<string, unknown>> {
  if (!signatureHeader) throw new WebhookVerificationError('missing X-Waffo-Signature')
  let timestamp = ''
  let value = ''
  for (const pair of signatureHeader.split(',')) {
    const index = pair.indexOf('=')
    if (index === -1) continue
    const key = pair.slice(0, index).trim()
    if (key === 't') timestamp = pair.slice(index + 1).trim()
    if (key === 'v1') value = pair.slice(index + 1).trim()
  }
  if (!timestamp || !value) throw new WebhookVerificationError('malformed X-Waffo-Signature')
  const age = (options.nowMs ?? Date.now()) - Number(timestamp)
  if (!Number.isFinite(age) || age > TOLERANCE_MS || age < -FUTURE_TOLERANCE_MS) {
    throw new WebhookVerificationError('timestamp outside tolerance')
  }
  const publicKey = options.publicKey ?? (await importPublicKey(environment))
  let signature: Uint8Array<ArrayBuffer>
  try {
    signature = base64Decode(value)
  } catch {
    throw new WebhookVerificationError('invalid signature encoding')
  }
  const valid = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    publicKey,
    signature,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  )
  if (!valid) throw new WebhookVerificationError('invalid signature')
  const payload = JSON.parse(rawBody) as Record<string, unknown>
  if (payload.mode && payload.mode !== environment) throw new WebhookVerificationError('mode mismatch')
  return payload
}

const publicKeys = new Map<WaffoEnvironment, Promise<CryptoKey>>()
function importPublicKey(environment: WaffoEnvironment) {
  let key = publicKeys.get(environment)
  if (!key) {
    const pem = environment === 'test' ? TEST_PUBLIC_KEY : PROD_PUBLIC_KEY
    key = crypto.subtle.importKey(
      'spki',
      base64Decode(pem.replace(/\s+/g, '')).buffer as ArrayBuffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    publicKeys.set(environment, key)
  }
  return key
}

export function waffoEnvironment(env: Env): WaffoEnvironment {
  return env.WAFFO_ENVIRONMENT === 'prod' || env.WAFFO_ENVIRONMENT === 'production' ? 'prod' : 'test'
}

export function normalizeWaffoEvent(payload: Record<string, unknown>): PaymentEvent {
  const eventType = String(payload.eventType ?? '')
  const eventId = String(payload.eventId ?? payload.id ?? '')
  if (!eventId) throw new WebhookVerificationError('missing eventId')
  const data = (payload.data ?? {}) as Record<string, unknown>
  const metadata = (data.orderMetadata ?? data.metadata ?? {}) as Record<string, unknown>
  const orderId = str(data.orderMerchantExternalId) ?? str(metadata.orderId)
  const currency = str(data.currency)
  // 金额是展示格式字符串（"29.00"、JPY "4500"）。amount/total 等字段已弃用（不早于 2027-09-20 移除），
  // 优先读 chargedAmount（实收）/ refundedAmount / originalChargedAmount，旧字段只作回退
  switch (eventType) {
    case 'order.completed': {
      const charged = data.chargedAmount ?? record(data.listPrice).total ?? data.total ?? data.amount
      return {
        kind: 'paid',
        eventId,
        eventType,
        orderId,
        providerOrderId: str(data.orderId),
        providerPaymentId: str(data.paymentId),
        paidAmount: str(charged),
        paidCurrency: currency,
        paidAmountCents: displayToMinor(charged, currency),
        // Waffo 不支持优惠券，productMetadata 由 waffo-setup.mjs 建商品时写入
        packageId: str(record(data.productMetadata).packageId),
        site: str(metadata.site) ?? str(record(data.productMetadata).site),
      }
    }
    // 订阅的首付和每次续费（不会发 order.completed）。eventId 是 PAY_ 支付号；不带周期，周期按付款时间推算，
    // 之后的 subscription.renewed 再校正。orderMerchantExternalId 始终是首单号，续费按 data.orderId（订阅 ORD_）找订阅
    case 'subscription.payment_succeeded': {
      const charged = data.chargedAmount ?? data.total ?? data.amount
      const subscriptionId = str(data.orderId)
      return {
        kind: 'paid',
        eventId,
        eventType,
        orderId,
        providerOrderId: subscriptionId,
        providerPaymentId: str(data.paymentId) ?? eventId,
        paidAmount: str(charged),
        paidCurrency: currency,
        paidAmountCents: displayToMinor(charged, currency),
        packageId: str(record(data.productMetadata).packageId),
        site: str(metadata.site) ?? str(record(data.productMetadata).site),
        subscription: subscriptionId ? { providerSubscriptionId: subscriptionId } : null,
      }
    }
    case 'refund.succeeded':
      return {
        kind: 'refunded',
        eventId,
        eventType,
        orderId,
        providerPaymentId: str(data.paymentId),
        refundId: str(data.refundId) ?? eventId,
        refundAmountCents: displayToMinor(data.refundedAmount ?? data.amount, currency),
        originalAmountCents: displayToMinor(data.originalChargedAmount ?? record(data.originalPayment).total, currency),
      }
    default: {
      const subscriptionId = str(data.orderId)
      if (eventType.startsWith('subscription.') && subscriptionId) {
        const orderStatus = str(data.orderStatus)
        const mapped = (orderStatus && WAFFO_ORDER_STATUS[orderStatus]) || WAFFO_EVENT_STATUS[eventType]
        return {
          kind: 'subscription',
          // activated、canceled、plan_changed 的 eventId 都是订单号：带上类型和事件时间，免得被当成同一事件去重
          eventId: [eventType, eventId, str(payload.timestamp)].filter(Boolean).join(':'),
          eventType,
          orderId,
          providerSubscriptionId: subscriptionId,
          status: mapped?.status ?? null,
          cancelAtPeriodEnd: eventType === 'subscription.uncanceled' ? false : (mapped?.cancelAtPeriodEnd ?? null),
          periodStart: isoDate(data.currentPeriodStart),
          periodEnd: isoDate(data.currentPeriodEnd),
          providerCustomerId: null,
          // Waffo 的事件不带商品 ID，用 waffo-setup.mjs 写进商品元数据的套餐 ID
          productId: null,
          planId: str(record(data.productMetadata).packageId),
          occurredAt: str(payload.timestamp),
          site: str(metadata.site) ?? str(record(data.productMetadata).site),
        }
      }
      return { kind: 'ignored', eventId, eventType }
    }
  }
}

// https://docs.waffo.ai/api-reference/webhooks：canceling = 当期结束后终止（这期仍可用，可以恢复）
type MappedStatus = { status: SubscriptionStatus | null; cancelAtPeriodEnd: boolean | null }
const WAFFO_ORDER_STATUS: Record<string, MappedStatus> = {
  active: { status: 'active', cancelAtPeriodEnd: false },
  canceling: { status: 'active', cancelAtPeriodEnd: true },
  canceled: { status: 'canceled', cancelAtPeriodEnd: null },
  past_due: { status: 'past_due', cancelAtPeriodEnd: null },
  expired: { status: 'expired', cancelAtPeriodEnd: null },
  closed: { status: 'expired', cancelAtPeriodEnd: null },
}
const WAFFO_EVENT_STATUS: Record<string, MappedStatus> = {
  'subscription.activated': WAFFO_ORDER_STATUS.active!,
  'subscription.renewed': WAFFO_ORDER_STATUS.active!,
  'subscription.recovered': WAFFO_ORDER_STATUS.active!,
  'subscription.uncanceled': WAFFO_ORDER_STATUS.active!,
  'subscription.canceling': WAFFO_ORDER_STATUS.canceling!,
  'subscription.canceled': WAFFO_ORDER_STATUS.canceled!,
  'subscription.past_due': WAFFO_ORDER_STATUS.past_due!,
}

// 周期字段是日期（2026-04-10）或完整时间，统一成 ISO
function isoDate(value: unknown) {
  const text = str(value)
  if (!text) return null
  const ms = Date.parse(text)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

function str(value: unknown) {
  return typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : null
}

function record(value: unknown) {
  return (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
}
