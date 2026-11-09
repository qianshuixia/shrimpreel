// 上传前在浏览器里检查、整理照片（生成器和手机传图页共用）：
// ① 尺寸检查：短边 < site.upload.minSide 或长边 ÷ 短边 > site.upload.maxRatio（视频模型不收这种参考图，见 site.ts 的说明）
//    → 返回 problem，直接提示用户换一张，不上传、不花积分；不自动补边或裁切，免得裁掉脸
// ② 缩小：手机原图常有 7–9 MB，上传接口要解析表单、算哈希、转 base64 送审核，Workers 免费计划的 CPU 上限扛不住，
//    请求以 exceededCpu 结束（503）。换脸只看脸，长边 2048 px 的 JPEG 足够，体积一般几百 KB
// 浏览器解不开的格式（老浏览器、部分 HEIC）不拦，原样上传，交给上传接口判
import { site } from '#/config/site'

const MAX_SIDE = 2048
const SKIP_BELOW_BYTES = 1_500_000
const QUALITY = 0.9

export type PhotoProblem = 'photo_too_small' | 'photo_bad_ratio'

// 纯计算；上传接口（src/server/media.ts 的 imageProblem）用同一套阈值
export function photoProblem(width: number, height: number): PhotoProblem | null {
  const short = Math.min(width, height)
  if (short < site.upload.minSide) return 'photo_too_small'
  if (Math.max(width, height) / Math.max(1, short) > site.upload.maxRatio) return 'photo_bad_ratio'
  return null
}

// 检查 + 需要时缩小。有 problem 时别上传，把它当错误码显示
export async function preparePhoto(file: File): Promise<{ file: File; problem: PhotoProblem | null }> {
  if (!file.type.startsWith('image/') || typeof createImageBitmap !== 'function') return { file, problem: null }
  let bitmap: ImageBitmap | null = null
  try {
    // from-image：按 EXIF 方向摆正（手机竖拍的照片不会变横）
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const problem = photoProblem(bitmap.width, bitmap.height)
    if (problem) return { file, problem }
    if (file.size <= SKIP_BELOW_BYTES && Math.max(bitmap.width, bitmap.height) <= MAX_SIDE) return { file, problem: null }
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
    const blob = await drawToJpeg(bitmap, Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)))
    if (!blob || blob.size >= file.size) return { file, problem: null }
    const name = `${file.name.replace(/\.[^.]+$/, '') || 'photo'}.jpg`
    return { file: new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified }), problem: null }
  } catch {
    return { file, problem: null }
  } finally {
    bitmap?.close()
  }
}

// JPEG 没有透明通道：透明 PNG 直接画上去，透明像素会变成黑色，所以先铺一层白底
function paint(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, bitmap: ImageBitmap, width: number, height: number) {
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)
}

async function drawToJpeg(bitmap: ImageBitmap, width: number, height: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    paint(ctx, bitmap, width, height)
    return canvas.convertToBlob({ type: 'image/jpeg', quality: QUALITY })
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  paint(ctx, bitmap, width, height)
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY))
}
