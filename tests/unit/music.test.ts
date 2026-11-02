import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny'
import { addStyleMusic } from '#/server/music'

const video = new Uint8Array(readFileSync('tests/fixtures/video-6s.mp4'))
const music = new Uint8Array(readFileSync('tests/fixtures/music-6s.m4a'))

// 内存版 R2：支持 head / get(onlyIf) / put(onlyIf)，对象带 httpMetadata
function fakeBucket(objects: Record<string, Uint8Array>) {
  const store = new Map(Object.entries(objects).map(([k, v]) => [k, { data: v, etag: 'e1' }]))
  const puts: { key: string; httpMetadata?: unknown; customMetadata?: unknown }[] = []
  const bucket = {
    async head(key: string) {
      const o = store.get(key)
      return o && { size: o.data.length, etag: o.etag }
    },
    async get(key: string, options: { onlyIf?: { etagMatches: string } } = {}) {
      const o = store.get(key)
      if (!o) return null
      if (options.onlyIf && options.onlyIf.etagMatches !== o.etag) return { size: o.data.length, etag: o.etag }
      return {
        size: o.data.length,
        etag: o.etag,
        httpMetadata: { contentType: 'video/mp4' },
        customMetadata: { k: 'v' },
        body: new Response(o.data as BodyInit).body,
        arrayBuffer: async () => o.data.slice().buffer,
      }
    },
    async put(key: string, value: Uint8Array, options: { httpMetadata?: unknown; customMetadata?: unknown; onlyIf?: { etagMatches: string } }) {
      const o = store.get(key)
      if (options.onlyIf && o && options.onlyIf.etagMatches !== o.etag) return null
      store.set(key, { data: value, etag: `${o?.etag ?? 'e'}+` })
      puts.push({ key, httpMetadata: options.httpMetadata, customMetadata: options.customMetadata })
      return { etag: store.get(key)!.etag }
    },
  }
  return { bucket: bucket as unknown as R2Bucket, store, puts }
}

const audioCodec = async (bytes: Uint8Array) => (await new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS }).getPrimaryAudioTrack())?.codec

afterEach(() => vi.restoreAllMocks())

describe('addStyleMusic', () => {
  it('混流后写回同一个 key，成片字节变了，httpMetadata 和 customMetadata 保留', async () => {
    const r2 = fakeBucket({ 'outputs/u/g.mp4': video, 'templates/music-6s.m4a': music })
    expect(await addStyleMusic(r2.bucket, 'outputs/u/g.mp4', 'music-6s.m4a', 'g')).toBe('mixed')
    const after = r2.store.get('outputs/u/g.mp4')!.data
    expect(Buffer.compare(after, video)).not.toBe(0)
    expect(await audioCodec(after)).toBe('aac')
    expect(r2.puts).toEqual([{ key: 'outputs/u/g.mp4', httpMetadata: { contentType: 'video/mp4' }, customMetadata: { k: 'v' } }])
  })

  it('音乐文件不在 R2：console.error 并跳过，成片字节不变', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r2 = fakeBucket({ 'outputs/u/g.mp4': video })
    expect(await addStyleMusic(r2.bucket, 'outputs/u/g.mp4', 'missing.m4a', 'g')).toBe('skipped')
    expect(error).toHaveBeenCalled()
    expect(r2.store.get('outputs/u/g.mp4')!.data).toBe(video)
    expect(r2.puts).toEqual([])
  })

  it('读取后、写回前成片被别的路径改写（etag 变了）：放弃，不覆盖对方的内容', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r2 = fakeBucket({ 'outputs/u/g.mp4': video, 'templates/music-6s.m4a': music })
    const other = new Uint8Array([1, 2, 3])
    // 条件读取成片之后、写回之前换掉对象
    const get = r2.bucket.get.bind(r2.bucket)
    r2.bucket.get = (async (key: string, options?: R2GetOptions) => {
      const result = await get(key, options)
      if (key === 'outputs/u/g.mp4' && options?.onlyIf) r2.store.set(key, { data: other, etag: 'other' })
      return result
    }) as typeof r2.bucket.get
    expect(await addStyleMusic(r2.bucket, 'outputs/u/g.mp4', 'music-6s.m4a', 'g')).toBe('skipped')
    expect(r2.store.get('outputs/u/g.mp4')!.data).toBe(other)
  })

  it('成片不是合法 MP4（混流抛错）：warn 并跳过，成片字节不变', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const junk = new Uint8Array(64)
    const r2 = fakeBucket({ 'outputs/u/g.mp4': junk, 'templates/music-6s.m4a': music })
    expect(await addStyleMusic(r2.bucket, 'outputs/u/g.mp4', 'music-6s.m4a', 'g')).toBe('skipped')
    expect(warn).toHaveBeenCalled()
    expect(r2.store.get('outputs/u/g.mp4')!.data).toBe(junk)
  })
})
