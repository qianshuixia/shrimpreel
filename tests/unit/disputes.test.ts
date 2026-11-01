import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { site } from '#/config/site'
import { ledgerStatements } from '#/server/credits'
import { processPaymentEvent } from '#/server/orders'
import { normalizeDodoEvent } from '#/server/payments/dodo'
import { expandStripeEvent, normalizeStripeEvent } from '#/server/payments/stripe'
import type { DisputeEvent, DisputeStage, PaymentEvent, RefundRequest } from '#/server/payments/types'
import type { OrderRow } from '#/server/types'
import { d1Shim, kvShim, migrate } from './d1-sqlite'

const notified = vi.hoisted(() => ({ disputes: [] as Array<Record<string, unknown>> }))
const refunds = vi.hoisted(() => ({ calls: [] as unknown[], fail: null as null | { status: number; message: string } }))
vi.mock('#/server/notifications', () => ({
  notifyOrderPaid: async () => {},
  notifyDispute: async (_env: unknown, input: Record<string, unknown>) => {
    notified.disputes.push(input)
  },
}))
vi.mock('#/server/payments', async () => {
  const { ApiError } = await import('#/server/util')
  return {
    getOrderProvider: (_env: unknown, id: string) =>
      id === 'mock'
        ? {
            id: 'mock',
            async refund(input: RefundRequest) {
              refunds.calls.push(input)
              if (refunds.fail) throw new ApiError(refunds.fail.status, 'payment_provider_conflict', refunds.fail.message)
              return { refundId: 're_1', status: 'pending' }
            },
          }
        : null,
  }
})

describe('争议事件归一化', () => {
  it('Stripe：created = opened；closed 按 status 映射；payment_intent 为空时由 expandStripeEvent 经 Charge 补上', async () => {
    const dispute = { id: 'dp_1', charge: 'ch_1', payment_intent: 'pi_1', amount: 990, currency: 'usd', reason: 'fraudulent', status: 'needs_response' }
    expect(normalizeStripeEvent({ id: 'evt_1', type: 'charge.dispute.created', data: { object: dispute } })).toEqual({
      kind: 'disputed',
      eventId: 'evt_1',
      eventType: 'charge.dispute.created',
      orderId: null,
      providerPaymentId: 'pi_1',
      disputeId: 'dp_1',
      stage: 'opened',
      amountCents: 990,
      reason: 'fraudulent',
    })
    const closed = (status: string) => normalizeStripeEvent({ id: 'evt_2', type: 'charge.dispute.closed', data: { object: { ...dispute, status } } })
    expect(closed('won')).toMatchObject({ kind: 'disputed', stage: 'won' })
    expect(closed('lost')).toMatchObject({ stage: 'lost' })
    expect(closed('warning_closed')).toMatchObject({ stage: 'closed' })
    expect(closed('prevented')).toMatchObject({ stage: 'closed' })
    expect(closed('under_review')).toMatchObject({ kind: 'ignored' })
    expect(normalizeStripeEvent({ id: 'evt_3', type: 'charge.dispute.updated', data: { object: dispute } })).toMatchObject({ kind: 'ignored' })

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'ch_1', payment_intent: 'pi_9' })))
    vi.stubGlobal('fetch', fetchMock)
    const expanded = await expandStripeEvent({ STRIPE_SECRET_KEY: 'sk_test_123' } as Env, {
      id: 'evt_1',
      type: 'charge.dispute.created',
      data: { object: { ...dispute, payment_intent: null } },
    })
    vi.unstubAllGlobals()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(normalizeStripeEvent(expanded)).toMatchObject({ providerPaymentId: 'pi_9' })
  })

  it('Stripe：欺诈预警按 payment_intent 关联；已不可操作（已退款或已拒付）的忽略', () => {
    const efw = { id: 'issfr_1', charge: 'ch_1', payment_intent: 'pi_1', actionable: true, fraud_type: 'misc' }
    expect(normalizeStripeEvent({ id: 'evt_4', type: 'radar.early_fraud_warning.created', data: { object: efw } })).toEqual({
      kind: 'fraud_warning',
      eventId: 'evt_4',
      eventType: 'radar.early_fraud_warning.created',
      orderId: null,
      providerPaymentId: 'pi_1',
    })
    expect(normalizeStripeEvent({ id: 'evt_5', type: 'radar.early_fraud_warning.created', data: { object: { ...efw, actionable: false } } })).toMatchObject({ kind: 'ignored' })
  })

  it('Dodo：dispute.* 按 payment_id 关联；accepted / expired 记败诉，cancelled 按关闭，challenged 忽略', () => {
    const dodo = (type: string) =>
      normalizeDodoEvent({
        __webhookId: `msg_${type}`,
        type,
        data: { dispute_id: 'dsp_1', payment_id: 'pay_1', amount: '9.90', dispute_stage: 'dispute', remarks: 'cardholder says fraud' },
      })
    expect(dodo('dispute.opened')).toEqual({
      kind: 'disputed',
      eventId: 'msg_dispute.opened',
      eventType: 'dispute.opened',
      orderId: null,
      providerPaymentId: 'pay_1',
      disputeId: 'dsp_1',
      stage: 'opened',
      amountCents: null,
      reason: 'cardholder says fraud',
    })
    const stages = Object.fromEntries(
      ['won', 'lost', 'accepted', 'expired', 'cancelled'].map((s) => [s, (dodo(`dispute.${s}`) as { stage: DisputeStage }).stage]),
    )
    expect(stages).toEqual({ won: 'won', lost: 'lost', accepted: 'lost', expired: 'lost', cancelled: 'closed' })
    expect(dodo('dispute.challenged')).toMatchObject({ kind: 'ignored' })
  })
})

describe('争议入账', () => {
  let sqlite: DatabaseSync
  let env: Env
  let seq = 0

  beforeEach(() => {
    notified.disputes.length = 0
    refunds.calls.length = 0
    refunds.fail = null
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    migrate(sqlite)
    env = { DB: d1Shim(sqlite), KV: kvShim() } as unknown as Env
    sqlite.prepare('INSERT INTO users (id, email, credits, status, created_at) VALUES (?, ?, 0, ?, ?)').run('u1', 'u1@example.com', 'active', new Date().toISOString())
  })

  const order = (id: string) => sqlite.prepare('SELECT * FROM orders WHERE id = ?').get(id) as unknown as OrderRow
  const balance = () => (sqlite.prepare(`SELECT credits FROM users WHERE id = 'u1'`).get() as { credits: number }).credits
  const ledger = () => sqlite.prepare(`SELECT reason, delta, idempotency_key FROM credit_ledger ORDER BY rowid`).all() as Array<{ reason: string; delta: number; idempotency_key: string }>
  // 不变量：users.credits = 批次剩余之和 = 流水之和（没有到期批次的前提下）
  function expectConsistent() {
    const grants = (sqlite.prepare(`SELECT COALESCE(SUM(remaining), 0) AS n FROM credit_grants WHERE user_id = 'u1'`).get() as { n: number }).n
    const flow = (sqlite.prepare(`SELECT COALESCE(SUM(delta), 0) AS n FROM credit_ledger WHERE user_id = 'u1'`).get() as { n: number }).n
    expect(balance()).toBe(grants)
    expect(balance()).toBe(flow)
  }
  const process = (event: PaymentEvent) => processPaymentEvent(env, 'mock', event, '{}')

  async function paidOrder(credits = 100, cents = 1000) {
    const id = `ord_${++seq}`
    sqlite
      .prepare(
        `INSERT INTO orders (id, user_id, provider, package_id, credits, amount_cents, currency, status, created_at, updated_at)
         VALUES (?, 'u1', 'mock', 'starter', ?, ?, 'USD', 'pending', ?, ?)`,
      )
      .run(id, credits, cents, new Date().toISOString(), new Date().toISOString())
    await process({
      kind: 'paid',
      eventId: `evt_paid_${id}`,
      eventType: 'mock.paid',
      orderId: id,
      providerOrderId: null,
      providerPaymentId: `pay_${id}`,
      paidAmount: (cents / 100).toFixed(2),
      paidCurrency: 'USD',
      paidAmountCents: cents,
    })
    return id
  }
  const spend = async (amount: number) => {
    await env.DB.batch(ledgerStatements(env.DB, { userId: 'u1', delta: -amount, reason: 'generation', idempotencyKey: `gen:${++seq}` }))
  }
  const dispute = (orderId: string, stage: DisputeStage, eventId: string, disputeId = 'dp_1'): DisputeEvent => ({
    kind: 'disputed',
    eventId,
    eventType: `mock.dispute_${stage}`,
    orderId,
    providerPaymentId: `pay_${orderId}`,
    disputeId,
    stage,
    amountCents: null,
    reason: 'fraudulent',
  })

  it('opened 回收剩余积分，重复投递（同事件、同争议的新事件）不重复回收', async () => {
    const id = await paidOrder()
    await spend(30)
    expect(await process(dispute(id, 'opened', 'e1'))).toMatchObject({ status: 'processed', credits: 70 })
    expect(order(id)).toMatchObject({ status: 'paid', dispute_id: 'dp_1', dispute_status: 'open', dispute_credits: 70, refunded_credits: 70 })
    expect(balance()).toBe(0)
    expect((await process(dispute(id, 'opened', 'e1'))).status).toBe('duplicate')
    expect((await process(dispute(id, 'opened', 'e2'))).status).toBe('duplicate')
    expect(ledger().filter((l) => l.reason === 'dispute')).toEqual([{ reason: 'dispute', delta: -70, idempotency_key: 'dispute:dp_1' }])
    expect(notified.disputes).toHaveLength(1)
    expectConsistent()
  })

  it('opened 期间的退款不会二次回收；找不到订单的争议忽略', async () => {
    const id = await paidOrder()
    await process(dispute(id, 'opened', 'e1'))
    await process({ kind: 'refunded', eventId: 'rf1', eventType: 'mock.refunded', orderId: id, providerPaymentId: `pay_${id}`, refundId: 'rf1', refundAmountCents: null, originalAmountCents: null })
    expect(order(id)).toMatchObject({ status: 'refunded', refunded_credits: 100 })
    expect(ledger().filter((l) => l.reason === 'order_refund')).toEqual([expect.objectContaining({ delta: 0 })])
    expectConsistent()
    const missing = await process({ ...dispute('nope', 'opened', 'e9'), providerPaymentId: 'pay_unknown' })
    expect(missing).toMatchObject({ status: 'ignored', note: 'order not found' })
  })

  it('won 原样补回回收的积分（只补一次），订单回到未退款状态', async () => {
    const id = await paidOrder()
    await spend(30)
    await process(dispute(id, 'opened', 'e1'))
    expect(await process(dispute(id, 'won', 'e2'))).toMatchObject({ status: 'processed', credits: 70 })
    expect(order(id)).toMatchObject({ status: 'paid', dispute_status: 'won', dispute_credits: 70, refunded_credits: 0 })
    expect(balance()).toBe(70)
    expect((await process(dispute(id, 'won', 'e3'))).status).toBe('duplicate')
    expect(ledger().filter((l) => l.reason === 'dispute_won')).toHaveLength(1)
    // closed（询单关闭）在 won 之后也是重复；败诉在胜诉之后忽略
    expect((await process(dispute(id, 'closed', 'e4'))).status).toBe('duplicate')
    expect((await process(dispute(id, 'lost', 'e5'))).status).toBe('ignored')
    expectConsistent()
  })

  it('closed（资金留在商户）同样补回；用户已花光时回收和补回都是 0', async () => {
    const id = await paidOrder()
    await process(dispute(id, 'opened', 'e1'))
    expect(await process(dispute(id, 'closed', 'e2'))).toMatchObject({ status: 'processed', credits: 100 })
    expect(balance()).toBe(100)

    const spent = await paidOrder(50, 500)
    await spend(150)
    expect(await process(dispute(spent, 'opened', 'f1', 'dp_2'))).toMatchObject({ credits: 0 })
    expect(order(spent)).toMatchObject({ dispute_credits: 0 })
    await process(dispute(spent, 'won', 'f2', 'dp_2'))
    expect(balance()).toBe(0)
    expectConsistent()
  })

  it('lost 订单记为全额退款，不二次回收；重放幂等', async () => {
    const id = await paidOrder()
    await spend(30)
    await process(dispute(id, 'opened', 'e1'))
    expect((await process(dispute(id, 'lost', 'e2'))).status).toBe('processed')
    expect(order(id)).toMatchObject({ status: 'refunded', dispute_status: 'lost', refunded_amount_cents: 1000, refunded_credits: 70, dispute_credits: 70 })
    expect(balance()).toBe(0)
    expect((await process(dispute(id, 'lost', 'e2'))).status).toBe('duplicate')
    expect((await process(dispute(id, 'lost', 'e6'))).status).toBe('duplicate')
    expect(ledger().filter((l) => l.reason === 'dispute')).toHaveLength(1)
    // 败诉后再有别的争议、胜诉事件：只留记录
    expect((await process(dispute(id, 'opened', 'e7', 'dp_other'))).status).toBe('ignored')
    expect((await process(dispute(id, 'won', 'e8'))).status).toBe('ignored')
    expectConsistent()
  })

  it('乱序：lost 先于 opened 到达时先回收再败诉；opened 随后到达是重复', async () => {
    const id = await paidOrder()
    await process(dispute(id, 'lost', 'e1'))
    expect(order(id)).toMatchObject({ status: 'refunded', dispute_status: 'lost', refunded_credits: 100, refunded_amount_cents: 1000 })
    expect(balance()).toBe(0)
    expect((await process(dispute(id, 'opened', 'e2'))).status).toBe('duplicate')
    expect(ledger().filter((l) => l.reason === 'dispute')).toHaveLength(1)
    expectConsistent()
  })

  it('开启期间已部分退款：胜诉不补回积分（钱已经退给买家）', async () => {
    const id = await paidOrder()
    await process({ kind: 'refunded', eventId: 'rf1', eventType: 'mock.refunded', orderId: id, providerPaymentId: `pay_${id}`, refundId: 'rf1', refundAmountCents: 500, originalAmountCents: null })
    expect(order(id)).toMatchObject({ status: 'paid', refunded_credits: 50 })
    await process(dispute(id, 'opened', 'e1'))
    expect(order(id)).toMatchObject({ dispute_credits: 50, refunded_credits: 100 })
    expect(await process(dispute(id, 'won', 'e2'))).toMatchObject({ status: 'processed', credits: 0 })
    expect(order(id)).toMatchObject({ dispute_status: 'won', refunded_credits: 100 })
    expect(balance()).toBe(0)
    expectConsistent()
  })

  it('另一个争议处理中：不重复回收，只留记录', async () => {
    const id = await paidOrder()
    await process(dispute(id, 'opened', 'e1'))
    expect(await process(dispute(id, 'opened', 'e2', 'dp_2'))).toMatchObject({ status: 'ignored' })
    expect(ledger().filter((l) => l.reason === 'dispute')).toHaveLength(1)
  })

  it('争议先于付款到达：抛错记为 failed，等支付商重试', async () => {
    const id = `ord_${++seq}`
    sqlite
      .prepare(
        `INSERT INTO orders (id, user_id, provider, package_id, credits, amount_cents, currency, status, created_at, updated_at)
         VALUES (?, 'u1', 'mock', 'starter', 100, 1000, 'USD', 'pending', ?, ?)`,
      )
      .run(id, new Date().toISOString(), new Date().toISOString())
    await expect(process(dispute(id, 'opened', 'e1'))).rejects.toThrow(/dispute before payment/)
    expect(sqlite.prepare(`SELECT status FROM payment_events WHERE event_id = 'e1'`).get()).toEqual({ status: 'failed' })
  })

  it('欺诈预警（开关默认关闭）：不退款、订单与余额不变，只通知管理员并写明未自动退款', async () => {
    const id = await paidOrder()
    const warning: Extract<PaymentEvent, { kind: 'fraud_warning' }> = { kind: 'fraud_warning', eventId: 'w0', eventType: 'mock.fraud_warning', orderId: id, providerPaymentId: `pay_${id}` }
    const result = await process(warning)
    expect(result).toMatchObject({ status: 'processed' })
    expect(result.note).toContain('未自动退款')
    expect(refunds.calls).toHaveLength(0)
    expect(order(id)).toMatchObject({ status: 'paid', refunded_amount_cents: 0 })
    expect(balance()).toBe(100)
    expect(notified.disputes.at(-1)).toMatchObject({ stage: 'fraud_warning', detail: result.note })
  })

  describe('fraudWarningAutoRefund 开启', () => {
    const autoRefund = site as { fraudWarningAutoRefund: boolean }
    beforeEach(() => {
      autoRefund.fraudWarningAutoRefund = true
    })
    afterEach(() => {
      autoRefund.fraudWarningAutoRefund = false
    })

    it('欺诈预警：对剩余金额提交全额退款，积分等退款回调；已有争议、退款被拒时只告警', async () => {
      const id = await paidOrder()
      const warning = (eventId: string): Extract<PaymentEvent, { kind: 'fraud_warning' }> => ({ kind: 'fraud_warning', eventId, eventType: 'mock.fraud_warning', orderId: id, providerPaymentId: `pay_${id}` })
      expect(await process(warning('w1'))).toMatchObject({ status: 'processed' })
      expect(refunds.calls).toEqual([expect.objectContaining({ orderId: id, amountCents: 1000, fullAmount: true, providerPaymentId: `pay_${id}` })])
      expect(balance()).toBe(100)
      expect(notified.disputes.at(-1)).toMatchObject({ stage: 'fraud_warning' })

      refunds.fail = { status: 409, message: 'Stripe refund: charge_already_refunded' }
      const second = await process(warning('w2'))
      expect(second).toMatchObject({ status: 'processed' })
      expect(second.note).toContain('自动退款失败')

      await process(dispute(id, 'opened', 'e1'))
      refunds.calls.length = 0
      expect(await process(warning('w3'))).toMatchObject({ status: 'ignored', note: 'dispute already open' })
      expect(refunds.calls).toHaveLength(0)

      // 网络类错误抛出，让支付商重试 webhook
      const other = await paidOrder()
      refunds.fail = { status: 502, message: 'boom' }
      await expect(process({ ...warning('w4'), orderId: other, providerPaymentId: `pay_${other}` })).rejects.toThrow('boom')
    })
  })
})

describe('争议提醒邮件', () => {
  it('管理员中文；支付商给的原因只进正文并转义，不进 Subject', async () => {
    const { renderEmail } = await import('#/server/email-templates')
    const mail = renderEmail(
      'admin_dispute',
      { orderId: 'ord_1', stage: 'opened', credits: 70, amount: '$9.90', reason: '<b>fraud</b>', detail: null },
      { siteUrl: 'https://example.test', locale: 'en' },
    )
    expect(mail.subject).toContain('收到支付争议')
    expect(mail.subject).not.toContain('fraud')
    expect(mail.text).toContain('已回收 70 积分')
    expect(mail.html).toContain('&lt;b&gt;fraud&lt;/b&gt;')
    expect(mail.text).toContain('https://example.test/admin/orders/ord_1')
  })
})
