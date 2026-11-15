import { describe, expect, it, vi } from 'vitest'
import { handleDemoVideoRequest, parseByteRange } from '#/server/media'

describe('parseByteRange', () => {
  it('解析 start-end、start- 与 -suffix；越界返 unsatisfiable；非 bytes 单位忽略返 null', () => {
    expect(parseByteRange(null, 100)).toBeNull()
    expect(parseByteRange('items=0-5', 100)).toBeNull()
    expect(parseByteRange('bytes=0-1', 100)).toEqual({ start: 0, end: 1 })
    expect(parseByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseByteRange('bytes=50-999', 100)).toEqual({ start: 50, end: 99 })
    expect(parseByteRange('bytes=100-105', 100)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=10-5', 100)).toBe('unsatisfiable')
  })
})

describe('handleDemoVideoRequest', () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

  const makeEnv = (r2Hit = false) => {
    const cancelSpy = vi.fn(async () => {})
    const env = {
      MEDIA: {
        get: vi.fn(async () =>
          r2Hit
            ? {
                body: new ReadableStream({
                  start(c) {
                    c.enqueue(bytes.slice(0, 2))
                    c.close()
                  },
                }),
                size: bytes.byteLength,
                httpEtag: '"r2-demo"',
                range: { offset: 0, length: 2 },
                writeHttpMetadata(h: Headers) {
                  h.set('content-type', 'video/mp4')
                },
              }
            : null,
        ),
      },
      ASSETS: {
        fetch: vi.fn(async () => {
          let readCount = 0
          const stream = new ReadableStream<Uint8Array>({
            pull(c) {
              if (readCount === 0) c.enqueue(bytes.slice(0, 5))
              else if (readCount === 1) c.enqueue(bytes.slice(5))
              else c.close()
              readCount++
            },
            cancel: cancelSpy,
          })
          return new Response(stream, {
            status: 200,
            headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.byteLength), etag: '"asset-demo"' },
          })
        }),
      },
    }
    return { env: env as unknown as Env, cancelSpy }
  }

  it('R2 命中时直接返回 206 Partial Content', async () => {
    const { env } = makeEnv(true)
    const res = await handleDemoVideoRequest(new Request('https://site.example/demo/original.mp4', { headers: { range: 'bytes=0-1' } }), env, '/demo/original.mp4')
    expect(res?.status).toBe(206)
    expect(res?.headers.get('content-range')).toBe('bytes 0-1/10')
    expect(res?.headers.get('accept-ranges')).toBe('bytes')
    expect(res?.headers.get('cache-control')).toBe('public, max-age=604800')
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(new Uint8Array([0, 1]))
  })

  it('回退 Static Assets：支持 Range bytes=0-1 返 206 并提前 cancel 上游流，无 Range 返 200，越界 416，HEAD 空体', async () => {
    const { env, cancelSpy } = makeEnv(false)
    const partial = await handleDemoVideoRequest(
      new Request('https://site.example/demo/original.mp4', { headers: { range: 'bytes=0-1' } }),
      env,
      '/demo/original.mp4',
    )
    expect(partial?.status).toBe(206)
    expect(partial?.headers.get('content-range')).toBe('bytes 0-1/10')
    expect(partial?.headers.get('content-length')).toBe('2')
    expect(new Uint8Array(await partial!.arrayBuffer())).toEqual(new Uint8Array([0, 1]))
    expect(cancelSpy).toHaveBeenCalled()

    const full = await handleDemoVideoRequest(new Request('https://site.example/demo/original.mp4'), env, '/demo/original.mp4')
    expect(full?.status).toBe(200)
    expect(full?.headers.get('accept-ranges')).toBe('bytes')
    expect(new Uint8Array(await full!.arrayBuffer())).toEqual(bytes)

    const bad = await handleDemoVideoRequest(
      new Request('https://site.example/demo/original.mp4', { headers: { range: 'bytes=50-60' } }),
      env,
      '/demo/original.mp4',
    )
    expect(bad?.status).toBe(416)
    expect(bad?.headers.get('content-range')).toBe('bytes */10')

    const head = await handleDemoVideoRequest(
      new Request('https://site.example/demo/original.mp4', { method: 'HEAD', headers: { range: 'bytes=2-4' } }),
      env,
      '/demo/original.mp4',
    )
    expect(head?.status).toBe(206)
    expect(head?.headers.get('content-range')).toBe('bytes 2-4/10')
    expect(head?.headers.get('content-length')).toBe('3')
    expect((await head!.arrayBuffer()).byteLength).toBe(0)
  })
})
