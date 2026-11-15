import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleUmamiProxy } from '#/server/umami'

const ORIGIN = 'https://umami.example.com'
const env = { UMAMI_ORIGIN: ORIGIN, APP_ENV: 'production' } as Env
const send = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://site.test/s/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

function mockFetch(response: () => Response | Promise<Response>) {
  const fn = vi.fn((..._args: unknown[]) => Promise.resolve(response()))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('handleUmamiProxy', () => {
  it('未配置 UMAMI_ORIGIN 时两个路径都是 404，且不发请求', async () => {
    const fetchMock = mockFetch(() => new Response('x'))
    const empty = { UMAMI_ORIGIN: '' } as Env
    expect((await handleUmamiProxy(new Request('https://site.test/s/script.js'), empty))?.status).toBe(404)
    expect((await handleUmamiProxy(send({ payload: {} }), empty))?.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('非目标路径返回 undefined，目标路径用错方法返回 405', async () => {
    expect(handleUmamiProxy(new Request('https://site.test/s/other.js'), env)).toBeUndefined()
    expect(handleUmamiProxy(new Request('https://site.test/pricing'), env)).toBeUndefined()
    expect((await handleUmamiProxy(new Request('https://site.test/s/script.js', { method: 'POST' }), env))?.status).toBe(405)
    expect((await handleUmamiProxy(new Request('https://site.test/s/api/send'), env))?.status).toBe(405)
  })

  it('script：取 ${origin}/script.js，只保留 Content-Type，加缓存和 noindex', async () => {
    const fetchMock = mockFetch(() => new Response('console.log(1)', { headers: { 'Content-Type': 'text/javascript', Server: 'nginx', 'x-vercel-id': 'abc' } }))
    const response = await handleUmamiProxy(new Request('https://site.test/s/script.js'), env)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${ORIGIN}/script.js`)
    expect(response?.status).toBe(200)
    expect(await response?.text()).toBe('console.log(1)')
    expect(response?.headers.get('Content-Type')).toBe('text/javascript')
    expect(response?.headers.get('Cache-Control')).toBe('public, max-age=86400')
    expect(response?.headers.get('X-Robots-Tag')).toBe('noindex')
    expect(response?.headers.get('server')).toBeNull()
    expect(response?.headers.get('x-vercel-id')).toBeNull()
  })

  it('send：把 CF-Connecting-IP 写进 payload.ip，不转发 Cookie / Authorization，转发 UA 和 x-umami-cache', async () => {
    const fetchMock = mockFetch(
      () => new Response('{"cache":"c"}', { status: 200, headers: { 'Content-Type': 'application/json', Server: 'vercel', 'x-vercel-id': 'iad1::x' } }),
    )
    const request = send(
      { type: 'event', payload: { website: 'w', url: '/', ip: 'spoofed' } },
      { Cookie: 'vt_session=secret', Authorization: 'Bearer secret', 'User-Agent': 'TestUA/1.0', 'x-umami-cache': 'tok', 'CF-Connecting-IP': '203.0.113.9' },
    )
    const response = await handleUmamiProxy(request, env)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${ORIGIN}/api/send`)
    expect(init.method).toBe('POST')
    const sent = new Headers(init.headers)
    expect(sent.get('User-Agent')).toBe('TestUA/1.0')
    expect(sent.get('x-umami-cache')).toBe('tok')
    expect(sent.get('Content-Type')).toBe('application/json')
    expect(sent.has('Cookie')).toBe(false)
    expect(sent.has('Authorization')).toBe(false)
    expect(JSON.parse(init.body as string)).toEqual({ type: 'event', payload: { website: 'w', url: '/', ip: '203.0.113.9' } })
    expect(response?.status).toBe(200)
    expect(await response?.text()).toBe('{"cache":"c"}')
    expect(response?.headers.get('Content-Type')).toBe('application/json')
    expect(response?.headers.get('Cache-Control')).toBe('no-store')
    expect(response?.headers.get('server')).toBeNull()
    expect(response?.headers.get('x-vercel-id')).toBeNull()
  })

  it('send：没有 CF-Connecting-IP（本地开发）时不写 payload.ip', async () => {
    const fetchMock = mockFetch(() => new Response('ok'))
    await handleUmamiProxy(send({ payload: { website: 'w' } }), env)
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({ payload: { website: 'w' } })
  })

  it('非 production（本地 dev、e2e、staging）：send 不转发、script 给空 JS；后台页面不转发', async () => {
    const fetchMock = mockFetch(() => new Response('ok'))
    for (const APP_ENV of ['development', 'staging']) {
      const response = await handleUmamiProxy(send({ payload: { website: 'w', url: '/' } }), { ...env, APP_ENV } as Env)
      expect(response?.status, APP_ENV).toBe(200)
      expect(await response?.json(), APP_ENV).toEqual({ disabled: true })
    }
    for (const url of ['https://site.test/admin', 'https://site.test/admin/orders/ord_1?x=1', '/admin/users']) {
      const response = await handleUmamiProxy(send({ payload: { website: 'w', url } }), env)
      expect(response?.status, url).toBe(200)
      expect(await response?.json(), url).toEqual({})
    }
    // 脚本返回空 JS（不是 502），页面控制台不报错
    for (const APP_ENV of ['development', 'staging']) {
      const script = await handleUmamiProxy(new Request('https://site.test/s/script.js'), { ...env, APP_ENV } as Env)
      expect(script?.status, APP_ENV).toBe(200)
      expect(script?.headers.get('Content-Type'), APP_ENV).toContain('javascript')
    }
    expect(fetchMock).not.toHaveBeenCalled()
    await handleUmamiProxy(send({ payload: { website: 'w', url: 'https://site.test/administrator-guide' } }), env)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('send：超过 16 KB 返回 413，不发请求', async () => {
    const fetchMock = mockFetch(() => new Response('ok'))
    const response = await handleUmamiProxy(send({ payload: { title: 'a'.repeat(17 * 1024) } }), env)
    expect(response?.status).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('send：非法 JSON、非对象、缺少对象类型的 payload 都是 400', async () => {
    const fetchMock = mockFetch(() => new Response('ok'))
    for (const body of ['{not json', '[1]', '"str"', '{}', '{"payload":"x"}', '{"payload":[1]}', '{"payload":null}']) {
      expect((await handleUmamiProxy(send(body), env))?.status, body).toBe(400)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('上游抛错返回 502，响应体不含 origin', async () => {
    mockFetch(() => Promise.reject(new TypeError(`fetch failed: ${ORIGIN}`)) as unknown as Response)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const response = await handleUmamiProxy(send({ payload: { website: 'w' } }), env)
    expect(response?.status).toBe(502)
    expect(await response?.text()).not.toContain('umami.example.com')
    const script = await handleUmamiProxy(new Request('https://site.test/s/script.js'), env)
    expect(script?.status).toBe(502)
    expect(await script?.text()).not.toContain('umami.example.com')
    for (const call of vi.mocked(console.warn).mock.calls) expect(JSON.stringify(call)).not.toContain('umami.example.com')
  })

  it('send：PUBLIC_LIMITER 超限时返回 429，不读取正文也不请求上游', async () => {
    const fetchMock = mockFetch(() => new Response('ok'))
    const limit = vi.fn(async () => ({ success: false }))
    const limitedEnv = { ...env, PUBLIC_LIMITER: { limit } } as unknown as Env
    const response = await handleUmamiProxy(send({ payload: { website: 'w' } }, { 'CF-Connecting-IP': '198.51.100.2' }), limitedEnv)
    expect(limit).toHaveBeenCalledWith({ key: 'umami:198.51.100.2' })
    expect(response?.status).toBe(429)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
