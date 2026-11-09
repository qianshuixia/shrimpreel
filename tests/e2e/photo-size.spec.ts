import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { ORIGIN, PHOTO, content, devLogin, json, post, uniqueEmail, uploadPhoto } from './helpers'

const t = content.en.errors

// 在页面里造一张图塞进上传框（尺寸可以是任意值，不用提交大文件进仓库）
async function pickGenerated(page: Page, input: string, width: number, height: number, quality: number) {
  return page.evaluate(
    async ({ input, width, height, quality }) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')!
      const img = ctx.createImageData(width, height)
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = (i * 13) % 256
        img.data[i + 1] = (i * 7) % 256
        img.data[i + 2] = (i * 3) % 256
        img.data[i + 3] = 255
      }
      ctx.putImageData(img, 0, 0)
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/jpeg', quality))
      const el = document.querySelector<HTMLInputElement>(input)!
      const transfer = new DataTransfer()
      transfer.items.add(new File([blob], 'IMG_0001.jpg', { type: 'image/jpeg' }))
      el.files = transfer.files
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return blob.size
    },
    { input, width, height, quality },
  )
}

test('太小、太窄太扁的照片在浏览器里就被拦下：提示换一张，不发上传请求', async ({ page }) => {
  await devLogin(page.request, uniqueEmail('photo-size'))
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const generator = page.getByTestId('generator')
  let uploads = 0
  page.on('request', (r) => {
    if (r.url().endsWith('/api/uploads') && r.method() === 'POST') uploads++
  })
  await generator.getByTestId('photo-input').setInputFiles('tests/fixtures/sizes/small.jpg')
  await expect(generator.getByRole('alert')).toHaveText(t.photo_too_small)
  await generator.getByTestId('photo-input').setInputFiles('tests/fixtures/sizes/narrow.jpg')
  await expect(generator.getByRole('alert')).toHaveText(t.photo_bad_ratio)
  await page.waitForTimeout(500)
  expect(uploads).toBe(0)

  await generator.getByTestId('photo-input').setInputFiles(PHOTO)
  await expect(generator.getByRole('alert')).toHaveCount(0)
  await expect.poll(() => uploads).toBe(1)
})

test('手机原图大小的照片先在浏览器里缩小：4032×3024 的 JPEG 传上去不到 2 MB，上传成功', async ({ page }) => {
  await devLogin(page.request, uniqueEmail('big-photo'))
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const uploaded = page.waitForResponse((r) => r.url().endsWith('/api/uploads') && r.request().method() === 'POST')
  const original = await pickGenerated(page, '[data-testid="generator"] [data-testid="photo-input"]', 4032, 3024, 1)
  expect(original).toBeGreaterThan(4_000_000)
  const response = await uploaded
  expect(response.status()).toBe(201)
  // multipart 请求体 Playwright 拿不到，看请求头里的长度
  expect(Number(await response.request().headerValue('content-length'))).toBeLessThan(2_000_000)
})

test('上传接口兜底：太窄、太小的照片 422，正常照片 201', async ({ request }) => {
  await devLogin(request, uniqueEmail('photo-size-api'))
  expect((await json<{ error: string }>(uploadPhoto(request, readFileSync('tests/fixtures/sizes/narrow.jpg')), 422)).error).toBe('photo_bad_ratio')
  expect((await json<{ error: string }>(uploadPhoto(request, readFileSync('tests/fixtures/sizes/small.jpg')), 422)).error).toBe('photo_too_small')
  await json(uploadPhoto(request), 201)
})

test('手机传图接口也拦：太窄的照片 422，二维码仍可用，换正常照片能传', async ({ request }) => {
  const send = (token: string, buffer: Buffer) =>
    request.post('/api/handoff/photo', { headers: { origin: ORIGIN }, multipart: { token, file: { name: 'p.jpg', mimeType: 'image/jpeg', buffer } } })
  const { token } = await json<{ token: string }>(post(request, '/api/handoff'))
  const narrow = await send(token, readFileSync('tests/fixtures/sizes/narrow.jpg'))
  expect(narrow.status()).toBe(422)
  expect((await narrow.json()).error).toBe('photo_bad_ratio')
  expect((await send(token, readFileSync(PHOTO))).status()).toBeLessThan(300)
})

test('透明 PNG 缩小后是白底：长边超过 2048 的透明 PNG 重画成 JPEG，透明处不变黑', async ({ page }) => {
  await devLogin(page.request, uniqueEmail('png-alpha'))
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const uploaded = page.waitForResponse((r) => r.url().endsWith('/api/uploads') && r.request().method() === 'POST')
  await page.evaluate(async () => {
    // 2400×2400、中间一块不透明、其余全透明：长边超过 2048 会被缩小重画
    const canvas = document.createElement('canvas')
    canvas.width = 2400
    canvas.height = 2400
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#336699'
    ctx.fillRect(900, 900, 600, 600)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
    const el = document.querySelector<HTMLInputElement>('[data-testid="generator"] [data-testid="photo-input"]')!
    const transfer = new DataTransfer()
    transfer.items.add(new File([blob], 'sticker.png', { type: 'image/png' }))
    el.files = transfer.files
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect((await uploaded).status()).toBe(201)
  // 预览用的就是传上去的文件：读角上的像素
  const corner = await page.evaluate(async () => {
    const img = [...document.querySelectorAll<HTMLImageElement>('[data-testid="generator"] img')].find((i) => i.src.startsWith('blob:'))!
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    return { size: [img.naturalWidth, img.naturalHeight], pixel: [...ctx.getImageData(5, 5, 1, 1).data] }
  })
  expect(corner.size).toEqual([2048, 2048])
  expect(corner.pixel.slice(0, 3).every((v) => v > 240)).toBe(true)
})

