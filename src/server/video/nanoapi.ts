// NanoAPI（可选的第三个视频服务商，VIDEO_PROVIDER=nanoapi）：https://nanoapi.ai/docs
// 照片（一张或多张，双人风格两张：第 1 张 = 源视频左边的人）+ 模板源视频提交给 genjutsu（motion_control：照片里的人做源视频的动作；replace_object：把源视频里的对象换成照片里的），
// 两者都给公开 HTTPS 地址，NanoAPI 提交时各下载一次。
// 创建任务没有幂等键：队列重投或 Worker 中断后重新提交会重复扣费，所以创建前先列出最近的任务做去重。
// jobs.ts 传入的 imageUrls 按任务创建时间签名，同一任务每次相同、不同任务一定不同（见 media.ts 的 signedUploadUrl），
// 要求任务里包含全部图片地址并配上源视频地址，就能认出“这个任务已经提交过”，直接拿回它的 id。
// webhook 只当“该去查一下了”的信号，结果始终用 API key 重新拉取（不验签名）。
import { site } from '#/config/site'
import { cleanSecret } from '../util'
import type { VideoProvider, VideoStatus } from './types'
import { VideoProviderError } from './types'

const API = 'https://api.nanoapi.ai/v1'
// 去重只看最近 3 小时：签名图片地址 2 小时过期，超过这个时间的任务不会再被重投
const DEDUPE_WINDOW_MS = 3 * 3600 * 1000
const DEDUPE_PAGE_SIZE = 100
const DEDUPE_MAX_PAGES = 5
// 失败后重试可能成功的任务错误类型；其余（content_policy、invalid_media 等）直接失败退积分
const RETRYABLE_TASK_ERRORS = new Set(['generation_failed', 'queue_timeout', 'internal_error'])

interface NanoapiTaskError {
  type?: string
  message?: string
}

interface NanoapiTask {
  id?: string
  status?: string
  input?: { image_urls?: string[]; video_url?: string }
  outputs?: Array<{ url?: string }>
  billing?: { charged?: string }
  error?: NanoapiTaskError | null
}

interface NanoapiEnvelope<T> {
  code?: number
  message?: string
  data?: T
  error?: { type?: string; param?: string; details?: unknown }
  request_id?: string
}

export function createNanoapiProvider(env: Env): VideoProvider {
  const key = cleanSecret(env.NANOAPI_API_KEY)

  // 有 body 用 POST，否则 GET；网络错误可重试
  async function call<T>(stage: string, path: string, body?: unknown) {
    if (!key) throw new VideoProviderError('provider_not_configured', 'NANOAPI_API_KEY missing', false)
    let response: Response
    try {
      response = await fetch(`${API}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown'
      throw new VideoProviderError(`nanoapi_${stage}_network`, `nanoapi ${stage} network error: ${reason}`.slice(0, 500), true)
    }
    const envelope = (await response.json().catch(() => null)) as NanoapiEnvelope<T> | null
    if (!response.ok || !envelope || envelope.data === undefined) throw requestError(stage, response, envelope)
    return envelope.data
  }

  // 在最近的任务里找已经提交过的同一个任务（不论状态）。列表查不了就抛错，不能盲目创建
  async function findExisting(imageUrls: readonly string[], sourceVideoUrl: string) {
    const createdAfter = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString()
    let startingAfter = ''
    for (let page = 0; page < DEDUPE_MAX_PAGES; page++) {
      const query = `created_after=${encodeURIComponent(createdAfter)}&limit=${DEDUPE_PAGE_SIZE}${startingAfter ? `&starting_after=${encodeURIComponent(startingAfter)}` : ''}`
      const list = await call<{ items?: NanoapiTask[]; has_more?: boolean }>('list', `/tasks?${query}`)
      const items = list.items ?? []
      const found = items.find((task) => task.id && imageUrls.every((url) => task.input?.image_urls?.includes(url)) && task.input?.video_url === sourceVideoUrl)
      if (found?.id) return found.id
      const last = items[items.length - 1]
      if (!list.has_more || !last?.id) return null
      startingAfter = last.id
    }
    return null
  }

  return {
    id: 'nanoapi',
    async submit(input) {
      const existing = await findExisting(input.imageUrls, input.sourceVideoUrl)
      if (existing) return { requestId: existing, meta: {} }
      const { model, mode, resolution } = site.video.nanoapi
      const prompt = input.style.prompt ?? site.video.nanoapi.prompt
      const body: Record<string, unknown> = {
        model,
        mode,
        image_urls: [...input.imageUrls],
        video_url: input.sourceVideoUrl,
        resolution,
      }
      if (prompt) body.prompt = prompt
      // NanoAPI 只接受 HTTPS 回调地址；本地 http 开发环境不带，靠轮询
      if (input.webhookUrl.startsWith('https://')) body.webhook_url = input.webhookUrl
      const task = await call<NanoapiTask>('submit', '/tasks', body)
      if (!task.id) throw new VideoProviderError('nanoapi_submit_no_id', 'nanoapi submit returned no task id', true)
      // 创建时就 failed 的任务也返回 id，由 status() 报失败
      return { requestId: task.id, meta: {} }
    },

    async status(requestId): Promise<VideoStatus> {
      const task = await call<NanoapiTask>('status', `/tasks/${encodeURIComponent(requestId)}`)
      if (task.status === 'succeeded') {
        const url = task.outputs?.[0]?.url
        if (!url) return { state: 'failed', code: 'nanoapi_no_video', message: 'nanoapi task succeeded without an output video' }
        return { state: 'completed', output: { url }, costCents: chargedCents(task) }
      }
      if (task.status === 'failed') {
        const type = task.error?.type ?? 'failed'
        return {
          state: 'failed',
          code: `nanoapi_${type}`,
          message: `${type}: ${task.error?.message ?? 'nanoapi task failed'}`.slice(0, 500),
          retryable: RETRYABLE_TASK_ERRORS.has(type),
        }
      }
      // queued、running 和未知状态都继续轮询
      return { state: 'pending' }
    },

    costCents: nanoapiCostCents,
  }
}

// 估算：motion_control 计费秒数 = 源视频秒数四舍五入、至少 4 秒；replace_object 向上取整。模板源视频时长固定
export function nanoapiCostCents(durationSeconds: number) {
  const { mode, costCentsPerSecond } = site.video.nanoapi
  const billed = mode === 'replace_object' ? Math.ceil(durationSeconds) : Math.max(4, Math.round(durationSeconds))
  return Math.round(billed * costCentsPerSecond)
}

// billing.charged 是 USD 小数字符串（最多 6 位小数）；先截到 6 位再取整，避免 0.845 * 100 = 84.4999… 少记 1 美分
function chargedCents(task: NanoapiTask) {
  if (task.billing?.charged === undefined) return undefined
  const usd = Number(task.billing.charged)
  return Number.isFinite(usd) ? Math.round(Number((usd * 100).toFixed(6))) : undefined
}

// HTTP 错误体是 { code, message, error: { type, param, details }, request_id }，按 error.type 分支
function requestError(stage: string, response: Response, body: NanoapiEnvelope<unknown> | null) {
  const type = body?.error?.type
  const parts = [`nanoapi ${stage} failed (HTTP ${response.status})`, type, body?.message, body?.request_id ? `request_id=${body.request_id}` : undefined]
  return new VideoProviderError(
    type ? `nanoapi_${type}` : `nanoapi_${stage}_${response.status}`,
    parts.filter(Boolean).join(': ').slice(0, 500),
    response.status === 408 || response.status === 429 || response.status >= 500,
  )
}
