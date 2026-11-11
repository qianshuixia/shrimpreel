import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultStyle, site, type Style } from '#/config/site'
import { signedUploadUrl } from '#/server/media'
import { createYirProvider } from '#/server/video/yir'

// yir 网关契约：https://yir.ai/docs（provider 只把 yir 的 Job 映射成 VideoStatus，退积分、下载成片在 jobs.ts）
const env = (vars: Record<string, string> = {}) =>
  ({ APP_ENV: 'production', SITE_URL: 'https://moonhop.ai', SESSION_SECRET: 'a'.repeat(64), YIR_API_KEY: 'yir_test', ...vars }) as unknown as Env

// style 取站点的默认风格对象本身：withScene 改它的 scene 后，submit 立刻按两步走
const input = (webhookUrl = 'https://moonhop.ai/api/webhooks/yir?gen=gen_1&token=t', style: Style = defaultStyle) => ({
  generationId: 'gen_1',
  style,
  durationSeconds: 12,
  imageUrls: ['https://moonhop.ai/media/uploads/upl_1?exp=1&sig=s'],
  sourceVideoUrl: 'https://moonhop.ai/media/templates/neon-12s.mp4',
  sourceVideoKey: 'templates/neon-12s.mp4',
  webhookUrl,
  meta: {},
})

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const yirError = (status: number, code: string, retryable: boolean, action = 'fix_request') =>
  json(status, { error: { code, message: `${code} message`, retryable, action }, request_id: 'req_1' })

function stubFetch(routes: Record<string, () => Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const path = new URL(url).pathname + new URL(url).search
    const route = routes[path]
    if (!route) throw new Error(`unexpected fetch ${path}`)
    return route()
  })
  return calls
}

// 站点会配置自己的风格 scene、prompt 和 routingOnly：用例默认按单步、默认 prompt、不限定渠道跑，结束后还原站点配置
const yirConfig = site.video.yir as { routingOnly: readonly string[] | null; sceneImage: unknown }
const styleConfig = defaultStyle as { scene: unknown; prompt: string | null }
const siteYir = { routingOnly: yirConfig.routingOnly, sceneImage: yirConfig.sceneImage }
const siteStyle = { scene: styleConfig.scene, prompt: styleConfig.prompt }

beforeEach(() => {
  styleConfig.scene = null
  styleConfig.prompt = null
  yirConfig.routingOnly = null
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  Object.assign(yirConfig, siteYir)
  Object.assign(styleConfig, siteStyle)
})

describe('yir provider：提交', () => {
  it('照片和源视频按 reference 模式提交，幂等键是任务 id；只有 HTTPS 回调地址才带 webhook_url', async () => {
    const calls = stubFetch({ '/v1/videos/generations': () => json(202, { id: 'job_1', object: 'job', status: 'queued' }) })
    const provider = createYirProvider(env())
    expect(await provider.submit(input())).toEqual({ requestId: 'job_1', meta: {} })
    const headers = calls[0]!.init!.headers as Record<string, string>
    expect(headers).toMatchObject({ Authorization: 'Bearer yir_test', 'Idempotency-Key': 'gen_1' })
    const body = JSON.parse(String(calls[0]!.init!.body))
    expect(body).toMatchObject({
      input: {
        type: 'reference',
        references: [
          { role: 'reference_image', url: input().imageUrls[0]! },
          { role: 'reference_video', url: input().sourceVideoUrl },
        ],
      },
      parameters: { duration: 12, aspect_ratio: 'auto', generate_audio: false, n: 1 },
      webhook_url: input().webhookUrl,
    })
    expect(body).not.toHaveProperty('max_cost')
    // 默认不限定渠道，按 API Key 的 Routing Profile 选
    expect(body).not.toHaveProperty('routing')

    await provider.submit(input('http://localhost:3000/api/webhooks/yir?gen=gen_1&token=t'))
    expect(JSON.parse(String(calls[1]!.init!.body))).not.toHaveProperty('webhook_url')
  })

  it('配置了 routingOnly：照片只经过这些渠道', async () => {
    const yir = site.video.yir as { routingOnly: readonly string[] | null }
    const calls = stubFetch({ '/v1/videos/generations': () => json(202, { id: 'job_1', status: 'queued' }) })
    yir.routingOnly = ['official']
    try {
      await createYirProvider(env()).submit(input())
    } finally {
      yir.routingOnly = null
    }
    expect(JSON.parse(String(calls[0]!.init!.body)).routing).toEqual({ only: ['official'] })
  })

  it('重新提交时图片签名地址不变：yir 按请求体识别幂等键，地址变了会 409', async () => {
    const createdAt = Date.parse('2026-10-21T08:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(createdAt + 60_000)
    const first = await signedUploadUrl(env(), 'upl_1', createdAt)
    vi.setSystemTime(createdAt + 30 * 60_000)
    expect(await signedUploadUrl(env(), 'upl_1', createdAt)).toBe(first)
    expect(await signedUploadUrl(env(), 'upl_1')).not.toBe(first)
  })

  it('按 yir 返回的 retryable 决定重投还是失败退积分，错误码原样保留给后台和失败告警', async () => {
    const provider = createYirProvider(env())
    const submitWith = async (response: () => Response) => {
      stubFetch({ '/v1/videos/generations': response })
      return provider.submit(input()).catch((e: unknown) => e)
    }
    // 余额不足：不重投（重投也是 402），任务失败退积分；错误码进失败告警的 topErrors
    expect(await submitWith(() => yirError(402, 'YIR_INSUFFICIENT_BALANCE', false, 'add_funds'))).toMatchObject({
      code: 'YIR_INSUFFICIENT_BALANCE',
      retryable: false,
      message: expect.stringContaining('[add_funds]'),
    })
    // 拉取源视频超时：400 但 yir 标记可重试
    expect(await submitWith(() => yirError(400, 'YIR_INVALID_REQUEST', true, 'retry_later'))).toMatchObject({ retryable: true })
    expect(await submitWith(() => yirError(400, 'YIR_INVALID_REQUEST', false))).toMatchObject({ retryable: false })
    // 网关故障没有错误体：按 HTTP 状态判断
    expect(await submitWith(() => new Response('bad gateway', { status: 502 }))).toMatchObject({ code: 'yir_submit_502', retryable: true })
  })

  it('没配 YIR_API_KEY：不发请求，直接不可重试', async () => {
    const calls = stubFetch({})
    const error = await createYirProvider(env({ YIR_API_KEY: '' })).submit(input()).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'provider_not_configured', retryable: false })
    expect(calls).toHaveLength(0)
  })
})

describe('yir provider：多张照片', () => {
  it('yir 只收一张照片：两张时不可重试地失败，不发请求', async () => {
    const calls = stubFetch({})
    await expect(createYirProvider(env()).submit({ ...input(), imageUrls: ['https://a/1', 'https://a/2'] })).rejects.toMatchObject({
      code: 'multi_photo_unsupported',
      retryable: false,
    })
    expect(calls).toHaveLength(0)
  })
})

describe('yir provider：查询', () => {
  const status = (body: unknown) => () => json(200, { id: 'job_1', error: null, ...(body as object) })

  it('未结束的状态都算处理中，只查轻量的 status 接口', async () => {
    for (const s of ['queued', 'running', 'delivering']) {
      const calls = stubFetch({ '/v1/jobs/job_1/status?wait=0': status({ status: s }) })
      expect(await createYirProvider(env()).status('job_1', {})).toEqual({ state: 'pending' })
      expect(calls).toHaveLength(1)
    }
  })

  it('失败和取消：带上 yir 错误码、上游原因和可重试标记', async () => {
    stubFetch({
      '/v1/jobs/job_1/status?wait=0': status({
        status: 'failed',
        error: { code: 'YIR_INPUT_REJECTED', message: 'Input rejected', retryable: false, action: 'modify_input', provider_error: { provider: 'kling', message: 'video too small' } },
      }),
    })
    expect(await createYirProvider(env()).status('job_1', {})).toEqual({
      state: 'failed',
      code: 'YIR_INPUT_REJECTED',
      message: 'Input rejected (provider: video too small) [modify_input]',
      retryable: false,
    })
    stubFetch({ '/v1/jobs/job_1/status?wait=0': status({ status: 'cancelled' }) })
    expect(await createYirProvider(env()).status('job_1', {})).toMatchObject({ state: 'failed', code: 'yir_cancelled' })
  })

  it('成功：取视频文件（跳过附带的尾帧图片），账单已结算时带实际成本，未结算时交给估算', async () => {
    const job = (billing: unknown, availability = 'available') => () =>
      json(200, {
        id: 'job_1',
        status: 'succeeded',
        error: null,
        result: {
          availability,
          files: availability === 'available'
            ? [
                { url: 'https://cdn.yir.ai/last-frame.png', media_type: 'image/png', expires_at: 1 },
                { url: 'https://cdn.yir.ai/out.mp4', media_type: 'video/mp4', expires_at: 1 },
              ]
            : [],
        },
        billing,
      })
    const routes = (billing: unknown, availability?: string) => ({
      '/v1/jobs/job_1/status?wait=0': status({ status: 'succeeded' }),
      '/v1/jobs/job_1': job(billing, availability),
    })
    const provider = createYirProvider(env())

    stubFetch(routes({ status: 'settled', total_charged_by_yir: '0.845', currency: 'USD' }))
    expect(await provider.status('job_1', {})).toEqual({ state: 'completed', output: { url: 'https://cdn.yir.ai/out.mp4' }, costCents: 85 })

    stubFetch(routes({ status: 'pending', total_charged_by_yir: '0.000' }))
    expect(await provider.status('job_1', {})).toEqual({ state: 'completed', output: { url: 'https://cdn.yir.ai/out.mp4' }, costCents: undefined })

    // 结果文件过了保留期：任务判失败退积分，不会一直轮询
    stubFetch(routes({ status: 'settled', total_charged_by_yir: '0.84' }, 'expired'))
    expect(await provider.status('job_1', {})).toMatchObject({ state: 'failed', code: 'yir_no_video' })
  })

  it('两步走的视频任务：成本 = 合成图 + 视频，合成图账单当时没结算就按配置估算', async () => {
    const routes = {
      '/v1/jobs/job_v/status?wait=0': () => json(200, { id: 'job_v', status: 'succeeded' }),
      '/v1/jobs/job_v': () =>
        json(200, {
          id: 'job_v',
          status: 'succeeded',
          result: { availability: 'available', files: [{ url: 'https://cdn.yir.ai/out.mp4', media_type: 'video/mp4' }] },
          billing: { status: 'settled', total_charged_by_yir: '0.66' },
        }),
    }
    await withScene(async () => {
      stubFetch(routes)
      expect(await createYirProvider(env()).status('job_v', { stage: 'video', sceneCostCents: 1 })).toMatchObject({ costCents: 67 })
      expect(await createYirProvider(env()).status('job_v', { stage: 'video' })).toMatchObject({ costCents: 68 })
    })
  })

  it('查询出错：Job 不存在不可重试，网关故障和限流可重试', async () => {
    const provider = createYirProvider(env())
    stubFetch({ '/v1/jobs/job_1/status?wait=0': () => yirError(404, 'YIR_JOB_NOT_FOUND', false) })
    expect(await provider.status('job_1', {}).catch((e: unknown) => e)).toMatchObject({ code: 'YIR_JOB_NOT_FOUND', retryable: false })
    stubFetch({ '/v1/jobs/job_1/status?wait=0': () => yirError(429, 'YIR_RATE_LIMITED', true, 'retry_later') })
    expect(await provider.status('job_1', {}).catch((e: unknown) => e)).toMatchObject({ retryable: true })
    stubFetch({ '/v1/jobs/job_1/status?wait=0': () => new Response('', { status: 503 }) })
    expect(await provider.status('job_1', {}).catch((e: unknown) => e)).toMatchObject({ code: 'yir_status_503', retryable: true })
  })
})

const SCENE = { frame: 'neon-scene.jpg', prompt: 'Put the person from Image 2 into Image 1.' }
const SCENE_IMAGE = { model: 'google/nano-banana-2', resolution: '1K', aspectRatio: '9:16', costCents: 2, routingOnly: null }

// 给默认风格配上 scene、共用图片模型参数；afterEach 还原
async function withScene(run: () => Promise<void>) {
  styleConfig.scene = SCENE
  yirConfig.sceneImage = SCENE_IMAGE
  await run()
}

describe('yir provider：两步走（先合成首帧，再做动作参考）', () => {
  const sceneJob = (status: string, extra: object = {}) => () => json(200, { id: 'job_s', status, error: null, ...extra })
  const sceneDone = {
    '/v1/jobs/job_s/status?wait=0': sceneJob('succeeded'),
    '/v1/jobs/job_s': sceneJob('succeeded', {
      result: { availability: 'available', files: [{ url: 'https://cdn.yir.ai/scene.jpeg?sig=1', media_type: 'image/jpeg' }] },
      billing: { status: 'settled', total_charged_by_yir: '0.012' },
    }),
    '/scene.jpeg?sig=1': () => new Response(new Uint8Array(1234)),
  }
  const meta = { stage: 'scene', generationId: 'gen_1', durationSeconds: 12, sourceVideoUrl: input().sourceVideoUrl, webhookUrl: input().webhookUrl, prompt: null }

  it('第一步提交图片任务：首帧和照片作为两张参考图，幂等键从任务 id 推出，meta 记下第二步要用的参数', async () => {
    await withScene(async () => {
      const calls = stubFetch({ '/v1/images/generations': () => json(202, { id: 'job_s', status: 'queued' }) })
      expect(await createYirProvider(env()).submit(input())).toEqual({ requestId: 'job_s', meta })
      expect(calls[0]!.init!.headers).toMatchObject({ 'Idempotency-Key': 'gen_1:scene' })
      expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({
        model: 'google/nano-banana-2',
        input: {
          type: 'image',
          references: [
            { role: 'reference_image', url: 'https://moonhop.ai/media/templates/neon-scene.jpg' },
            { role: 'reference_image', url: input().imageUrls[0]! },
          ],
        },
        parameters: { resolution: '1K', aspect_ratio: '9:16', n: 1 },
        webhook_url: input().webhookUrl,
      })
    })
  })

  it('合成图出来后传进 Files API，用 file_id 提交视频任务并进入下一步；重复推进时请求体不变，不会重复计费', async () => {
    await withScene(async () => {
      const upload = (status: string) => () => json(200, { files: [{ id: 'file_1', status, upload: { parts: [{ url: 'https://r2.example/put' }] } }] })
      const routes = (planStatus: string) => ({
        ...sceneDone,
        '/v1/files': upload(planStatus),
        '/put': () => new Response(null, { status: 200 }),
        '/v1/files/file_1/complete': () => json(200, { id: 'file_1', status: 'processing' }),
        '/v1/files/file_1': () => json(200, { id: 'file_1', status: 'ready' }),
        '/v1/videos/generations': () => json(202, { id: 'job_v', status: 'queued' }),
      })
      const first = stubFetch(routes('pending_upload'))
      const expected = { state: 'pending', next: { requestId: 'job_v', meta: { stage: 'video', sceneCostCents: 1 } } }
      expect(await createYirProvider(env()).status('job_s', meta)).toEqual(expected)
      const plan = first.find((c) => c.url.endsWith('/v1/files'))!
      expect(plan.init!.headers).toMatchObject({ 'Idempotency-Key': 'gen_1:scene-file' })
      expect(JSON.parse(String(plan.init!.body))).toEqual({ files: [{ name: 'scene-gen_1.jpg', media_type: 'image/jpeg', size: 1234 }] })
      expect(first.find((c) => c.url === 'https://r2.example/put')!.init!.method).toBe('PUT')
      const video = first.find((c) => c.url.endsWith('/v1/videos/generations'))!
      expect(video.init!.headers).toMatchObject({ 'Idempotency-Key': 'gen_1' })
      expect(JSON.parse(String(video.init!.body)).input.references).toEqual([
        { role: 'reference_image', file_id: 'file_1' },
        { role: 'reference_video', url: input().sourceVideoUrl },
      ])

      // webhook 和定时轮询同时推进：文件已经传完就不再 PUT，视频任务的请求体和幂等键与第一次完全一致
      const again = stubFetch(routes('ready'))
      expect(await createYirProvider(env()).status('job_s', meta)).toEqual(expected)
      expect(again.some((c) => c.url === 'https://r2.example/put')).toBe(false)
      const videoAgain = again.find((c) => c.url.endsWith('/v1/videos/generations'))!
      expect(videoAgain.init!.body).toBe(video.init!.body)
    })
  })

  it('合成图文件还没就绪：继续等，不提交视频任务', async () => {
    await withScene(async () => {
      const calls = stubFetch({
        ...sceneDone,
        '/v1/files': () => json(200, { files: [{ id: 'file_1', status: 'processing' }] }),
        '/v1/files/file_1': () => json(200, { id: 'file_1', status: 'processing' }),
      })
      expect(await createYirProvider(env()).status('job_s', meta)).toEqual({ state: 'pending' })
      expect(calls.some((c) => c.url.includes('/videos/generations'))).toBe(false)
    })
  })

  it('合成失败：任务失败（退积分），错误码原样保留；合成图过了保留期也判失败', async () => {
    await withScene(async () => {
      stubFetch({
        '/v1/jobs/job_s/status?wait=0': sceneJob('failed', {
          error: { code: 'YIR_CONTENT_REJECTED', message: 'Content rejected', retryable: false, action: 'modify_input' },
        }),
      })
      expect(await createYirProvider(env()).status('job_s', meta)).toMatchObject({ state: 'failed', code: 'YIR_CONTENT_REJECTED', retryable: false })
      stubFetch({
        '/v1/jobs/job_s/status?wait=0': sceneJob('succeeded'),
        '/v1/jobs/job_s': sceneJob('succeeded', { result: { availability: 'expired', files: [] } }),
      })
      expect(await createYirProvider(env()).status('job_s', meta)).toMatchObject({ state: 'failed', code: 'yir_no_scene' })
    })
  })

  it('估算成本：风格走两步才加一张合成图', async () => {
    const base = Math.round(12 * site.video.yir.costCentsPerSecond)
    expect(createYirProvider(env()).costCents(12, defaultStyle.id)).toBe(base)
    await withScene(async () => {
      expect(createYirProvider(env()).costCents(12, defaultStyle.id)).toBe(base + 2)
      // 不存在的风格按单步估算
      expect(createYirProvider(env()).costCents(12, 'gone')).toBe(base)
    })
  })

  it('多风格：各风格用自己的首帧、合成 prompt 和视频 prompt；没配 scene 的风格走单步', async () => {
    const other: Style = { ...defaultStyle, id: 'party-v1', prompt: 'Keep the party hat.', scene: { frame: 'party-scene.jpg', prompt: 'Put Image 2 at the party in Image 1.' } }
    const plain: Style = { ...defaultStyle, id: 'plain-v1', prompt: 'Plain prompt.', scene: null }
    yirConfig.sceneImage = SCENE_IMAGE

    const scene = stubFetch({ '/v1/images/generations': () => json(202, { id: 'job_s', status: 'queued' }) })
    const result = await createYirProvider(env()).submit(input(undefined, other))
    const sceneBody = JSON.parse(String(scene[0]!.init!.body))
    expect(sceneBody.input.prompt).toBe('Put Image 2 at the party in Image 1.')
    expect(sceneBody.input.references[0]).toEqual({ role: 'reference_image', url: 'https://moonhop.ai/media/templates/party-scene.jpg' })
    expect(sceneBody).toMatchObject({ model: SCENE_IMAGE.model, parameters: { resolution: '1K', aspect_ratio: '9:16' } })
    // 视频 prompt 随 meta 带到第二步
    expect(result.meta).toMatchObject({ stage: 'scene', prompt: 'Keep the party hat.' })

    const single = stubFetch({ '/v1/videos/generations': () => json(202, { id: 'job_1', status: 'queued' }) })
    expect(await createYirProvider(env()).submit(input(undefined, plain))).toEqual({ requestId: 'job_1', meta: {} })
    expect(JSON.parse(String(single[0]!.init!.body)).input.prompt).toBe('Plain prompt.')
    expect(single.some((c) => c.url.includes('/images/generations'))).toBe(false)
  })
})
