import { getModerationProvider, type ModerationVerdict } from './moderation'
import type { GenerationRow } from './types'
import { isProduction } from './util'

// 成片输出审核：成片存进 R2 后、置 succeeded 前，用 Cloudflare Media Transformations 抽几帧，逐帧交给图片审核服务。
// 欧盟禁止生成未经同意的私密内容，输入照片审核之外，输出也要有安全措施。
// frames：抽帧审核（需要 MEDIA_TRANSFORM 绑定）；off：不审核；mock：仅非生产，按生成请求的 mockOutcome 判定（e2e 用）
// 官方文档：https://developers.cloudflare.com/stream/transform-videos/bindings/
export type OutputModerationMode = 'frames' | 'off' | 'mock'

// 抽帧的长边上限（像素）：审核服务对 768 以内的画面足够，base64 后也不会太大
const FRAME_MAX_SIZE = 768
export function outputModerationMode(env: Env): OutputModerationMode {
  // 合并模板前的站点没有这个变量：当作 off
  const mode = env.OUTPUT_MODERATION || 'off'
  if (mode === 'frames' || mode === 'off') return mode
  if (mode === 'mock' && !isProduction(env)) return 'mock'
  throw new Error(`Unsupported OUTPUT_MODERATION: ${mode}`)
}

// 取样时间点（秒）：1 秒、中点、80% 处；片段很短时只取中点。
// 不取“结尾前 1 秒”：服务商出的片可能比请求的略短，抽帧落在片尾之外会一直失败、最后进死信退款
export function frameTimes(durationSeconds: number): number[] {
  if (durationSeconds < 3) return [round1(durationSeconds / 2)]
  return [...new Set([1, round1(durationSeconds / 2), round1(durationSeconds * 0.8)])]
}

const round1 = (value: number) => Math.round(value * 10) / 10

function mockOutcome(generation: GenerationRow) {
  try {
    const meta = JSON.parse(generation.provider_meta ?? '{}') as { mockOutcome?: unknown }
    return typeof meta.mockOutcome === 'string' ? meta.mockOutcome : null
  } catch {
    return null
  }
}

// Media Transformations 的输入上限是 100 MB（不含）；成片更大时抽帧会失败，交给队列重试和死信退款
async function extractFrame(env: Env, key: string, seconds: number) {
  const binding = env.MEDIA_TRANSFORM
  if (!binding) throw new Error('OUTPUT_MODERATION=frames requires the MEDIA_TRANSFORM binding (wrangler "media")')
  const object = await env.MEDIA.get(key)
  if (!object) throw new Error('output moderation: output missing from R2')
  const response = await binding
    .input(object.body)
    .transform({ width: FRAME_MAX_SIZE, height: FRAME_MAX_SIZE, fit: 'scale-down' })
    .output({ mode: 'frame', time: `${seconds}s`, format: 'jpg' })
    .response()
  if (!response.ok) throw new Error(`output moderation: frame extraction failed: HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

// 审核服务不可用（503）时直接抛错：调用方不吞，让队列按退避重试，不判任务失败
export async function moderateOutput(env: Env, generation: GenerationRow, outputKey: string): Promise<ModerationVerdict> {
  const mode = outputModerationMode(env)
  if (mode === 'off') return { allowed: true }
  if (mode === 'mock') return mockOutcome(generation) === 'output_reject' ? { allowed: false, reason: 'mock_output_reject' } : { allowed: true }

  const provider = getModerationProvider(env)
  if (provider.id === 'none') {
    console.warn('output moderation skipped: MODERATION_PROVIDER=none', { generationId: generation.id })
    return { allowed: true }
  }
  for (const seconds of frameTimes(generation.duration_seconds)) {
    const verdict = await provider.checkImage({ bytes: await extractFrame(env, outputKey, seconds), contentType: 'image/jpeg' })
    if (!verdict.allowed) return verdict
  }
  return { allowed: true }
}
