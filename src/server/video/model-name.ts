import { site } from '#/config/site'

// 成片元数据和验证页展示的模型名（站点配置里的模型；mock 返回 'mock'）
export function videoModelName(provider: string) {
  if (provider === 'fal') return site.video.falModel
  if (provider === 'yir') return site.video.yir.model
  if (provider === 'nanoapi') return site.video.nanoapi.model
  return provider
}
