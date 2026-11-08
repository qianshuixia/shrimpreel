import { expect, test, type Page } from '@playwright/test'
import { ORIGIN, buyPackage, content, devLogin, uniqueEmail } from './helpers'

const en = content.en

type Beacon = { id: string; kind: string; message: string; stack: string; page: string }

// 记录页面发往 /api/client-error 的上报和响应码
function watchReports(page: Page) {
  const reports: Beacon[] = []
  const statuses: number[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/client-error') reports.push(JSON.parse(request.postData() ?? '{}') as Beacon)
  })
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/client-error') statuses.push(response.status())
  })
  return { reports, statuses }
}

test('全局异常和未处理的 Promise 拒绝各报一次：带编号、页面地址不带 query；重复错误只报一次，每页最多 5 条，跨域 Script error 不报', async ({ page }) => {
  const { reports, statuses } = watchReports(page)
  await page.goto('/pricing?email=buyer%40example.com#top')
  // 监听在水合后挂上
  await page.waitForLoadState('networkidle')

  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error('checkout failed for buyer@example.com')
    })
    setTimeout(() => {
      throw new Error('checkout failed for buyer@example.com')
    })
    void Promise.reject(new TypeError('network down'))
    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }))
  })
  await expect.poll(() => reports.length).toBe(2)
  expect(reports.map((r) => r.kind).sort()).toEqual(['error', 'rejection'])
  for (const report of reports) {
    expect(report.id).toMatch(/^[0-9a-f]{12}$/)
    expect(report.page).toBe(`${ORIGIN}/pricing`)
    expect(report.stack).toContain('Error')
  }
  expect(reports.find((r) => r.kind === 'error')?.message).toBe('Error: checkout failed for buyer@example.com')
  expect(reports.find((r) => r.kind === 'rejection')?.message).toBe('TypeError: network down')
  expect(reports[0]!.id).not.toBe(reports[1]!.id)

  // 循环报错：再来 6 个不同的错误，本页总共只报 5 条
  await page.evaluate(() => {
    for (let i = 0; i < 6; i++) {
      setTimeout(() => {
        throw new Error(`loop ${i}`)
      })
    }
  })
  await expect.poll(() => reports.length).toBe(5)
  await page.waitForTimeout(1000)
  expect(reports).toHaveLength(5)
  await expect.poll(() => statuses.length).toBe(5)
  expect(new Set(statuses)).toEqual(new Set([204]))
})

test('渲染出错时显示错误页和错误编号，编号与上报一致；接口恢复后点重试回到正常页面', async ({ page }) => {
  const { reports } = watchReports(page)
  await devLogin(page.request, uniqueEmail('crash'))
  await buyPackage(page.request, 'starter')
  // 模拟接口返回了前端没预料到的数据：账单页渲染订单时抛 TypeError
  // 账单页分页请求 /api/orders?page=N，用正则匹配带查询参数的地址
  const ordersApi = /\/api\/orders(\?|$)/
  await page.route(ordersApi, (route) => route.fulfill({ json: { orders: [null] } }))
  await page.goto('/dashboard/billing')

  await expect(page.getByRole('heading', { name: en.common.errorTitle })).toBeVisible()
  const errorId = page.getByTestId('error-id')
  await expect(errorId).toHaveText(/^Error ID: [0-9a-f]{12} /)
  const shown = (await errorId.textContent())!.match(/[0-9a-f]{12}/)![0]
  await expect.poll(() => reports.filter((r) => r.kind === 'boundary').map((r) => r.id)).toEqual([shown])
  const boundary = reports.find((r) => r.kind === 'boundary')!
  expect(boundary.message).toMatch(/^TypeError: /)
  expect(boundary.page).toBe(`${ORIGIN}/dashboard/billing`)

  await page.unroute(ordersApi)
  await page.getByRole('button', { name: en.common.retry }).click()
  await expect(page.getByTestId('orders-table')).toBeVisible()
  await expect(page.getByTestId('error-id')).toHaveCount(0)
})

test('上报接口不要求同源、只回 204；非 JSON 或超大的上报直接丢弃', async ({ request }) => {
  const report = { id: 'abcdef012345', kind: 'error', message: 'Error: x', stack: '', page: 'https://example.com/' }
  // sendBeacon 不一定带 Origin，不能被 CSRF 校验拦下
  const res = await request.post('/api/client-error', { data: JSON.stringify(report), headers: { 'content-type': 'text/plain' } })
  expect(res.status()).toBe(204)
  expect(await res.text()).toBe('')
  for (const data of ['not json', JSON.stringify({ ...report, stack: 'x'.repeat(10_000) })]) {
    const dropped = await request.post('/api/client-error', { data, headers: { 'content-type': 'text/plain' } })
    expect(dropped.status()).toBe(204)
  }
})

// Chrome / Google 整页翻译把文字节点（连同行内元素）挪进它自己的 <font> 里，React 之后 insertBefore / removeChild
// 的参照节点就不在原父节点下，抛 NotFoundError、整页变错误页。src/lib/translate-guard.ts 在水合前装上防护
test('浏览器翻译防护：参照节点被包进翻译的 <font> 后，插入 / 删除不抛 NotFoundError、顺序不乱', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const result = await page.evaluate(() => {
    const box = document.createElement('div')
    const text = document.createTextNode('Drop a photo')
    const tail = document.createElement('span')
    box.appendChild(text)
    box.appendChild(tail)
    const font = document.createElement('font')
    box.replaceChild(font, text)
    font.appendChild(text)
    const added = document.createElement('b')
    let error = ''
    try {
      box.insertBefore(added, text) // React 以为 text 还是 box 的子节点
      box.removeChild(text)
    } catch (e) {
      error = String(e)
    }
    return { error, order: [...box.childNodes].map((n) => n.nodeName) }
  })
  expect(result.error).toBe('')
  expect(result.order).toEqual(['B', 'FONT', 'SPAN'])
})
