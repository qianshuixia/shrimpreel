import { describe, expect, it } from 'vitest'
import { activePaymentProviderId } from '#/server/payments'
import { defaultStyle } from '#/config/site'
import { createFalProvider } from '#/server/video/fal'
import { activeVideoProviderId, videoProviderIdForStyle } from '#/server/video'

// mock 支付/生成在生产环境必须不可用，否则任何人都能免费充值
describe('provider 选择', () => {
  const env = (vars: Record<string, string>) => vars as unknown as Env

  it('非生产环境允许 mock', () => {
    expect(activePaymentProviderId(env({ APP_ENV: 'development', PAYMENT_PROVIDER: 'mock' }))).toBe('mock')
    expect(activeVideoProviderId(env({ APP_ENV: 'preview', VIDEO_PROVIDER: 'mock' }))).toBe('mock')
  })

  it('生产环境和 staging 拒绝 mock，未知 provider 也拒绝', () => {
    expect(() => activePaymentProviderId(env({ APP_ENV: 'production', PAYMENT_PROVIDER: 'mock' }))).toThrow(/PAYMENT_PROVIDER/)
    expect(() => activeVideoProviderId(env({ APP_ENV: 'production', VIDEO_PROVIDER: 'mock' }))).toThrow(/VIDEO_PROVIDER/)
    // staging 部署在公开的 workers.dev 上，mock 支付等于免费充值
    expect(() => activePaymentProviderId(env({ APP_ENV: 'staging', PAYMENT_PROVIDER: 'mock' }))).toThrow(/PAYMENT_PROVIDER/)
    expect(() => activePaymentProviderId(env({ APP_ENV: 'development', PAYMENT_PROVIDER: 'creem' }))).toThrow()
  })

  it('生产环境正常选择 waffo / dodo / fal / yir / nanoapi', () => {
    expect(activePaymentProviderId(env({ APP_ENV: 'production', PAYMENT_PROVIDER: 'waffo' }))).toBe('waffo')
    expect(activePaymentProviderId(env({ APP_ENV: 'production', PAYMENT_PROVIDER: 'dodo' }))).toBe('dodo')
    expect(activeVideoProviderId(env({ APP_ENV: 'production', VIDEO_PROVIDER: 'fal' }))).toBe('fal')
    expect(activeVideoProviderId(env({ APP_ENV: 'production', VIDEO_PROVIDER: 'yir' }))).toBe('yir')
    expect(activeVideoProviderId(env({ APP_ENV: 'production', VIDEO_PROVIDER: 'nanoapi' }))).toBe('nanoapi')
  })
})

describe('videoProviderIdForStyle', () => {
  const env = (vars: Record<string, string>) => vars as unknown as Env
  const style = (provider?: 'fal' | 'yir' | 'nanoapi') => ({ ...defaultStyle, provider })

  it('风格指定的 provider 覆盖 VIDEO_PROVIDER，没指定就用 VIDEO_PROVIDER', () => {
    expect(videoProviderIdForStyle(env({ APP_ENV: 'production', VIDEO_PROVIDER: 'fal' }), style('nanoapi'))).toBe('nanoapi')
    expect(videoProviderIdForStyle(env({ APP_ENV: 'production', VIDEO_PROVIDER: 'fal' }), style())).toBe('fal')
  })

  it('mock 压过一切（本地和 e2e 里双人风格也能跑通）；生产环境配成 mock 仍然报错', () => {
    expect(videoProviderIdForStyle(env({ APP_ENV: 'development', VIDEO_PROVIDER: 'mock' }), style('nanoapi'))).toBe('mock')
    expect(() => videoProviderIdForStyle(env({ APP_ENV: 'production', VIDEO_PROVIDER: 'mock' }), style('nanoapi'))).toThrow(/VIDEO_PROVIDER/)
  })
})

describe('fal 多张照片', () => {
  it('fal 只收一张照片：两张时不可重试地失败', async () => {
    const provider = createFalProvider({ FAL_KEY: 'k' } as unknown as Env)
    const input = { generationId: 'g', style: defaultStyle, durationSeconds: 6, imageUrls: ['https://a/1', 'https://a/2'], sourceVideoUrl: 'https://a/v', sourceVideoKey: 'k', webhookUrl: 'https://a/w', meta: {} }
    await expect(provider.submit(input)).rejects.toMatchObject({ code: 'multi_photo_unsupported', retryable: false })
  })
})
