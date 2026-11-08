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
  // 太小 / 太窄太扁：浏览器端（src/lib/prepare-photo.ts）已经拦过，这里兜底旧页面和直接调接口的请求；放在审核前，不浪费 CPU
  const problem = imageProblem(imageSize(bytes, contentType))
  if (problem) throw new ApiError(422, problem)
  return { bytes, contentType }
}

// 从文件头读宽高：JPEG 找 SOF 段、PNG 读 IHDR、WebP 读 VP8 / VP8L / VP8X 头。读不出返回 null（放行）。
// 只扫字节、不解码，CPU 可以忽略
export function imageSize(bytes: Uint8Array, type: 'image/jpeg' | 'image/png' | 'image/webp'): { width: number; height: number } | null {
  const u16 = (i: number) => (bytes[i]! << 8) | bytes[i + 1]!
  if (type === 'image/png') {
    if (bytes.length < 24) return null
    const u32 = (i: number) => ((bytes[i]! << 24) >>> 0) + (bytes[i + 1]! << 16) + (bytes[i + 2]! << 8) + bytes[i + 3]!
    return { width: u32(16), height: u32(20) }
  }
  if (type === 'image/jpeg') {
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++
        continue
      }
      const marker = bytes[i + 1]!
      // SOF0–SOF15，去掉 DHT(C4) / JPG(C8) / DAC(CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: u16(i + 5), width: u16(i + 7) }
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
        i += marker === 0xff ? 1 : 2
        continue
      }
      if (marker === 0xda || marker === 0xd9) return null // 到图像数据了还没见 SOF
      i += 2 + u16(i + 2)
    }
    return null
  }
  if (bytes.length < 30) return null
  const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!)
  if (chunk === 'VP8 ') return { width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff, height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff }
  if (chunk === 'VP8L') {
    const [b0, b1, b2, b3] = [bytes[21]!, bytes[22]!, bytes[23]!, bytes[24]!]
    return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) }
  }
  if (chunk === 'VP8X') {
    return { width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)), height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) }
  }
  return null
}

// 和浏览器端 photoProblem 同一套阈值（site.upload.minSide / maxRatio）
export function imageProblem(size: { width: number; height: number } | null): 'photo_too_small' | 'photo_bad_ratio' | null {
  if (!size || !size.width || !size.height) return null
  const short = Math.min(size.width, size.height)
  if (short < site.upload.minSide) return 'photo_too_small'
  if (Math.max(size.width, size.height) / short > site.upload.maxRatio) return 'photo_bad_ratio'
  return null
}
