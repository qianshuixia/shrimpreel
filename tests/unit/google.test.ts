import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { app } from '#/server/app'
import { upsertUser } from '#/server/auth'
import { exchangeGoogleCode, googleAuthRedirect, verifyGoogleIdToken } from '#/server/google'
import { ApiError, base64Url, sha256Hex } from '#/server/util'
import { d1Shim, kvShim, migrate } from './d1-sqlite'

const CLIENT_ID = 'client-id'
const config = { clientId: CLIENT_ID, clientSecret: 'client-secret', redirectUri: 'https://site.example/api/auth/google/callback' }
const env = { APP_ENV: 'development', SITE_URL: 'https://site.example', GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'client-secret' } as unknown as Env

let keys: CryptoKeyPair
let jwk: JsonWebKey

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1' } as JsonWebKey
})

afterEach(() => {
  vi.restoreAllMocks()
})

const encode = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)))

async function idToken(claims: Record<string, unknown>) {
  const input = `${encode({ alg: 'RS256', kid: 'k1' })}.${encode({
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 600,
    sub: 'sub-1',
    email: 'a@example.com',
    email_verified: true,
    ...claims,
  })}`
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(input))
  return `${input}.${base64Url(new Uint8Array(signature))}`
}

// JWKS 返回测试公钥；token 端点记录请求体并返回给定的 id_token
function mockGoogle(token?: string) {
  const tokenRequests: URLSearchParams[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.includes('/oauth2/v3/certs')) return Response.json({ keys: [jwk] })
    if (url.includes('oauth2.googleapis.com/token')) {
      tokenRequests.push(new URLSearchParams(String(init?.body)))
      return Response.json({ id_token: token })
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  return tokenRequests
}

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error instanceof ApiError ? error.code : error),
  )

describe('Google 授权码流程：PKCE 与 nonce', () => {
  it('授权地址带 S256 code_challenge 和 nonce，challenge 由 verifier 推出', async () => {
    const { url, verifier, nonce, state } = await googleAuthRedirect(config)
    const params = new URL(url).searchParams
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    expect(params.get('code_challenge')).toBe(base64Url(new Uint8Array(digest)))
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('nonce')).toBe(nonce)
    expect(params.get('state')).toBe(state)
    // RFC 7636：verifier 43–128 个字符
    expect(verifier.length).toBeGreaterThanOrEqual(43)
  })

  it('换 token 时带上 code_verifier；id_token 里的 nonce 不一致就拒绝', async () => {
    const requests = mockGoogle(await idToken({ nonce: 'n-1' }))
    expect((await exchangeGoogleCode('code', config, { verifier: 'v-1', nonce: 'n-1' })).sub).toBe('sub-1')
    expect(requests[0]!.get('code_verifier')).toBe('v-1')
    expect(await rejection(exchangeGoogleCode('code', config, { verifier: 'v-1', nonce: 'n-2' }))).toBe('oauth_state')
  })

  it('id_token 没有 nonce、或期望值为空时拒绝', async () => {
    mockGoogle()
    expect(await rejection(verifyGoogleIdToken(await idToken({}), CLIENT_ID, 'n-1'))).toBe('oauth_state')
    expect(await rejection(verifyGoogleIdToken(await idToken({ nonce: '' }), CLIENT_ID, ''))).toBe('oauth_state')
    expect((await verifyGoogleIdToken(await idToken({ nonce: 'n-1' }), CLIENT_ID, 'n-1')).email).toBe('a@example.com')
  })

  it('start 把 state、verifier、nonce 和回跳地址存进 cookie；回跳地址含 | 也能原样取回', async () => {
    const res = await app.request(`/api/auth/google/start?redirect=${encodeURIComponent('/pricing?a=1|2')}`, {}, env)
    const cookie = decodeURIComponent(/oauth_state=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '')
    const [state, verifier, nonce, ...rest] = cookie.split('|')
    const params = new URL(res.headers.get('location')!).searchParams
    expect(params.get('state')).toBe(state)
    expect(params.get('nonce')).toBe(nonce)
    expect(verifier).toBeTruthy()
    expect(rest.join('|')).toBe('/pricing?a=1|2')
  })

  it('回调缺 verifier（旧版 cookie）时按登录过期处理，不去换 token', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const res = await app.request('/api/auth/google/callback?state=s&code=c', { headers: { cookie: 'oauth_state=s|/dashboard' } }, env)
    expect(res.headers.get('location')).toBe('/sign-in?error=oauth_state')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('One Tap nonce', () => {
  it('未登录访问 /api/me 直接下发 oneTapNonce 和 g_nonce cookie；已登录时为 null', async () => {
    const sqlite = new DatabaseSync(':memory:')
    migrate(sqlite)
    const meEnv = {
      ...env,
      DB: d1Shim(sqlite),
      KV: kvShim(),
      PAYMENT_PROVIDER: 'mock',
      ADMIN_EMAILS: '',
      SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
    } as unknown as Env

    const guestRes = await app.request('/api/me', {}, meEnv)
    expect(guestRes.status).toBe(200)
    expect(guestRes.headers.get('cache-control')).toBe('no-store')
    const guestBody = (await guestRes.json()) as { user: unknown; oneTapNonce: string | null }
    expect(guestBody.user).toBeNull()
    expect(guestBody.oneTapNonce).toMatch(/^[A-Za-z0-9_-]{24}$/)
    const guestCookie = guestRes.headers.get('set-cookie') ?? ''
    expect(guestCookie).toContain(`g_nonce=${guestBody.oneTapNonce}`)
    expect(guestCookie).toContain('Path=/api/auth/google')
    expect(guestCookie).toContain('HttpOnly')

    const user = await upsertUser(meEnv, { email: 'a@example.com', name: null, picture: null, googleSub: 'sub-1', country: null, locale: null })
    const now = new Date().toISOString()
    const sid = 'session-token-1'
    const sidHash = await sha256Hex(sid)
    const expires = new Date(Date.now() + 3600_000).toISOString()
    sqlite.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(sidHash, user.id, expires, now)

    const userRes = await app.request('/api/me', { headers: { cookie: `sid=${sid}` } }, meEnv)
    expect(userRes.status).toBe(200)
    expect(userRes.headers.get('cache-control')).toBe('no-store')
    const userBody = (await userRes.json()) as { user: { id: string } | null; oneTapNonce: string | null }
    expect(userBody.user?.id).toBe(user.id)
    expect(userBody.oneTapNonce).toBeNull()
    expect(userRes.headers.get('set-cookie')).toBeNull()
  })

  it('nonce 接口把同一个值写进只发往登录接口的 cookie，且不缓存', async () => {
    const res = await app.request('/api/auth/google/nonce', {}, env)
    const { nonce } = (await res.json()) as { nonce: string }
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`g_nonce=${nonce}`)
    expect(cookie).toContain('Path=/api/auth/google')
    expect(cookie).toContain('HttpOnly')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('credential 的 nonce 和 cookie 对不上（或没有 cookie）时拒绝，不会建账号', async () => {
    mockGoogle()
    const credential = await idToken({ nonce: 'n-1' })
    const post = (cookie?: string) =>
      app.request(
        '/api/auth/google/one-tap',
        {
          method: 'POST',
          headers: { origin: 'https://site.example', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
          body: JSON.stringify({ credential }),
        },
        { ...env, AUTH_LIMITER: { limit: async () => ({ success: true }) } } as unknown as Env,
      )
    for (const res of [await post(), await post('g_nonce=n-2')]) {
      expect(res.status).toBe(401)
      expect(((await res.json()) as { error: string }).error).toBe('oauth_state')
    }
  })
})
