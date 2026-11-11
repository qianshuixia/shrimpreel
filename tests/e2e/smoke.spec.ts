import { expect, test } from '@playwright/test'
import { cheapestPackageCovering, formatPrice, site } from '../../src/config/site'
import { PHOTO, SOLO_HOME, content, credits, devLogin, durationCredits, ledger, pkg, uniqueEmail } from './helpers'

const STARTER = pkg('starter').credits
const SHORT = durationCredits('short')

// 最小主路径：真实 UI 操作，mock 支付 + mock 生成，验证积分、视频、账单三处数据一致
test('新用户：登录 → 购买 → 生成 → 个人中心看到视频与账单', async ({ page }, testInfo) => {
  const shot = async (name: string) => testInfo.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })

  await page.goto('/')
  // 截图会给输入框留下空的 style 属性，水合前截图会触发 React 的属性不一致警告；等会话加载出登录按钮（已水合）再截
  await expect(page.getByTestId('generator-sign-up')).toBeVisible()
  await shot('01-landing')

  await page.getByTestId('nav-sign-in').click()
  await expect(page).toHaveURL(/\/sign-in/)
  await page.getByTestId('dev-email').fill(uniqueEmail('smoke'))
  await page.getByTestId('dev-login').click()
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.getByTestId('dashboard-credits')).toHaveText('0 credits')

  await page.goto('/pricing')
  await page.getByTestId('buy-starter').click()
  await expect(page.getByTestId('mock-checkout')).toBeVisible()
  await shot('02-mock-checkout')
  await page.getByTestId('mock-pay').click()
  await expect(page.getByTestId('checkout-result')).toHaveAttribute('data-status', 'paid')
  await expect(page.getByTestId('nav-credits')).toHaveText(`${STARTER} credits`)
  await shot('03-checkout-paid')

  await page.goto(SOLO_HOME)
  // 按钮出现 = 已水合且会话加载完；之前的输入事件 React 接收不到
  await expect(page.getByTestId('generate')).toBeVisible()
  await page.getByTestId('photo-input').setInputFiles(PHOTO)
  await page.getByTestId('duration-short').click()
  await page.getByTestId('consent').check()
  await expect(page.getByTestId('generate')).toBeEnabled()
  await page.getByTestId('generate').click()
  await expect(page.getByTestId('generation-status')).toHaveAttribute('data-status', 'succeeded', { timeout: 60_000 })
  await expect(page.getByTestId('generation-video')).toBeVisible()
  // 成片带 AI 生成标识与保存期限提示
  await expect(page.getByTestId('generator').getByTestId('ai-badge')).toBeVisible()
  await expect(page.getByTestId('ai-notice')).toContainText('AI-generated')
  await expect(page.getByTestId('nav-credits')).toHaveText(`${STARTER - SHORT} credits`)
  await shot('04-generation-succeeded')

  await page.goto('/dashboard')
  const item = page.getByTestId('video-item')
  await expect(item).toHaveCount(1)
  await expect(item).toHaveAttribute('data-status', 'succeeded')
  await expect(item).toHaveAttribute('data-media', 'available')
  await expect(item.getByTestId('ai-badge')).toBeVisible()
  const src = await item.locator('video').getAttribute('src')
  const video = await page.request.get(src!)
  expect(video.status()).toBe(200)
  expect(video.headers()['content-type']).toBe('video/mp4')
  await shot('05-dashboard')

  await page.goto('/dashboard/billing')
  await expect(page.getByTestId('orders-table').locator('tbody tr')).toHaveCount(1)
  await expect(page.getByTestId('ledger-table').locator('tbody tr')).toHaveCount(2)
  await shot('06-billing')
  const entries = await ledger(page.request)
  expect(entries.map((e) => [e.reason, e.delta]).sort()).toEqual([
    ['generation', -SHORT],
    ['purchase', STARTER],
  ])
})

test('中文站：购买流程全程保持 /zh 前缀', async ({ page }) => {
  await page.goto('/zh/sign-in')
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await page.getByTestId('dev-email').fill(uniqueEmail('zh'))
  await page.getByTestId('dev-login').click()
  await expect(page).toHaveURL(/\/zh\/dashboard$/)

  await page.goto('/zh/pricing')
  await page.getByTestId('buy-party').click()
  await expect(page).toHaveURL(/\/zh\/checkout\/mock\?order=/)
  await page.getByTestId('mock-pay').click()
  await expect(page).toHaveURL(/\/zh\/checkout\/success\?order=/)
  await expect(page.getByTestId('checkout-result')).toHaveAttribute('data-status', 'paid')
})

// 付费墙在想生成的那一刻：余额不足时生成器直接下单够用的最便宜的包，不用先跳价格页
test('生成器就地购买：余额不足时按钮是够用的最便宜的包，点击进收银台，付款后积分到账', async ({ page }) => {
  await devLogin(page.request, uniqueEmail('inline-buy'))
  const balance = await credits(page.request)
  const longest = site.durations[site.durations.length - 1]!
  const shortfall = longest.credits - balance
  expect(shortfall, '注册赠送已够用时本用例没有意义').toBeGreaterThan(0)
  const pack = cheapestPackageCovering(shortfall)!

  await page.goto(SOLO_HOME)
  await expect(page.getByTestId('generator-balance')).toBeVisible()
  await page.getByTestId(`duration-${longest.id}`).click()
  const buy = page.getByTestId('generator-buy')
  await expect(buy).toHaveText(content.en.generator.ctaBuyPack(pack.credits, formatPrice(pack.priceCents, pack.currency)))
  await expect(page.getByTestId('generator-see-packs')).toHaveAttribute('href', '/pricing')
  await buy.click()
  await expect(page.getByTestId('mock-checkout')).toBeVisible()
  await page.getByTestId('mock-pay').click()
  await expect(page.getByTestId('checkout-result')).toHaveAttribute('data-status', 'paid')
  await expect(page.getByTestId('nav-credits')).toHaveText(`${balance + pack.credits} credits`)
})
