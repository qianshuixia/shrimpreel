import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { defaultStyle, findDuration, findPackage, findPlan, findStyle, isLocale, localePath, sellingPlans, site } from '#/config/site'
import { safeRedirectPath } from '#/lib/redirect'
import { exportFileName, exportUserData } from './account-export'
import { adminRoutes } from './admin'
import { runHealthCheck } from './alerts'
import { backupDatabase } from './backup'
import { classifyTouch, deviceFromUserAgent, requestAttribution, sanitizeTouch } from './attribution'
import { deletedEmailHash, endSession, loadSessionUser, publicUser, startSession, upsertUser } from './auth'
import { CLIENT_ERROR_PATH, summarizeClientError } from './client-error'
import { clawbackStatements, expireStatements, ledgerStatements } from './credits'
import { CSP_REPORT_PATH, summarizeCspReports } from './csp'
import { exchangeGoogleCode, googleAuthRedirect, googleClientId, googleOAuthConfig, verifyGoogleIdToken } from './google'
import { publicGeneration, publicOrder, rateLimit, readJson, requireUser, pageParams } from './http'
import { enqueueJob, failGeneration, handleDeadLetter, handleVideoJob } from './jobs'
import { handoffRoutes } from './handoff'
import { jobToken, readImageFile, readUploadForm, serveR2Object, verifyUploadSignature } from './media'
import { getModerationProvider } from './moderation'
import { processPaymentEvent } from './orders'
import { reconcileOrder, reconcilePendingOrders } from './reconcile'
import { normalizeCode, redeemCode } from './redeem'
import { REFERRAL_COOKIE, ensureReferralCode, normalizeReferralCode, referralSummary, requestReferral } from './referrals'
import { assertCheckoutOpen, assertOpen, dailyCapGuard, generationsToday, getSettings, publicNotice, referralActive } from './settings'
import { seoRoutes } from './seo'
import { assertShareable, findSharedGeneration, loadShare, readSharePoster, startShare, stopShare } from './shares'
import { notifyContactMessage, runTakedownReminders } from './notifications'
import { normalizeDodoEvent, verifyDodoWebhook } from './payments/dodo'
import { expandStripeEvent, normalizeStripeEvent, verifyStripeWebhook } from './payments/stripe'
import { getOrderProvider, getPaymentProvider, mockPaidKey } from './payments'
import type { PaymentEvent } from './payments/types'
import { WebhookVerificationError } from './payments/types'
import { normalizeWaffoEvent, verifyWaffoWebhook, waffoEnvironment } from './payments/waffo'
import { sweepExpiredMedia } from './retention'
import {
  addInterval,
  grantDueSubscriptions,
  latestSubscription,
  liveSubscription,
  publicSubscription,
  setCancelAtPeriodEnd,
  subscriptionRef,
} from './subscriptions'
import { createTakedown, isBlockedMedia, parseTakedown, type TakedownInput } from './takedown'
import { turnstileSiteKey, verifyTurnstile } from './turnstile'
import type { AppContext, GenerationRow, OrderRow, UploadRow, UserRow } from './types'
import { ApiError, constantTimeEqual, createId, isCheckConstraintError, isProduction, nowIso, randomToken, sha256Hex } from './util'
import { activeVideoProviderId } from './video'

const MAX_ACTIVE_JOBS_PER_USER = 3

export const app = new Hono<AppContext>()

app.onError((error, c) => {
  if (error instanceof ApiError) {
    const status = error.status as ContentfulStatusCode
    // 5xx 的 message 可能带配置或支付商细节：写日志，只回给管理员（后台据此显示退款被拒的原因），其他人只拿到错误码
    if (error.status >= 500) {
      console.error(`[api] ${c.req.method} ${c.req.path} ${error.code}: ${error.message}`)
      if (c.get('user')?.role !== 'admin') return c.json({ error: error.code }, status)
    }
    return c.json({ error: error.code, message: error.message }, status)
  }
  if (error instanceof WebhookVerificationError) {
    console.warn('webhook rejected:', error.message)
    return c.json({ error: 'invalid_webhook' }, 401)
  }
  console.error(error)
  return c.json({ error: 'internal_error' }, 500)
})

// CSRF：有副作用的请求必须同源（webhook 除外，它们有各自的签名校验；CSP 报告和前端错误上报由浏览器发出，
// 不一定带 Origin，只写日志）
app.use('/api/*', async (c, next) => {
  const method = c.req.method
  const external = c.req.path.startsWith('/api/webhooks/') || c.req.path === CSP_REPORT_PATH || c.req.path === CLIENT_ERROR_PATH
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !external) {
    const origin = c.req.header('origin')
    const allowed = [new URL(c.req.url).origin, new URL(c.env.SITE_URL).origin]
    if (!origin || !allowed.includes(origin)) throw new ApiError(403, 'bad_origin')
  }
  c.set('user', external ? null : await loadSessionUser(c))
  await next()
})

app.get('/api/health', (c) => c.json({ ok: true, time: nowIso() }))

// CSP 违规报告（server/csp.ts）：只写日志不落库；按 IP 限流，超限或报告过大时静默丢弃
app.post(CSP_REPORT_PATH, async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'local'
  const allowed = !c.env.AUTH_LIMITER || (await c.env.AUTH_LIMITER.limit({ key: `csp:${ip}` })).success
  const size = Number(c.req.header('content-length'))
  if (allowed && size > 0 && size <= 16_384) {
    for (const line of summarizeCspReports(await c.req.text())) console.warn('[csp]', line)
  }
  return c.body(null, 204)
})

// 前端错误上报（server/client-error.ts）：同样只写日志、按 IP 限流，超限、过大或格式不对时静默丢弃
app.post(CLIENT_ERROR_PATH, async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'local'
  const allowed = !c.env.AUTH_LIMITER || (await c.env.AUTH_LIMITER.limit({ key: `client-error:${ip}` })).success
  const size = Number(c.req.header('content-length'))
  if (allowed && size > 0 && size <= 8_192) {
    const line = summarizeClientError(await c.req.text())
    if (line) console.error('[client-error]', line)
  }
  return c.body(null, 204)
})

app.get('/api/me', async (c) => {
  const user = c.get('user')
  const settings = await getSettings(c.env)
  return c.json({
    user: user ? publicUser(user) : null,
    config: {
      googleClientId: googleClientId(c.env) ?? null,
      devLogin: !isProduction(c.env),
      paymentProvider: settings.paymentProvider || c.env.PAYMENT_PROVIDER,
      turnstileSiteKey: turnstileSiteKey(c.env),
      notice: publicNotice(settings),
    },
  })
})

// ---------- Auth ----------

const ONE_TAP_NONCE_COOKIE = 'g_nonce'

app.get('/api/auth/google/start', async (c) => {
  await rateLimit(c.env.AUTH_LIMITER, c.req.header('cf-connecting-ip') ?? 'local')
  const config = googleOAuthConfig(c.env, new URL(c.req.url).origin)
  if (!config) throw new ApiError(503, 'google_not_configured')
  const { url, state, verifier, nonce } = await googleAuthRedirect(config)
  // 回跳地址放最后：它可能含 |
  setCookie(c, 'oauth_state', `${state}|${verifier}|${nonce}|${safeRedirectPath(c.req.query('redirect'), '/dashboard')}`, {
    httpOnly: true,
    secure: isProduction(c.env),
    sameSite: 'Lax',
    path: '/api/auth/google',
    maxAge: 600,
  })
  return c.redirect(url)
})

app.get('/api/auth/google/callback', async (c) => {
  const [expectedState, verifier, nonce, ...rest] = (getCookie(c, 'oauth_state') ?? '').split('|')
  const redirectTo = rest.join('|')
  deleteCookie(c, 'oauth_state', { path: '/api/auth/google' })
  const state = c.req.query('state') ?? ''
  const code = c.req.query('code')
  if (!expectedState || !verifier || !nonce || !code || !constantTimeEqual(state, expectedState)) {
    return c.redirect('/sign-in?error=oauth_state')
  }
  const config = googleOAuthConfig(c.env, new URL(c.req.url).origin)
  if (!config) throw new ApiError(503, 'google_not_configured')
  try {
    const profile = await exchangeGoogleCode(code, config, { verifier, nonce })
    const user = await upsertUser(c.env, {
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
      googleSub: profile.sub,
      country: c.req.header('cf-ipcountry') ?? null,
      locale: null,
      attribution: requestAttribution(c, 'first'),
      referral: await requestReferral(c),
    })
    await startSession(c, user.id)
  } catch (error) {
    const code = error instanceof ApiError ? error.code : 'oauth_failed'
    if (!(error instanceof ApiError)) console.error(error)
    return c.redirect(`/sign-in?error=${code}`)
  }
  return c.redirect(safeRedirectPath(redirectTo, '/dashboard'))
})

// One Tap 初始化前先取 nonce：同一个值存进只发往登录接口的 cookie，Google 签进 id_token，提交时两者必须一致
app.get('/api/auth/google/nonce', (c) => {
  if (!googleClientId(c.env)) throw new ApiError(503, 'google_not_configured')
  const nonce = randomToken(18)
  setCookie(c, ONE_TAP_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: isProduction(c.env),
    sameSite: 'Strict',
    path: '/api/auth/google',
    maxAge: 600,
  })
  c.header('Cache-Control', 'no-store')
  return c.json({ nonce })
})

app.post('/api/auth/google/one-tap', async (c) => {
  await rateLimit(c.env.AUTH_LIMITER, c.req.header('cf-connecting-ip') ?? 'local')
  const clientId = googleClientId(c.env)
  if (!clientId) throw new ApiError(503, 'google_not_configured')
  const { credential } = await readJson<{ credential: string }>(c)
  if (!credential) throw new ApiError(400, 'missing_credential')
  const nonce = getCookie(c, ONE_TAP_NONCE_COOKIE) ?? ''
  deleteCookie(c, ONE_TAP_NONCE_COOKIE, { path: '/api/auth/google', secure: isProduction(c.env) })
  const profile = await verifyGoogleIdToken(credential, clientId, nonce)
  const user = await upsertUser(c.env, {
    email: profile.email,
    name: profile.name,
    picture: profile.picture,
    googleSub: profile.sub,
    country: c.req.header('cf-ipcountry') ?? null,
    locale: null,
    attribution: requestAttribution(c, 'first'),
    referral: await requestReferral(c),
  })
  await startSession(c, user.id)
  return c.json({ user: publicUser(user) })
})

// 本地快捷登录（e2e 依赖它）；生产环境或经隧道/公网访问时 404
app.post('/api/auth/dev-login', async (c) => {
  if (!isLocalDevRequest(c)) throw new ApiError(404, 'not_found')
  const { email, name } = await readJson<{ email: string; name: string }>(c)
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError(400, 'invalid_email')
  const user = await upsertUser(c.env, {
    email,
    name: name ?? email.split('@')[0] ?? null,
    picture: null,
    googleSub: null,
    country: null,
    locale: null,
    attribution: requestAttribution(c, 'first'),
    referral: await requestReferral(c),
  })
  await startSession(c, user.id)
  return c.json({ user: publicUser(user) })
})

app.post('/api/auth/logout', async (c) => {
  await endSession(c)
  return c.json({ ok: true })
})

// ---------- Uploads ----------

app.post('/api/uploads', async (c) => {
  const user = requireUser(c)
  await rateLimit(c.env.UPLOAD_LIMITER, user.id)
  const form = await readUploadForm(c)
  const { bytes, contentType } = await readImageFile(form)
  // 已下架内容的原图不允许再次上传；审核不通过的不落盘、不扣积分
  const hash = await sha256Hex(bytes)
  if (await isBlockedMedia(c.env, hash)) throw new ApiError(422, 'content_rejected')
  const mockOutcome = form?.get('mockOutcome')
  const verdict = await getModerationProvider(c.env).checkImage({
    bytes,
    contentType,
    mockOutcome: typeof mockOutcome === 'string' ? mockOutcome : null,
  })
  if (!verdict.allowed) {
    console.warn('upload rejected by moderation', user.id, verdict.reason)
    throw new ApiError(422, 'content_rejected')
  }
  const id = createId('upl')
  const key = `uploads/${user.id}/${id}`
  await c.env.MEDIA.put(key, bytes, { httpMetadata: { contentType } })
  await c.env.DB.prepare(
    'INSERT INTO uploads (id, user_id, r2_key, content_type, size_bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, user.id, key, contentType, bytes.length, hash, nowIso())
    .run()
  return c.json({ upload: { id, contentType, size: bytes.length } }, 201)
})

// ---------- Generations ----------

app.post('/api/generations', async (c) => {
  const user = requireUser(c)
  const settings = await getSettings(c.env)
  assertOpen(settings, user)
  await rateLimit(c.env.GENERATE_LIMITER, user.id)
  const body = await readJson<{ uploadId: string; durationId: string; styleId?: string; mockOutcome: string; locale: string }>(c)
  const duration = findDuration(body.durationId ?? '')
  if (!duration) throw new ApiError(400, 'invalid_duration')
  // 不带 styleId 用默认风格；带了但不存在报错，不悄悄换风格
  const style = body.styleId === undefined || body.styleId === null ? defaultStyle : findStyle(String(body.styleId))
  if (!style) throw new ApiError(400, 'invalid_style')
  const db = c.env.DB
  const upload = await db
    .prepare('SELECT * FROM uploads WHERE id = ? AND user_id = ? AND expired_at IS NULL')
    .bind(body.uploadId ?? '', user.id)
    .first<UploadRow>()
  if (!upload) throw new ApiError(400, 'invalid_upload')
  const active = await db
    .prepare(`SELECT COUNT(*) AS n FROM generations WHERE user_id = ? AND status IN ('queued', 'processing')`)
    .bind(user.id)
    .first<{ n: number }>()
  if ((active?.n ?? 0) >= MAX_ACTIVE_JOBS_PER_USER) throw new ApiError(429, 'too_many_active_jobs')
  const cap = settings.generationDailyCap
  if (cap > 0 && (await generationsToday(db, nowIso())) >= cap) throw new ApiError(429, 'daily_limit')
  await rememberLocale(c.env, user, body.locale)

  const providerId = activeVideoProviderId(c.env)
  const mockOutcome = providerId === 'mock' && (body.mockOutcome === 'fail' || body.mockOutcome === 'hang') ? body.mockOutcome : null
  const meta = mockOutcome ? JSON.stringify({ mockOutcome }) : null
  const id = createId('gen')
  const now = nowIso()
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO generations (id, user_id, template_id, duration_id, duration_seconds, credits_cost, upload_id,
           status, provider, provider_meta, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
        )
        .bind(id, user.id, style.id, duration.id, duration.seconds, duration.credits, upload.id, providerId, meta, now, now),
      ...ledgerStatements(db, {
        userId: user.id,
        delta: -duration.credits,
        reason: 'generation',
        refId: id,
        idempotencyKey: `generation:${id}`,
      }),
      ...dailyCapGuard(db, cap, now),
    ])
  } catch (error) {
    // 余额断言和每日上限断言都是 CHECK 失败：回滚后按当天的任务数区分
    if (isCheckConstraintError(error)) {
      if (cap > 0 && (await generationsToday(db, now)) >= cap) throw new ApiError(429, 'daily_limit')
      throw new ApiError(402, 'insufficient_credits')
    }
    throw error
  }

  try {
    await enqueueJob(c.env, { kind: 'submit', generationId: id })
  } catch (error) {
    console.error('enqueue failed', error)
    await failGeneration(c.env, id, 'enqueue_failed', 'Could not enqueue job')
    throw new ApiError(503, 'queue_unavailable')
  }
  const row = await db.prepare('SELECT * FROM generations WHERE id = ?').bind(id).first<GenerationRow>()
  return c.json({ generation: publicGeneration(row!) }, 201)
})

app.get('/api/generations', async (c) => {
  const user = requireUser(c)
  const { limit, offset } = pageParams(c, 24)
  const rows = await c.env.DB.prepare('SELECT * FROM generations WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .bind(user.id, limit, offset)
    .all<GenerationRow>()
  return c.json({ generations: rows.results.map(publicGeneration) })
})

async function ownGeneration(c: Parameters<typeof requireUser>[0], id: string) {
  const user = requireUser(c)
  const row = await c.env.DB.prepare('SELECT * FROM generations WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first<GenerationRow>()
  if (!row) throw new ApiError(404, 'not_found')
  return row
}

app.get('/api/generations/:id', async (c) => {
  return c.json({ generation: publicGeneration(await ownGeneration(c, c.req.param('id'))) })
})

app.get('/api/generations/:id/video', async (c) => {
  const row = await ownGeneration(c, c.req.param('id'))
  if (row.removed_at) throw new ApiError(410, 'media_removed')
  if (row.expired_at) throw new ApiError(410, 'media_expired')
  if (row.status !== 'succeeded' || !row.output_r2_key) throw new ApiError(404, 'not_ready')
  const download = c.req.query('download') === '1'
  // 文件名标明 AI 生成，并带上 id：二次传播后被举报时可直接定位
  return serveR2Object(c.env.MEDIA, row.output_r2_key, c.req.raw, {
    cacheControl: 'private, max-age=3600',
    downloadName: download ? `${site.brandName.replace(/\s+/g, '-').toLowerCase()}-ai-video-${row.id}.mp4` : undefined,
  })
})

app.delete('/api/generations/:id', async (c) => {
  const row = await ownGeneration(c, c.req.param('id'))
  if (row.status === 'queued' || row.status === 'processing') throw new ApiError(409, 'generation_in_progress')
  const keys = [row.output_r2_key, row.share_poster_key].filter((key): key is string => Boolean(key))
  if (keys.length) await c.env.MEDIA.delete(keys)
  await c.env.DB.prepare('DELETE FROM generations WHERE id = ?').bind(row.id).run()
  return c.json({ ok: true })
})

// 公开分享：请求体可带一张 JPEG 封面（浏览器截帧生成，Content-Type: image/jpeg），没有就用站点默认 OG 图
app.post('/api/generations/:id/share', async (c) => {
  const row = await ownGeneration(c, c.req.param('id'))
  assertShareable(row)
  if (c.req.header('content-length') !== '0') await rateLimit(c.env.UPLOAD_LIMITER, row.user_id)
  const poster = await readSharePoster(c.env, c.req.raw)
  return c.json({ shareId: await startShare(c.env, row, poster) })
})

app.delete('/api/generations/:id/share', async (c) => {
  const row = await ownGeneration(c, c.req.param('id'))
  if (row.share_id) await stopShare(c.env, row)
  return c.json({ ok: true })
})

// 分享页在浏览器内跳转（切换语言等）时取数据；首屏由 src/server.ts 在服务端查好
app.get('/api/shares/:shareId', async (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json({ share: await loadShare(c.env, c.req.param('shareId')) })
})

// ---------- Credits & billing ----------

app.get('/api/credits/ledger', async (c) => {
  const user = requireUser(c)
  const { limit, offset } = pageParams(c)
  const rows = await c.env.DB.prepare(
    'SELECT id, delta, reason, ref_id, note, created_at FROM credit_ledger WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
  )
    .bind(user.id, limit, offset)
    .all()
  return c.json({ balance: user.credits, entries: rows.results })
})

// 即将到期的积分（账单页提示），按到期时间排序
app.get('/api/credits/expiring', async (c) => {
  const user = requireUser(c)
  const rows = await c.env.DB.prepare(
    `SELECT SUM(remaining) AS credits, expires_at AS expiresAt FROM credit_grants
     WHERE user_id = ? AND remaining > 0 AND expires_at > ? GROUP BY expires_at ORDER BY expires_at LIMIT 5`,
  )
    .bind(user.id, nowIso())
    .all<{ credits: number; expiresAt: string }>()
  return c.json({ expiring: rows.results })
})

// 邀请链接：只写 cookie 再跳首页（?ref=invite 让来源报表记为 invite），注册时服务端读 cookie 绑定邀请人
app.get('/i/:code', async (c) => {
  const code = normalizeReferralCode(c.req.param('code'))
  if (code && referralActive(await getSettings(c.env))) {
    setCookie(c, REFERRAL_COOKIE, code, { httpOnly: true, secure: isProduction(c.env), sameSite: 'Lax', path: '/', maxAge: 30 * 86400 })
  }
  c.header('X-Robots-Tag', 'noindex')
  return c.redirect('/?ref=invite', 302)
})

// 邀请卡片：第一次打开时生成邀请码
app.get('/api/referral', async (c) => {
  const user = requireUser(c)
  const { referralRewardCredits } = await getSettings(c.env)
  if (referralRewardCredits <= 0) return c.json({ enabled: false })
  const code = await ensureReferralCode(c.env.DB, user.id)
  return c.json({
    enabled: true,
    code,
    url: `${new URL(c.req.url).origin}/i/${code}`,
    rewardCredits: referralRewardCredits,
    ...(await referralSummary(c.env.DB, user.id)),
  })
})

// 兑换码（设置页）：按用户和 IP 限流，先校验格式再消耗 Turnstile token
app.post('/api/redeem', async (c) => {
  const user = requireUser(c)
  const ip = c.req.header('cf-connecting-ip')
  await rateLimit(c.env.AUTH_LIMITER, `redeem:${user.id}`)
  await rateLimit(c.env.AUTH_LIMITER, `redeem-ip:${ip ?? 'local'}`)
  const body = await readJson<{ code: string; turnstileToken: string }>(c)
  const code = normalizeCode(body.code)
  if (!code) throw new ApiError(400, 'invalid_code')
  await verifyTurnstile(c.env, body.turnstileToken, ip)
  const result = await redeemCode(c.env.DB, user.id, code)
  const balance = await c.env.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(user.id).first<number>('credits')
  return c.json({ ...result, balance })
})

app.post('/api/checkout', async (c) => {
  const user = requireUser(c)
  const settings = await getSettings(c.env)
  assertCheckoutOpen(settings, user)
  await rateLimit(c.env.AUTH_LIMITER, `checkout:${user.id}`)
  const body = await readJson<{ packageId: string; locale: string }>(c)
  // packageId 可以是积分包或在售的订阅套餐（订阅开关关掉时套餐不能再下单）
  const pack = findPackage(body.packageId ?? '') ?? sellingPlans.find((p) => p.id === body.packageId)
  if (!pack) throw new ApiError(400, 'invalid_package')
  // 同一时间只允许一个订阅；已到期取消且当期结束的不算（见 LIVE_SUBSCRIPTION_SQL）
  if (findPlan(pack.id) && (await liveSubscription(c.env.DB, user.id))) throw new ApiError(409, 'subscription_exists')
  const locale = isLocale(body.locale) ? body.locale : 'en'
  await rememberLocale(c.env, user, body.locale)
  const provider = getPaymentProvider(c.env, settings.paymentProvider)
  const id = createId('ord')
  const now = nowIso()
  const attr = requestAttribution(c, 'last')
  await c.env.DB.prepare(
    `INSERT INTO orders (id, user_id, provider, package_id, credits, amount_cents, currency, status,
     source, medium, campaign, country, device, attribution, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      user.id,
      provider.id,
      pack.id,
      pack.credits,
      pack.priceCents,
      pack.currency,
      attr.source,
      attr.medium,
      attr.campaign,
      attr.country ?? user.country,
      attr.device,
      attr.json,
      now,
      now,
    )
    .run()
  const siteUrl = c.env.SITE_URL.replace(/\/$/, '')
  try {
    const result = await provider.createCheckout({
      order: { id, packageId: pack.id, credits: pack.credits, amountCents: pack.priceCents, currency: pack.currency },
      user: { id: user.id, email: user.email, name: user.name },
      successUrl: `${siteUrl}${localePath(locale, '/checkout/success')}?order=${id}`,
      cancelUrl: `${siteUrl}${localePath(locale, '/pricing')}`,
    })
    await c.env.DB.prepare('UPDATE orders SET provider_session_id = ?, updated_at = ? WHERE id = ?')
      .bind(result.sessionId, nowIso(), id)
      .run()
    return c.json({ orderId: id, url: result.url })
  } catch (error) {
    await c.env.DB.prepare(`UPDATE orders SET status = 'failed', updated_at = ? WHERE id = ?`).bind(nowIso(), id).run()
    throw error
  }
})

// ---------- 订阅（账单页）----------

app.get('/api/subscription', async (c) => {
  const user = requireUser(c)
  const sub = await latestSubscription(c.env.DB, user.id)
  const provider = sub ? getOrderProvider(c.env, sub.provider) : null
  return c.json({
    subscription: sub ? publicSubscription(sub) : null,
    // Waffo 不能由商户撤销取消，账单页改为引导去客户门户
    canResume: !!provider?.resumeSubscription,
    canPortal: !!provider?.portalUrl,
  })
})

app.post('/api/subscription/cancel', async (c) => {
  const user = requireUser(c)
  await rateLimit(c.env.AUTH_LIMITER, `subscription:${user.id}`)
  return c.json({ subscription: publicSubscription(await setCancelAtPeriodEnd(c.env, user, true)) })
})

app.post('/api/subscription/resume', async (c) => {
  const user = requireUser(c)
  await rateLimit(c.env.AUTH_LIMITER, `subscription:${user.id}`)
  return c.json({ subscription: publicSubscription(await setCancelAtPeriodEnd(c.env, user, false)) })
})

// 支付商的客户门户：换卡、看发票、取消或恢复。地址有时效，每次点击现取
app.post('/api/subscription/portal', async (c) => {
  const user = requireUser(c)
  await rateLimit(c.env.AUTH_LIMITER, `subscription:${user.id}`)
  const body = await readJson<{ locale?: string }>(c)
  const sub = await latestSubscription(c.env.DB, user.id)
  if (!sub) throw new ApiError(404, 'subscription_not_found')
  const provider = getOrderProvider(c.env, sub.provider)
  if (!provider?.portalUrl) throw new ApiError(409, 'subscription_portal_unsupported')
  const locale = isLocale(body.locale) ? body.locale : 'en'
  const returnUrl = `${c.env.SITE_URL.replace(/\/$/, '')}${localePath(locale, '/dashboard/billing')}`
  return c.json({ url: await provider.portalUrl(subscriptionRef(sub, user), returnUrl) })
})

app.get('/api/orders', async (c) => {
  const user = requireUser(c)
  const { limit, offset } = pageParams(c)
  const rows = await c.env.DB.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
    .bind(user.id, limit, offset)
    .all<OrderRow>()
  return c.json({ orders: rows.results.map(publicOrder) })
})

app.get('/api/orders/:id', async (c) => {
  const user = requireUser(c)
  const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), user.id)
    .first<OrderRow>()
  if (!order) throw new ApiError(404, 'not_found')
  return c.json({ order: publicOrder(order), credits: user.credits })
})

// 成功页久等未到账时请求服务端向支付商查单（webhook 丢失或延迟）。只接受订单号，付款状态一律以支付商返回为准；
// 同一订单 10 秒内只查一次，查单失败不影响页面继续轮询
app.post('/api/orders/:id/reconcile', async (c) => {
  const user = requireUser(c)
  await rateLimit(c.env.AUTH_LIMITER, `reconcile:${user.id}`)
  const id = c.req.param('id')
  const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').bind(id, user.id).first<OrderRow>()
  if (!order) throw new ApiError(404, 'not_found')
  const status = await reconcileOrder(c.env, order, { minIntervalMs: 10_000 })
  const latest = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<OrderRow>()
  const credits = await c.env.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(user.id).first<number>('credits')
  return c.json({ reconcile: status, order: publicOrder(latest!), credits })
})

// mock 支付：模拟支付商回调，走与真实 webhook 完全相同的入账逻辑；amountCents 用于模拟部分退款。
// paid 的可选字段模拟异常回调（e2e 用）：paidAmountCents / paidCurrency / packageId / discounted 和订单不一致，
// orphan 让事件指向不存在的订单，site 模拟共用商户号的其他站点；
// deliver: false 模拟“支付商已收款但 webhook 丢失”：只记下付款，等主动对账（reconcile）查到

app.post('/api/mock-payments/complete', async (c) => {
  if (!isLocalDevRequest(c)) throw new ApiError(404, 'not_found')
  const user = requireUser(c)
  const body = await readJson<{
    orderId: string
    outcome: 'paid' | 'failed' | 'refunded'
    eventId: string
    amountCents?: number
    paidAmountCents?: number
    paidCurrency?: string
    packageId?: string
    discounted?: boolean
    orphan?: boolean
    site?: string
    deliver?: boolean
  }>(c)
  const order = await c.env.DB.prepare(`SELECT * FROM orders WHERE id = ? AND user_id = ? AND provider = 'mock'`)
    .bind(body.orderId ?? '', user.id)
    .first<OrderRow>()
  if (!order) throw new ApiError(404, 'not_found')
  const outcome = body.outcome ?? 'paid'
  const eventId = body.eventId ?? `mock_${outcome}_${order.id}`
  const paidCents = Number.isInteger(body.paidAmountCents) ? body.paidAmountCents! : order.amount_cents
  const ref = body.orphan ? `${order.id}_orphan` : order.id
  // 订阅套餐的首付：带上订阅信息，周期从现在起算一期
  const plan = findPlan(order.package_id)
  const now = nowIso()
  const subscription = plan
    ? { providerSubscriptionId: `mock_sub_${ref}`, periodStart: now, periodEnd: addInterval(now, plan.interval) }
    : null
  const event: PaymentEvent =
    outcome === 'paid'
      ? {
          kind: 'paid',
          eventId,
          eventType: 'mock.paid',
          orderId: ref,
          providerOrderId: `mock_order_${ref}`,
          providerPaymentId: `mock_pay_${ref}`,
          paidAmount: (paidCents / 100).toFixed(2),
          paidCurrency: body.paidCurrency ?? order.currency,
          paidAmountCents: paidCents,
          packageId: body.packageId ?? order.package_id,
          discounted: body.discounted === true,
          site: body.site ?? null,
          subscription,
        }
      : outcome === 'refunded'
        ? {
            kind: 'refunded',
            eventId,
            eventType: 'mock.refunded',
            orderId: order.id,
            providerPaymentId: order.provider_payment_id,
            refundId: eventId,
            refundAmountCents: Number.isInteger(body.amountCents) && body.amountCents! > 0 ? body.amountCents! : null,
            originalAmountCents: null,
          }
        : { kind: 'failed', eventId, eventType: 'mock.failed', orderId: order.id }
  if (body.deliver === false) {
    if (event.kind !== 'paid') throw new ApiError(400, 'invalid_request')
    await c.env.KV.put(mockPaidKey(order.id), JSON.stringify({ ...event, eventId: `reconcile:${event.providerPaymentId}` }), {
      expirationTtl: 86400,
    })
    return c.json({ status: 'stored', orderId: order.id })
  }
  const result = await processPaymentEvent(c.env, 'mock', event, JSON.stringify({ eventId, outcome, orderId: order.id }))
  return c.json(result)
})

// mock 订阅：模拟支付商的续费扣款和状态 webhook（作用于当前用户最近的 mock 订阅）。
// renew 按订阅锁定的价格扣下一期（paidAmountCents 模拟金额不符）；其余动作是状态事件，occurredAt 模拟乱序到达
app.post('/api/mock-payments/subscription', async (c) => {
  if (!isLocalDevRequest(c)) throw new ApiError(404, 'not_found')
  const user = requireUser(c)
  const body = await readJson<{
    action: 'renew' | 'past_due' | 'recover' | 'cancel_at_period_end' | 'uncancel' | 'canceled' | 'expired'
    eventId?: string
    occurredAt?: string
    paidAmountCents?: number
  }>(c)
  const sub = await latestSubscription(c.env.DB, user.id)
  if (!sub || sub.provider !== 'mock') throw new ApiError(404, 'subscription_not_found')
  const eventId = body.eventId ?? `mock_${body.action}_${createId('evt')}`
  const firstOrderId = await c.env.DB.prepare('SELECT id FROM orders WHERE subscription_id = ? ORDER BY created_at, id LIMIT 1')
    .bind(sub.id)
    .first<string>('id')
  let event: PaymentEvent
  if (body.action === 'renew') {
    const cents = Number.isInteger(body.paidAmountCents) ? body.paidAmountCents! : sub.amount_cents
    const periodStart = sub.current_period_end ?? nowIso()
    event = {
      kind: 'paid',
      eventId,
      eventType: 'mock.subscription.renewed',
      // 和真实支付商一样，续费事件的 orderId 仍是首单号
      orderId: firstOrderId,
      providerOrderId: sub.provider_subscription_id,
      providerPaymentId: `mock_pay_${eventId}`,
      paidAmount: (cents / 100).toFixed(2),
      paidCurrency: sub.currency,
      paidAmountCents: cents,
      packageId: sub.plan_id,
      site: null,
      subscription: { providerSubscriptionId: sub.provider_subscription_id, periodStart, periodEnd: addInterval(periodStart, sub.interval) },
    }
  } else {
    const states = {
      past_due: { status: 'past_due', cancelAtPeriodEnd: null },
      recover: { status: 'active', cancelAtPeriodEnd: null },
      cancel_at_period_end: { status: 'active', cancelAtPeriodEnd: true },
      uncancel: { status: 'active', cancelAtPeriodEnd: false },
      canceled: { status: 'canceled', cancelAtPeriodEnd: null },
      expired: { status: 'expired', cancelAtPeriodEnd: null },
    } as const
    const state = body.action && body.action in states ? states[body.action as keyof typeof states] : null
    if (!state) throw new ApiError(400, 'invalid_request')
    event = {
      kind: 'subscription',
      eventId,
      eventType: `mock.subscription.${body.action}`,
      orderId: firstOrderId,
      providerSubscriptionId: sub.provider_subscription_id,
      status: state.status,
      cancelAtPeriodEnd: state.cancelAtPeriodEnd,
      periodStart: null,
      periodEnd: null,
      providerCustomerId: null,
      productId: null,
      occurredAt: body.occurredAt ?? nowIso(),
      site: null,
    }
  }
  const result = await processPaymentEvent(c.env, 'mock', event, JSON.stringify(body))
  const latest = await latestSubscription(c.env.DB, user.id)
  return c.json({ ...result, subscription: latest ? publicSubscription(latest) : null })
})

// ---------- 访问统计（漏斗第一步）----------

// 每个浏览器会话上报一次（客户端用 sessionStorage 去重），按天 × 来源 × 国家 × 设备累加
app.post('/api/t/visit', async (c) => {
  const device = deviceFromUserAgent(c.req.header('user-agent'))
  if (device === 'bot') return c.body(null, 204)
  await rateLimit(c.env.AUTH_LIMITER, `visit:${c.req.header('cf-connecting-ip') ?? 'local'}`)
  const body = await c.req.json<{ touch?: unknown }>().catch(() => ({ touch: undefined }))
  const { source, medium } = classifyTouch(sanitizeTouch(body.touch), new URL(c.req.url).hostname)
  const country = c.req.header('cf-ipcountry')
  await c.env.DB.prepare(
    `INSERT INTO visit_stats (day, source, medium, country, device, visits) VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT (day, source, medium, country, device) DO UPDATE SET visits = visits + 1`,
  )
    .bind(nowIso().slice(0, 10), source, medium, country && country !== 'XX' ? country : 'unknown', device)
    .run()
  return c.body(null, 204)
})

// ---------- Webhooks ----------

app.post('/api/webhooks/waffo', async (c) => {
  const raw = await c.req.text()
  const payload = await verifyWaffoWebhook(raw, c.req.header('x-waffo-signature'), waffoEnvironment(c.env))
  const result = await processPaymentEvent(c.env, 'waffo', normalizeWaffoEvent(payload), raw)
  return c.json({ received: true, ...result })
})

app.post('/api/webhooks/dodo', async (c) => {
  const raw = await c.req.text()
  const payload = await verifyDodoWebhook(raw, c.req.raw.headers, c.env.DODO_WEBHOOK_SECRET)
  const result = await processPaymentEvent(c.env, 'dodo', normalizeDodoEvent(payload), raw)
  return c.json({ received: true, ...result })
})

// 付款类事件验签后用固定 API 版本重新取对象（取不到 Stripe 时返回 502，Stripe 会重试），不受 webhook 端点 API 版本影响
app.post('/api/webhooks/stripe', async (c) => {
  const raw = await c.req.text()
  const payload = await verifyStripeWebhook(raw, c.req.header('stripe-signature'), c.env.STRIPE_WEBHOOK_SECRET, c.env.STRIPE_ENVIRONMENT)
  const result = await processPaymentEvent(c.env, 'stripe', normalizeStripeEvent(await expandStripeEvent(c.env, payload)), raw)
  return c.json({ received: true, ...result })
})

// 视频服务商完成回调（fal、yir、nanoapi）：只当作“立即轮询”的信号，真实结果由 jobs.ts 用 API key 拉取，
// 所以只校验地址里的任务 token，不验 yir 的签名头；nanoapi 的回调不带签名，同样只靠地址里的 token
for (const provider of ['fal', 'yir', 'nanoapi']) {
  app.post(`/api/webhooks/${provider}`, async (c) => {
    const generationId = c.req.query('gen') ?? ''
    const token = c.req.query('token') ?? ''
    if (!generationId || !constantTimeEqual(token, await jobToken(c.env, generationId))) {
      throw new WebhookVerificationError(`invalid ${provider} job token`)
    }
    await enqueueJob(c.env, { kind: 'poll', generationId })
    return c.json({ received: true })
  })
}

// ---------- Contact & account ----------

app.post('/api/contact', async (c) => {
  const ip = c.req.header('cf-connecting-ip')
  await rateLimit(c.env.AUTH_LIMITER, `contact:${ip ?? 'local'}`)
  const body = await readJson<{ email: string; topic: string; message: string; turnstileToken: string }>(c)
  const user = c.get('user')
  const email = (body.email ?? user?.email ?? '').trim()
  const message = (body.message ?? '').trim()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError(400, 'invalid_email')
  if (message.length < 10 || message.length > 5000) throw new ApiError(400, 'invalid_message')
  const topic = ['general', 'billing', 'bug', 'partnership'].includes(body.topic ?? '') ? body.topic! : 'general'
  // 先校验字段再消耗 Turnstile token（token 单次有效）
  await verifyTurnstile(c.env, body.turnstileToken, ip)
  const id = createId('msg')
  await c.env.DB.prepare(
    'INSERT INTO contact_messages (id, user_id, email, topic, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, user?.id ?? null, email, topic, message, 'open', nowIso())
    .run()
  await notifyContactMessage(c.env, { id, email, topic, message })
  return c.json({ ok: true }, 201)
})

// 内容举报 / 下架申请：无需登录；管理员在 /admin/takedowns 按 due_at 处理
app.post('/api/takedowns', async (c) => {
  const ip = c.req.header('cf-connecting-ip')
  await rateLimit(c.env.AUTH_LIMITER, `takedown:${ip ?? 'local'}`)
  const body = await readJson<TakedownInput & { turnstileToken: string; locale: string }>(c)
  const input = parseTakedown(body)
  await verifyTurnstile(c.env, body.turnstileToken, ip)
  const locale = isLocale(body.locale) ? body.locale : null
  return c.json({ report: await createTakedown(c.env, input, c.get('user'), locale) }, 201)
})

// 导出我的数据（个人中心设置页）：JSON 附件，内容见 account-export.ts
app.get('/api/account/export', async (c) => {
  const user = requireUser(c)
  await rateLimit(c.env.AUTH_LIMITER, `export:${user.id}`)
  const data = await exportUserData(c.env, user.id)
  c.header('Content-Disposition', `attachment; filename="${exportFileName()}"`)
  c.header('Cache-Control', 'private, no-store')
  return c.json(data)
})

// 注销：删除上传与生成的媒体，匿名化用户；订单与积分流水按财务要求保留。
// 还会自动续费的订阅要先取消（否则注销后支付商仍会继续扣款）
app.delete('/api/account', async (c) => {
  const user = requireUser(c)
  const sub = await liveSubscription(c.env.DB, user.id)
  if (sub && !sub.cancel_at_period_end) throw new ApiError(409, 'subscription_active')
  for (const prefix of [`uploads/${user.id}/`, `outputs/${user.id}/`]) {
    let cursor: string | undefined
    do {
      const listed = await c.env.MEDIA.list({ prefix, cursor })
      if (listed.objects.length) await c.env.MEDIA.delete(listed.objects.map((o) => o.key))
      cursor = listed.truncated ? listed.cursor : undefined
    } while (cursor)
  }
  const db = c.env.DB
  await db.batch([
    db.prepare('DELETE FROM generations WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM uploads WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM email_outbox WHERE user_id = ?').bind(user.id),
    ...clawbackStatements(db, {
      userId: user.id,
      maxAmount: 1_000_000_000, // 全部剩余积分
      reason: 'account_deleted',
      idempotencyKey: `account_deleted:${user.id}`,
    }),
    db
      .prepare(
        `UPDATE users SET email = ?, name = NULL, avatar_url = NULL, google_sub = NULL, status = 'deleted' WHERE id = ?`,
      )
      .bind(`deleted+${user.id}@deleted.invalid`, user.id),
    db
      .prepare('INSERT OR IGNORE INTO deleted_accounts (email_hash, deleted_at) VALUES (?, ?)')
      .bind(await deletedEmailHash(c.env, user.email), nowIso()),
  ])
  await endSession(c)
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run()
  return c.json({ ok: true })
})

// 本地 e2e：按“days 天后”给当前用户的年付订阅补发到期的月份（Cron 里同样的补发逻辑）
app.post('/api/dev/subscription-grants', async (c) => {
  if (!isLocalDevRequest(c)) throw new ApiError(404, 'not_found')
  const user = requireUser(c)
  const { days } = await readJson<{ days: number }>(c)
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) throw new ApiError(400, 'invalid_days')
  const result = await grantDueSubscriptions(c.env, { now: Date.now() + days * 86400_000, userId: user.id })
  const row = await c.env.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(user.id).first<{ credits: number }>()
  return c.json({ ...result, credits: row?.credits ?? 0 })
})

// 本地 e2e：把当前用户的数据按“days 天后”执行一次保留期清理
app.post('/api/dev/sweep', async (c) => {
  if (!isLocalDevRequest(c)) throw new ApiError(404, 'not_found')
  const user = requireUser(c)
  const { days } = await readJson<{ days: number }>(c)
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) throw new ApiError(400, 'invalid_days')
  return c.json(await sweepExpiredMedia(c.env, { now: Date.now() + days * 86400_000, userId: user.id }))
})

// 本地 e2e：按“days 天后”作废当前用户到期的积分批次（Cron 里同样的作废逻辑）
app.post('/api/dev/expire-credits', async (c) => {
  if (!isLocalDevRequest(c)) throw new ApiError(404, 'not_found')
  const user = requireUser(c)
  const { days } = await readJson<{ days: number }>(c)
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) throw new ApiError(400, 'invalid_days')
  await c.env.DB.batch(expireStatements(c.env.DB, new Date(Date.now() + days * 86400_000).toISOString(), user.id))
  const row = await c.env.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(user.id).first<{ credits: number }>()
  return c.json({ credits: row?.credits ?? 0 })
})

// 本地 e2e：查看发件箱。本地 send_email binding 只模拟发送（不会真的发出），以发件箱记录为准
app.get('/api/dev/emails', async (c) => {
  if (!isLocalDevRequest(c)) throw new ApiError(404, 'not_found')
  const to = c.req.query('to')?.trim().toLowerCase() || null
  const ref = c.req.query('ref')?.trim() || null
  if (!to && !ref) throw new ApiError(400, 'filter_required')
  const rows = await c.env.DB.prepare(
    `SELECT id, dedupe_key, template, to_email, user_id, locale, params, subject, status, attempts, provider_message_id, last_error
     FROM email_outbox WHERE (?1 IS NULL OR lower(to_email) = ?1) AND (?2 IS NULL OR instr(dedupe_key, ?2) > 0)
     ORDER BY created_at, dedupe_key`,
  )
    .bind(to, ref)
    .all<{ params: string }>()
  return c.json({ emails: rows.results.map((row) => ({ ...row, params: JSON.parse(row.params) as unknown })) })
})

// 本地 e2e：按“hours 小时后”对指定举报跑一次超时提醒
app.post('/api/dev/takedown-reminders', async (c) => {
  if (!isLocalDevRequest(c)) throw new ApiError(404, 'not_found')
  const { takedownId, hours } = await readJson<{ takedownId: string; hours: number }>(c)
  if (!takedownId || typeof hours !== 'number' || !Number.isFinite(hours)) throw new ApiError(400, 'invalid_request')
  return c.json(await runTakedownReminders(c.env, { now: Date.now() + hours * 3600_000, takedownId }))
})

// 本地 e2e：模拟当前用户某个任务的队列消息进入死信队列（真实路径要重试 10 次、约 35 分钟）
app.post('/api/dev/dead-letter', async (c) => {
  if (!isLocalDevRequest(c)) throw new ApiError(404, 'not_found')
  const user = requireUser(c)
  const generationId = (await readJson<{ generationId: string }>(c)).generationId ?? ''
  const owned = await c.env.DB.prepare('SELECT id FROM generations WHERE id = ? AND user_id = ?').bind(generationId, user.id).first()
  if (!owned) throw new ApiError(404, 'not_found')
  return c.json({ failed: await handleDeadLetter(c.env, { kind: 'poll', generationId }) })
})

// 本地 e2e：让当前用户一个 hang 的 mock 任务出片，并同时跑 polls 次轮询（模拟 fal webhook 与定时轮询撞在一起）
app.post('/api/dev/mock-finish', async (c) => {
  if (!isLocalDevRequest(c)) throw new ApiError(404, 'not_found')
  const user = requireUser(c)
  const { generationId = '', polls = 1 } = await readJson<{ generationId?: string; polls?: number }>(c)
  if (!Number.isInteger(polls) || polls < 1 || polls > 5) throw new ApiError(400, 'invalid_polls')
  const updated = await c.env.DB.prepare(
    `UPDATE generations SET provider_meta = json_set(provider_meta, '$.mockOutcome', NULL, '$.readyAt', 0)
     WHERE id = ? AND user_id = ? AND provider = 'mock' AND provider_meta IS NOT NULL`,
  )
    .bind(generationId, user.id)
    .run()
  if (!updated.meta.changes) throw new ApiError(404, 'not_found')
  await Promise.all(Array.from({ length: polls }, () => handleVideoJob(c.env, { kind: 'poll', generationId })))
  return c.json({ ok: true })
})

// 本地 e2e：按“minutes 分钟后”对当前用户的 pending 订单跑一次 Cron 对账
app.post('/api/dev/reconcile-sweep', async (c) => {
  if (!isLocalDevRequest(c)) throw new ApiError(404, 'not_found')
  const user = requireUser(c)
  const { minutes } = await readJson<{ minutes: number }>(c)
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) throw new ApiError(400, 'invalid_minutes')
  return c.json(await reconcilePendingOrders(c.env, { now: Date.now() + minutes * 60_000, userId: user.id }))
})

// 本地 e2e：立即跑一次健康检查；since 把统计窗口起点固定到测试开始时刻
app.post('/api/dev/health-check', async (c) => {
  if (!isLocalDevRequest(c)) throw new ApiError(404, 'not_found')
  const { since } = await readJson<{ since?: string }>(c)
  if (since !== undefined && (typeof since !== 'string' || Number.isNaN(Date.parse(since)))) throw new ApiError(400, 'invalid_since')
  return c.json(await runHealthCheck(c.env, { since }))
})

// 本地 e2e：立即导出一次 D1 备份（覆盖当天的），返回表数、行数和大小
app.post('/api/dev/backup', async (c) => {
  if (!isLocalDevRequest(c)) throw new ApiError(404, 'not_found')
  return c.json(await backupDatabase(c.env))
})

// ---------- Admin ----------

app.route('/api/admin', adminRoutes)
app.route('/api/handoff', handoffRoutes)
app.route('/', seoRoutes)

app.all('/api/*', () => {
  throw new ApiError(404, 'not_found')
})

// ---------- Media（非 /api 路径，不需要登录） ----------

app.get('/media/templates/:file', async (c) => {
  const file = c.req.param('file')
  if (!/^[\w.-]+$/.test(file)) return c.notFound()
  return serveR2Object(c.env.MEDIA, `templates/${file}`, c.req.raw, { cacheControl: 'public, max-age=86400' })
})

app.get('/media/uploads/:id', async (c) => {
  const id = c.req.param('id')
  if (!(await verifyUploadSignature(c.env, id, c.req.query('exp') ?? null, c.req.query('sig') ?? null))) {
    return c.text('Forbidden', 403)
  }
  const upload = await c.env.DB.prepare('SELECT * FROM uploads WHERE id = ?').bind(id).first<UploadRow>()
  if (!upload || upload.expired_at) return c.notFound()
  return serveR2Object(c.env.MEDIA, upload.r2_key, c.req.raw, { cacheControl: 'private, max-age=600' })
})

// 公开分享的成片和封面：每次都查库，停止分享、下架、到期后立即失效（缓存只给 5 分钟）
app.get('/media/shares/:shareId/:file{video|poster\\.jpg}', async (c) => {
  const row = await findSharedGeneration(c.env, c.req.param('shareId'))
  c.header('X-Robots-Tag', 'noindex')
  if (!row) return c.text('Not found', 404)
  if (row.removed_at || row.expired_at || row.status !== 'succeeded' || !row.output_r2_key) return c.text('Gone', 410)
  const key = c.req.param('file') === 'video' ? row.output_r2_key : row.share_poster_key
  if (!key) return c.text('Not found', 404)
  const response = await serveR2Object(c.env.MEDIA, key, c.req.raw, { cacheControl: 'public, max-age=300' })
  response.headers.set('X-Robots-Tag', 'noindex')
  return response
})

// 记住用户最近使用的界面语言，交易邮件按它选择语言
async function rememberLocale(env: Env, user: UserRow, locale: string | undefined) {
  if (isLocale(locale) && locale !== user.locale) {
    await env.DB.prepare('UPDATE users SET locale = ? WHERE id = ?').bind(locale, user.id).run()
  }
}

// dev-login / mock 支付只允许本机直连：非生产 + 主机名是回环地址 + 没有经过 Cloudflare 边缘（隧道会带 cf-connecting-ip）
// + 没有经过其他反向代理（ngrok 用 --host-header=rewrite 把 Host 改成 localhost 时，仍会带 x-forwarded-for）。
// 不看 x-forwarded-host：@cloudflare/vite-plugin 在 dev 下会给每个请求补上它
function isLocalDevRequest(c: { env: Env; req: { url: string; header(name: string): string | undefined } }) {
  if (isProduction(c.env)) return false
  const host = new URL(c.req.url).hostname.replace(/^\[|\]$/g, '')
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) return false
  if (c.req.header('x-forwarded-for') || c.req.header('forwarded')) return false
  const edgeIp = c.req.header('cf-connecting-ip')
  return !edgeIp || ['127.0.0.1', '::1'].includes(edgeIp)
}
