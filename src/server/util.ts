export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
  }
}

export function createId(prefix: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return `${prefix}_${base64Url(bytes)}`
}

export function randomToken(byteLength = 32) {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

export function nowIso() {
  return new Date().toISOString()
}

export function base64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function base64UrlDecode(value: string) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
}

// 分块转：逐字节拼字符串时，几 MB 的照片在送审核前转 base64 就要上千毫秒 CPU，
// Workers 免费计划会直接以 exceededCpu 结束请求（客户端看到 503）。每次转 32 KB，同样的输入快几十倍
export function base64Encode(bytes: ArrayBuffer | Uint8Array) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const chunk = 0x8000
  let binary = ''
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode.apply(null, view.subarray(i, i + chunk) as unknown as number[])
  }
  return btoa(binary)
}

export function base64Decode(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
}

export async function sha256Hex(value: string | Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest('SHA-256', typeof value === 'string' ? new TextEncoder().encode(value) : value)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function hmacSha256(secret: Uint8Array<ArrayBuffer> | string, message: string) {
  const keyBytes = typeof secret === 'string' ? new TextEncoder().encode(secret) : secret
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)))
}

export function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function cleanSecret(value: string | undefined) {
  const cleaned = value?.replace(/^\uFEFF+/, '').trim()
  return cleaned ? cleaned : undefined
}

// staging（workers.dev 预发）按生产行为运行：禁用 mock、开发登录，Cookie 加 Secure；只有搜索引擎抓取不同，见 isIndexable
export function isProduction(env: { APP_ENV?: string }) {
  return env.APP_ENV === 'production' || env.APP_ENV === 'staging'
}

export function isIndexable(env: { APP_ENV?: string }) {
  return env.APP_ENV === 'production'
}

export function parseJsonRecord(value: string | undefined): Record<string, string> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    return {}
  }
}

export function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
}

export function isCheckConstraintError(error: unknown) {
  return error instanceof Error && /CHECK constraint failed/i.test(error.message)
}
