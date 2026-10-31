#!/usr/bin/env node
// 上新词脚手架：在复制出来的新项目里运行，一次改好 site.ts / wrangler.jsonc / package.json 里与词相关的字段，
// 再列出必须人工完成的文案、素材、Cloudflare 资源和支付商品清单。默认只打印计划，加 --write 才写文件。
//
//   node scripts/new-site.mjs --keyword "Moon Hop" --domain moonhop.ai
//   node scripts/new-site.mjs --keyword "Moon Hop" --domain moonhop.ai --keywords "AI dance video,Moon Hop filter" --write
//
// 可选：--brand（默认 "<keyword> AI"）--logo（默认首字母）--slug（默认 keyword 的 kebab-case）
//       --name（Worker 与 D1/R2/Queue 前缀，默认 slug）--email（默认 support@<domain>）
//       --platform（默认不变）--date（站点与文章的 publishedAt/updatedAt，默认今天）
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { site } from '../src/config/site.ts'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback
}
const write = args.includes('--write')

const keyword = arg('keyword')?.trim()
const domain = arg('domain')
  ?.trim()
  .replace(/^https?:\/\//, '')
  .replace(/\/.*$/, '')
  .toLowerCase()
if (!keyword || !domain) {
  console.error('用法：node scripts/new-site.mjs --keyword "Moon Hop" --domain moonhop.ai [--write]')
  process.exit(1)
}
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new Error(`--domain 不像正式域名：${domain}`)

const kebab = (value) =>
  value
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
const slug = arg('slug', kebab(keyword))
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new Error(`slug 只能是小写字母、数字和短横线：${slug}（中文关键词请用 --slug 指定）`)
const name = arg('name', slug)
const brand = arg('brand', `${keyword} AI`)
const logo = arg(
  'logo',
  keyword
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase(),
)
const email = arg('email', `support@${domain}`)
const platform = arg('platform', site.trendPlatform)
const date = arg('date', new Date().toISOString().slice(0, 10))
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date 需为 YYYY-MM-DD：${date}`)
const extraKeywords = (arg('keywords', '') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const secondaryKeywords = [...new Set([`${keyword} AI`, `${keyword} video`, `${keyword} trend`, ...extraKeywords])]
const templateId = `${slug}-v1`
const articles = { trend: `${slug}-ai-trend`, howTo: `how-to-make-${slug}-ai-video` }

const q = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const changes = []

// 每条替换必须恰好命中一次，模板结构变了就直接报错，而不是悄悄漏改
function replaceOnce(source, file, label, pattern, replacement) {
  const matches = source.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))
  if (!matches || matches.length !== 1) throw new Error(`${file}: "${label}" 应命中 1 处，实际 ${matches?.length ?? 0} 处`)
  const next = source.replace(pattern, replacement)
  if (next !== source) changes.push(`${file}  ${label}`)
  return next
}

// ---------- src/config/site.ts ----------
const siteFile = 'src/config/site.ts'
let siteSrc = readFileSync(siteFile, 'utf8')
const topLevel = { keyword, brandName: brand, logoMark: logo, domain, supportEmail: email, trendPlatform: platform }
for (const [key, value] of Object.entries(topLevel)) {
  siteSrc = replaceOnce(siteSrc, siteFile, `${key} = ${value}`, new RegExp(`(\\n  ${key}: )'(?:[^'\\\\]|\\\\.)*'`), `$1${q(value)}`)
}
// 默认风格 id 同时出现在 styles[0].id 和 styles[0].sources 里（多风格站点只换第一个，其余风格按需手改）
const oldTemplateId = site.styles[0].id
if (oldTemplateId !== templateId) {
  const count = siteSrc.split(oldTemplateId).length - 1
  if (count < 2) throw new Error(`${siteFile}: 没找到 styles[0].id "${oldTemplateId}" 及其 sources 源视频`)
  siteSrc = siteSrc.split(oldTemplateId).join(templateId)
  changes.push(`${siteFile}  styles[0].id 与 ${count - 1} 个时长源视频 → ${templateId}`)
}
for (const [key, articleSlug] of Object.entries(articles)) {
  siteSrc = replaceOnce(siteSrc, siteFile, `articles[${key}].slug = ${articleSlug}`, new RegExp(`(\\{ key: '${key}', slug: )'[^']*'`), `$1${q(articleSlug)}`)
}
// 文章日期与站点日期一起重置（新站的文章从上线日算起）
let articleDates = 0
siteSrc = siteSrc.replace(/(\{ key: '\w+', slug: '[^']*', publishedAt: )'[^']*'(, updatedAt: )'[^']*'/g, (_, a, b) => {
  articleDates++
  return `${a}${q(date)}${b}${q(date)}`
})
if (articleDates !== site.articles.length) throw new Error(`${siteFile}: 文章日期应命中 ${site.articles.length} 处，实际 ${articleDates} 处`)
changes.push(`${siteFile}  ${articleDates} 篇文章的 publishedAt/updatedAt = ${date}`)
// 模板自带 trend/howTo 两篇；之后为旧词加的文章不能直接带到新站
const extraArticles = site.articles.filter((a) => !(a.key in articles)).map((a) => a.key)
siteSrc = replaceOnce(
  siteSrc,
  siteFile,
  `seo.secondaryKeywords = ${secondaryKeywords.join(' / ')}`,
  /(\n    secondaryKeywords: )\[[^\]]*\]/,
  `$1[${secondaryKeywords.map(q).join(', ')}]`,
)
for (const key of ['publishedAt', 'updatedAt']) {
  siteSrc = replaceOnce(siteSrc, siteFile, `seo.${key} = ${date}`, new RegExp(`(\\n    ${key}: )'[^']*'`), `$1${q(date)}`)
}
// 以下属于旧站的身份信息，新站必须重新申请
for (const key of ['googleVerification', 'bingVerification', 'indexNowKey', 'ga4Id', 'cfBeaconToken', 'umamiWebsiteId', 'clarityId']) {
  siteSrc = replaceOnce(siteSrc, siteFile, `${key} 清空`, new RegExp(`(\\n    ${key}: )'[^']*'`), `$1''`)
}
siteSrc = replaceOnce(siteSrc, siteFile, 'seo.sameAs 清空', /(\n    sameAs: )\[[^\]]*\]/, '$1[]')

// ---------- wrangler.jsonc ----------
const wranglerFile = 'wrangler.jsonc'
let wrangler = readFileSync(wranglerFile, 'utf8')
const oldName = wrangler.match(/\n  "name": "([^"]+)"/)?.[1]
if (!oldName) throw new Error(`${wranglerFile}: 找不到顶层 name`)
if (oldName !== name) {
  // Worker 名、D1 database_name、R2 bucket、Queue（含 DLQ）都以项目名为前缀
  const count = wrangler.split(`"${oldName}`).length - 1
  wrangler = wrangler.split(`"${oldName}"`).join(`"${name}"`).split(`"${oldName}-`).join(`"${name}-`)
  changes.push(`${wranglerFile}  ${count} 处资源名 ${oldName} → ${name}`)
}
// 资源 id 属于旧站，新站要重新创建
wrangler = wrangler.replace(/("database_id": )"(?!0{8}-)[^"]+"/, (_, p) => {
  changes.push(`${wranglerFile}  database_id 重置为占位值`)
  return `${p}"00000000-0000-0000-0000-000000000000"`
})
wrangler = wrangler.replace(/("binding": "KV", "id": )"(?!0{32})[^"]+"/, (_, p) => {
  changes.push(`${wranglerFile}  KV id 重置为占位值`)
  return `${p}"00000000000000000000000000000000"`
})
// Rate Limiting 的 namespace_id 在同一账号内要唯一：按项目名派生一段，避免多个站点共用计数
const base = 1000 + (parseInt(createHash('sha256').update(name).digest('hex').slice(0, 8), 16) % 8000) * 10
let limiter = 0
const beforeLimiters = wrangler
wrangler = wrangler.replace(/"namespace_id": "\d+"/g, () => `"namespace_id": "${base + ++limiter}"`)
if (wrangler !== beforeLimiters) changes.push(`${wranglerFile}  ${limiter} 个 ratelimit namespace_id → ${base + 1}–${base + limiter}`)
// 交易邮件发件地址用新站域名（域名还要在 Email Service 完成 Onboard，见清单）
wrangler = replaceOnce(wrangler, wranglerFile, `EMAIL_FROM = noreply@${domain}`, /("EMAIL_FROM": )"[^"]*"/, `$1"noreply@${domain}"`)
// 模板自身的 workers.dev 预发配置，资源名属于模板，新站点不能沿用
const stagingFile = 'wrangler.staging.jsonc'
const removeStaging = existsSync(stagingFile)
if (removeStaging) changes.push(`${stagingFile}  删除（模板自身的预发配置）`)

// ---------- package.json ----------
const pkgFile = 'package.json'
let pkg = readFileSync(pkgFile, 'utf8')
pkg = replaceOnce(pkg, pkgFile, `name = ${name}`, /(\n  "name": )"[^"]*"/, `$1"${name}"`)

// ---------- 输出 ----------
console.log(`新站：${brand}（关键词 "${keyword}"）→ https://${domain}\n`)
console.log(changes.length ? changes.map((c) => `  · ${c}`).join('\n') : '  （没有需要修改的字段）')
if (write) {
  writeFileSync(siteFile, siteSrc)
  writeFileSync(wranglerFile, wrangler)
  writeFileSync(pkgFile, pkg)
  if (removeStaging) rmSync(stagingFile)
  console.log('\n已写入。')
} else {
  console.log('\n仅预览，加 --write 写入。')
}

// 文案里写死的旧关键词（应改成 ${k} 变量或重写）
const oldKeyword = site.keyword
const hardcoded = []
if (oldKeyword !== keyword) {
  for (const file of ['src/content/en.ts', 'src/content/zh.ts']) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (line.includes(oldKeyword)) hardcoded.push(`${file}:${i + 1}`)
      })
  }
}
const sourceFiles = Object.values(site.styles[0].sources).map((file) => `seed/templates/${file.split(oldTemplateId).join(templateId)}`)
const missingSources = sourceFiles
  .filter((file) => !existsSync(file))

console.log(`
接下来必须人工完成：
1. 重写趋势专属文案（只换关键词会被判定为模板站）：src/content/en.ts 与 zh.ts 的 hero、whatIs、ideas、faq、guides、articles.trend、articles.howTo。
   首页正文要自然覆盖长尾词：${secondaryKeywords.join('、')}${hardcoded.length ? `\n   写死旧关键词 "${oldKeyword}" 的行：${hardcoded.join(', ')}` : ''}${extraArticles.length ? `\n   旧站的其他文章（${extraArticles.join('、')}）：重写，或从 site.articles 和两份文案里删掉` : ''}
2. 换素材：public/demo/*（自有或已授权，并在 site.styles[].examples.*.credit 写来源）、public/og.png（1200×630）、public/favicon.svg。
   文章封面（site.articles[].cover）换完 demo 后重新截帧：node scripts/article-cover.mjs public/guides/<slug>.jpg --tag Guide --title "…" public/demo/original.mp4@1 public/demo/ai1.mp4@2（版式等选项见脚本开头）
   生成用源视频${missingSources.length ? `（缺 ${missingSources.length} 个）` : ''}：${sourceFiles.join('、')}
3. Cloudflare 资源（把 database_id、KV id 写回 wrangler.jsonc）：
   npx wrangler d1 create ${name}
   npx wrangler r2 bucket create ${name}-media
   npx wrangler kv namespace create ${name}-kv
   npx wrangler queues create ${name}-jobs && npx wrangler queues create ${name}-jobs-dlq
   npx wrangler r2 bucket lifecycle add ${name}-media expire-uploads uploads/ --expire-days 8
   npx wrangler r2 bucket lifecycle add ${name}-media expire-outputs outputs/ --expire-days 31
4. wrangler.jsonc vars：APP_ENV=production、SITE_URL=https://${domain}、PAYMENT_PROVIDER、VIDEO_PROVIDER、
   MODERATION_PROVIDER=openai（生产禁止 mock，否则上传一律 503）、TURNSTILE_SITE_KEY、ADMIN_EMAILS、GOOGLE_CLIENT_ID。
   密钥：除支付与视频密钥外，再 secret put OPENAI_API_KEY、TURNSTILE_SECRET_KEY。
   交易邮件：Dashboard → Compute > Email Service → Onboard Domain 添加 ${domain}（DNS 须托管在 Cloudflare）；
   发给任意收件人需 Workers Paid。EMAIL_FROM 已改为 noreply@${domain}；ADMIN_EMAILS 同时接收举报、留言提醒和系统告警。
5. 支付商品：node scripts/waffo-setup.mjs --store STO_xxx --apply（先 test 店铺跑通再建 prod），把输出写进 WAFFO_PRODUCTS；webhook 指向 https://${domain}/api/webhooks/waffo。
6. 本地验证：npm run typecheck && npm test && npm run test:e2e && npm run seo:check；部署前 npm run doctor（npm run deploy 会先跑）
7. 上线后：npm run seo:check -- --base https://${domain} --production；Search Console 与 Bing Webmaster 验证并提交 https://${domain}/sitemap.xml；
   如配置了 site.seo.indexNowKey：npm run seo:indexnow -- --submit`)
