import type { Context } from 'hono'
import { site } from '#/config/site'
import { isWeakSessionSecret } from './config-health'
import type { AppContext } from './types'
import { ApiError, base64Url, constantTimeEqual, hmacSha256, isProduction } from './util'

// 生产环境的签名密钥缺失、过短或仍是示例值时拒绝签名，而不是签出可伪造的 URL
function signingSecret(env: Env) {
  const secret = env.SESSION_SECRET ?? ''
  if (isProduction(env) && isWeakSessionSecret(secret)) {
    throw new ApiError(503, 'server_misconfigured', 'SESSION_SECRET is missing, shorter than 32 characters, or still the example value')
  }
  return secret
}

// 给视频 provider 拉取用户上传图片用的短期签名 URL：/media/uploads/<uploadId>?exp=&sig=
// issuedAtMs 固定时 URL 也固定：同一任务重新提交时请求体不变（yir 的幂等键按请求体识别）
export async function signedUploadUrl(env: Env, uploadId: string, issuedAtMs = Date.now(), ttlSeconds = 2 * 3600) {
  const exp = Math.floor(issuedAtMs / 1000) + ttlSeconds
  const sig = base64Url(await hmacSha256(signingSecret(env), `upload:${uploadId}:${exp}`))
  return `${env.SITE_URL.replace(/\/$/, '')}/media/uploads/${uploadId}?exp=${exp}&sig=${sig}`
}

export async function verifyUploadSignature(env: Env, uploadId: string, exp: string | null, sig: string | null) {
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false
  const expected = base64Url(await hmacSha256(signingSecret(env), `upload:${uploadId}:${exp}`))
  return constantTimeEqual(expected, sig)
}

// fal webhook 回调地址里带的 token，防止伪造回调触发无意义的轮询
export async function jobToken(env: Env, generationId: string) {
  return base64Url(await hmacSha256(signingSecret(env), `job:${generationId}`))
}

export function templateSourceUrl(env: Env, file: string) {
  return `${env.SITE_URL.replace(/\/$/, '')}/media/templates/${file}`
}

// 从 R2 输出对象，支持 Range（视频拖动进度条必需）与条件请求
export async function serveR2Object(
  bucket: R2Bucket,
  key: string,
  request: Request,
  options: { cacheControl: string; downloadName?: string },
) {
  const object = await bucket.get(key, { range: request.headers, onlyIf: request.headers })
  if (!object) return new Response('Not found', { status: 404 })

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  headers.set('accept-ranges', 'bytes')
  headers.set('cache-control', options.cacheControl)
  if (options.downloadName) headers.set('content-disposition', `attachment; filename="${options.downloadName}"`)

  if (!('body' in object)) return new Response(null, { status: 304, headers })

  const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined
  if (range && request.headers.has('range')) {
    const offset = range.offset ?? (range.suffix !== undefined ? object.size - range.suffix : 0)
    const length = range.length ?? object.size - offset
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`)
    headers.set('content-length', String(length))
    return new Response(object.body, { status: 206, headers })
  }
  headers.set('content-length', String(object.size))
  return new Response(object.body, { status: 200, headers })
}

// 只认真实图片：按文件头魔数判断，不信任客户端传的 Content-Type
export function sniffImageType(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return 'image/png'
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

// 图片上传的共用校验（/api/uploads 与手机传图 /api/handoff/photo 同一套）：
// 没有 Content-Length（分块上传）时 formData() 会把整个请求体读进内存，直接拒绝；浏览器上传表单总会带长度
export async function readUploadForm(c: Context<AppContext>): Promise<FormData | null> {
  const header = c.req.header('content-length')
  if (!header || !/^\d+$/.test(header)) throw new ApiError(411, 'length_required')
  if (Number(header) > site.upload.maxBytes + 64 * 1024) throw new ApiError(413, 'file_too_large')
  return c.req.raw.formData().catch(() => null)
}

// 取出 file 字段，按大小和文件头魔数校验，返回字节与嗅探出的类型
export async function readImageFile(form: FormData | null) {
  const file = form?.get('file')
  if (!file || typeof file === 'string') throw new ApiError(400, 'missing_file')
  if (file.size > site.upload.maxBytes) throw new ApiError(413, 'file_too_large')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const contentType = sniffImageType(bytes)
  if (!contentType || !(site.upload.contentTypes as readonly string[]).includes(contentType)) {
    throw new ApiError(415, 'unsupported_file_type')
  }
  return { bytes, contentType }
}
