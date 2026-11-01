import { postChatMessage } from './chat-notify'
import { sendEmails } from './email'
import { alertChatText, type TemplateParams } from './email-templates'
import { adminAlerts } from './notifications'
import { fetchVideoBalance, type VideoBalance } from './video-balance'

// 健康检查（Cron 每 5 分钟）：统计最近一段时间的异常，超过阈值就给 ADMIN_EMAILS 发告警邮件，同时写 console.error。
// 同一类告警在同一个时间桶（ALERT_BUCKET_HOURS）里只发一次：dedupe_key 带桶号，由发件箱唯一约束保证，
// Cron 重叠执行也不会重发；问题持续存在时下一个时间桶再提醒。发信本身出问题时，以 Workers 日志里的 [alert] 为准。
// 配置了 PAYMENT_NOTIFY_WEBHOOK_URL 时，每条告警同时发到聊天群（同一 kind 同一时间桶只发一次，用 KV 去重）。

export const ALERT_BUCKET_HOURS = 6

// 不计入生成失败率的错误码：管理员手动判失败、举报下架、成片被输出审核拦下都不是系统问题
const EXCLUDED_FAILURES = ['admin_failed', 'content_removed', 'output_moderation_rejected']

// 视频服务商账户问题（没配密钥、密钥失效、余额或月度额度不足）：重试没用，要站长去服务商后台处理。
// 任务已失败退积分，但之后的任务会一直失败，所以出现 1 个就告警，不等失败率
export const PROVIDER_ACCOUNT_ERRORS = ['provider_not_configured', 'YIR_UNAUTHORIZED', 'YIR_INSUFFICIENT_BALANCE', 'YIR_SPEND_LIMIT_EXCEEDED', 'nanoapi_invalid_api_key', 'nanoapi_insufficient_balance', 'nanoapi_account_suspended']

export const ALERT_RULES = {
  // 最近 1 小时完成的任务里失败 ≥ 3 个且占比 ≥ 30%（零星失败、大流量下的个别失败不报）
  generation_failures: { windowMinutes: 60, min: 3, minRate: 0.3 },
  // 最近 1 小时有任务因队列消息重试耗尽被判失败（error_code = dead_letter）
  dead_letter: { windowMinutes: 60, min: 1 },
  // 最近 1 小时有任务因服务商账户问题失败（PROVIDER_ACCOUNT_ERRORS）
  provider_account: { windowMinutes: 60, min: 1 },
  // 视频服务商余额低于 lowUsd（美元）：Cron 每小时查一次余额（UTC 整点那次），不等任务失败。后台“测试连接”也用这个阈值提示
  provider_balance: { windowMinutes: 60, lowUsd: 10 },
  // 创建超过 30 分钟仍未完成（jobs.ts 45 分钟时判超时退款）
  job_backlog: { windowMinutes: 30, min: 1 },
  // 最近 24 小时有处理失败、且之后没有重放成功的支付回调：用户可能付了款没到账
  payment_webhook: { windowMinutes: 24 * 60, min: 1 },
  // 最近 24 小时有付了款但没入账的回调：找不到订单（orphan），或金额、币种、商品和订单对不上（mismatch，订单补单或退款后不再计入）
  payment_review: { windowMinutes: 24 * 60, min: 1 },
  // 最近 6 小时创建的邮件（不含告警邮件）里最终失败、或重试 ≥ 3 次仍未发出的 ≥ 3 封（完整重试约 3.3 小时）
  email_failures: { windowMinutes: 6 * 60, min: 3 },
  // D1 每日备份当天连续失败 3 次（src/server/backup.ts 直接发，不经 evaluateHealth）
  backup_failed: { windowMinutes: 24 * 60, min: 3 },
} as const

const EMAIL_STUCK_ATTEMPTS = 3

export type AlertKind = keyof typeof ALERT_RULES
export type Alert = TemplateParams['admin_alert']

export interface HealthStats {
  generations: { finished: number; failed: number; topErrors: string | null }
  deadLetters: number
  providerAccount: { count: number; detail: string | null }
  backlog: number
  webhookFailures: { count: number; latest: string | null }
  paymentReview: { count: number; latest: string | null }
  emailFailures: number
  // 视频服务商余额；本次没查（每小时一次）、mock 或查不到时为 null
  providerBalance: VideoBalance | null
}

export function evaluateHealth(stats: HealthStats): Alert[] {
  const alert = (kind: AlertKind, count: number, extra: Partial<Alert> = {}): Alert => ({
    kind,
    count,
    total: null,
    windowMinutes: ALERT_RULES[kind].windowMinutes,
    detail: null,
    ...extra,
  })
  const alerts: Alert[] = []
  const { finished, failed, topErrors } = stats.generations
  const rate = ALERT_RULES.generation_failures
  if (failed >= rate.min && failed / finished >= rate.minRate) alerts.push(alert('generation_failures', failed, { total: finished, detail: topErrors }))
  if (stats.deadLetters >= ALERT_RULES.dead_letter.min) alerts.push(alert('dead_letter', stats.deadLetters))
  const account = stats.providerAccount
  if (account.count >= ALERT_RULES.provider_account.min) alerts.push(alert('provider_account', account.count, { detail: account.detail }))
  const balance = stats.providerBalance
  if (balance && balance.amount < ALERT_RULES.provider_balance.lowUsd) {
    alerts.push(alert('provider_balance', 1, { detail: `${balance.provider} 余额 ${balance.amount.toFixed(2)} ${balance.currency}` }))
  }
  if (stats.backlog >= ALERT_RULES.job_backlog.min) alerts.push(alert('job_backlog', stats.backlog))
  const webhooks = stats.webhookFailures
  if (webhooks.count >= ALERT_RULES.payment_webhook.min) alerts.push(alert('payment_webhook', webhooks.count, { detail: webhooks.latest }))
  const review = stats.paymentReview
  if (review.count >= ALERT_RULES.payment_review.min) alerts.push(alert('payment_review', review.count, { detail: review.latest }))
  if (stats.emailFailures >= ALERT_RULES.email_failures.min) alerts.push(alert('email_failures', stats.emailFailures))
  return alerts
}

// 时间桶编号（UTC，可读）：例如 2026-10-20T06 表示 06:00–12:00
export function alertBucket(now: number) {
  const size = ALERT_BUCKET_HOURS * 3600_000
  return new Date(Math.floor(now / size) * size).toISOString().slice(0, 13)
}

// 余额每小时只查一次：Cron 每 5 分钟跑一次，只在 UTC 分钟 < 5 的那次查（简单、无状态；Cron 偶尔漏跑一次就少查一小时）。
// 查询失败（网络错误、非 2xx）只记日志，不告警、不影响其他检查。
async function checkProviderBalance(env: Env, now: number): Promise<VideoBalance | null> {
  if (new Date(now).getUTCMinutes() >= 5) return null
  try {
    return await fetchVideoBalance(env)
  } catch (error) {
    console.error('[alert] provider balance check failed', error instanceof Error ? error.message : String(error))
    return null
  }
}

// since：只给本地 e2e 用，把各统计窗口的起点固定到测试开始时刻，不受之前运行留下的数据影响
export async function collectHealthStats(env: Env, now: number, since?: string): Promise<HealthStats> {
  const start = (kind: AlertKind) => since ?? new Date(now - ALERT_RULES[kind].windowMinutes * 60_000).toISOString()
  const db = env.DB
  const excluded = EXCLUDED_FAILURES.map(() => '?').join(', ')
  // updated_at 不早于 completed_at，先用它走 (status, updated_at) 索引
  const finishedSince = 'updated_at >= ? AND completed_at >= ?'
  const genStart = start('generation_failures')
  const deadStart = start('dead_letter')
  const accountStart = start('provider_account')
  const accountCodes = PROVIDER_ACCOUNT_ERRORS.map(() => '?').join(', ')
  const reviewWhere = `e.status IN ('orphan', 'mismatch') AND e.created_at >= ?
    AND (e.status = 'orphan' OR NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = e.order_id AND o.status IN ('paid', 'refunded')))`
  const providerBalance = await checkProviderBalance(env, now)
  const [finished, topErrors, deadLetters, accountErrors, backlog, webhooks, latestWebhook, reviews, latestReview, emails] = await db.batch([
    db
      .prepare(
        `SELECT COUNT(*) AS finished, COALESCE(SUM(status = 'failed'), 0) AS failed FROM generations
         WHERE status IN ('succeeded', 'failed') AND ${finishedSince} AND COALESCE(error_code, '') NOT IN (${excluded})`,
      )
      .bind(genStart, genStart, ...EXCLUDED_FAILURES),
    db
      .prepare(
        `SELECT error_code, COUNT(*) AS n FROM generations
         WHERE status = 'failed' AND ${finishedSince} AND COALESCE(error_code, '') NOT IN (${excluded})
         GROUP BY error_code ORDER BY n DESC LIMIT 3`,
      )
      .bind(genStart, genStart, ...EXCLUDED_FAILURES),
    db
      .prepare(`SELECT COUNT(*) AS n FROM generations WHERE status = 'failed' AND ${finishedSince} AND error_code = 'dead_letter'`)
      .bind(deadStart, deadStart),
    db
      .prepare(
        `SELECT error_code, COUNT(*) AS n FROM generations WHERE status = 'failed' AND ${finishedSince} AND error_code IN (${accountCodes})
         GROUP BY error_code ORDER BY n DESC`,
      )
      .bind(accountStart, accountStart, ...PROVIDER_ACCOUNT_ERRORS),
    db
      .prepare(`SELECT COUNT(*) AS n FROM generations WHERE status IN ('queued', 'processing') AND created_at < ?`)
      .bind(new Date(now - ALERT_RULES.job_backlog.windowMinutes * 60_000).toISOString()),
    db.prepare(`SELECT COUNT(*) AS n FROM payment_events WHERE status = 'failed' AND created_at >= ?`).bind(start('payment_webhook')),
    db
      .prepare(
        `SELECT provider, event_type, error FROM payment_events WHERE status = 'failed' AND created_at >= ? ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(start('payment_webhook')),
    db.prepare(`SELECT COUNT(*) AS n FROM payment_events e WHERE ${reviewWhere}`).bind(start('payment_review')),
    db
      .prepare(
        `SELECT e.provider, e.event_type, e.status, e.order_id, e.error FROM payment_events e WHERE ${reviewWhere}
         ORDER BY e.created_at DESC LIMIT 1`,
      )
      .bind(start('payment_review')),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM email_outbox WHERE created_at >= ? AND template != 'admin_alert'
         AND (status = 'failed' OR (status = 'pending' AND attempts >= ?))`,
      )
      .bind(start('email_failures'), EMAIL_STUCK_ATTEMPTS),
  ])
  const n = (result: D1Result | undefined) => Number((result?.results[0] as { n?: number } | undefined)?.n ?? 0)
  const generations = finished?.results[0] as { finished: number; failed: number } | undefined
  const errorSummary = (result: D1Result | undefined) => {
    const rows = (result?.results ?? []) as Array<{ error_code: string | null; n: number }>
    return rows.length ? rows.map((e) => `${e.error_code ?? 'unknown'} ×${e.n}`).join(', ') : null
  }
  const accountRows = (accountErrors?.results ?? []) as Array<{ n: number }>
  const latest = latestWebhook?.results[0] as { provider: string; event_type: string; error: string | null } | undefined
  const review = latestReview?.results[0] as
    | { provider: string; event_type: string; status: string; order_id: string | null; error: string | null }
    | undefined
  return {
    generations: {
      finished: Number(generations?.finished ?? 0),
      failed: Number(generations?.failed ?? 0),
      topErrors: errorSummary(topErrors),
    },
    deadLetters: n(deadLetters),
    providerAccount: { count: accountRows.reduce((sum, row) => sum + Number(row.n), 0), detail: errorSummary(accountErrors) },
    backlog: n(backlog),
    webhookFailures: {
      count: n(webhooks),
      latest: latest ? `${latest.provider} ${latest.event_type}: ${latest.error ?? ''}`.slice(0, 300) : null,
    },
    paymentReview: {
      count: n(reviews),
      latest: review
        ? `${review.provider} ${review.event_type} ${review.status}${review.order_id ? ` ${review.order_id}` : ''}: ${review.error ?? ''}`.slice(0, 300)
        : null,
    },
    emailFailures: n(emails),
    providerBalance,
  }
}

// 告警同步发到聊天群：同一 kind 同一时间桶只发一次（先查 KV 再写，Cron 重叠时可能极少量重复）。
// 发送失败只记日志（不带地址，地址里有 token），不影响邮件和其他告警。
export async function notifyAlertChat(env: Env, alert: Alert, bucket: string) {
  const webhook = env.PAYMENT_NOTIFY_WEBHOOK_URL
  if (!webhook) return
  try {
    const key = `alert_chat:${alert.kind}:${bucket}`
    if (await env.KV.get(key)) return
    // 先写再发：发送失败这个桶也不重试，避免群里被刷屏；失败原因在日志里
    await env.KV.put(key, '1', { expirationTtl: (ALERT_BUCKET_HOURS + 1) * 3600 })
    await postChatMessage(webhook, alertChatText(alert))
  } catch (error) {
    console.error('[alert] chat notify failed', alert.kind, error instanceof Error ? error.message : String(error))
  }
}

export async function runHealthCheck(env: Env, options: { now?: number; since?: string } = {}) {
  const now = options.now ?? Date.now()
  const stats = await collectHealthStats(env, now, options.since)
  const alerts = evaluateHealth(stats)
  const bucket = alertBucket(now)
  for (const alert of alerts) {
    console.error('[alert]', JSON.stringify(alert))
    await sendEmails(env, adminAlerts(env, `admin_alert:${alert.kind}:${bucket}`, () => ({ template: 'admin_alert', params: alert })))
    await notifyAlertChat(env, alert, bucket)
  }
  return { stats, alerts, bucket }
}
