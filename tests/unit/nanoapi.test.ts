import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultStyle, site, type Style } from '#/config/site'
import { createNanoapiProvider, nanoapiCostCents } from '#/server/video/nanoapi'
import { VideoProviderError } from '#/server/video/types'

// NanoAPI 契约：https://nanoapi.ai/docs（provider 只把任务映射成 VideoStatus，退积分、下载成片在 jobs.ts）
const env = (vars: Record<string, string> = {}) =>
  ({ APP_ENV: 'production', SITE_URL: 'https://moonhop.ai', SESSION_SECRET: 'a'.repeat(64), NANOAPI_API_KEY: 'nano_test', ...vars }) as unknown as Env

// 站点会给默认风格配自己的 prompt、scene：用例默认按风格不带 prompt 跑
const plainStyle: Style = { ...defaultStyle, prompt: null, scene: null }

const input = (webhookUrl = 'https://moonhop.ai/api/webhooks/nanoapi?gen=gen_1&token=t', style: Style = plainStyle) => ({
  generationId: 'gen_1',
  style,
  durationSeconds: 12,
  imageUrls: ['https://moonhop.ai/media/uploads/upl_1?exp=1&sig=s'],
  sourceVideoUrl: 'https://moonhop.ai/media/templates/neon-12s.mp4',
  sourceVideoKey: 'templates/neon-12s.mp4',
  webhookUrl,
  meta: {},
})

const ok = (data: unknown) => new Response(JSON.stringify({ code: 200, message: 'ok', data }), { status: 200, headers: { 'Content-Type': 'application/json' } })
const fail = (status: number, type: string, message = `${type} message`) =>
  new Response(JSON.stringify({ code: status, message, error: { type, param: null, details: null }, request_id: 'req_1' }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const task = (id: string, imageUrl: string, videoUrl: string, status = 'queued') => ({ id, status, model: 'genjutsu-1.0', input: { image_urls: [imageUrl], video_url: videoUrl } })
const empty = () => ok({ items: [], has_more: false })

type Route = (url: URL) => Response
// 按“方法 路径”匹配，query 在 route 里自己看
function stubFetch(routes: Record<string, Route>) {
  const calls: Array<{ method: string; url: URL; body: Record<string, unknown> | null; headers: Record<string, string> }> = []
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = new URL(raw)
    const method = init?.method ?? 'GET'
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null, headers: init?.headers as Record<string, string> })
    const route = routes[`${method} ${url.pathname}`]
    if (!route) throw new Error(`unexpected fetch ${method} ${url.pathname}`)
    return route(url)
  })
  return calls
}

// 站点会改自己的 mode、prompt：用例默认按 motion_control、空 prompt 跑，结束后还原站点配置
const nano = site.video.nanoapi as { mode: string; prompt: string }
const siteNano = { mode: nano.mode, prompt: nano.prompt }

beforeEach(() => {
  nano.mode = 'motion_control'
  nano.prompt = ''
})

afterEach(() => {
  vi.unstubAllGlobals()
  Object.assign(nano, siteNano)
})

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error as VideoProviderError
  }
  throw new Error('expected rejection')
}

describe('nanoapi provider：提交', () => {
  it('请求体取自站点配置；空 prompt 不传；只有 HTTPS 回调地址才带 webhook_url', async () => {
    const calls = stubFetch({ 'GET /v1/tasks': empty, 'POST /v1/tasks': () => ok({ id: 'tk_1', status: 'queued' }) })
    const provider = createNanoapiProvider(env())
    expect(await provider.submit(input())).toEqual({ requestId: 'tk_1', meta: {} })
    const posts = () => calls.filter((call) => call.method === 'POST')
    expect(posts()[0]!.headers).toMatchObject({ Authorization: 'Bearer nano_test' })
    expect(posts()[0]!.body).toEqual({
      model: 'genjutsu-1.0',
      mode: 'motion_control',
      image_urls: [input().imageUrls[0]!],
      video_url: input().sourceVideoUrl,
      resolution: site.video.nanoapi.resolution,
      webhook_url: input().webhookUrl,
    })

    await provider.submit(input('http://localhost:3000/api/webhooks/nanoapi?gen=gen_1&token=t'))
    expect(posts()[1]!.body).not.toHaveProperty('webhook_url')

    nano.prompt = 'Replace the dancer'
    nano.mode = 'replace_object'
    await provider.submit(input())
    expect(posts()[2]!.body).toMatchObject({ mode: 'replace_object', prompt: 'Replace the dancer' })

    // 风格自己的 prompt 优先于站点默认
    await provider.submit(input(undefined, { ...plainStyle, prompt: 'Swap in the second dancer' }))
    expect(posts()[3]!.body).toMatchObject({ prompt: 'Swap in the second dancer' })
  })

  it('创建前已有同一个任务（图片和源视频地址都相同）：沿用它的 id，不再创建，不论状态', async () => {
    const calls = stubFetch({
      'GET /v1/tasks': () =>
        ok({
          items: [
            task('tk_other', 'https://moonhop.ai/media/uploads/upl_2?exp=1&sig=x', input().sourceVideoUrl),
            task('tk_same', input().imageUrls[0]!, input().sourceVideoUrl, 'failed'),
          ],
          has_more: false,
        }),
    })
    expect(await createNanoapiProvider(env()).submit(input())).toEqual({ requestId: 'tk_same', meta: {} })
    expect(calls.map((call) => call.method)).toEqual(['GET'])
    // 只查最近 3 小时
    const age = Date.now() - Date.parse(calls[0]!.url.searchParams.get('created_after')!)
    expect(Math.abs(age - 3 * 3600 * 1000)).toBeLessThan(5000)
  })

  it('双人：image_urls 带两张，去重要求任务里包含全部图片地址', async () => {
    const two = [...input().imageUrls, 'https://moonhop.ai/media/uploads/upl_2?exp=1&sig=s2']
    const duo = { ...input(), imageUrls: two }
    const calls = stubFetch({ 'GET /v1/tasks': empty, 'POST /v1/tasks': () => ok({ id: 'tk_1', status: 'queued' }) })
    await createNanoapiProvider(env()).submit(duo)
    expect(calls.find((call) => call.method === 'POST')!.body).toMatchObject({ image_urls: two })

    // 只含第一张的任务不算同一个（别人的单人任务恰好用了同一张图）；两张都在才沿用
    const partial = { id: 'tk_one', status: 'queued', input: { image_urls: [two[0]], video_url: duo.sourceVideoUrl } }
    const full = { id: 'tk_both', status: 'queued', input: { image_urls: [two[1], two[0]], video_url: duo.sourceVideoUrl } }
    stubFetch({ 'GET /v1/tasks': () => ok({ items: [partial], has_more: false }), 'POST /v1/tasks': () => ok({ id: 'tk_new', status: 'queued' }) })
    expect(await createNanoapiProvider(env()).submit(duo)).toEqual({ requestId: 'tk_new', meta: {} })
    stubFetch({ 'GET /v1/tasks': () => ok({ items: [partial, full], has_more: false }) })
    expect(await createNanoapiProvider(env()).submit(duo)).toEqual({ requestId: 'tk_both', meta: {} })
  })

  it('图片地址相同但源视频不同不算同一个任务；去重要翻页找', async () => {
    const calls = stubFetch({
      'GET /v1/tasks': (url) =>
        url.searchParams.get('starting_after') === 'tk_a'
          ? ok({ items: [task('tk_b', input().imageUrls[0]!, input().sourceVideoUrl)], has_more: false })
          : ok({ items: [task('tk_a', input().imageUrls[0]!, 'https://moonhop.ai/media/templates/other.mp4')], has_more: true }),
    })
    expect(await createNanoapiProvider(env()).submit(input())).toEqual({ requestId: 'tk_b', meta: {} })
    expect(calls.map((call) => call.url.searchParams.get('starting_after'))).toEqual([null, 'tk_a'])
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
  })

  it('翻了 5 页还没找到就创建新任务', async () => {
    let page = 0
    const calls = stubFetch({
      'GET /v1/tasks': () => ok({ items: [task(`tk_${++page}`, 'https://x/y', 'https://x/z')], has_more: true }),
      'POST /v1/tasks': () => ok({ id: 'tk_new', status: 'queued' }),
    })
    expect(await createNanoapiProvider(env()).submit(input())).toEqual({ requestId: 'tk_new', meta: {} })
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(5)
  })

  it('去重列表查不了：不创建，抛错并按状态码决定可否重试', async () => {
    for (const [status, type, retryable] of [[503, 'service_unavailable', true], [401, 'invalid_api_key', false]] as const) {
      const calls = stubFetch({ 'GET /v1/tasks': () => fail(status, type) })
      const error = await rejection(createNanoapiProvider(env()).submit(input()))
      expect(error).toMatchObject({ code: `nanoapi_${type}`, retryable })
      expect(calls.some((call) => call.method === 'POST')).toBe(false)
    }
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('network down')
    })
    expect(await rejection(createNanoapiProvider(env()).submit(input()))).toMatchObject({ code: 'nanoapi_list_network', retryable: true })
  })

  it('创建错误映射：402、400、403 不可重试；429、503 可重试；message 带状态码和 request_id、不含密钥', async () => {
    const cases = [
      [402, 'insufficient_balance', false],
      [400, 'invalid_media', false],
      [403, 'account_suspended', false],
      [429, 'rate_limited', true],
      [503, 'service_unavailable', true],
    ] as const
    for (const [status, type, retryable] of cases) {
      stubFetch({ 'GET /v1/tasks': empty, 'POST /v1/tasks': () => fail(status, type) })
      const error = await rejection(createNanoapiProvider(env()).submit(input()))
      expect(error).toBeInstanceOf(VideoProviderError)
      expect(error).toMatchObject({ code: `nanoapi_${type}`, retryable })
      expect(error.message).toContain(`HTTP ${status}`)
      expect(error.message).toContain('request_id=req_1')
      expect(error.message).not.toContain('nano_test')
    }
    stubFetch({ 'GET /v1/tasks': empty, 'POST /v1/tasks': () => new Response('<html>bad gateway</html>', { status: 502 }) })
    expect(await rejection(createNanoapiProvider(env()).submit(input()))).toMatchObject({ code: 'nanoapi_submit_502', retryable: true })
  })

  it('没配 key：不可重试，且不发请求', async () => {
    const calls = stubFetch({})
    const error = await rejection(createNanoapiProvider(env({ NANOAPI_API_KEY: '' })).submit(input()))
    expect(error).toMatchObject({ code: 'provider_not_configured', retryable: false })
    expect(calls).toHaveLength(0)
  })
})

describe('nanoapi provider：查询', () => {
  const statusOf = (data: unknown) => {
    stubFetch({ 'GET /v1/tasks/tk_1': () => ok(data) })
    return createNanoapiProvider(env()).status('tk_1', {})
  }

  it('queued、running 和未知状态都是处理中', async () => {
    for (const status of ['queued', 'running', 'something_new']) expect(await statusOf({ id: 'tk_1', status })).toEqual({ state: 'pending' })
  })

  it('成功：取第一个输出，billing.charged 先截到 6 位再换算美分；没有输出算失败', async () => {
    const done = await statusOf({ id: 'tk_1', status: 'succeeded', outputs: [{ url: 'https://cdn.nanoapi.ai/a.mp4' }], billing: { charged: '0.845000' } })
    expect(done).toEqual({ state: 'completed', output: { url: 'https://cdn.nanoapi.ai/a.mp4' }, costCents: 85 })
    // 没有账单字段时交给 costCents() 估算
    expect(await statusOf({ id: 'tk_1', status: 'succeeded', outputs: [{ url: 'https://cdn.nanoapi.ai/a.mp4' }] })).toMatchObject({ costCents: undefined })
    expect(await statusOf({ id: 'tk_1', status: 'succeeded', outputs: [] })).toMatchObject({ state: 'failed', code: 'nanoapi_no_video' })
  })

  it('失败：错误码带 error.type，只有 generation_failed、queue_timeout、internal_error 可重试', async () => {
    for (const [type, retryable] of [['content_policy', false], ['invalid_media', false], ['generation_failed', true], ['queue_timeout', true], ['internal_error', true]] as const) {
      expect(await statusOf({ id: 'tk_1', status: 'failed', error: { type, message: 'boom' } })).toEqual({
        state: 'failed',
        code: `nanoapi_${type}`,
        message: `${type}: boom`,
        retryable,
      })
    }
  })

  it('任务不存在（404 not_found）不可重试；500 可重试', async () => {
    stubFetch({ 'GET /v1/tasks/tk_1': () => fail(404, 'not_found') })
    expect(await rejection(createNanoapiProvider(env()).status('tk_1', {}))).toMatchObject({ code: 'nanoapi_not_found', retryable: false })
    stubFetch({ 'GET /v1/tasks/tk_1': () => fail(500, 'internal_error') })
    expect(await rejection(createNanoapiProvider(env()).status('tk_1', {}))).toMatchObject({ code: 'nanoapi_internal_error', retryable: true })
  })
})

describe('nanoapiCostCents', () => {
  it('motion_control：秒数四舍五入、至少 4 秒', () => {
    const rate = site.video.nanoapi.costCentsPerSecond
    expect(nanoapiCostCents(2)).toBe(Math.round(4 * rate))
    expect(nanoapiCostCents(4)).toBe(Math.round(4 * rate))
    expect(nanoapiCostCents(5.4)).toBe(Math.round(5 * rate))
    expect(nanoapiCostCents(5.5)).toBe(Math.round(6 * rate))
    expect(nanoapiCostCents(12)).toBe(Math.round(12 * rate))
  })

  it('replace_object：秒数向上取整，没有 4 秒下限', () => {
    nano.mode = 'replace_object'
    const rate = site.video.nanoapi.costCentsPerSecond
    expect(nanoapiCostCents(2)).toBe(Math.round(2 * rate))
    expect(nanoapiCostCents(5.1)).toBe(Math.round(6 * rate))
  })
})
