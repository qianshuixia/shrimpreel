import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { ORIGIN, PHOTO, buyPackage, credits, devLogin, durationCredits, json, pkg, post, uniqueEmail, uploadPhoto } from './helpers'

const STARTER = pkg('starter').credits
const SHORT = durationCredits('short')

const ADMIN_EMAIL = 'admin@example.com'

type Generation = { id: string; status: string; videoUrl: string | null; expired: boolean; removed: boolean; expiresAt: string | null }
type Swept = { uploads: number; outputs: number }

// 下架会把原图哈希加入全局黑名单，测试必须用独一份的图片，不能拉黑共用的 fixture。
// JPEG 结束标记后追加随机字节：仍是合法 JPEG，哈希不同
function uniquePhoto() {
  // concat 总是分配新的非共享内存
  return Buffer.concat([readFileSync(PHOTO), randomBytes(16)]) as Buffer<ArrayBuffer>
}

async function upload(request: APIRequestContext, buffer?: Buffer<ArrayBuffer>) {
  return (await json<{ upload: { id: string } }>(uploadPhoto(request, buffer), 201)).upload.id
}

async function generate(request: APIRequestContext, uploadId: string) {
  return (await json<{ generation: Generation }>(post(request, '/api/generations', { consent: true, uploadId, durationId: 'short' }), 201)).generation.id
}

async function generation(request: APIRequestContext, id: string) {
  return (await json<{ generation: Generation }>(request.get(`/api/generations/${id}`))).generation
}

async function succeeded(request: APIRequestContext, id: string) {
  await expect.poll(async () => (await generation(request, id)).status, { timeout: 60_000, intervals: [1000] }).toBe('succeeded')
}

test('数据保留：进行中任务的原图不清理；到期后原图不能再用、成片按期过期，个人中心显示已过期', async ({ page }, testInfo) => {
  const request = page.request
  await devLogin(request, uniqueEmail('retention'))
  await buyPackage(request, 'starter')
  const uploadId = await upload(request)
  const genId = await generate(request, uploadId)

  // 任务还在跑：原图即使已过保留期也不能删，否则 provider 取不到图
  expect(await json<Swept>(post(request, '/api/dev/sweep', { days: 8 }))).toEqual({ uploads: 0, outputs: 0 })
  await succeeded(request, genId)
  const done = await generation(request, genId)
  expect(Date.parse(done.expiresAt!) - Date.now()).toBeGreaterThan(29 * 86400_000)

  // +8 天：原图过期（7 天），成片仍在（30 天）
  expect(await json<Swept>(post(request, '/api/dev/sweep', { days: 8 }))).toEqual({ uploads: 1, outputs: 0 })
  const reuse = await json<{ error: string }>(post(request, '/api/generations', { consent: true, uploadId, durationId: 'short' }), 400)
  expect(reuse.error).toBe('invalid_upload')
  expect(await credits(request)).toBe(STARTER - SHORT)
  expect((await request.get(`/api/generations/${genId}/video`)).status()).toBe(200)

  // +31 天：成片过期；重复执行不会重复处理
  expect(await json<Swept>(post(request, '/api/dev/sweep', { days: 31 }))).toEqual({ uploads: 0, outputs: 1 })
  expect(await json<Swept>(post(request, '/api/dev/sweep', { days: 31 }))).toEqual({ uploads: 0, outputs: 0 })
  expect((await json<{ error: string }>(request.get(`/api/generations/${genId}/video`), 410)).error).toBe('media_expired')
  expect(await generation(request, genId)).toMatchObject({ status: 'succeeded', expired: true, videoUrl: null, expiresAt: null })
  expect((await json<{ error: string }>(post(request, '/api/dev/sweep', { days: -1 }), 400)).error).toBe('invalid_days')

  await page.goto('/dashboard')
  const item = page.getByTestId('video-item')
  await expect(item).toHaveAttribute('data-media', 'expired')
  await expect(item).toContainText('Expired')
  await expect(item.locator('video')).toHaveCount(0)
  await testInfo.attach('dashboard-expired', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
})

test('举报下架：匿名在 /report 举报 → 管理员下架 → 同一原图的全部视频删除、再次上传被拦截，其它视频不受影响', async ({
  page,
  browser,
}, testInfo) => {
  const shot = async (name: string, target = page) =>
    testInfo.attach(name, { body: await target.screenshot({ fullPage: true }), contentType: 'image/png' })

  // 被举报用户：同一张图上传两次各生成一条，另一张图生成一条
  const ownerEmail = uniqueEmail('reported')
  await devLogin(page.request, ownerEmail)
  await buyPackage(page.request, 'starter')
  const photo = uniquePhoto()
  const [first, second, unrelated] = [await upload(page.request, photo), await upload(page.request, photo), await upload(page.request, uniquePhoto())]
  const reported = await generate(page.request, first)
  const copy = await generate(page.request, second)
  const kept = await generate(page.request, unrelated)
  for (const id of [reported, copy, kept]) await succeeded(page.request, id)

  const anon = await browser.newContext({ baseURL: ORIGIN })
  const adminContext = await browser.newContext({ baseURL: ORIGIN })
  try {
    // 校验失败不入库：未勾选声明、邮箱错误、无法定位内容
    const valid = { name: 'Jordan Reporter', email: 'reporter@example.com', contentRef: `video ${reported}`, reason: 'impersonation', attest: true, signature: 'Test Signature' }
    for (const [patch, code] of [
      [{ attest: false }, 'invalid_report'],
      [{ email: 'not-an-email' }, 'invalid_email'],
      [{ contentRef: 'x' }, 'invalid_report'],
      [{ reason: 'spam' }, 'invalid_report'],
      [{ signature: '   ' }, 'invalid_report'],
      [{ signature: undefined }, 'invalid_report'],
    ] as const) {
      expect((await json<{ error: string }>(post(anon.request, '/api/takedowns', { ...valid, ...patch }), 400)).error).toBe(code)
    }

    // 举报人只有下载文件名（含视频 ID）也能定位
    const reportPage = await anon.newPage()
    await reportPage.goto('/report')
    const form = reportPage.getByTestId('report-form')
    // 提交按钮可用 = 已水合；之前输入的内容会被受控组件覆盖
    await expect(form.getByRole('button')).toBeEnabled()
    await form.locator('[name=name]').fill(valid.name)
    await form.locator('[name=email]').fill(valid.email)
    await form.locator('[name=contentRef]').fill(`Reposted on a forum as brand-ai-video-${reported}.mp4`)
    await form.locator('[name=reason]').selectOption('impersonation')
    await form.locator('[name=details]').fill('This is me and I never agreed to this.')
    await form.locator('[name=isDepicted]').check()
    await form.locator('[name=attest]').check()
    await form.locator('[name=signature]').fill(valid.name)
    await form.getByRole('button').click()
    const sent = reportPage.getByTestId('report-sent')
    await expect(sent).toContainText('tdr_')
    const reportId = (await sent.textContent())!.match(/tdr_[A-Za-z0-9_-]+/)![0]
    await shot('01-report-sent', reportPage)

    // 管理员处理：待处理列表显示归属用户；下架时确认 ID、填写备注、二次确认
    const admin = await adminContext.newPage()
    await devLogin(admin.request, ADMIN_EMAIL)
    const stats = await json<{ openTakedowns: number }>(admin.request.get('/api/admin/stats'))
    expect(stats.openTakedowns).toBeGreaterThan(0)
    await admin.goto('/admin/takedowns')
    const item = admin.locator(`[data-testid="takedown-item"][data-id="${reportId}"]`)
    await expect(item).toContainText(reported)
    await expect(item.getByTestId('takedown-signature')).toContainText(valid.name)
    await expect(item).toContainText(ownerEmail)
    await shot('02-admin-queue', admin)
    admin.on('dialog', (dialog) => {
      if (dialog.type() !== 'prompt') return dialog.accept()
      return dialog.accept(dialog.defaultValue() || 'e2e: verified by reporter')
    })
    await item.getByRole('button', { name: '下架内容' }).click()
    await expect(item).toHaveCount(0)

    // 已处理的举报不能再次处理
    const again = post(admin.request, `/api/admin/takedowns/${reportId}/resolve`, { action: 'reject', note: 'late' })
    expect((await json<{ error: string }>(again, 409)).error).toBe('already_resolved')
    const { entries } = await json<{ entries: Array<{ action: string; target_id: string; detail: string }> }>(admin.request.get('/api/admin/audit'))
    const entry = entries.find((e) => e.target_id === reportId)
    expect(entry?.action).toBe('takedown.removed')
    expect(JSON.parse(entry!.detail)).toMatchObject({ generationId: reported, generations: 2, uploads: 2, blocked: true })
    await admin.getByRole('combobox').selectOption('removed')
    await expect(item).toContainText('已下架')
    await shot('03-admin-removed', admin)
  } finally {
    await anon.close()
    await adminContext.close()
  }

  // 被举报用户：两条同源视频都已删除，无关视频仍可播放；同一张图再传被拦截
  for (const id of [reported, copy]) {
    expect((await json<{ error: string }>(page.request.get(`/api/generations/${id}/video`), 410)).error).toBe('media_removed')
    expect(await generation(page.request, id)).toMatchObject({ removed: true, videoUrl: null })
  }
  expect((await page.request.get(`/api/generations/${kept}/video`)).status()).toBe(200)
  expect((await json<{ error: string }>(uploadPhoto(page.request, photo), 422)).error).toBe('content_rejected')

  await page.goto('/dashboard')
  await expect(page.locator('[data-testid="video-item"][data-media="removed"]')).toHaveCount(2)
  await expect(page.locator('[data-testid="video-item"][data-media="available"]')).toHaveCount(1)
  await shot('04-owner-dashboard')
})

test('上传审核不通过返回 422，不落盘；之后正常图片仍可上传', async ({ request }) => {
  await devLogin(request, uniqueEmail('moderation'))
  const rejected = await request.post('/api/uploads', {
    headers: { origin: ORIGIN },
    multipart: { file: { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: uniquePhoto() }, mockOutcome: 'reject' },
  })
  expect(rejected.status()).toBe(422)
  expect((await rejected.json()).error).toBe('content_rejected')
  await upload(request)
})

test('导出我的数据：设置页下载 JSON，含本人全部记录；不含他人数据和内部字段；未登录与注销后 401', async ({ page, browser }, testInfo) => {
  const request = page.request
  const ownerEmail = uniqueEmail('export')
  const owner = await devLogin(request, ownerEmail)
  const orderId = await buyPackage(request, 'starter')
  const uploadId = await upload(request)
  const genId = await generate(request, uploadId)
  await succeeded(request, genId)
  await json(post(request, '/api/contact', { topic: 'billing', message: 'Where is my invoice for the starter pack?' }), 201)
  const reportBody = { name: 'Owner Export', email: ownerEmail, reason: 'other', attest: true, signature: 'Test Signature', locale: 'en' }
  const ownReport = (await json<{ report: { id: string } }>(post(request, '/api/takedowns', { ...reportBody, contentRef: 'https://social.example/watch?v=copy' }), 201)).report.id

  // 另一个用户：自己下单，并举报 owner 的视频。这些都属于他的数据，不能出现在 owner 的导出里
  const otherEmail = uniqueEmail('export-other')
  const other = await browser.newContext({ baseURL: ORIGIN })
  let otherOrder: string
  let otherReport: string
  try {
    await devLogin(other.request, otherEmail)
    otherOrder = await buyPackage(other.request, 'starter')
    otherReport = (
      await json<{ report: { id: string } }>(
        post(other.request, '/api/takedowns', { ...reportBody, name: 'Other Reporter', email: otherEmail, contentRef: `video ${genId}` }),
        201,
      )
    ).report.id
    // 未登录不能导出
    await other.clearCookies()
    expect((await json<{ error: string }>(other.request.get('/api/account/export'), 401)).error).toBe('unauthorized')
  } finally {
    await other.close()
  }

  await page.goto('/dashboard/settings')
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-data').click()])
  expect(download.suggestedFilename()).toMatch(/-my-data-\d{4}-\d{2}-\d{2}\.json$/)
  const raw = readFileSync((await download.path())!, 'utf8')
  await testInfo.attach('export.json', { body: raw, contentType: 'application/json' })
  const data = JSON.parse(raw)

  expect(data.account).toMatchObject({ id: owner.id, email: ownerEmail, status: 'active', credits: STARTER - SHORT })
  expect(data.sessions.length).toBeGreaterThanOrEqual(1)
  expect(data.orders).toEqual([expect.objectContaining({ id: orderId, status: 'paid', packageId: 'starter', credits: STARTER })])
  expect(data.creditLedger.map((e: { reason: string; delta: number }) => [e.reason, e.delta])).toEqual([
    ['purchase', STARTER],
    ['generation', -SHORT],
  ])
  expect(data.uploads).toEqual([expect.objectContaining({ id: uploadId, contentType: 'image/jpeg' })])
  expect(data.generations).toEqual([expect.objectContaining({ id: genId, uploadId, status: 'succeeded', creditsCost: SHORT })])
  expect(data.contactMessages).toEqual([expect.objectContaining({ email: ownerEmail, topic: 'billing' })])
  expect(data.takedownRequests.map((r: { id: string }) => r.id)).toEqual([ownReport])
  expect(data.emails.map((e: { template: string }) => e.template)).toContain('order_paid')

  // 隔离与脱敏：没有别人的订单、举报和邮箱，也没有 R2 路径、模型请求 ID、邮件模板参数等内部字段
  for (const leaked of [otherOrder!, otherReport!, otherEmail, `uploads/${owner.id}`, `outputs/${owner.id}`, 'r2_key', 'provider_request_id', 'params']) {
    expect(raw, leaked).not.toContain(leaked)
  }

  const res = await request.get('/api/account/export')
  expect(res.headers()['cache-control']).toBe('private, no-store')
  // 注销后会话失效，不能再导出
  await json(request.delete('/api/account', { headers: { origin: ORIGIN } }))
  expect((await request.get('/api/account/export')).status()).toBe(401)

  // 驳回这两条举报：后台队列每页 50 条，未处理的越积越多会把其它用例的举报挤到第二页
  const admin = await browser.newContext({ baseURL: ORIGIN })
  try {
    await devLogin(admin.request, ADMIN_EMAIL)
    for (const id of [ownReport, otherReport!]) {
      await json(post(admin.request, `/api/admin/takedowns/${id}/resolve`, { action: 'reject', note: 'e2e: cleanup' }))
    }
  } finally {
    await admin.close()
  }
})
