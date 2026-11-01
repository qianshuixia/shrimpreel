// 成片 AI 元数据（XMP）：在 MP4 末尾追加一个顶层 uuid box，内容是 XMP 包。
// 纯函数，不依赖 Worker / 浏览器专有 API：服务端（src/server/xmp.ts 追加）和验证页（浏览器里读取）共用。
// 依据：欧盟 AI Act 第 50(2) 条（机器可读标记）、加州 SB 942（潜在披露）；XMP 在 MP4 里的存放方式见 Adobe XMP Specification Part 3（uuid box）。

// XMP 专用的 uuid：BE7ACFCB-97A9-42E8-9C71-999491E3AFAC
export const XMP_UUID_HEX = 'be7acfcb97a942e89c71999491e3afac'
const XMP_UUID_BYTES = Uint8Array.from(XMP_UUID_HEX.match(/../g)!.map((hex) => parseInt(hex, 16)))

// IPTC 的“由训练出的算法生成的媒体”
export const DIGITAL_SOURCE_TYPE = 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia'
// 本站自定义命名空间：生成 id 和验证页地址
const AIVIDEO_NS = 'urn:shrimpreel:ai-video:1.0:'
const BOM = String.fromCharCode(0xfeff)

// 生成 id（createId 的输出）；验证接口和浏览器解析出来的值都按它校验，避免把任意字符串带进查询
export const GENERATION_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/

export interface XmpFields {
  generationId: string
  brand: string
  // 视频模型名（站点配置）与服务商 id
  model: string
  provider: string
  createdAt: string
  verifyUrl: string
}

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function unescapeXml(value: string) {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

// 不写入任何用户信息：只有站点品牌、模型、创建时间和生成 id
export function buildXmpPacket(fields: XmpFields) {
  const tool = `${fields.brand} (${fields.model} via ${fields.provider})`
  const description = `AI-generated video created with ${fields.brand}. Verify: ${fields.verifyUrl}`
  return [
    `<?xpacket begin="${BOM}" id="W5M0MpCehiHzreSzNTczkc9d"?>`,
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '  <rdf:Description rdf:about=""',
    '   xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"',
    '   xmlns:dc="http://purl.org/dc/elements/1.1/"',
    '   xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
    '   xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"',
    `   xmlns:aivideo="${AIVIDEO_NS}">`,
    `   <Iptc4xmpExt:DigitalSourceType>${DIGITAL_SOURCE_TYPE}</Iptc4xmpExt:DigitalSourceType>`,
    `   <xmp:CreatorTool>${escapeXml(tool)}</xmp:CreatorTool>`,
    `   <xmp:CreateDate>${escapeXml(fields.createdAt)}</xmp:CreateDate>`,
    `   <xmpMM:DocumentID>xmp.did:${escapeXml(fields.generationId)}</xmpMM:DocumentID>`,
    `   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(description)}</rdf:li></rdf:Alt></dc:description>`,
    `   <aivideo:GenerationId>${escapeXml(fields.generationId)}</aivideo:GenerationId>`,
    `   <aivideo:VerifyUrl>${escapeXml(fields.verifyUrl)}</aivideo:VerifyUrl>`,
    '  </rdf:Description>',
    ' </rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('\n')
}

export interface XmpAiInfo {
  generationId: string
  digitalSourceType: string | null
}

function tagText(xml: string, tag: string) {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))
  return match ? unescapeXml(match[1]!.trim()) : null
}

// 从 XMP 包里读出生成 id；不是本站格式（没有合法的 id）返回 null
export function parseXmpAiInfo(xml: string): XmpAiInfo | null {
  const generationId = tagText(xml, 'aivideo:GenerationId')
  if (!generationId || !GENERATION_ID_PATTERN.test(generationId)) return null
  return { generationId, digitalSourceType: tagText(xml, 'Iptc4xmpExt:DigitalSourceType') }
}

// size(4) + 'uuid' + 16 字节 usertype + XMP 包
export function buildXmpBox(packet: string): Uint8Array {
  const payload = new TextEncoder().encode(packet)
  const size = 8 + 16 + payload.length
  const box = new Uint8Array(size)
  new DataView(box.buffer).setUint32(0, size)
  box.set([0x75, 0x75, 0x69, 0x64], 4)
  box.set(XMP_UUID_BYTES, 8)
  box.set(payload, 24)
  return box
}

// ---------- MP4 顶层 box 遍历 ----------

export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>

export interface Mp4Box {
  type: string
  start: number
  size: number
  headerSize: number
  // size 字段为 0：box 一直延伸到文件尾，后面不能再追加内容
  extendsToEnd: boolean
  // uuid box 的 16 字节 usertype（小写十六进制），其他类型为 null
  usertype: string | null
}

export type ScanResult = { ok: true; boxes: Mp4Box[] } | { ok: false; reason: 'invalid' | 'too_many'; boxes: Mp4Box[] }

const MAX_TOP_LEVEL_BOXES = 5000

// 只读每个 box 的头（最多 32 字节），不读 box 内容：成片在 R2 里时每个 box 一次 range 读取，在浏览器里是 Blob.slice
export async function scanTopLevelBoxes(read: RangeReader, totalSize: number, maxBoxes = MAX_TOP_LEVEL_BOXES): Promise<ScanResult> {
  const boxes: Mp4Box[] = []
  let offset = 0
  while (offset < totalSize) {
    if (boxes.length >= maxBoxes) return { ok: false, reason: 'too_many', boxes }
    const bytes = await read(offset, Math.min(32, totalSize - offset))
    if (bytes.length < 8) return { ok: false, reason: 'invalid', boxes }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const type = String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!)
    let size = view.getUint32(0)
    let headerSize = 8
    let extendsToEnd = false
    if (size === 0) {
      extendsToEnd = true
      size = totalSize - offset
    } else if (size === 1) {
      if (bytes.length < 16) return { ok: false, reason: 'invalid', boxes }
      size = view.getUint32(8) * 2 ** 32 + view.getUint32(12)
      headerSize = 16
    }
    if (!Number.isSafeInteger(size) || size < headerSize || offset + size > totalSize) return { ok: false, reason: 'invalid', boxes }
    let usertype: string | null = null
    if (type === 'uuid' && size >= headerSize + 16 && bytes.length >= headerSize + 16) {
      usertype = Array.from(bytes.subarray(headerSize, headerSize + 16), (b) => b.toString(16).padStart(2, '0')).join('')
    }
    boxes.push({ type, start: offset, size, headerSize, extendsToEnd, usertype })
    offset += size
  }
  return { ok: true, boxes }
}

export function findXmpBox(boxes: readonly Mp4Box[]) {
  return boxes.find((box) => box.type === 'uuid' && box.usertype === XMP_UUID_HEX) ?? null
}

// 服务端追加前的判断：已经有 XMP box → 不重复追加；结构完整且最后一个 box 有明确长度 → 可以追加；其余一律跳过
export type XmpInspection =
  | { kind: 'has_xmp'; box: Mp4Box }
  | { kind: 'appendable' }
  | { kind: 'unsupported'; reason: 'invalid' | 'too_many' | 'not_mp4' | 'open_ended' }

export async function inspectForXmp(read: RangeReader, totalSize: number): Promise<XmpInspection> {
  const scan = await scanTopLevelBoxes(read, totalSize)
  if (!scan.ok) return { kind: 'unsupported', reason: scan.reason }
  const existing = findXmpBox(scan.boxes)
  if (existing) return { kind: 'has_xmp', box: existing }
  if (scan.boxes[0]?.type !== 'ftyp') return { kind: 'unsupported', reason: 'not_mp4' }
  if (scan.boxes.at(-1)!.extendsToEnd) return { kind: 'unsupported', reason: 'open_ended' }
  return { kind: 'appendable' }
}

// XMP 包通常只有 1 KB 左右；超过上限当作没有，避免把大块内容读进浏览器内存
const MAX_XMP_BYTES = 256 * 1024

export async function readXmpPacket(read: RangeReader, box: Mp4Box): Promise<string | null> {
  const offset = box.start + box.headerSize + 16
  const length = box.size - box.headerSize - 16
  if (length <= 0 || length > MAX_XMP_BYTES) return null
  return new TextDecoder().decode(await read(offset, length))
}

// 验证页用：从本地视频文件里找 XMP box 并读出文本，文件不上传
export async function readXmpFromBlob(blob: Blob): Promise<string | null> {
  const read: RangeReader = async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())
  const scan = await scanTopLevelBoxes(read, blob.size)
  // 遍历中途遇到坏 box 时，之前已经扫到的部分仍然可能含有标记
  const box = findXmpBox(scan.boxes)
  return box ? readXmpPacket(read, box) : null
}
