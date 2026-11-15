// Umami 同域代理：页面只加载本站的 /s/script.js，上报也发到 /s/api/send，
// 实例地址（UMAMI_ORIGIN）只存在于 Worker，网页源码和 JS 里看不到

const SCRIPT_PATH = '/s/script.js'
const SEND_PATH = '/s/api/send'
const MAX_BODY_BYTES = 16 * 1024
const UPSTREAM_TIMEOUT_MS = 5000

const text = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers } })

// 不匹配 /s/script.js、/s/api/send 时返回 undefined，交给原有逻辑
export function handleUmamiProxy(request: Request, env: Env): Promise<Response> | undefined {
  const { pathname } = new URL(request.url)
  if (pathname !== SCRIPT_PATH && pathname !== SEND_PATH) return undefined
  const isScript = pathname === SCRIPT_PATH
  const allowed = isScript ? request.method === 'GET' || request.method === 'HEAD' : request.method === 'POST'
  if (!allowed) return Promise.resolve(text('Method not allowed', 405, { Allow: isScript ? 'GET, HEAD' : 'POST' }))
  const origin = (env.UMAMI_ORIGIN ?? '').trim().replace(/\/+$/, '')
  if (!origin) return Promise.resolve(text('Not found', 404))
  // 非 production 不上报（见 proxySend），脚本也不去取：本地 workerd 可能连不上实例，502 会让页面控制台报错
  if (isScript && env.APP_ENV !== 'production') return Promise.resolve(emptyScript())
  return isScript ? proxyScript(origin) : proxySend(request, origin, env)
}

const emptyScript = () =>
  new Response('/* Umami is disabled outside production */\n', {
    status: 200,
    headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  })

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

async function proxyScript(origin: string): Promise<Response> {
  try {
    const upstream = await fetch(`${origin}/script.js`, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      // 脚本很少变，让 Cloudflare 边缘缓存一天，减少对实例的请求
      cf: { cacheTtl: 86400, cacheEverything: true },
    })
    if (!upstream.ok) {
      console.warn('[umami] script upstream status', upstream.status)
      return text('Bad gateway', 502)
    }
    // 只保留 Content-Type，其它上游头会暴露后端
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
        'X-Robots-Tag': 'noindex',
      },
    })
  } catch (error) {
    console.warn('[umami] script upstream failed', error instanceof Error ? error.name : 'unknown')
    return text('Bad gateway', 502)
  }
}

async function proxySend(request: Request, origin: string, env: Env): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP')
  if (env.PUBLIC_LIMITER) {
    const { success } = await env.PUBLIC_LIMITER.limit({ key: `umami:${ip ?? 'local'}` })
    if (!success) return text('Too many requests', 429)
  }
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return text('Payload too large', 413)
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return text('Invalid JSON', 400)
  }
  const payload = isObject(body) ? body.payload : undefined
  if (!isObject(body) || !isObject(payload)) return text('Invalid payload', 400)
  // 只统计正式环境：本地 dev、e2e 和 staging 的 vars 与生产相同，不拦会把测试流量报进正式实例。
  // 返回 disabled 让跟踪脚本在本页停止上报
  if (env.APP_ENV !== 'production') return json({ disabled: true })
  // 后台页面不统计：路径里有订单号、用户 ID，也不是访客流量
  if (isAdminUrl(payload.url)) return json({})
  // Umami 看到 payload.ip 会用它查国家、计算访客；不写则会用 Worker 的出口 IP。本地开发没有这个头。
  // 带 payload.ip 时 Umami 跳过请求头里的地区信息、改查 GeoLite2 库，实例没有库会返回 500（Vercel 上要设 BUILD_GEO=1）。
  // 不能改用 CF-IPCountry 请求头：Worker 发往非 Cloudflare 源站时它会被删掉，Vercel 的 x-vercel-ip-country 又只反映 Worker 出口
  if (ip) payload.ip = ip
  // 请求头白名单：绝不能转发 Cookie、Authorization（站点登录态不能发给第三方）
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const userAgent = request.headers.get('User-Agent')
  if (userAgent) headers['User-Agent'] = userAgent
  const cache = request.headers.get('x-umami-cache')
  if (cache) headers['x-umami-cache'] = cache
  try {
    const upstream = await fetch(`${origin}/api/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    // 响应只保留状态码、body 和 Content-Type
    const responseHeaders: Record<string, string> = { 'Cache-Control': 'no-store' }
    const contentType = upstream.headers.get('Content-Type')
    if (contentType) responseHeaders['Content-Type'] = contentType
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
  } catch (error) {
    // 日志和响应都不带 UMAMI_ORIGIN
    console.warn('[umami] send upstream failed', error instanceof Error ? error.name : 'unknown')
    return text('Bad gateway', 502)
  }
}

function isAdminUrl(url: unknown) {
  if (typeof url !== 'string') return false
  try {
    const { pathname } = new URL(url, 'https://site.invalid')
    return pathname === '/admin' || pathname.startsWith('/admin/')
  } catch {
    return false
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
