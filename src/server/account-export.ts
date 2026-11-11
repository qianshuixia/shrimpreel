import { site } from '#/config/site'
import { nowIso } from './util'

// 个人数据导出（GDPR 第 15、20 条：访问权与可携带权），个人中心“导出我的数据”下载为 JSON。
// 只导出本人的数据和能直接看懂的字段：支付商内部 ID 只保留订单号；R2 路径、模型请求 ID、内部错误详情不导出；
// 别人对本人视频的举报属于举报人的数据，不导出（生成记录的 removedAt 会体现下架）。
// 邀请记录只导出本人这一侧：不带对方的用户 ID 和邮箱，也不带 IP 哈希。
// 媒体文件本身不打包，保留期内可在个人中心逐个下载。
const QUERIES = {
  account: `SELECT id, email, name, avatar_url AS avatarUrl, status, credits, locale, country, created_at AS createdAt,
      last_login_at AS lastLoginAt, signup_source AS signupSource, signup_medium AS signupMedium,
      signup_campaign AS signupCampaign, signup_device AS signupDevice, attribution, referral_code AS referralCode
    FROM users WHERE id = ?1`,
  sessions: `SELECT created_at AS createdAt, expires_at AS expiresAt, user_agent AS userAgent, ip
    FROM sessions WHERE user_id = ?1 ORDER BY created_at`,
  orders: `SELECT id, provider, provider_order_id AS providerOrderId, package_id AS packageId, credits,
      amount_cents AS amountCents, currency, status, paid_amount_cents AS paidAmountCents, paid_currency AS paidCurrency,
      refunded_amount_cents AS refundedAmountCents, refunded_credits AS refundedCredits, source, medium, campaign,
      country, device, attribution, created_at AS createdAt, paid_at AS paidAt, refunded_at AS refundedAt
    FROM orders WHERE user_id = ?1 ORDER BY created_at`,
  subscriptions: `SELECT id, provider, plan_id AS planId, interval, credits_per_month AS creditsPerMonth, amount_cents AS amountCents,
      currency, status, cancel_at_period_end AS cancelAtPeriodEnd, current_period_start AS currentPeriodStart,
      current_period_end AS currentPeriodEnd, created_at AS createdAt, ended_at AS endedAt
    FROM subscriptions WHERE user_id = ?1 ORDER BY created_at`,
  creditLedger: `SELECT delta, reason, ref_id AS refId, note, created_at AS createdAt
    FROM credit_ledger WHERE user_id = ?1 ORDER BY created_at, id`,
  creditGrants: `SELECT source, amount, remaining, expires_at AS expiresAt, created_at AS createdAt
    FROM credit_grants WHERE user_id = ?1 ORDER BY created_at, id`,
  referredBy: `SELECT status, created_at AS createdAt FROM referrals WHERE invitee_id = ?1`,
  referralsSent: `SELECT status, reject_reason AS rejectReason, reward_credits AS rewardCredits, created_at AS createdAt,
      rewarded_at AS rewardedAt, reversed_at AS reversedAt
    FROM referrals WHERE inviter_id = ?1 ORDER BY created_at`,
  uploads: `SELECT id, content_type AS contentType, size_bytes AS sizeBytes, sha256, created_at AS createdAt, expired_at AS expiredAt
    FROM uploads WHERE user_id = ?1 ORDER BY created_at`,
  generations: `SELECT id, template_id AS templateId, duration_id AS durationId, duration_seconds AS durationSeconds,
      credits_cost AS creditsCost, upload_id AS uploadId, second_upload_id AS secondUploadId, status, error_code AS errorCode, refunded,
      created_at AS createdAt, completed_at AS completedAt, expired_at AS expiredAt, removed_at AS removedAt,
      share_id AS shareId, shared_at AS sharedAt
    FROM generations WHERE user_id = ?1 ORDER BY created_at`,
  contactMessages: `SELECT id, email, topic, message, status, created_at AS createdAt
    FROM contact_messages WHERE user_id = ?1 ORDER BY created_at`,
  takedownRequests: `SELECT id, reporter_name AS reporterName, reporter_email AS reporterEmail, content_ref AS contentRef,
      reason, details, is_depicted AS isDepicted, status, resolution_note AS resolutionNote, created_at AS createdAt,
      resolved_at AS resolvedAt
    FROM takedown_requests WHERE reporter_user_id = ?1 ORDER BY created_at`,
  emails: `SELECT template, to_email AS toEmail, subject, status, created_at AS createdAt, sent_at AS sentAt
    FROM email_outbox WHERE user_id = ?1 ORDER BY created_at`,
} as const

type Row = Record<string, unknown>

// attribution 列存的是 JSON 字符串，导出时展开；解析失败就保留原文
function expandJson(row: Row) {
  if (typeof row.attribution !== 'string') return row
  try {
    return { ...row, attribution: JSON.parse(row.attribution) as unknown }
  } catch {
    return row
  }
}

export async function exportUserData(env: Env, userId: string) {
  const names = Object.keys(QUERIES) as Array<keyof typeof QUERIES>
  // 一次 batch 读出，各部分是同一时刻的快照
  const results = await env.DB.batch<Row>(names.map((name) => env.DB.prepare(QUERIES[name]).bind(userId)))
  const sections = Object.fromEntries(names.map((name, i) => [name, results[i]!.results.map(expandJson)])) as Record<keyof typeof QUERIES, Row[]>
  const { account, ...rest } = sections
  return {
    exportedAt: nowIso(),
    site: { name: site.brandName, url: `https://${site.domain}`, contact: site.supportEmail },
    account: account[0] ?? null,
    ...rest,
  }
}

export function exportFileName(date = new Date()) {
  return `${site.brandName.replace(/\s+/g, '-').toLowerCase()}-my-data-${date.toISOString().slice(0, 10)}.json`
}
