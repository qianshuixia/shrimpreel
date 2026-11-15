import { afterEach, describe, expect, it, vi } from 'vitest'
import { storeOutputFromUrl } from '#/server/jobs'

const LIMITS = { streamed: 1000, buffered: 100 }

afterEach(() => {
  vi.restoreAllMocks()
})

// R2 外壳：记录写入的字节数；流式写入时真的把流读完
function media() {
  const puts: Array<{ key: string; size: number; streamed: boolean }> = []
  const bucket = {
    async put(key: string, value: ReadableStream | Uint8Array) {
      if (value instanceof ReadableStream) {
        const size = (await new Response(value).arrayBuffer()).byteLength
        puts.push({ key, size, streamed: true })
      } else {
        puts.push({ key, size: value.byteLength, streamed: false })
      }
    },
  }
  return { puts, env: { MEDIA: bucket } as unknown as Env }
}

// 分块的响应体，记录被读了多少块，用来确认超限后没有继续读
function chunkedBody(chunks: number, chunkSize: number) {
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === chunks) return controller.close()
      sent += 1
      controller.enqueue(new Uint8Array(chunkSize))
    },
  })
  return { body, sent: () => sent }
}

function serve(body: BodyInit | null, headers: Record<string, string> = {}, status = 200) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status, headers }))
}

describe('storeOutputFromUrl：成片下载大小上限', () => {
  it('带 Content-Length 且未超限：直接把响应流写进 R2', async () => {
    const { env, puts } = media()
    serve(new Uint8Array(800), { 'content-length': '800' })
    expect(await storeOutputFromUrl(env, 'https://cdn.example/v.mp4', 'outputs/u/g.mp4', LIMITS)).toBe(true)
    expect(puts).toEqual([{ key: 'outputs/u/g.mp4', size: 800, streamed: true }])
  })

  it('Content-Length 超过上限：不读响应体、不写 R2', async () => {
    const { env, puts } = media()
    const stream = chunkedBody(50, 100)
    serve(stream.body, { 'content-length': '5000' })
    expect(await storeOutputFromUrl(env, 'https://cdn.example/v.mp4', 'k', LIMITS)).toBe(false)
    expect(puts).toEqual([])
    expect(stream.sent()).toBeLessThanOrEqual(1)
  })

  it('没有 Content-Length：边读边计数，超过缓存上限就停止读取', async () => {
    const { env, puts } = media()
    const stream = chunkedBody(50, 30)
    serve(stream.body)
    expect(await storeOutputFromUrl(env, 'https://cdn.example/v.mp4', 'k', LIMITS)).toBe(false)
    expect(puts).toEqual([])
    expect(stream.sent()).toBeLessThan(10)
  })

  it('没有 Content-Length 且在缓存上限内：拼好后写入', async () => {
    const { env, puts } = media()
    serve(chunkedBody(3, 30).body)
    expect(await storeOutputFromUrl(env, 'https://cdn.example/v.mp4', 'k', LIMITS)).toBe(true)
    expect(puts).toEqual([{ key: 'k', size: 90, streamed: false }])
  })

  it('下载失败抛错，交给队列重试', async () => {
    const { env } = media()
    serve('nope', {}, 503)
    await expect(storeOutputFromUrl(env, 'https://cdn.example/v.mp4', 'k', LIMITS)).rejects.toThrow('HTTP 503')
  })

  it('只允许 https:（以及拒绝 302 降级到 http://）；合法 https 重定向可正常写入', async () => {
    const { env, puts } = media()
    await expect(storeOutputFromUrl(env, 'http://cdn.example/v.mp4', 'k', LIMITS)).rejects.toThrow('unsafe output url protocol')

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://insecure.example/v.mp4' } }),
    )
    await expect(storeOutputFromUrl(env, 'https://cdn.example/v.mp4', 'k', LIMITS)).rejects.toThrow('unsafe output url protocol')

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://edge.cdn.example/v.mp4' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array(12), { status: 200, headers: { 'content-length': '12' } }))
    expect(await storeOutputFromUrl(env, 'https://cdn.example/v.mp4', 'k', LIMITS)).toBe(true)
    expect(puts).toEqual([{ key: 'k', size: 12, streamed: false }])
  })
})
