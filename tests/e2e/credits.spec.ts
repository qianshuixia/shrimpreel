import { expect, test } from '@playwright/test'
import { ORIGIN, buyPackage, content, credits, devLogin, durationCredits, json, ledger, pkg, post, uniqueEmail, uploadPhoto } from './helpers'

type Generation = { id: string; status: string }
type Grant = { source: string; amount: number; remaining: number; expires_at: string | null }

const ADMIN_EMAIL = 'admin@example.com'
const STARTER = pkg('starter').credits
const SHORT = durationCredits('short')
const FULL = durationCredits('full')
// 限时补发积分：比 short 少 1，这样一次 short 生成先扣光它、再从购买的积分里扣 1
const BONUS = SHORT - 1

// 积分批次：补发可设有效期，扣费先扣快到期的，生成失败按明细原路退回，到期由 Cron 作废并写 expire 流水
test('积分批次：先扣快到期的补发积分，失败原路退回，到期作废并在账单页提示', async ({ page, playwright }) => {
  test.skip(BONUS < 1, `short 档只要 ${SHORT} 积分，无法构造“先扣限时积分、再扣购买积分”`)
  const userEmail = uniqueEmail('grants')
  const user = await playwright.request.newContext({ baseURL: ORIGIN })
  try {
    const { id: userId } = await devLogin(user, userEmail)
    await buyPackage(user, 'starter') // 永不过期

    await devLogin(page.request, ADMIN_EMAIL)
    page.on('dialog', (dialog) => dialog.accept())
    const grants = async () => (await json<{ grants: Grant[] }>(page.request.get(`/api/admin/users/${userId}`))).grants

    // 扣减不能设有效期
    const bad = await json<{ error: string }>(post(page.request, `/api/admin/users/${userId}/credits`, { delta: -1, note: 'x', expiresInDays: 1 }), 400)
    expect(bad.error).toBe('invalid_expiry')

    await page.goto(`/admin/users/${userId}`)
    await page.getByTestId('admin-delta').fill(String(BONUS))
    await page.getByTestId('admin-expiry-days').fill('1')
    await page.getByTestId('admin-note').fill('e2e 限时补偿')
    await page.getByTestId('admin-adjust').click()
    await expect(page.getByTestId('admin-user-credits')).toHaveText(String(STARTER + BONUS))
    const table = page.getByTestId('admin-user-grants')
    await expect(table.locator('tbody tr')).toHaveCount(2)
    await expect(table.locator('tbody tr').first()).toContainText('admin_adjust')
    await expect(table.locator('tbody tr').first()).toContainText(`${BONUS} / ${BONUS}`)
    await expect(table.locator('tbody tr').last()).toContainText('永不过期')

    // 生成 short 档：先扣到期的补发积分，再扣购买的 1；失败后原路退回
    const { upload } = await json<{ upload: { id: string } }>(uploadPhoto(user), 201)
    const { generation } = await json<{ generation: Generation }>(
      post(user, '/api/generations', { consent: true, uploadId: upload.id, durationId: 'short', mockOutcome: 'fail' }),
      201,
    )
    expect(await credits(user)).toBe(STARTER + BONUS - SHORT)
    expect((await grants()).map((g) => [g.source, g.remaining])).toEqual([['purchase', STARTER - (SHORT - BONUS)]])
    await expect
      .poll(async () => (await json<{ generation: Generation }>(user.get(`/api/generations/${generation.id}`))).generation.status, {
        timeout: 60_000,
        intervals: [1000],
      })
      .toBe('failed')
    expect(await credits(user)).toBe(STARTER + BONUS)
    expect((await grants()).map((g) => [g.source, g.remaining, g.amount])).toEqual([
      ['admin_adjust', BONUS, BONUS],
      ['purchase', STARTER, STARTER],
    ])

    // 账单页提示即将到期的积分
    const expiring = await json<{ expiring: Array<{ credits: number; expiresAt: string }> }>(user.get('/api/credits/expiring'))
    expect(expiring.expiring).toEqual([{ credits: BONUS, expiresAt: expect.any(String) }])
    await devLogin(page.request, userEmail)
    await page.goto('/dashboard/billing')
    await expect(page.getByTestId('credits-expiring')).toContainText(`${BONUS} credits expire on`)
    await expect(page.getByTestId('credits-expiring')).toContainText(content.en.billing.expiringHint)

    // 两天后作废：余额回到购买的积分，expire 流水只写一次
    expect(await json(post(user, '/api/dev/expire-credits', { days: 2 }))).toEqual({ credits: STARTER })
    expect(await json(post(user, '/api/dev/expire-credits', { days: 2 }))).toEqual({ credits: STARTER })
    expect(await credits(user)).toBe(STARTER)
    const entries = await ledger(user)
    expect(entries.filter((e) => e.reason === 'expire').map((e) => e.delta)).toEqual([-BONUS])
    expect(entries.reduce((sum, e) => sum + e.delta, 0)).toBe(STARTER)
    expect((await json<{ expiring: unknown[] }>(user.get('/api/credits/expiring'))).expiring).toEqual([])
    await page.reload()
    await expect(page.getByTestId('ledger-table')).toContainText(content.en.billing.reasons.expire!)
    await expect(page.getByTestId('credits-expiring')).toHaveCount(0)
  } finally {
    await user.dispose()
  }
})

test('并发扣费：余额只够一次时同时发起两个生成，一个成功一个 402，余额不为负', async ({ request, playwright }) => {
  // 余额（购买 + 限时补发）要够一次 full、不够两次
  const RACE_BONUS = 5
  const balance = STARTER + RACE_BONUS
  test.skip(balance < FULL || balance >= 2 * FULL, `余额 ${balance} 不满足“够一次 full(${FULL}) 不够两次”，站点积分包与时长无法构造该场景`)
  const { id: userId } = await devLogin(request, uniqueEmail('race'))
  await buyPackage(request, 'starter')
  const admin = await playwright.request.newContext({ baseURL: ORIGIN })
  try {
    await devLogin(admin, ADMIN_EMAIL)
    await json(post(admin, `/api/admin/users/${userId}/credits`, { delta: RACE_BONUS, note: 'e2e 限时', expiresInDays: 1 }))
  } finally {
    await admin.dispose()
  }
  expect(await credits(request)).toBe(balance)

  const { upload } = await json<{ upload: { id: string } }>(uploadPhoto(request), 201)
  const body = { consent: true, uploadId: upload.id, durationId: 'full', mockOutcome: 'hang' }
  const results = await Promise.all([post(request, '/api/generations', body), post(request, '/api/generations', body)])
  expect(results.map((r) => r.status()).sort()).toEqual([201, 402])
  expect(await credits(request)).toBe(balance - FULL)
  const entries = await ledger(request)
  expect(entries.filter((e) => e.reason === 'generation').map((e) => e.delta)).toEqual([-FULL])
  expect(entries.reduce((sum, e) => sum + e.delta, 0)).toBe(balance - FULL)
})
