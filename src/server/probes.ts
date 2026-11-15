import type { Hono } from 'hono'
import { sellingPlans, site } from '#/config/site'
import { ALERT_RULES } from './alerts'
import { emailConfig } from './email'
import { audit, requireAdmin } from './http'
import { getModerationProvider } from './moderation'
import { activePaymentProviderId, getPaymentProvider } from './payments'
import { getSettings } from './settings'
import { dodoBaseUrl } from './payments/dodo'
import { STRIPE_API_VERSION } from './payments/stripe'
import { waffoEnvironment } from './payments/waffo'
import type { AppContext, UserRow } from './types'
import { ApiError, cleanSecret, createId, parseJsonRecord } from './util'
import { queryVideoBalance } from './video-balance'

// 后台“测试连接”：按当前配置对每个依赖做一次只读或可自行清理的探测，不建收银台、不提交生成任务。
// 结果里只有状态和说明，不回显任何密钥（说明文字里出现的密钥值也会被替换掉）。

export const PROBE_TARGETS = ['storage', 'kv', 'email', 'payment', 'video', 'moderation'] as const
export type ProbeTarget = (typeof PROBE_TARGETS)[number]
export type ProbeStatus = 'ok' | 'warn' | 'fail' | 'skipped'
export interface ProbeResult {
  target: ProbeTarget
  provider: string
  status: ProbeStatus
  message: string
  ms: number
}
type Outcome = { status: ProbeStatus; message: string }

const ok = (message: string): Outcome => ({ status: 'ok', message })
const warn = (message: string): Outcome => ({ status: 'warn', message })
const fail = (message: string): Outcome => ({ status: 'fail', message })

async function probeStorage(env: Env): Promise<Outcome> {
  const key = `_probe/${createId('prb')}`
  await env.MEDIA.put(key, 'probe')
  try {
    const head = await env.MEDIA.head(key)
    if (!head) return fail('写入后读不到对象')
  } finally {
    await env.MEDIA.delete(key)
  }
  return ok('写入、读取、删除正常')
}

async function probeKv(env: Env): Promise<Outcome> {
  const key = `probe:${createId('prb')}`
  await env.KV.put(key, '1', { expirationTtl: 60 })
  const value = await env.KV.get(key)
  await env.KV.delete(key)
  return value === '1' ? ok('写入、读取、删除正常') : fail('写入后读不到值')
}

async function probeEmail(env: Env, admin: UserRow): Promise<Outcome> {
  const config = emailConfig(env)
  if (!config) return { status: 'skipped', message: '没有配置 EMAIL_FROM，或既没有 RESEND_API_KEY 也没有 send_email binding，站点不发邮件' }
  const text = `这是 ${site.brandName} 后台“测试连接”发出的测试邮件，收到说明发信配置正常，无需回复。`
  const { messageId } = await config.mailer.send({
    from: config.from,
    to: admin.email,
    subject: `[${site.brandName}] 测试邮件`,
    text,
    html: `<p>${text}</p>`,
    replyTo: config.from.email,
  })
  const channel = config.provider === 'resend' ? 'Resend' : 'Cloudflare Email Service'
  return ok(`已通过 ${channel} 从 ${config.from.email} 发到 ${admin.email}（${messageId}），请到收件箱确认`)
}

async function probePayment(env: Env, override: string): Promise<Outcome> {
  const id = activePaymentProviderId(env, override)
  if (id === 'mock') return ok('mock 支付，不调用外部接口')
  const products = parseJsonRecord(id === 'dodo' ? env.DODO_PRODUCTS : id === 'stripe' ? env.STRIPE_PRODUCTS : env.WAFFO_PRODUCTS)
  // 积分包和订阅套餐都要有商品
  const items = [...site.packages, ...sellingPlans]
  const missing = items.filter((pack) => !products[pack.id]).map((pack) => pack.id)
  if (id === 'waffo') {
    // 用不存在的订单号查一次付款：能返回空列表说明商户号、私钥和签名都正确
    await getPaymentProvider(env, override).fetchPaidEvent!({ id: `probe_${createId('prb')}`, packageId: '', providerSessionId: null })
    const base = `签名和鉴权正常（${waffoEnvironment(env)} 环境）；Waffo 没有按商品查价格的接口，价格请在 Waffo 后台核对`
    return missing.length ? fail(`WAFFO_PRODUCTS 缺少套餐：${missing.join('、')}。${base}`) : ok(base)
  }
  if (id === 'stripe') return probeStripePrices(env, items, products, missing)
  const apiKey = cleanSecret(env.DODO_API_KEY)
  if (!apiKey) return fail('DODO_API_KEY 未配置')
  const problems = missing.map((packId) => `${packId}：DODO_PRODUCTS 里没有商品 ID`)
  const warnings: string[] = []
  for (const pack of items) {
    const productId = products[pack.id]
    if (!productId) continue
    const response = await fetch(`${dodoBaseUrl(env)}/products/${encodeURIComponent(productId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 401) return fail(`DODO_API_KEY 无效，或与 DODO_ENVIRONMENT=${env.DODO_ENVIRONMENT || 'test_mode'} 不匹配`)
    if (response.status === 404) {
      problems.push(`${pack.id}：商品 ${productId} 不存在（检查 DODO_ENVIRONMENT）`)
      continue
    }
    if (!response.ok) {
      problems.push(`${pack.id}：查询商品返回 HTTP ${response.status}`)
      continue
    }
    const body = (await response.json().catch(() => null)) as { price?: { price?: unknown; currency?: unknown } } | null
    const price = body?.price?.price
    const currency = body?.price?.currency
    if (typeof price !== 'number' || typeof currency !== 'string') warnings.push(`${pack.id}：读不到商品价格`)
    else if (currency.toUpperCase() !== pack.currency) warnings.push(`${pack.id}：Dodo 币种是 ${currency}，site.ts 是 ${pack.currency}`)
    // 实收低于订单金额的付款会被判为 mismatch、不入账（orders.ts checkPaidEvent）
    else if (price < pack.priceCents) problems.push(`${pack.id}：Dodo 售价 ${price} 低于 site.ts 的 ${pack.priceCents}，付款会因金额不符不入账`)
    else if (price > pack.priceCents) warnings.push(`${pack.id}：Dodo 售价 ${price} 高于页面展示的 ${pack.priceCents}`)
  }
  if (problems.length) return fail([...problems, ...warnings].join('；'))
  if (warnings.length) return warn(warnings.join('；'))
  return ok(`鉴权正常，${items.length} 个套餐的商品和价格与 site.ts 一致`)
}

// 逐个查 STRIPE_PRODUCTS 里的 Price：金额、币种和 site.ts 一致，积分包是一次性价格、订阅套餐是周期价格
async function probeStripePrices(
  env: Env,
  items: { id: string; priceCents: number; currency: string }[],
  products: Record<string, string>,
  missing: string[],
): Promise<Outcome> {
  const apiKey = cleanSecret(env.STRIPE_SECRET_KEY)
  if (!apiKey) return fail('STRIPE_SECRET_KEY 未配置')
  const planIntervals = new Map(sellingPlans.map((plan) => [plan.id, plan.interval]))
  const problems = missing.map((packId) => `${packId}：STRIPE_PRODUCTS 里没有 Price ID`)
  const warnings: string[] = []
  for (const pack of items) {
    const priceId = products[pack.id]
    if (!priceId) continue
    const response = await fetch(`https://api.stripe.com/v1/prices/${encodeURIComponent(priceId)}`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Stripe-Version': STRIPE_API_VERSION },
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 401) return fail('STRIPE_SECRET_KEY 无效')
    if (response.status === 403) return fail('STRIPE_SECRET_KEY 没有读取 Prices 的权限（受限 Key 需要的权限见 docs/payments.md）')
    if (response.status === 404) {
      problems.push(`${pack.id}：Price ${priceId} 不存在（检查 Key 和 STRIPE_ENVIRONMENT 是否同一模式）`)
      continue
    }
    if (!response.ok) {
      problems.push(`${pack.id}：查询 Price 返回 HTTP ${response.status}`)
      continue
    }
    const body = (await response.json().catch(() => null)) as {
      unit_amount?: unknown
      currency?: unknown
      type?: unknown
      active?: unknown
      recurring?: { interval?: unknown; interval_count?: unknown } | null
    } | null
    const price = body?.unit_amount
    const currency = body?.currency
    const interval = planIntervals.get(pack.id)
    const recurring = Boolean(interval)
    if (body?.active === false) problems.push(`${pack.id}：Price ${priceId} 已停用，下单会失败`)
    else if (body?.type !== (recurring ? 'recurring' : 'one_time')) {
      problems.push(`${pack.id}：${recurring ? '订阅套餐要用周期价格（recurring）' : '积分包要用一次性价格（one_time）'}`)
    } else if (recurring && (body?.recurring?.interval !== interval || (body?.recurring?.interval_count ?? 1) !== 1)) {
      problems.push(`${pack.id}：Price 的扣款周期不是${interval === 'year' ? '每年' : '每月'}一次`)
    } else if (typeof price !== 'number' || typeof currency !== 'string') warnings.push(`${pack.id}：读不到价格`)
    else if (currency.toUpperCase() !== pack.currency) warnings.push(`${pack.id}：Stripe 币种是 ${currency}，site.ts 是 ${pack.currency}`)
    else if (price < pack.priceCents) problems.push(`${pack.id}：Stripe 售价 ${price} 低于 site.ts 的 ${pack.priceCents}，付款会因金额不符不入账`)
    else if (price > pack.priceCents) warnings.push(`${pack.id}：Stripe 售价 ${price} 高于页面展示的 ${pack.priceCents}`)
  }
  if (problems.length) return fail([...problems, ...warnings].join('；'))
  if (warnings.length) return warn(warnings.join('；'))
  return ok(`鉴权正常，${items.length} 个套餐的 Price 和价格与 site.ts 一致`)
}

function balanceOutcome(amount: number, currency: string, provider: string) {
  const text = `${amount.toFixed(2)} ${currency}`
  return amount < ALERT_RULES.provider_balance.lowUsd ? warn(`鉴权正常，但 ${provider} 余额只剩 ${text}，请尽快充值`) : ok(`鉴权正常，余额 ${text}`)
}

async function probeVideo(env: Env): Promise<Outcome> {
  const result = await queryVideoBalance(env)
  if (result.status === 'mock') return ok('mock 视频服务商，不调用外部接口')
  if (result.status === 'no_key') return fail(`${result.keyName} 未配置`)
  if (result.status === 'unauthorized') return fail(`${result.keyName} 无效`)
  // Key 有效但权限范围不含 billing:usage:read：不影响生成，只是查不到余额
  if (result.status === 'forbidden') return warn(`${result.keyName} 有效，但没有 billing:usage:read 权限，查不到余额（不影响生成）`)
  if (result.status === 'http') return fail(`查询余额返回 HTTP ${result.code}`)
  if (result.status === 'unreadable') return warn('鉴权正常，但读不到余额')
  return balanceOutcome(result.amount, result.currency, result.provider)
}

async function probeModeration(env: Env): Promise<Outcome> {
  if (env.MODERATION_PROVIDER === 'none') return { status: 'skipped', message: 'MODERATION_PROVIDER=none，上传的照片不审核' }
  if (env.MODERATION_PROVIDER !== 'openai') {
    getModerationProvider(env)
    return ok('mock 审核，不调用外部接口')
  }
  const key = cleanSecret(env.OPENAI_API_KEY)
  if (!key) return fail('OPENAI_API_KEY 未配置')
  const response = await fetch('https://api.openai.com/v1/models/omni-moderation-latest', {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 401) return fail('OPENAI_API_KEY 无效')
  if (!response.ok) return fail(`查询 omni-moderation-latest 返回 HTTP ${response.status}`)
  return ok('鉴权正常，omni-moderation-latest 可用')
}

const PROVIDER_LABEL: Record<ProbeTarget, (env: Env) => string> = {
  storage: () => 'R2',
  kv: () => 'KV',
  email: () => 'Email',
  payment: (env) => env.PAYMENT_PROVIDER || '(未配置)',
  video: (env) => env.VIDEO_PROVIDER || '(未配置)',
  moderation: (env) => env.MODERATION_PROVIDER || '(未配置)',
}

// 名字像密钥的环境变量，值出现在说明里就替换掉（上游报错可能原样带回请求内容）
function redact(message: string, env: Env) {
  let out = message
  for (const [name, value] of Object.entries(env as unknown as Record<string, unknown>)) {
    if (typeof value !== 'string' || !/KEY|SECRET|TOKEN|PASSWORD/.test(name)) continue
    for (const secret of new Set([value, value.trim()])) if (secret.length >= 8) out = out.split(secret).join('***')
  }
  return out.slice(0, 500)
}

export async function runProbe(env: Env, target: ProbeTarget, admin: UserRow): Promise<ProbeResult> {
  const started = Date.now()
  // 支付按后台“收款渠道”实际生效的支付商测试
  const paymentOverride = target === 'payment' ? (await getSettings(env)).paymentProvider : ''
  let outcome: Outcome
  try {
    if (target === 'storage') outcome = await probeStorage(env)
    else if (target === 'kv') outcome = await probeKv(env)
    else if (target === 'email') outcome = await probeEmail(env, admin)
    else if (target === 'payment') outcome = await probePayment(env, paymentOverride)
    else if (target === 'video') outcome = await probeVideo(env)
    else outcome = await probeModeration(env)
  } catch (error) {
    outcome = fail(error instanceof Error ? error.message : String(error))
  }
  return { target, provider: target === 'payment' && paymentOverride ? paymentOverride : PROVIDER_LABEL[target](env), status: outcome.status, message: redact(outcome.message, env), ms: Date.now() - started }
}

export function registerProbeAdminRoutes(routes: Hono<AppContext>) {
  routes.post('/probes/:target', async (c) => {
    const admin = requireAdmin(c)
    const target = c.req.param('target') as ProbeTarget
    if (!PROBE_TARGETS.includes(target)) throw new ApiError(404, 'not_found')
    const result = await runProbe(c.env, target, admin)
    await audit(c.env, admin, 'probe.run', 'probe', target, { provider: result.provider, status: result.status })
    return c.json(result)
  })
}
