// 按 src/config/site.ts 的积分包在 Stripe 建一次性 Product + Price、按在售的订阅套餐（sellingPlans）建 recurring Price，可选建/改 webhook 端点并取签名密钥。
// 凭据从 .dev.vars（或同名环境变量）读取：STRIPE_SECRET_KEY；STRIPE_ENVIRONMENT=live（或 --live）时要求正式 Key（sk_live_ / rk_live_），否则要求 test Key（sk_test_ / rk_test_）。
// 受限 Key（rk_）需要权限：Products 写、Prices 写；用 --webhook 时还要 Webhook Endpoints 写。
// （这是脚本自己的权限。站点运行时的 Key 权限见 README 的“第三方回调地址”。）
//
//   node scripts/stripe-setup.mjs                                         # 只打印计划
//   node scripts/stripe-setup.mjs --apply                                 # 建 Product / Price，打印 STRIPE_PRODUCTS
//   node scripts/stripe-setup.mjs --apply --write-dev-vars --webhook https://<host>/api/webhooks/stripe
//   node scripts/stripe-setup.mjs --apply --write-dev-vars --webhook https://<new-host>/api/webhooks/stripe --webhook-id we_xxx  # 隧道换域名后改 URL
//
// 已在 STRIPE_PRODUCTS 里有 id 的积分包和订阅套餐会跳过；没有的先按 lookup_key 查已有的 active Price 复用，重复运行不会重复建。
// STRIPE_PRODUCTS 的值是 Price ID（price_...）。
// webhook 签名密钥（whsec_）只在创建端点时返回一次，只写进 .dev.vars 的 STRIPE_WEBHOOK_SECRET（需 --write-dev-vars），不打印；
// 没加 --write-dev-vars 就要到后台 Developers → Webhooks 查看。生产用 `wrangler secret put STRIPE_WEBHOOK_SECRET`。
// 任何输出都不带 Key 和 webhook 密钥；401/403 不打印 Stripe 原文（里面有打码的 Key）。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { sellingPlans, site } from '../src/config/site.ts'

// 与 src/server/payments/stripe.ts 的 STRIPE_API_VERSION 保持一致（脚本独立，不 import src/server）
const STRIPE_API_VERSION = '2026-09-30.endive'
const STRIPE_API = 'https://api.stripe.com/v1'

// 与 normalizeStripeEvent 处理的事件一致；开了订阅时加上账单和订阅状态事件
const SUBSCRIPTION_EVENTS = ['invoice.paid', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']
const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'refund.created',
  'refund.updated',
  'charge.dispute.created',
  'charge.dispute.closed',
  'radar.early_fraud_warning.created',
  ...(site.plans.length ? SUBSCRIPTION_EVENTS : []),
]

const args = parseArgs(process.argv.slice(2))
const devVarsPath = new URL('../.dev.vars', import.meta.url)
const vars = { ...readDevVars(devVarsPath), ...pickEnv(['STRIPE_SECRET_KEY', 'STRIPE_PRODUCTS', 'STRIPE_ENVIRONMENT']) }
const environment = args.live ? 'live' : (vars.STRIPE_ENVIRONMENT ?? 'test')
const apiKey = vars.STRIPE_SECRET_KEY?.trim()
const existing = safeJson(vars.STRIPE_PRODUCTS) ?? {}

// Key 前缀必须和环境一致，防止把 test 数据建到正式账户（或反过来）；报错不带 Key
if (apiKey) {
  const prefixes = environment === 'live' ? ['sk_live_', 'rk_live_'] : ['sk_test_', 'rk_test_']
  if (!prefixes.some((p) => apiKey.startsWith(p))) {
    fail(`STRIPE_SECRET_KEY 前缀与环境不符：environment=${environment} 需要以 ${prefixes.join(' 或 ')} 开头`)
  }
}

const plan = site.packages.map((pkg) => ({
  packageId: pkg.id,
  skip: Boolean(existing[pkg.id]),
  currency: pkg.currency.toLowerCase(),
  priceCents: pkg.priceCents,
  interval: null,
  lookupKey: `${site.domain}:${pkg.id}:${pkg.priceCents}:${pkg.currency.toLowerCase()}`,
  productId: productIdOf(pkg.id),
  product: {
    name: `${site.brandName} · ${pkg.credits} credits`.slice(0, 64),
    description: `${pkg.credits} credits for ${site.brandName}. One-time purchase, credits never expire.`,
    metadata: { packageId: pkg.id, credits: String(pkg.credits), site: site.domain },
  },
}))
for (const sub of sellingPlans) {
  plan.push({
    packageId: sub.id,
    skip: Boolean(existing[sub.id]),
    currency: sub.currency.toLowerCase(),
    priceCents: sub.priceCents,
    interval: sub.interval === 'year' ? 'year' : 'month',
    lookupKey: `${site.domain}:${sub.id}:${sub.priceCents}:${sub.currency.toLowerCase()}`,
    productId: productIdOf(sub.id),
    product: {
      name: `${site.brandName} · ${sub.interval === 'year' ? 'Yearly' : 'Monthly'} (${sub.credits} credits / month)`.slice(0, 64),
      description: `${sub.credits} credits every month for ${site.brandName}. Renews every ${sub.interval} until canceled; monthly credits expire at the end of each month.`,
      metadata: { packageId: sub.id, credits: String(sub.credits), interval: sub.interval, site: site.domain },
    },
  })
}

console.log(`environment=${environment} apply=${Boolean(args.apply)}`)
for (const item of plan) {
  const price = `${(item.priceCents / 100).toFixed(2)} ${item.currency.toUpperCase()}${item.interval ? ` / ${item.interval}` : ''}`
  console.log(`  ${item.skip ? 'skip  ' : 'create'} ${item.packageId.padEnd(10)} ${item.product.name} (${price})${item.skip ? ` → ${existing[item.packageId]}` : ` lookup_key=${item.lookupKey}`}`)
}
if (args.webhook) console.log(`  webhook ${args['webhook-id'] ? `update ${args['webhook-id']} →` : 'add'} ${args.webhook} events=${WEBHOOK_EVENTS.join(',')}`)
if (!args.apply) {
  console.log('dry run：加 --apply 执行')
  process.exit(0)
}

if (!apiKey) fail('缺少 STRIPE_SECRET_KEY')
if (args['write-dev-vars'] && !existsSync(devVarsPath)) fail('.dev.vars 不存在')

const products = { ...existing }
for (const item of plan) {
  if (item.skip) continue
  // 先按 lookup_key 找已有的 active Price（上次中途失败或手动建过的）
  const found = await request('GET', '/prices', { 'lookup_keys': [item.lookupKey], active: true, limit: 1 })
  let priceId = found.data?.[0]?.id
  if (priceId) {
    console.log(`reused  ${item.packageId} → ${priceId}`)
  } else {
    // default_price_data 不支持 lookup_key，所以先建 Product，再建带 lookup_key 的 Price。
    // Product 用固定 id：上次建了 Product 但 Price 失败时，重跑复用它，不留孤儿 Product
    const product = await ensureProduct(item)
    const price = await request('POST', '/prices', {
      product: product.id,
      unit_amount: item.priceCents,
      currency: item.currency,
      ...(item.interval ? { recurring: { interval: item.interval } } : {}),
      lookup_key: item.lookupKey,
      metadata: { packageId: item.packageId },
    })
    priceId = price.id
    console.log(`created ${item.packageId} → ${priceId} (product ${product.id})`)
  }
  products[item.packageId] = priceId
}
const productsJson = JSON.stringify(products)
console.log(`STRIPE_PRODUCTS=${productsJson}`)

let webhookId = args['webhook-id']
let webhookSecret = null
if (args.webhook && webhookId) {
  await request('POST', `/webhook_endpoints/${encodeURIComponent(webhookId)}`, { url: args.webhook, enabled_events: WEBHOOK_EVENTS })
  console.log(`webhook updated: ${webhookId} → ${args.webhook}`)
} else if (args.webhook) {
  const data = await request('POST', '/webhook_endpoints', {
    url: args.webhook,
    api_version: STRIPE_API_VERSION,
    description: `${site.domain} credits`,
    enabled_events: WEBHOOK_EVENTS,
  })
  webhookId = data.id
  webhookSecret = data.secret ?? null
  console.log(`webhook added: ${webhookId} → ${args.webhook}`)
}

if (args['write-dev-vars']) {
  let text = readFileSync(devVarsPath, 'utf8')
  text = setVar(text, 'STRIPE_PRODUCTS', `'${productsJson}'`)
  const written = ['STRIPE_PRODUCTS']
  if (webhookSecret) {
    text = setVar(text, 'STRIPE_WEBHOOK_SECRET', `"${webhookSecret}"`)
    written.push('STRIPE_WEBHOOK_SECRET')
  } else if (args.webhook && !args['webhook-id']) fail('Stripe 没有返回 webhook secret')
  writeFileSync(devVarsPath, text)
  console.log(`已写入 .dev.vars 的 ${written.join('、')}`)
} else if (args.webhook && !args['webhook-id']) {
  console.log('注意：webhook 签名密钥只在创建时返回一次，没有保存。请删除该端点后加 --write-dev-vars 重跑，或到后台 Developers → Webhooks 查看。')
}

// ---------- helpers ----------

// 站点 + 套餐 id 推出的 Product id（Stripe 允许自定义，字母数字、下划线和连字符）
function productIdOf(id) {
  return `sr_${site.domain}_${id}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100)
}

// 按固定 id 取 Product：不存在就建，存在就更新名称和说明（售价变了会换新 Price，Product 保持不变）
async function ensureProduct(item) {
  const current = await request('GET', `/products/${item.productId}`, undefined, { allow404: true })
  if (!current) return request('POST', '/products', { id: item.productId, ...item.product, active: true })
  return request('POST', `/products/${item.productId}`, { ...item.product, active: true })
}

// 调用 Stripe REST API（表单编码）。失败时打印 HTTP 状态和 error.code / error.message；401/403 不打印原文，里面有打码的 Key
async function request(method, path, params, { allow404 = false } = {}) {
  const query = method === 'GET' && params ? `?${formEncode(params)}` : ''
  const response = await fetch(`${STRIPE_API}${path}${query}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Stripe-Version': STRIPE_API_VERSION,
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: method === 'POST' ? formEncode(params ?? {}) : undefined,
  })
  const text = await response.text()
  if (allow404 && response.status === 404) return null
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) fail(`${method} ${path} → HTTP ${response.status}（Key 无效或权限不足，不打印 Stripe 原文）`)
    const error = safeJson(text)?.error ?? {}
    fail(`${method} ${path} → HTTP ${response.status} ${[error.code, error.message].filter(Boolean).join(': ')}`.trim())
  }
  return text ? JSON.parse(text) : {}
}

// Stripe 的表单编码：嵌套对象写成 a[b]=c，数组写成 a[0][b]=c
function formEncode(params) {
  const out = new URLSearchParams()
  const walk = (value, key) => {
    if (value === undefined || value === null) return
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${key}[${index}]`))
    else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, `${key}[${k}]`)
    else out.append(key, String(value))
  }
  for (const [key, value] of Object.entries(params)) walk(value, key)
  return out.toString()
}

function readDevVars(path) {
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!match) continue
    let value = match[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (value) out[match[1]] = value
  }
  return out
}

function setVar(text, name, value) {
  const re = new RegExp(`^${name}=.*$`, 'm')
  return re.test(text) ? text.replace(re, () => `${name}=${value}`) : `${text.trimEnd()}\n${name}=${value}\n`
}

function pickEnv(names) {
  return Object.fromEntries(names.filter((n) => process.env[n]).map((n) => [n, process.env[n]]))
}

function parseArgs(list) {
  const out = {}
  for (let i = 0; i < list.length; i++) {
    const key = list[i].replace(/^--/, '')
    const next = list[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i++
    } else out[key] = true
  }
  return out
}

function safeJson(text) {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
