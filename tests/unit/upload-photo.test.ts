import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { site } from '#/config/site'
import { photoProblem } from '#/lib/prepare-photo'
import { imageProblem, imageSize } from '#/server/media'
import { base64Decode, base64Encode } from '#/server/util'

const file = (p: string) => new Uint8Array(readFileSync(p))

describe('base64Encode 分块转', () => {
  it('和逐字节转的结果一样，跨块边界也对', () => {
    for (const size of [0, 1, 2, 3, 0x8000 - 1, 0x8000, 0x8000 + 1, 100_000]) {
      const bytes = new Uint8Array(size)
      for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 256
      let naive = ''
      for (const b of bytes) naive += String.fromCharCode(b)
      expect(base64Encode(bytes)).toBe(btoa(naive))
      expect(base64Decode(base64Encode(bytes))).toEqual(bytes)
    }
  })

  it('8 MB 1 秒内转完（逐字节拼接在 Worker 上要上千毫秒 CPU）', () => {
    const bytes = new Uint8Array(8 * 1024 * 1024).map((_, i) => i % 251)
    const start = performance.now()
    expect(base64Encode(bytes).length).toBe(Math.ceil(bytes.length / 3) * 4)
    expect(performance.now() - start).toBeLessThan(1000)
  })
})

describe('照片尺寸检查（浏览器 photoProblem / 上传接口 imageProblem 同一套阈值）', () => {
  it.each([
    [1152, 2048, null],
    [600, 1500, null], // 1:2.5 正好能过
    [1500, 600, null],
    [320, 1700, 'photo_bad_ratio'],
    [219, 1162, 'photo_too_small'], // 短边不到 300，先按太小拦
    [540, 1458, 'photo_bad_ratio'], // 1:2.7
    [1500, 500, 'photo_bad_ratio'], // 3:1
    [120, 160, 'photo_too_small'],
    [299, 400, 'photo_too_small'],
    [300, 400, null],
    [site.upload.minSide, site.upload.minSide, null],
  ] as const)('%i×%i → %s', (w, h, expected) => {
    expect(photoProblem(w, h)).toBe(expected)
    expect(imageProblem({ width: w, height: h })).toBe(expected)
  })

  it('读不出尺寸就放行', () => {
    expect(imageProblem(null)).toBeNull()
  })
})

describe('imageSize：只读文件头', () => {
  it('JPEG（SOF 段）', () => {
    expect(imageSize(file('tests/fixtures/sizes/narrow.jpg'), 'image/jpeg')).toEqual({ width: 320, height: 1700 })
    expect(imageSize(file('tests/fixtures/photo.jpg'), 'image/jpeg')).toEqual({ width: 300, height: 400 })
  })

  it('PNG（IHDR）', () => {
    expect(imageSize(file('tests/fixtures/sizes/landscape.png'), 'image/png')).toEqual({ width: 640, height: 480 })
  })

  it('WebP VP8X（扩展格式）', () => {
    const b = new Uint8Array(30)
    b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0)
    b.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8)
    b.set([299 & 0xff, 299 >> 8, 0, 399 & 0xff, 399 >> 8, 0], 24) // 宽 300、高 400，存的是减 1 后的 24 位小端
    expect(imageSize(b, 'image/webp')).toEqual({ width: 300, height: 400 })
  })

  it('截断 / 坏文件不抛错，返回 null', () => {
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]), 'image/jpeg')).toBeNull()
    expect(imageSize(new Uint8Array(10), 'image/png')).toBeNull()
    expect(imageSize(new Uint8Array(12), 'image/webp')).toBeNull()
  })
})
