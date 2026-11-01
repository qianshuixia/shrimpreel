import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { site } from '#/config/site'
import { XMP_UUID_HEX, parseXmpAiInfo, scanTopLevelBoxes } from '#/lib/xmp'
import { ORIGIN, buyPackage, credits, devLogin, durationCredits, json, ledger, post, uniqueEmail, uploadPhoto } from './helpers'

type Generation = { id: string; status: string; videoUrl: string | null; errorCode: string | null; refunded: boolean }

const STARTER = site.packages.find((p) => p.id === 'starter')!.credits
const SHORT = durationCredits('short')

async function generate(request: APIRequestContext, mockOutcome?: string) {
  const { upload } = await json<{ upload: { id: string } }>(uploadPhoto(request), 201)
  const body = { uploadId: upload.id, durationId: 'short', consent: true, ...(mockOutcome ? { mockOutcome } : {}) }
  return (await json<{ generation: Generation }>(post(request, '/api/generations', body), 201)).generation.id
}

async function waitFor(request: APIRequestContext, id: string, state: 'succeeded' | 'failed') {
  const read = async () => (await json<{ generation: Generation }>(request.get(`/api/generations/${id}`))).generation
  await expect.poll(async () => (await read()).status, { timeout: 60_000, intervals: [1000] }).toBe(state)
  return read()
}

// 页面水合前输入框是禁用的：等它可用再选文件，否则 change 事件会丢
async function chooseFile(page: Page, buffer: Uint8Array | Buffer) {
  const input = page.getByTestId('verify-input')
  await expect(input).toBeEnabled()
  await input.setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.from(buffer) })
}

test.describe('成片 AI 标记与验证页', () => {
  test.skip(STARTER < 2 * SHORT, `starter(${STARTER}) 不够连续两次 short(${SHORT})`)

  test('开关 aiMetadata 关闭（模板默认）：成片没有 XMP；/verify、验证接口 404；页脚没有验证链接；sitemap 不含 /verify', async ({ request, page }) => {
    test.skip(site.aiMetadata.enabled, '站点开启了 aiMetadata')
    await devLogin(request, uniqueEmail('label-off'))
    await buyPackage(request, 'starter')
    const id = await generate(request)
    await waitFor(request, id, 'succeeded')

    const download = await request.get(`/api/generations/${id}/video?download=1`)
    expect(download.status()).toBe(200)
    const bytes = new Uint8Array(await download.body())
    const scan = await scanTopLevelBoxes(async (offset, length) => bytes.slice(offset, offset + length), bytes.length)
    expect(scan.ok).toBe(true)
    expect(scan.boxes.some((b) => b.usertype === XMP_UUID_HEX)).toBe(false)

    // 接口：真实 id 与随便一个 id 都是 404 not_found，不泄露这条记录是否存在
    for (const probe of [id, 'gen_doesNotExist0']) {
      const res = await request.get(`/api/verify/${probe}`)
      expect(res.status()).toBe(404)
      expect(await res.json()).toMatchObject({ error: 'not_found' })
    }

    // 页面（含中文站）返回 404；页脚没有验证链接
    for (const path of ['/verify', '/zh/verify']) {
      expect((await page.request.get(path)).status()).toBe(404)
    }
    await page.goto('/')
    await expect(page.locator('footer')).toBeVisible()
    await expect(page.locator('footer a[href$="/verify"]')).toHaveCount(0)

    expect(await (await request.get('/sitemap.xml')).text()).not.toContain('/verify')
  })

  test('开关 aiMetadata 开启：成片末尾带 XMP 标记；验证页识别它，剥掉标记、删除记录后分别提示没有标记、没有记录；接口不泄露用户信息', async ({ request, page }) => {
    test.skip(!site.aiMetadata.enabled, '站点未开启 aiMetadata（模板默认关闭），XMP 与验证页靠 tests/unit/xmp.test.ts 覆盖')
    const email = uniqueEmail('label')
    const user = await devLogin(request, email)
    await buyPackage(request, 'starter')
    const id = await generate(request)
    const done = await waitFor(request, id, 'succeeded')
    expect(done.videoUrl).toBe(`/api/generations/${id}/video`)

    // 下载的成片：最后一个顶层 box 是 XMP uuid box，生成 id、AI 来源类型都在里面，没有邮箱和用户 id
    const download = await request.get(`/api/generations/${id}/video?download=1`)
    expect(download.status()).toBe(200)
    expect(download.headers()['content-disposition']).toContain(id)
    const video = await download.body()
    expect(Number(download.headers()['content-length'])).toBe(video.length)
    const bytes = new Uint8Array(video)
    const scan = await scanTopLevelBoxes(async (offset, length) => bytes.slice(offset, offset + length), bytes.length)
    expect(scan.ok).toBe(true)
    const last = scan.boxes.at(-1)!
    expect(last).toMatchObject({ type: 'uuid', usertype: XMP_UUID_HEX })
    expect(scan.boxes.filter((b) => b.usertype === XMP_UUID_HEX)).toHaveLength(1)
    expect(scan.boxes[0]!.type).toBe('ftyp')
    const packet = new TextDecoder().decode(bytes.subarray(last.start + last.headerSize + 16))
    expect(parseXmpAiInfo(packet)).toEqual({
      generationId: id,
      digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia',
    })
    expect(packet).not.toContain(email)
    expect(packet).not.toContain(user.id)
    // Range 读取（播放器拖动进度条）在追加后的对象上仍然正确
    const tail = await request.get(`/api/generations/${id}/video`, { headers: { range: `bytes=${last.start}-` } })
    expect(tail.status()).toBe(206)
    expect((await tail.body()).length).toBe(bytes.length - last.start)

    // 验证接口只回答是不是本站生成的，不带用户信息；不存在的 id 没有任何内容
    const found = await json<Record<string, unknown>>(request.get(`/api/verify/${id}`))
    expect(Object.keys(found).sort()).toEqual(['brand', 'createdAt', 'found', 'model', 'provider'])
    expect(found).toMatchObject({ found: true, brand: site.brandName, provider: 'mock' })
    expect(JSON.stringify(found)).not.toContain(user.id)
    const missing = await json<Record<string, unknown>>(request.get('/api/verify/gen_doesNotExist0'))
    expect(missing).toEqual({ found: false })
    expect(await json(request.get('/api/verify/' + encodeURIComponent('x'.repeat(200))))).toEqual({ found: false })

    // 验证页（本地读文件，不上传）：带标记 → 匹配
    await page.goto('/verify')
    const result = page.getByTestId('verify-result')
    await chooseFile(page, video)
    await expect(result).toHaveAttribute('data-state', 'found')
    await expect(page.getByTestId('verify-id')).toHaveText(id)
    await expect(page.getByTestId('verify-brand')).toHaveText(site.brandName)

    // 元数据里的验证链接（?id=）直接查记录
    await page.goto(`/verify?id=${id}`)
    await expect(result).toHaveAttribute('data-state', 'found')

    // 被重新压缩的视频没有标记：提示没有找到，并说明元数据会丢失
    await page.goto('/verify')
    await chooseFile(page, video.subarray(0, last.start))
    await expect(result).toHaveAttribute('data-state', 'no-marker')
    await expect(result).toContainText(/re-compressed|re-uploaded/)

    // 中文站同一页面可用
    await page.goto('/zh/verify')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('验证视频')

    // 删除记录后，带标记的文件和从未存在过的 id 得到同样的答案（不区分已删除与不存在）
    expect((await request.delete(`/api/generations/${id}`, { headers: { origin: ORIGIN } })).status()).toBe(200)
    expect(await json(request.get(`/api/verify/${id}`))).toEqual(missing)
    await page.goto('/verify')
    await chooseFile(page, video)
    await expect(result).toHaveAttribute('data-state', 'not-found')
  })


  test('成片输出审核不通过：不交付成片，任务失败并退回积分；开启 aiMetadata 时验证接口也查不到', async ({ request }) => {
    await devLogin(request, uniqueEmail('output-reject'))
    await buyPackage(request, 'starter')
    const id = await generate(request, 'output_reject')
    expect(await credits(request)).toBe(STARTER - SHORT)

    const failed = await waitFor(request, id, 'failed')
    expect(failed).toMatchObject({ errorCode: 'output_moderation_rejected', refunded: true, videoUrl: null })
    expect(await credits(request)).toBe(STARTER)
    const entries = (await ledger(request)).filter((e) => e.ref_id === id)
    expect(entries.map((e) => [e.reason, e.delta]).sort()).toEqual([
      ['generation', -SHORT],
      ['generation_refund', SHORT],
    ])
    expect((await request.get(`/api/generations/${id}/video`)).status()).toBe(404)
    if (site.aiMetadata.enabled) expect(await json(request.get(`/api/verify/${id}`))).toEqual({ found: false })
    else expect((await request.get(`/api/verify/${id}`)).status()).toBe(404)
  })
})
