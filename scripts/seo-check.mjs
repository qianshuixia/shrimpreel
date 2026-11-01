#!/usr/bin/env node
// SEO 自检：抓取正在运行的站点（默认本地 dev），检查 SSR 输出的基础 SEO 是否齐全。
// 用法：
//   npm run seo:check                                   # 检查 http://127.0.0.1:3000
//   npm run seo:check -- --base https://your-domain.com --production   # 上线后检查正式站
// 页面列表取自 /sitemap.xml，规则取自 src/config/site.ts。有 error 时退出码为 1。
// 报告写入 .tmp/seo-check/report.md 与 report.json（--out 可改目录）。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ARTICLES, DEFAULT_LOCALE, LOCALES, site } from '../src/config/site.ts'

const REQUIRED_JSONLD = {
  home: ['Organization', 'WebSite', 'SoftwareApplication', 'FAQPage'],
  article: ['Article', 'BreadcrumbList'],
  guides: ['BreadcrumbList'],
}
// Google 结果页标题约 600px、描述约 920px；按"半角=1、全角=2"估算宽度
const TITLE_MAX = 60
const TITLE_MIN = 15
const DESC_MAX = 160
const DESC_MIN = 70

function displayWidth(text) {
  let width = 0
  for (const ch of text) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1
  return width
}

function decode(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'))
  return match ? decode(match[1]) : null
}

function metaContent(html, key, value) {
  for (const [tag] of html.matchAll(/<meta\s[^>]*>/gi)) {
    if (attr(tag, key) === value) return attr(tag, 'content')
  }
  return null
}

function visibleText(html) {
  return decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

function innerText(fragment) {
  return decode(fragment.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

function jsonLdTypes(html, report) {
  const types = []
  // 页面上的 script 都带 CSP nonce 等属性，不能按固定写法匹配
  for (const [, body] of html.matchAll(/<script\b[^>]*\btype="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(body)
      for (const node of data['@graph'] ?? [data]) types.push(node['@type'])
    } catch (error) {
      report('error', 'JSON-LD 无法解析', String(error))
    }
  }
  return types
}

function pageKind(path) {
  const rest = LOCALES.filter((l) => l !== DEFAULT_LOCALE).reduce((p, l) => (p === `/${l}` ? '/' : p.replace(new RegExp(`^/${l}/`), '/')), path)
  if (rest === '/') return 'home'
  if (rest === '/guides') return 'guides'
  if (ARTICLES.some((article) => rest === `/${article.slug}`)) return 'article'
  return 'page'
}

async function fetchText(url, init) {
  const response = await fetch(url, { redirect: 'manual', ...init })
  return { response, text: await response.text() }
}

export async function runSeoCheck({ base = 'http://127.0.0.1:3000', production = false } = {}) {
  base = base.replace(/\/+$/, '')
  const findings = []
  const pages = []
  const add = (where) => (level, check, detail = '') => findings.push({ level, where, check, detail })

  // 1. 配置
  const cfg = add('config')
  if (!site.domain || site.domain === 'example.com' || site.domain.includes('localhost')) {
    cfg(production ? 'error' : 'warn', 'site.domain 仍是占位域名', `当前为 "${site.domain}"，canonical/sitemap/hreflang 都会指向它`)
  }
  const today = new Date().toISOString().slice(0, 10)
  const checkDates = (label, dates) => {
    for (const key of ['publishedAt', 'updatedAt']) {
      const value = dates[key]
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) cfg('error', `${label}.${key} 不是 YYYY-MM-DD`, value)
      else if (value > today) cfg('warn', `${label}.${key} 晚于今天`, value)
    }
    if (dates.updatedAt < dates.publishedAt) cfg('error', `${label}.updatedAt 早于 publishedAt`)
  }
  checkDates('site.seo', site.seo)
  const reservedSlugs = new Set(['guides', 'pricing', 'contact', 'report', 'verify', 'privacy-policy', 'terms-of-service', 'refund-policy', 'sign-in', 'dashboard', 'checkout', 'admin', 'api', ...LOCALES])
  const seenSlugs = new Set()
  for (const article of ARTICLES) {
    const label = `site.articles[${article.key}]`
    checkDates(label, article)
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(article.slug)) cfg('error', `${label}.slug 只能用小写字母、数字和连字符`, article.slug)
    if (reservedSlugs.has(article.slug)) cfg('error', `${label}.slug 与站内路由冲突`, article.slug)
    if (seenSlugs.has(article.slug)) cfg('error', `${label}.slug 重复`, article.slug)
    seenSlugs.add(article.slug)
  }
  if (production && !site.seo.googleVerification) cfg('warn', '未配置 site.seo.googleVerification', '也可以用 DNS 方式在 Search Console 验证')

  // 2. sitemap → 页面列表
  const sm = add('/sitemap.xml')
  const sitemap = await fetchText(`${base}/sitemap.xml`)
  const origin = `https://${site.domain}`
  let paths = []
  if (sitemap.response.status !== 200) {
    sm('error', 'sitemap.xml 不可访问', `HTTP ${sitemap.response.status}`)
  } else {
    const urls = [...sitemap.text.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1])
    for (const url of urls) {
      const loc = decode(url.match(/<loc>([^<]*)<\/loc>/)?.[1] ?? '')
      if (!loc.startsWith(origin)) sm('error', 'sitemap 的 loc 不在 site.domain 下', loc)
      if (!/<lastmod>\d{4}-\d{2}-\d{2}/.test(url)) sm('warn', 'sitemap 条目缺少 lastmod', loc)
      paths.push(loc.slice(origin.length) || '/')
    }
    for (const locale of LOCALES) {
      const home = locale === DEFAULT_LOCALE ? '/' : `/${locale}`
      if (!paths.includes(home)) sm('error', 'sitemap 缺少首页', home)
    }
    for (const article of ARTICLES) {
      if (!paths.includes(`/${article.slug}`)) sm('error', 'sitemap 缺少文章', `/${article.slug}`)
    }
    if (!paths.includes('/guides')) sm('error', 'sitemap 缺少文章列表页', '/guides')
  }

  // 3. 逐页检查 SSR 输出（不执行 JS，等同搜索引擎首次抓取看到的 HTML）
  for (const path of paths) {
    const report = add(path)
    const { response, text: html } = await fetchText(`${base}${path}`)
    if (response.status !== 200) {
      report('error', '页面状态码不是 200', `HTTP ${response.status}`)
      continue
    }
    const kind = pageKind(path)
    const expectedCanonical = `${origin}${path === '/' ? '' : path}`
    const title = decode(html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '')
    const description = metaContent(html, 'name', 'description') ?? ''
    const h1s = [...html.matchAll(/<h1[\s>][\s\S]*?<\/h1>/gi)].map((m) => innerText(m[0]))
    const h2s = [...html.matchAll(/<h2[\s>][\s\S]*?<\/h2>/gi)].map((m) => innerText(m[0]))
    const linkTags = [...html.matchAll(/<link\s[^>]*>/gi)].map((m) => m[0])
    const canonical = linkTags.filter((tag) => attr(tag, 'rel') === 'canonical').map((tag) => attr(tag, 'href'))
    const hreflangs = linkTags.filter((tag) => attr(tag, 'rel') === 'alternate' && attr(tag, 'hreflang')).map((tag) => attr(tag, 'hreflang'))
    const robots = metaContent(html, 'name', 'robots') ?? ''
    const types = jsonLdTypes(html, report)
    const text = visibleText(html)
    const keyword = site.keyword.toLowerCase()

    pages.push({ path, kind, title, titleWidth: displayWidth(title), descriptionWidth: displayWidth(description), h1: h1s, h2: h2s, canonical: canonical[0] ?? null, hreflang: hreflangs, jsonLd: types })

    if (!/<html[^>]*\slang="[^"]+"/i.test(html)) report('error', '<html> 缺少 lang')
    if (!title) report('error', '缺少 <title>')
    else if (displayWidth(title) > TITLE_MAX) report('warn', `标题过长（>${TITLE_MAX}），搜索结果会被截断`, `${displayWidth(title)}: ${title}`)
    else if (displayWidth(title) < TITLE_MIN) report('warn', '标题过短', title)
    if (kind === 'home' && !title.toLowerCase().includes(keyword)) report('error', '首页标题不含主关键词', title)
    if (kind === 'article' && !title.toLowerCase().includes(keyword)) report('warn', '文章标题不含主关键词', title)
    if (!description) report('error', '缺少 meta description')
    else if (displayWidth(description) > DESC_MAX) report('warn', `描述过长（>${DESC_MAX}）`, `${displayWidth(description)}`)
    else if (displayWidth(description) < DESC_MIN) report('warn', `描述过短（<${DESC_MIN}）`, `${displayWidth(description)}: ${description}`)
    if (kind === 'home' && !description.toLowerCase().includes(keyword)) report('warn', '首页描述不含主关键词')
    if (h1s.length !== 1) report('error', `H1 数量应为 1，实际 ${h1s.length}`, h1s.join(' | '))
    if (kind === 'home' && h1s[0] && !h1s[0].toLowerCase().includes(keyword)) report('error', '首页 H1 不含主关键词', h1s[0])
    if (kind === 'home' && h2s.filter((h) => h.toLowerCase().includes(keyword)).length < 2) report('warn', '首页含关键词的 H2 少于 2 个', h2s.join(' | '))
    if (canonical.length !== 1) report('error', `canonical 数量应为 1，实际 ${canonical.length}`)
    else if (canonical[0] !== expectedCanonical) report('error', 'canonical 与页面 URL 不一致', `${canonical[0]} ≠ ${expectedCanonical}`)
    for (const lang of [...LOCALES, 'x-default']) {
      if (!hreflangs.includes(lang)) report('error', `缺少 hreflang=${lang}`)
    }
    for (const [key, value] of [
      ['property', 'og:title'],
      ['property', 'og:description'],
      ['property', 'og:image'],
      ['property', 'og:url'],
      ['name', 'twitter:card'],
    ]) {
      if (!metaContent(html, key, value)) report('error', `缺少 ${value}`)
    }
    const ogUrl = metaContent(html, 'property', 'og:url')
    if (ogUrl && canonical[0] && ogUrl !== canonical[0]) report('warn', 'og:url 与 canonical 不一致', `${ogUrl} ≠ ${canonical[0]}`)
    if (/noindex/i.test(robots)) report('error', '公开页面带 noindex', robots)
    for (const type of REQUIRED_JSONLD[kind] ?? []) {
      if (!types.includes(type)) report('error', `缺少 JSON-LD ${type}`)
    }
    const imgs = [...html.matchAll(/<img\s[^>]*>/gi)].map((m) => m[0])
    // alt="" 是装饰图的正确写法（旁边已有同样的文字），只报完全没写 alt 的
    const noAlt = imgs.filter((tag) => attr(tag, 'alt') === null)
    if (noAlt.length) report('warn', `${noAlt.length} 张图片缺少 alt`)
    // 内链：/guides 是文章枢纽，必须链到每一篇；首页至少链到 /guides
    if (kind === 'guides') {
      for (const article of ARTICLES) {
        if (!html.includes(`/${article.slug}"`)) report('error', '文章列表页没有链接到文章', article.slug)
      }
    }
    if (kind === 'home') {
      if (!html.includes('/guides"')) report('warn', '首页没有链接到 /guides')
      // 长尾词只在默认语言首页检查（其他语言的写法不同）
      if (path === '/') {
        for (const phrase of site.seo.secondaryKeywords) {
          if (!text.toLowerCase().includes(phrase.toLowerCase())) report('warn', '首页正文未覆盖长尾词', phrase)
        }
      }
    }
  }

  // 4. 站点级行为
  const sitewide = add('site')
  const sample = paths.find((p) => p !== '/') ?? '/pricing'
  const slash = await fetch(`${base}${sample}/?utm_source=seo-check`, { redirect: 'manual' })
  const location = slash.headers.get('location') ?? ''
  if (slash.status !== 301) sitewide('error', '尾斜杠 URL 应 301 到无斜杠版本', `${sample}/ → HTTP ${slash.status}`)
  else if (!location.includes(`${sample}?utm_source=seo-check`)) sitewide('error', '尾斜杠 301 目标不对或丢失查询参数', location)
  const missing = await fetch(`${base}/seo-check-missing-page-${Date.now()}`, { redirect: 'manual' })
  if (missing.status !== 404) sitewide('warn', '不存在的页面没有返回 404（soft 404）', `HTTP ${missing.status}`)
  const robotsTxt = await fetchText(`${base}/robots.txt`)
  if (robotsTxt.response.status !== 200) sitewide('error', 'robots.txt 不可访问', `HTTP ${robotsTxt.response.status}`)
  else if (/^Disallow:\s*\/\s*$/m.test(robotsTxt.text)) sitewide(production ? 'error' : 'info', 'robots.txt 禁止全部抓取', production ? '正式站必须设置 APP_ENV=production' : '非生产环境的预期行为')
  else if (!robotsTxt.text.includes(`${origin}/sitemap.xml`)) sitewide('warn', 'robots.txt 未声明 sitemap')
  const llmsTxt = await fetchText(`${base}/llms.txt`)
  if (llmsTxt.response.status !== 200) sitewide('error', 'llms.txt 不可访问', `HTTP ${llmsTxt.response.status}`)
  else if (!llmsTxt.text.startsWith('# ')) sitewide('error', 'llms.txt 不是以 "# 站点名" 开头', llmsTxt.text.slice(0, 40))
  if (production) {
    const hsts = (await fetch(`${base}/`, { redirect: 'manual' })).headers.get('strict-transport-security')
    if (!hsts) sitewide('warn', '正式站缺少 Strict-Transport-Security')
  }
  if (site.seo.indexNowKey) {
    const key = await fetchText(`${base}/${site.seo.indexNowKey}.txt`)
    if (key.response.status !== 200 || key.text.trim() !== site.seo.indexNowKey) sitewide('error', 'IndexNow key 文件不可访问或内容不符')
  }

  return { base, production, checkedAt: new Date().toISOString(), pages, findings, errors: findings.filter((f) => f.level === 'error').length, warnings: findings.filter((f) => f.level === 'warn').length }
}

function toMarkdown(result) {
  const lines = [
    `# SEO check`,
    '',
    `- 时间：${result.checkedAt}`,
    `- 目标：${result.base}${result.production ? '（production）' : ''}`,
    `- 命令：node scripts/seo-check.mjs --base ${result.base}${result.production ? ' --production' : ''}`,
    `- 结果：${result.errors} error / ${result.warnings} warn / ${result.pages.length} 页`,
    '',
    '## 问题',
    '',
    ...(result.findings.length ? ['| 级别 | 位置 | 检查 | 详情 |', '| --- | --- | --- | --- |', ...result.findings.map((f) => `| ${f.level} | ${f.where} | ${f.check} | ${String(f.detail).replace(/\|/g, '\\|')} |`)] : ['无']),
    '',
    '## 页面',
    '',
    '| 路径 | 标题宽度 | 描述宽度 | H1 | JSON-LD |',
    '| --- | --- | --- | --- | --- |',
    ...result.pages.map((p) => `| ${p.path} | ${p.titleWidth} | ${p.descriptionWidth} | ${p.h1.join(' / ').replace(/\|/g, '\\|')} | ${p.jsonLd.join(', ')} |`),
    '',
  ]
  return lines.join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const value = (name, fallback) => {
    const index = args.indexOf(name)
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback
  }
  const result = await runSeoCheck({ base: value('--base', 'http://127.0.0.1:3000'), production: args.includes('--production') })
  const out = value('--out', join('.tmp', 'seo-check'))
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'report.json'), `${JSON.stringify(result, null, 2)}\n`)
  writeFileSync(join(out, 'report.md'), toMarkdown(result))
  for (const f of result.findings) console.log(`${f.level.padEnd(5)} ${f.where.padEnd(28)} ${f.check}${f.detail ? ` — ${f.detail}` : ''}`)
  console.log(`\n${result.errors} error, ${result.warnings} warn, ${result.pages.length} pages → ${join(out, 'report.md')}`)
  process.exit(result.errors ? 1 : 0)
}
