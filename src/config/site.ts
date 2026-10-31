// 上新词时主要改这个文件：关键词、品牌、模板视频、时长档位、积分包、文章 slug。
// 文案在 src/content/<locale>.ts，通过 {keyword} 等变量自动套用。

import type { ThemeName } from '#/lib/theme'

export const LOCALES = ['en', 'zh'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'en'

// 每种语言的 BCP 47 标签（<html lang>、日期格式、Turnstile）、og:locale 和切换器里显示的自称。
// 加语言时在这里补一行，并在 src/lib/i18n.ts 的 loaders 里登记文案文件
export const LOCALE_META: Record<Locale, { tag: string; ogLocale: string; name: string }> = {
  en: { tag: 'en', ogLocale: 'en_US', name: 'English' },
  zh: { tag: 'zh-CN', ogLocale: 'zh_CN', name: '简体中文' },
}

export const site = {
  keyword: 'Neon Shuffle',
  brandName: 'Neon Shuffle AI',
  logoMark: 'NS',
  domain: 'example.com',
  supportEmail: 'support@example.com',
  // 社媒平台名称（用于 “Viral on TikTok” 之类标签）
  trendPlatform: 'TikTok',
  ogImage: '/og.png',
  // 页面主题，可选值和效果见 src/lib/theme.ts
  theme: 'classic' as ThemeName,

  // 生成模板的共用参数：provider 输出时长 = 源视频时长，所以每种风格的每个时长档位各有一段剪好的源视频（见 styles[].sources）。
  template: {
    aspectRatio: '9:16',
    fullSeconds: 18,
  },

  // 舞蹈风格：一个站点可以配多种，第一个是默认风格；只有一种时界面不显示风格选择。
  // 源视频上传到 R2 的 templates/<文件名>，由 /media/templates/<文件名> 公开提供给 provider 拉取。
  // 风格的展示名和一句话介绍写在 src/content/<locale>.ts 的 styles[id]（缺了 typecheck 报错）。
  styles: [
    {
      // 写入 generations.template_id，发布后不要改
      id: 'neon-shuffle-v1',
      // 键 = durations[].id，每个档位都要有
      sources: { short: 'neon-shuffle-v1-6s.mp4', medium: 'neon-shuffle-v1-12s.mp4', full: 'neon-shuffle-v1-18s.mp4' },
      // 这种风格的 prompt，覆盖 video.yir.prompt 和 video.nanoapi.prompt；null = 用默认
      prompt: null as string | null,
      // yir 两步走（可选）：先用图片模型把照片里的人合成进源视频首帧，再拿合成图做动作参考，成片保留源视频的场景。
      // null = 单步，直接用用户照片做参考，背景会变成照片的背景。图片模型等共用参数在 video.yir.sceneImage
      scene: null as StyleScene | null,
      // 首页展示素材（public/demo/）。换成真实素材时必须拥有授权，credit 写原作者，例如 '@handle · TikTok'。
      examples: {
        original: { video: '/demo/original.mp4', poster: '/demo/original.jpg', credit: 'Demo clip · original' },
        aiVersions: [
          { video: '/demo/ai1.mp4', poster: '/demo/ai1.jpg', credit: 'Demo clip · AI render' },
          { video: '/demo/ai2.mp4', poster: '/demo/ai2.jpg', credit: 'Demo clip · AI render' },
        ],
        madeWith: { photo: '/demo/sample-photo.jpg', video: '/demo/madeWith.mp4', poster: '/demo/madeWith.jpg' },
      },
    },
  ],

  // 全站共用的首页展示素材
  examples: {
    // “创意”区块：每条 = 一张示例照片 + 一段成片
    ideas: [
      { photo: '/demo/sample-photo.jpg', video: '/demo/ai1.mp4', poster: '/demo/ai1.jpg' },
      { photo: '/demo/sample-photo.jpg', video: '/demo/ai2.mp4', poster: '/demo/ai2.jpg' },
      { photo: '/demo/sample-photo.jpg', video: '/demo/madeWith.mp4', poster: '/demo/madeWith.jpg' },
    ],
  },

  // 视频模型，服务商由 VIDEO_PROVIDER 选择。换模型时同时检查 src/server/video/ 下对应文件的入参与出参。
  video: {
    // fal.ai queue API（默认）
    falModel: 'fal-ai/wan/v2.2-14b/animate/replace',
    resolution: '480p',
    // 成本估算，只用于后台毛利；实际扣费以 fal 账单为准。换模型、分辨率或源视频帧率时同步更新。
    // fal 按帧计费：16 帧 = 1 个“视频秒”，480p $0.04/视频秒（https://fal.ai/models/fal-ai/wan/v2.2-14b/animate/replace）
    costCentsPerVideoSecond: 4,
    sourceFps: 24,
    // yir.ai 网关（可选，VIDEO_PROVIDER=yir）：照片 + 源视频走 Kling Motion Control。prompt 按热词写清要保留什么。
    yir: {
      model: 'klingai/kling-2.6',
      prompt: 'The person in the reference image performs the exact moves from the reference video. Keep their face, hair and outfit.',
      resolution: '720p',
      // 成本估算（美分/秒），只在出片时 yir 账单还没结算时用。按参考视频秒数计费，以 https://yir.ai/models 当前报价为准
      costCentsPerSecond: 7,
      // 用户照片会经过哪些上游渠道。null = 按 API Key 绑定的 Routing Profile 选，失败可换渠道；
      // 填渠道 ID（如 ['official'] 只走 Kling 官方）则只在这些渠道里选，全部失败时任务失败。隐私政策要写明实际经过的渠道
      routingOnly: null as readonly string[] | null,
      // 两步走用的图片模型参数（共用）。哪种风格走两步由 styles[].scene 决定，字段说明见下方 YirSceneImageConfig
      sceneImage: {
        model: 'google/nano-banana-2',
        resolution: '1K',
        aspectRatio: '9:16',
        costCents: 4,
        routingOnly: null as readonly string[] | null,
      } as YirSceneImageConfig,
    },
    // NanoAPI（可选，VIDEO_PROVIDER=nanoapi）：genjutsu 模型，照片 + 源视频。
    // mode：motion_control = 照片里的人做源视频的动作；replace_object = 把源视频里的对象换成照片里的，prompt 要写清换哪个。
    nanoapi: {
      model: 'genjutsu-1.0',
      mode: 'motion_control' as 'motion_control' | 'replace_object',
      prompt: '',
      resolution: '480p',
      // 成本估算（美分/秒），只用于后台毛利；实际扣费以 NanoAPI 账单为准。单价出处 https://nanoapi.ai/docs/genjutsu
      // genjutsu-1.0：480p $0.117/s、720p $0.273/s、1080p $0.78/s。motion_control 计费秒数 = 源视频秒数四舍五入、至少 4 秒；replace_object 向上取整
      costCentsPerSecond: 11.7,
    },
  },

  durations: [
    { id: 'short', seconds: 6, credits: 6 },
    { id: 'medium', seconds: 12, credits: 12 },
    { id: 'full', seconds: 18, credits: 18, isFull: true },
  ],

  // 积分包：一次性购买，买的积分永不过期（赠送积分可以设有效期，扣费时先扣快到期的）。价格用于展示与订单记录，实际收费以支付商后台为准。
  // 可选 anchorPriceCents：划线原价，价格卡显示原价和“Save X%”。只能填这个套餐真实卖过的价格
  // （欧盟要求以降价前 30 天内的最低价为准），不能编一个从没卖过的高价；没有就不填
  packages: [
    { id: 'starter', credits: 20, priceCents: 990, currency: 'USD' },
    { id: 'party', credits: 60, priceCents: 1990, currency: 'USD', highlight: true },
    { id: 'squad', credits: 100, priceCents: 2990, currency: 'USD' },
  ],

  // 订阅：按月或按年自动续费，每月发 credits 积分，当期结束时作废（不累积）；年付一次收一年的钱，积分按月发放。
  // 价格同样以支付商后台为准（dodo-setup / waffo-setup 按这里建订阅商品）。改价只影响新订阅，老订阅按订阅时的价格续费。
  // 开关 subscriptionsEnabled：false 时不再卖新订阅（定价页、条款、退款政策和 FAQ 里的订阅内容一起隐藏，下单接口拒绝套餐），
  // 已有订阅照常续费、退款，账单页仍能取消和进门户；这时要保留 *_PRODUCTS 里套餐的商品，支付商 webhook 也别退订订阅事件。
  // 使用手册见 docs/subscriptions.md
  subscriptionsEnabled: true as boolean,
  plans: [
    { id: 'monthly', interval: 'month', credits: 60, priceCents: 1490, currency: 'USD' },
    { id: 'yearly', interval: 'year', credits: 60, priceCents: 14900, currency: 'USD', highlight: true },
  ] as readonly SubscriptionPlan[],

  signupBonusCredits: 0,
  // 注册赠送积分的有效期（天），0 = 永不过期
  signupBonusValidDays: 0 as number,

  // 邀请奖励：被邀请人第一笔付款入账后给邀请人发的积分，0 = 关闭（不显示邀请卡片，/i/ 链接不再绑定）
  referralRewardCredits: 10 as number,
  // 同一邀请人在同一 IP（IPv6 按 /64）下最多绑定几个新账号，超出的不发奖励
  referralMaxPerIp: 3,
  // 每个邀请人 30 天内最多获得几次奖励
  referralMonthlyCap: 20,

  upload: {
    maxBytes: 10 * 1024 * 1024,
    contentTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },

  // 数据保留（天）：Cron 到期删除 R2 对象并标记 expired；隐私政策与个人中心按这里的值展示。
  // 另在 R2 配同前缀的生命周期规则兜底（README「数据保留」）。0 = 不自动删除。
  retention: {
    uploadDays: 7,
    outputDays: 30,
  },

  // 举报下架的处理时限（小时），TAKE IT DOWN Act 要求 48 小时内删除
  takedownSlaHours: 48,

  // 成片公开分享（/v/<随机串>）：用户在个人中心主动开启，页面 noindex，带 AI 标识和举报入口；
  // 成片到期、下架、删除或停止分享后链接失效。换脸、真人类站点风险高时设为 false（按钮和页面都不出现）
  share: {
    enabled: true,
  },

  // SEO 文章（指南），按展示顺序排列。slug 是根路径：/<slug> 与 /zh/<slug>；正文在 src/content/<locale>.ts 的 articles[key]。
  // 新增文章：这里加一项，各语言 content 的 articles 补同名 key（缺了 typecheck 会报错）。
  // trend、howTo 两篇被首页直接链接，不要删。related 不填时推荐其余文章里最近更新的。
  // 日期写进 Article 的 datePublished/dateModified、页面上的“最后更新”和 sitemap lastmod，改正文时同步改 updatedAt
  // cover 可选：public/ 下 1200×630 的图片路径，用在列表卡片、文章顶部、og:image 和 Article 的 image；
  // 用 scripts/article-cover.mjs 从站点自己的视频截帧生成（带标题、标签，可选多种版式）。不填时卡片没有图，og:image 用站点默认图
  articles: [
    { key: 'trend', slug: 'neon-shuffle-ai-trend', publishedAt: '2026-10-20', updatedAt: '2026-10-20', cover: '/guides/neon-shuffle-ai-trend.jpg' },
    { key: 'howTo', slug: 'how-to-make-neon-shuffle-ai-video', publishedAt: '2026-10-20', updatedAt: '2026-10-20' },
  ],

  seo: {
    // 长尾词：不输出 meta keywords（Google 不用），由 npm run seo:check 检查首页正文是否覆盖
    secondaryKeywords: ['Neon Shuffle AI', 'Neon Shuffle video', 'Neon Shuffle trend', 'AI dance video'],
    // 首次上线日期与站点页面（首页、价格、法律页等）最近一次内容更新日期：首页视频 uploadDate、sitemap lastmod。文章用各自的日期
    publishedAt: '2026-10-20',
    updatedAt: '2026-10-20',
    // Search Console / Bing Webmaster 选“HTML 标记”验证时填 content 值；用 DNS 验证则留空
    googleVerification: '',
    bingVerification: '',
    // IndexNow key（8–128 位字母数字）：填了才会公开 /<key>.txt，配合 npm run seo:indexnow 推送
    indexNowKey: '',
    // 品牌社媒主页，写进 Organization.sameAs
    sameAs: [] as string[],
    ogImageSize: { width: 1200, height: 630 },
  },

  // 统计：推荐只填 cfBeaconToken（Cloudflare Web Analytics，不写 Cookie，不需要同意横幅）。
  // 填了 ga4Id 才启用 GA4：同时出现同意横幅和页脚“Cookie 设置”，访客接受前不加载 gtag.js（Consent Mode v2 basic 模式，见 lib/consent.ts）。
  // 填了 umamiWebsiteId 就在所有页面加载同域的 Umami 脚本（/s/script.js，由 Worker 代理，实例地址在 vars.UMAMI_ORIGIN，不进前端）；
  // Umami 不写 Cookie，不受同意横幅控制。
  // 填了 clarityId（Microsoft Clarity 项目 ID）就在正式域名上录制访客会话，同样会出现同意横幅；
  // 访客接受前以无 Cookie 模式录制，接受后才写 Cookie（见 lib/consent.ts）。
  // 同意横幅只对欧洲经济区、英国、瑞士和无法判断国家的访客自动弹出，其他地区默认同意、可在页脚拒绝（按 cf-ipcountry 判断）。
  // 隐私政策的“Cookie 与统计”一节按这几项自动调整
  analytics: {
    ga4Id: '',
    cfBeaconToken: '',
    umamiWebsiteId: '',
    clarityId: '',
  },
} as const

export type DurationOption = (typeof site.durations)[number]
export type CreditPackage = (typeof site.packages)[number]

// 风格的两步走参数（yir）：首帧图和合成 prompt 跟着风格走
export interface StyleScene {
  // 源视频首帧图，放在 seed/templates/，和源视频一起上传到 R2 的 templates/。各时长档位从同一帧开始，共用一张
  frame: string
  prompt: string // Image 1 是首帧，Image 2 是用户照片
}

// 两步走的图片模型参数，所有风格共用
export interface YirSceneImageConfig {
  model: string // 图片编辑模型，如 'google/nano-banana-2'
  resolution: string
  aspectRatio: string // 和源视频一致，如 '9:16'
  costCents: number // 成本估算（美分/张），只在账单还没结算时用
  routingOnly: readonly string[] | null // 同 yir.routingOnly，照片也会经过图片模型的渠道
}

export interface SubscriptionPlan {
  id: string
  interval: 'month' | 'year'
  credits: number // 每月发放的积分
  priceCents: number // 每期价格（年付为一年的价格）
  currency: string
  highlight?: boolean
}

export interface ExampleClip {
  video: string
  poster: string
  credit: string
}

export interface Style {
  id: string
  sources: Readonly<Record<DurationOption['id'], string>> // 键 = durations[].id，值 = seed/templates/ 里的文件名
  prompt: string | null
  scene: StyleScene | null
  examples: {
    original: ExampleClip
    aiVersions: readonly ExampleClip[]
    madeWith: { photo: string; video: string; poster: string }
  }
}

export const STYLES: readonly Style[] = site.styles
// 第一个风格是默认风格：请求不带 styleId、首页 SSR 和 SEO 都用它
export const defaultStyle: Style = STYLES[0]!

export function findStyle(id: string): Style | undefined {
  return STYLES.find((s) => s.id === id)
}

export function findDuration(id: string) {
  return site.durations.find((d) => d.id === id)
}

export function findPackage(id: string) {
  return site.packages.find((p) => p.id === id)
}

// 在售的订阅套餐：开关关掉时为空。处理已有订阅（续费、退款、账单页）用 findPlan，不受开关影响
export const sellingPlans: readonly SubscriptionPlan[] = site.subscriptionsEnabled ? site.plans : []

export function findPlan(id: string) {
  return site.plans.find((p) => p.id === id)
}

// 套餐填了高于售价的 anchorPriceCents 才返回划线原价和折扣百分比，否则不显示
export function anchorPrice(pack: CreditPackage): { cents: number; percentOff: number } | null {
  const anchor = 'anchorPriceCents' in pack ? pack.anchorPriceCents : undefined
  if (typeof anchor !== 'number' || anchor <= pack.priceCents) return null
  return { cents: anchor, percentOff: Math.round((1 - pack.priceCents / anchor) * 100) }
}

// 积分包能做几条视频：列出“买得起的最长时长”和“最短时长”（相同则只列一项），没有买得起的时长时返回空数组
export function packageMakes(credits: number): { videos: number; seconds: number }[] {
  const affordable = site.durations.filter((d) => d.credits <= credits)
  if (!affordable.length) return []
  const bySeconds = [...affordable].sort((a, b) => a.seconds - b.seconds)
  const shortest = bySeconds[0]!
  const longest = bySeconds[bySeconds.length - 1]!
  const items = longest === shortest ? [longest] : [longest, shortest]
  return items.map((d) => ({ videos: Math.floor(credits / d.credits), seconds: d.seconds }))
}

// 积分 ≥ shortfall 的积分包里最便宜的一个（只看一次性积分包，不含订阅）；没有够用的返回 undefined
export function cheapestPackageCovering(shortfall: number) {
  return site.packages.filter((p) => p.credits >= shortfall).sort((a, b) => a.priceCents - b.priceCents)[0]
}

export type ArticleKey = (typeof site.articles)[number]['key']
export interface Article {
  key: ArticleKey
  slug: string
  publishedAt: string
  updatedAt: string
  related?: readonly ArticleKey[]
  cover?: string
}
export const ARTICLES: readonly Article[] = site.articles

export function findArticle(slug: string) {
  return ARTICLES.find((a) => a.slug === slug)
}

export function articlePath(key: ArticleKey) {
  const article = ARTICLES.find((a) => a.key === key)
  if (!article) throw new Error(`Unknown article: ${key}`)
  return `/${article.slug}`
}

export function relatedArticles(article: Article, limit = 3): Article[] {
  if (article.related) return article.related.flatMap((key) => ARTICLES.filter((a) => a.key === key)).slice(0, limit)
  return ARTICLES.filter((a) => a.key !== article.key)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
}

export function isLocale(value: string | undefined): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value)
}

export function localePath(locale: Locale, path: string) {
  const clean = path.startsWith('/') ? path : `/${path}`
  if (locale === DEFAULT_LOCALE) return clean
  return clean === '/' ? `/${locale}` : `/${locale}${clean}`
}

export function formatPrice(cents: number, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)
}
