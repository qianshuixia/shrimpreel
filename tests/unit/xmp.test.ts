import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  XMP_UUID_HEX,
  buildXmpBox,
  buildXmpPacket,
  inspectForXmp,
  parseXmpAiInfo,
  readXmpFromBlob,
  scanTopLevelBoxes,
  type XmpFields,
} from '#/lib/xmp'
import { tagOutputWithXmp } from '#/server/xmp'

const fields: XmpFields = {
  generationId: 'gen_AbC123-xyz_',
  brand: 'ShrimpReel',
  model: 'fal-ai/wan/v2.2-14b/animate/replace',
  provider: 'fal',
  createdAt: '2026-11-01T10:00:00.000Z',
  verifyUrl: 'https://example.com/verify?id=gen_AbC123-xyz_',
}

function box(type: string, payloadSize: number, size?: number) {
  const out = new Uint8Array(8 + payloadSize)
  new DataView(out.buffer).setUint32(0, size ?? out.length)
  out.set(new TextEncoder().encode(type), 4)
  out.fill(0x2a, 8)
  return out
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

// ftyp + moov + mdat，最后一个 box 有明确长度
const mp4 = () => concat(box('ftyp', 16), box('moov', 100), box('mdat', 5000))

function fakeBucket(initial: Uint8Array) {
  let data = initial
  let etag = 'e1'
  let puts = 0
  const bucket = {
    async head() {
      return { size: data.length, etag }
    },
    async get(_key: string, options: { range?: { offset: number; length: number }; onlyIf?: { etagMatches: string } } = {}) {
      if (options.onlyIf && options.onlyIf.etagMatches !== etag) return { size: data.length, etag }
      const part = options.range ? data.slice(options.range.offset, options.range.offset + options.range.length) : data
      return {
        size: data.length,
        etag,
        httpMetadata: { contentType: 'video/mp4' },
        customMetadata: undefined,
        body: new Response(part as BodyInit).body,
        arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength),
      }
    },
    async put(_key: string, stream: ReadableStream<Uint8Array>, options: { onlyIf?: { etagMatches: string } }) {
      if (options.onlyIf && options.onlyIf.etagMatches !== etag) return null
      data = new Uint8Array(await new Response(stream).arrayBuffer())
      etag = `e${++puts + 1}`
      return { etag }
    },
  }
  return { bucket: bucket as unknown as R2Bucket, bytes: () => data, replace: (next: Uint8Array) => ((data = next), (etag = 'other')) }
}

// 测试里没有 FixedLengthStream：用 TransformStream 代替，并核对写入的总长
const lengths: number[] = []
const createStream = (length: number) => {
  lengths.push(length)
  return new TransformStream<Uint8Array, Uint8Array>()
}

afterEach(() => {
  lengths.length = 0
  vi.restoreAllMocks()
})

describe('XMP 包与 box', () => {
  it('box：大小、uuid 类型、XMP UUID 正确；XMP 带 AI 来源类型和生成 id，且不含个人信息', () => {
    const packet = buildXmpPacket(fields)
    const bytes = buildXmpBox(packet)
    const view = new DataView(bytes.buffer)
    expect(view.getUint32(0)).toBe(bytes.length)
    expect(new TextDecoder().decode(bytes.subarray(4, 8))).toBe('uuid')
    expect(Array.from(bytes.subarray(8, 24), (b) => b.toString(16).padStart(2, '0')).join('')).toBe('be7acfcb97a942e89c71999491e3afac')
    expect(new TextDecoder().decode(bytes.subarray(24))).toBe(packet)
    expect(packet).toContain('trainedAlgorithmicMedia')
    expect(packet).toContain('<xmp:CreateDate>2026-11-01T10:00:00.000Z</xmp:CreateDate>')
    expect(packet).toContain('fal-ai/wan/v2.2-14b/animate/replace via fal')
    expect(packet).not.toMatch(/@/)
  })

  it('XMP 可解析：读回生成 id 和来源类型；转义字符不破坏结构；非本站格式返回 null', () => {
    const info = parseXmpAiInfo(buildXmpPacket({ ...fields, brand: 'A<B>&"C"' }))
    expect(info).toEqual({ generationId: 'gen_AbC123-xyz_', digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia' })
    expect(parseXmpAiInfo('<x:xmpmeta></x:xmpmeta>')).toBeNull()
    expect(parseXmpAiInfo('<aivideo:GenerationId>../../etc</aivideo:GenerationId>')).toBeNull()
  })
})

describe('顶层 box 遍历', () => {
  const read = (data: Uint8Array) => async (offset: number, length: number) => data.slice(offset, offset + length)

  it('列出顶层 box；64 位 largesize 和 size=0 都能识别', async () => {
    const large = new Uint8Array(24)
    const view = new DataView(large.buffer)
    view.setUint32(0, 1)
    large.set(new TextEncoder().encode('free'), 4)
    view.setUint32(12, 24)
    const data = concat(box('ftyp', 8), large, box('mdat', 20, 0))
    const scan = await scanTopLevelBoxes(read(data), data.length)
    expect(scan.ok).toBe(true)
    expect(scan.boxes.map((b) => [b.type, b.size, b.extendsToEnd])).toEqual([
      ['ftyp', 16, false],
      ['free', 24, false],
      ['mdat', 28, true],
    ])
  })

  it('box 长度越界、尾部残缺都判 invalid，不无限循环', async () => {
    const truncated = concat(box('ftyp', 8), box('mdat', 20, 500))
    expect(await scanTopLevelBoxes(read(truncated), truncated.length)).toMatchObject({ ok: false, reason: 'invalid' })
    const trailing = concat(box('ftyp', 8), new Uint8Array([1, 2, 3]))
    expect(await scanTopLevelBoxes(read(trailing), trailing.length)).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('inspectForXmp：可追加 / 已有标记 / size=0 / 不是 MP4', async () => {
    const plain = mp4()
    expect(await inspectForXmp(read(plain), plain.length)).toEqual({ kind: 'appendable' })
    const tagged = concat(plain, buildXmpBox(buildXmpPacket(fields)))
    expect(await inspectForXmp(read(tagged), tagged.length)).toMatchObject({ kind: 'has_xmp' })
    const open = concat(box('ftyp', 8), box('mdat', 100, 0))
    expect(await inspectForXmp(read(open), open.length)).toEqual({ kind: 'unsupported', reason: 'open_ended' })
    const other = concat(box('moov', 8), box('mdat', 8))
    expect(await inspectForXmp(read(other), other.length)).toEqual({ kind: 'unsupported', reason: 'not_mp4' })
  })

  it('浏览器侧：从 Blob 里读出 XMP，没标记的文件返回 null', async () => {
    const tagged = concat(mp4(), buildXmpBox(buildXmpPacket(fields)))
    const xmp = await readXmpFromBlob(new Blob([tagged]))
    expect(parseXmpAiInfo(xmp!)?.generationId).toBe(fields.generationId)
    expect(await readXmpFromBlob(new Blob([mp4()]))).toBeNull()
    expect(await readXmpFromBlob(new Blob([new Uint8Array([1, 2, 3])]))).toBeNull()
  })
})

describe('tagOutputWithXmp（流式追加到 R2 对象）', () => {
  it('追加 box：原内容不变，总长 = 原长 + box 长，写回的对象含 XMP；再调一次不重复追加', async () => {
    const original = mp4()
    const r2 = fakeBucket(original)
    expect(await tagOutputWithXmp(r2.bucket, 'k', fields, createStream)).toBe('tagged')
    const boxBytes = buildXmpBox(buildXmpPacket(fields))
    expect(lengths).toEqual([original.length + boxBytes.length])
    expect(r2.bytes()).toEqual(concat(original, boxBytes))
    expect((await scanTopLevelBoxes(async (o, l) => r2.bytes().slice(o, o + l), r2.bytes().length)).boxes.at(-1)).toMatchObject({ usertype: XMP_UUID_HEX })

    const after = r2.bytes()
    expect(await tagOutputWithXmp(r2.bucket, 'k', fields, createStream)).toBe('already_tagged')
    expect(r2.bytes()).toEqual(after)
    expect(lengths).toHaveLength(1)
  })

  it('最后一个 box 的 size=0：跳过并 warn，成片保持原样', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const open = concat(box('ftyp', 8), box('mdat', 100, 0))
    const r2 = fakeBucket(open)
    expect(await tagOutputWithXmp(r2.bucket, 'k', fields, createStream)).toBe('skipped')
    expect(r2.bytes()).toEqual(open)
    expect(warn).toHaveBeenCalledWith('output xmp skipped', { generationId: fields.generationId, reason: 'open_ended' })
  })

  it('读取后对象被别的路径覆盖（etag 变了）：放弃追加，不覆盖对方的内容', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r2 = fakeBucket(mp4())
    const head = r2.bucket.head.bind(r2.bucket)
    // 抢在条件读取之前换掉对象
    r2.bucket.head = (async (key: string) => {
      const result = await head(key)
      r2.replace(concat(mp4(), box('free', 4)))
      return result
    }) as typeof r2.bucket.head
    expect(await tagOutputWithXmp(r2.bucket, 'k', fields, createStream)).toBe('skipped')
    expect(warn).toHaveBeenCalledWith('output xmp skipped', { generationId: fields.generationId, reason: 'changed' })
    expect(r2.bytes()).toEqual(concat(mp4(), box('free', 4)))
  })
})
