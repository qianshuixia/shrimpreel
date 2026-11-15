import { ApiError, base64Url, base64UrlDecode, cleanSecret, constantTimeEqual, randomToken } from './util'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'

type GoogleJwk = JsonWebKey & { kid?: string }

export interface GoogleProfile {
  sub: string
  email: string
  name: string | null
  picture: string | null
}

export interface GoogleOAuthConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export function googleClientId(env: Env) {
  return cleanSecret(env.GOOGLE_CLIENT_ID)
}

export function googleOAuthConfig(env: Env, origin: string): GoogleOAuthConfig | null {
  const clientId = googleClientId(env)
  const clientSecret = cleanSecret(env.GOOGLE_CLIENT_SECRET)
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret, redirectUri: `${origin}/api/auth/google/callback` }
}

// state 防 CSRF；PKCE（S256）让截获的授权码无法单独兑换；nonce 把 id_token 绑定到这一次登录。三者都存在回调的 cookie 里
export async function googleAuthRedirect(config: GoogleOAuthConfig) {
  const state = randomToken(18)
  const verifier = randomToken(32)
  const nonce = randomToken(18)
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  const url = new URL(GOOGLE_AUTH_URL)
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', state)
  url.searchParams.set('nonce', nonce)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('prompt', 'select_account')
  return { url: url.toString(), state, verifier, nonce }
}

export async function exchangeGoogleCode(
  code: string,
  config: GoogleOAuthConfig,
  pkce: { verifier: string; nonce: string },
): Promise<GoogleProfile> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: pkce.verifier,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new ApiError(502, 'google_token_exchange_failed')
  const body = (await response.json()) as { id_token?: string }
  if (!body.id_token) throw new ApiError(502, 'google_missing_id_token')
  return verifyGoogleIdToken(body.id_token, config.clientId, pkce.nonce)
}

// 同时用于 redirect 回调拿到的 id_token 和 One Tap 的 credential；nonce 必须和本站签发、存在 cookie 里的一致
export async function verifyGoogleIdToken(idToken: string, clientId: string, expectedNonce: string): Promise<GoogleProfile> {
  const [headerPart, payloadPart, signaturePart] = idToken.split('.')
  if (!headerPart || !payloadPart || !signaturePart) throw new ApiError(401, 'google_invalid_id_token')
  const header = decodeJson<{ alg?: string; kid?: string }>(headerPart)
  if (header.alg !== 'RS256' || !header.kid) throw new ApiError(401, 'google_invalid_id_token')
  await verifySignature(`${headerPart}.${payloadPart}`, signaturePart, header.kid)
  const body = decodeJson<{
    iss?: string
    aud?: string
    exp?: number
    sub?: string
    email?: string
    email_verified?: boolean
    nonce?: string
    name?: string
    picture?: string
  }>(payloadPart)
  if (body.iss !== 'https://accounts.google.com' && body.iss !== 'accounts.google.com') {
    throw new ApiError(401, 'google_invalid_id_token')
  }
  if (body.aud !== clientId) throw new ApiError(401, 'google_invalid_id_token')
  if (!body.exp || body.exp * 1000 <= Date.now()) throw new ApiError(401, 'google_id_token_expired')
  if (!expectedNonce || !body.nonce || !constantTimeEqual(body.nonce, expectedNonce)) throw new ApiError(401, 'oauth_state')
  if (!body.sub || !body.email) throw new ApiError(401, 'google_missing_email')
  if (body.email_verified !== true) throw new ApiError(403, 'google_email_not_verified')
  return { sub: body.sub, email: body.email.toLowerCase(), name: body.name ?? null, picture: body.picture ?? null }
}

function decodeJson<T>(part: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as T
  } catch {
    throw new ApiError(401, 'google_invalid_id_token')
  }
}

async function verifySignature(signingInput: string, signature: string, kid: string) {
  const response = await fetch(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(15_000), cf: { cacheTtl: 3600, cacheEverything: true } })
  if (!response.ok) throw new ApiError(502, 'google_jwks_unavailable')
  const jwks = (await response.json()) as { keys?: GoogleJwk[] }
  const jwk = jwks.keys?.find((key) => key.kid === kid)
  if (!jwk) throw new ApiError(401, 'google_invalid_id_token')
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
    'verify',
  ])
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlDecode(signature),
    new TextEncoder().encode(signingInput),
  )
  if (!valid) throw new ApiError(401, 'google_invalid_id_token')
}
