import { Hono } from 'hono'
import { rateLimit, readJson } from './http'
import { readImageFile, readUploadForm } from './media'
import { HANDOFF_PREFIX } from './retention'
import type { AppContext } from './types'
import { ApiError, randomToken, sha256Hex } from './util'

// 扫码用手机传图：照片经 R2 中转回桌面浏览器，桌面再走正常的 selectFile → /api/uploads（审核在那一步）。
// 用 R2 而不是 KV：R2 强一致，KV 跨机房最长 60 秒才可见，还会缓存“不存在”，轮询会卡住。
// 对象：handoff/<sha256(token)>/pending（等待中，customMetadata.expiresAt）→ 手机传完后换成 handoff/<hash>/photo → 桌面取走后留一个空的 taken 标记（再传返回 handoff_used 而不是 handoff_expired）；
// 桌面取走即删，没取走的由 Cron 在 1 小时后清掉（retention.ts 的 sweepHandoff）。token 只在二维码的 URL fragment 里，不进日志。
export const HANDOFF_TTL_MS = 10 * 60_000

export const handoffRoutes = new Hono<AppContext>()

function clientIp(c: { req: { header: (name: string) => string | undefined } }) {
  return c.req.header('cf-connecting-ip') ?? 'local'
}

async function keysFor(token: unknown) {
  // 正常 token 是 43 个字符的 base64url；长度限制只是挡掉垃圾输入
  if (typeof token !== 'string' || !/^[\w-]{16,128}$/.test(token)) throw new ApiError(410, 'handoff_expired')
  const hash = await sha256Hex(token)
  return { pending: `${HANDOFF_PREFIX}${hash}/pending`, photo: `${HANDOFF_PREFIX}${hash}/photo`, taken: `${HANDOFF_PREFIX}${hash}/taken` }
}

async function pendingAlive(env: Env, key: string) {
  const head = await env.MEDIA.head(key)
  return !!head && Number(head.customMetadata?.expiresAt ?? 0) > Date.now()
}

handoffRoutes.post('/', async (c) => {
  await rateLimit(c.env.UPLOAD_LIMITER, `handoff:${clientIp(c)}`)
  const token = randomToken()
  const keys = await keysFor(token)
  const expiresAt = Date.now() + HANDOFF_TTL_MS
  await c.env.MEDIA.put(keys.pending, new Uint8Array(0), { customMetadata: { expiresAt: String(expiresAt) } })
  c.header('Cache-Control', 'no-store')
  return c.json({ token, expiresAt: new Date(expiresAt).toISOString() })
})

handoffRoutes.post('/photo', async (c) => {
  await rateLimit(c.env.UPLOAD_LIMITER, `handoff:${clientIp(c)}`)
  const form = await readUploadForm(c)
  const keys = await keysFor(form?.get('token'))
  if ((await c.env.MEDIA.head(keys.photo)) || (await c.env.MEDIA.head(keys.taken))) throw new ApiError(409, 'handoff_used')
  if (!(await pendingAlive(c.env, keys.pending))) throw new ApiError(410, 'handoff_expired')
  const { bytes, contentType } = await readImageFile(form)
  // etagDoesNotMatch '*'：只在对象不存在时写入，两台手机同时传同一个 token 时只有一个成功
  const stored = await c.env.MEDIA.put(keys.photo, bytes, {
    httpMetadata: { contentType },
    onlyIf: { etagDoesNotMatch: '*' },
  })
  if (!stored) throw new ApiError(409, 'handoff_used')
  await c.env.MEDIA.delete(keys.pending)
  return c.json({ ok: true }, 201)
})

// 桌面每 2 秒轮询一次，不限流：UPLOAD_LIMITER 是每分钟 20 次，会把正常轮询挡成 429。
// 每次只有 1~2 次 R2 读（A 类写操作为 0），要猜中 256 位随机 token 才有内容，最坏的滥用是浪费读配额，交给 Cloudflare 层的速率规则
handoffRoutes.post('/take', async (c) => {
  const body = await readJson<{ token: string }>(c)
  const keys = await keysFor(body.token)
  c.header('Cache-Control', 'no-store')
  const object = await c.env.MEDIA.get(keys.photo)
  if (object) {
    const bytes = await object.arrayBuffer()
    await c.env.MEDIA.put(keys.taken, new Uint8Array(0))
    await c.env.MEDIA.delete(keys.photo)
    return c.body(bytes, 200, { 'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream' })
  }
  if (await pendingAlive(c.env, keys.pending)) return c.body(null, 204)
  throw new ApiError(410, 'handoff_expired')
})
