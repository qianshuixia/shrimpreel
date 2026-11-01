import { formatPrice, site } from '#/config/site'
import { adminEmails } from './auth'
import { postChatMessage } from './chat-notify'
import { runEmailMaintenance, sendEmails, type OutgoingEmail } from './email'
import { outputExpiresAt } from './retention'
import type { GenerationRow, OrderRow, TakedownRow, UserRow } from './types'

// 业务事件 → 邮件。每封邮件的 dedupe_key 由事件和收件人决定，重复调用（队列重投、webhook 重放、Cron 重叠）只发一次。
// 这里的函数都不抛错：通知失败只记日志，不影响调用方的主流程。

// 举报截止前多久提醒管理员
export const REMIND_BEFORE_HOURS = 12
// 这些失败不发“生成失败”邮件：被下架的另有 content_removed；入队失败时接口直接报错，用户当场可见
const SILENT_FAILURES = new Set(['content_removed', 'enqueue_failed'])

type Recipient = Pick<UserRow, 'id' | 'email' | 'locale'>

async function safely(label: string, run: () => Promise<unknown>) {
  try {
    await run()
  } catch (error) {
    console.error(`notify ${label} failed`, error)
  }
}

// 已注销、封禁的用户不发
async function activeUser(env: Env, userId: string) {
  return env.DB.prepare(`SELECT id, email, locale FROM users WHERE id = ? AND status = 'active'`).bind(userId).first<Recipient>()
}

// 每个管理员一封（固定中文），key 加上收件人
export function adminAlerts(env: Env, key: string, build: (to: string) => Omit<OutgoingEmail, 'key' | 'to'>) {
  return adminEmails(env).map((to) => ({ ...build(to), key: `${key}:${to}`, to, locale: 'zh' }) as OutgoingEmail)
}

export function notifyGenerationFinished(env: Env, generationId: string) {
  return safely('generation', async () => {
    const generation = await env.DB.prepare('SELECT * FROM generations WHERE id = ?').bind(generationId).first<GenerationRow>()
    if (!generation) return
    const user = await activeUser(env, generation.user_id)
    if (!user) return
    if (generation.status === 'succeeded') {
      await sendEmails(env, [
        {
          key: `generation_succeeded:${generation.id}`,
          template: 'generation_succeeded',
          to: user.email,
          userId: user.id,
          locale: user.locale,
          params: { generationId: generation.id, expiresAt: outputExpiresAt(generation.completed_at) },
        },
      ])
    } else if (generation.status === 'failed' && generation.refunded && !SILENT_FAILURES.has(generation.error_code ?? '')) {
      await sendEmails(env, [
        {
          key: `generation_failed:${generation.id}`,
          template: 'generation_failed',
          to: user.email,
          userId: user.id,
          locale: user.locale,
          params: { generationId: generation.id, credits: generation.credits_cost },
        },
      ])
    }
  })
}

// 付款即时通知的消息（发给站长，固定中文）
export function paidChatText(order: OrderRow) {
  const amount = formatPrice(order.paid_amount_cents ?? order.amount_cents, order.paid_currency ?? order.currency)
  return [
    `【${site.brandName}】新付款 ${amount}`,
    `${order.subscription_id ? '订阅' : '积分包'} ${order.package_id} · ${order.credits} 积分`,
    `来源 ${order.source ?? 'direct'}${order.country ? ` · ${order.country}` : ''}`,
    `订单 ${order.id}`,
  ].join('\n')
}

// 只在订单首次入账时调用（processPaymentEvent 返回 processed、后台补单），重放的 webhook 不会重复通知
export function notifyOrderPaid(env: Env, orderId: string) {
  return safely('order', async () => {
    const order = await env.DB.prepare(`SELECT * FROM orders WHERE id = ? AND status = 'paid'`).bind(orderId).first<OrderRow>()
    if (!order) return
    const webhook = env.PAYMENT_NOTIFY_WEBHOOK_URL
    if (webhook) await safely('order chat', () => postChatMessage(webhook, paidChatText(order)))
    const user = await activeUser(env, order.user_id)
    if (!user) return
    await sendEmails(env, [
      {
        key: `order_paid:${order.id}`,
        template: 'order_paid',
        to: user.email,
        userId: user.id,
        locale: user.locale,
        params: {
          orderId: order.id,
          credits: order.credits,
          amount: formatPrice(order.paid_amount_cents ?? order.amount_cents, order.paid_currency ?? order.currency),
        },
      },
    ])
  })
}

const DISPUTE_TITLE = { opened: '收到争议', won: '争议胜诉', lost: '争议败诉', closed: '争议关闭', fraud_warning: '欺诈预警' } as const

// 支付争议（拒付）和欺诈预警：只通知管理员（邮件 + 聊天群），同一争议同一阶段只发一次。
// 只在事件首次处理成功时调用，重放的 webhook 不会重复通知
export function notifyDispute(
  env: Env,
  input: {
    orderId: string
    stage: 'opened' | 'won' | 'lost' | 'closed' | 'fraud_warning'
    key: string // 争议编号，没有时用支付编号
    credits: number
    amountCents: number | null
    reason: string | null
    detail: string | null
  },
) {
  return safely('dispute', async () => {
    const order = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(input.orderId).first<OrderRow>()
    if (!order) return
    const currency = order.paid_currency ?? order.currency
    const amount = formatPrice(input.amountCents ?? order.paid_amount_cents ?? order.amount_cents, currency)
    const webhook = env.PAYMENT_NOTIFY_WEBHOOK_URL
    if (webhook) {
      const text = [`【${site.brandName}】${DISPUTE_TITLE[input.stage]} ${amount}`, `订单 ${order.id} · 回收/补回 ${input.credits} 积分`, input.reason ?? '', input.detail ?? '']
      await safely('dispute chat', () => postChatMessage(webhook, text.filter(Boolean).join('\n')))
    }
    await sendEmails(
      env,
      adminAlerts(env, `admin_dispute:${input.stage}:${input.key}`, () => ({
        template: 'admin_dispute',
        params: { orderId: order.id, stage: input.stage, credits: input.credits, amount, reason: input.reason, detail: input.detail },
      })),
    )
  })
}

type NewTakedown =Pick<TakedownRow, 'id' | 'reporter_email' | 'reporter_user_id' | 'locale' | 'reason' | 'generation_id' | 'due_at'> & {
  receipt: boolean
}

// 举报人收回执（receipt 为 true 时），管理员收“新举报”
export function notifyTakedownCreated(env: Env, report: NewTakedown) {
  return safely('takedown created', () =>
    sendEmails(env, [
      ...(report.receipt
        ? [
            {
              key: `takedown_received:${report.id}`,
              template: 'takedown_received' as const,
              to: report.reporter_email,
              userId: report.reporter_user_id,
              locale: report.locale,
              params: { reportId: report.id, dueAt: report.due_at },
            },
          ]
        : []),
      ...adminAlerts(env, `admin_takedown:${report.id}:new`, () => ({
        template: 'admin_takedown',
        params: { reportId: report.id, stage: 'new', reason: report.reason, generationId: report.generation_id, dueAt: report.due_at },
      })),
    ]),
  )
}

// 处理结果通知举报人；删除时通知被删视频的作者（作者就是举报人时只发处理结果）
export function notifyTakedownResolved(
  env: Env,
  report: Pick<TakedownRow, 'id' | 'reporter_email' | 'reporter_user_id' | 'locale'>,
  outcome: 'removed' | 'rejected',
  owners: Array<{ userId: string; videos: number }> = [],
) {
  return safely('takedown resolved', async () => {
    const emails: OutgoingEmail[] = [
      {
        key: `takedown_resolved:${report.id}`,
        template: 'takedown_resolved',
        to: report.reporter_email,
        userId: report.reporter_user_id,
        locale: report.locale,
        params: { reportId: report.id, outcome },
      },
    ]
    for (const owner of owners) {
      if (owner.userId === report.reporter_user_id) continue
      const user = await activeUser(env, owner.userId)
      if (!user) continue
      emails.push({
        key: `content_removed:${report.id}:${user.id}`,
        template: 'content_removed',
        to: user.email,
        userId: user.id,
        locale: user.locale,
        params: { reportId: report.id, videos: owner.videos },
      })
    }
    await sendEmails(env, emails)
  })
}

// 新留言提醒管理员；不给留言人发自动回复（表单可填任意邮箱，避免被用来向第三方发信）
export function notifyContactMessage(env: Env, message: { id: string; email: string; topic: string; message: string }) {
  return safely('contact', () =>
    sendEmails(
      env,
      adminAlerts(env, `admin_contact:${message.id}`, () => ({
        template: 'admin_contact',
        params: { messageId: message.id, topic: message.topic, email: message.email, message: message.message },
      })),
    ),
  )
}

// 未处理的举报：截止前 REMIND_BEFORE_HOURS 小时提醒一次（stage 1），超时再提醒一次（stage 2）。
// 停机后才跑到时直接发最新阶段；邮件写入失败则不推进 stage，下次 Cron 重试
export async function runTakedownReminders(env: Env, options: { now?: number; takedownId?: string } = {}) {
  const now = options.now ?? Date.now()
  const rows = await env.DB.prepare(
    `SELECT * FROM takedown_requests WHERE status = 'open' AND reminder_stage < 2 AND due_at <= ?
     ${options.takedownId ? 'AND id = ?' : ''} ORDER BY due_at LIMIT 50`,
  )
    .bind(new Date(now + REMIND_BEFORE_HOURS * 3600_000).toISOString(), ...(options.takedownId ? [options.takedownId] : []))
    .all<TakedownRow>()
  let reminded = 0
  for (const report of rows.results) {
    const stage = Date.parse(report.due_at) <= now ? 2 : 1
    if (stage <= report.reminder_stage) continue
    const stageName = stage === 2 ? 'overdue' : 'due_soon'
    const ok = await sendEmails(
      env,
      adminAlerts(env, `admin_takedown:${report.id}:${stageName}`, () => ({
        template: 'admin_takedown',
        params: { reportId: report.id, stage: stageName, reason: report.reason, generationId: report.generation_id, dueAt: report.due_at },
      })),
    )
    if (!ok) continue
    await env.DB.prepare('UPDATE takedown_requests SET reminder_stage = ? WHERE id = ? AND reminder_stage < ?')
      .bind(stage, report.id, stage)
      .run()
    reminded++
  }
  return { reminded }
}

// Cron（每 5 分钟）：举报提醒 + 邮件补发与清理
export async function runNotificationCron(env: Env) {
  await safely('takedown reminders', () => runTakedownReminders(env))
  const result = await runEmailMaintenance(env)
  if (result.retried) console.log('email retry', result)
}
