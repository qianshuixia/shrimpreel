// 上线配置检查：部署前的 `npm run doctor`（scripts/doctor.mjs，按 wrangler 配置和 `wrangler secret list` 的名字检查）
// 与后台概览的“配置检查”卡片（按运行时 env 检查）共用这一套规则。只报告缺什么、错在哪，不输出任何密钥值。
// 本文件不能有 import：scripts/doctor.mjs 用 Node 直接加载 .ts 源码。

export type ConfigLevel = 'error' | 'warn'
export interface ConfigIssue {
  level: ConfigLevel
  key: string
  message: string
}

export interface ConfigInput {
  vars: Record<string, string | undefined>
  // 运行时传入密钥的值（可额外检查强度）；doctor 只知道名字，已配置的传 true
  secrets: Record<string, string | true | undefined>
  bindings: readonly string[]
  packageIds: readonly string[]
  // 在售的订阅套餐 id（sellingPlans，订阅开关关掉时为空），同样要在 *_PRODUCTS 里有商品
  planIds?: readonly string[]
  // 风格固定的视频服务商（STYLES 里写了 provider 的）：和 VIDEO_PROVIDER 不同的也要有各自的密钥
  styleProviders?: readonly string[]
  siteDomain: string
}

// .dev.vars.example 里的占位值：模板公开后人人都知道，生产环境不能用
export const EXAMPLE_SESSION_SECRET = 'change-me-to-a-long-random-string'
export const REQUIRED_BINDINGS = [
  'DB',
  'MEDIA',
  'KV',
  'VIDEO_QUEUE',
  'EMAIL',
  'ASSETS',
  'UPLOAD_LIMITER',
  'GENERATE_LIMITER',
  'AUTH_LIMITER',
] as const

// 可选绑定：只有用到对应功能时才需要（OUTPUT_MODERATION=frames 需要 MEDIA_TRANSFORM）
export const OPTIONAL_BINDINGS = ['MEDIA_TRANSFORM'] as const

export function isWeakSessionSecret(secret: string) {
  return secret.length < 32 || secret === EXAMPLE_SESSION_SECRET
}

const PAYMENT_SECRETS: Record<string, string[]> = {
  waffo: ['WAFFO_MERCHANT_ID', 'WAFFO_PRIVATE_KEY'],
  dodo: ['DODO_API_KEY', 'DODO_WEBHOOK_SECRET'],
  stripe: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
}
const VIDEO_SECRETS: Record<string, string[]> = { fal: ['FAL_KEY'], yir: ['YIR_API_KEY'], nanoapi: ['NANOAPI_API_KEY'] }
const MODERATION_SECRETS: Record<string, string[]> = { openai: ['OPENAI_API_KEY'], none: [] }
const PLACEHOLDER_HOSTS = /(^|\.)(example\.(com|org|net)|localhost)$|^127\.|SUBDOMAIN/i

const text = (value: string | undefined) => value?.replace(/^\uFEFF+/, '').trim() ?? ''

function hostOf(url: string) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

// 同一站点：完全相同，或一方是另一方的子域名（www.、发信子域名等）
const sameSite = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)

export function checkConfig(input: ConfigInput): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  const error = (key: string, message: string) => issues.push({ level: 'error', key, message })
  const warn = (key: string, message: string) => issues.push({ level: 'warn', key, message })
  const vars = (name: string) => text(input.vars[name])
  const requireSecrets = (names: string[], reason: string) => {
    for (const name of names) {
      const value = input.secrets[name]
      if (value === true) continue
      if (!text(value)) error(name, `缺少密钥 ${name}（${reason}），用 wrangler secret put 写入`)
    }
  }

  const appEnv = vars('APP_ENV')
  const production = appEnv === 'production'
  if (appEnv !== 'production' && appEnv !== 'staging') {
    error('APP_ENV', `APP_ENV=${appEnv || '(空)'}：上线必须是 production（预发用 staging），否则 Cookie 不带 Secure，mock 和开发登录不会被拦截`)
  }

  const siteUrl = vars('SITE_URL')
  const host = hostOf(siteUrl)
  if (!host || !siteUrl.startsWith('https://')) {
    error('SITE_URL', `SITE_URL=${siteUrl || '(空)'}：必须是 https 的站点地址`)
  } else if (PLACEHOLDER_HOSTS.test(host)) {
    error('SITE_URL', `SITE_URL 仍是占位地址（${host}）`)
  } else if (production && !sameSite(host, input.siteDomain.toLowerCase())) {
    error('SITE_URL', `SITE_URL 的域名 ${host} 与 site.domain（${input.siteDomain}）不一致：canonical、sitemap 和 CSRF 同源校验都依赖它们一致`)
  }
  if (production && PLACEHOLDER_HOSTS.test(input.siteDomain)) {
    error('site.domain', `src/config/site.ts 的 domain 仍是占位值（${input.siteDomain}）`)
  }

  const missingBindings = REQUIRED_BINDINGS.filter((name) => !input.bindings.includes(name))
  if (missingBindings.length) error('bindings', `缺少绑定：${missingBindings.join('、')}`)

  // 只有 Google 登录：不配就没人能登录
  if (!vars('GOOGLE_CLIENT_ID')) error('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_ID 为空：站点只有 Google 登录，用户无法登录')
  else requireSecrets(['GOOGLE_CLIENT_SECRET'], 'Google 登录')

  const sessionSecret = input.secrets.SESSION_SECRET
  if (typeof sessionSecret === 'string' && text(sessionSecret) && isWeakSessionSecret(text(sessionSecret))) {
    error('SESSION_SECRET', 'SESSION_SECRET 短于 32 个字符或仍是示例值：生成任务提交不出去，上传图片地址返回 503')
  } else {
    requireSecrets(['SESSION_SECRET'], '签名图片地址和视频服务商回调')
  }

  const payment = vars('PAYMENT_PROVIDER')
  if (payment === 'mock') error('PAYMENT_PROVIDER', 'PAYMENT_PROVIDER=mock：生产环境下单会返回 503')
  else if (!PAYMENT_SECRETS[payment]) error('PAYMENT_PROVIDER', `未知的 PAYMENT_PROVIDER=${payment || '(空)'}，可选 waffo、dodo、stripe`)
  else {
    requireSecrets(PAYMENT_SECRETS[payment], `${payment} 支付`)
    const productsKey = `${payment.toUpperCase()}_PRODUCTS`
    let products: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(vars(productsKey) || '{}')
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) products = parsed as Record<string, unknown>
      else error(productsKey, `${productsKey} 必须是 JSON 对象`)
    } catch {
      error(productsKey, `${productsKey} 不是合法 JSON`)
    }
    const missing = input.packageIds.filter((id) => typeof products[id] !== 'string' || !products[id])
    if (missing.length) error(productsKey, `${productsKey} 缺少积分包的商品 id：${missing.join('、')}`)
    const planIds = input.planIds ?? []
    const missingPlans = planIds.filter((id) => typeof products[id] !== 'string' || !products[id])
    if (missingPlans.length) error(productsKey, `${productsKey} 缺少订阅套餐的商品 id：${missingPlans.join('、')}（订阅商品要按周期单独建）`)
    // Waffo 的客户门户（换卡、恢复订阅）要店铺 ID；没有它扣款失败的用户无法自助更新付款方式
    if (payment === 'waffo' && planIds.length && !vars('WAFFO_STORE_ID')) {
      error('WAFFO_STORE_ID', 'WAFFO_STORE_ID 为空：开了订阅时，账单页的“管理付款”打不开，扣款失败的用户无法换卡')
    }
    const live = payment === 'waffo' ? ['prod', 'production'].includes(vars('WAFFO_ENVIRONMENT')) : vars(`${payment.toUpperCase()}_ENVIRONMENT`) === 'live'
    // Stripe 的 test / live Key 前缀不同（sk_test_、rk_test_ / sk_live_、rk_live_），和 STRIPE_ENVIRONMENT 不符时 webhook 的 livemode 核对会拒收所有事件
    const stripeKey = input.secrets.STRIPE_SECRET_KEY
    if (payment === 'stripe' && typeof stripeKey === 'string' && text(stripeKey)) {
      const keyMode = /^(sk|rk)_live_/.test(text(stripeKey)) ? 'live' : /^(sk|rk)_test_/.test(text(stripeKey)) ? 'test' : null
      if (!keyMode) error('STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY 不是 sk_ 或 rk_ 开头的 Stripe 密钥')
      else if (keyMode !== (live ? 'live' : 'test')) error('STRIPE_SECRET_KEY', `STRIPE_SECRET_KEY 是 ${keyMode} 模式的 Key，但 STRIPE_ENVIRONMENT=${vars('STRIPE_ENVIRONMENT') || '(空)'}`)
    }
    const envKey = `${payment.toUpperCase()}_ENVIRONMENT`
    if (production && !live) warn(envKey, `${envKey}=${vars(envKey) || '(空)'}：仍是 test 模式，不会真实收款`)
    if (!production && live) warn(envKey, `${envKey} 是正式模式，但 APP_ENV 不是 production：预发应使用 test 店铺`)
  }

  const video = vars('VIDEO_PROVIDER')
  if (video === 'mock') error('VIDEO_PROVIDER', 'VIDEO_PROVIDER=mock：生产环境提交生成会返回 503')
  else if (!VIDEO_SECRETS[video]) error('VIDEO_PROVIDER', `未知的 VIDEO_PROVIDER=${video || '(空)'}，可选 fal、yir、nanoapi`)
  else requireSecrets(VIDEO_SECRETS[video], `${video} 视频生成`)
  for (const p of new Set(input.styleProviders ?? [])) {
    if (p === video) continue
    if (!VIDEO_SECRETS[p]) error('styleProviders', `风格指定了未知的视频服务商 ${p || '(空)'}，可选 fal、yir、nanoapi`)
    else requireSecrets(VIDEO_SECRETS[p], `${p} 视频生成（风格指定）`)
  }

  const moderation = vars('MODERATION_PROVIDER')
  if (moderation === 'mock') error('MODERATION_PROVIDER', 'MODERATION_PROVIDER=mock：生产环境上传图片一律返回 503')
  else if (!MODERATION_SECRETS[moderation]) error('MODERATION_PROVIDER', `未知的 MODERATION_PROVIDER=${moderation || '(空)'}，可选 openai、none`)
  else if (moderation === 'none') warn('MODERATION_PROVIDER', 'MODERATION_PROVIDER=none：上传图片不做审核')
  else requireSecrets(MODERATION_SECRETS[moderation], '图片审核')

  // 成片输出审核：frames 要有 Media Transformations 绑定；off 时只有输入照片审核，成片不检查
  const outputModeration = vars('OUTPUT_MODERATION') || 'off'
  if (outputModeration === 'mock') error('OUTPUT_MODERATION', 'OUTPUT_MODERATION=mock：生产环境提交生成后会一直失败重试')
  else if (outputModeration === 'frames') {
    if (!input.bindings.includes('MEDIA_TRANSFORM')) {
      error('OUTPUT_MODERATION', 'OUTPUT_MODERATION=frames 但没有 MEDIA_TRANSFORM 绑定：成片无法抽帧审核，在 wrangler.jsonc 加 "media": { "binding": "MEDIA_TRANSFORM" }')
    }
    if (moderation === 'none') warn('OUTPUT_MODERATION', 'OUTPUT_MODERATION=frames 但 MODERATION_PROVIDER=none：成片不做审核')
  } else if (outputModeration === 'off') {
    if (moderation !== 'none') warn('OUTPUT_MODERATION', 'OUTPUT_MODERATION=off：成片输出不做内容审核（输入照片仍会审核）。欧盟禁止生成未经同意的私密内容，建议改为 frames')
  } else error('OUTPUT_MODERATION', `未知的 OUTPUT_MODERATION=${outputModeration}，可选 frames、off`)

  if (vars('TURNSTILE_SITE_KEY')) requireSecrets(['TURNSTILE_SECRET_KEY'], 'Turnstile')
  else warn('TURNSTILE_SITE_KEY', 'TURNSTILE_SITE_KEY 为空：留言和举报表单没有人机校验，只靠限流')

  // Umami 同域代理（可选）：只检查格式
  const umami = vars('UMAMI_ORIGIN')
  if (umami && !/^https:\/\/[^/?#\s]+$/.test(umami)) warn('UMAMI_ORIGIN', 'UMAMI_ORIGIN 不是不带路径的 https 地址（如 https://umami.example.com）：Umami 统计无法代理')

  // 付款即时通知（可选）：只检查格式，不输出地址（里面带 token）
  const chat = input.secrets.PAYMENT_NOTIFY_WEBHOOK_URL
  if (typeof chat === 'string' && text(chat)) {
    const chatHost = hostOf(text(chat))
    if (!chatHost || !text(chat).startsWith('https://')) {
      warn('PAYMENT_NOTIFY_WEBHOOK_URL', 'PAYMENT_NOTIFY_WEBHOOK_URL 不是 https 地址：付款通知发不出去')
    } else if (chatHost === 'api.telegram.org' && !/[?&]chat_id=[^&]/.test(text(chat))) {
      warn('PAYMENT_NOTIFY_WEBHOOK_URL', 'PAYMENT_NOTIFY_WEBHOOK_URL 是 Telegram 地址但没带 chat_id：付款通知发不出去')
    }
  }

  const admins = vars('ADMIN_EMAILS')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
  if (!admins.length) error('ADMIN_EMAILS', 'ADMIN_EMAILS 为空：没有管理员，举报、留言提醒和系统告警无人接收')
  else if (admins.some((email) => PLACEHOLDER_HOSTS.test(email.split('@')[1] ?? ''))) {
    warn('ADMIN_EMAILS', 'ADMIN_EMAILS 含占位邮箱（example.com 等）：发往它的提醒和告警收不到')
  }

  const from = vars('EMAIL_FROM')
  const fromDomain = from.split('@')[1]?.toLowerCase() ?? ''
  if (!from) warn('EMAIL_FROM', 'EMAIL_FROM 为空：不发交易邮件和管理员提醒')
  else if (!fromDomain || PLACEHOLDER_HOSTS.test(fromDomain)) error('EMAIL_FROM', `EMAIL_FROM=${from}：不是可发信的地址`)
  else {
    // 可选的 Resend 渠道：配了 RESEND_API_KEY 就走 Resend，不再用 send_email binding
    const resend = input.secrets.RESEND_API_KEY === true || Boolean(text(input.secrets.RESEND_API_KEY as string | undefined))
    if (production && !resend) {
      warn(
        'RESEND_API_KEY',
        '未配置 RESEND_API_KEY：Cloudflare Email Service 在 Workers Free 上只能发给 Cloudflare 里已验证的地址（管理员），发给用户需要 Workers Paid，或配置 RESEND_API_KEY 改走 Resend',
      )
    }
    if (production && !PLACEHOLDER_HOSTS.test(input.siteDomain) && !sameSite(fromDomain, input.siteDomain.toLowerCase())) {
      warn(
        'EMAIL_FROM',
        resend
          ? `EMAIL_FROM 的域名 ${fromDomain} 与站点域名 ${input.siteDomain} 不同：确认该域名已在 Resend 完成验证（Domains）`
          : `EMAIL_FROM 的域名 ${fromDomain} 与站点域名 ${input.siteDomain} 不同：确认该域名已在 Email Service 完成 Onboard`,
      )
    }
  }

  return issues
}
