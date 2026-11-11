import { expect, test, type Page } from '@playwright/test'
import { articlePath, site } from '../../src/config/site'
import { PERMISSIONS_POLICY } from '../../src/server/csp'
import { PHOTO, SOLO_HOME, buyPackage, content, devLogin, uniqueEmail } from './helpers'

const en = content.en
const CSP = 'content-security-policy-report-only'

// 在页面脚本之前挂上监听：CSP 违规事件和水合报错都汇总到测试进程（exposeFunction 跨导航有效）
async function watch(page: Page) {
  const violations: string[] = []
  const problems: string[] = []
  await page.exposeFunction('__cspViolation', (line: string) => violations.push(line))
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      const report = (window as unknown as { __cspViolation: (line: string) => void }).__cspViolation
      report(`${e.effectiveDirective} ${e.blockedURI || '-'} @ ${location.pathname}`)
    })
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (/hydrat|did not match/i.test(message.text())) problems.push(`${message.type()}: ${message.text()}`)
  })
  return { violations, problems }
}

test('页面下发 CSP Report-Only 和 Permissions-Policy，内联脚本都带本次请求的 nonce；API 不带 CSP', async ({ request }, testInfo) => {
  const nonces: string[] = []
  for (const path of ['/', '/zh', articlePath('trend')]) {
    const res = await request.get(path)
    expect(res.status()).toBe(200)
    const headers = res.headers()
    expect(headers['permissions-policy']).toBe(PERMISSIONS_POLICY)
    // 还在观察期：不能出现强制执行的头
    expect(headers['content-security-policy']).toBeUndefined()
    const policy = headers[CSP] ?? ''
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain('report-uri /api/csp-report')
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/)
    const nonce = policy.match(/'nonce-([^']+)'/)?.[1]
    expect(nonce, policy).toBeTruthy()
    nonces.push(nonce!)

    // 会执行的内联脚本（主题、水合数据等）都要带这个 nonce；JSON-LD 不执行，不受 script-src 限制
    const html = await res.text()
    const inline = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]!).filter((attrs) => !/\bsrc=|application\/ld\+json/.test(attrs))
    expect(inline.length).toBeGreaterThan(0)
    expect(inline.filter((attrs) => !attrs.includes(`nonce="${nonce}"`))).toEqual([])
    if (path === '/') await testInfo.attach('csp.txt', { body: policy, contentType: 'text/plain' })
  }
  // 每次请求的 nonce 都不同
  expect(new Set(nonces).size).toBe(nonces.length)

  const api = await request.get('/api/health')
  expect(api.headers()[CSP]).toBeUndefined()
  expect(api.headers()['x-content-type-options']).toBe('nosniff')
})

test('公开页、登录后生成和后台都没有 CSP 违规与水合错误；不带 nonce 的注入脚本会被报告', async ({ page }, testInfo) => {
  const { violations, problems } = await watch(page)

  for (const path of ['/', '/zh', '/pricing', '/guides', articlePath('howTo'), '/sign-in', '/contact', '/report', '/privacy-policy']) {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
  }
  // 客户端路由切换（不整页刷新）
  await page.goto('/')
  await expect(page.getByTestId('generator-sign-up')).toBeVisible()
  await page.getByRole('link', { name: en.whatIs.guide }).click()
  await expect(page).toHaveURL(new RegExp(`${articlePath('trend')}$`))
  await expect(page).toHaveTitle(`${en.articles.trend.title} | ${site.brandName}`)

  // 登录后完整生成一次：照片预览（blob:）、轮询、成片播放
  await devLogin(page.request, uniqueEmail('csp'))
  await buyPackage(page.request, 'starter')
  await page.goto(SOLO_HOME)
  await expect(page.getByTestId('generate')).toBeVisible()
  await page.getByTestId('photo-input').setInputFiles(PHOTO)
  await page.getByTestId('duration-short').click()
  await page.getByTestId('consent').check()
  await expect(page.getByTestId('generate')).toBeEnabled()
  await page.getByTestId('generate').click()
  await expect(page.getByTestId('generation-status')).toHaveAttribute('data-status', 'succeeded', { timeout: 60_000 })
  await expect(page.getByTestId('generation-video')).toBeVisible()
  await page.goto('/dashboard')
  await page.waitForLoadState('networkidle')

  // 后台
  await devLogin(page.request, 'admin@example.com')
  for (const path of ['/admin', '/admin/generations']) {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
  }
  await testInfo.attach('pages-clean', { body: JSON.stringify({ violations, problems }, null, 2), contentType: 'application/json' })
  expect(violations).toEqual([])
  expect(problems).toEqual([])

  // 反向对照：注入一段不带 nonce 的内联脚本。策略生效时会产生 script-src 违规；Report-Only 阶段脚本照常执行
  await page.evaluate(() => {
    const script = document.createElement('script')
    script.textContent = 'window.__injected = true'
    document.head.appendChild(script)
  })
  await expect.poll(() => violations.length).toBe(1)
  expect(violations[0]).toMatch(/^script-src-elem inline @ \/admin\/generations$/)
  expect(await page.evaluate(() => (window as unknown as { __injected?: boolean }).__injected)).toBe(true)
})

test('CSP 报告接口：不要求同源、只回 204，超大或非 JSON 报告直接丢弃', async ({ request }) => {
  const report = {
    'csp-report': {
      'document-uri': 'https://example.com/checkout/success?email=buyer%40example.com',
      'effective-directive': 'script-src-elem',
      'blocked-uri': 'inline',
    },
  }
  // 浏览器发报告时不一定带 Origin，不能被 CSRF 校验拦下
  const res = await request.post('/api/csp-report', { data: report, headers: { 'content-type': 'application/csp-report' } })
  expect(res.status()).toBe(204)
  expect(await res.text()).toBe('')

  const reportingApi = await request.post('/api/csp-report', {
    data: [{ type: 'csp-violation', body: { documentURL: 'https://example.com/', effectiveDirective: 'img-src', blockedURL: 'https://evil.test/x.png' } }],
    headers: { 'content-type': 'application/reports+json' },
  })
  expect(reportingApi.status()).toBe(204)

  for (const data of ['not json', 'x'.repeat(20_000)]) {
    const dropped = await request.post('/api/csp-report', { data, headers: { 'content-type': 'application/csp-report' } })
    expect(dropped.status()).toBe(204)
  }
  // 其它写接口仍然要求同源
  expect((await request.post('/api/contact', { data: {} })).status()).toBe(403)
})
