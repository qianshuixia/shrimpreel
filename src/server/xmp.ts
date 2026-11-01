import { buildXmpBox, buildXmpPacket, inspectForXmp, type RangeReader, type XmpFields } from '#/lib/xmp'

// 'tagged'：本次追加了标记；'already_tagged'：对象里已经有同 UUID 的 box；'skipped'：结构不适合追加（已 warn），成片保持原样
export type TagResult = 'tagged' | 'already_tagged' | 'skipped'

interface FixedLength {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
}

// 给已存进 R2 的成片追加 XMP uuid box，不把整个文件读进内存：
// 1) 用几次 range 读取遍历顶层 box 头，确认还没有标记、最后一个 box 长度明确（size=0 的 box 会吞掉追加的内容）
// 2) 用 FixedLengthStream（总长 = 原长 + box 长）把原流 + box 写回同一个 key；put 带 etag 条件，期间被别的路径覆盖则放弃
export async function tagOutputWithXmp(
  bucket: R2Bucket,
  key: string,
  fields: XmpFields,
  // 单元测试里没有 FixedLengthStream，可注入替代
  createStream: (length: number) => FixedLength = (length) => new FixedLengthStream(length),
): Promise<TagResult> {
  const head = await bucket.head(key)
  if (!head) throw new Error(`xmp: output ${fields.generationId} missing from R2`)

  const read: RangeReader = async (offset, length) => {
    const part = await bucket.get(key, { range: { offset, length } })
    if (!part || !('body' in part)) throw new Error(`xmp: cannot read output ${fields.generationId}`)
    return new Uint8Array(await part.arrayBuffer())
  }
  const inspection = await inspectForXmp(read, head.size)
  if (inspection.kind === 'has_xmp') return 'already_tagged'
  if (inspection.kind === 'unsupported') {
    console.warn('output xmp skipped', { generationId: fields.generationId, reason: inspection.reason })
    return 'skipped'
  }

  const box = buildXmpBox(buildXmpPacket(fields))
  const source = await bucket.get(key, { onlyIf: { etagMatches: head.etag } })
  if (!source || !('body' in source)) {
    console.warn('output xmp skipped', { generationId: fields.generationId, reason: 'changed' })
    return 'skipped'
  }

  const stream = createStream(head.size + box.byteLength)
  const stored = bucket.put(key, stream.readable, {
    httpMetadata: source.httpMetadata,
    customMetadata: source.customMetadata,
    onlyIf: { etagMatches: head.etag },
  })
  const copy = (async () => {
    await source.body.pipeTo(stream.writable, { preventClose: true })
    const writer = stream.writable.getWriter()
    await writer.write(box)
    await writer.close()
  })()
  const [result] = await Promise.all([stored, copy])
  if (!result) {
    console.warn('output xmp skipped', { generationId: fields.generationId, reason: 'changed' })
    return 'skipped'
  }
  return 'tagged'
}
