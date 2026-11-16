import { expect, test, type Page } from '@playwright/test'
import { defaultStyle } from '../../src/config/site'
import { content } from '../e2e/helpers'

// 线上只读巡检（playwright.smoke.config.ts）：部署后确认页面能打开、开发与 mock 入口已关闭、未登录拿不到数据、
// 安全响应头和 robots 符合环境。所有 POST 都是必然被拒的请求，不产生订单、积分或邮件。
const BASE = new URL(process.env.SMOKE_BASE_URL!)
const ORIGIN = BASE.origin
const EXPECT = process.env.SMOKE_EXPECT ?? 'production'
if (EXPECT !== 'production' && EXPECT !== 'staging') throw new Error('SMOKE_EXPECT 只能是 production 或 staging')
// 只在本机用生产模式预览验证这套巡检时设为 1：预览没有真实支付商密钥，仍是 mock
const ALLOW_MOCK = process.env.SMOKE_ALLOW_MOCK === '1'

// 收集页面脚本错误（水合失败、chunk 加载失败都会落在这里）
function watchErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

test('健康检查与未登录会话：开发登录关闭，支付商不是 mock', async ({ request }) => {
  const health = await request.get('/api/health')
  expect(health.status()).toBe(200)
  expect(await health.json()).toMatchObject({ ok: true })
  const me = await request.get('/api/me')
  expect(me.status()).toBe(200)
  const session = (await me.json()) as { user: unknown; config: { devLogin: boolean; paymentProvider: string } }
  expect(session).toMatchObject({ user: null, config: { devLogin: false } })
  if (!ALLOW_MOCK) expect(session.config.paymentProvider).not.toBe('mock')
})

test('sitemap 里的页面全部可打开，没有脚本错误', async ({ page, request }) => {
  const sitemap = await request.get('/sitemap.xml')
  expect(sitemap.status()).toBe(200)
  // sitemap 写的是正式域名（canonical）；巡检预发或本地预览时只取路径，套到被测地址上
  const paths = [...new Set([...(await sitemap.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]!).pathname))]
  expect(paths.length).toBeGreaterThan(3)
  const errors = watchErrors(page)
  const failed: string[] = []
  for (const path of paths) {
    const response = await page.goto(path, { waitUntil: 'load' })
    if (response?.status() !== 200) failed.push(`${path} → ${response?.status()}`)
  }
  expect(failed).toEqual([])
  expect(errors).toEqual([])
})

for (const [locale, scheme] of [
  ['en', 'light'],
  ['zh', 'dark'],
] as const) {
  test(`首页（${locale}，${scheme}）水合完成、导航可用`, async ({ page }, testInfo) => {
    const errors = watchErrors(page)
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto(locale === 'en' ? '/' : `/${locale}`)
    // 未登录时生成器显示注册按钮：出现即说明已水合、会话接口可用
    await expect(page.getByTestId('generator-sign-up')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', locale === 'en' ? 'en' : /^zh/)
    await page.getByTestId('nav-sign-in').click()
    await expect(page).toHaveURL(/\/sign-in$/)
    // 会话配置加载完（出现 Google 按钮或“未配置”提示）后，不应有开发登录表单
    const t = content[locale].signIn
    await expect(page.getByRole('link', { name: t.google }).or(page.getByText(t.notConfigured))).toBeVisible()
    await expect(page.getByTestId('dev-login')).toHaveCount(0)
    await testInfo.attach(`home-${locale}-${scheme}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
    expect(errors).toEqual([])
  })
}

test('未登录：个人中心提示登录，后台和用户接口拒绝', async ({ page, request }) => {
  await page.goto('/dashboard')
  await expect(page.getByText(content.en.common.signInRequired)).toBeVisible()
  expect((await request.get('/api/admin/stats')).status()).toBe(401)
  expect((await request.get('/api/orders')).status()).toBe(401)
  expect((await request.get('/api/generations')).status()).toBe(401)
})

test('开发与 mock 入口全部关闭：同源 POST 也是 404，页面也打不开', async ({ request }) => {
  // 开发登录开着说明 APP_ENV 不是 production/staging：这时下面的 POST 可能真的执行（建用户、发告警），直接判失败
  const { config } = (await (await request.get('/api/me')).json()) as { config: { devLogin: boolean } }
  expect(config.devLogin, 'APP_ENV 不是 production/staging，不再发送开发接口请求').toBe(false)
  const devPosts = [
    '/api/auth/dev-login',
    '/api/mock-payments/complete',
    '/api/mock-payments/subscription',
    '/api/dev/subscription-grants',
    '/api/dev/expire-credits',
    '/api/dev/sweep',
    '/api/dev/takedown-reminders',
    '/api/dev/dead-letter',
    '/api/dev/mock-finish',
    '/api/dev/reconcile-sweep',
    '/api/dev/health-check',
    '/api/dev/backup',
  ]
  const wrong: string[] = []
  for (const path of devPosts) {
    // 带同源 Origin，确保过了 CSRF 校验，拿到的是端点本身的结果
    const res = await request.post(path, { data: {}, headers: { origin: ORIGIN } })
    if (res.status() !== 404) wrong.push(`POST ${path} → ${res.status()}`)
  }
  for (const path of ['/api/dev/emails', '/checkout/mock', '/zh/checkout/mock', '/checkout/mock?order=x']) {
    const res = await request.get(path, { maxRedirects: 0 })
    if (res.status() !== 404) wrong.push(`GET ${path} → ${res.status()}`)
  }
  expect(wrong).toEqual([])
})

test('跨站 POST 被 CSRF 拦下；未签名的支付与生成回调被拒', async ({ request }) => {
  const crossSite = await request.post('/api/contact', { data: {}, headers: { origin: 'https://evil.example' } })
  expect(crossSite.status()).toBe(403)
  expect(await crossSite.json()).toMatchObject({ error: 'bad_origin' })
  const noOrigin = await request.delete('/api/account')
  expect(noOrigin.status()).toBe(403)

  const forged = JSON.stringify({ type: 'payment.succeeded', data: { metadata: { orderId: 'smoke' } } })
  for (const path of ['/api/webhooks/waffo', '/api/webhooks/dodo', '/api/webhooks/stripe', '/api/webhooks/fal', '/api/webhooks/yir', '/api/webhooks/nanoapi']) {
    const res = await request.post(path, { data: forged, headers: { 'content-type': 'application/json' } })
    expect(res.status(), path).toBe(401)
    expect(await res.json()).toEqual({ error: 'invalid_webhook' })
  }
})

test('安全响应头：页面带 CSP，https 下有 HSTS，接口不带 CSP', async ({ request }) => {
  const page = await request.get('/')
  const headers = page.headers()
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['x-frame-options']).toBe('SAMEORIGIN')
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
  expect(headers['permissions-policy']).toBeTruthy()
  expect(headers['content-security-policy-report-only']).toMatch(/script-src[^;]*'nonce-/)
  if (BASE.protocol === 'https:') expect(headers['strict-transport-security']).toMatch(/max-age=\d+/)
  const api = (await request.get('/api/health')).headers()
  expect(api['x-content-type-options']).toBe('nosniff')
  expect(api['content-security-policy-report-only']).toBeUndefined()
})

test(`robots.txt 与页面 robots 符合 ${EXPECT}`, async ({ request, page }) => {
  const robots = await (await request.get('/robots.txt')).text()
  await page.goto('/')
  const noindex = page.locator('meta[name="robots"][content*="noindex"]')
  if (EXPECT === 'production') {
    expect(robots).toContain('Allow: /')
    expect(robots).toMatch(/Sitemap: https:\/\//)
    await expect(noindex).toHaveCount(0)
  } else {
    expect(robots).toMatch(/Disallow: \/\s*$/)
  }
})

test('llms.txt 可访问，以站点名开头', async ({ request }) => {
  const res = await request.get('/llms.txt')
  expect(res.status()).toBe(200)
  expect(res.headers()['content-type']).toContain('text/plain')
  expect((await res.text()).startsWith('# ')).toBe(true)
})

test('演示视频支持 Safari Range 206 与 HEAD 探测', async ({ request }) => {
  const demoPath = defaultStyle.examples.original.video
  const partial = await request.get(demoPath, { headers: { range: 'bytes=0-99' } })
  expect(partial.status()).toBe(206)
  expect(partial.headers()['accept-ranges']).toBe('bytes')
  expect(partial.headers()['content-range']).toMatch(/^bytes 0-99\/\d+$/)
  expect((await partial.body()).byteLength).toBe(100)

  const head = await request.head(demoPath)
  expect(head.status()).toBe(200)
  expect(head.headers()['accept-ranges']).toBe('bytes')
  expect(Number(head.headers()['content-length'])).toBeGreaterThan(100)

  const headRange = await request.head(demoPath, { headers: { range: 'bytes=0-99' } })
  expect(headRange.status()).toBe(206)
  expect(headRange.headers()['content-range']).toMatch(/^bytes 0-99\/\d+$/)
})
