import { readFileSync } from 'node:fs'
import { expect, type APIRequestContext, type APIResponse } from '@playwright/test'
import { defaultStyle, site } from '../../src/config/site'
import { en } from '../../src/content/en'
import { zh } from '../../src/content/zh'

// 3000 被占用时用 E2E_PORT 换端口（与 playwright.config.ts 一致）
export const ORIGIN = `http://127.0.0.1:${process.env.E2E_PORT ?? '3000'}`
export const PHOTO = 'tests/fixtures/photo.jpg'
// 首页生成器默认选中主推风格（site.featuredStyleId），它可能是双人或自带时长的风格。
// 按“一张照片 + site.durations”写的用例从这里打开，固定用默认的单人风格。
export const SOLO_QUERY = `?style=${defaultStyle.id}`
export const SOLO_HOME = `/${SOLO_QUERY}`

// 页面文案（站点里按语言懒加载，测试直接调用文案工厂）
export const content = { en: en(site), zh: zh(site) }

export function uniqueEmail(tag: string) {
  return `e2e-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`
}

// 写接口有同源校验（CSRF），APIRequestContext 默认不带 Origin，这里统一补上
export function post(request: APIRequestContext, path: string, data?: unknown) {
  return request.post(path, { data, headers: { origin: ORIGIN } })
}

export async function json<T>(response: APIResponse | Promise<APIResponse>, status = 200): Promise<T> {
  const res = await response
  expect(res.status(), `${res.url()} → ${await res.text()}`).toBe(status)
  return (await res.json()) as T
}

export async function devLogin(request: APIRequestContext, email: string) {
  const data = await json<{ user: { id: string; email: string; credits: number; role: string } }>(
    post(request, '/api/auth/dev-login', { email }),
  )
  return data.user
}

export async function credits(request: APIRequestContext) {
  const data = await json<{ user: { credits: number } | null }>(request.get('/api/me'))
  return data.user!.credits
}

export async function ledger(request: APIRequestContext) {
  const data = await json<{ balance: number; entries: Array<{ delta: number; reason: string; ref_id: string | null }> }>(
    request.get('/api/credits/ledger'),
  )
  return data.entries
}

// 走真实下单接口 + mock 回调，与真实 webhook 共用入账逻辑
export async function buyPackage(request: APIRequestContext, packageId: string) {
  const { orderId } = await json<{ orderId: string; url: string }>(post(request, '/api/checkout', { packageId, locale: 'en' }))
  await json(post(request, '/api/mock-payments/complete', { orderId, outcome: 'paid' }))
  return orderId
}

export async function uploadPhoto(request: APIRequestContext, buffer = readFileSync(PHOTO), mimeType = 'image/jpeg') {
  return request.post('/api/uploads', {
    headers: { origin: ORIGIN },
    multipart: { file: { name: 'photo.jpg', mimeType, buffer } },
  })
}

// ---- 套餐 / 时长 / 订阅的数值：一律从 site 推算，派生站改了定价这些用例也成立 ----

export function pkg(id: string) {
  const found = site.packages.find((p) => p.id === id)
  if (!found) throw new Error(`site.packages 里没有套餐 ${id}`)
  return found
}

export function plan(id: string) {
  const found = site.plans.find((p) => p.id === id)
  if (!found) throw new Error(`site.plans 里没有订阅 ${id}`)
  return found
}

export function durationCredits(id: string) {
  const found = site.durations.find((d) => d.id === id)
  if (!found) throw new Error(`site.durations 里没有时长 ${id}`)
  return found.credits
}

// 部分退款回收的积分：与 src/server/orders.ts 的 planRefund 同一公式（按金额比例四舍五入，封顶到剩余积分）
export function clawbackCredits(order: { credits: number; priceCents: number }, refundedCents: number, alreadyRefundedCredits = 0) {
  return Math.min(order.credits - alreadyRefundedCredits, Math.round((order.credits * refundedCents) / order.priceCents))
}

// 定价页年付卡片的“Save X%”：与 src/components/Pricing.tsx 的 yearlySaving 同一公式，没有可比月付时为 null
export function yearlySavingPercent(yearly: { credits: number; priceCents: number; currency: string }) {
  const monthly = site.plans.find((m) => m.interval === 'month' && m.credits === yearly.credits && m.currency === yearly.currency)
  if (!monthly) return null
  const percent = Math.round((1 - yearly.priceCents / (monthly.priceCents * 12)) * 100)
  return percent > 0 ? percent : null
}
