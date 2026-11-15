import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { site } from '#/config/site'
import { checkPaidEvent } from '#/server/orders'
import {
  STRIPE_API_VERSION,
  createStripeProvider,
  expandStripeEvent,
  formEncode,
  normalizeStripeEvent,
  verifyStripeWebhook,
} from '#/server/payments/stripe'

const NOW = Date.UTC(2026, 9, 20, 8, 0, 0)
const TS = Math.floor(NOW / 1000)
const SECRET = 'whsec_test_secret_value'

// Stripe-Signature：hex(HMAC-SHA256(whsec_ 整串, `${t}.${body}`))
function sign(body: string, timestamp = TS, secret = SECRET) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

const env = (overrides: Partial<Env> = {}) =>
  ({
    STRIPE_SECRET_KEY: 'sk_test_123',
    STRIPE_ENVIRONMENT: 'test',
    STRIPE_PRODUCTS: '{"starter":"price_starter","monthly":"price_monthly"}',
    ...overrides,
  }) as Env

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_test_1',
    object: 'checkout.session',
    mode: 'payment',
    status: 'complete',
    payment_status: 'paid',
    amount_total: 990,
    currency: 'usd',
    client_reference_id: 'ord_1',
    payment_intent: 'pi_1',
    metadata: { orderId: 'ord_1', site: site.domain },
    total_details: { amount_discount: 0 },
    line_items: { data: [{ price: { id: 'price_starter' } }] },
    ...overrides,
  }
}

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'in_1',
    object: 'invoice',
    status: 'paid',
    billing_reason: 'subscription_create',
    amount_paid: 1490,
    currency: 'usd',
    customer: 'cus_1',
    parent: {
      type: 'subscription_details',
      subscription_details: { subscription: 'sub_1', metadata: { orderId: 'ord_sub', site: site.domain } },
    },
    lines: {
      data: [
        {
          parent: { type: 'subscription_item_details' },
          period: { start: TS, end: TS + 30 * 86400 },
          pricing: { price_details: { price: 'price_monthly' } },
        },
      ],
    },
    payments: { data: [{ status: 'paid', payment: { type: 'payment_intent', payment_intent: 'pi_sub_1' } }] },
    ...overrides,
  }
}

const event = (type: string, object: unknown, extra: Record<string, unknown> = {}) => ({ id: 'evt_1', type, created: TS, data: { object }, ...extra })

describe('verifyStripeWebhook', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', livemode: false, data: { object: {} } })

  it('接受正确签名；轮换密钥期间多个 v1 中任一匹配即通过', async () => {
    await expect(verifyStripeWebhook(body, `t=${TS},v1=${sign(body)}`, SECRET, 'test', NOW)).resolves.toMatchObject({ id: 'evt_1' })
    const multi = `t=${TS},v1=${sign(body, TS, 'whsec_old')},v1=${sign(body)},v0=abc`
    await expect(verifyStripeWebhook(body, multi, SECRET, 'test', NOW)).resolves.toBeTruthy()
  })

  it('拒绝篡改 body、改时间戳重放、只有 v0 签名、缺少签名头或密钥', async () => {
    const header = `t=${TS},v1=${sign(body)}`
    await expect(verifyStripeWebhook(body.replace('evt_1', 'evt_2'), header, SECRET, 'test', NOW)).rejects.toThrow('invalid signature')
    await expect(verifyStripeWebhook(body, `t=${TS + 1},v1=${sign(body)}`, SECRET, 'test', NOW)).rejects.toThrow('invalid signature')
    await expect(verifyStripeWebhook(body, `t=${TS},v0=${sign(body)}`, SECRET, 'test', NOW)).rejects.toThrow('missing stripe-signature')
    await expect(verifyStripeWebhook(body, null, SECRET, 'test', NOW)).rejects.toThrow('missing stripe-signature')
    await expect(verifyStripeWebhook(body, header, ' ', 'test', NOW)).rejects.toThrow('STRIPE_WEBHOOK_SECRET missing')
  })

  it('拒绝 5 分钟容差外的时间戳', async () => {
    const old = TS - 6 * 60
    await expect(verifyStripeWebhook(body, `t=${old},v1=${sign(body, old)}`, SECRET, 'test', NOW)).rejects.toThrow('timestamp')
    const future = TS + 6 * 60
    await expect(verifyStripeWebhook(body, `t=${future},v1=${sign(body, future)}`, SECRET, 'test', NOW)).rejects.toThrow('timestamp')
  })

  it('livemode 与 STRIPE_ENVIRONMENT 不一致时拒收：test 环境收到 live 事件、live 环境收到 test 事件', async () => {
    const live = JSON.stringify({ id: 'evt_1', type: 'x', livemode: true })
    await expect(verifyStripeWebhook(live, `t=${TS},v1=${sign(live)}`, SECRET, 'test', NOW)).rejects.toThrow('livemode mismatch')
    await expect(verifyStripeWebhook(live, `t=${TS},v1=${sign(live)}`, SECRET, 'live', NOW)).resolves.toBeTruthy()
    await expect(verifyStripeWebhook(body, `t=${TS},v1=${sign(body)}`, SECRET, 'live', NOW)).rejects.toThrow('livemode mismatch')
  })
})

describe('normalizeStripeEvent', () => {
  it('积分包 checkout 完成映射为 paid，带实付金额、PaymentIntent、Price 和站点', () => {
    const paid = normalizeStripeEvent(event('checkout.session.completed', session()))
    expect(paid).toEqual({
      kind: 'paid',
      eventId: 'evt_1',
      eventType: 'checkout.session.completed',
      orderId: 'ord_1',
      providerOrderId: 'cs_test_1',
      providerPaymentId: 'pi_1',
      paidAmount: '9.90',
      paidCurrency: 'USD',
      paidAmountCents: 990,
      productId: 'price_starter',
      discounted: false,
      site: site.domain,
      subscription: null,
    })
    expect(checkPaidEvent({ package_id: 'starter', amount_cents: 990, currency: 'USD' }, paid as never, 'price_starter')).toBeNull()
  })

  it('异步付款：completed 时还是 unpaid 的忽略，async_payment_succeeded 入账，async_payment_failed 和 expired 标记失败', () => {
    expect(normalizeStripeEvent(event('checkout.session.completed', session({ payment_status: 'unpaid' }))).kind).toBe('ignored')
    expect(normalizeStripeEvent(event('checkout.session.async_payment_succeeded', session())).kind).toBe('paid')
    expect(normalizeStripeEvent(event('checkout.session.async_payment_failed', session({ payment_status: 'unpaid' })))).toEqual({
      kind: 'failed',
      eventId: 'evt_1',
      eventType: 'checkout.session.async_payment_failed',
      orderId: 'ord_1',
    })
    // metadata 丢失时用 client_reference_id 找订单
    expect(normalizeStripeEvent(event('checkout.session.expired', session({ metadata: {} })))).toMatchObject({ kind: 'failed', orderId: 'ord_1' })
  })

  it('订阅模式的 checkout 完成不入账（首付以 invoice.paid 为准，避免重复加积分）', () => {
    expect(normalizeStripeEvent(event('checkout.session.completed', session({ mode: 'subscription' }))).kind).toBe('ignored')
  })

  it('用了优惠码时标记 discounted，少付也不判为金额不符；没用时少付会被拦下', () => {
    const discounted = normalizeStripeEvent(event('checkout.session.completed', session({ amount_total: 500, total_details: { amount_discount: 490 } })))
    expect(discounted).toMatchObject({ discounted: true, paidAmountCents: 500 })
    expect(checkPaidEvent({ package_id: 'starter', amount_cents: 990, currency: 'USD' }, discounted as never, 'price_starter')).toBeNull()
    const short = normalizeStripeEvent(event('checkout.session.completed', session({ amount_total: 500 })))
    expect(checkPaidEvent({ package_id: 'starter', amount_cents: 990, currency: 'USD' }, short as never, 'price_starter')).toMatch(/paid 500/)
    const wrong = normalizeStripeEvent(event('checkout.session.completed', session({ line_items: { data: [{ price: { id: 'price_other' } }] } })))
    expect(checkPaidEvent({ package_id: 'starter', amount_cents: 990, currency: 'USD' }, wrong as never, 'price_starter')).toMatch(/product price_other/)
  })

  it('订阅首付 invoice.paid 映射为带订阅信息的 paid：订阅号、客户、周期、首单号、PaymentIntent', () => {
    expect(normalizeStripeEvent(event('invoice.paid', invoice()))).toEqual({
      kind: 'paid',
      eventId: 'evt_1',
      eventType: 'invoice.paid',
      orderId: 'ord_sub',
      providerOrderId: 'in_1',
      providerPaymentId: 'pi_sub_1',
      paidAmount: '14.90',
      paidCurrency: 'USD',
      paidAmountCents: 1490,
      productId: 'price_monthly',
      discounted: false,
      site: site.domain,
      subscription: {
        providerSubscriptionId: 'sub_1',
        providerCustomerId: 'cus_1',
        periodStart: new Date(NOW).toISOString(),
        periodEnd: new Date(NOW + 30 * 86400_000).toISOString(),
      },
    })
  })

  it('续费账单不核对 Price（老订阅锁定旧价格）；payments 没展开时用账单号；非订阅账单忽略', () => {
    const renewal = normalizeStripeEvent(event('invoice.paid', invoice({ billing_reason: 'subscription_cycle', payments: undefined })))
    expect(renewal).toMatchObject({ kind: 'paid', productId: null, providerPaymentId: 'in_1' })
    expect(normalizeStripeEvent(event('invoice.paid', invoice({ parent: { type: 'quote_details' } }))).kind).toBe('ignored')
  })

  it('订阅状态事件映射状态、到期取消、周期、换套餐后的 Price 和发生时间', () => {
    const sub = {
      id: 'sub_1',
      object: 'subscription',
      status: 'active',
      customer: 'cus_1',
      cancel_at_period_end: false,
      cancel_at: null,
      metadata: { orderId: 'ord_sub', site: site.domain },
      items: { data: [{ price: { id: 'price_yearly' }, current_period_start: TS, current_period_end: TS + 365 * 86400 }] },
    }
    expect(normalizeStripeEvent(event('customer.subscription.updated', sub))).toEqual({
      kind: 'subscription',
      eventId: 'evt_1',
      eventType: 'customer.subscription.updated',
      orderId: 'ord_sub',
      providerSubscriptionId: 'sub_1',
      status: 'active',
      cancelAtPeriodEnd: false,
      periodStart: new Date(NOW).toISOString(),
      periodEnd: new Date(NOW + 365 * 86400_000).toISOString(),
      providerCustomerId: 'cus_1',
      productId: 'price_yearly',
      occurredAt: new Date(NOW).toISOString(),
      site: site.domain,
    })
    const statusOf = (status: string) => (normalizeStripeEvent(event('customer.subscription.updated', { ...sub, status })) as { status: unknown }).status
    expect(['trialing', 'past_due', 'unpaid', 'canceled', 'incomplete_expired', 'incomplete', 'paused'].map(statusOf)).toEqual([
      'active',
      'past_due',
      'past_due',
      'canceled',
      'expired',
      null,
      null,
    ])
    // 门户里选“按日期取消”只设 cancel_at，同样视为不再续费
    expect(normalizeStripeEvent(event('customer.subscription.updated', { ...sub, cancel_at: TS + 86400 }))).toMatchObject({ cancelAtPeriodEnd: true })
    expect(normalizeStripeEvent(event('customer.subscription.deleted', { ...sub, status: 'canceled' }))).toMatchObject({ status: 'canceled' })
  })

  it('退款成功映射为 refunded（部分退款带金额），处理中和失败的退款忽略', () => {
    const refund = { id: 're_1', object: 'refund', status: 'succeeded', amount: 300, payment_intent: 'pi_1', metadata: { orderId: 'ord_1' } }
    expect(normalizeStripeEvent(event('refund.created', refund))).toEqual({
      kind: 'refunded',
      eventId: 'evt_1',
      eventType: 'refund.created',
      orderId: 'ord_1',
      providerPaymentId: 'pi_1',
      refundId: 're_1',
      refundAmountCents: 300,
      originalAmountCents: null,
    })
    // 在 Stripe 后台发起的退款没有 metadata，按 PaymentIntent 找订单
    expect(normalizeStripeEvent(event('refund.updated', { ...refund, metadata: {} }))).toMatchObject({ orderId: null, providerPaymentId: 'pi_1' })
    expect(normalizeStripeEvent(event('refund.created', { ...refund, status: 'pending' })).kind).toBe('ignored')
    expect(normalizeStripeEvent(event('refund.updated', { ...refund, status: 'failed' })).kind).toBe('ignored')
    expect(normalizeStripeEvent(event('charge.refunded', {})).kind).toBe('ignored')
  })
})

describe('formEncode', () => {
  it('嵌套对象和数组编码成 Stripe 的 a[b] / a[0][b] 格式，跳过 null', () => {
    const encoded = formEncode({ mode: 'payment', line_items: [{ price: 'price_1', quantity: 1 }], metadata: { orderId: 'ord_1', none: null } })
    expect(decodeURIComponent(encoded)).toBe('mode=payment&line_items[0][price]=price_1&line_items[0][quantity]=1&metadata[orderId]=ord_1')
  })
})

type Call = { url: string; method: string; body: string; headers: Record<string, string> }

function stubStripe(handler: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const call = { url, method: init.method ?? 'GET', body: decodeURIComponent(String(init.body ?? '')), headers: init.headers as Record<string, string> }
    calls.push(call)
    const result = handler(call)
    return new Response(JSON.stringify(result.body), { status: result.status ?? 200 })
  })
  return calls
}

const checkoutInput = (packageId: string) => ({
  order: { id: 'ord_1', packageId, credits: 20, amountCents: 990, currency: 'USD' },
  user: { id: 'usr_1', email: 'a@example.com', name: null },
  successUrl: 'https://moonhop.ai/checkout/success?order=ord_1',
  cancelUrl: 'https://moonhop.ai/pricing',
})

describe('createStripeProvider', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('积分包用 payment 模式，订单号写进 session 和 PaymentIntent 的 metadata，限定银行卡、必填账单地址与 35 分钟过期', async () => {
    const calls = stubStripe(() => ({ body: { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' } }))
    const beforeSec = Math.floor(Date.now() / 1000)
    const result = await createStripeProvider(env()).createCheckout(checkoutInput('starter'))
    expect(result).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_1', sessionId: 'cs_1' })
    const [call] = calls
    expect(call!.url).toBe('https://api.stripe.com/v1/checkout/sessions')
    expect(call!.headers).toMatchObject({ Authorization: 'Bearer sk_test_123', 'Stripe-Version': STRIPE_API_VERSION, 'Idempotency-Key': 'checkout:ord_1' })
    expect(call!.body).toContain('mode=payment&line_items[0][price]=price_starter&line_items[0][quantity]=1')
    expect(call!.body).toContain('payment_method_types[0]=card')
    expect(call!.body).toContain('billing_address_collection=required')
    const expiresMatch = call!.body.match(/(?:^|&)expires_at=(\d+)/)
    expect(expiresMatch).not.toBeNull()
    const expiresAt = Number(expiresMatch![1])
    expect(expiresAt).toBeGreaterThanOrEqual(beforeSec + 34 * 60)
    expect(expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 36 * 60)
    expect(call!.body).toContain('client_reference_id=ord_1')
    expect(call!.body).toContain('payment_intent_data[metadata][orderId]=ord_1')
    expect(call!.body).not.toContain('subscription_data')
  })

  it('订阅套餐用 subscription 模式，metadata 写到 Subscription 上；没配 Price 或 Key 时 503', async () => {
    const calls = stubStripe(() => ({ body: { id: 'cs_2', url: 'https://checkout.stripe.com/c/pay/cs_2' } }))
    await createStripeProvider(env()).createCheckout(checkoutInput('monthly'))
    expect(calls[0]!.body).toContain('mode=subscription')
    expect(calls[0]!.body).toContain('subscription_data[metadata][orderId]=ord_1')
    await expect(createStripeProvider(env()).createCheckout(checkoutInput('party'))).rejects.toMatchObject({ status: 503 })
    await expect(createStripeProvider(env({ STRIPE_SECRET_KEY: '' })).createCheckout(checkoutInput('starter'))).rejects.toMatchObject({ status: 503 })
  })

  it('Stripe 报错转成 502，401 不带 Stripe 原文（里面有打码的 Key）', async () => {
    stubStripe(() => ({ status: 401, body: { error: { message: 'Invalid API Key provided: sk_test_***123' } } }))
    const error = await createStripeProvider(env()).createCheckout(checkoutInput('starter')).catch((e: Error) => e)
    expect(error).toMatchObject({ status: 502 })
    expect(String((error as Error).message)).not.toContain('sk_test')
  })

  it('退款按 PaymentIntent 提交，部分退款带金额；已全额退过等业务错误转成 409', async () => {
    const calls = stubStripe(() => ({ body: { id: 're_1', status: 'succeeded' } }))
    const provider = createStripeProvider(env())
    const request = { orderId: 'ord_1', packageId: 'starter', providerPaymentId: 'pi_1', amountCents: 300, fullAmount: false, currency: 'USD', reason: '重复购买' }
    expect(await provider.refund!(request)).toEqual({ refundId: 're_1', status: 'succeeded' })
    expect(calls[0]!.body).toContain('payment_intent=pi_1&amount=300')
    expect(calls[0]!.body).toContain('metadata[orderId]=ord_1')
    await provider.refund!({ ...request, fullAmount: true })
    expect(calls[1]!.body).not.toContain('amount=')
    stubStripe(() => ({ status: 400, body: { error: { code: 'charge_already_refunded', message: 'already refunded' } } }))
    await expect(provider.refund!(request)).rejects.toMatchObject({ status: 409, code: 'payment_provider_conflict' })
  })

  it('查单：积分包 session 已付返回 reconcile 事件，eventId 用 PaymentIntent；未付、不存在、没有 session id 返回 null', async () => {
    let current: { status?: number; body: unknown } = { body: session() }
    const calls = stubStripe(() => current)
    const provider = createStripeProvider(env())
    const found = await provider.fetchPaidEvent!({ id: 'ord_1', packageId: 'starter', providerSessionId: 'cs_test_1' })
    expect(found?.event).toMatchObject({ kind: 'paid', eventId: 'reconcile:pi_1', eventType: 'reconcile', orderId: 'ord_1', productId: 'price_starter' })
    expect(decodeURIComponent(calls[0]!.url)).toBe('https://api.stripe.com/v1/checkout/sessions/cs_test_1?expand[0]=line_items')
    current = { body: session({ payment_status: 'unpaid', status: 'open' }) }
    expect(await provider.fetchPaidEvent!({ id: 'ord_1', packageId: 'starter', providerSessionId: 'cs_test_1' })).toBeNull()
    current = { status: 404, body: { error: { code: 'resource_missing' } } }
    expect(await provider.fetchPaidEvent!({ id: 'ord_1', packageId: 'starter', providerSessionId: 'cs_test_1' })).toBeNull()
    expect(await provider.fetchPaidEvent!({ id: 'ord_1', packageId: 'starter', providerSessionId: null })).toBeNull()
    current = { status: 500, body: {} }
    await expect(provider.fetchPaidEvent!({ id: 'ord_1', packageId: 'starter', providerSessionId: 'cs_test_1' })).rejects.toMatchObject({ status: 502 })
  })

  it('查单：订阅 session 取首张账单，账单已付才按 invoice.paid 归一化', async () => {
    let invoiceBody = invoice()
    stubStripe((call) =>
      call.url.includes('/invoices/')
        ? { body: invoiceBody }
        : { body: session({ mode: 'subscription', invoice: 'in_1', payment_intent: null, line_items: { data: [{ price: { id: 'price_monthly' } }] } }) },
    )
    const provider = createStripeProvider(env())
    const found = await provider.fetchPaidEvent!({ id: 'ord_sub', packageId: 'monthly', providerSessionId: 'cs_sub' })
    expect(found?.event).toMatchObject({ eventId: 'reconcile:pi_sub_1', eventType: 'reconcile', orderId: 'ord_sub', subscription: { providerSubscriptionId: 'sub_1' } })
    invoiceBody = invoice({ status: 'open' })
    expect(await provider.fetchPaidEvent!({ id: 'ord_sub', packageId: 'monthly', providerSessionId: 'cs_sub' })).toBeNull()
  })

  it('取消、恢复订阅改 cancel_at_period_end；门户缺客户号时先查订阅', async () => {
    const calls = stubStripe((call) =>
      call.url.includes('billing_portal') ? { body: { url: 'https://billing.stripe.com/p/session/1' } } : { body: { id: 'sub_1', customer: 'cus_9' } },
    )
    const provider = createStripeProvider(env())
    const ref = { providerSubscriptionId: 'sub_1', providerCustomerId: null, user: { id: 'usr_1', email: 'a@example.com' } }
    await provider.cancelSubscription!(ref)
    await provider.resumeSubscription!(ref)
    expect(calls.map((c) => `${c.method} ${c.body}`)).toEqual(['POST cancel_at_period_end=true', 'POST cancel_at_period_end=false'])
    expect(await provider.portalUrl!(ref, 'https://moonhop.ai/account/billing')).toBe('https://billing.stripe.com/p/session/1')
    expect(calls[2]!.method).toBe('GET')
    expect(calls[3]!.body).toBe('customer=cus_9&return_url=https://moonhop.ai/account/billing')
  })
})

describe('expandStripeEvent', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('付款类事件用固定 API 版本重新取对象（展开 line_items / payments），其他事件不调用 API', async () => {
    const calls = stubStripe((call) => ({ body: call.url.includes('/invoices/') ? invoice() : session() }))
    const expanded = await expandStripeEvent(env(), event('checkout.session.completed', { id: 'cs_test_1' }))
    expect(normalizeStripeEvent(expanded)).toMatchObject({ kind: 'paid', productId: 'price_starter' })
    const paid = await expandStripeEvent(env(), event('invoice.paid', { id: 'in_1' }))
    expect(normalizeStripeEvent(paid)).toMatchObject({ providerPaymentId: 'pi_sub_1' })
    expect(calls.map((c) => decodeURIComponent(c.url))).toEqual([
      'https://api.stripe.com/v1/checkout/sessions/cs_test_1?expand[0]=line_items',
      'https://api.stripe.com/v1/invoices/in_1?expand[0]=payments',
    ])
    const refund = event('refund.created', { id: 're_1' })
    expect(await expandStripeEvent(env(), refund)).toBe(refund)
    expect(await expandStripeEvent(env(), event('checkout.session.expired', { id: 'cs_test_1' }))).toMatchObject({ data: { object: { id: 'cs_test_1' } } })
    expect(calls).toHaveLength(2)
  })

  it('对象已删除（404）时沿用 payload；Stripe 出错时抛出，webhook 返回 502 让 Stripe 重试', async () => {
    stubStripe(() => ({ status: 404, body: { error: { code: 'resource_missing' } } }))
    const original = event('invoice.paid', invoice())
    expect(await expandStripeEvent(env(), original)).toBe(original)
    stubStripe(() => ({ status: 500, body: {} }))
    await expect(expandStripeEvent(env(), original)).rejects.toMatchObject({ status: 502 })
  })
})
