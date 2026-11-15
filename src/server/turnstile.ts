import { ApiError, cleanSecret } from './util'

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export function turnstileSiteKey(env: Env) {
  return env.TURNSTILE_SITE_KEY?.trim() || null
}

// 配了站点密钥才启用；启用但缺 secret 时直接报错，避免前端显示验证、后端却不校验
export async function verifyTurnstile(env: Env, token: unknown, remoteIp: string | undefined, fetcher: typeof fetch = fetch) {
  if (!turnstileSiteKey(env)) return
  const secret = cleanSecret(env.TURNSTILE_SECRET_KEY)
  if (!secret) throw new ApiError(503, 'captcha_not_configured', 'TURNSTILE_SITE_KEY is set but TURNSTILE_SECRET_KEY is missing')
  if (typeof token !== 'string' || !token || token.length > 2048) throw new ApiError(400, 'captcha_required')

  const body = new FormData()
  body.append('secret', secret)
  body.append('response', token)
  if (remoteIp) body.append('remoteip', remoteIp)
  let data: { success?: boolean; 'error-codes'?: string[] }
  try {
    const response = await fetcher(SITEVERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`siteverify HTTP ${response.status}`)
    data = (await response.json()) as typeof data
  } catch (error) {
    console.error('turnstile siteverify failed', error)
    throw new ApiError(503, 'captcha_unavailable')
  }
  if (!data.success) {
    console.warn('turnstile rejected', data['error-codes'])
    throw new ApiError(400, 'captcha_failed')
  }
}
