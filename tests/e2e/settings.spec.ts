import { expect, test, type APIRequestContext } from '@playwright/test'
import { site } from '../../src/config/site'
import { ORIGIN, SOLO_HOME, SOLO_QUERY, content, credits, devLogin, durationCredits, json, ledger, post, uniqueEmail, uploadPhoto } from './helpers'

// 运营设置是全站共享状态：每个用例前后都把所有参数恢复成默认值，避免影响其他用例
const ADMIN_EMAIL = 'admin@example.com'
type SettingsView = {
  values: Record<string, unknown>
  defaults: Record<string, unknown>
  overrides: Array<{ key: string; updatedBy: string | null }>
}
type AuditEntry = { id: string; action: string; target_type: string; target_id: string; detail: string | null; admin_email: string }

let admin: APIRequestContext

const setSettings = (values: Record<string, unknown>) => json<SettingsView>(post(admin, '/api/admin/settings', { values }))

async function resetSettings() {
  const { values, defaults } = await json<SettingsView>(admin.get('/api/admin/settings'))
  const changed = Object.fromEntries(Object.entries(defaults).filter(([key, value]) => values[key] !== value))
  if (Object.keys(changed).length) await setSettings(changed)
}

const auditEntries = async () => (await json<{ entries: AuditEntry[] }>(admin.get('/api/admin/audit'))).entries

// 新用户（按当前注册赠送拿积分）+ 一张上传好的照片
async function userWithUpload(request: APIRequestContext) {
  const user = await devLogin(request, uniqueEmail('settings'))
  const { upload } = await json<{ upload: { id: string } }>(uploadPhoto(request), 201)
  return { user, uploadId: upload.id }
}
const generate = (request: APIRequestContext, uploadId: string) => post(request, '/api/generations', { consent: true, uploadId, durationId: 'short' })

test.beforeAll(async ({ playwright }) => {
  admin = await playwright.request.newContext({ baseURL: ORIGIN })
  await devLogin(admin, ADMIN_EMAIL)
  await resetSettings()
})
test.afterEach(async () => {
  await resetSettings()
})
test.afterAll(async () => {
  await admin.dispose()
})

test('运营设置只有管理员能读写；未知参数、越界值整体拒绝；未知探测目标 404', async ({ request }) => {
  expect((await request.get('/api/admin/settings')).status()).toBe(401)
  await devLogin(request, uniqueEmail('normal'))
  expect((await request.get('/api/admin/settings')).status()).toBe(403)
  expect((await post(request, '/api/admin/settings', { values: { maintenance: true } })).status()).toBe(403)
  expect((await post(request, '/api/admin/probes/storage', {})).status()).toBe(403)

  const unknown = await json<{ error: string; message: string }>(post(admin, '/api/admin/settings', { values: { signupBonusCredits: 5, FAL_KEY: 'x' } }), 400)
  expect(unknown).toEqual({ error: 'invalid_setting', message: '未知参数：FAL_KEY' })
  const outOfRange = await json<{ message: string }>(post(admin, '/api/admin/settings', { values: { maintenance: true, generationDailyCap: -1 } }), 400)
  expect(outOfRange.message).toContain('全站每日生成上限')
  // 整体拒绝：同一次提交里合法的维护模式也没有保存
  expect((await json<SettingsView>(admin.get('/api/admin/settings'))).values.maintenance).toBe(false)
  expect((await post(admin, '/api/admin/probes/billing', {})).status()).toBe(404)
})

test('注册赠送和有效期改后立即用于新注册用户；改回默认值删掉存值，审计记录前后值', async ({ request, playwright }) => {
  const view = await setSettings({ signupBonusCredits: 7, signupBonusValidDays: 3 })
  expect(view.overrides.map((o) => [o.key, o.updatedBy])).toEqual(
    expect.arrayContaining([
      ['signupBonusCredits', ADMIN_EMAIL],
      ['signupBonusValidDays', ADMIN_EMAIL],
    ]),
  )
  await devLogin(request, uniqueEmail('bonus'))
  expect(await credits(request)).toBe(7)
  expect(await ledger(request)).toEqual([expect.objectContaining({ reason: 'signup_bonus', delta: 7 })])
  const { expiring } = await json<{ expiring: Array<{ credits: number; expiresAt: string }> }>(request.get('/api/credits/expiring'))
  expect(expiring).toHaveLength(1)
  expect(expiring[0]!.credits).toBe(7)
  expect(Math.abs(Date.parse(expiring[0]!.expiresAt) - Date.now() - 3 * 86400_000)).toBeLessThan(10 * 60_000)

  const [entry] = await auditEntries()
  expect(entry).toMatchObject({ action: 'settings.update', target_type: 'settings', target_id: 'runtime', admin_email: ADMIN_EMAIL })
  expect(JSON.parse(entry!.detail!)).toEqual({ signupBonusCredits: { from: 0, to: 7 }, signupBonusValidDays: { from: 0, to: 3 } })

  // 提交未变化的值不写库、不记审计
  await setSettings({ signupBonusCredits: 7 })
  expect((await auditEntries())[0]!.detail).toBe(entry!.detail)

  const restored = await setSettings({ signupBonusCredits: 0, signupBonusValidDays: 0 })
  expect(restored.overrides.map((o) => o.key)).not.toContain('signupBonusCredits')
  const later = await playwright.request.newContext({ baseURL: ORIGIN })
  try {
    await devLogin(later, uniqueEmail('nobonus'))
    expect(await credits(later)).toBe(0)
  } finally {
    await later.dispose()
  }
})

test('维护模式：新生成和下单返回 503，已建订单的支付回调照常入账，管理员不受限；前台显示提示条', async ({ page, request }) => {
  await setSettings({ signupBonusCredits: 10 })
  const { uploadId } = await userWithUpload(request)
  const { orderId } = await json<{ orderId: string }>(post(request, '/api/checkout', { packageId: 'starter', locale: 'en' }))

  await setSettings({ maintenance: true })
  expect(await json(generate(request, uploadId), 503)).toEqual({ error: 'maintenance' })
  expect(await json(post(request, '/api/checkout', { packageId: 'starter', locale: 'en' }), 503)).toEqual({ error: 'maintenance' })
  expect(await credits(request)).toBe(10)
  // 维护前建的订单，付款回调不受影响
  await json(post(request, '/api/mock-payments/complete', { orderId, outcome: 'paid' }))
  expect(await credits(request)).toBeGreaterThan(10)
  // 管理员照常下单，便于维护期间验证
  await json(post(admin, '/api/checkout', { packageId: 'starter', locale: 'en' }))

  await page.goto('/')
  await expect(page.getByTestId('maintenance-notice')).toHaveText(content.en.common.maintenance)
  await page.goto('/zh')
  await expect(page.getByTestId('maintenance-notice')).toHaveText(content.zh.common.maintenance)

  await setSettings({ maintenance: false })
  await json(generate(request, uploadId), 201)
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByTestId('maintenance-notice')).toHaveCount(0)
})

test('暂停收款：价格页按钮变成“支付即将开放”，下单返回 503，生成和已建订单的回调照常，管理员不受限', async ({ page, request }) => {
  await setSettings({ signupBonusCredits: 10 })
  const { uploadId } = await userWithUpload(request)
  const { orderId } = await json<{ orderId: string }>(post(request, '/api/checkout', { packageId: 'starter', locale: 'en' }))

  await setSettings({ checkoutPaused: true })
  expect(await json(post(request, '/api/checkout', { packageId: 'starter', locale: 'en' }), 503)).toEqual({ error: 'checkout_paused' })
  await json(post(request, '/api/mock-payments/complete', { orderId, outcome: 'paid' }))
  expect(await credits(request)).toBeGreaterThan(10)
  await json(generate(request, uploadId), 201)
  await json(post(admin, '/api/checkout', { packageId: 'starter', locale: 'en' }))

  await page.goto('/pricing')
  await expect(page.getByTestId('checkout-paused')).toHaveText(content.en.pricing.pausedNote)
  await expect(page.getByTestId('buy-starter')).toBeDisabled()
  await expect(page.getByTestId('buy-starter')).toHaveText(content.en.pricing.paused)
  await page.goto('/zh/pricing')
  await expect(page.getByTestId('buy-starter')).toHaveText(content.zh.pricing.paused)
  await expect(page.getByTestId('maintenance-notice')).toHaveCount(0)
  // 管理员也看到暂停说明，否则会以为开关没生效；按钮保持可点，便于验证
  await devLogin(page.request, ADMIN_EMAIL)
  await page.goto('/pricing')
  await expect(page.getByTestId('checkout-paused')).toBeVisible()
  await expect(page.getByTestId('buy-starter')).toHaveText(content.en.pricing.buy)
  await expect(page.getByTestId('buy-starter')).toBeEnabled()

  await setSettings({ checkoutPaused: false })
  await page.goto('/pricing')
  await expect(page.getByTestId('buy-starter')).toHaveText(content.en.pricing.buy)
  await expect(page.getByTestId('buy-starter')).toBeEnabled()
  await expect(page.getByTestId('checkout-paused')).toHaveCount(0)
})

test('暂停收款：生成器里的就地购买按钮对普通用户禁用并显示“支付即将开放”', async ({ page }) => {
  const longest = site.durations[site.durations.length - 1]!
  await devLogin(page.request, uniqueEmail('inline-paused'))
  await setSettings({ checkoutPaused: true })

  await page.goto(SOLO_HOME)
  await expect(page.getByTestId('generator-balance')).toBeVisible()
  await page.getByTestId(`duration-${longest.id}`).click()
  await expect(page.getByTestId('generator-buy')).toBeDisabled()
  await expect(page.getByTestId('generator-buy')).toHaveText(content.en.pricing.paused)
  await page.goto(`/zh${SOLO_QUERY}`)
  await expect(page.getByTestId('generator-balance')).toBeVisible()
  await page.getByTestId(`duration-${longest.id}`).click()
  await expect(page.getByTestId('generator-buy')).toHaveText(content.zh.pricing.paused)
})

test('收款渠道：非法渠道连同其它改动整体拒绝、不记审计，下单仍走部署配置；后台下拉显示当前 PAYMENT_PROVIDER', async ({ page, request }) => {
  // 目标支付商配置不全时拒绝切换由 tests/unit/settings.test.ts 覆盖：本地 .dev.vars 各家配得是否齐全因人而异
  const latestAudit = (await auditEntries())[0]?.id
  const rejected = await json<{ message: string }>(post(admin, '/api/admin/settings', { values: { paymentProvider: 'paypal', maintenance: true } }), 400)
  expect(rejected.message).toContain('收款渠道')
  const view = await json<SettingsView>(admin.get('/api/admin/settings'))
  expect(view.values).toMatchObject({ paymentProvider: '', maintenance: false })
  expect((await auditEntries())[0]?.id).toBe(latestAudit)

  await devLogin(request, uniqueEmail('provider'))
  const { url } = await json<{ url: string }>(post(request, '/api/checkout', { packageId: 'starter', locale: 'en' }))
  expect(url).toContain('/checkout/mock')

  await devLogin(page.request, ADMIN_EMAIL)
  await page.goto('/admin/settings')
  const select = page.getByTestId('setting-paymentProvider')
  await expect(select.locator('option').first()).toHaveText('跟随部署配置（PAYMENT_PROVIDER=mock）')
  await expect(select.locator('option')).toHaveText(['跟随部署配置（PAYMENT_PROVIDER=mock）', 'Waffo', 'Dodo Payments', 'Stripe'])
  await expect(select).toHaveValue('')
})

test('全站公告按语言显示，提交时压成一行；清空后不显示', async ({ page }) => {
  const view = await setSettings({ 'announcement.en': 'Spring sale: 20% off', 'announcement.zh': '  春季\n特惠   八折 ' })
  expect(view.values['announcement.zh']).toBe('春季 特惠 八折')

  await page.goto('/')
  await expect(page.getByTestId('site-announcement')).toHaveText('Spring sale: 20% off')
  await expect(page.getByTestId('maintenance-notice')).toHaveCount(0)
  await page.goto('/zh')
  await expect(page.getByTestId('site-announcement')).toHaveText('春季 特惠 八折')

  await setSettings({ 'announcement.en': '' })
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByTestId('site-announcement')).toHaveCount(0)
})

test('全站每日生成上限：达到上限后返回 429 且不扣积分，调高后恢复', async ({ request }) => {
  await setSettings({ signupBonusCredits: 30 })
  const { uploadId } = await userWithUpload(request)
  await setSettings({ generationDailyCap: 1_000_000 })
  await json(generate(request, uploadId), 201)
  const before = await credits(request)

  // 今天至少已有刚才这一个任务，上限 1 时下一个一定超出
  await setSettings({ generationDailyCap: 1 })
  expect(await json(generate(request, uploadId), 429)).toMatchObject({ error: 'daily_limit' })
  expect(await credits(request)).toBe(before)
  expect((await ledger(request)).filter((e) => e.reason === 'generation')).toHaveLength(1)

  await setSettings({ generationDailyCap: 0 })
  await json(generate(request, uploadId), 201)
  expect(await credits(request)).toBe(before - durationCredits('short'))
})

test('后台运营设置页：只提交改动项、显示修改人、恢复默认；测试连接逐项给出结果并记审计', async ({ page }) => {
  await devLogin(page.request, ADMIN_EMAIL)
  await page.goto('/admin/settings')
  const field = page.locator('[data-testid="setting-field"][data-key="signupBonusCredits"]')
  await expect(field).toContainText('使用默认值')
  await expect(page.getByTestId('settings-save')).toHaveText('没有修改')

  await page.getByTestId('setting-signupBonusCredits').fill('5')
  await expect(page.getByTestId('settings-save')).toHaveText('保存 1 项修改')
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('注册赠送积分：0 → 5')
    void dialog.accept()
  })
  await page.getByTestId('settings-save').click()
  await expect(page.getByTestId('settings-message')).toHaveText('已保存 1 项')
  await expect(field).toContainText(`已修改：${ADMIN_EMAIL}`)
  expect((await json<SettingsView>(admin.get('/api/admin/settings'))).values.signupBonusCredits).toBe(5)

  await field.getByRole('button', { name: '恢复默认（0）' }).click()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByTestId('settings-save').click()
  await expect(field).toContainText('使用默认值')

  // 本地是 mock 支付 / 视频 / 审核，发信走本地模拟的 send_email binding
  await page.getByTestId('probe-all').click()
  for (const target of ['storage', 'kv', 'email', 'payment', 'video', 'moderation']) {
    await expect(page.locator(`[data-testid="probe-row"][data-target="${target}"]`).getByTestId('probe-result'), target).toContainText('正常')
  }
  await expect(page.locator('[data-testid="probe-row"][data-target="email"]')).toContainText(`发到 ${ADMIN_EMAIL}`)
  const probes = (await auditEntries()).filter((e) => e.action === 'probe.run').slice(0, 6)
  expect(probes.map((e) => e.target_id).sort()).toEqual(['email', 'kv', 'moderation', 'payment', 'storage', 'video'])
  await page.screenshot({ path: '.tmp/runtime-settings/admin-settings.png', fullPage: true })
})
