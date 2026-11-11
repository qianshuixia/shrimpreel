import { Hono } from 'hono'
import { ARTICLES, DEFAULT_LOCALE, LOCALES, STYLES, formatPrice, localePath, sellingPlans, site, stylePhotoCount } from '#/config/site'
import type { Style, StyleDuration } from '#/config/site'
import { absoluteUrl, loadContent } from '#/lib/i18n'
import type { AppContext } from './types'
import { isIndexable } from './util'

export const seoRoutes = new Hono<AppContext>()

// IndexNow 验证文件：site.seo.indexNowKey 非空时在 /<key>.txt 返回 key 本身（npm run seo:indexnow 用它提交 URL）
const INDEXNOW_PATH = site.seo.indexNowKey ? `/${site.seo.indexNowKey}.txt` : null

// server.ts 用它决定交给 Hono 还是 TanStack
export function isSeoPath(pathname: string) {
  return pathname === '/sitemap.xml' || pathname === '/robots.txt' || pathname === '/llms.txt' || pathname === INDEXNOW_PATH
}

const ARTICLE_PATHS = ARTICLES.map((article) => `/${article.slug}`)

// 可被索引的公开页面（账户、结账、后台页都带 noindex，不进 sitemap）
export const PUBLIC_PATHS = ['/', '/pricing', '/guides', '/contact', '/report', ...(site.aiMetadata.enabled ? ['/verify'] : []), '/privacy-policy', '/terms-of-service', '/refund-policy', ...ARTICLE_PATHS]

// lastmod 按页面取：文章用各自的 updatedAt，/guides 随最新文章变化，其余页面用 site.seo.updatedAt
function lastModified(path: string) {
  const article = ARTICLES.find((a) => `/${a.slug}` === path)
  if (article) return article.updatedAt
  if (path === '/guides') return [site.seo.updatedAt, ...ARTICLES.map((a) => a.updatedAt)].sort().at(-1)!
  return site.seo.updatedAt
}

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// URL 与页面 canonical 同源（site.domain），避免 sitemap 与 canonical 不一致
seoRoutes.get('/sitemap.xml', (c) => {
  const urls = PUBLIC_PATHS.flatMap((path) =>
    LOCALES.map((locale) => {
      const alternates = [
        ...LOCALES.map((alt) => `<xhtml:link rel="alternate" hreflang="${alt}" href="${escapeXml(absoluteUrl(localePath(alt, path)))}"/>`),
        `<xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(absoluteUrl(localePath(DEFAULT_LOCALE, path)))}"/>`,
      ].join('')
      return `<url><loc>${escapeXml(absoluteUrl(localePath(locale, path)))}</loc><lastmod>${lastModified(path)}</lastmod>${alternates}</url>`
    }),
  )
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join('\n')}
</urlset>`
  return c.body(xml, 200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' })
})

if (INDEXNOW_PATH) {
  seoRoutes.get(INDEXNOW_PATH, (c) => c.text(site.seo.indexNowKey, 200, { 'Cache-Control': 'public, max-age=86400' }))
}

// 只有正式站（APP_ENV=production）允许抓取；staging 和本地整体禁止，避免与正式站重复收录
seoRoutes.get('/robots.txt', (c) => {
  const body = isIndexable(c.env)
    ? [
        'User-agent: *',
        'Allow: /',
        'Disallow: /api/',
        'Disallow: /admin',
        ...LOCALES.map((locale) => `Disallow: ${localePath(locale, '/checkout/')}`),
        '',
        `Sitemap: ${absoluteUrl('/sitemap.xml')}`,
      ].join('\n')
    : ['User-agent: *', 'Disallow: /'].join('\n')
  return c.text(`${body}\n`, 200, { 'Cache-Control': 'public, max-age=3600' })
})

// llms.txt（https://llmstxt.org/）：给 AI 搜索引用本站的摘要。内容全部由 site 配置和英文文案生成，
// 事实句只写配置里确实有的字段，避免 AI 把时长、价格、方向说错；配置推不出来的由站点写在 site.seo.llmsFacts
seoRoutes.get('/llms.txt', async (c) => {
  const en = await loadContent('en')
  const link = (title: string, path: string, note?: string) => `- [${title}](${absoluteUrl(path)})${note ? `: ${note}` : ''}`
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const { upload, retention } = site

  const styleName = (style: Style) => en.styles[style.id as keyof typeof en.styles].name
  const styleNames = STYLES.map(styleName)
  const durationText = (list: readonly StyleDuration[]) => list.map((d) => `${d.seconds}-second clip: ${plural(d.credits, 'credit')}`).join('; ')
  // 风格自己配了 durations 的单独列价格，其余风格共用 site.durations；都没配时和以前一样只写一句
  const ownDurationStyles = STYLES.filter((style) => style.durations)
  const sharedDurationStyles = STYLES.filter((style) => !style.durations)
  const lengths =
    ownDurationStyles.length === 0
      ? `available lengths and cost: ${durationText(site.durations)}`
      : `lengths and cost: ${[
          ...(sharedDurationStyles.length > 0 ? [`${sharedDurationStyles.map(styleName).join(', ')}: ${durationText(site.durations)}`] : []),
          ...ownDurationStyles.map((style) => `${styleName(style)}: ${durationText(style.durations!)}`),
        ].join('. ')}`
  const duoNames = STYLES.filter((style) => stylePhotoCount(style) === 2).map(styleName)
  const packs = site.packages.map((p) => `${plural(p.credits, 'credit')} for ${formatPrice(p.priceCents, p.currency)}`)
  const formats = upload.contentTypes.map((type) => type.replace('image/', '').toUpperCase())
  const musicStyles = STYLES.filter((style) => style.music).map((style) => en.styles[style.id as keyof typeof en.styles].name)
  const facts = [
    `Input: one photo (${formats.join(', ')}, up to ${Math.round(upload.maxBytes / 1024 / 1024)} MB)${
      duoNames.length > 0 ? `; the ${duoNames.join(', ')} style${duoNames.length === 1 ? ' takes' : 's take'} two photos, one per person (the first is the dancer on the left)` : ''
    }.`,
    `Style${styleNames.length === 1 ? '' : 's'}: ${styleNames.join(', ')}.`,
    `Output: a vertical ${site.template.aspectRatio} video; ${lengths}.`,
    ...(musicStyles.length === 0
      ? []
      : musicStyles.length === STYLES.length
        ? [STYLES.length === 1 ? 'Videos come with a background music track.' : 'Each style comes with its own background music track.']
        : [`Videos in the ${musicStyles.join(', ')} style${musicStyles.length === 1 ? '' : 's'} come with a background music track.`]),
    `Downloads are MP4 files without a visible watermark${site.aiMetadata.enabled ? '; each video carries a machine-readable AI label (XMP metadata)' : ''}.`,
    `Credit packs (one-time purchase, credits from packs never expire): ${packs.join('; ')}.`,
    ...(sellingPlans.length > 0
      ? [`Subscriptions: ${sellingPlans.map((p) => `${formatPrice(p.priceCents, p.currency)} per ${p.interval} for ${plural(p.credits, 'credit')} each month`).join('; ')}.`]
      : []),
    'If a render fails, the credits are refunded automatically.',
    retention.outputDays > 0 ? `Finished videos are kept for ${retention.outputDays} days.` : 'Finished videos are kept until the user deletes them.',
    'An account is required; users sign in with Google.',
    ...site.seo.llmsFacts,
  ]

  const lines = [
    `# ${site.brandName}`,
    '',
    `> ${en.meta.homeDescription}`,
    '',
    '## Key facts',
    '',
    ...facts.map((fact) => `- ${fact}`),
    '',
    '## Pages',
    '',
    link(en.meta.homeTitle, '/', en.meta.homeDescription),
    link(en.meta.pricingTitle, '/pricing', en.meta.pricingDescription),
    link(en.guides.metaTitle, '/guides', en.guides.description),
    '',
    '## Guides',
    '',
    ...ARTICLES.map((article) => link(en.articles[article.key].title, `/${article.slug}`, en.articles[article.key].description)),
    '',
    '## Optional',
    '',
    ...LOCALES.filter((locale) => locale !== DEFAULT_LOCALE).map((locale) => link(`Home (${locale})`, localePath(locale, '/'))),
    link(en.legal.terms.title, '/terms-of-service'),
    link(en.legal.privacy.title, '/privacy-policy'),
    link(en.legal.refund.title, '/refund-policy'),
    `- Contact: ${site.supportEmail}`,
  ]
  return c.body(`${lines.join('\n')}\n`, 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' })
})
