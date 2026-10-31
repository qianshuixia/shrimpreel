import handler from '@tanstack/react-start/server-entry'
import { regionalConsentDefault } from './lib/consent'
import { runHealthCheck } from './server/alerts'
import { app } from './server/app'
import { runDailyBackup } from './server/backup'
import { PERMISSIONS_POLICY, contentSecurityPolicy, createNonce } from './server/csp'
import { handleDeadLetterBatch, handleQueueBatch, runScheduledMaintenance } from './server/jobs'
import { runNotificationCron } from './server/notifications'
import { isSeoPath } from './server/seo'
import { SHARE_PAGE, loadShare, shareHttpStatus } from './server/shares'
import { handleUmamiProxy } from './server/umami'
import { isProduction } from './server/util'
import type { VideoJobMessage } from './server/types'

// mock 收银台页面（/checkout/mock、/zh/checkout/mock）：生产环境它调用的接口都是 404，页面本身也不该能打开
const MOCK_CHECKOUT_PAGE = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?checkout\/mock$/i
// 支付结果页：支付商回跳时会附带 email 等参数（Dodo 带买家邮箱），只保留 order
const CHECKOUT_RESULT_PAGE = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?checkout\/success$/i

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': PERMISSIONS_POLICY,
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url)
    const { pathname } = url
    // Umami 同域代理（/s/script.js、/s/api/send）：不走页面和 API 逻辑
    const umami = handleUmamiProxy(request, env)
    if (umami) return withSecurityHeaders(await umami, env, url)
    const toHono = pathname.startsWith('/api/') || pathname.startsWith('/media/') || pathname.startsWith('/i/') || isSeoPath(pathname)
    // 页面统一无尾斜杠：/pricing/ → 301 /pricing（TanStack 默认 307，不传递权重）
    if (!toHono && pathname.length > 1 && pathname.endsWith('/') && (request.method === 'GET' || request.method === 'HEAD')) {
      url.pathname = pathname.replace(/\/+$/, '') || '/'
      return withSecurityHeaders(Response.redirect(url.toString(), 301), env, url)
    }
    // 先 302 去掉多余参数再渲染：邮箱不会进页面、前端统计、错误上报和浏览器历史（第一次请求的 URL 仍会出现在 Workers 日志里）
    if (request.method === 'GET' && CHECKOUT_RESULT_PAGE.test(pathname) && [...url.searchParams.keys()].some((key) => key !== 'order')) {
      const order = url.searchParams.get('order')
      url.search = order ? `?order=${encodeURIComponent(order)}` : ''
      const response = new Response(null, { status: 302, headers: { Location: `${url.pathname}${url.search}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
      return withSecurityHeaders(response, env, url)
    }
    if (isProduction(env) && MOCK_CHECKOUT_PAGE.test(pathname)) {
      return withSecurityHeaders(new Response('Not found', { status: 404, headers: { 'X-Robots-Tag': 'noindex' } }), env, url)
    }
    // 页面请求生成 CSP nonce，经请求上下文交给 router（src/router.tsx 的 ssr.nonce），内联脚本都会带上它
    const nonce = toHono ? undefined : createNonce()
    // 分享页：先查好数据交给页面渲染 OG 标签，失效的链接返回 404/410；页面一律 noindex（用户内容不进搜索引擎）
    const shareId = !toHono && request.method === 'GET' ? pathname.match(SHARE_PAGE)?.[1] : undefined
    const share = shareId !== undefined ? await loadShare(env, shareId) : undefined
    // 统计 Cookie 的地区默认值（见 lib/consent.ts）；页面每次请求都重新渲染（带 nonce），不会把一个国家的结果缓存给另一个国家
    const consentDefault = regionalConsentDefault(request.headers.get('cf-ipcountry'))
    let response = nonce ? await handler.fetch(request, { context: { nonce, share, consentDefault } }) : await app.fetch(request, env, ctx)
    if (share) {
      const headers = new Headers(response.headers)
      headers.set('X-Robots-Tag', 'noindex')
      headers.set('Cache-Control', 'no-store')
      const status = response.status === 200 ? shareHttpStatus(share) : response.status
      response = new Response(response.body, { status, statusText: '', headers })
    }
    if (import.meta.env.DEV) await drainUnreadBody(request)
    return withSecurityHeaders(response, env, url, nonce)
  },

  async queue(batch: MessageBatch<VideoJobMessage>, env: Env) {
    // 死信队列按约定以 -dlq 结尾（wrangler.jsonc 的 dead_letter_queue）
    if (batch.queue.endsWith('-dlq')) await handleDeadLetterBatch(batch, env)
    else await handleQueueBatch(batch, env)
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduledMaintenance(env))
    ctx.waitUntil(runNotificationCron(env))
    ctx.waitUntil(runHealthCheck(env).catch((error) => console.error('[alert] health check failed', error)))
    ctx.waitUntil(runDailyBackup(env).catch((error) => console.error('[alert] d1 backup failed', error)))
  },
} satisfies ExportedHandler<Env, VideoJobMessage>

// 仅本地开发：miniflare 5（wrangler ≥ 4.117 / @cloudflare/vite-plugin ≥ 1.49.1）下，Worker 没读完 request body
// 就返回（CSRF 403、未登录 401 等提前返回），Vite → workerd 复用的连接会让后续请求 500 "fetch failed"。
// 复现：同一连接上连发 3 个带 JSON body 的跨域 POST，第 3 个 500。生产构建里 DEV 为 false，整段被移除
async function drainUnreadBody(request: Request) {
  if (request.body && !request.bodyUsed) await request.arrayBuffer()
}

function withSecurityHeaders(response: Response, env: Env, url: URL, nonce?: string) {
  // 101/WebSocket 等特殊响应不能重建
  if (response.status === 101) return response
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(key)) headers.set(key, value)
  }
  // CSP 只对页面下发（Report-Only 阶段，见 server/csp.ts）；API、媒体和 sitemap 不是 HTML，不需要
  if (nonce && headers.get('Content-Type')?.startsWith('text/html')) {
    headers.set('Content-Security-Policy-Report-Only', contentSecurityPolicy(nonce))
  }
  // HSTS 只在正式站和 staging 的 https 下发（workers.dev 所在的 .dev 顶级域本就在 HSTS 预加载列表里）；本地开发不加
  if (isProduction(env) && url.protocol === 'https:' && !headers.has('Strict-Transport-Security')) {
    headers.set('Strict-Transport-Security', 'max-age=31536000')
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
