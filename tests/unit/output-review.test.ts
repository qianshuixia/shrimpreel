import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { site } from '#/config/site'
import { handleVideoJob } from '#/server/jobs'
import { frameTimes, moderateOutput, outputModerationMode } from '#/server/output-moderation'
import type { GenerationRow } from '#/server/types'
import { ApiError } from '#/server/util'
import type { VideoStatus } from '#/server/video/types'
import { d1Shim, migrate } from './d1-sqlite'

const checkImage = vi.fn()
const providerId = vi.fn(() => 'openai')
vi.mock('#/server/moderation', () => ({ getModerationProvider: () => ({ id: providerId(), checkImage }) }))
const status = vi.fn<(requestId: string, meta: Record<string, unknown>) => Promise<VideoStatus>>()
vi.mock('#/server/video', () => ({ getVideoProvider: vi.fn(() => ({ id: 'fal', status, costCents: () => 0 })) }))
vi.mock('#/server/notifications', () => ({ notifyGenerationFinished: async () => {} }))

const generation = { id: 'gen_1', duration_seconds: 6, provider_meta: null } as unknown as GenerationRow
const frame = new Uint8Array([0xff, 0xd8, 0xff])

function transformBinding(calls: string[] = []) {
  return {
    input: () => ({
      transform: () => ({
        output: (options: { time: string }) => ({
          response: async () => {
            calls.push(options.time)
            return new Response(frame, { status: 200 })
          },
        }),
      }),
    }),
  }
}

function bucketWith(object: Uint8Array | null) {
  return { get: async () => (object ? { body: new Response(object as BodyInit).body } : null) }
}

beforeEach(() => {
  checkImage.mockReset().mockResolvedValue({ allowed: true })
  providerId.mockReturnValue('openai')
  vi.restoreAllMocks()
})

describe('frameTimes', () => {
  it('取 1 秒、中点、80% 处；短片段只取中点；不重复', () => {
    expect(frameTimes(6)).toEqual([1, 3, 4.8])
    expect(frameTimes(12)).toEqual([1, 6, 9.6])
    expect(frameTimes(3)).toEqual([1, 1.5, 2.4])
    expect(frameTimes(2)).toEqual([1])
    expect(frameTimes(1)).toEqual([0.5])
  })
})

describe('outputModerationMode', () => {
  it('缺省按 off；mock 在生产和预发环境不可用；未知值报错', () => {
    expect(outputModerationMode({ APP_ENV: 'production' } as Env)).toBe('off')
    expect(outputModerationMode({ APP_ENV: 'production', OUTPUT_MODERATION: 'frames' } as Env)).toBe('frames')
    expect(outputModerationMode({ APP_ENV: 'development', OUTPUT_MODERATION: 'mock' } as Env)).toBe('mock')
    expect(() => outputModerationMode({ APP_ENV: 'production', OUTPUT_MODERATION: 'mock' } as Env)).toThrow()
    expect(() => outputModerationMode({ APP_ENV: 'staging', OUTPUT_MODERATION: 'mock' } as Env)).toThrow()
    expect(() => outputModerationMode({ OUTPUT_MODERATION: 'all' } as Env)).toThrow()
  })
})

describe('moderateOutput', () => {
  const envOf = (extra: Partial<Env> = {}) =>
    ({ APP_ENV: 'production', OUTPUT_MODERATION: 'frames', MEDIA: bucketWith(frame), MEDIA_TRANSFORM: transformBinding(), ...extra }) as unknown as Env

  it('frames：逐帧审核，三帧都通过才放行', async () => {
    const calls: string[] = []
    const env = envOf({ MEDIA_TRANSFORM: transformBinding(calls) as unknown as MediaBinding })
    expect(await moderateOutput(env, generation, 'k')).toEqual({ allowed: true })
    expect(calls).toEqual(['1s', '3s', '4.8s'])
    expect(checkImage).toHaveBeenCalledTimes(3)
    expect(checkImage).toHaveBeenCalledWith({ bytes: frame, contentType: 'image/jpeg' })
  })

  it('任一帧不通过：立即返回拒绝原因，后面的帧不再检查', async () => {
    checkImage.mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false, reason: 'sexual' })
    expect(await moderateOutput(envOf(), generation, 'k')).toEqual({ allowed: false, reason: 'sexual' })
    expect(checkImage).toHaveBeenCalledTimes(2)
  })

  it('审核服务 503：错误向上抛（队列重试），不判拒绝', async () => {
    checkImage.mockRejectedValue(new ApiError(503, 'moderation_unavailable'))
    await expect(moderateOutput(envOf(), generation, 'k')).rejects.toMatchObject({ status: 503 })
  })

  it('抽帧失败或缺绑定：抛错，不放行', async () => {
    const failing = { input: () => ({ transform: () => ({ output: () => ({ response: async () => new Response('x', { status: 502 }) }) }) }) }
    await expect(moderateOutput(envOf({ MEDIA_TRANSFORM: failing as unknown as MediaBinding }), generation, 'k')).rejects.toThrow('HTTP 502')
    await expect(moderateOutput(envOf({ MEDIA_TRANSFORM: undefined }), generation, 'k')).rejects.toThrow('MEDIA_TRANSFORM')
    expect(checkImage).not.toHaveBeenCalled()
  })

  it('MODERATION_PROVIDER=none：跳过并 warn；off：直接放行', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    providerId.mockReturnValue('none')
    expect(await moderateOutput(envOf(), generation, 'k')).toEqual({ allowed: true })
    expect(warn).toHaveBeenCalled()
    expect(await moderateOutput(envOf({ OUTPUT_MODERATION: 'off' }), generation, 'k')).toEqual({ allowed: true })
    expect(checkImage).not.toHaveBeenCalled()
  })

  it('mock：只有 mockOutcome=output_reject 的任务被拒', async () => {
    const env = envOf({ APP_ENV: 'development', OUTPUT_MODERATION: 'mock' })
    expect(await moderateOutput(env, generation, 'k')).toEqual({ allowed: true })
    const rejected = { ...generation, provider_meta: JSON.stringify({ mockOutcome: 'output_reject' }) } as GenerationRow
    expect(await moderateOutput(env, rejected, 'k')).toEqual({ allowed: false, reason: 'mock_output_reject' })
  })
})

// 轮询到成片后：审核不通过 → 删成片、失败退积分；通过 → 追加 XMP、置 succeeded
describe('jobs：成片输出审核', () => {
  let sqlite: DatabaseSync
  let objects: Map<string, Uint8Array>
  let env: Env

  const ftyp = new Uint8Array(16)
  new DataView(ftyp.buffer).setUint32(0, 16)
  ftyp.set(new TextEncoder().encode('ftyp'), 4)
  const mdat = new Uint8Array(32)
  new DataView(mdat.buffer).setUint32(0, 32)
  mdat.set(new TextEncoder().encode('mdat'), 4)
  const video = new Uint8Array([...ftyp, ...mdat])

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    migrate(sqlite)
    objects = new Map([['templates/src.mp4', video]])
    const bucket = {
      get: async (key: string, options: { range?: { offset: number; length: number } } = {}) => {
        const data = objects.get(key)
        if (!data) return null
        const part = options.range ? data.slice(options.range.offset, options.range.offset + options.range.length) : data
        return { size: data.length, etag: 'e', body: new Response(part as BodyInit).body, httpMetadata: {}, arrayBuffer: async () => part.slice().buffer }
      },
      head: async (key: string) => (objects.has(key) ? { size: objects.get(key)!.length, etag: 'e' } : null),
      put: async (key: string, value: ArrayBuffer | ReadableStream<Uint8Array>) => {
        objects.set(key, new Uint8Array(value instanceof ArrayBuffer ? value : await new Response(value).arrayBuffer()))
        return { etag: 'e' }
      },
      delete: async (key: string) => void objects.delete(key),
    }
    env = {
      DB: d1Shim(sqlite),
      MEDIA: bucket,
      APP_ENV: 'development',
      SITE_URL: 'https://example.com',
      OUTPUT_MODERATION: 'mock',
    } as unknown as Env
    const now = new Date().toISOString()
    sqlite.prepare('INSERT INTO users (id, email, credits, created_at) VALUES (?, ?, 0, ?)').run('usr_1', 'u@example.com', now)
    sqlite
      .prepare(
        `INSERT INTO generations (id, user_id, template_id, duration_id, duration_seconds, credits_cost, upload_id, status, provider,
         provider_request_id, provider_meta, created_at, updated_at) VALUES ('gen_1', 'usr_1', 't', 'short', 6, 6, 'upl_1', 'processing', 'fal', 'job', ?, ?, ?)`,
      )
      .run(JSON.stringify({ mockOutcome: 'output_reject' }), now, now)
    status.mockReset().mockResolvedValue({ state: 'completed', output: { r2Key: 'templates/src.mp4' } })
    // 没有 FixedLengthStream 的 Node 环境
    vi.stubGlobal(
      'FixedLengthStream',
      class extends TransformStream {
        constructor(_length: number) {
          super()
        }
      },
    )
  })

  const row = () => sqlite.prepare('SELECT status, error_code, refunded, output_r2_key FROM generations WHERE id = ?').get('gen_1')

  it('审核不通过：成片被删，任务失败并退回积分，不写 output_r2_key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await handleVideoJob(env, { kind: 'poll', generationId: 'gen_1' })
    expect(row()).toMatchObject({ status: 'failed', error_code: 'output_moderation_rejected', refunded: 1, output_r2_key: null })
    expect(objects.has('outputs/usr_1/gen_1.mp4')).toBe(false)
    expect(sqlite.prepare(`SELECT delta FROM credit_ledger WHERE idempotency_key = 'generation_refund:gen_1'`).get()).toEqual({ delta: 6 })
    expect(warn).toHaveBeenCalledWith('output moderation rejected', { generationId: 'gen_1', reason: 'mock_output_reject' })
  })

  // 站点开关 aiMetadata 默认关闭：测试里按需打开，用完还原
  const aiMetadata = site.aiMetadata as { enabled: boolean }
  afterEach(() => {
    aiMetadata.enabled = false
  })

  it('审核通过但 aiMetadata 关闭（默认）：成片保持原样，直接置为 succeeded', async () => {
    sqlite.prepare(`UPDATE generations SET provider_meta = NULL WHERE id = 'gen_1'`).run()
    await handleVideoJob(env, { kind: 'poll', generationId: 'gen_1' })
    expect(row()).toMatchObject({ status: 'succeeded', output_r2_key: 'outputs/usr_1/gen_1.mp4' })
    expect(objects.get('outputs/usr_1/gen_1.mp4')).toEqual(video)
  })

  it('审核通过且 aiMetadata 开启：成片末尾追加 XMP box 后置为 succeeded', async () => {
    aiMetadata.enabled = true
    sqlite.prepare(`UPDATE generations SET provider_meta = NULL WHERE id = 'gen_1'`).run()
    await handleVideoJob(env, { kind: 'poll', generationId: 'gen_1' })
    expect(row()).toMatchObject({ status: 'succeeded', output_r2_key: 'outputs/usr_1/gen_1.mp4' })
    const stored = objects.get('outputs/usr_1/gen_1.mp4')!
    expect(stored.length).toBeGreaterThan(video.length)
    expect(stored.subarray(0, video.length)).toEqual(video)
    const text = new TextDecoder().decode(stored.subarray(video.length))
    expect(text).toContain('<aivideo:GenerationId>gen_1</aivideo:GenerationId>')
    expect(text).toContain('https://example.com/verify?id=gen_1')
    expect(text).not.toContain('u@example.com')
  })
})
