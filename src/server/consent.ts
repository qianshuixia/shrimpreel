import { DEFAULT_LOCALE, isLocale, site } from '#/config/site'

// 生成前的同意文案原文：按请求语言在服务端取，不信任客户端传来的文案
export async function consentText(locale: unknown) {
  const lang = typeof locale === 'string' && isLocale(locale) ? locale : DEFAULT_LOCALE
  const content = lang === 'zh' ? (await import('#/content/zh')).zh(site) : (await import('#/content/en')).en(site)
  return content.generator.consent
}
