import { muxMusic } from '#/lib/music-mux'

// 'mixed'：已把风格的背景音乐混进成片；'skipped'：任何原因没混成（已 warn / error），成片保持原样
export type MusicResult = 'mixed' | 'skipped'

// mediabunny 使用 fastStart: 'in-memory' 时峰值内存约为输入视频的 3 倍；
// 收紧混流上限至 20 MB（3 × 20 MB ≈ 60 MB），确保 128 MB Isolate 不触发 Error 1102 OOM 崩溃重试
export const MAX_MUX_VIDEO_BYTES = 20 * 1024 * 1024

// 直接对内存中的成片字节混入风格背景音乐（单次写入管线调用，省去多余的 R2 读写）；
// 超过 MAX_MUX_VIDEO_BYTES 或任何混流失败均原样退回原视频，不抛错
export async function muxStyleMusicBytes(
  bucket: R2Bucket,
  video: Uint8Array,
  musicFile: string,
  generationId: string,
): Promise<{ bytes: Uint8Array; result: MusicResult }> {
  const skip = (reason: string): { bytes: Uint8Array; result: MusicResult } => {
    console.warn('output music skipped', { generationId, reason })
    return { bytes: video, result: 'skipped' }
  }
  if (video.byteLength > MAX_MUX_VIDEO_BYTES) return skip('too_large')

  const musicObject = await bucket.get(`templates/${musicFile}`)
  if (!musicObject || !('body' in musicObject)) {
    console.error('output music file missing from R2', { generationId, file: musicFile })
    return { bytes: video, result: 'skipped' }
  }
  const music = new Uint8Array(await musicObject.arrayBuffer())

  try {
    return { bytes: await muxMusic(video, music), result: 'mixed' }
  } catch (error) {
    console.warn('output music skipped', { generationId, reason: 'mux_failed', error: error instanceof Error ? error.message : String(error) })
    return { bytes: video, result: 'skipped' }
  }
}

// 给已存进 R2 的成片换上风格的背景音乐（模板里 templates/<musicFile>，AAC）。
// 和 tagOutputWithXmp 一样，读写都带 etag 条件，期间被别的路径改写就放弃。
// 背景音乐只是附加功能：任何失败都不抛错，不让生成失败、不退积分。
export async function addStyleMusic(bucket: R2Bucket, outputKey: string, musicFile: string, generationId: string): Promise<MusicResult> {
  const skip = (reason: string): MusicResult => {
    console.warn('output music skipped', { generationId, reason })
    return 'skipped'
  }
  const head = await bucket.head(outputKey)
  if (!head) return skip('output_missing')
  if (head.size > MAX_MUX_VIDEO_BYTES) return skip('too_large')

  const source = await bucket.get(outputKey, { onlyIf: { etagMatches: head.etag } })
  if (!source || !('body' in source)) return skip('changed')
  const video = new Uint8Array(await source.arrayBuffer())

  const { bytes: mixed, result } = await muxStyleMusicBytes(bucket, video, musicFile, generationId)
  if (result !== 'mixed') return 'skipped'

  const stored = await bucket.put(outputKey, mixed, {
    httpMetadata: source.httpMetadata,
    customMetadata: source.customMetadata,
    onlyIf: { etagMatches: head.etag },
  })
  if (!stored) return skip('changed')
  return 'mixed'
}
