// fal.ai queue API：https://docs.fal.ai/model-apis/model-endpoints/queue
// 提交后保存返回的 status_url / response_url（带子路径的模型不能自己拼 URL）。
// webhook 只当“该去查一下了”的信号，结果始终用 API key 重新拉取。
import { site } from '#/config/site'
import { cleanSecret } from '../util'
import type { VideoProvider, VideoStatus } from './types'
import { VideoProviderError } from './types'

export function createFalProvider(env: Env): VideoProvider {
  const key = cleanSecret(env.FAL_KEY)
  const headers = () => {
    if (!key) throw new VideoProviderError('provider_not_configured', 'FAL_KEY missing', false)
    return { Authorization: `Key ${key}`, 'Content-Type': 'application/json' }
  }

  return {
    id: 'fal',
    async submit(input) {
      if (input.imageUrls.length > 1) throw new VideoProviderError('multi_photo_unsupported', 'fal takes one photo', false)
      const url = new URL(`https://queue.fal.run/${site.video.falModel}`)
      url.searchParams.set('fal_webhook', input.webhookUrl)
      const response = await fetch(url, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          video_url: input.sourceVideoUrl,
          image_url: input.imageUrls[0],
          resolution: site.video.resolution,
        }),
      })
      const body = (await response.json().catch(() => null)) as {
        request_id?: string
        status_url?: string
        response_url?: string
        detail?: unknown
      } | null
      if (!response.ok || !body?.request_id || !body.status_url || !body.response_url) {
        throw new VideoProviderError(
          `fal_submit_${response.status}`,
          `fal submit failed: ${JSON.stringify(body?.detail ?? body).slice(0, 300)}`,
          isRetryableStatus(response.status),
        )
      }
      return {
        requestId: body.request_id,
        meta: { statusUrl: body.status_url, responseUrl: body.response_url },
      }
    },

    async status(_requestId, meta): Promise<VideoStatus> {
      const statusUrl = String(meta.statusUrl ?? '')
      const responseUrl = String(meta.responseUrl ?? '')
      if (!statusUrl || !responseUrl) return { state: 'failed', code: 'missing_meta', message: 'fal urls missing' }
      const statusResponse = await fetch(statusUrl, { headers: headers() })
      if (!statusResponse.ok) {
        throw new VideoProviderError(`fal_status_${statusResponse.status}`, 'fal status failed', isRetryableStatus(statusResponse.status))
      }
      const status = (await statusResponse.json()) as { status?: string; error?: string; error_type?: string }
      if (status.status === 'IN_QUEUE' || status.status === 'IN_PROGRESS') return { state: 'pending' }
      if (status.status !== 'COMPLETED') return { state: 'pending' }
      if (status.error) {
        return { state: 'failed', code: status.error_type ?? 'fal_error', message: status.error.slice(0, 500) }
      }
      const resultResponse = await fetch(responseUrl, { headers: headers() })
      const result = (await resultResponse.json().catch(() => null)) as {
        video?: { url?: string }
        detail?: unknown
      } | null
      if (!resultResponse.ok) {
        if (isRetryableStatus(resultResponse.status)) {
          throw new VideoProviderError(`fal_result_${resultResponse.status}`, 'fal result fetch failed', true)
        }
        return {
          state: 'failed',
          code: `fal_result_${resultResponse.status}`,
          message: JSON.stringify(result?.detail ?? result).slice(0, 500),
        }
      }
      if (!result?.video?.url) return { state: 'failed', code: 'fal_no_video', message: 'fal result has no video url' }
      return { state: 'completed', output: { url: result.video.url } }
    },

    costCents: falCostCents,
  }
}

// 计费帧数 = 时长 × 帧率，每 16 帧算 1 个视频秒
export function falCostCents(durationSeconds: number) {
  const { costCentsPerVideoSecond, sourceFps } = site.video
  return Math.round(((durationSeconds * sourceFps) / 16) * costCentsPerVideoSecond)
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 429 || status >= 500
}
