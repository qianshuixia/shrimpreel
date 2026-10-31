# Changelog

Notable changes to the template. Derived sites pick them up with `git merge` from upstream (see the `sync-upstream` skill). Earlier changes are in the git history.

中文说明在每条下方。

## 2026-10-31

### Changed: the consent banner only asks visitors from the EEA, the UK and Switzerland

- With `ga4Id` or `clarityId` set, the default for analytics cookies now depends on the visitor's country (`cf-ipcountry`). The EEA, the UK, Switzerland and unknown countries (`XX`, `T1`, no header) default to `denied` and see the banner as before. Everywhere else defaults to `granted` without a banner: GA4 loads, Clarity may set its cookies and `vt_attr` is written from the first page view. The footer "Cookie settings" opens the card, which then explains that cookies are on by default and can be rejected. A stored choice always overrides the default.
- `src/server.ts` passes the default to the page through the request context; it is rendered on `<html data-consent-default>` and read by the inline GA4/Clarity scripts, the banner and the attribution code (`regionalConsentDefault`, `consentDefault` and `effectiveConsent` in `src/lib/consent.ts`).
- New copy key `consent.bodyOptOut`; the privacy policy's cookie section describes the regional split.

Upgrading a site: merge upstream. Add `bodyOptOut` to `consent` in `src/content/en.ts` and `zh.ts` if the merge didn't (typecheck reports it), and check the privacy policy's cookie paragraphs if the site rewrote them. After deploying, open the site with a US and an EU IP (or `cf-ipcountry`) to confirm the banner only shows for the EU. No vars, secrets or migrations.

调整：同意横幅只对欧洲经济区、英国和瑞士的访客弹出。填了 `ga4Id` 或 `clarityId` 时，统计 Cookie 的默认值按访客国家（`cf-ipcountry`）决定：欧洲经济区、英国、瑞士和无法判断的国家（`XX`、`T1`、没有这个头）默认 `denied`，照旧弹横幅；其他地区默认 `granted`、不弹横幅，GA4 直接加载，Clarity 可以写 Cookie，`vt_attr` 从第一个页面就写入。页脚“Cookie 设置”可以打开卡片，此时说明的是“默认开启、可拒绝”。存储的选择始终优先于默认值。`src/server.ts` 经请求上下文把默认值交给页面，渲染在 `<html data-consent-default>` 上，GA4/Clarity 内联脚本、横幅和归因代码都从这里读（`src/lib/consent.ts` 的 `regionalConsentDefault`、`consentDefault`、`effectiveConsent`）。新增文案键 `consent.bodyOptOut`，隐私政策的 Cookie 一节按地区分别说明。站点升级：合并 upstream；若合并后 `src/content/en.ts`、`zh.ts` 的 `consent` 里没有 `bodyOptOut` 就补上（typecheck 会报），站点改写过隐私政策 Cookie 段落的要核对一遍。部署后分别用美国和欧盟 IP（或 `cf-ipcountry`）访问，确认横幅只对欧盟弹出。没有新增 vars、密钥和迁移。

### Added: optional Microsoft Clarity session recordings

- **`analytics.clarityId`** (`src/config/site.ts`): a Microsoft Clarity project ID. When set, Clarity's loader is added to every page, but it only runs on `site.domain` and `www.` (not local dev, e2e, staging or `/admin`). It sends Clarity a `consentv2` signal before loading: `analytics_Storage` is `granted` only if the visitor accepted analytics cookies, otherwise Clarity records without cookies. Accepting or rejecting in the banner updates Clarity too, and rejecting makes Clarity delete its cookies.
- The consent banner, the footer "Cookie settings" link and the consent gate on the `vt_attr` cookie now apply when `ga4Id` **or** `clarityId` is set (`CONSENT_REQUIRED` in `src/lib/consent.ts`). With only Clarity, accepting no longer tries to load gtag.js.
- The privacy policy and the banner text mention Clarity when it is configured. The CSP allows `https://*.clarity.ms` and `https://c.bing.com`.

Upgrading a site: merge upstream, then add `clarityId: ''` to `analytics` in `src/config/site.ts` if the merge didn't (fill in the project ID to turn it on). In Clarity's Settings → Setup, turn Cookies off. No vars, secrets or migrations.

新增：可选的 Microsoft Clarity 录屏。`src/config/site.ts` 的 `analytics.clarityId` 填 Clarity 项目 ID 后，每个页面都带上加载脚本，但只在 `site.domain` 和 `www.` 上运行（本地 dev、e2e、staging 和 `/admin` 不运行）。加载前先发 `consentv2`：访客接受了统计 Cookie 才是 `analytics_Storage: granted`，否则 Clarity 以无 Cookie 模式录制。横幅里的接受和拒绝同步给 Clarity，拒绝时 Clarity 删除自己的 Cookie。同意横幅、页脚“Cookie 设置”和 `vt_attr` 的同意门槛改为填了 `ga4Id` 或 `clarityId` 就生效（`src/lib/consent.ts` 的 `CONSENT_REQUIRED`）；只配 Clarity 时接受不再尝试加载 gtag.js。配置了 Clarity 时，隐私政策和横幅文案会提到它；CSP 放行 `https://*.clarity.ms` 和 `https://c.bing.com`。站点升级：合并 upstream；若合并后 `analytics` 里没有 `clarityId: ''` 就补上（填项目 ID 即启用），并在 Clarity 后台 Settings → Setup 关掉 Cookies。没有新增 vars、密钥和迁移。

## 2026-10-27

### Changed: article covers get a headline, a tag and layouts

- **`scripts/article-cover.mjs`** now renders the cover as HTML in Playwright's Chromium (already installed for e2e) instead of an ffmpeg filter graph. New options: `--title` (headline), `--tag` (category pill), `--note` (one small line), `--labels "A|B"`, `--accent`, and `--layout`: `row` (1–3 frames fanned, the default), `before-after` (photo → video with an arrow), `vs` (split screen), `hero` (one large frame), `grid` (2–4 frames), `full` (one wide image such as an illustration). The brand name comes from `site.brandName` of the repo you run it in. Without `--title` it only lays out the frames. ffmpeg is still needed to grab video frames.
- The template's sample cover is regenerated with a headline.

Upgrading a site: merge upstream. Existing covers keep working; regenerate them with `--title`, `--tag` and a layout per article type if you want the new look. No vars, secrets or migrations.

调整：文章封面加标题、分类标签和版式。`scripts/article-cover.mjs` 改为用 Playwright 的 Chromium（e2e 已经装好）渲染 HTML 再截图，不再拼 ffmpeg 滤镜。新增选项：`--title`（标题）、`--tag`（分类标签）、`--note`（一行小字）、`--labels "A|B"`、`--accent`，以及 `--layout`：`row`（1–3 帧扇形排开，默认）、`before-after`（照片 → 成片，中间箭头）、`vs`（左右分屏）、`hero`（一帧大图）、`grid`（2–4 帧）、`full`（一张横图铺满，如插画）。品牌名取运行目录的 `site.brandName`。不带 `--title` 时只排画面。截视频帧仍需要 ffmpeg。模板示例封面已按新样式重新生成。站点升级：合并 upstream；已有封面照常可用，想换新样式就按文章类型选版式，加 `--title`、`--tag` 重新生成。没有新增 vars、密钥和迁移。

## 2026-10-26

### Added: optional article covers

- **`cover`** on `site.articles[]` (`src/config/site.ts`): a 1200×630 image under `public/`. When set it shows on the `/guides` card (and related-guide cards) and at the top of the article, and becomes that article's `og:image` / `twitter:image` and Article JSON-LD `image`. Without it nothing changes. The template's `trend` article ships with `/guides/neon-shuffle-ai-trend.jpg`.
- **`scripts/article-cover.mjs`** builds a cover from 1–3 frames of the site's own videos on a blurred background: `node scripts/article-cover.mjs public/guides/<slug>.jpg public/demo/original.mp4@1 public/demo/ai1.mp4@2` (needs ffmpeg).
- `npm run seo:check` no longer counts `alt=""` (decorative images) as a missing alt.

Upgrading a site: merge upstream. Covers are optional; to add them, generate one per article and set `cover: '/guides/<slug>.jpg'`. If the merge brings in `public/guides/neon-shuffle-ai-trend.jpg` and no article uses it, delete it. No vars, secrets or migrations.

新增：可选的文章封面。`site.articles[]` 的 `cover` 是 `public/` 下 1200×630 的图片，填了就显示在 `/guides` 卡片（含“相关指南”卡片）和文章顶部，并用作该文章的 `og:image` / `twitter:image` 和 Article 结构化数据的 `image`；不填和以前一样。模板的 `trend` 文章带了示例封面 `/guides/neon-shuffle-ai-trend.jpg`。`scripts/article-cover.mjs` 从站点自己的视频截 1–3 帧、铺在模糊背景上生成封面（需要 ffmpeg）。`npm run seo:check` 不再把 `alt=""`（装饰图）算成缺少 alt。站点升级：合并 upstream；封面可选，要加就每篇生成一张并填 `cover: '/guides/<slug>.jpg'`；合并带进来的 `public/guides/neon-shuffle-ai-trend.jpg` 没有文章用就删掉。没有新增 vars、密钥和迁移。

### Fixed: `/s/script.js` returns an empty script outside production

- With Umami configured, local dev, e2e and staging no longer fetch the tracker from the instance: `/s/script.js` returns an empty JavaScript file when `APP_ENV` is not `production`. Before, a local Worker that could not reach the instance answered 502 `text/plain`, the browser logged errors on every page, and the "home page hydrates without errors" e2e case failed. Nothing was reported from these environments either way.

Upgrading a site: merge upstream. Nothing to configure; production is unchanged.

修复：非 production 环境的 `/s/script.js` 返回空脚本。配了 Umami 的站点，本地 dev、e2e 和 staging 不再去实例取跟踪脚本，`APP_ENV` 不是 `production` 时直接返回一个空 JS。之前本地 Worker 连不上实例时返回 502 和 `text/plain`，每个页面控制台报错，e2e“首页水合无报错”失败；这些环境本来就不上报。站点升级：合并 upstream，无需配置，生产不变。

### Added: a second theme (`acid`), a corner consent card and "Ask AI" in the footer

- **`site.theme`** (`src/config/site.ts`): `'classic'` (the current look) or `'acid'` (zinc black / cream, lime accent, bold sans headings, small radii). It is set on `<html data-skin>`; light / dark still follows the visitor. Colors, the heading font, radii, the primary button, the footer and the logo tile are CSS variables in `src/styles.css`; themes are listed in `src/lib/theme.ts`. The footer, language links and logo no longer hard-code colors.
- The consent banner is now a small card in the bottom-right corner (full width at the bottom on phones) with a × that hides it for this page view without saving a choice. "Accept" and "Reject" stay the same size.
- The footer gets an "AI & agent docs" row: a link to `/llms.txt` and ChatGPT, Claude, Perplexity, Gemini (Google AI Mode) and Grok buttons that open a pre-filled question about the site in a new tab (`rel="noopener nofollow"`).

Upgrading a site: merge upstream. `src/config/site.ts` needs `theme` (keep `'classic' as ThemeName` for the current look; the import is `import type { ThemeName } from '#/lib/theme'`). `src/content/en.ts` and `zh.ts` need `consent.dismiss` and `footer.agentDocs`, `footer.askAi`, `footer.askAiLabel`, `footer.askAiPrompt` (copy them from the template; `npm run typecheck` lists what is missing). The shorter `consent.body` is optional. No vars, secrets or migrations.

新增：第二套主题 `acid`、右下角同意卡片和页脚“问问 AI”。`site.theme` 可选 `'classic'`（现有外观）或 `'acid'`（锌黑 / 奶白、黄绿强调、无衬线粗标题、小圆角），写在 `<html data-skin>` 上，亮色 / 暗色仍由访客切换；颜色、标题字体、圆角、主按钮、页脚和 Logo 底色都是 `src/styles.css` 里的 CSS 变量，主题列表在 `src/lib/theme.ts`；页脚、语言链接和 Logo 不再写死颜色。同意横幅改成右下角小卡片（手机上贴底铺满），× 只收起本次、不记录选择，“接受”和“拒绝”仍同样大小。页脚新增“AI 与 Agent 文档”一行：`/llms.txt` 链接，以及 ChatGPT、Claude、Perplexity、Gemini（Google AI Mode）、Grok 按钮，在新标签打开一段预填的提问（`rel="noopener nofollow"`）。站点升级：合并 upstream；`src/config/site.ts` 要有 `theme`（保持现有外观填 `'classic' as ThemeName`，并加 `import type { ThemeName } from '#/lib/theme'`）；`src/content/en.ts`、`zh.ts` 要补 `consent.dismiss` 和 `footer.agentDocs`、`footer.askAi`、`footer.askAiLabel`、`footer.askAiPrompt`（从模板复制，缺哪个 `npm run typecheck` 会列出），缩短后的 `consent.body` 可选。没有新增 vars、密钥和迁移。

### Fixed: Umami only counts production visitors

- `/s/api/send` now forwards events only when `APP_ENV` is `production`; local dev, e2e and staging get `{"disabled":true}` (the tracker stops for that page) and nothing reaches the instance. Sites share their `vars` with local dev, so before this a local run or e2e pass with Umami enabled reported to the live instance.
- Events whose `url` is under `/admin` are dropped (`{}`), so admin views, with order and user IDs in their paths, no longer show up in analytics.

Upgrading a site: merge upstream and deploy. Nothing to configure. Events already recorded from `127.0.0.1` or `/admin` stay in Umami; delete them there if needed.

修复：Umami 只统计正式环境。`/s/api/send` 只在 `APP_ENV` 为 `production` 时转发，本地 dev、e2e、staging 返回 `{"disabled":true}`（跟踪脚本在本页停止上报），不会到达实例；站点的 `vars` 本地和生产共用，之前开了 Umami 的站点本地跑 dev 或 e2e 会报进正式实例。`url` 在 `/admin` 下的事件直接丢弃（返回 `{}`），后台页面（路径里有订单号、用户 ID）不再进统计。站点升级：合并 upstream 后部署，无需配置。已经记录的 `127.0.0.1` 或 `/admin` 数据留在 Umami 里，需要时在那边删除。

### Added: optional Umami analytics through a same-origin proxy

- **`analytics.umamiWebsiteId`** (`src/config/site.ts`, empty by default): when set, every page loads `/s/script.js` (with `data-website-id`). Umami sets no cookies, so the consent banner does not gate it. The privacy policy adapts (the "no third-party analytics" sentence is dropped, a cookie-free Umami sentence is added, and the service-provider sentence mentions analytics). `new-site.mjs` clears the ID for a new site.
- **`UMAMI_ORIGIN`** (plain var in `wrangler.jsonc` / `wrangler.staging.jsonc`, empty by default): the Umami instance, an https origin without a path. It is only read by the Worker (`src/server/umami.ts`), never bundled into the frontend, so the instance's domain is not visible in page source or JS. The Worker serves `GET|HEAD /s/script.js` (cached for a day) and `POST /s/api/send`: the body is capped at 16 KB and must be a JSON object with an object `payload`; `CF-Connecting-IP` is written to `payload.ip` so Umami counts country and unique visitors by the real visitor; only `Content-Type`, `User-Agent` and `x-umami-cache` go upstream (never cookies); only status, body and `Content-Type` come back; upstream errors or a 5 s timeout return 502 without the origin. Empty `UMAMI_ORIGIN` gives 404. `npm run doctor` warns when it is not a path-less https origin. CSP is unchanged.

Upgrading a site (only if you want Umami): merge upstream, set `analytics.umamiWebsiteId` in `src/config/site.ts` and `UMAMI_ORIGIN` in `wrangler.jsonc` `vars`, then deploy. No secrets or migrations. The Umami instance must ship the GeoLite2 database (on Vercel set `BUILD_GEO=1` and redeploy): with `payload.ip` set, Umami looks up the country itself and returns 500 without it.

新增：可选的 Umami 统计，经站点自己域名的同域代理接入。`analytics.umamiWebsiteId`（`site.ts`，默认空）填了就在所有页面加载 `/s/script.js`；Umami 不写 Cookie，不受同意横幅控制，隐私政策按配置调整。`UMAMI_ORIGIN`（`wrangler.jsonc` 和 `wrangler.staging.jsonc` 的普通 var，默认空）是实例地址（不带路径的 https origin），只在 Worker（`src/server/umami.ts`）里使用，不进前端 bundle，网页源码和 JS 里看不到实例域名。Worker 提供 `GET|HEAD /s/script.js`（缓存一天）和 `POST /s/api/send`：body 上限 16 KB，必须是带对象 `payload` 的 JSON；把 `CF-Connecting-IP` 写进 `payload.ip`，让 Umami 按真实访客统计国家和独立访客；上游只带 `Content-Type`、`User-Agent`、`x-umami-cache`（绝不带 Cookie），响应只回状态码、body 和 `Content-Type`；上游出错或 5 秒超时返回 502，且不含实例地址。`UMAMI_ORIGIN` 为空时返回 404；格式不对时 `npm run doctor` 警告；CSP 不变。站点升级（想用 Umami 才需要）：合并 upstream 后，在 `src/config/site.ts` 填 `analytics.umamiWebsiteId`，在 `wrangler.jsonc` 的 `vars` 填 `UMAMI_ORIGIN`，部署。没有新增密钥和迁移。Umami 实例要带 GeoLite2 数据库（Vercel 上设 `BUILD_GEO=1` 后重新部署）：带了 `payload.ip` 时 Umami 自己查国家，没有数据库会返回 500。

## 2026-10-25

### Added: optional Resend channel for transactional email

- **`RESEND_API_KEY`** (optional secret): when it is set and `EMAIL_FROM` is non-empty, every email goes out through [Resend](https://resend.com/) (`src/server/resend.ts`, `POST https://api.resend.com/emails`) instead of the `send_email` binding. Workers Free only lets Email Service reach addresses verified in Cloudflare; Resend's free tier (3,000 a month, 100 a day) can email users. Daily or monthly quota (429) and rate limits are retried with the usual backoff, 5xx and network errors too; domain not verified, invalid key and other 4xx fail immediately. The key never appears in errors. Without the key nothing changes.
- The admin connection test for email names the channel (Resend or Cloudflare Email Service). `npm run doctor` and the overview check warn in production when `EMAIL_FROM` is set but `RESEND_API_KEY` is not (Workers Free limitation), and warn when `EMAIL_FROM` is on another domain than the site, pointing at Resend verification when the key is set.

Upgrading a site (only if you want Resend): sign up at Resend, add and verify the sending domain under Domains (SPF/DKIM), create an API key, add `RESEND_API_KEY` to `.dev.vars.production`, run `node scripts/sync-secrets.mjs --apply`, then run the email "Test connection" in the admin and check the inbox. No new vars or migrations.

新增：交易邮件可选走 Resend。配置可选 secret `RESEND_API_KEY` 且 `EMAIL_FROM` 非空时，全部邮件经 Resend（`src/server/resend.ts`，`POST https://api.resend.com/emails`）发送，不再用 `send_email` binding。Workers Free 上 Email Service 只能发给 Cloudflare 里已验证的地址，Resend 免费档（每月 3000 封、每天 100 封）可以发给用户。429 的日 / 月额度和限流、5xx 和网络错误按原有退避重试；域名未验证、Key 无效等其它 4xx 直接失败；错误信息不含 Key。不配 Key 则行为完全不变。后台邮件“测试连接”会注明走的渠道；`npm run doctor` 和概览的配置检查在生产环境 `EMAIL_FROM` 非空但没配 `RESEND_API_KEY` 时警告（Workers Free 限制），`EMAIL_FROM` 域名与站点不同时警告，配了 Key 则提示去 Resend 验证。站点升级（想用 Resend 才需要）：注册 Resend，在 Domains 添加并验证发件域名（SPF/DKIM），创建 API Key 写进 `.dev.vars.production` 的 `RESEND_API_KEY`，运行 `node scripts/sync-secrets.mjs --apply`，再到后台对邮件点“测试连接”并查收。没有新增 vars 和迁移。

### Added: buy in the generator, "makes N videos" on packs, `/llms.txt`, alerts in chat and a low-balance alert

- **Inline paywall**: when a signed-in user doesn't have enough credits for the chosen length, the generator's main button checks out the cheapest pack that covers the shortfall ("Get 18 credits · $9.90"), with a "See all packs" link below. With no such pack it still links to `/pricing`. Checkout logic moved to `useCheckout()` in `src/lib/checkout.ts`, shared with the pricing page; the checkout pause rules are unchanged.
- **Pricing cards**: `pricing.approx(videos, seconds)` is replaced by `pricing.makes(items)`, which lists how many videos of the longest and the shortest affordable length a pack makes (`packageMakes` in `site.ts`). The grid follows the pack count (2, 3 or 4 columns). A site can add a single-video pack that covers exactly the shortest length.
- **`/llms.txt`**: generated from `site` and the English copy (key facts, pages, guides, legal). `seo:check` and the production smoke test check it.
- **Alerts in chat**: every health-check alert and D1 backup failure is also posted to `PAYMENT_NOTIFY_WEBHOOK_URL` when it's set (one per alert type per 6-hour bucket, deduped in KV). New `provider_balance` alert: the video provider balance is checked hourly and alerts below $10. The admin connection test now warns below $10 as well (was $5).
- **Tests**: the doctor fixture in `tests/unit/config-health.test.ts` derives `WAFFO_PRODUCTS` from `site.packages` and `sellingPlans`, so adding a pack to a site no longer fails it.

Upgrading a site: merge upstream, then in `src/content/en.ts` and `zh.ts` replace `pricing.approx` with `pricing.makes` and add `generator.ctaBuyPack` and `generator.seePacks` (typecheck lists them; copy the template's wording and adjust). Optional: add a single-video pack to `site.packages` and its name in `pricing.packages`, then create the product with `node scripts/waffo-setup.mjs` / `dodo-setup.mjs` (test first, then live) and update `WAFFO_PRODUCTS` / `DODO_PRODUCTS`; `npm run doctor` reports a pack without a product ID. If the chat is a Feishu bot with keyword checks, add the keyword "告警". No new vars, secrets or migrations.

新增：生成器就地购买、积分包显示“可做几条”、`/llms.txt`、告警发到聊天群和视频服务商余额告警。**就地购买**：已登录用户余额不够所选时长时，生成器主按钮直接下单够用的最便宜的积分包（“购买 18 积分 · $9.90”），下方是“查看全部套餐”；没有够用的包时仍链到 `/pricing`。下单逻辑移到 `src/lib/checkout.ts` 的 `useCheckout()`，和价格页共用，暂停收款规则不变。**价格卡片**：`pricing.approx(videos, seconds)` 换成 `pricing.makes(items)`，列出买得起的最长和最短时长各能做几条（`site.ts` 的 `packageMakes`）；网格按包数排成 2、3 或 4 列；站点可以加一个正好够最短时长的单条包。**`/llms.txt`**：由 `site` 和英文文案生成（关键事实、页面、指南、条款），`seo:check` 和线上 smoke 会检查。**告警进聊天群**：配了 `PAYMENT_NOTIFY_WEBHOOK_URL` 时，健康检查告警和 D1 备份失败也发到群里（同一类告警每 6 小时一条，KV 去重）；新增 `provider_balance` 告警，每小时查一次视频服务商余额，低于 10 美元告警；后台测试连接的余额提示阈值也从 5 美元改为 10 美元。**测试**：`tests/unit/config-health.test.ts` 的 doctor 夹具按 `site.packages` 和 `sellingPlans` 生成 `WAFFO_PRODUCTS`，站点加积分包不再导致它失败。站点升级：合并 upstream 后，在 `src/content/en.ts`、`zh.ts` 把 `pricing.approx` 换成 `pricing.makes`，补 `generator.ctaBuyPack` 和 `generator.seePacks`（typecheck 会列出来，可照抄模板措辞再调整）。可选：在 `site.packages` 加单条包并在 `pricing.packages` 写名称，用 `node scripts/waffo-setup.mjs` / `dodo-setup.mjs` 建商品（先 test 后 live），更新 `WAFFO_PRODUCTS` / `DODO_PRODUCTS`，缺商品 ID 时 `npm run doctor` 会报错。聊天群是开了关键词校验的飞书机器人时，加关键词“告警”。没有新增 vars、密钥和迁移。

### Fixed: e2e on sites with their own pricing

- The e2e suite hard-coded the template's package and plan credits (starter 20, party 60, plans 60 a month), so a site that changed its pricing failed about 20 e2e tests in CI. Credits, prices, refund clawbacks and the yearly "Save X%" are now derived from `site` through helpers in `tests/e2e/helpers.ts` (`pkg`, `plan`, `durationCredits`, `clawbackCredits`, `yearlySavingPercent`). A few scenarios that need a specific relation between package and duration credits skip with a reason when the site's config can't build them.

Upgrading a site: merge upstream; nothing else to do. The site's CI e2e should pass with its own pricing.

修复：e2e 写死了模板的套餐和订阅积分（starter 20、party 60、订阅每月 60），站点改了定价后 CI 里约 20 个 e2e 失败。现在积分、价格、部分退款回收的积分和年付“Save X%”都通过 `tests/e2e/helpers.ts` 的 helper（`pkg`、`plan`、`durationCredits`、`clawbackCredits`、`yearlySavingPercent`）从 `site` 推算；少数依赖套餐与时长积分特定关系的场景，站点配置构造不出来时带原因跳过。站点升级：合并 upstream 即可，站点 CI 的 e2e 应按站点自己的定价通过。

### Added: switch the payment provider from the admin

- A new runtime setting `paymentProvider` ("收款渠道" in `/admin/settings`): a dropdown that overrides `PAYMENT_PROVIDER` for new orders (Waffo, Dodo or Stripe; empty follows the deploy config). Saving checks the target provider's secrets, product IDs and key mode with the same rules as the launch check and rejects the save with the missing keys (never their values). Refunds, order lookups and subscription renewals or cancellations keep using each order's own provider, so keep every provider's webhook in place. The admin overview's config check and the payment connection test follow the effective provider; `npm run doctor` still checks only `PAYMENT_PROVIDER`. `/api/me` reports the effective provider.

Upgrading a site: merge upstream; nothing else to do. No new copy, vars, secrets or migrations. Only switch to a provider whose account is live and whose secrets are set on the site.

新增后台切换收款渠道：后台 `/admin/settings` 新增运营参数 `paymentProvider`（“收款渠道”），用下拉框为新订单覆盖 `PAYMENT_PROVIDER`（Waffo、Dodo、Stripe；留空跟随部署配置）。保存前按上线检查的同一套规则检查目标支付商的密钥、商品 ID 和 Key 模式，配置不全就拒绝保存，并列出缺的键（不显示值）。退款、查单和订阅续费、取消仍按订单所属的支付商处理，所以各家的 webhook 都要保持开着。后台概览的配置检查和支付测试连接按实际生效的支付商检查；`npm run doctor` 仍只检查 `PAYMENT_PROVIDER`。`/api/me` 返回实际生效的支付商。站点升级：合并 upstream 即可，没有新增文案、vars、密钥和迁移；只切到账号已开通、密钥已配在站点上的支付商。

### Added: checkout pause

- A new runtime setting `checkoutPaused` ("暂停收款" in `/admin/settings`) for a payment provider that isn't live yet or is temporarily broken. While it's on, the pricing page buttons show a disabled "Payments opening soon" with a note at the top, and `POST /api/checkout` returns 503 `checkout_paused`. Admins still see the note but keep working buttons so they can test checkout. Generation, sign-in and webhooks for existing orders keep working. `/api/me` exposes it as `config.notice.checkoutPaused`.

Upgrading a site: merge upstream, then add `pricing.paused`, `pricing.pausedNote` and `errors.checkout_paused` to `src/content/en.ts` and `zh.ts` (typecheck lists them). Turn it on in `/admin/settings` when needed; no new vars, secrets or migrations.

新增暂停收款：后台 `/admin/settings` 的新开关 `checkoutPaused`（“暂停收款”），支付商还没开通或临时出问题时用。打开后价格页的购买按钮变成不可点的“支付即将开放”，顶部显示说明，`POST /api/checkout` 返回 503 `checkout_paused`；管理员也看到说明，但按钮照常可点，便于测试结账；生成、登录和已建订单的支付回调照常。`/api/me` 里是 `config.notice.checkoutPaused`。站点升级：合并 upstream 后，在 `src/content/en.ts`、`zh.ts` 补 `pricing.paused`、`pricing.pausedNote` 和 `errors.checkout_paused`（typecheck 会列出来），需要时在后台打开；没有新增 vars、密钥和迁移。

### Fixed: sign-in and checkout returns counted as traffic sources

- Coming back from Google sign-in or a payment provider's checkout page left `accounts.google.com` (or the checkout domain) in `document.referrer`, so the visitor's last touch became `google / organic` (or a referral from the payment provider) and orders were attributed to it. These hosts (`accounts.google.*`, `*.dodopayments.com`, `*.waffo.ai`, `*.stripe.com`, `*.paypal.com`; list in `src/lib/referrer.ts`) no longer count as a referrer on the client, and the server classifies them as `direct`, so orders fall back to the first touch even for cookies written before the fix.

Upgrading a site: nothing to do. Existing `orders.source` values are not rewritten; their raw touches are still in the `attribution` column.

修复：Google 登录、支付商结账页回跳后，`document.referrer` 是 `accounts.google.com` 或结账域名，最近一次触达被记成 `google / organic`（或来自支付商的 referral），订单来源跟着错。现在这些域名（`accounts.google.*`、`*.dodopayments.com`、`*.waffo.ai`、`*.stripe.com`、`*.paypal.com`，表在 `src/lib/referrer.ts`）客户端不记为 referrer，服务端按 `direct` 归类，修复前写下的 Cookie 下单时也会回落到首次触达。站点升级：无需操作；已写入 `orders.source` 的旧记录不会改写，原始触达仍在 `attribution` 列里。

### Docs: showcase

- Both READMEs get a "Built with ShrimpReel" section: a card image (`docs/media/showcase-christmas-dance-ai.jpg`) linking to Christmas Dance AI, the first live site built from the template. The status note now says a site runs in production.

Upgrading a site: nothing to do. The section and the image arrive with the merge; a site can drop them from its own README.

文档：README 两份新增“用 ShrimpReel 做的站”，用卡片图（`docs/media/showcase-christmas-dance-ai.jpg`）链接到第一个上线的站点 Christmas Dance AI；状态说明改为已有站点在生产环境运行。站点升级：无需操作，合并后会带上这一节和图片，站点可以在自己的 README 里删掉。

### Added: multiple dance styles

- A site can offer several dance styles (for example an elf dance and a Christmas party dance). `site.styles[]` replaces `template.id`, `durations[].source`, `site.examples.original/aiVersions/madeWith` and the per-style parts of `site.video.yir.scene`. Each style has its own `id` (written to `generations.template_id`, don't change it once published), `sources` (one source video per `durations[].id`), optional `prompt` (overrides `video.yir.prompt` and `video.nanoapi.prompt`), optional `scene` (yir two-step `{ frame, prompt }`) and its `examples`. The first style is the default. `template` keeps only `aspectRatio` and `fullSeconds`; `site.examples` keeps only `ideas`; `site.video.yir.scene` is now `site.video.yir.sceneImage` (shared `model`, `resolution`, `aspectRatio`, `costCents`, `routingOnly`, always present), and a style runs two-step when its own `scene` is set.
- `POST /api/generations` takes an optional `styleId` (default style when omitted, `400 invalid_style` for an unknown id). `VideoProvider.costCents(durationSeconds, styleId)` adds the scene image cost only for styles with a `scene`.
- UI: with more than one style the generator shows a style picker above the length (`?style=<id>` preselects) and the home hero gets style tabs synced with it; "Made with" shows one row per style. With one style nothing changes. Copy for each style goes in `styles[<id>]` of `src/content/en.ts` and `zh.ts` (`{ name, tagline }`) and `generator.stepStyle`.

Upgrading a site: merge upstream, then in `src/config/site.ts` move `template.id`, `durations[].source`, `examples.original/aiVersions/madeWith` and the `frame`/`prompt` of `video.yir.scene` into `styles[0]` (`id`, `sources` keyed by duration id, `examples`, `scene`); rename the other `video.yir.scene` fields (`model`, `resolution`, `aspectRatio`, `costCents`, `routingOnly`) to `video.yir.sceneImage` (keep the old values; a site without two-step keeps the template defaults). Add `styles: { '<id>': { name, tagline } }` to `en.ts` and `zh.ts`. Existing generations keep working because `template_id` already holds the style id. No new vars, secrets or migrations.

新增多舞蹈风格：一个站点可以提供多种舞（例如精灵舞和圣诞派对舞）。`site.styles[]` 取代 `template.id`、`durations[].source`、`site.examples.original/aiVersions/madeWith` 和 `site.video.yir.scene` 里随风格变化的部分。每种风格有自己的 `id`（写入 `generations.template_id`，发布后不要改）、`sources`（每个时长档位一段源视频）、可选的 `prompt`（覆盖 `video.yir.prompt` 和 `video.nanoapi.prompt`）、可选的 `scene`（yir 两步走的 `{ frame, prompt }`）和 `examples`，第一个是默认风格。`template` 只保留 `aspectRatio` 和 `fullSeconds`，`site.examples` 只保留 `ideas`，`site.video.yir.scene` 改名 `sceneImage`（共用的 `model`、`resolution`、`aspectRatio`、`costCents`、`routingOnly`，始终存在），某个风格设了自己的 `scene` 才走两步。`POST /api/generations` 接受可选的 `styleId`（缺省用默认风格，不存在返回 400 `invalid_style`）；`VideoProvider.costCents(durationSeconds, styleId)` 只对有 `scene` 的风格加合成图费用。界面：多于一种风格时生成器在时长上方出现风格选择（`?style=<id>` 预选），首页 hero 出现与之同步的风格标签，“Made with”每种风格一行；只有一种风格时界面不变。每种风格的文案写在 `en.ts`、`zh.ts` 的 `styles[<id>]`（`{ name, tagline }`）和 `generator.stepStyle`。站点升级：合并 upstream 后，在 `src/config/site.ts` 里把 `template.id`、`durations[].source`、`examples.original/aiVersions/madeWith` 和 `video.yir.scene` 的 `frame`/`prompt` 迁到 `styles[0]`（`id`、按时长 id 索引的 `sources`、`examples`、`scene`）；`video.yir.scene` 的其余字段（`model`、`resolution`、`aspectRatio`、`costCents`、`routingOnly`）改名为 `video.yir.sceneImage`，沿用原值（没用两步走的站点保留模板默认值）；`en.ts`、`zh.ts` 补 `styles`。已有的生成记录不受影响，因为 `template_id` 本来就存风格 id。没有新增 vars、密钥和迁移。

### Added: NanoAPI video provider

- A third optional video provider: `VIDEO_PROVIDER=nanoapi` with the `NANOAPI_API_KEY` secret and `site.video.nanoapi` (`genjutsu-1.0`; `mode` is `motion_control` or `replace_object`, plus `prompt`, `resolution` and `costCentsPerSecond`). The default provider is unchanged.
- NanoAPI has no idempotency key, so before creating a task the provider lists the last 3 hours of tasks and reuses the one with the same photo and source video URLs; a failed list request fails the submit instead of creating blindly. Polling every 30 seconds; the webhook (`/api/webhooks/nanoapi`) is only a "go check now" signal. Account errors (`nanoapi_invalid_api_key`, `nanoapi_insufficient_balance`, `nanoapi_account_suspended`) fire the "Video provider account" alert; the config check and "test connection" cover it.
- Tested with a real key at 480p: one order through the dev server and a tunnel (webhook, R2 copy, actual cost, dedupe list fields). `motion_control` keeps the face and the source scene but the photo's clothes; `replace_object` keeps the source outfit but not the face. Dressing the photo first with an image model and then running `motion_control` gives "you, in costume, dancing"; the template doesn't do that step for NanoAPI. NanoAPI reads the source video with Range requests and a browser User-Agent, so keep bot challenges away from `/media/*`; cut source videos to whole seconds (`replace_object` rounds up). Details in the README under "Video providers".

Upgrading a site: merge upstream. Nothing changes unless you set `VIDEO_PROVIDER=nanoapi`; then set the `NANOAPI_API_KEY` secret and review `site.video.nanoapi`. No new vars or migrations.

新增第三个可选视频服务商 NanoAPI（`VIDEO_PROVIDER=nanoapi`，密钥 `NANOAPI_API_KEY`，配置 `site.video.nanoapi`：`genjutsu-1.0`，`mode` 为 `motion_control` 或 `replace_object`）。NanoAPI 创建任务没有幂等键，所以创建前先列出最近 3 小时的任务，照片和源视频地址都相同就沿用旧任务，列表查不了则提交失败而不是盲目创建。轮询间隔 30 秒，webhook（`/api/webhooks/nanoapi`）只当“该查了”的信号。账户类错误触发“视频服务商账户”告警，配置检查和测试连接已覆盖。已用真实 key 在 480p 实测：经隧道跑通一单（webhook、转存 R2、实际成本、去重列表字段）。`motion_control` 保留人脸和源视频场景，但衣服是照片里的；`replace_object` 保留服装，但人脸不像本人。先用图片模型给照片换装，再跑 `motion_control`，才能做到“本人穿戏服跳舞”，模板的 NanoAPI 接入没有做这一步。NanoAPI 用浏览器 UA 和 Range 请求读源视频，`/media/*` 前面不要加人机验证；源视频剪成整秒（`replace_object` 向上取整）。站点升级：合并 upstream；不设 `VIDEO_PROVIDER=nanoapi` 行为不变，启用时配置 `NANOAPI_API_KEY` 并检查 `site.video.nanoapi`；没有新增 vars 和迁移。

## 2026-10-24

### Fixed: dev server always uses payment test environments

- `LOCAL_DEV_VARS` in `vite.config.ts` now sets `DODO_ENVIRONMENT`, `STRIPE_ENVIRONMENT` and `WAFFO_ENVIRONMENT` to `test`. A live site has `DODO_ENVIRONMENT=live` in `wrangler.jsonc`, so the dev server and `npm run test:sandbox` sent the test key from `.dev.vars` to the live API and checkout failed with HTTP 401. Builds and `wrangler deploy` are unaffected.

Upgrading a site: merge upstream. No new vars, secrets or migrations.

修复：站点上线后 `wrangler.jsonc` 里是 `DODO_ENVIRONMENT=live`，dev server 和 sandbox e2e 会拿 `.dev.vars` 里的 test key 去请求正式环境，下单返回 401。现在 `LOCAL_DEV_VARS` 把三家支付商的环境固定为 `test`，构建和部署不受影响。站点升级：合并 upstream；没有新增 vars、密钥和迁移。

### Fixed: e2e on sites with GA4 configured

- `playwright.config.ts` presets the analytics consent to `denied` in localStorage, so the consent banner no longer covers buttons at the bottom of the page and e2e runs never send hits to the site's real GA4 property. The attribution test grants consent itself and blocks gtag.js. No effect when `analytics.ga4Id` is empty.

Upgrading a site: merge upstream. Test-only change.

修复：站点填了 `analytics.ga4Id` 后 e2e 失败（同意横幅挡住后台按钮、归因 Cookie 要等同意才写）。现在 e2e 默认在 localStorage 预置“拒绝统计”，测试访问也不会发到真实的 GA4；归因用例自己改成同意并拦掉 gtag.js。没配 GA4 时不受影响。站点升级：合并 upstream，只改测试。

### Added: Dodo brand for products

- `node scripts/dodo-setup.mjs --apply --brand <brand_id>` creates the products under a brand of the Dodo business (Settings → Business → Brands). Several sites can share one verified business: each gets its own brand name, logo and statement descriptor on checkout and invoices, while KYC and payouts stay shared. Webhooks are business-level, so every site's endpoint also receives the other sites' events; those are already answered `ignored` with 200 (see docs/payments.md).

Upgrading a site: merge upstream. Only matters when creating Dodo products for a site that is a secondary brand. No new vars, secrets or migrations.

新增 Dodo 品牌：`dodo-setup.mjs --brand <brand_id>` 把商品建在 Dodo business 下这个站的品牌里。多个站可以共用一个已认证的 business，结账页和发票显示各站自己的名字、Logo 和账单描述，KYC 和打款共用。webhook 是 business 级的，每个站都会收到别站的事件，模板已按 `ignored` 回 200。站点升级：合并 upstream；只有给次级品牌建商品时才用得到；没有新增 vars、密钥和迁移。

### Fixed: yir unit tests on sites with `scene` configured

- `tests/unit/yir.test.ts` reset `site.video.yir.scene` and `routingOnly` to `null` before each test and restore the site's values after, so single-step tests no longer fail on a site that enables the two-step mode.

Upgrading a site: merge upstream. Test-only change.

修复：站点配了 `site.video.yir.scene` 后 yir 单步用例会失败。现在每个用例前把 `scene`、`routingOnly` 置空，结束后还原站点配置。站点升级：合并 upstream，只改测试。

### Changed: dev server always uses development vars

- `vite.config.ts` overrides `APP_ENV`, `SITE_URL`, the payment / video / moderation providers, `ADMIN_EMAILS`, `EMAIL_FROM`, `GOOGLE_CLIENT_ID` and `TURNSTILE_SITE_KEY` with development values (`LOCAL_DEV_VARS`) when running `vite dev`. A site can keep production values in `wrangler.jsonc` `vars` and still run local dev, e2e and CI against mock providers and dev sign-in. `.dev.vars` still overrides them for trying a real provider locally. Builds and `wrangler deploy` are unaffected.

Upgrading a site: merge upstream. If your site already had production values in `wrangler.jsonc`, local dev and e2e now run in development mode again; if you had relied on `vars` to point dev at a real provider, move that to `.dev.vars`. No new vars, secrets or migrations.

dev server 一律使用开发值：`vite dev` 时用 `LOCAL_DEV_VARS` 覆盖 `APP_ENV`、`SITE_URL`、支付/视频/审核服务商、`ADMIN_EMAILS`、`EMAIL_FROM`、`GOOGLE_CLIENT_ID` 和 `TURNSTILE_SITE_KEY`，站点的 `wrangler.jsonc` 可以直接写生产值，本地开发、e2e、CI 仍走 mock 和开发登录；要在本地试真实服务商写进 `.dev.vars`。构建和部署不受影响。站点升级：合并 upstream；原来靠 `vars` 让本地连真实服务商的，改写到 `.dev.vars`；没有新增 vars、密钥和迁移。

### Added: two-step yir mode

- `site.video.yir.scene` (`null` by default): an image model first puts the person from the user's photo into the source video's first frame, then Kling Motion Control uses the composite as its reference, so the clip keeps the source video's scene instead of the photo's background.
- The composite is uploaded to the yir Files API and referenced by a fixed `file_id`, so resubmits send the same body and aren't billed twice. Estimated cost adds `scene.costCents` per order.
- Providers can return `{ state: 'pending', next }` from `status()`; `jobs.ts` writes the next provider job back with a compare-and-set on the previous request id, so a webhook and a scheduled poll advancing at the same time write once.
- `npm run seed:local` now uploads `.jpg` files in `seed/templates/` as well as `.mp4`.

Upgrading a site: merge upstream. Nothing changes unless you set `site.video.yir.scene`; then put the frame in `seed/templates/` and upload it to `templates/` in R2 (`--content-type image/jpeg`). No new vars, secrets or migrations.

新增 yir 两步走（`site.video.yir.scene`，默认关闭）：先用图片模型把照片里的人合成进源视频首帧，再用合成图做 Kling 动作参考，成片保留源视频场景。合成图传进 yir Files API，用固定 `file_id` 引用，重复提交不重复计费；每单估算成本加 `scene.costCents`。`status()` 可返回带 `next` 的 pending，jobs.ts 按旧任务 id 抢占写回，webhook 和轮询同时推进只写一次。`seed:local` 同时上传 jpg。站点升级：合并 upstream；不配 `scene` 行为不变，配了要把首帧图放进 `seed/templates/` 并上传到 R2 的 `templates/`；没有新增 vars、密钥和迁移。

### Added: Stripe payments

- `PAYMENT_PROVIDER=stripe`: credit packs and subscriptions through Stripe Checkout, partial refunds from the admin, order reconcile, cancel / resume renewal, and the customer portal. Webhook: `/api/webhooks/stripe`.
- Webhooks are verified with `STRIPE_WEBHOOK_SECRET` and the `livemode` flag must match `STRIPE_ENVIRONMENT`; checkout sessions and invoices are fetched again with a pinned API version before crediting. Subscriptions are credited on `invoice.paid`.
- `scripts/stripe-setup.mjs` creates Products, Prices and the webhook endpoint (re-runs reuse them by lookup key). The launch check compares the key prefix with `STRIPE_ENVIRONMENT`; "Test connections" checks each Price's amount, currency, type and interval.
- Tested in a Stripe sandbox: payment, declined card, partial refund and a monthly subscription (cancel, resume, portal) all pass with real webhooks.
- Stripe is not a Merchant of Record: you handle sales tax and invoices yourself.

Upgrading a site: merge upstream, add `STRIPE_ENVIRONMENT` and `STRIPE_PRODUCTS` to `vars` (already in the template's `wrangler*.jsonc`), and set the two secrets only if the site switches to Stripe. No migration. Setup: [docs/payments.md](docs/payments.md) → "Stripe".

新增 Stripe 支付：积分包、订阅、后台部分退款、主动查单、取消/撤销续费和客户门户。webhook 验签并核对 `livemode`，入账前按固定 API 版本重新取对象，订阅按 `invoice.paid` 入账。`scripts/stripe-setup.mjs` 建商品、价格和 webhook；上线检查核对 Key 前缀，“测试连接”核对每个 Price。已在 Stripe 沙盒用真实 webhook 测通付款、拒付、部分退款和月付订阅。Stripe 不是 MoR，销售税和发票自己处理。站点升级：合并 upstream，`vars` 里加 `STRIPE_ENVIRONMENT`、`STRIPE_PRODUCTS`；只有改用 Stripe 时才需要配两个密钥；没有新迁移。
