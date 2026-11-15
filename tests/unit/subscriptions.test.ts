import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { findPlan } from '#/config/site'
import { processPaymentEvent, refundOrder } from '#/server/orders'
import { normalizeDodoEvent } from '#/server/payments/dodo'
import type { PaymentEvent, SubscriptionCharge } from '#/server/payments/types'
import { normalizeWaffoEvent } from '#/server/payments/waffo'
import { addMonths, grantDueSubscriptions, grantWindow, liveSubscription, nextGrantAt } from '#/server/subscriptions'
import type { OrderRow, SubscriptionRow } from '#/server/types'
import { d1Shim, kvShim, migrate } from './d1-sqlite'

// 入账后的通知邮件与本测试无关
vi.mock('#/server/notifications', () => ({ notifyOrderPaid: async () => {} }))

const DAY = 86400_000
const HOUR = 3600_000
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString()
const monthly = findPlan('monthly')!
const yearly = findPlan('yearly')!

describe('周期推算', () => {
  it('按日历月相加，日期超出当月时取月末（含闰年）', () => {
    expect(addMonths('2026-01-31T10:00:00.000Z', 1)).toBe('2026-02-28T10:00:00.000Z')
    expect(addMonths('2028-01-31T10:00:00.000Z', 1)).toBe('2028-02-29T10:00:00.000Z')
    expect(addMonths('2028-02-29T00:00:00.000Z', 12)).toBe('2029-02-28T00:00:00.000Z')
    expect(addMonths('2026-03-31T00:00:00.000Z', -1)).toBe('2026-02-28T00:00:00.000Z')
    // 不累积误差：从开始日直接加 k 个月，而不是逐月相加
    expect(addMonths('2026-01-31T00:00:00.000Z', 2)).toBe('2026-03-31T00:00:00.000Z')
  })

  it('年付按月补发：第 k 个月从开始日 + k 月起，到下个月同日或当期结束作废；离当期结束不到一天不再补发', () => {
    const sub = { interval: 'year' as const, current_period_start: '2026-01-31T00:00:00.000Z', current_period_end: '2027-01-31T03:00:00.000Z' }
    expect(nextGrantAt(sub, 1)).toBe('2026-02-28T00:00:00.000Z')
    expect(nextGrantAt(sub, 11)).toBe('2026-12-31T00:00:00.000Z')
    expect(nextGrantAt(sub, 12)).toBeNull()
    expect(grantWindow(sub, 0)).toEqual({ start: '2026-01-31T00:00:00.000Z', expiresAt: '2026-02-28T00:00:00.000Z' })
    expect(grantWindow(sub, 11)).toEqual({ start: '2026-12-31T00:00:00.000Z', expiresAt: '2027-01-31T00:00:00.000Z' })
    // 月付只有一个月，直接用支付商给的当期结束时间
    const month = { interval: 'month' as const, current_period_start: '2026-01-31T00:00:00.000Z', current_period_end: '2026-03-02T05:00:00.000Z' }
    expect(nextGrantAt(month, 1)).toBeNull()
    expect(grantWindow(month, 0).expiresAt).toBe('2026-03-02T05:00:00.000Z')
  })
})

describe('订阅事件归一化', () => {
  it('Dodo：订阅扣款带订阅号和本次覆盖的周期，不核对商品；订阅状态事件映射到本地状态', () => {
    const paid = normalizeDodoEvent({
      __webhookId: 'msg_1',
      type: 'payment.succeeded',
      data: {
        payment_id: 'pay_1',
        subscription_id: 'sub_1',
        total_amount: 1490,
        currency: 'USD',
        product_cart: null,
        customer: { customer_id: 'cus_1' },
        service_periods: [{ subscription_id: 'sub_1', starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-11-01T00:00:00Z' }],
        metadata: { orderId: 'ord_1', site: 'example.com' },
      },
    })
    expect(paid).toMatchObject({
      kind: 'paid',
      orderId: 'ord_1',
      providerPaymentId: 'pay_1',
      paidAmountCents: 1490,
      productId: null,
      subscription: { providerSubscriptionId: 'sub_1', providerCustomerId: 'cus_1', periodStart: '2026-10-01T00:00:00Z', periodEnd: '2026-11-01T00:00:00Z' },
    })
    // 一次性付款没有订阅号
    expect(normalizeDodoEvent({ __webhookId: 'm', type: 'payment.succeeded', data: { payment_id: 'p', total_amount: 990, currency: 'USD' } })).toMatchObject({ subscription: null })

    const onHold = normalizeDodoEvent({
      __webhookId: 'msg_2',
      type: 'subscription.on_hold',
      timestamp: '2026-11-01T01:00:00Z',
      data: { subscription_id: 'sub_1', status: 'on_hold', cancel_at_next_billing_date: false, product_id: 'pdt_m', next_billing_date: '2026-12-01T00:00:00Z', metadata: { orderId: 'ord_1' } },
    })
    expect(onHold).toMatchObject({ kind: 'subscription', providerSubscriptionId: 'sub_1', status: 'past_due', cancelAtPeriodEnd: false, productId: 'pdt_m', occurredAt: '2026-11-01T01:00:00Z' })
    expect(normalizeDodoEvent({ __webhookId: 'm', type: 'subscription.paused', data: { subscription_id: 'sub_1', status: 'paused' } })).toMatchObject({ status: null })
  })

  it('Waffo：订阅扣款按订阅订单号找订阅；canceling/uncanceled 只改到期取消标记；同一订单号的不同事件不会被当成重复', () => {
    const paid = normalizeWaffoEvent({
      eventId: 'PAY_2',
      eventType: 'subscription.payment_succeeded',
      data: { orderId: 'ORD_sub', orderMerchantExternalId: 'ord_1', paymentId: 'PAY_2', chargedAmount: '14.90', currency: 'USD', productMetadata: { packageId: 'monthly' } },
    })
    expect(paid).toMatchObject({ kind: 'paid', orderId: 'ord_1', providerPaymentId: 'PAY_2', paidAmountCents: 1490, packageId: 'monthly', subscription: { providerSubscriptionId: 'ORD_sub' } })

    const canceling = normalizeWaffoEvent({
      eventId: 'ORD_sub',
      eventType: 'subscription.canceling',
      timestamp: '2026-10-05T00:00:00Z',
      data: { orderId: 'ORD_sub', orderStatus: 'canceling', currentPeriodStart: '2026-10-01', currentPeriodEnd: '2026-11-01' },
    })
    expect(canceling).toMatchObject({
      kind: 'subscription',
      status: 'active',
      cancelAtPeriodEnd: true,
      periodStart: '2026-10-01T00:00:00.000Z',
      periodEnd: '2026-11-01T00:00:00.000Z',
    })
    const uncanceled = normalizeWaffoEvent({ eventId: 'ORD_sub', eventType: 'subscription.uncanceled', timestamp: '2026-10-06T00:00:00Z', data: { orderId: 'ORD_sub' } })
    expect(uncanceled).toMatchObject({ status: 'active', cancelAtPeriodEnd: false })
    expect(uncanceled.eventId).not.toBe(canceling.eventId)
    expect(normalizeWaffoEvent({ eventId: 'ORD_sub', eventType: 'subscription.past_due', data: { orderId: 'ORD_sub' } })).toMatchObject({ status: 'past_due' })
  })
})

describe('订阅入账', () => {
  let sqlite: DatabaseSync
  let env: Env
  let seq = 0

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    migrate(sqlite)
    env = { DB: d1Shim(sqlite), KV: kvShim() } as unknown as Env
    sqlite.prepare('INSERT INTO users (id, email, credits, status, created_at) VALUES (?, ?, 0, ?, ?)').run('u1', 'u1@example.com', 'active', iso())
  })

  const credits = () => (sqlite.prepare(`SELECT credits FROM users WHERE id = 'u1'`).get() as { credits: number }).credits
  const sub = () => sqlite.prepare(`SELECT * FROM subscriptions WHERE user_id = 'u1'`).get() as unknown as SubscriptionRow
  const order = (id: string) => sqlite.prepare('SELECT * FROM orders WHERE id = ?').get(id) as unknown as OrderRow
  const orders = () => sqlite.prepare(`SELECT id, status, credits, subscription_id FROM orders WHERE user_id = 'u1' ORDER BY created_at, rowid`).all() as unknown as OrderRow[]
  const grants = (refId: string) =>
    sqlite.prepare('SELECT amount, remaining, expires_at FROM credit_grants WHERE ref_id = ? ORDER BY rowid').all(refId) as Array<{
      amount: number
      remaining: number
      expires_at: string | null
    }>

  function addOrder(packageId: string, amountCents: number, orderCredits: number) {
    const id = `ord_${++seq}`
    sqlite
      .prepare(
        `INSERT INTO orders (id, user_id, provider, package_id, credits, amount_cents, currency, status, created_at, updated_at)
         VALUES (?, 'u1', 'mock', ?, ?, ?, 'USD', 'pending', ?, ?)`,
      )
      .run(id, packageId, orderCredits, amountCents, iso(), iso())
    return id
  }

  const charge = (orderId: string, paymentId: string, cents: number, subscription: SubscriptionCharge | null, eventId = `evt_${paymentId}`): PaymentEvent => ({
    kind: 'paid',
    eventId,
    eventType: 'mock.paid',
    orderId,
    providerOrderId: subscription?.providerSubscriptionId ?? null,
    providerPaymentId: paymentId,
    paidAmount: (cents / 100).toFixed(2),
    paidCurrency: 'USD',
    paidAmountCents: cents,
    subscription,
  })
  const state = (
    occurredAt: string,
    patch: { status?: 'active' | 'past_due' | 'canceled' | 'expired' | null; cancelAtPeriodEnd?: boolean | null; periodStart?: string; periodEnd?: string },
    providerSubscriptionId = 'msub_1',
  ): PaymentEvent => ({
    kind: 'subscription',
    eventId: `evt_state_${occurredAt}`,
    eventType: 'mock.subscription',
    orderId: null,
    providerSubscriptionId,
    status: patch.status ?? null,
    cancelAtPeriodEnd: patch.cancelAtPeriodEnd ?? null,
    periodStart: patch.periodStart ?? null,
    periodEnd: patch.periodEnd ?? null,
    providerCustomerId: null,
    productId: null,
    occurredAt,
    site: null,
  })
  const process = (event: PaymentEvent) => processPaymentEvent(env, 'mock', event, '{}')

  async function startMonthly() {
    const first = addOrder('monthly', monthly.priceCents, monthly.credits)
    const periodEnd = iso(30 * DAY)
    const result = await process(charge(first, 'pay_1', monthly.priceCents, { providerSubscriptionId: 'msub_1', periodStart: iso(), periodEnd }))
    return { first, periodEnd, result }
  }

  it('首付：积分当期结束作废，建订阅并关联订单；重放和同一支付号的新事件都算重复', async () => {
    const { first, periodEnd, result } = await startMonthly()
    expect(result.status).toBe('processed')
    expect(credits()).toBe(monthly.credits)
    expect(grants(first)).toEqual([{ amount: monthly.credits, remaining: monthly.credits, expires_at: periodEnd }])
    expect(sub()).toMatchObject({ status: 'active', plan_id: 'monthly', current_order_id: first, grants_done: 1, next_grant_at: null, amount_cents: monthly.priceCents })
    expect(order(first)).toMatchObject({ status: 'paid', subscription_id: sub().id })

    expect((await process(charge(first, 'pay_1', monthly.priceCents, { providerSubscriptionId: 'msub_1' }))).status).toBe('duplicate')
    expect((await process(charge(first, 'pay_1', monthly.priceCents, { providerSubscriptionId: 'msub_1' }, 'evt_other'))).status).toBe('duplicate')
    expect(credits()).toBe(monthly.credits)
  })

  it('套餐订单付款却没有订阅信息、积分包订单带订阅信息，都按金额/商品不符处理，不入账', async () => {
    const plan = addOrder('monthly', monthly.priceCents, monthly.credits)
    expect((await process(charge(plan, 'pay_x', monthly.priceCents, null))).status).toBe('mismatch')
    const pack = addOrder('starter', 990, 20)
    expect((await process(charge(pack, 'pay_y', 990, { providerSubscriptionId: 'msub_x' }))).status).toBe('mismatch')
    expect(credits()).toBe(0)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM subscriptions').get()).toEqual({ n: 0 })
  })

  it('续费：每次扣款新建一张订单（重放不重复建），金额按订阅锁定的价格核对，不符时只记待处理订单', async () => {
    const { first } = await startMonthly()
    const nextStart = iso(30 * DAY)
    const renewal = await process(charge(first, 'pay_2', monthly.priceCents, { providerSubscriptionId: 'msub_1', periodStart: nextStart, periodEnd: iso(61 * DAY) }))
    expect(renewal.status).toBe('processed')
    expect(renewal.orderId).not.toBe(first)
    expect(credits()).toBe(monthly.credits * 2)
    expect(order(renewal.orderId!)).toMatchObject({ status: 'paid', package_id: 'monthly', subscription_id: sub().id, provider_payment_id: 'pay_2' })
    expect(sub()).toMatchObject({ current_order_id: renewal.orderId, current_period_start: nextStart, status: 'active' })
    expect((await process(charge(first, 'pay_2', monthly.priceCents, { providerSubscriptionId: 'msub_1' }, 'evt_retry'))).status).toBe('duplicate')

    const cheap = await process(charge(first, 'pay_3', monthly.priceCents - 100, { providerSubscriptionId: 'msub_1' }))
    expect(cheap.status).toBe('mismatch')
    expect(order(cheap.orderId!)).toMatchObject({ status: 'pending' })
    expect(credits()).toBe(monthly.credits * 2)
    expect(orders().map((o) => o.status)).toEqual(['paid', 'paid', 'pending'])
  })

  it('首付不带周期（Waffo）：先按付款时间推算，之后状态事件校正周期时当期积分的到期时间一起对齐；乱序的旧事件不改', async () => {
    const first = addOrder('monthly', monthly.priceCents, monthly.credits)
    await process(charge(first, 'pay_1', monthly.priceCents, { providerSubscriptionId: 'msub_1' }))
    const guessed = sub().current_period_end!
    expect(grants(first)[0]!.expires_at).toBe(guessed)

    const start = new Date(Date.parse(sub().current_period_start!) - 13 * HOUR).toISOString()
    const end = addMonths(start, 1)
    expect((await process(state(iso(HOUR), { status: 'active', periodStart: start, periodEnd: end }))).status).toBe('processed')
    expect(sub()).toMatchObject({ current_period_start: start, current_period_end: end })
    expect(grants(first)).toEqual([{ amount: monthly.credits, remaining: monthly.credits, expires_at: end }])

    expect((await process(state(iso(-HOUR), { periodStart: iso(), periodEnd: guessed }))).status).toBe('ignored')
    expect(grants(first)[0]!.expires_at).toBe(end)
  })

  it('续费成功把逾期的订阅恢复为 active 并清掉到期取消标记', async () => {
    const { first } = await startMonthly()
    await process(state(iso(DAY), { status: 'past_due' }))
    expect(sub().status).toBe('past_due')
    await process(charge(first, 'pay_2', monthly.priceCents, { providerSubscriptionId: 'msub_1' }))
    expect(sub()).toMatchObject({ status: 'active', cancel_at_period_end: 0 })
  })

  it('状态事件乱序：更早发生的事件不覆盖更晚的状态；终止后不再算有效订阅', async () => {
    await startMonthly()
    expect((await process(state(iso(2 * DAY), { cancelAtPeriodEnd: true }))).status).toBe('processed')
    const stale = await process(state(iso(DAY), { cancelAtPeriodEnd: false, status: 'past_due' }))
    expect(stale).toMatchObject({ status: 'ignored', note: 'stale subscription event' })
    expect(sub()).toMatchObject({ status: 'active', cancel_at_period_end: 1 })
    expect(await liveSubscription(env.DB, 'u1')).not.toBeNull()
    // 到期取消且当期已结束（终止事件丢了）也不再算有效订阅，用户可以重新订阅
    expect(await liveSubscription(env.DB, 'u1', iso(31 * DAY))).toBeNull()

    await process(state(iso(3 * DAY), { status: 'canceled' }))
    expect(sub()).toMatchObject({ status: 'canceled', next_grant_at: null })
    expect(sub().ended_at).not.toBeNull()
    expect(await liveSubscription(env.DB, 'u1')).toBeNull()
    // 不认识的订阅（首付还没到）忽略
    expect((await process(state(iso(4 * DAY), { status: 'active' }, 'msub_unknown'))).status).toBe('ignored')
  })

  it('年付：首付只发第一个月；Cron 停了几天时一次补齐，已过期的月份跳过；重复执行不重复发', async () => {
    const first = addOrder('yearly', yearly.priceCents, yearly.credits)
    const start = iso(-65 * DAY)
    const end = addMonths(start, 12)
    await process(charge(first, 'pay_y1', yearly.priceCents, { providerSubscriptionId: 'msub_1', periodStart: start, periodEnd: end }))
    expect(sub()).toMatchObject({ interval: 'year', grants_done: 1, next_grant_at: addMonths(start, 1) })
    expect(grants(first)[0]!.expires_at).toBe(addMonths(start, 1))

    // 第 2 个月（start+1 月 ~ start+2 月）已经整月过去，跳过；第 3 个月补发
    expect(await grantDueSubscriptions(env)).toEqual({ checked: 1, granted: 1 })
    expect(sub()).toMatchObject({ grants_done: 3, next_grant_at: addMonths(start, 3) })
    expect(grants(first).map((g) => g.expires_at)).toEqual([addMonths(start, 1), addMonths(start, 3)])
    expect(order(first).credits).toBe(yearly.credits * 2)
    expect(await grantDueSubscriptions(env)).toEqual({ checked: 0, granted: 0 })

    // 到了下个月再发一次
    const nextMonth = Date.parse(addMonths(start, 3)) + 1000
    expect(await grantDueSubscriptions(env, { now: nextMonth })).toEqual({ checked: 1, granted: 1 })
    expect(order(first).credits).toBe(yearly.credits * 3)
  })

  it('年付退款：按已发放的积分比例回收、只扣这张订单的订阅批次（不碰另买的积分包），退款后停止补发', async () => {
    const first = addOrder('yearly', yearly.priceCents, yearly.credits)
    const start = iso(-35 * DAY)
    await process(charge(first, 'pay_y1', yearly.priceCents, { providerSubscriptionId: 'msub_1', periodStart: start, periodEnd: addMonths(start, 12) }))
    await grantDueSubscriptions(env)
    expect(order(first).credits).toBe(yearly.credits * 2)
    const pack = addOrder('starter', 990, 20)
    await process(charge(pack, 'pay_pack', 990, null))
    // 第一个月的批次已过期作废（余额里还在，等过期清理），这里模拟用户已用掉第二个月的一部分
    sqlite.exec(`UPDATE credit_grants SET remaining = 0 WHERE ref_id = '${first}' AND expires_at < '${iso()}'`)
    sqlite.exec(`UPDATE credit_grants SET remaining = 15 WHERE ref_id = '${first}' AND expires_at > '${iso()}'`)
    sqlite.exec(`UPDATE users SET credits = 35 WHERE id = 'u1'`)

    expect(await refundOrder(env.DB, order(first), { refundKey: 'rf_1', amountCents: null, note: 'refund' })).toBe(true)
    expect(order(first)).toMatchObject({ status: 'refunded', refunded_credits: yearly.credits * 2 })
    expect(credits()).toBe(20)
    expect(grants(pack)).toEqual([{ amount: 20, remaining: 20, expires_at: null }])

    // 当期订单已退款：到点不再补发，并清掉补发计划
    expect(await grantDueSubscriptions(env, { now: Date.parse(addMonths(start, 2)) + 1000 })).toEqual({ checked: 1, granted: 0 })
    expect(sub().next_grant_at).toBeNull()
  })

  it('到期取消且当期已结束（终止 webhook 丢失）：新订时自动把旧订阅置为 expired 再入账', async () => {
    const oldOrder = addOrder('monthly', monthly.priceCents, monthly.credits)
    const pastStart = iso(-35 * DAY)
    const pastEnd = iso(-5 * DAY)
    await process(charge(oldOrder, 'pay_old', monthly.priceCents, { providerSubscriptionId: 'msub_old', periodStart: pastStart, periodEnd: pastEnd }))
    sqlite.exec(`UPDATE subscriptions SET cancel_at_period_end = 1 WHERE provider_subscription_id = 'msub_old'`)

    const nextOrder = addOrder('monthly', monthly.priceCents, monthly.credits)
    const result = await process(
      charge(nextOrder, 'pay_new', monthly.priceCents, { providerSubscriptionId: 'msub_new', periodStart: iso(), periodEnd: iso(30 * DAY) }),
    )
    expect(result).toEqual({ status: 'processed', orderId: nextOrder })
    expect(sqlite.prepare(`SELECT status FROM subscriptions WHERE provider_subscription_id = 'msub_old'`).get()).toEqual({ status: 'expired' })
    expect(sqlite.prepare(`SELECT status FROM subscriptions WHERE provider_subscription_id = 'msub_new'`).get()).toEqual({ status: 'active' })
    expect(credits()).toBe(monthly.credits * 2)
  })

  it('并发双开同一用户第二笔活跃订阅命中唯一约束：返回 mismatch、保留交易号且不重复发积分', async () => {
    await startMonthly()
    const second = addOrder('monthly', monthly.priceCents, monthly.credits)
    const dup = await process(
      charge(second, 'pay_concurrent', monthly.priceCents, { providerSubscriptionId: 'msub_2', periodStart: iso(), periodEnd: iso(30 * DAY) }),
    )
    expect(dup).toEqual({ status: 'mismatch', orderId: second, note: 'duplicate live subscription for user' })
    expect(order(second)).toMatchObject({ status: 'pending', provider_payment_id: 'pay_concurrent', provider_order_id: 'msub_2' })
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = 'u1' AND status IN ('active', 'past_due')`).get()).toEqual({ n: 1 })
    expect(credits()).toBe(monthly.credits)
  })
})
