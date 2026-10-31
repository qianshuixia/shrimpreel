import { site } from '#/config/site'

const DAY_MS = 86400_000
// 手机传图中转对象（handoff.ts）：没被取走的最长保留 1 小时
export const HANDOFF_PREFIX = 'handoff/'
export const HANDOFF_MAX_AGE_MS = 60 * 60_000
// D1 单条语句最多绑定 100 个参数；每轮每类最多处理这么多，Cron 每 5 分钟跑一次足够消化
const BATCH = 90

type SweepOptions = { now?: number; userId?: string }

// 到期清理：先删 R2 对象再标记行，标记失败时下一轮会重删（R2 delete 幂等）。
// 进行中的任务引用的原图不删；成片只删已成功且仍有对象的。userId 只给本地 e2e 用，限定在单个用户内。
export async function sweepExpiredMedia(env: Env, options: SweepOptions = {}) {
  const now = options.now ?? Date.now()
  const stamp = new Date(now).toISOString()
  const userFilter = options.userId ? 'AND user_id = ?' : ''
  const userParams = options.userId ? [options.userId] : []
  let uploads = 0
  let outputs = 0

  if (site.retention.uploadDays > 0) {
    const cutoff = new Date(now - site.retention.uploadDays * DAY_MS).toISOString()
    const rows = await env.DB.prepare(
      `SELECT id, r2_key FROM uploads u WHERE expired_at IS NULL AND created_at < ? ${userFilter}
       AND NOT EXISTS (SELECT 1 FROM generations g WHERE g.upload_id = u.id AND g.status IN ('queued', 'processing'))
       LIMIT ${BATCH}`,
    )
      .bind(cutoff, ...userParams)
      .all<{ id: string; r2_key: string }>()
    if (rows.results.length) {
      await env.MEDIA.delete(rows.results.map((r) => r.r2_key))
      const ids = rows.results.map((r) => r.id)
      await env.DB.prepare(`UPDATE uploads SET expired_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`)
        .bind(stamp, ...ids)
        .run()
      uploads = ids.length
    }
  }

  if (site.retention.outputDays > 0) {
    const cutoff = new Date(now - site.retention.outputDays * DAY_MS).toISOString()
    const rows = await env.DB.prepare(
      `SELECT id, output_r2_key, share_poster_key FROM generations WHERE status = 'succeeded' AND output_r2_key IS NOT NULL AND completed_at < ? ${userFilter}
       LIMIT ${BATCH}`,
    )
      .bind(cutoff, ...userParams)
      .all<{ id: string; output_r2_key: string; share_poster_key: string | null }>()
    if (rows.results.length) {
      // 分享封面随成片一起删；share_id 保留，分享链接显示“已过期”（410）而不是 404
      await env.MEDIA.delete(rows.results.flatMap((r) => (r.share_poster_key ? [r.output_r2_key, r.share_poster_key] : [r.output_r2_key])))
      const ids = rows.results.map((r) => r.id)
      await env.DB.prepare(
        `UPDATE generations SET output_r2_key = NULL, share_poster_key = NULL, expired_at = ?, updated_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
      )
        .bind(stamp, stamp, ...ids)
        .run()
      outputs = ids.length
    }
  }

  return { uploads, outputs }
}

// 删除上传时间超过 HANDOFF_MAX_AGE_MS 的中转对象（没被取走的照片、没人扫的 pending）
export function expiredHandoffKeys(objects: Array<{ key: string; uploaded: Date }>, now: number) {
  return objects.filter((o) => now - o.uploaded.getTime() > HANDOFF_MAX_AGE_MS).map((o) => o.key)
}

export async function sweepHandoff(env: Env, now = Date.now()) {
  let removed = 0
  let cursor: string | undefined
  do {
    const listed = await env.MEDIA.list({ prefix: HANDOFF_PREFIX, cursor })
    const keys = expiredHandoffKeys(listed.objects, now)
    if (keys.length) await env.MEDIA.delete(keys)
    removed += keys.length
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)
  return removed
}

// 成片的可下载截止时间；未成功、已过期或不自动删除时为 null
export function outputExpiresAt(completedAt: string | null) {
  if (!completedAt || site.retention.outputDays <= 0) return null
  return new Date(Date.parse(completedAt) + site.retention.outputDays * DAY_MS).toISOString()
}
