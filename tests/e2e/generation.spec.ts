import { expect, test } from '@playwright/test'
import { DISPLAY_STYLES, STYLES, defaultStyle, featuredStyle, formatPrice, site, styleDurations, stylePhotoCount } from '#/config/site'
import { ORIGIN, PHOTO, buyPackage, credits, devLogin, durationCredits, json, ledger, pkg, post, uniqueEmail, uploadPhoto } from './helpers'

type Generation = { id: string; status: string; videoUrl: string | null; templateId: string }

const ADMIN_EMAIL = 'admin@example.com'
const STARTER = pkg('starter').credits
const SHORT = durationCredits('short')
const FULL = durationCredits('full')

test('余额不足返回 402，不产生任务也不产生流水', async ({ request }) => {
  await devLogin(request, uniqueEmail('broke'))
  const { upload } = await json<{ upload: { id: string } }>(uploadPhoto(request), 201)
  const res = await json<{ error: string }>(post(request, '/api/generations', { consent: true, uploadId: upload.id, durationId: 'short' }), 402)
  expect(res.error).toBe('insufficient_credits')
  const { generations } = await json<{ generations: Generation[] }>(request.get('/api/generations'))
  expect(generations).toHaveLength(0)
  expect(await ledger(request)).toHaveLength(0)
})

test('创建生成必须带 consent: true，缺失、为假或不是布尔值都返回 400 且不扣积分', async ({ request }) => {
  await devLogin(request, uniqueEmail('noconsent'))
  await buyPackage(request, 'starter')
  const { upload } = await json<{ upload: { id: string } }>(uploadPhoto(request), 201)
  for (const consent of [undefined, false, 'true', 1]) {
    const res = await json<{ error: string }>(post(request, '/api/generations', { consent, uploadId: upload.id, durationId: 'short' }), 400)
    expect(res.error).toBe('consent_required')
  }
  expect(await credits(request)).toBe(STARTER)
  const { generations } = await json<{ generations: Generation[] }>(request.get('/api/generations'))
  expect(generations).toHaveLength(0)
})

test('上传校验与越权：伪装 JPEG 返回 415，不能用别人的上传发起生成', async ({ request, playwright }) => {
  await devLogin(request, uniqueEmail('owner'))
  const fake = await uploadPhoto(request, Buffer.from('<?php echo "not an image"; ?>'), 'image/jpeg')
  expect(fake.status()).toBe(415)
  const { upload } = await json<{ upload: { id: string } }>(uploadPhoto(request), 201)

  const other = await playwright.request.newContext({ baseURL: ORIGIN })
  try {
    await devLogin(other, uniqueEmail('intruder'))
    await buyPackage(other, 'starter')
    const res = await json<{ error: string }>(post(other, '/api/generations', { consent: true, uploadId: upload.id, durationId: 'short' }), 400)
    expect(res.error).toBe('invalid_upload')
    expect(await credits(other)).toBe(STARTER)
    // 别人的上传图片也不能直接读取
    expect((await other.get(`/media/uploads/${upload.id}`)).status()).not.toBe(200)
  } finally {
    await other.dispose()
  }
})

test('单人风格收到两张照片返回 400 invalid_upload，不扣积分也不产生任务', async ({ request }) => {
  await devLogin(request, uniqueEmail('twophotos'))
  await buyPackage(request, 'starter')
  const first = (await json<{ upload: { id: string } }>(uploadPhoto(request), 201)).upload.id
  const second = (await json<{ upload: { id: string } }>(uploadPhoto(request), 201)).upload.id
  const res = await json<{ error: string }>(post(request, '/api/generations', { consent: true, uploadIds: [first, second], durationId: 'short' }), 400)
  expect(res.error).toBe('invalid_upload')
  expect(await credits(request)).toBe(STARTER)
  const { generations } = await json<{ generations: Generation[] }>(request.get('/api/generations'))
  expect(generations).toHaveLength(0)
})

test('生成失败自动退回积分，失败任务没有视频', async ({ request }) => {
  test.skip(STARTER < FULL, `starter(${STARTER}) 买不起 full(${FULL})，无法构造“扣 full 再退回”`)
  await devLogin(request, uniqueEmail('refund'))
  await buyPackage(request, 'starter')
  const { upload } = await json<{ upload: { id: string } }>(uploadPhoto(request), 201)
  const { generation } = await json<{ generation: Generation }>(
    post(request, '/api/generations', { consent: true, uploadId: upload.id, durationId: 'full', mockOutcome: 'fail' }),
    201,
  )
  expect(await credits(request)).toBe(STARTER - FULL)

  await expect
    .poll(async () => (await json<{ generation: Generation }>(request.get(`/api/generations/${generation.id}`))).generation.status, {
      timeout: 60_000,
      intervals: [1000],
    })
    .toBe('failed')

  expect(await credits(request)).toBe(STARTER)
  const entries = (await ledger(request)).filter((e) => e.ref_id === generation.id)
  expect(entries.map((e) => [e.reason, e.delta]).sort()).toEqual([
    ['generation', -FULL],
    ['generation_refund', FULL],
  ])
  expect((await request.get(`/api/generations/${generation.id}/video`)).status()).toBe(404)
})

// fal webhook 只是“该去查一下”的信号，会和定时轮询同时处理同一个任务：只能一路落库，另一路不能删掉已落库的成片
test('并发轮询只落库一次、成片不被误删；后台记录服务商成本与毛利，未出片的失败任务不记成本', async ({ request, page }) => {
  test.skip(STARTER < 2 * SHORT, `starter(${STARTER}) 不够连续两次 short(${SHORT})`)
  await devLogin(request, uniqueEmail('race'))
  await buyPackage(request, 'starter')
  const start = async (mockOutcome: 'hang' | 'fail') => {
    const { upload } = await json<{ upload: { id: string } }>(uploadPhoto(request), 201)
    const body = { consent: true, uploadId: upload.id, durationId: 'short', mockOutcome }
    return (await json<{ generation: Generation }>(post(request, '/api/generations', body), 201)).generation.id
  }
  const status = async (id: string) => (await json<{ generation: Generation }>(request.get(`/api/generations/${id}`))).generation.status
  const raced = await start('hang')
  const failed = await start('fail')

  await expect.poll(() => status(raced), { timeout: 30_000, intervals: [500] }).toBe('processing')
  expect(await json(post(request, '/api/dev/mock-finish', { generationId: raced, polls: 3 }))).toEqual({ ok: true })
  expect(await status(raced)).toBe('succeeded')
  const video = await request.get(`/api/generations/${raced}/video`)
  expect(video.status()).toBe(200)
  expect((await video.body()).length).toBeGreaterThan(10_000)

  await expect.poll(() => status(failed), { timeout: 60_000, intervals: [1000] }).toBe('failed')
  expect(await credits(request)).toBe(STARTER - SHORT)

  // mock 出片成本为 0（不是 NULL）；没出片的失败任务服务商不计费，成本为 NULL
  await devLogin(page.request, ADMIN_EMAIL)
  type AdminGeneration = { id: string; provider_cost_cents: number | null }
  const admin = await json<{ generations: AdminGeneration[]; revenuePerCreditCents: number | null }>(page.request.get('/api/admin/generations'))
  const cost = (id: string) => admin.generations.find((g) => g.id === id)?.provider_cost_cents
  expect(cost(raced)).toBe(0)
  expect(cost(failed)).toBeNull()
  // 本用例刚付过一笔 USD 订单，每积分实收一定能算出来
  const perCredit = admin.revenuePerCreditCents
  expect(perCredit).toBeGreaterThan(0)

  await page.goto('/admin/generations')
  const cell = (id: string) => page.getByTestId('admin-generations').locator('tr', { hasText: id }).getByTestId('generation-cost')
  await expect(cell(raced)).toHaveText(`$0.00毛利 ${formatPrice(Math.round(SHORT * perCredit!), 'USD')}`)
  await expect(cell(failed)).toHaveText('—')
  await page.goto('/admin')
  await expect(page.getByTestId('admin-margin')).toContainText('近 30 天服务商成本')
  await expect(page.getByTestId('admin-margin')).toContainText('估算毛利')
})

test('风格：不带 styleId 用默认风格，不存在的风格返回 400 invalid_style 且不扣积分', async ({ request }) => {
  await devLogin(request, uniqueEmail('style-api'))
  await buyPackage(request, 'starter')
  const start = async (extra: Record<string, unknown>, status: number) => {
    const { upload } = await json<{ upload: { id: string } }>(uploadPhoto(request), 201)
    return json<{ generation: Generation; error: string }>(post(request, '/api/generations', { consent: true, uploadId: upload.id, durationId: 'short', ...extra }), status)
  }

  const bad = await start({ styleId: 'no-such-style' }, 400)
  expect(bad.error).toBe('invalid_style')
  expect(await credits(request)).toBe(STARTER)
  expect(((await json<{ generations: Generation[] }>(request.get('/api/generations'))).generations)).toHaveLength(0)

  const fallback = await start({ mockOutcome: 'hang' }, 201)
  expect(fallback.generation.templateId).toBe(defaultStyle.id)
  expect(await credits(request)).toBe(STARTER - SHORT)
})

test.describe('多风格站点', () => {
  // 生成流程用单人风格走；双人风格由下面的“双人风格”用例覆盖
  // 第二个风格 = 界面上主推风格以外的第一个单人风格
  const SECOND = DISPLAY_STYLES.slice(1).find((s) => stylePhotoCount(s) === 1)
  test.skip(STYLES.length < 2 || !SECOND, '站点只有一种风格，或主推风格以外都是双人风格')

  test('首页切换 hero 标签与生成器同步，选第二个风格生成，记录里是所选风格；?style= 可预选', async ({ page }) => {
    const second = SECOND!
    await devLogin(page.request, uniqueEmail('style-ui'))
    await buyPackage(page.request, 'starter')

    // SSR 默认显示主推风格（没设就是默认风格），标签按主推在前排序；点第二个标签后素材和生成器的选中项一起切换
    await page.goto('/')
    await page.waitForLoadState('networkidle') // 等水合完成再点，否则点击落在还没绑事件的 SSR 按钮上
    await expect(page.getByRole('tablist')).toBeVisible()
    await expect(page.getByRole('tab').first()).toHaveAttribute('data-testid', `hero-tab-${featuredStyle.id}`)
    await expect(page.getByTestId(`hero-tab-${featuredStyle.id}`)).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId(`style-${featuredStyle.id}`)).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId(`hero-tab-${second.id}`).click()
    await expect(page.getByTestId(`hero-tab-${second.id}`)).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId(`style-${second.id}`)).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator(`[role="tabpanel"] video[src="${second.examples.original.video}"]`)).toHaveCount(1)
    // “Made with”每个风格各一行，不依赖 JS
    for (const style of STYLES) await expect(page.getByTestId(`made-with-${style.id}`)).toBeVisible()

    // 键盘：方向键在标签间移动并选中
    await page.getByTestId(`hero-tab-${second.id}`).focus()
    await page.keyboard.press('ArrowLeft')
    const prev = DISPLAY_STYLES[(DISPLAY_STYLES.indexOf(second) - 1 + DISPLAY_STYLES.length) % DISPLAY_STYLES.length]!
    await expect(page.getByTestId(`hero-tab-${prev.id}`)).toHaveAttribute('aria-selected', 'true')

    await page.getByTestId(`style-${second.id}`).click()
    await page.getByTestId('photo-input').setInputFiles(PHOTO)
    await page.getByTestId(`duration-${styleDurations(second)[0]!.id}`).click()
    await page.getByTestId('consent').check()
    await expect(page.getByTestId('generate')).toBeEnabled()
    await page.getByTestId('generate').click()
    await expect(page.getByTestId('generation-status')).toHaveAttribute('data-status', 'succeeded', { timeout: 60_000 })
    const { generations } = await json<{ generations: Generation[] }>(page.request.get('/api/generations'))
    expect(generations.map((g) => g.templateId)).toEqual([second.id])

    // ?style= 预选；无效的 id 忽略
    await page.goto(`/?style=${second.id}`)
    await expect(page.getByTestId(`style-${second.id}`)).toHaveAttribute('aria-checked', 'true')
    await page.goto('/?style=no-such-style')
    await expect(page.getByTestId(`style-${featuredStyle.id}`)).toHaveAttribute('aria-checked', 'true')
    expect(site.styles.length).toBeGreaterThan(1)
  })
})

const DUO = STYLES.find((s) => stylePhotoCount(s) === 2)

test.describe('双人风格', () => {
  test.skip(!DUO, '站点没有双人风格（photos: 2）')
  const longest = DUO ? styleDurations(DUO)[styleDurations(DUO).length - 1]! : null

  test('选双人风格：两个照片槽，少一张不能生成；两张上传后用 mock 生成成功，扣该风格时长的积分；API 只给一张返回 400', async ({ page }) => {
    const duo = DUO!
    const cost = longest!.credits
    test.skip(STARTER < cost, `starter(${STARTER}) 买不起 ${longest!.id}(${cost})`)
    await devLogin(page.request, uniqueEmail('duo'))
    await buyPackage(page.request, 'starter')

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    if (STYLES.length > 1) await page.getByTestId(`style-${duo.id}`).click()
    await expect(page.getByTestId('photo-input-2')).toHaveCount(1)
    // 时长档位是该风格自己的：每档都有卡片
    for (const d of styleDurations(duo)) await expect(page.getByTestId(`duration-${d.id}`)).toBeVisible()
    await page.getByTestId(`duration-${longest!.id}`).click()
    await page.getByTestId('consent').check()

    await page.getByTestId('photo-input').setInputFiles(PHOTO)
    await expect(page.getByTestId('generate')).toBeDisabled()
    await page.getByTestId('photo-input-2').setInputFiles(PHOTO)
    await expect(page.getByTestId('generate')).toBeEnabled()
    await page.getByTestId('generate').click()
    await expect(page.getByTestId('generation-status')).toHaveAttribute('data-status', 'succeeded', { timeout: 60_000 })
    const { generations } = await json<{ generations: Generation[] }>(page.request.get('/api/generations'))
    expect(generations.map((g) => g.templateId)).toEqual([duo.id])
    expect(await credits(page.request)).toBe(STARTER - cost)

    // 双人风格只给一张照片：400，余额不变
    const { upload } = await json<{ upload: { id: string } }>(uploadPhoto(page.request), 201)
    const res = await json<{ error: string }>(
      post(page.request, '/api/generations', { consent: true, uploadIds: [upload.id], durationId: longest!.id, styleId: duo.id }),
      400,
    )
    expect(res.error).toBe('invalid_upload')
    expect(await credits(page.request)).toBe(STARTER - cost)
  })
})
