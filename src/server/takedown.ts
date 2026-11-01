import { site } from '#/config/site'
import { failGeneration } from './jobs'
import { notifyTakedownCreated } from './notifications'
import type { GenerationRow, UploadRow, UserRow } from './types'
import { ApiError, createId, nowIso, sha256Hex } from './util'

export const TAKEDOWN_REASONS = ['intimate', 'impersonation', 'minor', 'copyright', 'other'] as const

export interface TakedownInput {
  name: string
  email: string
  contentRef: string
  reason: string
  details: string
  isDepicted: boolean
  // 善意声明（TAKE IT DOWN Act 等要求举报人声明内容未经同意）
  attest: boolean
  // 电子签名（输入全名）
  signature: string
}

// 下载文件名和链接里都带 generation id，举报人粘贴文件名或链接即可定位
const GENERATION_ID = /gen_[A-Za-z0-9_-]{16}/
// 公开分享链接 /v/<shareId>（可带语言前缀）：按 share_id 反查 generation
const SHARE_LINK = /\/v\/([A-Za-z0-9_-]{16})(?![A-Za-z0-9_-])/

function field(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function parseTakedown(body: Partial<TakedownInput>) {
  const name = field(body.name, 200)
  const email = field(body.email, 320)
  const contentRef = field(body.contentRef, 2000)
  const details = field(body.details, 5000)
  const signature = field(body.signature, 200)
  const reason = TAKEDOWN_REASONS.find((r) => r === body.reason)
  if (!name) throw new ApiError(400, 'invalid_report', 'name')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError(400, 'invalid_email')
  if (contentRef.length < 3) throw new ApiError(400, 'invalid_report', 'contentRef')
  if (!reason) throw new ApiError(400, 'invalid_report', 'reason')
  if (body.attest !== true) throw new ApiError(400, 'invalid_report', 'attest')
  if (!signature) throw new ApiError(400, 'invalid_report', 'signature')
  return { name, email, contentRef, details: details || null, reason, isDepicted: body.isDepicted === true, signature }
}

export async function createTakedown(
  env: Env,
  input: ReturnType<typeof parseTakedown>,
  reporter: UserRow | null,
  locale: string | null,
) {
  const id = createId('tdr')
  const now = new Date()
  const dueAt = new Date(now.getTime() + site.takedownSlaHours * 3600_000).toISOString()
  const generationId =
    (input.contentRef.match(GENERATION_ID) ?? input.details?.match(GENERATION_ID))?.[0] ??
    (await generationIdFromShareLink(env, `${input.contentRef}\n${input.details ?? ''}`))
  await env.DB.prepare(
    `INSERT INTO takedown_requests (id, reporter_name, reporter_email, reporter_user_id, content_ref, generation_id, reason,
     details, is_depicted, signature, status, due_at, locale, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
  )
    .bind(
      id,
      input.name,
      input.email,
      reporter?.id ?? null,
      input.contentRef,
      generationId,
      input.reason,
      input.details,
      input.isDepicted ? 1 : 0,
      input.signature,
      dueAt,
      locale,
      now.toISOString(),
    )
    .run()
  // 举报表单不需要登录，填的邮箱没人验证过：回执只发给已登录、且填的就是自己账号邮箱的举报人，
  // 否则这张表单能被用来给任意地址发信。编号在提交后的页面上显示，处理结果仍发到填写的邮箱（要等管理员处理）
  const receipt = reporter !== null && reporter.email.toLowerCase() === input.email.toLowerCase()
  await notifyTakedownCreated(env, {
    id,
    receipt,
    reporter_email: input.email,
    reporter_user_id: reporter?.id ?? null,
    locale,
    reason: input.reason,
    generation_id: generationId,
    due_at: dueAt,
  })
  return { id, dueAt }
}

async function generationIdFromShareLink(env: Env, text: string) {
  const shareId = text.match(SHARE_LINK)?.[1]
  if (!shareId) return null
  const row = await env.DB.prepare('SELECT id FROM generations WHERE share_id = ?').bind(shareId).first<{ id: string }>()
  return row?.id ?? null
}

// 下架：同一张原图（按 sha256，包括其他账号上传的同一文件）生成的所有成片和原图都删除，
// 进行中的任务判失败并退款，再把哈希加入黑名单阻止重新上传
export async function removeReportedContent(env: Env, generation: GenerationRow, takedownId: string) {
  const db = env.DB
  const upload = await db.prepare('SELECT * FROM uploads WHERE id = ?').bind(generation.upload_id).first<UploadRow>()
  let hash = upload?.sha256 ?? null
  if (upload && !hash && !upload.expired_at) {
    const object = await env.MEDIA.get(upload.r2_key)
    if (object) hash = await sha256Hex(new Uint8Array(await object.arrayBuffer()))
  }

  const uploadMatch = `(id = ? OR (sha256 IS NOT NULL AND sha256 = ?))`
  const uploadParams = [generation.upload_id, hash ?? '']
  const [uploads, generations] = await db.batch([
    db.prepare(`SELECT id, r2_key FROM uploads WHERE expired_at IS NULL AND ${uploadMatch}`).bind(...uploadParams),
    db
      .prepare(
        `SELECT id, user_id, status, output_r2_key, share_poster_key FROM generations WHERE removed_at IS NULL
         AND (id = ? OR upload_id IN (SELECT id FROM uploads WHERE ${uploadMatch}))`,
      )
      .bind(generation.id, ...uploadParams),
  ])
  const uploadRows = uploads!.results as Array<{ id: string; r2_key: string }>
  const generationRows = generations!.results as Array<Pick<GenerationRow, 'id' | 'user_id' | 'status' | 'output_r2_key' | 'share_poster_key'>>

  for (const row of generationRows) {
    if (row.status === 'queued' || row.status === 'processing') await failGeneration(env, row.id, 'content_removed', 'Removed after a takedown request')
  }
  const keys = [
    ...uploadRows.map((r) => r.r2_key),
    ...generationRows.flatMap((r) => [r.output_r2_key, r.share_poster_key].filter((key): key is string => Boolean(key))),
  ]
  for (let i = 0; i < keys.length; i += 1000) await env.MEDIA.delete(keys.slice(i, i + 1000))

  const now = nowIso()
  await db.batch([
    db
      .prepare(
        `UPDATE generations SET output_r2_key = NULL, share_poster_key = NULL, removed_at = ?, updated_at = ? WHERE removed_at IS NULL
         AND (id = ? OR upload_id IN (SELECT id FROM uploads WHERE ${uploadMatch}))`,
      )
      .bind(now, now, generation.id, ...uploadParams),
    db.prepare(`UPDATE uploads SET expired_at = COALESCE(expired_at, ?) WHERE ${uploadMatch}`).bind(now, ...uploadParams),
    ...(hash
      ? [
          db
            .prepare('INSERT INTO blocked_media (sha256, takedown_id, created_at) VALUES (?, ?, ?) ON CONFLICT(sha256) DO NOTHING')
            .bind(hash, takedownId, now),
        ]
      : []),
  ])
  // 按作者统计被删的视频（有成片或生成中的；早已失败或过期的不算），用于通知作者
  const owners = new Map<string, number>()
  for (const row of generationRows) {
    if (row.output_r2_key || row.status === 'queued' || row.status === 'processing') owners.set(row.user_id, (owners.get(row.user_id) ?? 0) + 1)
  }
  return {
    generations: generationRows.length,
    uploads: uploadRows.length,
    blocked: Boolean(hash),
    owners: [...owners].map(([userId, videos]) => ({ userId, videos })),
  }
}

export async function isBlockedMedia(env: Env, hash: string) {
  return Boolean(await env.DB.prepare('SELECT 1 AS hit FROM blocked_media WHERE sha256 = ?').bind(hash).first())
}
