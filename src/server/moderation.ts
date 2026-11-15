import { ApiError, base64Encode, cleanSecret, isProduction } from './util'

export type ModerationVerdict = { allowed: true } | { allowed: false; reason: string }

export interface ModerationInput {
  bytes: Uint8Array
  contentType: string
  // 仅 mock 使用：'reject' 模拟审核不通过（e2e）
  mockOutcome?: string | null
}

export interface ModerationProvider {
  id: 'openai' | 'none' | 'mock'
  checkImage(input: ModerationInput): Promise<ModerationVerdict>
}

// OpenAI omni-moderation（免费）。图片输入只覆盖 sexual、violence、self-harm 类别；
// 未成年人与名人识别不在其中，仍依赖同意声明 + 举报下架。
// https://developers.openai.com/api/docs/guides/moderation
const OPENAI_IMAGE_CATEGORIES = ['sexual', 'violence/graphic', 'self-harm', 'self-harm/intent', 'self-harm/instructions'] as const

export function createOpenAiModeration(apiKey: string, fetcher: typeof fetch = fetch): ModerationProvider {
  return {
    id: 'openai',
    async checkImage({ bytes, contentType }) {
      let response: Response
      try {
        response = await fetcher('https://api.openai.com/v1/moderations', {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'omni-moderation-latest',
            input: [{ type: 'image_url', image_url: { url: `data:${contentType};base64,${base64Encode(bytes)}` } }],
          }),
          signal: AbortSignal.timeout(15_000),
        })
      } catch (error) {
        console.error('moderation request failed', error)
        throw new ApiError(503, 'moderation_unavailable')
      }
      if (!response.ok) {
        console.error('moderation HTTP', response.status, (await response.text()).slice(0, 300))
        throw new ApiError(503, 'moderation_unavailable')
      }
      const data = (await response.json()) as { results?: Array<{ flagged?: boolean; categories?: Record<string, boolean> }> }
      const result = data.results?.[0]
      if (!result) throw new ApiError(503, 'moderation_unavailable')
      const hits = OPENAI_IMAGE_CATEGORIES.filter((category) => result.categories?.[category])
      return hits.length ? { allowed: false, reason: hits.join(',') } : { allowed: true }
    },
  }
}

function createMockModeration(): ModerationProvider {
  return {
    id: 'mock',
    async checkImage({ mockOutcome }) {
      return mockOutcome === 'reject' ? { allowed: false, reason: 'mock_reject' } : { allowed: true }
    },
  }
}

export function getModerationProvider(env: Env): ModerationProvider {
  const id = env.MODERATION_PROVIDER
  if (id === 'openai') {
    const key = cleanSecret(env.OPENAI_API_KEY)
    if (!key) throw new ApiError(503, 'moderation_not_configured', 'MODERATION_PROVIDER=openai requires OPENAI_API_KEY')
    return createOpenAiModeration(key)
  }
  if (id === 'none') return { id: 'none', checkImage: async () => ({ allowed: true }) }
  if (id === 'mock' && !isProduction(env)) return createMockModeration()
  throw new ApiError(503, 'moderation_not_configured', `Unsupported MODERATION_PROVIDER: ${id}`)
}
