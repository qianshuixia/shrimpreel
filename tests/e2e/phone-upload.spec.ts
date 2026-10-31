import { readFileSync } from 'node:fs'
import { devices, expect, test, type Page } from '@playwright/test'
import { STYLES, cheapestPackageCovering, formatPrice, site } from '../../src/config/site'
import { ORIGIN, PHOTO, content, json, post, uniqueEmail } from './helpers'

const en = content.en
const OTHER_DURATION = site.durations[0]!
const LONGEST = site.durations[site.durations.length - 1]!

// 水合完成的标志：会话加载完，CTA 出现
async function ready(page: Page) {
  await expect(page.getByTestId('generator-sign-up').or(page.getByTestId('generate')).or(page.getByTestId('generator-buy'))).toBeVisible()
}

test('访客草稿跨登录和付款保留：照片、风格、时长、授权都恢复，生成开始后草稿清除', async ({ page }) => {
  expect(OTHER_DURATION.id, '默认时长是最后一档，本用例选第一档').not.toBe(LONGEST.id)
  const otherStyle = STYLES.length > 1 ? STYLES[1]! : null
  const cheapest = cheapestPackageCovering(OTHER_DURATION.credits)!

  await page.goto('/')
  await ready(page)
  await page.getByTestId('photo-input').setInputFiles(PHOTO)
  await expect(page.getByText(en.generator.uploaded)).toBeVisible()
  if (otherStyle) await page.getByTestId(`style-${otherStyle.id}`).click()
  await page.getByTestId(`duration-${OTHER_DURATION.id}`).click()
  await page.getByTestId('consent').check()
  await expect(page.getByTestId('generator-draft-kept')).toHaveText(en.generator.draftKept)
  await expect(page.getByTestId('generator-guest-price')).toHaveText(
    en.generator.guestPrice(OTHER_DURATION.credits, formatPrice(cheapest.priceCents, cheapest.currency)),
  )

  // 草稿写入 IndexedDB 是异步的，确认最后一次改动（授权勾选）已写入后再整页跳转
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<boolean>((resolve) => {
            const open = indexedDB.open('photo-draft')
            open.onerror = () => resolve(false)
            open.onsuccess = () => {
              const db = open.result
              if (!db.objectStoreNames.contains('draft')) {
                db.close()
                return resolve(false)
              }
              const get = db.transaction('draft').objectStore('draft').get('current')
              get.onsuccess = () => {
                const d = get.result as { consent?: boolean } | undefined
                db.close()
                resolve(d?.consent === true)
              }
            }
          }),
      ),
    )
    .toBe(true)

  // 本地没有 Google 配置：CTA 指向本地登录页，登录后回到首页
  await page.getByTestId('generator-sign-up').click()
  await expect(page).toHaveURL(/\/sign-in/)
  await page.getByTestId('dev-email').fill(uniqueEmail('draft'))
  await page.getByTestId('dev-login').click()
  await expect(page).toHaveURL(`${ORIGIN}/`)

  const generator = page.getByTestId('generator')
  await expect(page.getByTestId('generator-buy')).toBeVisible()
  await expect(generator.getByText(en.generator.uploaded)).toBeVisible()
  await expect(page.getByTestId('consent')).toBeChecked()
  await expect(page.getByTestId(`duration-${OTHER_DURATION.id}`)).toHaveAttribute('aria-checked', 'true')
  if (otherStyle) await expect(page.getByTestId(`style-${otherStyle.id}`)).toHaveAttribute('aria-checked', 'true')

  // 余额不足：就地买包，付完回到 /#create，照片仍在
  await expect(page.getByTestId('generator-buy')).toHaveText(en.generator.ctaBuyPack(cheapest.credits, formatPrice(cheapest.priceCents, cheapest.currency)))
  await page.getByTestId('generator-buy').click()
  await expect(page.getByTestId('mock-checkout')).toBeVisible()
  await page.getByTestId('mock-pay').click()
  await expect(page.getByTestId('checkout-result')).toHaveAttribute('data-status', 'paid')
  await page.getByTestId('checkout-result').locator('a[href$="#create"]').click()
  await expect(page.getByTestId('generate')).toBeEnabled()
  await expect(generator.getByText(en.generator.uploaded)).toBeVisible()
  await expect(page.getByTestId(`duration-${OTHER_DURATION.id}`)).toHaveAttribute('aria-checked', 'true')

  await page.getByTestId('generate').click()
  await expect(page.getByTestId('generation-status')).toHaveAttribute('data-status', 'succeeded', { timeout: 60_000 })

  // 生成已开始：草稿清除，刷新后没有照片
  await page.reload()
  await ready(page)
  await expect(page.getByTestId('generator').getByText(en.generator.dropTitle)).toBeVisible()
  await expect(page.getByText(en.generator.uploaded)).toBeHidden()
})

test('扫码用手机上传：手机传图后桌面面板关闭并选中照片，同一二维码不能再用；手机视口不显示入口', async ({ page, browser }) => {
  await page.goto('/')
  await ready(page)
  await page.getByTestId('phone-upload-open').click()
  await expect(page.getByTestId('phone-upload-panel')).toBeVisible()
  await expect(page.getByTestId('phone-upload-qr')).toBeVisible()
  const link = (await page.getByTestId('phone-upload-link').getAttribute('href'))!
  expect(link).toMatch(new RegExp(`^${ORIGIN}/phone-upload#[\\w-]{20,}$`))

  const phone = await browser.newContext({
    ...devices['Pixel 7'],
    storageState: { cookies: [], origins: [{ origin: ORIGIN, localStorage: [{ name: 'consent.analytics', value: 'denied' }] }] },
  })
  try {
    const mobile = await phone.newPage()
    await mobile.goto(`${ORIGIN}/`)
    await ready(mobile)
    await expect(mobile.getByTestId('phone-upload-open')).toBeHidden()

    await mobile.goto(link)
    await mobile.getByTestId('phone-upload-input').setInputFiles(PHOTO)
    await expect(mobile.getByTestId('phone-upload-done')).toHaveText(en.phoneUpload.done)

    // 桌面 2 秒轮询一次：面板关闭，照片已选
    await expect(page.getByTestId('phone-upload-panel')).toBeHidden({ timeout: 15_000 })
    await expect(page.getByTestId('generator').getByText(en.generator.uploaded)).toBeVisible()

    // 已被取走的二维码再传：已用过
    const again = await phone.newPage()
    await again.goto(link)
    await again.getByTestId('phone-upload-input').setInputFiles(PHOTO)
    await expect(again.getByRole('alert')).toHaveText(en.errors.handoff_used!)
  } finally {
    await phone.close()
  }
})

test('手机上传页：没有 token 提示扫码；格式不对在手机上就被拦下', async ({ page }) => {
  await page.goto('/phone-upload')
  await expect(page.getByTestId('phone-upload-no-token')).toHaveText(en.phoneUpload.noToken)
  await page.goto('/phone-upload#sometoken-sometoken-1234')
  await page.reload() // 只改 fragment 是同文档跳转，不会重新读 token
  await page.getByTestId('phone-upload-input').setInputFiles({ name: 'a.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') })
  await expect(page.getByRole('alert')).toHaveText(en.errors.unsupported_file_type!)
})

test('手机传图接口边界：未知 token、伪装成图片的文本、一次性取走', async ({ request }) => {
  const photo = readFileSync(PHOTO)
  const jpeg = { name: 'p.jpg', mimeType: 'image/jpeg', buffer: photo }
  const unknown = 'A'.repeat(43)
  const send = (token: string, file: { name: string; mimeType: string; buffer: Buffer }) =>
    request.post('/api/handoff/photo', { headers: { origin: ORIGIN }, multipart: { token, file } })
  const take = (token: string) => post(request, '/api/handoff/take', { token })

  expect((await send(unknown, jpeg)).status()).toBe(410)
  const missing = await take(unknown)
  expect(missing.status()).toBe(410)
  expect((await missing.json()).error).toBe('handoff_expired')
  expect((await take('x')).status()).toBe(410)

  const created = await json<{ token: string; expiresAt: string; expiresInMs: number }>(post(request, '/api/handoff'))
  expect(Date.parse(created.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000)
  expect(created.expiresInMs).toBe(10 * 60_000)
  // 还在等待
  expect((await take(created.token)).status()).toBe(204)

  // 文本冒充 JPEG：按文件头判断，拒绝；二维码仍可用
  const fake = await send(created.token, { name: 'p.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not an image at all') })
  expect(fake.status()).toBe(415)
  expect((await take(created.token)).status()).toBe(204)

  expect((await send(created.token, jpeg)).status()).toBe(201)
  // 同一 token 不能传第二张
  expect((await send(created.token, jpeg)).status()).toBe(409)

  const taken = await take(created.token)
  expect(taken.status()).toBe(200)
  expect(taken.headers()['content-type']).toBe('image/jpeg')
  expect(taken.headers()['cache-control']).toBe('no-store')
  expect((await taken.body()).equals(photo)).toBe(true)
  // 一次性：取走后再取 410，再传仍是“已用过”
  expect((await take(created.token)).status()).toBe(410)
  expect((await send(created.token, jpeg)).status()).toBe(409)
})
