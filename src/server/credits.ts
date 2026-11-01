import { createId, nowIso } from './util'

// 所有积分变动都走这里，流水、批次和余额在同一个 D1 batch（事务）里：
// - 入账新建一个批次（credit_grants），可带到期时间；扣费按“先到期先扣”分配到批次上，明细记在 credit_allocations
// - 分配完全在 SQL 里算（窗口函数），和扣减在同一个事务里，并发扣费不会超扣，也不需要重试
// - idempotency_key 唯一：重复入账整个 batch 回滚（isUniqueConstraintError）
// - 余额不足：credit_guard 的 CHECK 失败，整个 batch 回滚（isCheckConstraintError）
// - users.credits 是批次 remaining 之和的缓存，每次变动后重算

export type LedgerReason =
  | 'signup_bonus'
  | 'purchase'
  | 'generation'
  | 'generation_refund'
  | 'order_refund'
  | 'dispute'
  | 'dispute_won'
  | 'admin_adjust'
  | 'account_deleted'
  | 'expire'
  | 'redeem'
  | 'referral'
  | 'referral_refund'
  | 'subscription'

export interface LedgerEntry {
  userId: string
  delta: number
  reason: LedgerReason
  refId?: string | null
  idempotencyKey: string
  note?: string | null
  // 只对入账有效：批次到期时间（ISO），不填永不过期
  expiresAt?: string | null
}

// 入账（delta > 0）新建批次；扣费（delta < 0）余额不足时整个 batch 回滚
export function ledgerStatements(db: D1Database, entry: LedgerEntry): D1PreparedStatement[] {
  const now = nowIso()
  if (entry.delta > 0) {
    return [
      db
        .prepare(
          `INSERT INTO credit_grants (id, user_id, source, ref_id, amount, remaining, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(createId('grt'), entry.userId, entry.reason, entry.refId ?? null, entry.delta, entry.delta, entry.expiresAt ?? null, now),
      insertLedger(db, entry, now),
      recomputeBalance(db, entry.userId),
    ]
  }
  const amount = -entry.delta
  return [
    ...expireStatements(db, now, entry.userId),
    ...allocateStatements(db, { userId: entry.userId, key: entry.idempotencyKey, amount, now }),
    db
      .prepare('INSERT INTO credit_guard (ok) SELECT COALESCE(SUM(amount), 0) = ? FROM credit_allocations WHERE ledger_key = ?')
      .bind(amount, entry.idempotencyKey),
    db.prepare('DELETE FROM credit_guard'),
    insertLedger(db, entry, now),
    recomputeBalance(db, entry.userId),
  ]
}

// 回收（退款、注销）：最多扣到 0（用户可能已经花掉部分积分），流水记录实际扣除量。
// preferRefId：先扣这个来源的批次（退款时先扣该订单买的积分），再按先到期先扣；
// onlyPreferred：只扣这个来源的批次（订阅积分当期作废，退款不该扣到用户另买的积分包）
export function clawbackStatements(
  db: D1Database,
  entry: Omit<LedgerEntry, 'delta' | 'expiresAt'> & { maxAmount: number; preferRefId?: string | null; onlyPreferred?: boolean },
): D1PreparedStatement[] {
  const now = nowIso()
  const key = entry.idempotencyKey
  return [
    ...expireStatements(db, now, entry.userId),
    ...allocateStatements(db, {
      userId: entry.userId,
      key,
      amount: entry.maxAmount,
      preferRefId: entry.preferRefId,
      onlyPreferred: entry.onlyPreferred === true && !!entry.preferRefId,
      now,
    }),
    db
      .prepare(
        `INSERT INTO credit_ledger (id, user_id, delta, reason, ref_id, idempotency_key, note, created_at)
         SELECT ?, ?, -COALESCE(SUM(amount), 0), ?, ?, ?, ?, ? FROM credit_allocations WHERE ledger_key = ?`,
      )
      .bind(createId('led'), entry.userId, entry.reason, entry.refId ?? null, key, entry.note ?? null, now, key),
    recomputeBalance(db, entry.userId),
  ]
}

// 生成失败退积分：按扣费明细原路退回各批次（已到期的批次退回后由下一次作废清掉）。
// 只在任务处于 failed + refunded 时生效；已经退过时流水的 idempotency_key 冲突，整个 batch 回滚。
// 本功能上线前扣费的任务没有明细，退成一个永不过期的新批次
export function generationRefundStatements(db: D1Database, generationId: string, note: string, now = nowIso()): D1PreparedStatement[] {
  const refundable = `FROM generations WHERE id = ?1 AND status = 'failed' AND refunded = 1`
  const hasAllocations = `SELECT 1 FROM credit_allocations WHERE ledger_key = 'generation:' || ?1`
  return [
    db
      .prepare(
        `INSERT INTO credit_ledger (id, user_id, delta, reason, ref_id, idempotency_key, note, created_at)
         SELECT 'led_' || lower(hex(randomblob(12))), user_id, credits_cost, 'generation_refund', id, 'generation_refund:' || id, ?2, ?3
         ${refundable}`,
      )
      .bind(generationId, note, now),
    db
      .prepare(
        `UPDATE credit_grants SET remaining = remaining +
           (SELECT a.amount FROM credit_allocations a WHERE a.ledger_key = 'generation:' || ?1 AND a.grant_id = credit_grants.id)
         WHERE id IN (SELECT grant_id FROM credit_allocations WHERE ledger_key = 'generation:' || ?1) AND EXISTS (SELECT 1 ${refundable})`,
      )
      .bind(generationId),
    db
      .prepare(
        `INSERT INTO credit_grants (id, user_id, source, ref_id, amount, remaining, expires_at, created_at)
         SELECT 'grt_' || lower(hex(randomblob(12))), user_id, 'generation_refund', id, credits_cost, credits_cost, NULL, ?2
         ${refundable} AND credits_cost > 0 AND NOT EXISTS (${hasAllocations})`,
      )
      .bind(generationId, now),
    db
      .prepare(
        `UPDATE users SET credits = (SELECT COALESCE(SUM(remaining), 0) FROM credit_grants WHERE user_id = users.id)
         WHERE id = (SELECT user_id ${refundable})`,
      )
      .bind(generationId),
  ]
}

// 作废到期批次的剩余积分：每个批次写一条 expire 流水，扣减缓存余额，remaining 置 0。
// 不传 userId 时处理所有用户（Cron）；扣费前按用户处理，保证不会扣到已到期的批次
// 订阅当期的周期被支付商校正（付款事件不带周期时先按付款时间推算）：把这张订单最新一个还没到期的订阅批次改到新的到期时间。
// 只改到期时间不改数量，余额缓存不变。和订阅的 UPDATE 放进同一个 batch：订阅这次没更新（乱序事件被丢弃）时周期对不上，不改
export function alignSubscriptionGrantStatement(
  db: D1Database,
  entry: { subscriptionId: string; orderId: string; periodStart: string; periodEnd: string; expiresAt: string },
  now = nowIso(),
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE credit_grants SET expires_at = ?1
       WHERE id = (SELECT id FROM credit_grants WHERE source = 'subscription' AND ref_id = ?2 AND remaining > 0 AND expires_at > ?3
                   ORDER BY expires_at DESC LIMIT 1)
         AND EXISTS (SELECT 1 FROM subscriptions WHERE id = ?4 AND current_order_id = ?2 AND current_period_start = ?5 AND current_period_end = ?6)`,
    )
    .bind(entry.expiresAt, entry.orderId, now, entry.subscriptionId, entry.periodStart, entry.periodEnd)
}

export function expireStatements(db: D1Database, now: string, userId: string | null = null): D1PreparedStatement[] {
  const expiring = `remaining > 0 AND expires_at IS NOT NULL AND expires_at <= ?1 AND (?2 IS NULL OR user_id = ?2)`
  return [
    db
      .prepare(
        `INSERT INTO credit_ledger (id, user_id, delta, reason, ref_id, idempotency_key, note, created_at)
         SELECT 'led_' || lower(hex(randomblob(12))), user_id, -remaining, 'expire', id, 'expire:' || id || ':' || ?1, source, ?1
         FROM credit_grants WHERE ${expiring}`,
      )
      .bind(now, userId),
    db
      .prepare(
        `UPDATE users SET credits = credits - (SELECT SUM(remaining) FROM credit_grants WHERE user_id = users.id AND ${expiring})
         WHERE id IN (SELECT user_id FROM credit_grants WHERE ${expiring})`,
      )
      .bind(now, userId),
    db.prepare(`UPDATE credit_grants SET remaining = 0 WHERE ${expiring}`).bind(now, userId),
  ]
}

// 先到期先扣（永不过期的最后扣），同一到期时间按入账先后。只分配到 amount 为止，可用积分不够时分配得少
function allocateStatements(
  db: D1Database,
  input: { userId: string; key: string; amount: number; preferRefId?: string | null; onlyPreferred?: boolean; now: string },
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO credit_allocations (ledger_key, grant_id, amount)
         SELECT ?1, id, MIN(remaining, ?3 - (running - remaining)) FROM (
           SELECT id, remaining, SUM(remaining) OVER (
             ORDER BY CASE WHEN ref_id = ?4 THEN 0 ELSE 1 END, expires_at IS NULL, expires_at, created_at, id
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS running
           FROM credit_grants WHERE user_id = ?2 AND remaining > 0 AND (expires_at IS NULL OR expires_at > ?5)
             AND (?6 = 0 OR ref_id = ?4)
         ) WHERE running - remaining < ?3`,
      )
      .bind(input.key, input.userId, input.amount, input.preferRefId ?? null, input.now, input.onlyPreferred ? 1 : 0),
    db
      .prepare(
        `UPDATE credit_grants SET remaining = remaining -
           (SELECT a.amount FROM credit_allocations a WHERE a.ledger_key = ?1 AND a.grant_id = credit_grants.id)
         WHERE id IN (SELECT grant_id FROM credit_allocations WHERE ledger_key = ?1)`,
      )
      .bind(input.key),
  ]
}

function insertLedger(db: D1Database, entry: LedgerEntry, now: string) {
  return db
    .prepare(
      `INSERT INTO credit_ledger (id, user_id, delta, reason, ref_id, idempotency_key, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(createId('led'), entry.userId, entry.delta, entry.reason, entry.refId ?? null, entry.idempotencyKey, entry.note ?? null, now)
}

function recomputeBalance(db: D1Database, userId: string) {
  return db.prepare('UPDATE users SET credits = (SELECT COALESCE(SUM(remaining), 0) FROM credit_grants WHERE user_id = ?1) WHERE id = ?1').bind(userId)
}
