import type { Style } from '#/config/site'
import { ApiError, isProduction } from '../util'
import { createFalProvider } from './fal'
import { createNanoapiProvider } from './nanoapi'
import { createYirProvider } from './yir'
import type { VideoProvider } from './types'

// mock：本地与 e2e 用。几秒后“完成”，输出直接复制该时长档位的模板源视频。
// 生成请求带 mockOutcome（仅非生产）：'fail' 模拟失败，用于验证自动退积分；'hang' 一直处理中，直到超时、死信或管理员处理。
function createMockProvider(): VideoProvider {
  return {
    id: 'mock',
    async submit(input) {
      return {
        requestId: `mock_${input.generationId}`,
        meta: { ...input.meta, readyAt: Date.now() + 3000, sourceKey: input.sourceVideoKey },
      }
    },
    async status(_requestId, meta) {
      if (meta.mockOutcome === 'hang' || Date.now() < Number(meta.readyAt ?? 0)) return { state: 'pending' }
      if (meta.mockOutcome === 'fail') return { state: 'failed', code: 'mock_failure', message: 'Simulated provider failure' }
      return { state: 'completed', output: { r2Key: String(meta.sourceKey) } }
    },
    costCents: () => 0,
  }
}

export function activeVideoProviderId(env: Env): VideoProvider['id'] {
  if (env.VIDEO_PROVIDER === 'fal') return 'fal'
  if (env.VIDEO_PROVIDER === 'yir') return 'yir'
  if (env.VIDEO_PROVIDER === 'nanoapi') return 'nanoapi'
  if (env.VIDEO_PROVIDER === 'mock' && !isProduction(env)) return 'mock'
  throw new ApiError(503, 'video_not_configured', `Unsupported VIDEO_PROVIDER: ${env.VIDEO_PROVIDER}`)
}

// 生成任务用哪个服务商：风格固定了就用风格的；mock（本地与 e2e）压过一切，这样双人风格也能在 mock 下跑通
export function videoProviderIdForStyle(env: Env, style: Style): VideoProvider['id'] {
  const active = activeVideoProviderId(env)
  if (active === 'mock') return 'mock'
  return style.provider ?? active
}

export function getVideoProvider(env: Env, id: string = activeVideoProviderId(env)): VideoProvider {
  if (id === 'fal') return createFalProvider(env)
  if (id === 'yir') return createYirProvider(env)
  if (id === 'nanoapi') return createNanoapiProvider(env)
  if (id === 'mock' && !isProduction(env)) return createMockProvider()
  throw new ApiError(503, 'video_not_configured', `Unsupported video provider: ${id}`)
}
