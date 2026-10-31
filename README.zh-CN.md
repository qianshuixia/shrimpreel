# ShrimpReel（虾片）

[English](README.md) | 简体中文

作者：[浅水虾](https://x.com/qianshuixia2026)，一只朝着深海出发的浅水虾。

开源的“一张照片 → 跟拍某个爆款视频模板”AI 视频 SaaS 模板。每追一个新热词就建一个站：从本模板建仓库，改配置、文案和素材即可上线。全部跑在 Cloudflare 上：Workers + D1 + R2 + KV + Queues + Rate Limiting + Cron。

https://github.com/user-attachments/assets/895aab94-d0c9-474e-8d90-61a6c551e536

72 秒功能介绍，无声（[英文版](README.md)；MP4 文件在 [docs/media](docs/media)）。画面来自本地运行，示例站 Neon Shuffle AI 和视频素材都是占位演示。

## 用 ShrimpReel 做的站

<a href="https://christmasdanceai.com/?utm_source=github&utm_medium=referral&utm_campaign=shrimpreel"><img src="docs/media/showcase-christmas-dance-ai.jpg" width="600" alt="Christmas Dance AI：一张照片生成精灵舞或圣诞派对舞视频"></a>

[Christmas Dance AI](https://christmasdanceai.com/?utm_source=github&utm_medium=referral&utm_campaign=shrimpreel)：上传一张照片，变身小精灵在圣诞老人的工坊里跳舞，或穿自己的衣服跳圣诞派对舞。两种风格、Google 登录、积分包和订阅，都来自本模板。

> 状态：本地全流程可用（单元测试 + Playwright e2e），上面的站点已在生产环境运行。模板本身不部署。哪些已用真实服务验证、哪些还没有，见 [ROADMAP.md](ROADMAP.md)。

- 前端/SSR：TanStack Start（React 19）+ Tailwind 4，`/` 英文、`/zh` 中文
- API：Hono（`/api/*`、`/media/*`、`/sitemap.xml`、`/robots.txt`、`/llms.txt`、IndexNow key 文件），入口 `src/server.ts`
- 支付：Waffo Pancake（默认）、Dodo Payments，均为 MoR；也可用 Stripe（你自己是商户，销售税自己处理）；`mock` 仅用于本地和 e2e
- 视频：fal.ai queue API（默认），可选 [yir.ai](https://yir.ai/?ref=qianshuixia) 网关或 [NanoAPI](https://nanoapi.ai)；`mock` 仅用于本地和 e2e。见下文“视频服务商”
- 已具备：
  - 用户与积分：Google 登录（含 One Tap）、积分包、月付和年付订阅、积分流水、个人中心（视频/账单/设置/兑换码/邀请链接/注销/导出我的数据）；账单显示实付与退款，订单和积分流水可分页加载，每笔订单有可打印的详情页（税务发票由支付商出具）
  - 订单与生成：订单与部分/全额退款回收、生成任务队列（含死信队列）与失败退积分
  - 增长与运营：来源归因（UTM 与广告点击 ID，首次和最近触达）、访问 → 注册 → 下单 → 支付 → 生成漏斗、GA4 事件（带同意横幅）、成片公开分享页（用户自己开启，带链接预览图）
  - 管理后台：概览（含服务商成本与毛利）、用户、订单、生成、举报下架、留言、支付事件、邮件、审计、经营报表与订单 CSV、兑换码、邀请排行、运营设置与测试连接
    - 用户：按状态、角色、是否付费筛选，按注册时间、最近登录、积分排序；详情页有累计付款、生成统计、订单、积分批次与流水和针对该用户的管理员操作（补发可设有效期）
    - 订单：按订单号、邮箱、支付商流水号搜索；详情页把支付回调、积分变动、管理员操作和邮件合成一条时间线，可在详情页退款、查单或补单
    - 生成：按任务 ID、邮箱、服务商请求 ID 搜索
  - 交易邮件：积分到账、成片完成、生成失败退积分、举报回执（仅登录用户）与处理结果；管理员收新举报、超时提醒和新留言（Cloudflare Email Service，发件箱去重与重试）
  - 合规与内容安全：成片 AI 标识；照片 7 天、成片 30 天自动清理；举报下架（48 小时队列，同一张原图的全部成片一并删除并拉黑）；上传图片审核；联系和举报表单的 Turnstile 人机验证
  - 运维与安全：后台免部署切换维护模式、暂停收款、新订单的收款渠道、全站公告和每日生成上限；健康检查告警邮件、付款即时通知（Telegram、飞书、Discord 等）、D1 每日备份到 R2、前端错误上报到 Workers 日志、CSP（Report-Only，每次请求一个 nonce）与 Permissions-Policy
  - 内容与 SEO：one-page 首页（How it works / What is 区块，可选的痛点和“自己拍 vs 用本站”对比区块）、可扩展的文章集合（`/guides` 列表页、相关文章）、法律页、联系表单；SSR 输出完整的 canonical、hreflang、JSON-LD 和 sitemap；文案按语言拆包；`npm run seo:check` 检查全站

更新日志见 [CHANGELOG.md](CHANGELOG.md)。功能建议与后续规划见 [docs/SAAS_VIDEO_FEATURES.md](docs/SAAS_VIDEO_FEATURES.md) 和 [ROADMAP.md](ROADMAP.md)。SEO 规则、关键词规划和审计结果见 [docs/SEO_AUDIT.md](docs/SEO_AUDIT.md)。全部环境变量和 `site.ts` 上线字段见 [docs/env.md](docs/env.md)，新增支付商的步骤与 webhook 返回码约定见 [docs/payments.md](docs/payments.md)，订阅的开关、套餐和支付商配置见 [docs/subscriptions.md](docs/subscriptions.md)，改代码前的约定（积分、支付入账、双语文案、迁移、e2e）见 [AGENTS.md](AGENTS.md)。

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars       # 至少填 SESSION_SECRET
npm run seed:local                   # 应用 D1 迁移 + 把 seed/templates/ 的 mp4 和 jpg 上传到本地 R2
npm run dev -- --host 127.0.0.1      # http://127.0.0.1:3000
```

- npm 用 11.19 及以上，版本更低时 `package.json` 里的 `devEngines` 会给出警告。用旧版 npm 跑 `npm install` 会把 `package-lock.json` 改写成 CI 上 `npm ci` 不认的结构（报 `Missing: @emnapi/core@… from lock file`）。
- 本地默认 `PAYMENT_PROVIDER=mock`、`VIDEO_PROVIDER=mock`：点购买会进入模拟收银台，生成会复制模板视频作为结果，不花钱。
- 登录页在非 production 环境有“开发登录”（`POST /api/auth/dev-login`），production 返回 404。开发登录、mock 支付和 `/api/dev/*` 只接受本机直连：经过隧道或代理的请求（带 `cf-connecting-ip`、`X-Forwarded-For` 等头）一律返回 404。局域网里的人能伪造这些条件，所以不要用 `--host 0.0.0.0` 启动，也不要把 dev server 直接暴露到公网；联调 webhook 用 `scripts/webhook-proxy.mjs`（见下文）。
- 本地默认 `MODERATION_PROVIDER=mock`：上传表单带 `mockOutcome=reject` 时模拟审核不通过。`TURNSTILE_SITE_KEY` 留空表示不启用人机验证。
- `POST /api/dev/sweep {"days": 8}`（仅本机）：模拟 N 天后的清理，只处理当前登录用户的媒体，用来验证保留期。
- `ADMIN_EMAILS` 里的邮箱登录后可进 `/admin`，本地默认是 `admin@example.com`。这些邮箱是在登录时被设为管理员的，之后从列表里删掉不会撤销角色，要同时在 `/admin/users` 的用户详情页点“取消管理员”。
- 本地发信只是模拟，不会真的发出，结果以发件箱为准：`GET /api/dev/emails?to=<邮箱>&ref=<订单号/举报编号>`（仅本机）。`POST /api/dev/takedown-reminders {"takedownId": "tdr_…", "hours": 37}` 模拟 N 小时后对某条举报跑一次超时提醒。
- Windows：用 `--host 127.0.0.1` 启动，否则 Playwright 等工具连 `localhost` 可能解析到 IPv6 连不上。`npm install` 前先停掉 dev server，否则 `.wrangler` / miniflare 文件被占用会报 `EBUSY`。
- `src/server.ts` 里的 `drainUnreadBody` 只在 dev 生效：当前 miniflare 5 beta 在 Worker 不读完请求体就返回时，会让同一连接上的下一个请求 500 `fetch failed`。升级 `@cloudflare/vite-plugin` 后可以去掉它，再用 `npm run test:e2e` 验证 CSRF 用例。

## 上新词流程

每个热词站是一个独立仓库，把本模板设为 `upstream`。支付、安全和框架的修复在模板里改一次，各站点合并即可。

用 Claude Code 时，建好站点仓库（第 1 步）后可以直接说“上新词：Moon Hop，TikTok 上的月球跳舞”。仓库自带的 `new-hot-site` skill（`.claude/skills/new-hot-site/`）会完成第 2–4 步和第 7 步的本地部分：整理站点简介、跑脚手架、改定价、重写两种语言的文案、生成占位素材，再跑 typecheck、test、build、seo:check 和离线 doctor。它只改站点差异文件，不提交、不部署。缺的信息（正式域名、授权素材等）写成 `TODO(site): …` 注释，`npm run doctor` 会列出来，正式站（`APP_ENV=production`）还有没填的就拦下部署。

1. **建站点仓库**：
   ```bash
   git clone https://github.com/qianshuixia/shrimpreel.git moonhop && cd moonhop
   git remote rename origin upstream
   git remote add origin git@github.com:<owner>/moonhop.git
   ```
   不要用 GitHub 的 “Use this template”：它生成的仓库和模板没有共同历史，之后无法 `git merge upstream/main`。公开仓库的 fork 不能设为私有，站点仓库一般也不用 fork。
2. **跑脚手架**：
   ```bash
   node scripts/new-site.mjs --keyword "Moon Hop" --domain moonhop.ai --keywords "AI dance video,Moon Hop filter"          # 预览
   node scripts/new-site.mjs --keyword "Moon Hop" --domain moonhop.ai --keywords "AI dance video,Moon Hop filter" --write  # 写入
   ```
   脚本一次改好以下内容，并列出剩下必须人工完成的清单：
   - `site.ts`：关键词、品牌、域名、邮箱、默认风格的 `id`（`styles[0].id`）、文章 slug、长尾词、发布/更新日期；同时清空旧站的站长验证、IndexNow key 和统计 ID。
   - `wrangler.jsonc`：资源名和 ratelimit `namespace_id`，D1/KV id 重置为占位值。
   - `package.json`：`name`。
   - 删除 `wrangler.staging.jsonc`（模板自身的预发配置）。

   积分包价格（`packages`）、订阅开关和套餐（`subscriptionsEnabled`、`plans`，开关设为 `false` 只卖积分包）、`durations`、`video.falModel` 按需在 `src/config/site.ts` 手改。套餐可加 `anchorPriceCents` 显示划线原价和折扣，只能填这个套餐真实卖过的价格（欧盟按降价前 30 天内最低价算），新站一般不填。价格页每个包显示“可做 N 条 X 秒或 M 条 Y 秒视频”（买得起的最长和最短时长），包数是 2 或 4 时网格按包数排列。可以加一个正好够最短时长的单条包（如 6 积分 $4.99）给只想做一条的人；余额不足时生成器的主按钮直接下单够用的最便宜的包，不用先跳价格页。
3. **改文案**：`src/content/en.ts`、`src/content/zh.ts`。文案通过 `{keyword}` 等变量套用。每个词至少要重写 hero、whatIs、ideas、FAQ 和两篇文章，首页正文要自然覆盖长尾词。首页的痛点（`problem`）和对比（`withWithout`）区块按新趋势改，写不出真实内容就设为 `null`，不渲染。整站只换关键词会被 Google 判为 [scaled content abuse](https://developers.google.com/search/docs/essentials/spam-policies#scaled-content)。
   - **文章**：在 `site.ts` 的 `articles` 加一项（`key`、`slug`、发布和更新日期，可选 `related`），再在每种语言的 `articles` 里补同名 key，缺了 typecheck 会报错。可选的 `cover` 是 `public/` 下 1200×630 的封面，显示在 `/guides` 卡片和文章顶部，并用作该文章的 `og:image` 和 Article 结构化数据的 `image`；不填就没有卡片图，分享图用 `public/og.png`。封面用 `node scripts/article-cover.mjs public/guides/<slug>.jpg --tag Guide --title "短标题" public/demo/original.mp4@1 public/demo/ai1.mp4@2` 从站点自己的视频截帧（也可以用图片）生成，带标题、分类标签和品牌名；`--layout` 可选 `row`、`before-after`（照片 → 成片）、`vs`、`hero`、`grid`、`full`（一张横图铺满）。选项见脚本开头；用 Playwright 的 Chromium 渲染，截视频帧需要 ffmpeg。文章页地址是 `/<slug>`，自动进入 `/guides` 列表、sitemap 和其它文章的“相关文章”。`trend`、`howTo` 两篇被首页直接链接，不要删。建议每站至少一篇 1,200 词以上的支柱页，加 4–6 篇长尾页（教程、灵感、排错、对比）。
   - 文案按语言拆包，浏览器只下载当前语言（含法律页全文）。组件里照常用 `getContent(locale)`；只有在根路由之外、渲染之前要用文案时，才需要先 `await loadContent(locale)`。
   - 加一种语言：在 `site.ts` 的 `LOCALES` 和 `LOCALE_META` 里登记，新建 `src/content/<locale>.ts`（类型与 `en.ts` 一致），再在 `src/lib/i18n.ts` 的 `loaders` 里加一行动态 import。
4. **换素材**：
   - `seed/templates/<风格 id>-<秒数>s.mp4`：生成用的源视频，每种风格的每个时长档位一段（`site.styles[].sources`），部署后上传到 R2 的 `templates/`。
   - `public/demo/*`：首页展示视频和海报。必须是自有或已获授权的素材，在 `site.styles[].examples.*.credit` 写明来源。
   - `public/og.png`、`public/favicon.svg`。
   - **多种舞蹈风格**（可选）：在 `site.styles` 里加项。每项有 `id`（写入 `generations.template_id`，发布后不要改）、`sources`（每个 `durations[].id` 一个文件）、`prompt`（`null` = 用 `video.yir.prompt` / `video.nanoapi.prompt`）、`scene`（yir 两步走的 `{ frame, prompt }`，`null` = 单步）和 `examples`（`original`、`aiVersions`、`madeWith`）。第一项是默认风格。同时在 `en.ts`、`zh.ts` 补 `styles['<id>'] = { name, tagline }`。只有一种风格时界面没有风格选择；多于一种时生成器出现选择（`/?style=<id>` 预选），首页 hero 出现风格标签，“Made with”每种风格一行。
   - `node scripts/generate-placeholder-media.mjs`（需要 ffmpeg）按 `site.styles[].sources` 的文件名和品牌名重新生成原创占位素材。之后删掉 `seed/templates/` 里旧风格的文件。
5. **改 `wrangler.jsonc` 的 `vars`**：`SITE_URL`、`APP_ENV=production`、`PAYMENT_PROVIDER`、`VIDEO_PROVIDER`、`MODERATION_PROVIDER`、`TURNSTILE_SITE_KEY`、`ADMIN_EMAILS`、`EMAIL_FROM`、`*_PRODUCTS`、`GOOGLE_CLIENT_ID`；创建资源后把 D1/KV id 写回（见下文）。
6. **在支付商后台建商品**：每个积分包一个一次性商品、每个订阅套餐一个订阅商品，product id 写进 `WAFFO_PRODUCTS`、`DODO_PRODUCTS` 或 `STRIPE_PRODUCTS`（Stripe 填 Price ID `price_...`），例如 `{"starter":"prod_xxx","party":"prod_yyy","squad":"prod_zzz","monthly":"prod_aaa","yearly":"prod_bbb"}`。Waffo 卖订阅还要配 `WAFFO_STORE_ID`，客户门户要用；关掉订阅开关时 setup 脚本不建套餐商品。Waffo 可用 `node scripts/waffo-setup.mjs --store STO_xxx --apply` 批量创建，Dodo 可用 `node scripts/dodo-setup.mjs --apply --write-dev-vars`（加 `--webhook <url>` 同时建 webhook 并把签名密钥写进 `.dev.vars`；几个站共用一个 Dodo business 时加 `--brand <brand_id>`，商品建在这个站的品牌下，结账页显示这个站的名字和 Logo），Stripe 可用 `node scripts/stripe-setup.mjs --apply --write-dev-vars`（`--webhook` 用法相同）。页面价格只用于展示，实际收费以支付商后台为准，两边要一致。
7. **本地验证**：`npm run typecheck && npm test && npm run test:e2e && npm run seo:check`，然后部署（`npm run deploy` 会先跑部署前体检，见下文）。
8. **上线后**：
   - 运行 `npm run seo:check -- --base https://<domain> --production`。
   - 在 Search Console 和 Bing Webmaster 验证站点，提交 `https://<domain>/sitemap.xml`。
   - 配置了 `site.seo.indexNowKey` 时，运行 `npm run seo:indexnow -- --submit`。
   - 用 Claude Code 时，`launch-audit` skill 会一次跑完这些检查和其余上线清单（见“部署到 Cloudflare”）。

### 合并模板更新

用 Claude Code 时直接说“同步模板”。`sync-upstream` skill（`.claude/skills/sync-upstream/`）会先出同步计划，再合并、按下面的分层解决冲突、补本地配置并跑完整验证，合并结果停在暂存区等你确认后再提交。站点里还没有这个 skill 时，让它读模板里的版本：`git show upstream/main:.claude/skills/sync-upstream/SKILL.md`（Windows Git Bash 前面加 `MSYS_NO_PATHCONV=1`）。

手工合并：

```bash
git fetch upstream
git show upstream/main:scripts/sync-plan.mjs > .tmp/sync-plan.mjs && node .tmp/sync-plan.mjs   # 同步计划，只读
git merge --no-ff upstream/main
npm install && npm run typecheck && npm test && npm run test:e2e
npm run db:migrate:remote   # 模板新增了 migrations/ 时，部署前先应用
```

- 同步计划用模板最新版的 `scripts/sync-plan.mjs`，列出：同步基线、模板的新提交、按层归类的改动（共用代码 / 站点层 / 站点已删除 / 依赖锁）、两边都改过的文件、站点改过的共用文件、新 migration、新增的 vars 和密钥。`--json` 输出机器可读结果。
- 基线是 `git merge-base HEAD upstream/main`，只能用 `git merge` 同步。squash、rebase 或 cherry-pick 模板提交会让基线停在原地，下次计划会重复列出已合过的提交。
- 合并提交信息末尾加一行 `Template-sync: <模板 commit sha>`（计划最后会打印），`git log --grep "Template-sync:"` 可以查历次同步。
- 站点差异只放在 `src/config/site.ts`、`src/content/*`、`public/*`、`seed/`、`wrangler.jsonc` 和 `package.json` 的 `name`。其它文件和模板保持一致：共用代码的 bug 在模板里修，再合并到各站，不要只改一个站。
- 这些文件冲突时，保留站点自己的值，同时接受模板新增的键；文案缺键时 typecheck 会报错。
- 模板改了 `wrangler.staging.jsonc` 时，站点里会出现“修改/删除”冲突，用 `git rm wrangler.staging.jsonc` 解决。

## 部署到 Cloudflare

首次为一个新站创建资源（名称与 `wrangler.jsonc` 保持一致）：

```bash
npx wrangler d1 create <name>                  # 把输出的 database_id 写进 wrangler.jsonc
npx wrangler r2 bucket create <name>-media
npx wrangler kv namespace create <name>-kv     # 把 id 写进 wrangler.jsonc；标题在账号内唯一，不要都叫 KV
npx wrangler queues create <name>-jobs
npx wrangler queues create <name>-jobs-dlq
npm run db:migrate:remote                      # 0003 保留期、举报下架和图片拉黑；0004 邮件发件箱
npx wrangler r2 object put <name>-media/templates/<file>.mp4 --file seed/templates/<file>.mp4 --content-type video/mp4 --remote
```

- `ratelimits[].namespace_id` 在同一账号内要唯一，多个站点不要共用同一组数字。
- 密钥：`SESSION_SECRET`、`GOOGLE_CLIENT_SECRET`、`WAFFO_MERCHANT_ID`、`WAFFO_PRIVATE_KEY`、`DODO_API_KEY`、`DODO_WEBHOOK_SECRET`、`FAL_KEY`；用 Stripe 时是 `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`；按需加 `YIR_API_KEY`（`VIDEO_PROVIDER=yir`）、`NANOAPI_API_KEY`（`VIDEO_PROVIDER=nanoapi`）、`OPENAI_API_KEY`（图片审核）、`TURNSTILE_SECRET_KEY`。可以逐个 `npx wrangler secret put <NAME>`，也可以用 `scripts/sync-secrets.mjs` 一次同步：
  ```bash
  cp .dev.vars.example .dev.vars.production     # 填上线用的值；.dev.vars.* 已被 .gitignore 忽略
  node scripts/sync-secrets.mjs                 # 只出计划：新增、已存在、只在远端、同步后仍缺，不打印任何值
  node scripts/sync-secrets.mjs --apply         # 写入远端还没有的 secret
  ```
  - 写入时值经 stdin 交给 `wrangler secret bulk`，不落临时文件，wrangler 的输出也会先脱敏再打印。
  - 已存在的 secret 默认不覆盖（换 `SESSION_SECRET` 会让所有登录和已签名的图片地址失效），要覆盖加 `--overwrite`。远端多出来的 secret 只列出，不删除。
  - 写入前会拒绝：文件没被 `.gitignore` 忽略、键名不在 `.dev.vars.example` 里或是 var、值为空或仍是占位值、`SESSION_SECRET` 太弱。读不到远端列表（未登录，或首次部署时 Worker 还不存在）时，要加 `--overwrite` 才写入；Worker 不存在时 wrangler 会先创建它。
  - 预发：`node scripts/sync-secrets.mjs -c wrangler.staging.jsonc --file .dev.vars.staging`。
  - `SESSION_SECRET` 用于签名交给视频服务商的图片地址和视频服务商回调 token，用 `openssl rand -hex 32` 生成。production 和 staging 下，缺失、短于 32 个字符或仍是 `.dev.vars.example` 里的值时会被拒绝：任务提交不出去（队列重试完后判失败并退积分，Workers Logs 写明原因），`/media/uploads/*` 返回 503。
- 同时配好 R2 生命周期规则，见下文“合规与内容安全”。
- 发信域名要在 Email Service 完成 Onboard，见下文“交易邮件”。
- 部署前体检：`npm run doctor`，`npm run deploy` 会先跑它，有错误就停下。
  - 检查 `APP_ENV`、`SITE_URL` 与 `site.domain` 是否一致、是否误用 mock、所选支付/视频/审核服务商需要的密钥、`*_PRODUCTS` 是否覆盖全部积分包、绑定和资源 id 是否还是占位值、Cron 与死信队列、站点文件里没填完的 `TODO(site)`，以及远端 D1 是否还有未应用的 migration。
  - 密钥只用 `wrangler secret list` 核对名字，不读取值。需要已登录 wrangler；首次部署时 Worker 还不存在，先写密钥（`wrangler secret put` 或 `sync-secrets --apply --overwrite`，都会创建 Worker）。`--offline` 跳过所有远端查询，`-c wrangler.staging.jsonc` 检查预发配置。
  - 后台概览的“上线配置检查”卡片按运行时 env 跑同一套规则（规则在 `src/server/config-health.ts`），还会检查 `SESSION_SECRET` 强度；只显示问题，不显示任何值。
- 部署：`npm run deploy`。在 Cloudflare 控制台给 Worker 绑定自定义域名，`SITE_URL` 和 `site.domain` 要与之一致（canonical、sitemap 和 CSRF 同源校验都依赖它）。
  - 上线时把 `wrangler.jsonc` 的 `vars` 改成生产值（`APP_ENV=production`、正式域名、真实服务商）。dev server（本地开发、e2e、CI）不读这些值：`vite.config.ts` 的 `LOCAL_DEV_VARS` 把环境、域名、服务商、支付商的 test/live 环境（固定为 test）、管理员、发件地址、Google 和 Turnstile 换成开发值，开发登录和 mock 照常可用。要在本地试真实服务商，写进 `.dev.vars` 覆盖。
- `APP_ENV=production` 或 `staging` 时，若仍配置 `mock` 支付、`mock` 视频或 `mock` 审核，下单、生成和上传会返回 503；开发登录、mock 支付接口和 `/checkout/mock` 页面返回 404。`robots.txt` 只在 production 放开抓取。
- 部署后巡检：`SMOKE_BASE_URL=https://<domain> npm run test:smoke`，预发加 `SMOKE_EXPECT=staging`。
- 用 GitHub Actions 发布：站点仓库把 [.github/workflows/deploy.yml.example](.github/workflows/deploy.yml.example) 复制为 `deploy.yml`，手动触发后依次跑 typecheck、单元测试、离线体检、`db:migrate:remote`、`npm run deploy` 和部署后巡检（报告作为 artifact 上传）。
  - 在仓库 Settings → Environments 建 `production`（建议加 Required reviewers），放 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。Token 用“Edit Cloudflare Workers”模板，再加 Account 级的 D1 Edit 和 Queues Edit（模板本身不含这两项）。
  - 运行时密钥不经过 CI，在本地用 sync-secrets 同步；建资源、上传源视频、绑定域名这些首次部署步骤也在本地做完。
  - 巡检失败时新版本已经上线：看 artifact 里的报告，必要时 `npx wrangler rollback` 回到上一版。migration 不会回滚，所以 migration 要兼容上一版代码。
- 上线体检：用 Claude Code 时说“上线检查”。`launch-audit` skill（`.claude/skills/launch-audit/`）依次跑部署前检查（typecheck、test、build、doctor、`TODO(site)`）和线上检查（seo:check、test:smoke、HTTPS 与 R2 源视频、移动端 Lighthouse 和截图），再逐项核对站长平台、真实付款退款、发信域名、R2 生命周期、Google OAuth 等人工项，报告写到 `.tmp/launch-audit/<日期>/report.md`，结论分“可以上线”“可以上线，有待办”“不能上线”。全程只读，不部署、不迁移、不写密钥。
  - 只发 GET 和必然被拒的 POST：不登录、不下单、不写数据，可以随时对正式站跑。浏览器 UA 带 bot 标识，不计入访问报表；发现开发登录开着时直接判失败，不再请求开发接口。
  - 检查 sitemap 里的页面全部 200 且没有脚本错误；中英文首页（含深色模式）水合；开发登录关闭、支付商不是 mock；开发与 mock 接口和 `/checkout/mock` 页面都是 404；跨站 POST 被拦；未签名的支付与视频服务商回调返回 401；安全响应头（https 下含 HSTS）；robots.txt 符合环境。
  - 报告和失败时的 trace 在 `.tmp/smoke-prod/`。
- 自定义域名可用后，在站点的 `wrangler.jsonc` 里设 `"workers_dev": false` 和 `"preview_urls": false`。否则正式 Worker 还会在 `*.workers.dev` 上响应，绕过你在域名上配置的 WAF 和限流规则；每个版本还有一个公开的 [Version URL](https://developers.cloudflare.com/workers/configuration/previews/)，用同一套 D1、R2 运行该版本的代码。模板默认开着 `workers_dev`，是为了新站在绑定域名前也能访问。

### 模板预发（workers.dev）

没有域名时，用 [wrangler.staging.jsonc](wrangler.staging.jsonc) 把模板本身部署到 `https://video-template-staging.<子域名>.workers.dev`，用来验证真实绑定、Google 登录、支付商 test 模式和视频服务商回调。

- `APP_ENV=staging`：和 production 一样禁用 mock 与开发登录，Cookie 加 Secure；但 `robots.txt` 禁止抓取。canonical 仍指向 `site.domain`。
- 资源名都带 `-staging`，与正式站隔离。`tests/unit/staging.test.ts` 会检查它和 `wrangler.jsonc` 的绑定、vars 键是否一致。new-site 会删除这个文件。
- 不发交易邮件（`EMAIL_FROM` 为空），默认不做图片审核（`MODERATION_PROVIDER=none`）。

```bash
npx wrangler d1 create video-template-staging                # database_id 写进 wrangler.staging.jsonc
npx wrangler r2 bucket create video-template-staging-media
npx wrangler kv namespace create video-template-staging-kv   # id 写进 wrangler.staging.jsonc
npx wrangler queues create video-template-staging-jobs
npx wrangler queues create video-template-staging-jobs-dlq
npx wrangler r2 bucket lifecycle add video-template-staging-media expire-uploads uploads/ --expire-days 8
npx wrangler r2 bucket lifecycle add video-template-staging-media expire-outputs outputs/ --expire-days 31
npx wrangler d1 migrations apply DB --remote -c wrangler.staging.jsonc
npx wrangler r2 object put video-template-staging-media/templates/<file>.mp4 --file seed/templates/<file>.mp4 --content-type video/mp4 --remote
npm run doctor -- -c wrangler.staging.jsonc                 # 部署前体检
npx vite build --mode staging && npx wrangler deploy         # deploy 读取构建产物里的 staging 配置
node scripts/sync-secrets.mjs -c wrangler.staging.jsonc --file .dev.vars.staging --apply   # 或逐个 wrangler secret put <NAME> -c wrangler.staging.jsonc
SMOKE_BASE_URL=https://video-template-staging.<子域名>.workers.dev SMOKE_EXPECT=staging npm run test:smoke   # 部署后巡检
```

- 除 `deploy` 外，staging 的 wrangler 命令都要带 `-c wrangler.staging.jsonc`：不带时，`deploy` 这类命令会跟随最近一次构建产物里的配置。`npm run deploy` 会先按 `wrangler.jsonc` 重新构建。
- 下表的回调地址把 `<domain>` 换成 workers.dev 地址。Waffo 和 Dodo 只用 test 店铺，Stripe 只用沙盒。

### 第三方回调地址

| 服务 | 配置位置 | 地址 |
| --- | --- | --- |
| Google OAuth | Google Cloud Console → Authorized redirect URIs | `https://<domain>/api/auth/google/callback` |
| Waffo Pancake | Dashboard → Settings → Webhooks | `https://<domain>/api/webhooks/waffo` |
| Dodo Payments | Dashboard → Webhooks | `https://<domain>/api/webhooks/dodo` |
| Stripe | Developers → Webhooks（或 `stripe-setup.mjs --webhook`） | `https://<domain>/api/webhooks/stripe` |
| fal.ai | 代码自动带上 | `https://<domain>/api/webhooks/fal` |
| yir.ai | 代码自动带上（只有 https 地址才带，本地开发靠轮询） | `https://<domain>/api/webhooks/yir` |
| NanoAPI | 代码自动带上（只有 https 地址才带，本地开发靠轮询） | `https://<domain>/api/webhooks/nanoapi` |

- **Waffo**：`WAFFO_ENVIRONMENT` 为 `test` 或 `prod`。webhook 用 Waffo 公开的 RSA 公钥验签（已内置在 `src/server/payments/waffo.ts`），无需另配密钥。`WAFFO_PRIVATE_KEY` 支持 PKCS1/PKCS8，可以写成单行带 `\n` 的形式。
  - 退款是异步的：后台发起后只拿到工单号 `TKT_`，PSP 处理完才生成 `REF_` 并推送 `refund.succeeded`，test 模式实测要等 12–22 分钟。积分在 webhook 到达时才回收。
  - 每笔支付只能退款一次（可部分），且须在支付后 14 天内。后台会提前拦截，错误码为 `waffo_refund_exists` / `refund_window_expired`。
  - webhook 丢失时用“仅记账”补登，必须填 `REF_` 退款单号（填 `TKT_` 会被拒绝，否则迟到的 webhook 会再扣一次）。
  - webhook 由 Upstash QStash 投递，失败重试只发往创建时填的 URL，所以必须用固定域名。
- **本地联调真实 webhook**：`node scripts/webhook-proxy.mjs --port 3100` 只转发 `POST /api/webhooks/{waffo,dodo,stripe}`，把隧道指向它，不要直接暴露 dev server。用 sandbox e2e 自动跑一遍收银台和 webhook 的做法见 [docs/payments.md](docs/payments.md)。实测 Pinggy 可用（`ssh -p 443 -R0:127.0.0.1:3100 qr@a.pinggy.io`，免费版 60 分钟），localhost.run 经常断线。
- **Dodo**：`DODO_ENVIRONMENT` 为 `test` 或 `live`。webhook 按 Standard Webhooks 规范验签，`DODO_WEBHOOK_SECRET` 填控制台给的 `whsec_...`。
  - API 密钥按资源授权：`dodo-setup.mjs` 需要 Products 写入，加 `--webhook` 还要 Webhooks 写入；运行时需要 Checkout sessions 和 Refunds 写入，主动对账还要 Checkout sessions 和 Payments 读取；卖订阅还要 Subscriptions 写入（取消续费、撤销）、Customers 写入（客户门户）和 Subscriptions 读取。
  - 商户只能在支付后 30 天内退款，可分多次部分退款，但同一时间只能有一笔在处理（[文档](https://docs.dodopayments.com/features/transactions/refunds)）。超过 30 天时后台返回 `refund_window_expired`。
  - 退款从商户钱包余额扣。每笔支付扣掉税费和手续费后才入账，test 模式实测要等约 4–5 分钟。余额不够时 Dodo 返回 409 “Insufficient funds in wallet”，后台显示为 `payment_provider_conflict`。新店或刚提现之后，全额退款经常因此失败。
  - test 模式下退款接口直接返回 `succeeded`，`refund.succeeded` 约 2 秒后到达。积分仍以 webhook 为准回收。
  - webhook 由 Svix 投递。支付事件的 metadata（`orderId` 等）会原样回传；退款事件不带 metadata，靠 `payment_id` 反查订单。隧道换域名后用 `--webhook-id` 改 URL，签名密钥不变。
  - 支付成功或失败都会跳回 `return_url`，并追加 `payment_id`、`status`、`email`（买家邮箱）。GA4 的 `page_location` 已去掉 email。
  - 收银台显示的商户名取自 Dodo 注册信息。上 live 前在后台改成品牌名。
- **Stripe**：`STRIPE_ENVIRONMENT` 为 `test` 或 `live`，要和 Key 前缀（`sk_test_` / `sk_live_`）及 webhook 的 `livemode` 一致。`STRIPE_PRODUCTS` 把积分包和套餐映射到 Price ID。webhook 用 `STRIPE_WEBHOOK_SECRET`（`whsec_...`）验签，checkout session 和账单入账前按固定 API 版本重新取一次。
  - Stripe 不是 MoR：销售税和发票由你负责。退款没有固定期限，可多次部分退款；退款从 Stripe 余额扣，余额不足时挂起为 pending。
  - 订阅按 `invoice.paid` 入账。客户门户要先在 Settings → Billing → Customer portal 保存一次配置才能打开。受限 Key（`rk_`）需要的权限见 [docs/payments.md](docs/payments.md) 的“Stripe”。
- **fal、yir、NanoAPI**：webhook 只当作“该查一下了”的信号，结果总是用 `FAL_KEY`、`YIR_API_KEY` 或 `NANOAPI_API_KEY` 重新拉取。另外每 5 分钟的 Cron 会补查卡住的任务，超过 45 分钟判失败并退积分。

## 关键设计

- **主题**：`site.theme` 选整站外观，写在 `<html data-skin>` 上，访客仍可切换亮色 / 暗色。`classic`（默认）：暖白纸张、品红强调、衬线标题、胶囊按钮；`acid`：锌黑 / 奶白、黄绿强调、无衬线粗标题、小圆角按钮。颜色、字体、圆角都是 `src/styles.css` 里的 CSS 变量，新增主题时在 `src/lib/theme.ts` 登记并写亮色、暗色两组变量（`tests/unit/theme.test.ts` 核对）。
  - 统计同意卡片（填了 `ga4Id` 或 `clarityId` 时启用，只对欧洲经济区、英国、瑞士和无法判断国家的访客自动弹出）在右下角，不挡正文；“接受”和“拒绝”同样大小，× 只收起本次，不记录选择。
  - 页脚“问问 AI”：链接 `/llms.txt`，并列出 ChatGPT、Claude、Perplexity、Gemini（Google AI Mode）、Grok 按钮，带一段预填提问（`footer.askAiPrompt`，含首页和 `llms.txt` 地址）在新标签打开，链接 `nofollow`。
- **积分**：每笔变动都写流水，`idempotency_key` 唯一（`order:<id>`、`order_refund:<id>`、`generation:<id>` 等），与批次、余额更新在同一个 D1 batch 里，重复入账会整体回滚。
  - 批次：每次入账是一个批次（`credit_grants`），可以带到期时间。买的积分永不过期；注册赠送按运营设置里的有效期到期（默认 `site.signupBonusValidDays`，0 = 永不过期）；后台补发时可填有效期（1–3650 天）。
  - 扣费先扣最早到期的批次，永不过期的最后扣，从哪些批次扣了多少记在 `credit_allocations`。分配在 SQL 里完成，余额不足时整个 batch 回滚，并发扣费不会超扣。生成失败按明细原路退回；退款回收时先扣该订单买的批次。
  - 到期：每 5 分钟的 Cron 把到期批次的剩余积分作废，写 `expire` 流水；扣费前也会先作废该用户的到期批次。`users.credits` 是批次剩余之和的缓存，最多比实际多算 5 分钟内刚到期的积分，扣费不受影响。
  - 账单页提示即将到期的积分，后台用户详情显示各批次的剩余和到期时间。
- **兑换码**：后台 `/admin/redeem-codes` 一次生成最多 1000 个随机码（12 位，去掉 I/O/0/1 等易混字符，显示为 `XXXX-XXXX-XXXX`），或指定一个活动码（4–32 位字母数字，如 `LAUNCH2026`），按批导出 CSV。每个码设积分、可用次数（每个账号每个码只能用一次）、可选的积分有效期和兑换截止时间；可以停用，已兑换的积分不受影响。
  - 用户在设置页兑换（`POST /api/redeem`，忽略大小写、空格和横线），按用户和 IP 限流，配置了 Turnstile 时需要人机验证。兑换得到一个来源为 `redeem`、ref 为码的积分批次，到期和扣费规则与其他批次相同。
  - 兑换在一个 D1 batch 里完成：只有码未停用、未过截止时间且次数没用完时才写入兑换记录，随后用一行断言确认写入成功，再加次数、发积分。并发兑换不会超出次数，同一账号重复兑换返回 409 `already_redeemed`。
- **邀请奖励**：每个用户在设置页有一个邀请链接 `/i/<码>`（8 位，去掉易混字符，第一次打开时生成）。好友经链接注册、首单付款后，邀请人获得运营设置里的奖励积分（默认 `site.referralRewardCredits` = 10；`site.ts` 里设为 0 关闭功能并隐藏卡片）。只发积分，不发现金。
  - 链接写入 `vt_ref` Cookie（30 天，`noindex`），注册时消费；只绑定新注册的账号，老用户和邀请人自己都不会被绑定。
  - 防刷：同一邀请人来自同一 IP（加盐哈希，IPv6 按 /64）的注册最多 `site.referralMaxPerIp` 个，超出的记为拒绝；每个邀请人任意 30 天内最多拿 `site.referralMonthlyCap` 次奖励；付款时邀请人已封禁或注销则不发。
  - 奖励和好友的购买入账在同一个 D1 batch 里写入，用断言行保证并发的首单只发一次。奖励订单发生退款（部分退款也算）时整笔回收邀请人的奖励，最多扣到 0，只回收一次。
  - 后台 `/admin/referrals` 按奖励数列出邀请人，并列出最近的邀请记录、状态和拒绝原因。导出我的数据只包含本人这一侧，不含对方的 ID、邮箱和 IP 哈希；功能开启时隐私政策会说明这个 Cookie 和哈希。
- **运营设置**：`/admin/settings` 免部署调整非敏感参数：维护模式、暂停收款、各语言的全站公告、注册赠送积分与有效期、邀请奖励积分、全站每日生成上限（`src/server/settings.ts`）。只把和 `site.ts` 默认值不同的值存进 D1 的 `settings` 表；保存成默认值时删掉那一行，以后改 `site.ts` 仍然生效。读取走 KV 缓存（60 秒），修改最多约 1 分钟在各地生效。密钥仍放 wrangler secrets。每次修改写审计，记录前后值。
  - 维护模式：新的生成和下单返回 503 `maintenance`，前台每页顶部显示维护提示；登录、查看、下载和支付回调照常，管理员不受限制，便于维护期间验证。
  - 暂停收款：支付商还没开通或临时出问题时用。价格页的购买按钮变成不可点的“支付即将开放”，顶部显示说明，新下单返回 503 `checkout_paused`；生成和已建订单的支付回调照常，管理员不受限制。
  - 收款渠道：为新订单覆盖 `PAYMENT_PROVIDER`，留空跟随部署配置。保存前检查目标支付商的密钥、商品 ID 和 Key 模式，不全就拒绝并列出缺的键；已有订单的退款、查单和订阅续费仍走原支付商，各家 webhook 都要保持开着。`npm run doctor` 只看部署配置，后台概览的配置检查按实际生效的支付商。
  - 每日生成上限按 UTC 自然日统计创建的任务数（失败退款的也算），超出返回 429 `daily_limit`，不扣积分；并发提交由同一个 D1 batch 里的断言行兜底。0 = 不限。建议和服务商控制台的消费上限一起用。
  - 邀请奖励设为 0 即暂停邀请（隐藏卡片，链接不再绑定）。暂停期间付款的首单记为拒绝（`paused`），恢复后不会用之后的订单补发。`site.referralRewardCredits` 为 0 时这一项锁定，因为隐私政策按 `site.ts` 生成。
  - “测试连接”逐项探测 R2、KV、发信（给你发一封测试邮件）、支付（Dodo、Stripe：逐个套餐核对商品或 Price 的价格与 `site.ts` 是否一致，售价更低时报失败，因为这样的付款会被判金额不符而不入账；Stripe 还核对一次性/周期价格和扣款周期；Waffo：用不存在的订单号查单，验证签名和鉴权）、视频服务商（鉴权和余额，低于 5 美元提示）和图片审核（鉴权）。探测只读或自行清理，不建收银台、不提交任务，说明文字里的密钥值会被替换掉。
- **订阅**：默认开启，开关是 `site.subscriptionsEnabled`。模板默认月付 $14.90、年付 $149，每月都发 60 积分；开关设为 `false` 就只卖积分包，定价页、条款、退款政策和 FAQ 里的订阅文案一起隐藏，已有订阅照常续费和发积分。开关、改套餐、支付商配置和排查见使用手册 [docs/subscriptions.md](docs/subscriptions.md)。
  - 每次扣款都是一张订单。续费订单号由支付商的付款 ID 派生，重复投递只建一次；续费金额按订阅时锁定的价格核对，对不上的转人工处理。
  - 订阅积分是当月结束作废的批次（流水 reason 为 `subscription`），生成时先于长期积分扣除。年付首付只发第一个月，其余由每 5 分钟的 Cron 按月补发，重复执行不会重发。
  - 状态事件（扣款失败、到期取消、已终止等）按支付商给的发生时间防乱序，迟到的旧事件不会覆盖新状态。同一用户只能有一个有效订阅（409 `subscription_exists`），还会续费时不能注销账号（409 `subscription_active`）。
  - 账单页有订阅卡片：下次续费日、到期取消与撤销、扣款失败提示、支付商客户门户。Waffo 只能在客户门户里撤销取消，门户需要 `WAFFO_STORE_ID`。
  - 退款只回收这张订单发过的订阅积分，之后不再补发年付积分；退款不会取消订阅。不支持换套餐、试用期和暂停。规则和 Dodo、Waffo 的差异见 [docs/payments.md](docs/payments.md) 的“订阅”。
  - test 模式实测（webhook 模式）：Waffo 月付首付、订阅激活、当月积分、客户门户、取消续费全部通过；Dodo 首付、激活、积分和门户地址通过，取消续费和撤销要等 API 密钥补上 Subscriptions 写入后再验证。续费和扣款失败 test 模式触发不了，由单元测试和 mock e2e 覆盖。Waffo 付款事件不带周期且周期只到日期，状态事件到达后会校正周期，当期积分的到期时间跟着对齐。
- **支付事件**：`payment_events (provider, event_id)` 唯一。重放、并发重试、退款后迟到的 paid 都只生效一次。退款按 `MIN(余额, 包内积分)` 回收，流水记录实际扣除量。
  - paid 事件入账前和订单核对：商品要一致（Dodo 商品 ID、Stripe Price ID、Waffo `productMetadata.packageId`），同币种时含税实收不得低于标价；币种不同（Dodo Adaptive Currency）或用了折扣码时不核对金额。不一致的不入账，记为 `mismatch`；找不到订单的 paid 事件记为 `orphan`（`metadata.site` 标明是共用商户号的其他站点的事件直接忽略）。两者都返回 200，并触发“付款待核对”告警：核实后在后台补单，或到支付商后台退款（退款回调到达后订单结案为已退款，不动积分）。
  - 退款事件先于付款事件到达（付款回调还在重试）时记为失败并返回 5xx，等付款入账后由支付商重试。
  - webhook 丢失或迟到时主动向支付商查单（`src/server/reconcile.ts`；Dodo 查 checkout session 再取 payment，Stripe 查 checkout session（带账单行和账单），Waffo 用 GraphQL `payments` 按商户订单号查）：成功页在约 15 秒和 60 秒时各查一次；5 分钟 Cron 查创建 10 分钟到 24 小时之间的 pending 订单，指数退避（约 10、20、40……分钟，每轮最多 10 单）；后台订单详情有“查单”按钮，补单前先用。查到的付款和 webhook 走同一套核对与幂等键，迟到的 webhook 不会重复入账。浏览器只能传订单号，不能传付款状态。已有 `mismatch` 事件的订单留给人工核对。
- **生成**：先扣积分再入队，失败、超时或管理员判失败时自动退回。视频服务商的 webhook 和定时轮询可能同时处理同一个任务，只有一路能把任务置为成功，另一路不会删掉已落库的成片。
- **成片分享**：用户在个人中心对自己的成片点“分享”，生成公开链接 `/v/<随机串>`（16 位，不可枚举，`/zh/v/…` 同样可用）。默认开启；`site.share.enabled` 设为 `false` 时按钮和页面都不出现，换脸、真人类站点建议关闭。
  - 分享页只有视频、AI 角标与声明、“我也做一条”按钮和举报入口，不显示作者信息，HTML 和接口里也没有视频 ID。响应头和 meta 都是 `noindex`，不进 sitemap。
  - 链接预览：开启分享时浏览器从成片截一帧，画成 1200×630 的 JPEG（左上角带 AI 标识）一起上传，作为 `og:image`，成片地址写进 `og:video`。封面和上传照片一样过图片审核（不通过返回 422 `share_rejected`）；截帧失败（浏览器解码不了、超时）时不带封面，用站点默认 OG 图。
  - 媒体走 `/media/shares/<id>/video` 和 `/media/shares/<id>/poster.jpg`，支持 Range，`Cache-Control: public, max-age=300`，所以停止分享后已打开过的访客最多还能从缓存播放 5 分钟。
  - 失效：停止分享后旧链接返回 404，再分享得到新链接；成片到期或因举报下架返回 410，封面随之删除，之后不能再分享；删除视频时封面一并删除。
  - 迁移 `0015_shares.sql` 给 `generations` 加了 `share_id`、`share_poster_key`、`shared_at`。导出我的数据包含分享链接和开启时间；功能开启时隐私政策多一节“分享的视频”。
- **成本与毛利**：出片时把服务商成本写入 `generations.provider_cost_cents`：yir、NanoAPI 账单已结算时记实际扣费，其余按 `site.video` 里的单价估算。
  - fal 按帧计费，16 帧算 1 个视频秒，480p 为 $0.04/视频秒（[价格](https://fal.ai/models/fal-ai/wan/v2.2-14b/animate/replace)）。模板源视频是 24fps，所以成片每秒 6 美分，18 秒约 $1.08。换模型、分辨率或源视频帧率时更新 `costCentsPerVideoSecond` 和 `sourceFps`。
  - 出片后才被判失败的任务（超时、管理员判失败）照样记成本；没出片的失败任务不记。mock 记 0。
  - 后台概览显示近 30 天的服务商成本、消耗积分折算的收入和估算毛利；生成列表逐条显示成本和毛利。每积分实收 = USD 已支付订单的净实收 ÷ 未回收的积分。实际扣费以服务商账单为准。
- **视频服务商**：`VIDEO_PROVIDER` 可选 `fal`（默认）、`yir`、`nanoapi` 或 `mock`。[yir.ai](https://yir.ai/?ref=qianshuixia) 是图片视频 API 网关，启用方法：`VIDEO_PROVIDER=yir`，secret 写 `YIR_API_KEY`，模型和提示词在 `site.video.yir` 里改（`src/server/video/yir.ts`）。
  - yir 没有模板所用的角色替换模型（`wan/v2.2-14b/animate/replace`）。接入用的是 Kling 2.6 Motion Control（reference 模式：照片 + 模板源视频），模板只交付接入代码，没有用真实 key 实测（提交、状态查询和错误映射由单元测试覆盖），效果和单价要自己验证，`costCentsPerSecond: 7` 只是估算，上线前按 [yir 模型页](https://yir.ai/models) 的报价改。
  - 两步走（可选，按风格配 `site.styles[].scene = { frame, prompt }`，默认 `null`；图片模型等共用参数在 `site.video.yir.sceneImage`）：Motion Control 的成片背景取自用户照片。想保留源视频的场景，就先用图片模型（如 `google/nano-banana-2`）把照片里的人合成进源视频首帧，再拿合成图做动作参考。首帧图放在 `seed/templates/`，和源视频一样上传到 R2 的 `templates/`（`--content-type image/jpeg`）。合成图会传进 yir Files API，第二步用固定的 `file_id` 引用，重新提交时请求体不变。每单多一张图的费用（`sceneImage.costCents`），用户照片也会经过图片模型的渠道。
  - 提交时用任务 id 作 `Idempotency-Key`：队列重投或 Worker 中断后重新提交，拿回的是同一个 yir 任务，不会重复计费。yir 按请求体识别同一请求，所以照片签名地址按任务创建时间生成，有效期 2 小时，重新提交时地址不变。
  - 没有用 `max_cost` 给单个任务封顶：yir 对用 URL 引用的素材拒绝 `max_cost`。Motion Control 按参考视频秒数计费，而模板源视频的时长是固定的，单价本身就有上限。整体花费建议在 yir Console 给这个 API Key 设月度额度，超出后提交返回 `YIR_SPEND_LIMIT_EXCEEDED`。
  - yir 除了官方渠道，还可能把任务路由到第三方渠道，用户照片会发给它们。`site.video.yir.routingOnly` 默认 `null`，按 API Key 的 Routing Profile 选渠道，失败时可以换渠道。填渠道 ID（如 `['official']`）后只在这些渠道里选，它们都失败时任务失败。不管选哪种，隐私政策都要列出实际经过的渠道。
  - 余额不足、额度用完、Key 失效或没配 Key 时，任务失败并退积分，同时触发“视频服务商账户”告警（见“监控告警”），不用等失败率攒够。
  - 上游已计费的尝试即使任务失败也会收费，钱包余额可能变成负数。成片结果在 yir 只保留 7 天，模板出片后立即转存到 R2。
  - 利益披露：本 README 里的 yir 链接是作者的推荐链接。按 yir 条款，被推荐账号注册后 6 个月内的消费，作者能拿到 yir 毛利的一部分。不想走推荐链接可以直接访问 [yir.ai](https://yir.ai)。fal 的链接不带推荐。
  - [NanoAPI](https://nanoapi.ai)（`VIDEO_PROVIDER=nanoapi`，secret `NANOAPI_API_KEY`，配置在 `site.video.nanoapi`，代码在 `src/server/video/nanoapi.ts`）用 `genjutsu-1.0` 模型处理照片 + 模板源视频。`mode: 'motion_control'` 让照片里的人做源视频的动作；`'replace_object'` 把源视频里的对象换成照片里的，`prompt` 要写清换哪个。计费秒数是源视频时长（motion_control 四舍五入且至少 4 秒，replace_object 向上取整）乘以对应分辨率的单价（480p $0.117/s、720p $0.273/s、1080p $0.78/s，见[价格](https://nanoapi.ai/docs/genjutsu)）。2026-10-25 用真实 key 实测，480p，源视频 6 秒，每段出片要 4～7 分钟。`motion_control` 保留源视频的场景、动作和照片里的人脸，但衣服也是照片里的；`replace_object` 保留源视频的服装和场景，但人脸会往原舞者的样子靠。要让用户换上戏服，先用图片模型给照片换装，再跑 `motion_control`，模板的 NanoAPI 接入没有做这一步。`replace_object` 把 6.04 秒的视频按 7 秒计费，所以源视频要剪成整秒。
  - NanoAPI 会自己下载照片和源视频：用浏览器 User-Agent，读视频时发 Range 请求。源视频读不了时任务以 `internal_error` 失败（全额退款），不会报 `invalid_media`。实测里，不支持 Range 的服务器和不带扩展名的签名地址都出现过这种情况。模板的 `/media/*` 路由支持 Range，地址以 `.mp4` 结尾。不要在 `/media/*` 前面加人机验证，包括 Bot Fight Mode、Under Attack 模式和 WAF 质询。本地测试不要用 Pinggy 免费隧道，它会给浏览器返回一个提示页。
  - NanoAPI 创建任务没有幂等键，队列重投或 Worker 中断后重新提交会重复扣费。所以创建前先列出最近 3 小时的任务，照片地址和源视频地址都对得上就直接沿用那个任务（照片签名地址按任务创建时间生成，同一任务每次相同，不同任务一定不同）。列表请求失败时提交也失败（可重试的错误会重投），不会在查不了的情况下盲目创建。
  - 没配密钥、密钥失效、余额用完或账户被停用时，任务失败并退积分，同时立即触发“视频服务商账户”告警。NanoAPI 的 Key 没有月度额度，余额要自己在 NanoAPI 控制台盯着。结果每 30 秒轮询一次（文档要求间隔不少于 15 秒）。
- **安全**：非 GET 的 `/api/*`（webhook、CSP 报告和前端错误上报除外）要求 `Origin` 与站点同源；上传按文件头校验真实类型；上传和生成按用户限流；封禁用户会立即使会话失效；管理操作写入 `admin_audit`。
  - 登录后的 `redirect`（登录页和 Google 回调）只接受站内路径：`src/lib/redirect.ts` 拒绝反斜杠、控制字符，以及规范化后以 `//` 开头的地址，所以 `/sign-in?redirect=/\evil.com` 这类链接会落到个人中心。
  - 5xx 错误只对管理员返回 `message`；其他人只拿到错误码，详情以 `[api] <method> <path> <code>: <message>` 写入 Workers Logs。
  - Google 登录：授权码流程带 PKCE（S256）和 nonce；One Tap 初始化前先从 `/api/auth/google/nonce` 取 nonce（同时写进 cookie），提交时两者必须一致。
  - 账号以 Google 的 `sub` 为准：同一邮箱换了 Google 账号（`sub` 不同）会被拒绝登录，登录页提示联系客服（`account_conflict`）；dev 登录建的账号（没有 `sub`）在第一次 Google 登录时绑定。
  - 注销账号只保留邮箱的加盐哈希（`deleted_accounts` 表，盐是 `SESSION_SECRET`），同一邮箱重新注册时不发注册赠送、不绑定邀请人。更换 `SESSION_SECRET` 后旧记录对不上。
  - 上传请求必须带 `Content-Length`（否则 411），超过上限直接 413，不读请求体。服务商成片超过 100 MB 判失败并退积分；带长度时流式写入 R2，没带长度时边读边计数，超过 48 MB 即停止。
  - 支付结果页带 `order` 以外的参数（Dodo 回跳会附带买家邮箱）时，Worker 先 302 去掉再渲染，邮箱不会进入页面、统计、错误上报和浏览器历史；第一次请求的 URL 仍会出现在 Workers 日志里。
  - 举报表单不需要登录：回执只发给已登录、且填的是本人账号邮箱的举报人，防止表单被用来给任意地址发信；举报编号在提交后的页面上显示，处理结果仍发到填写的邮箱。
  - 报告安全漏洞见 [SECURITY.md](SECURITY.md)。
- **CSP**：页面响应带 `Content-Security-Policy-Report-Only`，策略在 `src/server/csp.ts`。
  - 每次请求生成 nonce（`src/server.ts` → `src/router.tsx` 的 `ssr.nonce`），框架输出的内联脚本都会带上它，`script-src` 不放开 `'unsafe-inline'`。自定义内联脚本放进 `__root.tsx` 的 `headScripts()`，不要直接写 `<script>`。
  - 已按官方文档放行 GA4、Cloudflare Web Analytics、Turnstile、Google 登录；接入新的第三方脚本、iframe 或接口时要在 `csp.ts` 里补来源。
  - 违规报告发到 `/api/csp-report`，只写 Workers 日志 `[csp] <指令> blocked=… page=…`（URL 去掉 query，按 IP 限流）。上线观察一段时间没有误报后，把 `server.ts` 里的头名改成 `Content-Security-Policy` 即可强制执行。
  - 所有响应都带 `Permissions-Policy`，关闭摄像头、麦克风、定位、支付和 USB。

## 合规与内容安全

- **AI 标识**：生成器和个人中心的播放器左上角有 “AI-generated” 角标，下方提示分享时保留标识。下载文件名为 `<brand>-ai-video-<视频 ID>.mp4`，举报人凭文件名即可定位。成片里没有烧录水印，也没有写入 C2PA（需要 Containers，见 [FEATURES P0-1](docs/SAAS_VIDEO_FEATURES.md)）。分享页同样显示角标和 AI 生成声明，链接预览图左上角也带 AI 标识。
- **数据保留**：由 `site.retention` 控制，默认原图 7 天、成片 30 天，隐私政策文案自动读取这两个天数。
  - 每 5 分钟的 Cron 删除到期的 R2 对象，并在 D1 记 `expired_at`，每类每次最多处理 90 条。进行中任务用到的原图不删。
  - 过期后个人中心显示“已过期”，视频接口返回 410 `media_expired`。订单和积分流水不受影响。
  - 另配 R2 生命周期规则兜底，天数比代码多 1 天，避免抢在 D1 标记之前删除。不要给 `templates/` 配规则。
    ```bash
    npx wrangler r2 bucket lifecycle add <name>-media expire-uploads uploads/ --expire-days 8
    npx wrangler r2 bucket lifecycle add <name>-media expire-outputs outputs/ --expire-days 31
    ```
- **举报下架**：页脚 “Report content” 进入 `/report`，无需登录。
  - 表单字段：签名、邮箱、内容定位、原因、未同意声明。提交后写入 `takedown_requests`，截止时间为 48 小时后（`site.takedownSlaHours`）。内容定位里能识别出 `gen_` 视频 ID 或分享链接（`/v/<id>`，可带语言前缀）时自动关联；分享页的举报入口会把分享地址预填进表单。
  - 管理员在 `/admin/takedowns` 处理，概览页显示待处理数和超时数。
  - 下架：按原图 SHA-256 找出同一张照片的全部上传和成片，然后：
    - 进行中的任务判失败并退积分；
    - 删除 R2 对象（含分享封面）并标记 `removed_at`，分享链接返回 410；
    - 哈希写入 `blocked_media`，此后再上传同一张图返回 422 `content_rejected`。
  - 驳回：必须填写原因。
  - 两种处理都写入 `admin_audit`。新举报、截止前 12 小时和超时时会给 `ADMIN_EMAILS` 发邮件（见“交易邮件”），但仍需要有人每天看队列。
- **上传审核**：用 `MODERATION_PROVIDER` 选择。审核在写 R2 之前完成，不通过的图片不落盘，也不扣积分。
  - `openai`：调用 OpenAI `omni-moderation-latest`（免费），需要 `OPENAI_API_KEY`。拦截 sexual、violence/graphic、self-harm 类别。接口失败时拒绝上传，返回 503。
  - `none`：不审核。
  - `mock`：仅限非 production。
  - 未成年人和名人识别不在 OpenAI 的图片类别里，这两类仍依赖同意声明和举报下架。
- **Turnstile**：在 Cloudflare 控制台创建 widget，站点密钥写进 `vars.TURNSTILE_SITE_KEY`，再执行 `npx wrangler secret put TURNSTILE_SECRET_KEY`。
  - 目前只保护联系和举报两个匿名表单。登录和生成依靠 Google 登录加限流；开放免费试用时再接入。
  - 配了站点密钥但没配 secret 时，两个表单返回 503，不会静默放行。
- **统计与 Cookie**：在 `site.analytics` 配置，隐私政策的“Cookie 与统计”一节会按配置自动调整。
  - 推荐只填 `cfBeaconToken`（Cloudflare Web Analytics）：不写 Cookie，不需要同意横幅。
  - Umami（可选）：填 `analytics.umamiWebsiteId` 和 `vars.UMAMI_ORIGIN`（实例地址，如 `https://umami.example.com`）。页面加载本站的 `/s/script.js`，上报到本站的 `/s/api/send`，由 Worker（`src/server/umami.ts`）代理，网页源码和 JS 里看不到实例域名。不写 Cookie，不受同意横幅控制；代理不转发 Cookie，访客 IP（`CF-Connecting-IP`）只用于判断国家和统计独立访客。只有 `APP_ENV=production` 才上报；本地 dev、e2e、staging 拿到的是空脚本，什么都不转发。`/admin` 后台页面不上报。
  - Microsoft Clarity（可选，热力图和会话回放）：`analytics.clarityId` 填项目 ID。只在 `site.domain`（含 `www.`）上加载，本地 dev、e2e、staging 和 `/admin` 都不加载。填了它也会出现同意横幅：访客接受前 Clarity 以无 Cookie 模式录制（`consentv2` 的 `analytics_Storage: denied`，每次页面浏览一个 ID），接受后才写 `_clck` / `_clsk`，拒绝时 Clarity 删除它们。在 Clarity 后台 Settings → Setup 把 **Cookies** 关掉，让项目按这些同意信号工作。表单输入由 Clarity 默认的遮盖规则隐藏。CSP 已放行 `https://*.clarity.ms` 和 `https://c.bing.com`。
  - 填了 `ga4Id` 才启用 GA4，同时出现同意横幅和页脚 “Cookie settings”。采用 Consent Mode v2 basic 模式：访客接受前不加载 gtag.js，事件只进 `dataLayer`；广告类同意项始终为 denied。拒绝或撤回时删除 `_ga`、`_ga_*`、`_gid`（当前主机和各级父域）。选择存在 `localStorage` 的 `consent.analytics`，逻辑见 `src/lib/consent.ts`。
  - 按地区取默认值（和多数面向消费者的网站一样）：Worker 读 `cf-ipcountry`，把默认值写在 `<html data-consent-default>` 上。欧洲经济区、英国、瑞士的访客，以及国家未知的访客（`XX`、`T1` 或没有这个头，本地开发属于这一类）默认 `denied` 并弹横幅；其他地区默认 `granted`、不弹横幅，GA4、Clarity 的 Cookie 和 `vt_attr` 从第一个页面就生效，页脚“Cookie 设置”可以打开卡片拒绝。存储的选择始终优先于默认值。隐私政策按这个区分说明。
  - 来源归因写第一方 Cookie `vt_attr`（90 天）。填了 `ga4Id` 时它和 GA4 一样等访客接受后才写入：接受时补记本次访问的来源，拒绝或撤回时删除；没写 Cookie 的访客，注册和订单记为 direct，访问统计照常计数。没填 `ga4Id` 时没有横幅，`vt_attr` 直接写入；按欧盟 ePrivacy 的严格解释这也需要事先同意，主要面向欧盟用户时应启用横幅。逻辑见 `src/lib/attribution.ts`。
- **导出我的数据**（GDPR 第 15、20 条）：个人中心设置页可下载 JSON（`GET /api/account/export`），包含账号、会话、订单、积分流水与批次、上传与生成记录、留言、本人提交的举报和发信记录；按用户限流。不含 R2 路径、服务商请求 ID、内部错误信息和成本，也不含他人针对本人视频的举报。媒体文件不打包，仍在保留期内的可从个人中心下载。字段清单见 `src/server/account-export.ts`。
- **数据库备份**：每 5 分钟的 Cron 发现当天（UTC）还没有备份时，把 D1 导出成 SQL（建表语句加全部数据，`sessions` 只导结构），gzip 后存到 MEDIA 的 `backups/d1/<日期>.sql.gz`，保留 30 天（`src/server/backup.ts`）。当天最多尝试 3 次，第 3 次仍失败时给 `ADMIN_EMAILS` 发 `backup_failed` 告警。`backups/` 没有公开路由，R2 生命周期规则也不要覆盖它。
  - 恢复到一个新建的空数据库（不要先跑迁移，备份里带 `d1_migrations` 记录）。先不加 `--apply` 只出计划（下载、统计各表行数、检查目标库为空），确认后再导入：
    ```bash
    node scripts/restore-d1.mjs --date 2026-10-21 --remote --database <新库名>
    node scripts/restore-d1.mjs --date 2026-10-21 --remote --database <新库名> --apply
    ```
    然后把 `wrangler.jsonc` 的 `database_id` 指向新库并重新部署。备份不含会话，恢复后所有人需要重新登录。
  - D1 Time Travel 可以恢复到 30 天内的任意时间点（Workers Free 为 7 天），但会原地覆盖数据库：`npx wrangler d1 time-travel restore <db> --timestamp=<unix>`。误操作先用 Time Travel；R2 里的备份用于更久的留存、数据库被整个删除或换账号迁移。
  - 本地可以 `POST /api/dev/backup` 立即导出一次（只接受本机直连），再用 `--file <路径> --local --persist-to <目录>` 恢复到一份独立的本地状态核对。

## 交易邮件

用 [Cloudflare Email Service](https://developers.cloudflare.com/email-service/)（public beta）从 Worker 直接发信：`send_email` binding 名为 `EMAIL`，发件地址是 `vars.EMAIL_FROM`。

- **发给用户**：积分到账、成片完成（附保留截止日期）、生成失败退积分、举报回执（只发给填写本人账号邮箱的登录用户）、举报处理结果、视频因举报被删除。语言跟随用户最近一次下单或生成时所用的界面语言，举报相关邮件用举报时的页面语言。已注销或封禁的用户不发。
- **发给管理员**（`ADMIN_EMAILS`，中文）：新举报；截止前 12 小时和超时后各提醒一次；新留言（Reply-To 是留言人）。留言人不会收到自动回复，避免表单被用来向任意邮箱发信。
- **发送方式**：业务事件先写入 D1 的 `email_outbox` 表，`dedupe_key` 唯一（如 `order_paid:<订单号>`）。webhook 重放、队列重投、Cron 重叠都只发一封。
  - 写入后立即发送。遇到限流、日配额或服务端错误时，按 5、15、45… 分钟退避，最多 5 次，由每 5 分钟的 Cron 补发；发件人未验证等永久错误直接记为失败。
  - 发送语义是“至少一次”：邮件已发出、但 Worker 在写回状态前中断时，可能多发一封。
  - 发件箱保留 30 天，注销账号时删除该用户的记录。
- **后台**：`/admin/emails` 可以按收件人、订单号、举报编号搜索，失败或未发送的邮件可以重发；概览页显示发送失败数。
- **上线配置**：
  1. Cloudflare 控制台 → Compute > Email Service → Onboard Domain，添加站点域名（DNS 必须托管在 Cloudflare），按提示添加 SPF/DKIM 记录。
  2. 账号需要 Workers Paid 才能发给任意收件人。每月含 3,000 封，超出部分每千封 $0.35（[价格](https://developers.cloudflare.com/email-service/platform/pricing/)）。
  3. `vars.EMAIL_FROM` 改成 `noreply@<domain>`（`new-site.mjs` 会自动改），然后运行 `npm run db:migrate:remote` 应用 0004。
- **可选：改走 Resend**（例如 Workers Free 上，Email Service 只能发给 Cloudflare 里已验证的地址）：注册 [Resend](https://resend.com/)，在 Domains 验证发件域名，创建 API Key，写进 `.dev.vars.production` 的 `RESEND_API_KEY` 后运行 `node scripts/sync-secrets.mjs --apply`（或 `npx wrangler secret put RESEND_API_KEY`）。配了 Key 且 `EMAIL_FROM` 非空时，全部邮件走 Resend，不再用 `send_email` binding（免费档每月 3000 封、每天 100 封；额度用完按限流重试）。到后台对“邮件”点“测试连接”确认，结果会注明走的渠道。不配 Key 则行为不变。
- `EMAIL_FROM` 留空或没有 binding 时不发信，邮件记为“未发送”；配好后可在后台重发。本地 `wrangler dev` 只模拟发送，不要给 binding 加 `"remote": true`。

## 监控告警

每 5 分钟的 Cron 跑一次健康检查（`src/server/alerts.ts`），超过阈值就给 `ADMIN_EMAILS` 发中文告警邮件，同时写一条 `console.error('[alert] …')` 到 Workers 日志：

| 告警 | 条件 | 后台页面 |
| --- | --- | --- |
| 生成失败率 | 最近 1 小时完成的任务里失败 ≥ 3 个且占比 ≥ 30%（不含管理员手动失败、举报下架） | `/admin/generations` |
| 死信 | 最近 1 小时有任务因队列消息重试耗尽被判失败 | `/admin/generations` |
| 视频服务商账户 | 最近 1 小时有任务因没配密钥、密钥失效、yir、NanoAPI 余额不足或 Key 月度额度用完而失败（1 个就告警） | `/admin/generations` |
| 视频服务商余额 | 每小时（UTC 整点那次 Cron）查一次 yir、NanoAPI、fal 的余额，低于 10 美元就告警，不等任务失败；查询失败只写日志 | `/admin/generations` |
| 任务积压 | 有任务创建超过 30 分钟仍未完成 | `/admin/generations` |
| 支付回调 | 最近 24 小时有处理失败的支付回调 | `/admin/events` |
| 付款待核对 | 最近 24 小时有 paid 回调找不到订单，或金额、币种、商品和订单不一致（订单补单或退款后不再计入） | `/admin/events` |
| 邮件 | 最近 6 小时有 ≥ 3 封邮件失败或重试 3 次仍未发出（不含告警邮件本身） | `/admin/emails` |

- **去重**：同一类告警每 6 小时（UTC 时间桶）最多发一次，`dedupe_key` 为 `admin_alert:<类型>:<桶>:<管理员邮箱>`。问题持续存在时，下一个时间桶再提醒。
- **死信队列**：主队列消息重试 10 次（约 35 分钟）仍失败会进入 `<name>-jobs-dlq`。同一个 Worker 消费死信队列（`src/server.ts` 按队列名的 `-dlq` 后缀分流），把任务判为失败（`error_code = dead_letter`）并退积分，用户会收到生成失败邮件。新站点要同时创建两个队列（见“部署到 Cloudflare”），`new-site.mjs` 会一并改名。
- **D1 备份失败**：不在上表的健康检查里；当天第 3 次导出仍失败时发一封 `backup_failed` 告警，见“合规与内容安全”的“数据库备份”。
- **付款即时通知**：配置 secret `PAYMENT_NOTIFY_WEBHOOK_URL` 后，每笔订单首次入账（含续费和后台补单）往 Telegram、飞书 / Lark、Discord 或 Slack 群发一条消息：金额、套餐、积分、来源和订单号。地址格式见 [docs/env.md](docs/env.md)。发送失败只写日志，不影响入账；日志和报错里不出现 webhook 地址（里面带 token）。同一个地址也会收到上表的告警和 D1 备份失败（同一类告警每个时间桶一条，用 KV 去重）；飞书开了关键词校验时要加上“告警”。
- 发信本身出问题（域名未验证、配额用完）时告警邮件也可能发不出去，此时以 Workers 日志里的 `[alert]` 为准。配了 `PAYMENT_NOTIFY_WEBHOOK_URL` 时聊天群就是第二通道；还要第三条通道时，可以用 Workers Logpush 把日志推到外部监控服务，按 `[alert]` 设置通知。
- **前端错误**：浏览器里未捕获的异常、未处理的 Promise 拒绝和错误页渲染失败，由 `src/lib/error-report.ts` 用 `sendBeacon` 发到 `/api/client-error`，只写 Workers 日志：`[client-error] id=… kind=error|rejection|boundary page=… message=… stack=…`。
  - 错误页显示错误编号，用户反馈时在 Workers Logs 里搜 `id=<编号>` 即可找到堆栈。
  - 日志里邮箱打码，URL 去掉账号密码、query 和 hash，堆栈只留前 6 行；同一页面同一个错误只报一次，每页最多 5 条，接口按 IP 限流。跨域脚本的 `Script error.` 不报。
  - 线上是打包后的代码，堆栈对应压缩文件的行列号；需要还原源码位置或聚合告警时，可以把发送部分换成 Sentry 等平台的 SDK（记得在 `csp.ts` 的 `connect-src` 里放行）。

## 测试

```bash
npm run typecheck
npm test            # vitest：Waffo/Dodo/Stripe 验签与事件映射、退款比例与退款单号规则、归因解析、生产环境禁用 mock、Turnstile 与图片审核的错误分支、邮件模板与发送重试判定、告警阈值与时间桶、GA4 同意前不加载与撤回删 Cookie、CSP 报告和前端错误上报的摘要与脱敏、登录跳转校验、Google 登录的 PKCE 与 nonce、账号按 sub 绑定与注销邮箱不再领注册赠送、成片下载大小上限、D1 备份的 SQL 转义、付款通知的消息格式与地址脱敏、归因 Cookie 等同意后才写入、5xx 详情不对非管理员返回、生产环境拒绝弱 SESSION_SECRET、上线配置检查与 doctor 的规则和 wrangler 输出解析、模板同步计划的分层、密钥同步计划的校验与脱敏、积分账务、兑换码、邀请奖励与订阅（日历月、年付补发、续费、乱序事件、周期校正时当期积分到期时间对齐、退款、Dodo/Waffo 事件映射，SQLite）、运营设置的校验缓存与每日上限、测试连接与脱敏、e2e 验收目录与用例一致
npm run test:e2e    # Playwright：需要先 npm run seed:local；会复用已运行在 127.0.0.1:3000 的 dev server
E2E_PORT=3200 npm run test:e2e   # 3000 被其它程序占用时换端口
npm run seo:check   # 需要 dev server 在跑；报告写到 .tmp/seo-check/
SMOKE_BASE_URL=https://<domain> npm run test:smoke   # 线上只读巡检，见“部署到 Cloudflare”
SANDBOX_PROVIDER=dodo E2E_PORT=3200 npm run test:sandbox   # 支付商 test 模式真实收银台（dodo、waffo 或 stripe），需要 .dev.vars 里的 test 凭据，不进 CI
```

按风险分级的 e2e 验收目录和未覆盖项见 [tests/e2e/CATALOG.md](tests/e2e/CATALOG.md)。新增或改名用例时要同步更新，`npm test` 会核对两边是否一致。sandbox e2e 的前提、webhook 模式和测试卡见 [docs/payments.md](docs/payments.md) 的“sandbox e2e”。

e2e 覆盖（70 个用例）：
- 购买与生成：完整主路径（含中文站路径和 AI 角标）、余额不足时在生成器里直接买够用的最便宜的包（暂停收款时禁用）、支付失败、未登录回到结果页（邮箱在渲染前被 302 去掉）、余额不足、生成失败退款；3 路轮询并发处理同一任务时只落库一次、成片不被误删，后台显示成本与毛利。
- 合规：
  - 保留期：进行中任务的原图不清理；到期原图不能再用；成片过期返回 410，个人中心显示已过期；重复清理是幂等的。
  - 举报下架：匿名在 `/report` 举报，管理员在后台下架。同一张原图的两条成片都被删除，无关成片保留，重新上传同一张图被拦截；已处理的举报不能再处理，处理结果写入审计。
  - 审核：不通过的上传返回 422。
  - 导出我的数据：设置页下载的 JSON 含本人全部记录，不含他人数据和内部字段；未登录和注销后返回 401。
  - 成片分享：个人中心开启后，匿名访客看到 noindex 的分享页和 AI 标识，页面不暴露视频 ID；他人不能开启或停止分享；停止分享后旧链接 404，成片到期或被举报下架后 410；封面不是 JPEG 或审核不通过被拒；凭带语言前缀的分享链接举报即可定位视频。
- 积分批次：后台补发限时积分后，生成先扣它、失败原路退回，到期作废后账单页提示消失；余额只够一次时并发发起两个生成，一个成功一个 402。账务规则另有单元测试在 SQLite 上执行全部迁移核对。
- 兑换码：后台生成一批并导出 CSV、停用其中一个；用户在设置页兑换，积分带有效期；重复兑换、次数用完、停用或格式不对的码、非管理员访问都被拒绝；可用 3 次的活动码被 5 个用户同时兑换，只有 3 个成功。
- 邀请奖励：好友经设置页的链接注册、首单付款后邀请人只拿一次奖励；第二单、其他用户的订单、无效码和老用户都不发；首单退款后奖励只回收一次；同一 IP 超出上限的注册被拒绝，后台显示原因；导出数据只含本人这一侧。
- 运营设置：只有管理员能读写，未知参数或越界值整体拒绝；注册赠送和有效期改后立即用于新用户，审计记前后值；维护模式下生成和下单返回 503，已建订单的付款照常入账，管理员不受限，中英文页面都显示提示条；暂停收款时下单返回 503 `checkout_paused`，中英文价格页按钮禁用，生成和已建订单照常；未知的收款渠道整体拒绝，下单仍走部署配置；公告按语言显示；每日上限返回 429 且不扣积分；后台页面只提交改动项，本地各项测试连接都正常。
- 订阅：月付从定价页订阅、积分随当期作废、续费重放只入账一次、少付的转人工、扣款失败与恢复、账单页到期取消与撤销、客户门户、续费期间拒绝再订阅和注销、终止后可重新订阅；年付按月补发（Cron 重复执行不重发）、迟到的旧状态事件被忽略、退款只回收订阅积分并停止补发。
- 告警与死信：任务进死信后判失败、只退一次积分；健康检查触发失败率和死信告警，同一时间桶重复执行不重发。
- 交易邮件：支付回调重放只发一封、语言跟随用户；生成成功与失败各一封，重复判失败不重发；未登录举报不发回执、登录用户填本人邮箱才发，临近截止与超时提醒各一次、下架后通知举报人和作者且不再提醒；留言只提醒管理员；注销清除发件记录；后台邮件页。
- 支付事件与退款：并发和重放支付事件、部分消费后退款、两次部分退款、管理员退款时补登后迟到的同号 webhook 不重复扣；退款先于付款到达时重试后照常回收；少付或套餐不符不入账并告警、退款后结案，折扣码和换币种照常入账，孤儿事件告警、其他站点的事件忽略；webhook 丢失时成功页和 Cron 都能查单补救（指数退避、5 个并发查单只入账一次、迟到的 webhook 不重复入账、别人的订单返回 404、少付的付款不再自动重查），后台查单能直接入账或提示人工核对。
- 订单与用户数据：账单和订单详情显示实付与部分退款，他人订单接口返回 404、页面显示找不到；后台搜索订单、退款金额无效时拦下可重试、部分退款与补单后时间线完整；用户按付费、封禁筛选和按积分排序，非法排序值不进 SQL；积分流水超过一页时加载更多不重不漏。
- 安全与权限：CSRF、伪造上传和越权、后台权限、后台概览的配置检查不回传密钥值、积分调整和封禁、dev 登录与 mock 支付只接受本机直连；登录后的站外 `redirect` 回退到个人中心，登录页遇到未知错误码（如 `__proto__`）显示通用提示；支付结果页带的邮箱参数在渲染前就被 302 去掉。
- 安全响应头：内联脚本都带本次请求的 nonce；公开页、登录后生成和后台浏览器内零 CSP 违规；注入不带 nonce 的脚本会被报告；报告接口不受同源校验影响。
- 前端错误上报：全局异常和未处理的拒绝各报一次、页面地址不带 query，重复错误不重报，每页最多 5 条；渲染出错时错误页显示的编号与上报一致，接口恢复后点重试回到正常页面。
- 归因与报表：UTM 归因跨会话保持、报表和 CSV。
- SEO：seo-check 全部规则、中英文首页水合、客户端路由切换后 head 同步、语言链接可抓取。

产物在 `.tmp/video-template-e2e/`：`report/`（HTML 报告，含每步截图和 trace）、`results.json`、`test-results/`。

## 目录

```text
src/config/site.ts      每个词要改的配置
src/content/            中英文文案
src/routes/             页面（{-$locale} 为可选语言前缀，admin/ 为后台）
src/server/             API：auth、credits、orders、payments/、video/、jobs（队列、死信与 Cron）、alerts（健康检查告警）、admin、seo、retention、takedown、moderation、turnstile、email（发件箱）、notifications（业务事件 → 邮件）、settings（运营设置）、probes（测试连接）、csp（内容安全策略）、client-error（前端错误上报）
migrations/             D1 迁移
containers/postprocess/ 成片后处理容器：烧录水印、C2PA 签名、封面和预览（实验阶段，Worker 尚未接入，见 ROADMAP）
seed/templates/         生成用的模板源视频
.claude/skills/         Claude Code skill：new-hot-site（上新词）、sync-upstream（合并模板更新）、launch-audit（上线体检）
scripts/                new-site（上新词）、doctor（部署前体检）、sync-plan（模板同步计划）、sync-secrets（密钥同步）、seo-check、indexnow、waffo-setup、dodo-setup、stripe-setup、webhook-proxy、seed-local、占位素材生成
tests/                  unit（单元）、e2e（mock 服务商）、smoke（部署后巡检）、sandbox（支付商 test 模式）
```

## 许可证

[MIT](LICENSE)
