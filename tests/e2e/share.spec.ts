import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { ORIGIN, PHOTO, buyPackage, content, devLogin, json, post, uniqueEmail, uploadPhoto } from './helpers'

const ADMIN_EMAIL = 'admin@example.com'
const t = content.en.share

// 下架会拉黑原图哈希，涉及下架的用例用独一份的图片（同 compliance.spec.ts）
function uniquePhoto() {
  return Buffer.concat([readFileSync(PHOTO), randomBytes(16)]) as Buffer<ArrayBuffer>
}

async function renderedVideo(request: APIRequestContext, photo?: Buffer<ArrayBuffer>) {
  await buyPackage(request, 'starter')
  const uploadId = (await json<{ upload: { id: string } }>(uploadPhoto(request, photo), 201)).upload.id
  const id = (await json<{ generation: { id: string } }>(post(request, '/api/generations', { consent: true, uploadId, durationId: 'short' }), 201)).generation.id
  await expect
    .poll(async () => (await json<{ generation: { status: string } }>(request.get(`/api/generations/${id}`))).generation.status, {
      timeout: 60_000,
      intervals: [1000],
    })
    .toBe('succeeded')
  return id
}

// 带 JPEG 封面开启分享（浏览器里是 canvas 截帧，这里直接用 fixture 照片）
function shareWithPoster(request: APIRequestContext, id: string, body: Buffer = readFileSync(PHOTO), headers: Record<string, string> = {}) {
  return request.post(`/api/generations/${id}/share`, { headers: { origin: ORIGIN, 'content-type': 'image/jpeg', ...headers }, data: body })
}

async function sharePage(request: APIRequestContext, path: string) {
  const response = await request.get(path)
  return { status: response.status(), robots: response.headers()['x-robots-tag'], html: await response.text() }
}

test('公开分享：个人中心开启 → 匿名访客看到 noindex 的分享页和 AI 标识 → 他人无权操作 → 停止分享后旧链接 404，到期后 410', async ({
  page,
  browser,
  playwright,
}, testInfo) => {
  const shot = async (name: string, target = page) =>
    testInfo.attach(name, { body: await target.screenshot({ fullPage: true }), contentType: 'image/png' })
  await devLogin(page.request, uniqueEmail('share-owner'))
  const id = await renderedVideo(page.request)

  // 个人中心点“分享”（确认框接受），出现分享链接
  page.on('dialog', (dialog) => dialog.accept())
  await page.goto('/dashboard')
  const card = page.getByTestId('video-item').first()
  await card.getByTestId('share-button').click()
  const link = card.getByTestId('share-link')
  await expect(link).toBeVisible()
  const sharePath = (await link.getAttribute('href'))!
  expect(sharePath).toMatch(/^\/v\/[A-Za-z0-9_-]{16}$/)
  const shareId = sharePath.slice(3)
  await shot('01-dashboard-shared')

  const anon = await browser.newContext()
  const other = await playwright.request.newContext({ baseURL: ORIGIN })
  try {
    // 匿名访客：200、noindex（响应头和 meta 都有）、OG 视频地址；不暴露 generation id
    const visitor = await anon.newPage()
    const first = await sharePage(visitor.request, sharePath)
    expect(first.status).toBe(200)
    expect(first.robots).toBe('noindex')
    expect(first.html).toContain('<meta name="robots" content="noindex"')
    expect(first.html).toContain(`/media/shares/${shareId}/video`)
    expect(first.html).toContain('og:video:type')
    expect(first.html).not.toContain(id)
    await visitor.goto(sharePath)
    await expect(visitor.getByTestId('share-page')).toBeVisible()
    await expect(visitor.getByTestId('ai-badge')).toBeVisible()
    await expect(visitor.getByRole('heading', { level: 1 })).toHaveText(t.heading)
    await shot('02-share-page', visitor)
    // 举报入口把分享链接带进举报表单
    await visitor.getByTestId('share-report').click()
    await expect(visitor.locator('[name=contentRef]')).toHaveValue(new RegExp(`/v/${shareId}$`))

    // 公开视频支持 Range；中文前缀同样可用
    const range = await visitor.request.get(`/media/shares/${shareId}/video`, { headers: { range: 'bytes=0-99' } })
    expect(range.status()).toBe(206)
    expect((await sharePage(visitor.request, `/zh${sharePath}`)).html).toContain(content.zh.share.heading)

    // 其他登录用户不能替作者分享或停止分享
    await devLogin(other, uniqueEmail('share-other'))
    expect((await json<{ error: string }>(post(other, `/api/generations/${id}/share`), 404)).error).toBe('not_found')
    expect((await other.delete(`/api/generations/${id}/share`, { headers: { origin: ORIGIN } })).status()).toBe(404)

    // 停止分享：旧链接页面 404、媒体 404
    await card.getByTestId('stop-sharing').click()
    await expect(card.getByTestId('share-button')).toBeVisible()
    const stopped = await sharePage(visitor.request, sharePath)
    expect(stopped.status).toBe(404)
    expect(stopped.robots).toBe('noindex')
    expect((await visitor.request.get(`/media/shares/${shareId}/video`)).status()).toBe(404)
    await visitor.goto(sharePath)
    await expect(visitor.getByTestId('share-gone')).toHaveAttribute('data-state', 'missing')

    // 封面校验：不是 JPEG 415、审核不通过 422；合格封面重新分享得到新链接，og:image 指向封面
    expect((await json<{ error: string }>(shareWithPoster(page.request, id, Buffer.from('not an image')), 415)).error).toBe('unsupported_file_type')
    expect((await json<{ error: string }>(shareWithPoster(page.request, id, readFileSync(PHOTO), { 'x-mock-moderation': 'reject' }), 422)).error).toBe(
      'share_rejected',
    )
    const { shareId: again } = await json<{ shareId: string }>(shareWithPoster(page.request, id))
    expect(again).not.toBe(shareId)
    expect((await sharePage(visitor.request, sharePath)).status).toBe(404)
    expect((await sharePage(visitor.request, `/v/${again}`)).html).toContain(`/media/shares/${again}/poster.jpg`)
    const poster = await visitor.request.get(`/media/shares/${again}/poster.jpg`)
    expect(poster.status()).toBe(200)
    expect(poster.headers()['content-type']).toBe('image/jpeg')

    // 成片到期：分享页和媒体 410，封面随成片删除
    expect(await json(post(page.request, '/api/dev/sweep', { days: 31 }))).toMatchObject({ outputs: 1 })
    expect((await sharePage(visitor.request, `/v/${again}`)).status).toBe(410)
    expect((await visitor.request.get(`/media/shares/${again}/poster.jpg`)).status()).toBe(410)
    await visitor.goto(`/v/${again}`)
    await expect(visitor.getByTestId('share-gone')).toHaveAttribute('data-state', 'expired')
    await expect(visitor.getByRole('heading', { level: 1 })).toHaveText(t.gone.expired)
    // 到期的视频不能再分享
    expect((await json<{ error: string }>(post(page.request, `/api/generations/${id}/share`), 410)).error).toBe('media_expired')
  } finally {
    await anon.close()
    await other.dispose()
  }
})

test('分享链接被举报：凭分享链接即可定位视频，下架后分享页和媒体 410', async ({ request, playwright }) => {
  await devLogin(request, uniqueEmail('share-reported'))
  const id = await renderedVideo(request, uniquePhoto())
  const { shareId } = await json<{ shareId: string }>(shareWithPoster(request, id))

  const admin = await playwright.request.newContext({ baseURL: ORIGIN })
  const anon = await playwright.request.newContext({ baseURL: ORIGIN })
  try {
    // 匿名举报只给了带语言前缀的分享链接（没有视频 ID）
    const report = await json<{ report: { id: string } }>(
      post(anon, '/api/takedowns', {
        name: 'Share Reporter',
        email: 'share-reporter@example.com',
        contentRef: `${ORIGIN}/zh/v/${shareId}`,
        reason: 'impersonation',
        attest: true, signature: 'Test Signature',
      }),
      201,
    )
    // 管理员下架时不指定视频 ID，用举报时反查到的
    await devLogin(admin, ADMIN_EMAIL)
    await json(post(admin, `/api/admin/takedowns/${report.report.id}/resolve`, { action: 'remove', note: 'e2e: share link report' }))
    const { takedowns } = await json<{ takedowns: Array<{ id: string; generation_id: string | null }> }>(admin.get('/api/admin/takedowns?status=removed'))
    expect(takedowns.find((r) => r.id === report.report.id)?.generation_id).toBe(id)

    const page = await anon.get(`/v/${shareId}`)
    expect(page.status()).toBe(410)
    expect(await page.text()).toContain(t.gone.removed)
    expect((await anon.get(`/media/shares/${shareId}/video`)).status()).toBe(410)
    expect((await anon.get(`/media/shares/${shareId}/poster.jpg`)).status()).toBe(410)
    expect((await json<{ share: { state: string } }>(anon.get(`/api/shares/${shareId}`))).share.state).toBe('removed')
  } finally {
    await admin.dispose()
    await anon.dispose()
  }
})
