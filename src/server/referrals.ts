import type { Context, Hono } from 'hono'
import { deleteCookie, getCookie } from 'hono/cookie'
import { site } from '#/config/site'
import { clawbackStatements, ledgerStatements } from './credits'
import { getSettings, referralActive } from './settings'
import type { AppContext, OrderRow } from './types'
import { isUniqueConstraintError, nowIso, sha256Hex } from './util'

// 邀请奖励：/i/<code> 只写 vt_ref cookie；注册时服务端读 cookie 绑定邀请人（不接受请求体里的邀请人）。
// 被邀请人第一笔付款入账时，在同一个 D1 batch 里给邀请人发积分；这笔订单退款（含部分退款）时整笔回收。
// 防刷：奖励只在真实付款后发；同一邀请人在同一 IP（IPv6 按 /64）下最多绑定 referralMaxPerIp 个账号，超出的记为 rejected；
// 每个邀请人 30 天内最多获得 referralMonthlyCap 次奖励（已回收的也算）。
// 奖励积分是后台运营参数（settings.ts，默认 site.referralRewardCredits），设为 0 暂停邀请：不再绑定、不再发奖，已发的照常回收。

export const REFERRAL_COOKIE = 'vt_ref'
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8
const MONTH_MS = 30 * 86400_000

export function normalizeReferralCode(input: unknown) {
  if (typeof input !== 'string') return null
  const code = input.trim().toUpperCase()
  return code.length === CODE_LENGTH && [...code].every((ch) => ALPHABET.includes(ch)) ? code : null
}

function generateReferralCode() {
  return Array.from(crypto.getRandomValues(new Uint8Array(CODE_LENGTH)), (b) => ALPHABET[b & 31]).join('')
}

// 只存加盐哈希，不存 IP；IPv6 取前 4 组（一户人家通常分到一个 /64）
export async function referralIpHash(secret: string | undefined, ip: string | null | undefined) {
  if (!ip) return null
  const key = ip.includes(':') ? ip.toLowerCase().split(':').slice(0, 4).join(':') : ip
  return (await sha256Hex(`referral-ip:${secret ?? ''}:${key}`)).slice(0, 32)
}

export interface SignupReferral {
  code: string
  ipHash: string | null
}

// 登录接口调用：读出并清掉 vt_ref（只有新用户注册时才会用来绑定）
export async function requestReferral(c: Context<AppContext>): Promise<SignupReferral | null> {
  const code = normalizeReferralCode(getCookie(c, REFERRAL_COOKIE))
  if (!code) return null
  deleteCookie(c, REFERRAL_COOKIE, { path: '/' })
  if (!referralActive(await getSettings(c.env))) return null
  return { code, ipHash: await referralIpHash(c.env.SESSION_SECRET, c.req.header('cf-connecting-ip')) }
}

// 放进注册的 batch：邀请码不存在、邀请人不是 active 时不插入；同一 IP 已绑定到上限时记为 rejected（ip_limit）
export function bindReferralStatement(db: D1Database, inviteeId: string, referral: SignupReferral, now = nowIso()) {
  return db
    .prepare(
      `INSERT INTO referrals (invitee_id, inviter_id, ip_hash, status, reject_reason, created_at)
       SELECT ?1, id, ?2, CASE WHEN ip_full THEN 'rejected' ELSE 'pending' END, CASE WHEN ip_full THEN 'ip_limit' END, ?3
       FROM (SELECT u.id, (?2 IS NOT NULL AND (SELECT COUNT(*) FROM referrals r WHERE r.inviter_id = u.id AND r.ip_hash = ?2) >= ?4) AS ip_full
             FROM users u WHERE u.referral_code = ?5 AND u.status = 'active' AND u.id <> ?1)`,
    )
    .bind(inviteeId, referral.ipHash, now, site.referralMaxPerIp, referral.code)
}

// 付款入账时追加到同一个 batch。不符合条件时只把 pending 改成 rejected；符合时改成 rewarded 并断言是本订单改的
// （同一被邀请人两笔订单并发入账，后提交的断言失败，调用方去掉这些语句重试，只发一次）
export async function referralRewardStatements(
  db: D1Database,
  order: Pick<OrderRow, 'id' | 'user_id'>,
  credits: number,
  now = nowIso(),
) {
  const row = await db
    .prepare(
      `SELECT r.inviter_id, u.status AS inviter_status,
       (SELECT COUNT(*) FROM referrals x WHERE x.inviter_id = r.inviter_id AND x.rewarded_at > ?) AS recent
       FROM referrals r JOIN users u ON u.id = r.inviter_id WHERE r.invitee_id = ? AND r.status = 'pending'`,
    )
    .bind(new Date(Date.parse(now) - MONTH_MS).toISOString(), order.user_id)
    .first<{ inviter_id: string; inviter_status: string; recent: number }>()
  if (!row) return []
  // 暂停期间付款的首单也记为 rejected（paused），恢复后不会拿第二单补发
  const reject =
    credits <= 0 ? 'paused' : row.inviter_status !== 'active' ? 'inviter_inactive' : row.recent >= site.referralMonthlyCap ? 'monthly_cap' : null
  if (reject) {
    return [
      db
        .prepare(`UPDATE referrals SET status = 'rejected', reject_reason = ? WHERE invitee_id = ? AND status = 'pending'`)
        .bind(reject, order.user_id),
    ]
  }
  return [
    db
      .prepare(
        `UPDATE referrals SET status = 'rewarded', reward_order_id = ?, reward_credits = ?, rewarded_at = ?
         WHERE invitee_id = ? AND status = 'pending'`,
      )
      .bind(order.id, credits, now, order.user_id),
    db.prepare('INSERT INTO credit_guard (ok) SELECT COUNT(*) = 1 FROM referrals WHERE invitee_id = ? AND reward_order_id = ?').bind(order.user_id, order.id),
    db.prepare('DELETE FROM credit_guard'),
    ...ledgerStatements(db, {
      userId: row.inviter_id,
      delta: credits,
      reason: 'referral',
      refId: order.id,
      idempotencyKey: `referral:${order.id}`,
    }),
  ]
}

// 退款时追加到同一个 batch：这笔订单发过邀请奖励就整笔回收（邀请人可能已经花掉，最多扣到 0）。
// 两笔退款并发时只有先提交的那笔能把 rewarded 改成 reversed，后一笔断言失败，调用方去掉这些语句重试
export async function referralClawbackStatements(db: D1Database, order: Pick<OrderRow, 'id'>, now = nowIso()) {
  const row = await db
    .prepare(`SELECT inviter_id, reward_credits FROM referrals WHERE reward_order_id = ? AND status = 'rewarded'`)
    .bind(order.id)
    .first<{ inviter_id: string; reward_credits: number }>()
  if (!row) return []
  return [
    db.prepare(`UPDATE referrals SET status = 'reversed', reversed_at = ? WHERE reward_order_id = ? AND status = 'rewarded'`).bind(now, order.id),
    db.prepare('INSERT INTO credit_guard (ok) SELECT changes() = 1'),
    db.prepare('DELETE FROM credit_guard'),
    ...clawbackStatements(db, {
      userId: row.inviter_id,
      maxAmount: row.reward_credits,
      reason: 'referral_refund',
      refId: order.id,
      idempotencyKey: `referral_refund:${order.id}`,
      preferRefId: order.id,
    }),
  ]
}

// 第一次打开邀请卡片时生成邀请码；撞码（概率可忽略）换一个重试
export async function ensureReferralCode(db: D1Database, userId: string) {
  for (let attempt = 0; ; attempt++) {
    const existing = await db.prepare('SELECT referral_code FROM users WHERE id = ?').bind(userId).first<{ referral_code: string | null }>()
    if (!existing) throw new Error(`user not found: ${userId}`)
    if (existing.referral_code) return existing.referral_code
    try {
      await db.prepare('UPDATE users SET referral_code = ? WHERE id = ? AND referral_code IS NULL').bind(generateReferralCode(), userId).run()
    } catch (error) {
      if (!isUniqueConstraintError(error) || attempt >= 2) throw error
    }
  }
}

export async function referralSummary(db: D1Database, userId: string) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS invited, COALESCE(SUM(status = 'rewarded'), 0) AS rewarded,
       COALESCE(SUM(CASE WHEN status = 'rewarded' THEN reward_credits ELSE 0 END), 0) AS credits
       FROM referrals WHERE inviter_id = ?`,
    )
    .bind(userId)
    .first<{ invited: number; rewarded: number; credits: number }>()
  return row ?? { invited: 0, rewarded: 0, credits: 0 }
}

// 后台邀请排行：按时间段（created_at）统计每个邀请人的邀请数、已发奖励、回收、拒绝；另附最近的邀请记录
export function registerReferralAdminRoutes(routes: Hono<AppContext>) {
  routes.get('/referrals', async (c) => {
    const days = Number.parseInt(c.req.query('days') ?? '30', 10)
    const since = days > 0 ? new Date(Date.now() - days * 86400_000).toISOString() : ''
    const db = c.env.DB
    const [leaders, recent, totals] = await db.batch([
      db
        .prepare(
          `SELECT agg.inviter_id AS userId, u.email, u.referral_code AS code,
           agg.invited, agg.rewarded, agg.reversed, agg.rejected, agg.credits, agg.lastAt
           FROM (
             SELECT inviter_id, COUNT(*) AS invited,
               SUM(status = 'rewarded') AS rewarded, SUM(status = 'reversed') AS reversed, SUM(status = 'rejected') AS rejected,
               COALESCE(SUM(CASE WHEN status = 'rewarded' THEN reward_credits ELSE 0 END), 0) AS credits, MAX(created_at) AS lastAt
             FROM referrals WHERE created_at >= ?
             GROUP BY inviter_id ORDER BY rewarded DESC, invited DESC, lastAt DESC LIMIT 50
           ) agg
           JOIN users u ON u.id = agg.inviter_id
           ORDER BY agg.rewarded DESC, agg.invited DESC, agg.lastAt DESC`,
        )
        .bind(since),
      db
        .prepare(
          `SELECT r.invitee_id AS inviteeId, invitee.email AS inviteeEmail, r.inviter_id AS inviterId, inviter.email AS inviterEmail,
           r.status, r.reject_reason AS rejectReason, r.reward_order_id AS orderId, r.reward_credits AS credits, r.created_at AS createdAt
           FROM referrals r JOIN users invitee ON invitee.id = r.invitee_id JOIN users inviter ON inviter.id = r.inviter_id
           WHERE r.created_at >= ? ORDER BY r.created_at DESC LIMIT 50`,
        )
        .bind(since),
      db
        .prepare(
          `SELECT COUNT(*) AS invited, COALESCE(SUM(status = 'rewarded'), 0) AS rewarded, COALESCE(SUM(status = 'reversed'), 0) AS reversed,
           COALESCE(SUM(status = 'rejected'), 0) AS rejected,
           COALESCE(SUM(CASE WHEN status = 'rewarded' THEN reward_credits ELSE 0 END), 0) AS credits
           FROM referrals WHERE created_at >= ?`,
        )
        .bind(since),
    ])
    return c.json({ leaders: leaders!.results, recent: recent!.results, totals: totals!.results[0] })
  })
}
