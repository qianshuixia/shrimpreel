import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { handoffRoutes } from '../../src/server/handoff'
import { expiredHandoffKeys, sweepHandoff } from '../../src/server/retention'
import { ApiError } from '../../src/server/util'

const NOW = Date.parse('2026-10-31T12:00:00Z')
const minutesAgo = (n: number) => new Date(NOW - n * 60_000)

describe('手机传图中转对象的清理', () => {
  it('只选出上传超过 1 小时的对象', () => {
    const objects = [
      { key: 'handoff/a/pending', uploaded: minutesAgo(61) },
      { key: 'handoff/b/photo', uploaded: minutesAgo(59) },
      { key: 'handoff/c/taken', uploaded: minutesAgo(180) },
    ]
    expect(expiredHandoffKeys(objects, NOW)).toEqual(['handoff/a/pending', 'handoff/c/taken'])
  })

  it('分页列出所有对象，只删过期的', async () => {
    const pages = [
      { objects: [{ key: 'handoff/a/photo', uploaded: minutesAgo(90) }, { key: 'handoff/b/photo', uploaded: minutesAgo(5) }], truncated: true, cursor: 'next' },
      { objects: [{ key: 'handoff/c/pending', uploaded: minutesAgo(70) }], truncated: false },
    ]
    const deleted: string[] = []
    const seen: Array<{ prefix?: string; cursor?: string }> = []
    const env = {
      MEDIA: {
        list: async (options: { prefix?: string; cursor?: string }) => {
          seen.push(options)
          return pages[options.cursor ? 1 : 0]
        },
        delete: async (keys: string[]) => void deleted.push(...keys),
      },
    } as unknown as Env
    expect(await sweepHandoff(env, NOW)).toBe(2)
    expect(deleted).toEqual(['handoff/a/photo', 'handoff/c/pending'])
    expect(seen.map((s) => s.prefix)).toEqual(['handoff/', 'handoff/'])
  })

  it('POST /take 走 PUBLIC_LIMITER 按客户端 IP 限流，超限返回 429 且不读 R2', async () => {
    const app = new Hono()
      .onError((err, c) => (err instanceof ApiError ? c.json({ error: err.code }, err.status as 429) : c.text('err', 500)))
      .route('/api/handoff', handoffRoutes)
    const get = vi.fn(async () => null)
    const limit = vi.fn(async () => ({ success: false }))
    const response = await app.request(
      '/api/handoff/take',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.9' },
        body: JSON.stringify({ token: 'a'.repeat(32) }),
      },
      { PUBLIC_LIMITER: { limit }, MEDIA: { get } } as unknown as Env,
    )
    expect(response.status).toBe(429)
    expect(limit).toHaveBeenCalledWith({ key: 'handoff-take:198.51.100.9' })
    expect(get).not.toHaveBeenCalled()
  })
})
