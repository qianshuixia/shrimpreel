// yir.ai 网关（可选的第二个视频服务商，VIDEO_PROVIDER=yir）：https://yir.ai/docs
// 照片 + 模板源视频按 reference 模式提交（Kling Motion Control），两者都给公开 HTTPS 地址，yir 提交时各下载一次。
// 风格配了 scene 时分两步：先用图片模型把照片里的人合成进源视频首帧，再拿合成图做动作参考，成片保留源视频的场景。
// Idempotency-Key 从生成任务 id 推出：队列重投或 Worker 中断后重新提交会拿回同一个 Job，不会重复计费。
// yir 按请求体识别同一请求，所以请求体必须每次一致（jobs.ts 里图片签名按任务创建时间算；
// 合成图的结果地址每次查询都重新签名，所以先传进 yir Files API，第二步用固定的 file_id 引用）。
// webhook 只当“该去查一下了”的信号，结果始终用 API key 重新拉取。
import { findStyle, site } from '#/config/site'
import { templateSourceUrl } from '../media'
import { cleanSecret } from '../util'
import type { VideoProvider, VideoStatus } from './types'
import { VideoProviderError } from './types'

const GATEWAY = 'https://gateway.yir.ai/v1'
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])

interface YirError {
  code?: string
  message?: string
  retryable?: boolean
  action?: string
  provider_error?: { message?: string }
}

interface YirFile {
  url?: string
  media_type?: string
}

interface YirJob {
  id?: string
  status?: string
  error?: YirError | null
  result?: { availability?: string; files?: YirFile[] }
  billing?: { status?: string; total_charged_by_yir?: string }
}

interface YirUpload {
  id?: string
  status?: string
  upload?: { parts?: Array<{ url?: string }> }
}

// 两步走第一步时 provider_meta 里记的状态（requestId 是合成图任务）；进入第二步后 meta 换成 { stage: 'video', sceneCostCents }
interface SceneMeta {
  stage: 'scene'
  generationId: string
  durationSeconds: number
  sourceVideoUrl: string
  webhookUrl: string
  prompt: string | null // 风格的 prompt，null 用 site.video.yir.prompt
}

type Reference = { role: 'reference_image'; url: string } | { role: 'reference_image'; file_id: string }
type Failed = Extract<VideoStatus, { state: 'failed' }>

export function createYirProvider(env: Env): VideoProvider {
  const key = cleanSecret(env.YIR_API_KEY)
  const headers = (extra: Record<string, string> = {}) => {
    if (!key) throw new VideoProviderError('provider_not_configured', 'YIR_API_KEY missing', false)
    return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra }
  }

  // 有 body 用 POST，否则 GET
  async function call<T>(stage: string, path: string, body?: unknown, idempotencyKey?: string) {
    const response = await fetch(`${GATEWAY}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: headers(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = (await response.json().catch(() => null)) as (T & { error?: YirError | null }) | null
    if (!response.ok || !data) throw requestError(stage, response, data)
    return data
  }

  // yir 只投递 443 端口的 HTTPS 地址；本地 http 开发环境不带，靠轮询
  function withDelivery(body: Record<string, unknown>, webhookUrl: string, routingOnly: readonly string[] | null) {
    if (routingOnly?.length) body.routing = { only: routingOnly }
    if (webhookUrl.startsWith('https://')) body.webhook_url = webhookUrl
    return body
  }

  async function submitJob(kind: 'videos' | 'images', body: Record<string, unknown>, idempotencyKey: string) {
    const job = await call<YirJob>('submit', `/${kind}/generations`, body, idempotencyKey)
    if (!job.id) throw new VideoProviderError('yir_submit_no_id', 'yir submit returned no job id', true)
    return job.id
  }

  function submitVideo(generationId: string, image: Reference, sourceVideoUrl: string, durationSeconds: number, webhookUrl: string, stylePrompt: string | null) {
    const { model, resolution, routingOnly } = site.video.yir
    const prompt = stylePrompt ?? site.video.yir.prompt
    const body = {
      model,
      input: { type: 'reference', prompt, references: [image, { role: 'reference_video', url: sourceVideoUrl }] },
      parameters: { duration: durationSeconds, resolution, aspect_ratio: 'auto', generate_audio: false, n: 1 },
    }
    return submitJob('videos', withDelivery(body, webhookUrl, routingOnly), generationId)
  }

  // 未结束返回 null；失败或取消返回 failed；成功返回完整 Job（完整 Job 里才有结果文件和账单）
  async function finishedJob(requestId: string): Promise<YirJob | Failed | null> {
    const id = encodeURIComponent(requestId)
    const summary = await call<YirJob>('status', `/jobs/${id}/status?wait=0`)
    if (!summary.status || !TERMINAL.has(summary.status)) return null
    if (summary.status === 'cancelled') return { state: 'failed', code: 'yir_cancelled', message: 'yir job cancelled' }
    if (summary.status === 'failed') {
      const error = summary.error
      return { state: 'failed', code: error?.code ?? 'yir_failed', message: describe(error), retryable: error?.retryable }
    }
    return call<YirJob>('status', `/jobs/${id}`)
  }

  // 把合成图传进 Files API，返回 file_id；文件还在处理时返回 null，下次轮询再来。
  // 幂等键固定，重复调用拿回同一个文件；已经传完的不再 PUT
  async function uploadScene(generationId: string, url: string, mediaType: string) {
    const download = await fetch(url)
    if (!download.ok) throw new VideoProviderError('yir_scene_download', `download scene failed: HTTP ${download.status}`, true)
    const bytes = new Uint8Array(await download.arrayBuffer())
    const ext = mediaType === 'image/png' ? 'png' : mediaType === 'image/webp' ? 'webp' : 'jpg'
    const plan = await call<{ files?: YirUpload[] }>(
      'upload',
      '/files',
      { files: [{ name: `scene-${generationId}.${ext}`, media_type: mediaType, size: bytes.byteLength }] },
      `${generationId}:scene-file`,
    )
    const file = plan.files?.[0]
    if (!file?.id) throw new VideoProviderError('yir_upload_no_id', 'yir upload returned no file id', true)
    const fileId = encodeURIComponent(file.id)
    if (file.status === 'pending_upload') {
      const partUrl = file.upload?.parts?.[0]?.url
      const put = partUrl ? await fetch(partUrl, { method: 'PUT', body: bytes }) : null
      if (!put?.ok) throw new VideoProviderError('yir_upload_put', `upload scene failed: HTTP ${put?.status ?? 'no url'}`, true)
      await call('upload', `/files/${fileId}/complete`, {})
    }
    const current = await call<YirUpload>('upload', `/files/${fileId}`)
    if (current.status === 'ready') return file.id
    if (current.status === 'failed' || current.status === 'expired') {
      throw new VideoProviderError('yir_upload_failed', `yir scene file ${current.status}`, false)
    }
    return null
  }

  async function sceneStatus(requestId: string, meta: SceneMeta): Promise<VideoStatus> {
    const job = await finishedJob(requestId)
    if (!job) return { state: 'pending' }
    if ('state' in job) return job
    const image = job.result?.availability === 'available'
      ? job.result.files?.find((file) => file.url && file.media_type?.startsWith('image/'))
      : undefined
    if (!image?.url || !image.media_type) {
      return { state: 'failed', code: 'yir_no_scene', message: `yir scene unavailable (${job.result?.availability ?? 'missing'})` }
    }
    const fileId = await uploadScene(meta.generationId, image.url, image.media_type)
    if (!fileId) return { state: 'pending' }
    const reference = { role: 'reference_image', file_id: fileId } as const
    const videoId = await submitVideo(meta.generationId, reference, meta.sourceVideoUrl, meta.durationSeconds, meta.webhookUrl, meta.prompt)
    return { state: 'pending', next: { requestId: videoId, meta: { stage: 'video', sceneCostCents: settledCents(job) } } }
  }

  return {
    id: 'yir',
    async submit(input) {
      if (input.imageUrls.length > 1) throw new VideoProviderError('multi_photo_unsupported', 'yir takes one photo', false)
      const photoUrl = input.imageUrls[0]!
      const scene = input.style.scene
      if (!scene) {
        const reference = { role: 'reference_image', url: photoUrl } as const
        const requestId = await submitVideo(input.generationId, reference, input.sourceVideoUrl, input.durationSeconds, input.webhookUrl, input.style.prompt)
        return { requestId, meta: {} }
      }
      // Image 1 是源视频首帧，Image 2 是用户照片，和 scene.prompt 的写法对应
      const image = site.video.yir.sceneImage
      const body = {
        model: image.model,
        input: {
          type: 'image',
          prompt: scene.prompt,
          references: [
            { role: 'reference_image', url: templateSourceUrl(env, scene.frame) },
            { role: 'reference_image', url: photoUrl },
          ],
        },
        parameters: { resolution: image.resolution, aspect_ratio: image.aspectRatio, n: 1 },
      }
      const requestId = await submitJob('images', withDelivery(body, input.webhookUrl, image.routingOnly), `${input.generationId}:scene`)
      const meta: SceneMeta = {
        stage: 'scene',
        generationId: input.generationId,
        durationSeconds: input.durationSeconds,
        sourceVideoUrl: input.sourceVideoUrl,
        webhookUrl: input.webhookUrl,
        prompt: input.style.prompt,
      }
      return { requestId, meta: { ...meta } }
    },

    async status(requestId, meta): Promise<VideoStatus> {
      if (meta.stage === 'scene') return sceneStatus(requestId, meta as unknown as SceneMeta)
      const job = await finishedJob(requestId)
      if (!job) return { state: 'pending' }
      if ('state' in job) return job
      const video = job.result?.availability === 'available'
        ? job.result.files?.find((file) => file.url && file.media_type?.startsWith('video/'))
        : undefined
      if (!video?.url) {
        return { state: 'failed', code: 'yir_no_video', message: `yir result unavailable (${job.result?.availability ?? 'missing'})` }
      }
      // 两步走的成本 = 合成图 + 视频；合成图账单当时还没结算就按配置估算
      const videoCents = settledCents(job)
      const sceneCents = meta.stage !== 'video' ? 0
        : typeof meta.sceneCostCents === 'number' ? meta.sceneCostCents : site.video.yir.sceneImage.costCents
      return { state: 'completed', output: { url: video.url }, costCents: videoCents === undefined ? undefined : videoCents + sceneCents }
    },

    costCents: yirCostCents,
  }
}

// 估算：Motion Control 按参考视频实测秒数计费，参考视频就是模板源视频，时长固定；两步走再加一张合成图
export function yirCostCents(durationSeconds: number, styleId: string) {
  const twoStep = !!findStyle(styleId)?.scene
  return Math.round(durationSeconds * site.video.yir.costCentsPerSecond) + (twoStep ? site.video.yir.sceneImage.costCents : 0)
}

// 账单已结算才是最终金额；还在对账（pending）时返回 undefined，由 costCents() 估算
function settledCents(job: YirJob) {
  if (job.billing?.status !== 'settled') return undefined
  const usd = Number(job.billing.total_charged_by_yir)
  // 金额是 USD 小数字符串（最多 6 位小数）；先截到 6 位再取整，避免 0.845 * 100 = 84.4999… 少记 1 美分
  return Number.isFinite(usd) ? Math.round(Number((usd * 100).toFixed(6))) : undefined
}

function describe(error: YirError | null | undefined) {
  const provider = error?.provider_error?.message
  const message = `${error?.message ?? 'yir job failed'}${provider ? ` (provider: ${provider})` : ''}`
  return error?.action ? `${message} [${error.action}]`.slice(0, 500) : message.slice(0, 500)
}

// HTTP 错误体是 { error: { code, message, retryable, action } }，按 yir 给的 retryable 决定重投还是退积分
function requestError(stage: string, response: Response, body: { error?: YirError | null } | null) {
  const error = body?.error
  return new VideoProviderError(
    error?.code ?? `yir_${stage}_${response.status}`,
    `yir ${stage} failed (HTTP ${response.status}): ${describe(error)}`,
    error?.retryable ?? (response.status === 408 || response.status === 429 || response.status >= 500),
  )
}
