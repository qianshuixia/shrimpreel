import { findDuration, findStyle } from '#/config/site'
import { jobToken, signedUploadUrl, templateSourceUrl } from './media'
import { expireStatements, generationRefundStatements } from './credits'
import { notifyGenerationFinished } from './notifications'
import { reconcilePendingOrders } from './reconcile'
import type { GenerationRow, UploadRow, VideoJobMessage } from './types'
import { sweepExpiredMedia, sweepHandoff } from './retention'
import { grantDueSubscriptions } from './subscriptions'
import { nowIso } from './util'
import { getVideoProvider } from './video'
import { VideoProviderError } from './video/types'

const JOB_TIMEOUT_MINUTES = 45
// 成片大小上限：带 Content-Length 时直接流式写入 R2，不占 Worker 内存；没带时只能边读边缓存，上限更低（Worker 内存 128 MB）
export const MAX_OUTPUT_BYTES = 100 * 1024 * 1024
export const MAX_BUFFERED_OUTPUT_BYTES = 48 * 1024 * 1024

// 把服务商给的成片地址存进 R2；超过上限返回 false（调用方判失败、退积分），不把超大文件读进内存
export async function storeOutputFromUrl(
  env: Env,
  url: string,
  key: string,
  limits = { streamed: MAX_OUTPUT_BYTES, buffered: MAX_BUFFERED_OUTPUT_BYTES },
) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`download output failed: HTTP ${response.status}`)
  const httpMetadata = { contentType: 'video/mp4' }
  const header = response.headers.get('content-length')
  const declared = header === null ? NaN : Number(header)
  if (Number.isSafeInteger(declared) && declared > 0) {
    if (declared > limits.streamed) {
      await response.body?.cancel()
      return false
    }
    // 运行时保证响应体和 Content-Length 一致，R2 也只接受长度已知的流
    await env.MEDIA.put(key, response.body, { httpMetadata })
    return true
  }
  if (!response.body) throw new Error('download output failed: empty body')
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limits.buffered) {
      await reader.cancel()
      return false
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  await env.MEDIA.put(key, bytes, { httpMetadata })
  return true
}
const POLL_DELAY_SECONDS: Record<string, number> = { mock: 2, fal: 20, yir: 20, nanoapi: 30 }

export async function enqueueJob(env: Env, message: VideoJobMessage, delaySeconds = 0) {
  await env.VIDEO_QUEUE.send(message, delaySeconds > 0 ? { delaySeconds } : undefined)
}

export async function handleQueueBatch(batch: MessageBatch<VideoJobMessage>, env: Env) {
  for (const message of batch.messages) {
    try {
      await handleVideoJob(env, message.body)
      message.ack()
    } catch (error) {
      console.error('video job failed, will retry', message.body, error)
      message.retry({ delaySeconds: Math.min(300, 10 * 2 ** message.attempts) })
    }
  }
}

// 死信：主队列消息重试 max_retries 次仍失败后转入 DLQ（wrangler.jsonc），由同一个 Worker 消费。
// 任务判失败并退积分（已结束的任务不受影响），健康检查按 error_code = dead_letter 告警
export async function handleDeadLetterBatch(batch: MessageBatch<VideoJobMessage>, env: Env) {
  for (const message of batch.messages) {
    console.error('video job dead-lettered', message.body)
    try {
      await handleDeadLetter(env, message.body)
      message.ack()
    } catch (error) {
      console.error('dead letter handling failed', message.body, error)
      message.retry()
    }
  }
}

export function handleDeadLetter(env: Env, message: VideoJobMessage) {
  return failGeneration(env, message.generationId, 'dead_letter', `Queue message (${message.kind}) exhausted its retries`)
}

export async function handleVideoJob(env: Env, message: VideoJobMessage) {
  const generation = await env.DB.prepare('SELECT * FROM generations WHERE id = ?')
    .bind(message.generationId)
    .first<GenerationRow>()
  if (!generation) return
  if (message.kind === 'submit') await submitGeneration(env, generation)
  else await pollGeneration(env, generation)
}

async function submitGeneration(env: Env, generation: GenerationRow) {
  if (generation.status !== 'queued') return
  // 先抢占：队列至少投递一次，重复消息不能重复向 provider 提交（会重复计费）
  const claimed = await env.DB.prepare(
    `UPDATE generations SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'`,
  )
    .bind(nowIso(), generation.id)
    .run()
  if (!claimed.meta.changes) return

  const duration = findDuration(generation.duration_id)
  const style = findStyle(generation.template_id)
  const sourceFile = duration ? style?.sources[duration.id] : undefined
  const upload = await env.DB.prepare('SELECT * FROM uploads WHERE id = ?').bind(generation.upload_id).first<UploadRow>()
  if (!duration || !style || !sourceFile || !upload || upload.expired_at) {
    await failGeneration(env, generation.id, 'invalid_input', 'Upload, style or duration no longer exists')
    return
  }

  const provider = getVideoProvider(env, generation.provider)
  const baseMeta = parseMeta(generation.provider_meta)

  // 签名在 try 里：生产环境 SESSION_SECRET 配错时会抛错，要和提交失败一样放回 queued，交给队列重试和死信退款
  try {
    const webhookUrl = new URL(`/api/webhooks/${provider.id}`, env.SITE_URL)
    webhookUrl.searchParams.set('gen', generation.id)
    webhookUrl.searchParams.set('token', await jobToken(env, generation.id))
    // 重新提交时请求体要和第一次一致，签名按任务创建时间算（任务 45 分钟超时，2 小时有效期足够）
    const result = await provider.submit({
      generationId: generation.id,
      style,
      durationSeconds: generation.duration_seconds,
      imageUrl: await signedUploadUrl(env, upload.id, Date.parse(generation.created_at)),
      sourceVideoUrl: templateSourceUrl(env, sourceFile),
      sourceVideoKey: `templates/${sourceFile}`,
      webhookUrl: webhookUrl.toString(),
      meta: baseMeta,
    })
    const now = nowIso()
    await env.DB.prepare(
      `UPDATE generations SET provider_request_id = ?, provider_meta = ?, started_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(result.requestId, JSON.stringify(result.meta), now, now, generation.id)
      .run()
    await enqueueJob(env, { kind: 'poll', generationId: generation.id }, POLL_DELAY_SECONDS[provider.id])
  } catch (error) {
    if (error instanceof VideoProviderError && !error.retryable) {
      await failGeneration(env, generation.id, error.code, error.message)
      return
    }
    // 可重试：放回 queued，让队列重投时重新抢占
    await env.DB.prepare(`UPDATE generations SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'processing'`)
      .bind(nowIso(), generation.id)
      .run()
    throw error
  }
}

async function pollGeneration(env: Env, generation: GenerationRow) {
  if (generation.status !== 'processing' || !generation.provider_request_id) return
  const provider = getVideoProvider(env, generation.provider)
  let status
  try {
    status = await provider.status(generation.provider_request_id, parseMeta(generation.provider_meta))
  } catch (error) {
    if (error instanceof VideoProviderError && !error.retryable) {
      await failGeneration(env, generation.id, error.code, error.message)
      return
    }
    throw error
  }

  if (status.state === 'pending') {
    if (minutesSince(generation.created_at) > JOB_TIMEOUT_MINUTES) {
      await failGeneration(env, generation.id, 'timeout', 'Generation timed out')
      return
    }
    if (status.next) {
      // webhook 和定时轮询可能同时推进到下一步：服务商端靠幂等键只建一个任务，这里按旧任务 id 抢占，只写一次
      const advanced = await env.DB.prepare(
        `UPDATE generations SET provider_request_id = ?, provider_meta = ?, updated_at = ?
         WHERE id = ? AND status = 'processing' AND provider_request_id = ?`,
      )
        .bind(status.next.requestId, JSON.stringify(status.next.meta), nowIso(), generation.id, generation.provider_request_id)
        .run()
      if (!advanced.meta.changes) return
    } else {
      await env.DB.prepare('UPDATE generations SET updated_at = ? WHERE id = ?').bind(nowIso(), generation.id).run()
    }
    await enqueueJob(env, { kind: 'poll', generationId: generation.id }, POLL_DELAY_SECONDS[provider.id])
    return
  }

  if (status.state === 'failed') {
    await failGeneration(env, generation.id, status.code, status.message)
    return
  }

  const outputKey = `outputs/${generation.user_id}/${generation.id}.mp4`
  if ('url' in status.output) {
    if (!(await storeOutputFromUrl(env, status.output.url, outputKey))) {
      await failGeneration(env, generation.id, 'output_too_large', 'Provider output exceeds the size limit')
      return
    }
  } else {
    const source = await env.MEDIA.get(status.output.r2Key)
    if (!source) {
      await failGeneration(env, generation.id, 'output_missing', `R2 object ${status.output.r2Key} not found`)
      return
    }
    await env.MEDIA.put(outputKey, await source.arrayBuffer(), { httpMetadata: { contentType: 'video/mp4' } })
  }
  const now = nowIso()
  const costCents = status.costCents ?? provider.costCents(generation.duration_seconds, generation.template_id)
  const saved = await env.DB.prepare(
    `UPDATE generations SET status = 'succeeded', output_r2_key = ?, provider_cost_cents = ?, completed_at = ?, updated_at = ?
     WHERE id = ? AND status = 'processing'`,
  )
    .bind(outputKey, costCents, now, now, generation.id)
    .run()
  if (saved.meta.changes) {
    await notifyGenerationFinished(env, generation.id)
    return
  }
  // webhook 和定时轮询可能同时处理同一任务：另一路已经成功落库时，同一个 outputKey 就是它的成片，不能删
  const current = await env.DB.prepare('SELECT status FROM generations WHERE id = ?').bind(generation.id).first<{ status: string }>()
  if (current?.status === 'succeeded') return
  // 期间已被判失败（超时、管理员失败或下架）：不留下无主的成片，但服务商已经出片计费，成本照记
  await env.MEDIA.delete(outputKey)
  await env.DB.prepare('UPDATE generations SET provider_cost_cents = ? WHERE id = ? AND provider_cost_cents IS NULL')
    .bind(costCents, generation.id)
    .run()
}

// 失败并退积分，在同一事务里：
// 1) 只有 queued/processing 才会被置为 failed
// 2) 只为 failed+refunded 的任务写退款流水；已退过则 idempotency_key 冲突，整个 batch 回滚（不会重复退）
// 3) 只有第 2 步成立时才按扣费明细退回积分（已成功的任务第 1、2 步都不生效，见 credits.ts）
// 返回这次调用是否真的把任务置为失败
export async function failGeneration(env: Env, generationId: string, code: string, message: string) {
  const now = nowIso()
  const db = env.DB
  let results: D1Result[]
  try {
    results = await db.batch([
      db
        .prepare(
          `UPDATE generations SET status = 'failed', refunded = 1, error_code = ?, error_message = ?, completed_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('queued', 'processing')`,
        )
        .bind(code.slice(0, 100), message.slice(0, 1000), now, now, generationId),
      ...generationRefundStatements(db, generationId, code.slice(0, 100), now),
    ])
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) return false
    throw error
  }
  // 只有这次调用真正把任务置为失败时才通知
  const failed = Boolean(results[0]?.meta.changes)
  if (failed) await notifyGenerationFinished(env, generationId)
  return failed
}

// 每 5 分钟：补投丢失的队列消息、超时任务失败退款、作废到期积分、年付订阅按月补发、pending 订单向支付商查单、清理过期会话和长期未支付订单、按保留期删除媒体
export async function runScheduledMaintenance(env: Env) {
  const db = env.DB
  const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString()
  const timeoutBefore = new Date(Date.now() - JOB_TIMEOUT_MINUTES * 60_000).toISOString()

  const stuck = await db
    .prepare(
      `SELECT * FROM generations WHERE status IN ('queued', 'processing') AND updated_at < ? ORDER BY updated_at LIMIT 50`,
    )
    .bind(staleBefore)
    .all<GenerationRow>()

  for (const generation of stuck.results) {
    if (generation.created_at < timeoutBefore) {
      await failGeneration(env, generation.id, 'timeout', 'Generation timed out')
    } else if (generation.status === 'queued') {
      await enqueueJob(env, { kind: 'submit', generationId: generation.id })
    } else if (generation.provider_request_id) {
      await enqueueJob(env, { kind: 'poll', generationId: generation.id })
    } else if (generation.attempts < 3) {
      // 抢占后、拿到 request id 前 Worker 中断：放回队列重新提交
      await db
        .prepare(`UPDATE generations SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'processing'`)
        .bind(nowIso(), generation.id)
        .run()
      await enqueueJob(env, { kind: 'submit', generationId: generation.id })
    } else {
      await failGeneration(env, generation.id, 'submit_failed', 'Provider submission did not complete')
    }
  }

  const now = nowIso()
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    db
      .prepare(`UPDATE orders SET status = 'canceled', updated_at = ? WHERE status = 'pending' AND created_at < ?`)
      .bind(now, new Date(Date.now() - 24 * 3600_000).toISOString()),
    ...expireStatements(db, now),
  ])

  // 年付订阅按月补发积分
  const grants = await grantDueSubscriptions(env)
  if (grants.checked) console.log('subscription grants', grants)

  const swept = await sweepExpiredMedia(env)
  if (swept.uploads || swept.outputs) console.log('retention sweep', swept)
  // 手机传图的中转对象（handoff/）：没被取走的最长保留 1 小时
  const handoff = await sweepHandoff(env)
  if (handoff) console.log('handoff sweep', handoff)

  // 24 小时内的 pending 订单向支付商查单，补救丢失的 webhook（超过 24 小时的已在上面取消，两者不重叠）
  const reconciled = await reconcilePendingOrders(env)
  if (reconciled.checked) console.log('order reconcile sweep', reconciled)
}

function parseMeta(value: string | null): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function minutesSince(iso: string) {
  return (Date.now() - Date.parse(iso)) / 60_000
}
