import { muxMusic } from '#/lib/music-mux'
import { MAX_BUFFERED_OUTPUT_BYTES } from './jobs'

// 'mixed'：已把风格的背景音乐混进成片；'skipped'：任何原因没混成（已 warn / error），成片保持原样
export type MusicResult = 'mixed' | 'skipped'

// 给已存进 R2 的成片换上风格的背景音乐（模板里 templates/<musicFile>，AAC）。
// 和 tagOutputWithXmp 一样，读写都带 etag 条件，期间被别的路径改写就放弃。
// 整个文件要读进内存混流，所以超过 MAX_BUFFERED_OUTPUT_BYTES 的成片直接跳过。
// 背景音乐只是附加功能：任何失败都不抛错，不让生成失败、不退积分。
export async function addStyleMusic(bucket: R2Bucket, outputKey: string, musicFile: string, generationId: string): Promise<MusicResult> {
  const skip = (reason: string): MusicResult => {
    console.warn('output music skipped', { generationId, reason })
    return 'skipped'
  }
  const head = await bucket.head(outputKey)
  if (!head) return skip('output_missing')
  if (head.size > MAX_BUFFERED_OUTPUT_BYTES) return skip('too_large')

  const musicObject = await bucket.get(`templates/${musicFile}`)
  if (!musicObject || !('body' in musicObject)) {
    console.error('output music file missing from R2', { generationId, file: musicFile })
    return 'skipped'
  }
  const music = new Uint8Array(await musicObject.arrayBuffer())

  const source = await bucket.get(outputKey, { onlyIf: { etagMatches: head.etag } })
  if (!source || !('body' in source)) return skip('changed')
  const video = new Uint8Array(await source.arrayBuffer())

  let mixed: Uint8Array
  try {
    mixed = await muxMusic(video, music)
  } catch (error) {
    console.warn('output music skipped', { generationId, reason: 'mux_failed', error: error instanceof Error ? error.message : String(error) })
    return 'skipped'
  }

  const stored = await bucket.put(outputKey, mixed, {
    httpMetadata: source.httpMetadata,
    customMetadata: source.customMetadata,
    onlyIf: { etagMatches: head.etag },
  })
  if (!stored) return skip('changed')
  return 'mixed'
}
