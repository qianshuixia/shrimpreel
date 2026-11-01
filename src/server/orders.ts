import { findPlan, site } from '#/config/site'
import { alignSubscriptionGrantStatement, clawbackStatements, ledgerStatements } from './credits'
import { notifyDispute, notifyOrderPaid } from './notifications'
import { getOrderProvider } from './payments'
import { referralClawbackStatements, referralRewardStatements } from './referrals'
import { getSettings } from './settings'
import { addInterval, grantWindow, nextGrantAt } from './subscriptions'
import type { DisputeEvent, PaidEvent, PaymentEvent, PaymentProviderId, SubscriptionCharge, SubscriptionEvent } from './payments/types'
import type { OrderRow, SubscriptionRow } from './types'
import { ApiError, createId, isCheckConstraintError, isUniqueConstraintError, nowIso, parseJsonRecord, sha256Hex } from './util'

// orphan：paid 事件找不到本站订单；mismatch：paid 事件和订单的金额、币种或商品对不上，没有入账。
// 两者都返回 200（多个站可能共用一个商户号，返回 5xx 会让支付商对别站的事件无限重试），由健康检查告警后人工处理
export type FulfillmentResult = {
  status: 'processed' | 'duplicate' | 'ignored' | 'orphan' | 'mismatch'
  orderId: string | null
  note?: string
  credits?: number // 争议：本次回收（opened）或补回（won、closed）的积分
}
type EventStatus = 'processed' | 'ignored' | 'failed' | 'orphan' | 'mismatch'

// 处理归一化后的支付事件。幂等性两层保证：
// 1) payment_events(provider, event_id) 唯一：同一事件重放直接返回 duplicate
// 2) credit_ledger.idempotency_key：order:<id> / order_refund:<id>，即使事件 id 不同也不会重复加/扣积分
export async function processPaymentEvent(
  env: Env,
  provider: PaymentProviderId,
  event: PaymentEvent,
  rawPayload: string,
): Promise<FulfillmentResult> {
  const db = env.DB
  const seen = await db
    .prepare('SELECT status FROM payment_events WHERE provider = ? AND event_id = ?')
    .bind(provider, event.eventId)
    .first<{ status: string }>()
  if (seen && seen.status !== 'failed') return { status: 'duplicate', orderId: null }

  let result: FulfillmentResult
  try {
    result = await applyEvent(env, provider, event)
  } catch (error) {
    await recordEvent(db, provider, event, null, 'failed', error instanceof Error ? error.message : String(error), rawPayload)
    throw error
  }
  const status: EventStatus = result.status === 'duplicate' ? 'processed' : result.status
  await recordEvent(db, provider, event, result.orderId, status, result.note ?? null, rawPayload)
  if (result.status === 'processed' && result.orderId) {
    if (event.kind === 'paid') await notifyOrderPaid(env, result.orderId)
    else if (event.kind === 'disputed') {
      await notifyDispute(env, {
        orderId: result.orderId,
        stage: event.stage,
        key: event.disputeId,
        credits: result.credits ?? 0,
        amountCents: event.amountCents,
        reason: event.reason,
        detail: result.note ?? null,
      })
    } else if (event.kind === 'fraud_warning') {
      await notifyDispute(env, {
        orderId: result.orderId,
        stage: 'fraud_warning',
        key: event.providerPaymentId ?? event.eventId,
        credits: 0,
        amountCents: null,
        reason: null,
        detail: result.note ?? null,
      })
    }
  }
  return result
}

async function applyEvent(env: Env, provider: PaymentProviderId, event: PaymentEvent): Promise<FulfillmentResult> {
  const db = env.DB
  if (event.kind === 'ignored') return { status: 'ignored', orderId: null, note: 'unhandled event type' }
  if (event.kind === 'subscription') return applySubscriptionState(env, provider, event)
  if (event.kind === 'paid' && event.subscription) return applySubscriptionPayment(env, provider, event, event.subscription)

  const order = await findOrder(db, provider, event)
  if (!order) {
    // 退款、失败事件找不到订单不影响用户；付了款却找不到订单要人工核对。metadata 标明是别的站下的单就忽略
    if (event.kind !== 'paid') return { status: 'ignored', orderId: null, note: 'order not found' }
    if (event.site && event.site !== site.domain) return { status: 'ignored', orderId: null, note: `order of another site: ${event.site}` }
    return { status: 'orphan', orderId: null, note: 'order not found' }
  }

  if (event.kind === 'disputed') return applyDispute(env, order, event)
  if (event.kind === 'fraud_warning') return applyFraudWarning(env, order)

  if (event.kind === 'paid') {
    if (order.status === 'paid' || order.status === 'refunded') return { status: 'duplicate', orderId: order.id }
    const now = nowIso()
    // 订阅套餐的订单只能按订阅扣款入账（每月积分要带到期时间）；付款事件没带订阅信息说明支付商那边建的不是订阅商品
    const mismatch = findPlan(order.package_id)
      ? `plan ${order.package_id} paid without subscription`
      : checkPaidEvent(order, event, expectedProductId(env, provider, order.package_id))
    if (mismatch) {
      await markMismatch(db, order.id, event, now)
      return { status: 'mismatch', orderId: order.id, note: mismatch }
    }
    // 被邀请人的第一笔付款：同一个 batch 里给邀请人发奖励（见 referrals.ts）
    const referral = await referralRewardStatements(db, order, (await getSettings(env)).referralRewardCredits, now)
    const fulfill = [
      ...ledgerStatements(db, {
        userId: order.user_id,
        delta: order.credits,
        reason: 'purchase',
        refId: order.id,
        idempotencyKey: `order:${order.id}`,
      }),
      db
        .prepare(
          `UPDATE orders SET status = 'paid', paid_at = ?, updated_at = ?,
           provider_order_id = COALESCE(?, provider_order_id), provider_payment_id = COALESCE(?, provider_payment_id),
           paid_amount = ?, paid_currency = ?, paid_amount_cents = ? WHERE id = ?`,
        )
        .bind(
          now,
          now,
          event.providerOrderId,
          event.providerPaymentId,
          event.paidAmount,
          event.paidCurrency,
          event.paidAmountCents,
          order.id,
        ),
    ]
    try {
      await batchWithOptional(db, fulfill, referral)
    } catch (error) {
      if (isUniqueConstraintError(error)) return { status: 'duplicate', orderId: order.id }
      throw error
    }
    return { status: 'processed', orderId: order.id }
  }

  if (event.kind === 'refunded') {
    if (order.status !== 'paid' && order.status !== 'refunded') {
      // 金额/商品不符没有入账的付款，站长在支付商后台退款后结案：不动积分，只把订单标为已退款
      const unfulfilled = await db
        .prepare(`SELECT 1 FROM payment_events WHERE order_id = ? AND status = 'mismatch' LIMIT 1`)
        .bind(order.id)
        .first()
      if (unfulfilled) {
        const now = nowIso()
        await db
          .prepare(
            `UPDATE orders SET status = 'refunded', refunded_amount_cents = ?, refunded_at = ?, updated_at = ?
             WHERE id = ? AND status NOT IN ('paid', 'refunded')`,
          )
          .bind(event.refundAmountCents ?? event.originalAmountCents ?? 0, now, now, order.id)
          .run()
        return { status: 'processed', orderId: order.id, note: 'refund of unfulfilled mismatch payment' }
      }
      // 退款事件先于付款事件到达（付款回调失败重试中）：记为 failed 并返回 5xx，让支付商稍后重试，
      // 否则付款入账后这笔退款就不会再回收积分
      throw new Error(`refund before payment: order ${order.id} is ${order.status}`)
    }
    const refunded = await refundOrder(db, order, {
      refundKey: event.refundId ?? event.eventId,
      amountCents: event.refundAmountCents,
      originalAmountCents: event.originalAmountCents,
      note: 'provider refund',
    })
    return { status: refunded ? 'processed' : 'duplicate', orderId: order.id }
  }

  // failed：只把仍在 pending 的订单标记失败
  await db
    .prepare(`UPDATE orders SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'`)
    .bind(nowIso(), order.id)
    .run()
  return { status: 'processed', orderId: order.id }
}

// 争议（拒付）。积分：opened 时立即回收订单剩余未退的积分（幂等键 dispute:<争议号>，最多扣到 0），实际回收量记在
// dispute_credits 并计入 refunded_credits（之后的退款不会再回收同一批积分）；
// won / closed（资金留在商户）补回 dispute_credits（幂等键 dispute_won:<争议号>）并从 refunded_credits 减去；
// lost 订单记为全额退款，积分在 opened 时已回收，不再二次回收。
// 事件乱序：lost 先于 opened 到达时，在同一个 batch 里先回收再记为败诉；opened 晚于 won / lost 到达时当作重复。
async function applyDispute(env: Env, order: OrderRow, event: DisputeEvent): Promise<FulfillmentResult> {
  const db = env.DB
  if (order.status !== 'paid' && order.status !== 'refunded') {
    // 金额、商品不符没有入账的付款：积分本来就没发，不处理
    const unfulfilled = await db
      .prepare(`SELECT 1 FROM payment_events WHERE order_id = ? AND status = 'mismatch' LIMIT 1`)
      .bind(order.id)
      .first()
    if (unfulfilled) return { status: 'ignored', orderId: order.id, note: 'dispute of unfulfilled mismatch payment' }
    // 争议事件先于付款事件到达：同退款，记为 failed 返回 5xx，等支付商重试
    throw new Error(`dispute before payment: order ${order.id} is ${order.status}`)
  }
  const same = order.dispute_id === event.disputeId
  if (same && (event.stage === 'opened' || order.dispute_status === event.stage || (event.stage === 'closed' && order.dispute_status === 'won'))) {
    return { status: 'duplicate', orderId: order.id }
  }
  // 一张订单只跟踪一个争议：别的争议还在处理中，或订单已因败诉全额退款时，这个事件只留记录和告警
  if (!same && (order.dispute_status === 'open' || order.dispute_status === 'lost')) {
    return { status: 'ignored', orderId: order.id, note: `order has dispute ${order.dispute_id} (${order.dispute_status})` }
  }
  const now = nowIso()
  try {
    if (event.stage === 'opened') {
      await db.batch(disputeOpenStatements(db, order, event, now))
      return { status: 'processed', orderId: order.id, credits: await disputeCredits(db, event.disputeId) }
    }
    if (event.stage === 'lost') {
      if (same && order.dispute_status === 'won') return { status: 'ignored', orderId: order.id, note: 'dispute already won' }
      const referral = await referralClawbackStatements(db, order, now)
      await batchWithOptional(
        db,
        [
          ...(same ? [] : disputeOpenStatements(db, order, event, now)),
          // 订单记为全额退款；之前部分退过款的，退款金额补到实收
          db
            .prepare(
              `UPDATE orders SET status = 'refunded', refunded_amount_cents = COALESCE(paid_amount_cents, amount_cents),
               refunded_at = ?1, updated_at = ?1 WHERE id = ?2 AND status = 'paid'`,
            )
            .bind(now, order.id),
          db.prepare(`UPDATE orders SET dispute_status = 'lost', updated_at = ? WHERE id = ?`).bind(now, order.id),
        ],
        referral,
      )
      return { status: 'processed', orderId: order.id }
    }
    // won / closed：补回积分。只在订单仍是 paid 且没退过款时补（已退款的钱已经给了买家，不能再给积分）；
    // 订阅积分按期作废，补回的积分沿用原批次的到期时间，已过期就不补
    if (order.dispute_status === 'lost') return { status: 'ignored', orderId: order.id, note: 'dispute already lost' }
    let restore = same && order.dispute_status === 'open' && order.dispute_credits > 0 && order.status === 'paid' && order.refunded_amount_cents === 0 ? order.dispute_credits : 0
    let expiresAt: string | null = null
    if (restore > 0 && order.subscription_id) {
      expiresAt = await db
        .prepare(`SELECT MAX(expires_at) AS expires_at FROM credit_grants WHERE ref_id = ? AND source = 'subscription'`)
        .bind(order.id)
        .first<string>('expires_at')
      if (!expiresAt || expiresAt <= now) restore = 0
    }
    await db.batch([
      ...(restore > 0
        ? ledgerStatements(db, {
            userId: order.user_id,
            delta: restore,
            reason: 'dispute_won',
            refId: order.id,
            idempotencyKey: `dispute_won:${event.disputeId}`,
            note: `dispute ${event.stage} ${event.disputeId}`,
            expiresAt,
          })
        : []),
      // 没见过 opened 事件（丢失或乱序）时直接记下争议，没有积分可补
      db
        .prepare(
          `UPDATE orders SET refunded_credits = refunded_credits - ?1, dispute_id = ?2, dispute_status = 'won',
           disputed_at = COALESCE(disputed_at, ?3), updated_at = ?3
           WHERE id = ?4 AND (dispute_status IS NULL OR dispute_status != 'lost') AND (dispute_status != 'open' OR dispute_id = ?2 OR dispute_id IS NULL)`,
        )
        .bind(restore, event.disputeId, now, order.id),
      db.prepare('INSERT INTO credit_guard (ok) SELECT changes() = 1'),
      db.prepare('DELETE FROM credit_guard'),
    ])
    return { status: 'processed', orderId: order.id, credits: restore }
  } catch (error) {
    // 幂等键冲突：同一争议的积分变动已经落库（并发重复投递）
    if (isUniqueConstraintError(error) || isCheckConstraintError(error)) return { status: 'duplicate', orderId: order.id }
    throw error
  }
}

// 争议开启：回收订单剩余未退的积分，记下争议。没有可回收的积分（已退光）时只记争议
function disputeOpenStatements(db: D1Database, order: OrderRow, event: DisputeEvent, now: string): D1PreparedStatement[] {
  const key = `dispute:${event.disputeId}`
  const remaining = Math.max(0, order.credits - order.refunded_credits)
  const clawed = `COALESCE((SELECT -delta FROM credit_ledger WHERE idempotency_key = ?1), 0)`
  return [
    ...(remaining > 0
      ? clawbackStatements(db, {
          userId: order.user_id,
          maxAmount: remaining,
          reason: 'dispute',
          refId: order.id,
          idempotencyKey: key,
          preferRefId: order.id,
          // 订阅积分按期作废，只回收这张订单发的批次，不扣用户另买的积分包
          onlyPreferred: !!order.subscription_id,
          note: `dispute ${event.disputeId}`,
        })
      : []),
    db
      .prepare(
        `UPDATE orders SET dispute_id = ?2, dispute_status = 'open', disputed_at = ?3, dispute_credits = ${clawed},
         refunded_credits = refunded_credits + ${clawed}, updated_at = ?3 WHERE id = ?4`,
      )
      .bind(key, event.disputeId, now, order.id),
  ]
}

async function disputeCredits(db: D1Database, disputeId: string) {
  const delta = await db.prepare('SELECT delta FROM credit_ledger WHERE idempotency_key = ?').bind(`dispute:${disputeId}`).first<number>('delta')
  return delta ? -delta : 0
}

// 发卡行欺诈预警：还没有拒付，主动全额退剩余金额可以避免拒付（并且不计入拒付率）。
// 仅在 site.fraudWarningAutoRefund 开启时自动退款，关闭时只通知管理员。
// 只提交退款，积分等之后的退款 webhook 回收（同后台退款）；退不了（已退、已拒付、超出期限、没有 API）时只告警
async function applyFraudWarning(env: Env, order: OrderRow): Promise<FulfillmentResult> {
  if (order.status !== 'paid') return { status: 'ignored', orderId: order.id, note: `order is ${order.status}` }
  if (order.dispute_status === 'open') return { status: 'ignored', orderId: order.id, note: 'dispute already open' }
  const remaining = Math.max(0, (order.paid_amount_cents ?? order.amount_cents) - order.refunded_amount_cents)
  if (remaining <= 0) return { status: 'ignored', orderId: order.id, note: 'nothing left to refund' }
  // 站点开关关闭（默认）：不动钱，只在通知里提示管理员到后台核对后退款
  if (!site.fraudWarningAutoRefund) return { status: 'processed', orderId: order.id, note: '未自动退款，请到后台核对后退款' }
  const provider = getOrderProvider(env, order.provider)
  if (!provider?.refund) return { status: 'processed', orderId: order.id, note: '该支付商没有退款 API，请到支付商后台手动退款' }
  try {
    if (!order.provider_payment_id) throw new ApiError(409, 'missing_provider_payment')
    assertProviderRefundAllowed(order)
    const result = await provider.refund({
      orderId: order.id,
      packageId: order.package_id,
      providerPaymentId: order.provider_payment_id,
      amountCents: remaining,
      fullAmount: true,
      currency: order.paid_currency ?? order.currency,
      reason: 'early fraud warning',
    })
    return {
      status: 'processed',
      orderId: order.id,
      note: `已自动提交全额退款${result.refundId ? ` ${result.refundId}` : ''}（${result.status}），积分在退款回调到达后回收`,
    }
  } catch (error) {
    // 业务冲突不重试（重试也一样），原因写进告警；其他错误（网络、支付商 5xx）抛出，让支付商重试 webhook
    if (error instanceof ApiError && error.status === 409) {
      return { status: 'processed', orderId: order.id, note: `自动退款失败（${error.message}），请到支付商后台处理` }
    }
    throw error
  }
}

// 入账前核对 paid 事件和订单，返回不一致的原因，null 表示通过。只拦“买错商品”和“少付”：
// - 含税定价时实收 = 标价，不含税定价时实收 = 标价 + 税，所以同币种下实收（含税）不应低于标价；
// - 币种不同（Dodo Adaptive Currency 按买家本地货币收款）或用了折扣码时金额没法比，只核对商品
export function checkPaidEvent(
  order: Pick<OrderRow, 'package_id' | 'amount_cents' | 'currency'>,
  event: PaidEvent,
  expectedProductId: string | null,
): string | null {
  if (event.productId && expectedProductId && event.productId !== expectedProductId) {
    return `product ${event.productId} is not ${expectedProductId} (${order.package_id})`
  }
  if (event.packageId && event.packageId !== order.package_id) return `package ${event.packageId} is not ${order.package_id}`
  if (event.discounted || event.paidAmountCents === null || !event.paidCurrency) return null
  if (event.paidCurrency.toUpperCase() !== order.currency.toUpperCase()) return null
  if (event.paidAmountCents < order.amount_cents) {
    return `paid ${event.paidAmountCents} < price ${order.amount_cents} ${order.currency}`
  }
  return null
}

function providerProducts(env: Env, provider: PaymentProviderId) {
  return parseJsonRecord(provider === 'dodo' ? env.DODO_PRODUCTS : provider === 'waffo' ? env.WAFFO_PRODUCTS : provider === 'stripe' ? env.STRIPE_PRODUCTS : undefined)
}

function expectedProductId(env: Env, provider: PaymentProviderId, packageId: string) {
  return providerProducts(env, provider)[packageId] ?? null
}

// 不入账，订单保持原状态；记下支付商单号，方便后台按流水号搜到订单，核实后补单或退款
async function markMismatch(db: D1Database, orderId: string, event: PaidEvent, now: string) {
  await db
    .prepare(
      `UPDATE orders SET provider_order_id = COALESCE(?, provider_order_id),
       provider_payment_id = COALESCE(?, provider_payment_id), updated_at = ? WHERE id = ?`,
    )
    .bind(event.providerOrderId, event.providerPaymentId, now, orderId)
    .run()
}

function findSubscription(db: D1Database, provider: PaymentProviderId, providerSubscriptionId: string) {
  return db
    .prepare('SELECT * FROM subscriptions WHERE provider = ? AND provider_subscription_id = ?')
    .bind(provider, providerSubscriptionId)
    .first<SubscriptionRow>()
}

// 订阅扣款。首付：按 checkout 时的订单入账并建订阅；续费：每次扣款新建一张订单（订单号由支付号派生，重放不会重复建单），
// 金额按订阅锁定的价格核对。积分当期结束作废；年付首付先发第一个月，其余由 Cron 每月补发（subscriptions.ts）
async function applySubscriptionPayment(
  env: Env,
  provider: PaymentProviderId,
  event: PaidEvent,
  charge: SubscriptionCharge,
): Promise<FulfillmentResult> {
  const db = env.DB
  const sub = await findSubscription(db, provider, charge.providerSubscriptionId)
  if (event.providerPaymentId) {
    const paid = await db
      .prepare(`SELECT id FROM orders WHERE provider = ? AND provider_payment_id = ? AND status IN ('paid', 'refunded')`)
      .bind(provider, event.providerPaymentId)
      .first<{ id: string }>()
    if (paid) return { status: 'duplicate', orderId: paid.id }
  }
  return sub ? applySubscriptionRenewal(env, provider, event, charge, sub) : applySubscriptionStart(env, provider, event, charge)
}

async function applySubscriptionStart(
  env: Env,
  provider: PaymentProviderId,
  event: PaidEvent,
  charge: SubscriptionCharge,
): Promise<FulfillmentResult> {
  const db = env.DB
  const order = await findOrder(db, provider, event)
  if (!order) {
    if (event.site && event.site !== site.domain) return { status: 'ignored', orderId: null, note: `order of another site: ${event.site}` }
    return { status: 'orphan', orderId: null, note: 'subscription order not found' }
  }
  if (order.status === 'paid' || order.status === 'refunded') return { status: 'duplicate', orderId: order.id }
  const now = nowIso()
  const plan = findPlan(order.package_id)
  const mismatch = plan
    ? checkPaidEvent(order, event, expectedProductId(env, provider, order.package_id))
    : `package ${order.package_id} is not a subscription plan`
  if (mismatch || !plan) {
    await markMismatch(db, order.id, event, now)
    return { status: 'mismatch', orderId: order.id, note: mismatch ?? undefined }
  }
  const periodStart = charge.periodStart ?? now
  const period = {
    interval: plan.interval,
    current_period_start: periodStart,
    current_period_end: charge.periodEnd ?? addInterval(periodStart, plan.interval),
  }
  const subscriptionId = createId('sub')
  const referral = await referralRewardStatements(db, order, (await getSettings(env)).referralRewardCredits, now)
  const statements = [
    ...ledgerStatements(db, {
      userId: order.user_id,
      delta: order.credits,
      reason: 'subscription',
      refId: order.id,
      idempotencyKey: `order:${order.id}`,
      expiresAt: grantWindow(period, 0).expiresAt,
    }),
    db
      .prepare(
        `INSERT INTO subscriptions (id, user_id, provider, provider_subscription_id, provider_customer_id, plan_id, interval,
         credits_per_month, amount_cents, currency, status, cancel_at_period_end, current_period_start, current_period_end,
         current_order_id, grants_done, next_grant_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .bind(
        subscriptionId,
        order.user_id,
        provider,
        charge.providerSubscriptionId,
        charge.providerCustomerId ?? null,
        plan.id,
        plan.interval,
        order.credits,
        order.amount_cents,
        order.currency,
        period.current_period_start,
        period.current_period_end,
        order.id,
        nextGrantAt(period, 1),
        now,
        now,
      ),
    db
      .prepare(
        `UPDATE orders SET status = 'paid', paid_at = ?, updated_at = ?, subscription_id = ?,
         provider_order_id = COALESCE(?, provider_order_id), provider_payment_id = COALESCE(?, provider_payment_id),
         paid_amount = ?, paid_currency = ?, paid_amount_cents = ? WHERE id = ?`,
      )
      .bind(
        now,
        now,
        subscriptionId,
        event.providerOrderId,
        event.providerPaymentId,
        event.paidAmount,
        event.paidCurrency,
        event.paidAmountCents,
        order.id,
      ),
  ]
  try {
    await batchWithOptional(db, statements, referral)
  } catch (error) {
    if (isUniqueConstraintError(error)) return { status: 'duplicate', orderId: order.id }
    throw error
  }
  return { status: 'processed', orderId: order.id }
}

async function applySubscriptionRenewal(
  env: Env,
  provider: PaymentProviderId,
  event: PaidEvent,
  charge: SubscriptionCharge,
  sub: SubscriptionRow,
): Promise<FulfillmentResult> {
  const db = env.DB
  if (!event.providerPaymentId) return { status: 'mismatch', orderId: sub.current_order_id, note: 'subscription charge without payment id' }
  const now = nowIso()
  const orderId = `ord_${(await sha256Hex(`${provider}:${event.providerPaymentId}`)).slice(0, 24)}`
  const mismatch = checkPaidEvent(
    { package_id: sub.plan_id, amount_cents: sub.amount_cents, currency: sub.currency },
    event,
    expectedProductId(env, provider, sub.plan_id),
  )
  // 周期：支付商给了就用；没给（Waffo）时，若状态事件已先把订阅推进到新的一期就沿用，否则从付款时间起算一期
  const keepPeriod =
    !charge.periodStart && sub.current_period_start && sub.current_period_end && Date.parse(sub.current_period_end) > Date.now() + 86400_000
  const periodStart = charge.periodStart ?? (keepPeriod ? sub.current_period_start! : now)
  const period = {
    interval: sub.interval,
    current_period_start: periodStart,
    current_period_end: charge.periodEnd ?? (keepPeriod ? sub.current_period_end! : addInterval(periodStart, sub.interval)),
  }
  // 续费订单沿用当期订单的归因字段，按渠道统计的收入包含续费
  const insertOrder = (status: 'paid' | 'pending') =>
    db
      .prepare(
        `INSERT INTO orders (id, user_id, provider, package_id, credits, amount_cents, currency, status, provider_order_id,
         provider_payment_id, paid_amount, paid_currency, paid_amount_cents, subscription_id, source, medium, campaign, country,
         device, attribution, created_at, paid_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, o.source, o.medium, o.campaign, o.country,
         o.device, o.attribution, ?15, ?16, ?15
         FROM (SELECT 1) LEFT JOIN orders o ON o.id = ?17`,
      )
      .bind(
        orderId,
        sub.user_id,
        provider,
        sub.plan_id,
        sub.credits_per_month,
        sub.amount_cents,
        sub.currency,
        status,
        charge.providerSubscriptionId,
        event.providerPaymentId,
        event.paidAmount,
        event.paidCurrency,
        event.paidAmountCents,
        sub.id,
        now,
        status === 'paid' ? now : null,
        sub.current_order_id,
      )
  if (mismatch) {
    try {
      await insertOrder('pending').run()
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error
    }
    return { status: 'mismatch', orderId, note: mismatch }
  }
  try {
    await db.batch([
      insertOrder('paid'),
      ...ledgerStatements(db, {
        userId: sub.user_id,
        delta: sub.credits_per_month,
        reason: 'subscription',
        refId: orderId,
        idempotencyKey: `order:${orderId}`,
        expiresAt: grantWindow(period, 0).expiresAt,
      }),
      // 续费成功说明没有取消（或已在门户恢复）；逾期补扣成功回到 active，已终止的订阅只补积分不改状态
      db
        .prepare(
          `UPDATE subscriptions SET current_order_id = ?, current_period_start = ?, current_period_end = ?, grants_done = 1,
           next_grant_at = ?, provider_customer_id = COALESCE(?, provider_customer_id),
           status = CASE WHEN status IN ('active', 'past_due') THEN 'active' ELSE status END,
           cancel_at_period_end = CASE WHEN status IN ('active', 'past_due') THEN 0 ELSE cancel_at_period_end END,
           updated_at = ? WHERE id = ?`,
        )
        .bind(orderId, period.current_period_start, period.current_period_end, nextGrantAt(period, 1), charge.providerCustomerId ?? null, now, sub.id),
    ])
  } catch (error) {
    if (isUniqueConstraintError(error)) return { status: 'duplicate', orderId }
    throw error
  }
  return { status: 'processed', orderId }
}

// 订阅状态事件：只更新事件里给出的字段；事件时间早于已应用的状态时丢弃（webhook 可能乱序，本地取消也会推进 state_at）。
// 支付商发起的换套餐按新套餐更新每月积分和价格，下次续费按新价格核对
async function applySubscriptionState(env: Env, provider: PaymentProviderId, event: SubscriptionEvent): Promise<FulfillmentResult> {
  const db = env.DB
  const sub = await findSubscription(db, provider, event.providerSubscriptionId)
  if (!sub) {
    if (event.site && event.site !== site.domain) return { status: 'ignored', orderId: null, note: `subscription of another site: ${event.site}` }
    // 首付的付款事件还没到（或首付核对不符没建订阅）：状态以之后的扣款为准
    return { status: 'ignored', orderId: null, note: 'subscription not found' }
  }
  const occurredAt = event.occurredAt && !Number.isNaN(Date.parse(event.occurredAt)) ? new Date(event.occurredAt).toISOString() : null
  if (occurredAt && sub.state_at && occurredAt < sub.state_at) {
    return { status: 'ignored', orderId: sub.current_order_id, note: 'stale subscription event' }
  }
  const now = nowIso()
  const products = providerProducts(env, provider)
  const planId = event.planId ?? Object.keys(products).find((id) => event.productId && products[id] === event.productId) ?? null
  const plan = planId && planId !== sub.plan_id ? findPlan(planId) : undefined
  const next = {
    ...sub,
    status: event.status ?? sub.status,
    cancel_at_period_end: event.cancelAtPeriodEnd === null ? sub.cancel_at_period_end : event.cancelAtPeriodEnd ? 1 : 0,
    current_period_start: event.periodStart ?? sub.current_period_start,
    current_period_end: event.periodEnd ?? sub.current_period_end,
    provider_customer_id: event.providerCustomerId ?? sub.provider_customer_id,
    ...(plan ? { plan_id: plan.id, interval: plan.interval, credits_per_month: plan.credits, amount_cents: plan.priceCents, currency: plan.currency } : {}),
  }
  const ended = next.status === 'canceled' || next.status === 'expired'
  // 年付补发和当期积分的到期时间跟着周期走：同一期内的校正（付款时推算的周期与支付商相差几小时，
  // Waffo 的周期还只到日期）重算下次补发、对齐当期批次的到期时间；已经是新的一期（续费扣款还没到）先停发，等扣款入账时重新开始
  let nextGrant = sub.next_grant_at
  let align: D1PreparedStatement | null = null
  if (ended) nextGrant = null
  else if (
    (next.current_period_start !== sub.current_period_start || next.current_period_end !== sub.current_period_end) &&
    next.current_period_start &&
    next.current_period_end
  ) {
    const sameCycle = sub.current_period_start && Math.abs(Date.parse(next.current_period_start) - Date.parse(sub.current_period_start)) < 2 * 86400_000
    nextGrant = sameCycle ? nextGrantAt(next, sub.grants_done) : null
    if (sameCycle && sub.current_order_id && sub.grants_done > 0) {
      align = alignSubscriptionGrantStatement(db, {
        subscriptionId: sub.id,
        orderId: sub.current_order_id,
        periodStart: next.current_period_start,
        periodEnd: next.current_period_end,
        expiresAt: grantWindow(next, sub.grants_done - 1).expiresAt,
      })
    }
  }
  const update = db
    .prepare(
      `UPDATE subscriptions SET status = ?, cancel_at_period_end = ?, current_period_start = ?, current_period_end = ?,
       provider_customer_id = ?, plan_id = ?, interval = ?, credits_per_month = ?, amount_cents = ?, currency = ?,
       next_grant_at = ?, ended_at = ?, state_at = COALESCE(?, state_at), updated_at = ?
       WHERE id = ? AND (state_at IS NULL OR ? IS NULL OR state_at <= ?)`,
    )
    .bind(
      next.status,
      next.cancel_at_period_end,
      next.current_period_start,
      next.current_period_end,
      next.provider_customer_id,
      next.plan_id,
      next.interval,
      next.credits_per_month,
      next.amount_cents,
      next.currency,
      nextGrant,
      ended ? (sub.ended_at ?? now) : null,
      occurredAt,
      now,
      sub.id,
      occurredAt,
      occurredAt,
    )
  const [result] = await db.batch(align ? [update, align] : [update])
  if (!result!.meta.changes) return { status: 'ignored', orderId: sub.current_order_id, note: 'stale subscription event' }
  return { status: 'processed', orderId: sub.current_order_id }
}

export interface RefundInput {
  refundKey: string // 同一笔退款重试时不变（支付商 refund id）
  amountCents: number | null // null = 全额退剩余部分
  originalAmountCents?: number | null
  note: string
}

// 按退款金额占实收金额的比例回收积分（最多扣到 0），累计退满后订单置为 refunded，否则保持 paid。
// 返回 false 表示订单不可退或这笔退款已处理过。
export async function refundOrder(db: D1Database, order: OrderRow, refund: RefundInput) {
  const plan = planRefund(order, refund)
  if (!plan) return false
  const now = nowIso()
  const referral = await referralClawbackStatements(db, order, now)
  try {
    await batchWithOptional(db, [
      ...clawbackStatements(db, {
        userId: order.user_id,
        maxAmount: plan.credits,
        reason: 'order_refund',
        refId: order.id,
        idempotencyKey: `order_refund:${order.id}:${refund.refundKey}`,
        preferRefId: order.id,
        // 订阅积分按期作废，只回收这张订单发的批次，不扣用户另买的积分包
        onlyPreferred: !!order.subscription_id,
        note: plan.full ? refund.note : `${refund.note} (partial ${plan.amountCents}/${plan.paidCents})`,
      }),
      db
        .prepare(
          `UPDATE orders SET refunded_credits = refunded_credits + ?, refunded_amount_cents = refunded_amount_cents + ?,
           status = ?, refunded_at = ?, updated_at = ? WHERE id = ? AND status = 'paid'`,
        )
        .bind(plan.credits, plan.amountCents, plan.full ? 'refunded' : 'paid', now, now, order.id),
    ], referral)
  } catch (error) {
    if (isUniqueConstraintError(error)) return false
    throw error
  }
  return true
}

// 先带上可选语句（邀请奖励的发放或回收）执行；可选语句里的断言失败（并发下已被别的订单或退款处理）时去掉它们重试
async function batchWithOptional(db: D1Database, statements: D1PreparedStatement[], optional: D1PreparedStatement[]) {
  if (!optional.length) return db.batch(statements)
  try {
    return await db.batch([...statements, ...optional])
  } catch (error) {
    if (!isCheckConstraintError(error)) throw error
    return db.batch(statements)
  }
}

// 后台"仅记账"退款的幂等键（与退款 webhook 共用 order_refund:<orderId>:<key>）：
// - mock 订单没有退款单号，由当前已退金额派生：并发连点拿到同一个键不会重复扣，下一笔部分退款又能拿到新键
// - 真实支付商订单必须填支付商退款单号（Dodo refund_id / Waffo REF_ / Stripe re_），webhook 迟到时不会重复回收积分
// - Waffo 的 webhook 用 REF_ 退款单号；误填 TKT_ 工单号会和迟到的 webhook 各扣一次
export function localRefundKey(order: Pick<OrderRow, 'provider' | 'refunded_amount_cents'>, refundId: string | undefined, amountCents: number) {
  const id = refundId?.trim()
  if (order.provider === 'mock') return id || `admin:${order.refunded_amount_cents}:${amountCents}`
  if (!id) throw new ApiError(400, 'refund_id_required')
  if (order.provider === 'waffo' && !id.startsWith('REF_')) throw new ApiError(400, 'invalid_refund_id')
  if (order.provider === 'stripe' && !id.startsWith('re_')) throw new ApiError(400, 'invalid_refund_id')
  return id
}

// 支付商退款规则，超出后 API 直接拒绝；提前拦截给出明确错误码：
// - Waffo：支付后 14 天内，每笔支付只能有一次退款（可部分），第二次返回 409。已退过还要再退只能线下处理，再用"仅记账"补登
// - Dodo：支付后 30 天内，可多次部分退款（同一时间只能有一笔处理中）https://docs.dodopayments.com/features/transactions/refunds
// - Stripe：没有固定期限，可多次部分退款；从 Stripe 余额扣，余额不足时挂起为 pending，等 succeeded 的 webhook 再回收积分 https://docs.stripe.com/refunds
const REFUND_WINDOW_DAYS: Record<string, number> = { waffo: 14, dodo: 30 }
export function assertProviderRefundAllowed(order: Pick<OrderRow, 'provider' | 'refunded_amount_cents' | 'paid_at'>, now = Date.now()) {
  if (order.provider === 'waffo' && order.refunded_amount_cents > 0) throw new ApiError(409, 'waffo_refund_exists')
  const days = REFUND_WINDOW_DAYS[order.provider]
  if (days && order.paid_at && now - Date.parse(order.paid_at) > days * 86400_000) throw new ApiError(409, 'refund_window_expired')
}

type RefundableOrder = Pick<
  OrderRow,
  'status' | 'credits' | 'amount_cents' | 'paid_amount_cents' | 'refunded_amount_cents' | 'refunded_credits'
>

export function planRefund(order: RefundableOrder, refund: Pick<RefundInput, 'amountCents' | 'originalAmountCents'>) {
  if (order.status !== 'paid') return null
  const paidCents = refund.originalAmountCents || order.paid_amount_cents || order.amount_cents
  const remainingCredits = order.credits - order.refunded_credits
  const remainingCents = Math.max(0, paidCents - order.refunded_amount_cents)
  const full = refund.amountCents === null || refund.amountCents >= remainingCents || paidCents <= 0
  // 全额时退款金额封顶到剩余实收，避免净收入被记成负数
  if (full) return { full, paidCents, credits: remainingCredits, amountCents: remainingCents }
  const credits = Math.min(remainingCredits, Math.round((order.credits * refund.amountCents!) / paidCents))
  return { full, paidCents, credits, amountCents: refund.amountCents! }
}

async function findOrder(db: D1Database, provider: PaymentProviderId, event: Exclude<PaymentEvent, { kind: 'ignored' | 'subscription' }>) {
  // 订阅续费的退款事件里 orderId 仍是首单号（checkout 元数据跟着订阅走），先按支付号找到具体那一期的订单
  if ((event.kind === 'refunded' || event.kind === 'disputed' || event.kind === 'fraud_warning') && event.providerPaymentId) {
    const order = await db
      .prepare('SELECT * FROM orders WHERE provider = ? AND provider_payment_id = ?')
      .bind(provider, event.providerPaymentId)
      .first<OrderRow>()
    if (order) return order
  }
  if (event.orderId) {
    const order = await db
      .prepare('SELECT * FROM orders WHERE id = ? AND provider = ?')
      .bind(event.orderId, provider)
      .first<OrderRow>()
    if (order) return order
  }
  if ('providerPaymentId' in event && event.providerPaymentId) {
    const order = await db
      .prepare('SELECT * FROM orders WHERE provider = ? AND provider_payment_id = ?')
      .bind(provider, event.providerPaymentId)
      .first<OrderRow>()
    if (order) return order
  }
  if (event.kind === 'paid' && event.providerOrderId) {
    return db
      .prepare('SELECT * FROM orders WHERE provider = ? AND (provider_session_id = ? OR provider_order_id = ?)')
      .bind(provider, event.providerOrderId, event.providerOrderId)
      .first<OrderRow>()
  }
  return null
}

async function recordEvent(
  db: D1Database,
  provider: PaymentProviderId,
  event: PaymentEvent,
  orderId: string | null,
  status: EventStatus,
  error: string | null,
  payload: string,
) {
  await db
    .prepare(
      `INSERT INTO payment_events (id, provider, event_id, event_type, order_id, status, error, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider, event_id) DO UPDATE SET status = excluded.status, error = excluded.error, order_id = excluded.order_id`,
    )
    .bind(createId('pev'), provider, event.eventId, event.eventType, orderId, status, error, payload.slice(0, 20000), nowIso())
    .run()
}
