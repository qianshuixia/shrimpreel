# ROADMAP

## 当前状态（2026-10-24）

本地全部可用。模板本身不部署上线（2026-10-20 决定），线上验证随第一个热词站进行。下文提到的 `.tmp/` 工件不入库，只在作者本机。

- 已验证：
  - 检查与构建：`npm run typecheck`；`npm test`（239 个单元测试）；`npm run build`。
  - e2e：`npm run test:e2e`（64 个用例全部通过，2026-10-24）。
  - SEO：`npm run seo:check`（20 个页面 0 error）。
  - 支付商 sandbox（2026-10-21，`SANDBOX_WEBHOOK=1`，经隧道收真实 webhook）：Dodo 付款、拒付、部分退款 3 个用例通过，订阅用例的首付、激活、积分和门户通过，取消续费因 test 密钥缺 Subscriptions 写入返回 403；Waffo 付款、拒付和订阅 3 个用例全部通过。
- 模板全面评审（2026-10-20）中不需要产品决策的 P0/P1 已在本地完成：
  - 工程：GitHub Actions CI（typecheck、单元测试、build，e2e 单独一个 job 并上传报告；Playwright 在 CI 重试 1 次）；README 改为 upstream remote 的多站升级流程。
  - SEO 与内链：文章改为可扩展集合（`site.articles`）；`/guides` 列表页进入导航和页脚；文章页有相关文章和可见面包屑，价格页面包屑与 BreadcrumbList 一致；FAQ、价格页、联系页链接到文章；语言切换改为可抓取的 `<a hreflang>`；sitemap `lastmod` 按页面取。
  - 性能：`public/_headers` 给 `/assets/*` 长缓存，`/demo/*`、`/og.png` 缓存 7 天；文案按语言拆包，首屏共享 i18n chunk 从 gzip 43.9 kB 降到约 27 kB，另加当前语言 9–10 kB。
  - 无障碍：文字用的强调色加深（`--accent-text`），标题层级、上传控件 label、Logo 可访问名称已修。
  - 运维与安全：告警与死信队列、前端错误上报、错误页只显示错误 ID、CSP（Report-Only）与 Permissions-Policy、后台服务商成本与毛利。
  - 合规：GA4 同意横幅、导出我的数据。
- P0 合规已在本地完成，工件在 `.tmp/template-gaps/`：
  - AI 标识：播放器角标、分享提示，下载文件名带视频 ID。
  - 数据保留：Cron 清理，个人中心显示“已过期”。
  - 举报下架：`/report` 加 `/admin/takedowns`，48 小时队列，按原图哈希删除全部副本并拉黑。
  - 上传审核：OpenAI omni-moderation 或 mock。
  - 联系和举报表单接入 Turnstile；支付结果页从地址栏去掉 `email`。
  - 说明见 README 的“合规与内容安全”。
- P1-9 交易邮件已在本地完成（Cloudflare Email Service，D1 发件箱去重、退避重试、后台邮件页），工件在 `.tmp/transactional-email/`。说明见 README 的“交易邮件”。随后加了可选的 Resend 发信渠道（`RESEND_API_KEY`，单元测试覆盖，未实测真实发信）。
- 监控告警已在本地完成：Cron 健康检查（生成失败率、死信、积压、支付回调、付款待核对、邮件），按 6 小时时间桶去重发给 `ADMIN_EMAILS`；死信队列由同一 Worker 消费，判失败并退积分。说明见 README 的“监控告警”。
- GA4 同意横幅已在本地完成：Consent Mode v2 basic 模式，接受前不加载 gtag.js，撤回时删除 `_ga` 系列 Cookie；页脚可重新打开；隐私政策按统计配置自动调整。默认配置不启用 GA4（推荐 Cloudflare Web Analytics），浏览器流程用临时 `ga4Id` 验证过一次。说明见 README 的“合规与内容安全”。
- 文章封面已完成（2026-10-26）：`site.articles[].cover` 可选，用在 `/guides` 卡片、文章顶部、`og:image` 和 Article `image`；`scripts/article-cover.mjs` 从站点视频截帧生成 1200×630 封面（2026-10-27 起带标题、分类标签、品牌名和 6 种版式）；e2e 覆盖 SPA 切换后 `og:image` 不残留。
- 可选的 Umami 统计已完成并在 christmasdanceai 上线（2026-10-26）：只有 production 上报，`/admin` 不上报；`analytics.umamiWebsiteId` 加 `UMAMI_ORIGIN`，Worker 同域代理 `/s/script.js` 和 `/s/api/send`（不转发 Cookie、只回传状态码 / body / Content-Type、5 秒超时 502），实例域名不进前端；隐私政策按配置调整，单元测试覆盖。说明见 README 的“统计与 Cookie”。
- 同意横幅改为按地区（2026-10-31）：欧洲经济区、英国、瑞士和无法判断国家的访客默认关闭统计 Cookie 并弹横幅，其他地区默认开启、不弹横幅，页脚可拒绝。依据：竞品（JibJab、Elf Yourself、Kling、CapCut 等）对美国访客都不弹横幅；之前全球弹横幅时，不点横幅的大部分访客不进 GA，漏斗看不全。单元测试覆盖国家判断和默认值，本地带 `cf-ipcountry` 实测，工件在 `.tmp/geo-consent/`。
- 可选的 Microsoft Clarity 录屏已完成（2026-10-31）：`analytics.clarityId`，只在正式域名加载、`/admin` 不录；未同意时无 Cookie 模式，同意横幅的选择同步给 Clarity（`consentv2`）；隐私政策和横幅文案按配置调整，CSP 放行，单元测试覆盖。用于排查“打开收银台不付款”。
- CSP 与 Permissions-Policy 已在本地完成：页面下发 `Content-Security-Policy-Report-Only`，内联脚本用每次请求的 nonce，违规写 `[csp]` 日志。dev 与生产构建下公开页、生成流程、后台、GA4 同意后加载均为零违规。**仍是 Report-Only**，上线观察无误报后再改为强制执行。说明见 README 的“关键设计”。
- 开源前安全排查（2026-10-20）已在本地完成，报告在 `.tmp/security-audit/report.md`（只在作者本机，不入库）：
  - 已修复：
    - 登录后 `redirect` 的开放重定向，包括 `/\evil`、`/..//evil` 等写法；
    - 登录页 `?error=__proto__` 崩溃；
    - 5xx 的错误详情只返回给管理员；
    - production/staging 拒绝弱 `SESSION_SECRET`；
    - 开发登录和 mock 支付拒绝带 `X-Forwarded-For` 的请求，防止 ngrok 把 Host 改成 localhost 后绕过本机检查；
    - 新增 [SECURITY.md](SECURITY.md)；
    - CI checkout 不保留 Git 凭据。

    回归测试在 `tests/unit/security.test.ts`、`tests/e2e/sign-in.spec.ts` 和 `tests/e2e/attribution.spec.ts`。
  - 核实没有问题：
    - `npm audit` 0 个漏洞；
    - 会入库的文件里没有密钥和个人信息；
    - Google ID token 校验了签名、`iss`、`aud`、`exp` 和 `email_verified`；
    - 邮件模板转义了用户输入；
    - 后处理容器不经 shell 调用 ffmpeg，输入有大小上限。
- 订单与用户数据管理已在本地完成（2026-10-21），工件在 `.tmp/admin-data/`（只在作者本机）：
  - 用户侧：账单显示实付和退款，订单与积分流水分页加载；新增订单详情页 `/dashboard/orders/:id`，可打印，他人订单返回 404。
  - 后台：用户列表加付费、角色筛选和排序，详情页加累计付款、生成统计和审计；新增订单详情页（支付回调、积分、管理员操作、邮件合成时间线，可退款、补单）；订单和生成列表支持按支付商流水号、服务商请求 ID 搜索。
  - 后台列表连续切换筛选时，先发出的请求后返回会覆盖新结果，已改为只采用最后一次请求。
  - 迁移 `0007_admin_lookup.sql` 只加索引，部署前执行 `npm run db:migrate:remote`。
- 成片后处理的技术验证已在本地完成，代码在 `containers/postprocess/`（ffmpeg 烧录水印、c2patool 写 C2PA、封面和 3 秒预览）：
  - Windows 原生 42 项检查通过，包括篡改检测、特殊字符水印、并发 503 和未配置证书时拒绝。
  - 性能和成本：720p 10 秒约 3.2 CPU 秒；每 1000 个任务 $0.13–0.41。
  - 报告和工件在 `.tmp/postprocess/`（`report.md`）。
  - Docker 镜像没有构建过，因为本机 Docker 引擎缺 Virtual Machine Platform；Worker 侧尚未接入。
- workers.dev 预发配置保留但不使用（模板不上线），没有创建资源：
  - 配置文件 `wrangler.staging.jsonc`，用 `APP_ENV=staging` 运行，用法见 README 的“模板预发”。
  - `vite build --mode staging` 加 `wrangler deploy --dry-run` 已确认读取 staging 配置，绑定全部指向 `-staging` 资源。
- Waffo test 模式真实联调已跑通，三笔订单覆盖：
  - 真实收银台支付 → webhook 入账；
  - 部分退款与全额退款 → `refund.succeeded` webhook 回收积分；
  - webhook 丢失时按 `REF_` 补登；
  - 二次退款被 Waffo 以 409 拒绝。

  工件在 `.tmp/template-review/waffo-e2e/`。
- Dodo test 模式真实联调已跑通（商品与 webhook 由 `scripts/dodo-setup.mjs` 创建），三笔订单覆盖：
  - 真实收银台支付 → Svix webhook 入账，metadata 原样回传；
  - 同一笔支付两次部分退款，再退剩余全额 → `refund.succeeded` 按比例回收积分；
  - 同号补登幂等；钱包余额不足时退款被 409 拒绝；
  - 拒付卡 → `payment.failed` → 订单 failed。

  工件在 `.tmp/template-review/dodo-e2e/`。
- 模板增强计划 #2 支付回调一致性已在本地完成（2026-10-21），工件在 `.tmp/payment-consistency/`：paid 事件入账前核对商品和同币种实收金额，不符记 `mismatch`、找不到订单记 `orphan`，新增“付款待核对”告警和后台筛选；退款先于付款到达时返回 5xx 等支付商重试（之前会丢掉这笔退款）。说明见 README 的“关键设计”。
- 模板增强计划 #1 主动对账已在本地完成（2026-10-21），工件在 `.tmp/order-reconcile/`：`PaymentProvider.fetchPaidEvent` 向支付商查单（Dodo 查 checkout session 再取 payment，Waffo 用 GraphQL 按商户订单号查），查到的付款复用 `processPaymentEvent` 入账；成功页 pending 约 15 秒和 60 秒时各查一次，5 分钟 Cron 按指数退避扫 10 分钟到 24 小时的 pending 订单，后台订单详情加“查单”。用 test 凭据对本地 6 笔真实 Waffo/Dodo test 订单只读查单，金额、支付单号、商品 ID 与本地记录一致，失败订单查不到付款。迁移 `0008_order_reconcile.sql` 给 orders 加 `last_reconciled_at`，部署前执行 `npm run db:migrate:remote`。说明见 README 的“关键设计”。
- 模板增强计划 #3 部署前体检已在本地完成（2026-10-21），工件在 `.tmp/config-doctor/`：`npm run doctor`（`npm run deploy` 先跑）按 wrangler 配置检查 `APP_ENV`、站点域名、误用 mock、所选服务商的密钥名（`wrangler secret list`）、商品映射、绑定与占位资源 id、Cron 与死信队列、远端未应用的 migration；后台概览加“上线配置检查”卡片，按运行时 env 跑同一套规则（`src/server/config-health.ts`），只显示问题不显示值。远端分支只验证了“查不到 Worker、查不到 D1”时的报错；已部署 Worker 的 secret 列表和远端 migration 输出要等第一个热词站核对。说明见 README 的“部署到 Cloudflare”。
- 模板增强计划 #4 线上只读巡检已在本地完成（2026-10-21），工件在 `.tmp/smoke-prod/`：`SMOKE_BASE_URL=<地址> npm run test:smoke`（独立配置 `playwright.smoke.config.ts`，用例在 `tests/smoke/`），只发 GET 和必然被拒的 POST，UA 带 bot 标识不计入访问报表。生产环境的 `/checkout/mock` 页面改为直接 404。用本机生产模式预览（`wrangler dev` + https）验证：production 和 staging 各 9 个通过；故意留 mock 支付商、把 staging 当 production 巡检、对开发模式巡检，分别报出对应的失败项，开发模式下没有发出任何开发接口请求。真实域名上的巡检随第一个热词站进行。说明见 README 的“部署到 Cloudflare”。
- 模板增强计划 #5 已完成（2026-10-21），工件在 `.tmp/agent-docs/`：根目录 `AGENTS.md` 只写代码里看不出来的约定（积分走 `ledgerStatements`、支付事件走 `processPaymentEvent` 及两处有据可查的例外、新增环境变量要同步的位置、生产环境必须关闭的入口、双语文案、迁移命名、e2e 单实例），`CLAUDE.md` 只引用它；`docs/env.md` 列出全部 vars、secret、`site.ts` 上线字段和它们的生效时机；`docs/payments.md` 写明支付商代码的职责、webhook 返回码语义和新增支付商的清单。文档里引用的路径和符号已逐一核对。
- 模板增强计划 #14 已完成（2026-10-21），工件在 `.tmp/e2e-catalog/`：`tests/e2e/CATALOG.md` 把 48 个 e2e 用例和 4 个巡检用例按风险归类（P0：资金与积分、权限与安全、合规与用户数据、主路径；P1：邮件、告警、安全响应头、SEO、运营），每条写断言要点；另列只由单元测试覆盖的逻辑，以及 12 项没有 e2e 的风险、原因和计划（真实支付商、真实视频生成与 fal 回调、真实发信、Google 登录、Turnstile、OpenAI 审核、限流、真实队列与 Cron、争议、Cookie 横幅、移动端与其他浏览器、线上巡检）。`tests/unit/catalog.test.ts` 双向核对：目录引用的标题必须存在，`tests/e2e` 的每个用例必须登记；故意写错标题、删掉一条登记都能报出来。
- 模板增强计划 #25 已完成（2026-10-21），工件在 `.tmp/new-hot-site/`：Claude Code skill `.claude/skills/new-hot-site/` 入库（`.gitignore` 只放行这一个 skill），把一句话需求整理成站点简介，按白名单只改站点差异文件，缺的信息写成 `TODO(site): …`；`npm run doctor` 扫描 `site.ts`、`src/content/*.ts`、`wrangler.jsonc` 里的 `TODO(site)`，正式环境报错、其它环境提醒。在模板快照的沙箱里按 skill 派生了 Moon Hop 站（域名未定、没有素材），typecheck、单元测试、build、seo:check（0 error、0 warn）都通过，doctor 列出的 4 处 TODO 和写入的一致。实测修了模板的 4 个问题：派生站删掉 `wrangler.staging.jsonc` 后 `npm test` 会失败（跳过的 describe 仍会读文件）；占位素材脚本和 e2e 的 global-setup 写死了 `neon-shuffle-v1-*` 文件名，改为跟 `site.durations` 走；价格、隐私、条款、退款页的中文描述和英文联系页描述在品牌名较短时低于 70 个宽度，已加长。
- 模板增强计划 #11 已完成（2026-10-21），工件在 `.tmp/sync-upstream/`（同步）和 `.tmp/launch-audit/`（上线体检）：
  - 同步：`scripts/sync-plan.mjs` 只读出同步计划。基线取 `git merge-base HEAD upstream/main`，所以站点只能 `git merge`。计划把模板改动分成共用代码、站点层、站点已删除、依赖锁四层，列出两边都改过的文件、站点改过的共用文件、新 migration、新增 vars 和密钥。skill `.claude/skills/sync-upstream/` 用模板最新版的脚本出计划，按层解决冲突、补本地配置、跑完整验证，合并停在暂存区；提交带 `Template-sync: <sha>` trailer。
  - 同步的沙箱验证：从模板快照派生 Moon Hop 站，站点改了文案和主色；模板再加一个提交（新 var、新密钥、改 staging 配置）。计划正确分层，标出站点改过的 `src/styles.css`。合并出现 en.ts 和 staging 配置两个冲突，按 skill 处理后 typecheck、单元测试、build、seed、e2e 48 个、seo:check 都通过，提交后再出计划显示已是最新。没有共同历史、目标 ref 不存在都给出明确报错。e2e 的新 global-setup 暴露了测试站的源视频没按新 `template.id` 改名，已写进 skill。另外发现 Windows Git Bash 会改写 `git show <ref>:<路径>`，要加 `MSYS_NO_PATHCONV=1`。
  - 上线体检：skill `.claude/skills/launch-audit/` 只读，依次跑部署前检查、线上检查（seo:check、smoke、HTTPS、R2 源视频、移动端 Lighthouse 和截图）和人工清单，报告给出三档结论。对本机生产模式预览实跑一遍：smoke 9 个通过，Lighthouse 移动端 95 分，故意缺的 18s 源视频被查出 404，在线 doctor 和 R2 生命周期对未部署的模板给出明确失败，结论“不能上线”符合预期。PageSpeed Insights API 不带 key 返回 429，skill 改为优先用 `PSI_API_KEY`，没有 key 时用本地 Lighthouse。
  - 未验证：依赖锁冲突后 `npm install` 的路径；真实域名上的上线体检，随第一个热词站进行。
- 模板增强计划 #12 已完成（2026-10-21），工件在 `.tmp/deploy-workflow/`：
  - 密钥同步：`scripts/sync-secrets.mjs` 读 `.dev.vars.production`，对比 `wrangler secret list` 出计划（新增、已存在、只在远端、按所选服务商算出的同步后仍缺），只列名字。`--apply` 经 stdin 交给 `wrangler secret bulk`，输出脱敏；已存在的默认不覆盖，远端多出的不删除。文件没被 `.gitignore` 忽略、键名未登记或是 var、空值、占位值、弱 `SESSION_SECRET` 时拒绝写入；读不到远端列表时要加 `--overwrite`。单元测试用 fake wrangler 覆盖这些分支和脱敏；真实 wrangler 跑了 dry-run 和三种拒绝路径，日志里没有出现值。
  - 部署 workflow：`.github/workflows/deploy.yml.example`，站点复制为 `deploy.yml` 后手动触发：typecheck、单元测试、离线 doctor、`db:migrate:remote`、`npm run deploy`、线上巡检并上传报告。Cloudflare 的“Edit Cloudflare Workers” token 模板不含 D1 和 Queues，README 写明要加 D1 Edit 和 Queues Edit。核对了 wrangler 4.151 源码：CI 里 `d1 migrations apply` 的确认按 yes 继续；`secret bulk` 是 merge-patch，只改列出的键，Worker 不存在时会创建。
  - 未验证：真实 GitHub Actions 运行、真实 `secret bulk` 写入（都要真实站点，随第一个热词站进行）；actionlint（本机 Docker 未运行，只用 YAML 解析检查过）。
- Stripe 支付（2026-10-24，开源用户要求）：`src/server/payments/stripe.ts` 接入积分包、订阅、退款、查单、取消/撤销续费和客户门户，webhook 路由 `/api/webhooks/stripe`；`STRIPE_PRODUCTS` 存 Price ID，`scripts/stripe-setup.mjs` 建 Product/Price 和 webhook；上线检查核对 Key 前缀与 `STRIPE_ENVIRONMENT`，测试连接逐个核对 Price 的金额、币种、类型和周期。单元测试 `stripe.test.ts`，sandbox 用例 `tests/sandbox/stripe.spec.ts` 4 个。说明见 `docs/payments.md` 的“Stripe”。
  - 沙盒实测（2026-10-24，工件在 `.tmp/stripe-payments/`）：`stripe-setup.mjs` 建了 5 个 Price，重跑时按 lookup_key 复用；没有 webhook 时，付款、拒付 2 个用例通过；`SANDBOX_WEBHOOK=1` 经 Pinggy 隧道时 4 个用例全部通过（付款、拒付、部分退款、月付订阅的取消续费、撤销和门户），webhook 全部返回 200，没有 failed 或 mismatch；后台“测试连接”用真实 Price 返回 ok。临时 webhook 端点已删除。
  - 未验证：真实续费和扣款失败（要等一个计费周期）；live 模式；异步付款方式（银行转账等）；退款成功后又失败时积分不会自动恢复。
- 依赖：TanStack Start 1.169、`@cloudflare/vite-plugin` 1.64（miniflare 5 beta）、wrangler 4.151、Vite 8。

## 未验证

- Dodo：`payment.cancelled`、`refund.failed`、争议事件、收银台折扣码（入账核对靠 `discount_id`/`discounts` 判断用了折扣码，字段取自文档和本地 payload，未用真实折扣码验证）；live 模式（需要开通 live payments）。
- Waffo 下单时 `language` 参数是否生效；争议/拒付事件（test 模式无法触发）。
- fal.ai 真实生成：入参和出参按文档实现，没有用真实 `FAL_KEY` 跑过。
- Google OAuth 和 One Tap 的线上回调。
- 合规相关：
  - OpenAI 图片审核没有用真实 `OPENAI_API_KEY` 调用过。请求格式按官方文档实现，单元测试只验证了响应解析。
  - Turnstile 没有用真实站点密钥在浏览器里跑过。服务端校验只有单元测试。
  - R2 生命周期规则还没有在线上 bucket 配置。
- 交易邮件：本地只模拟发送。还没有 Onboard 发信域名、真实发出过邮件，也没有验证垃圾箱投递率和 Gmail/Outlook 的显示效果；需要 Workers Paid。
- Cloudflare 线上部署：D1/R2/KV/Queues/Rate Limiting/Cron 的实际绑定、自定义域名、HSTS、`robots.txt` 和 sitemap 的线上输出、Core Web Vitals。
- 线上 D1 执行迁移 0014、0015（需要 `npm run db:migrate:remote`）。
- 成片分享：社交平台（X、Facebook、Telegram、微信等）抓取 OG 预览；Safari 上的封面截帧（不支持 canvas `filter` 的 Safari 版本上背景不会模糊，但仍能截出封面）。
- D1 备份：线上 Cron 每天写入 R2、30 天清理，以及 `scripts/restore-d1.mjs --remote` 恢复到新建的线上库。
- 付款即时通知：没有往真实的 Telegram、飞书、Discord webhook 发过消息。

## 已知问题

- 本地 dev 下，miniflare 5 beta 在 Worker 不读完请求体就返回时，会让同一连接上的下一个请求出错。`src/server.ts` 里的 `drainUnreadBody` 是仅 dev 生效的规避代码。2026-10-21 在 `@cloudflare/vite-plugin` 1.64.0（miniflare 5.20261019.0-beta）上复测仍需要：去掉后同一连接连发跨域 JSON POST，结果是 403、500 交替，恢复后全是 403。下次升级用同样的办法复测（keep-alive 连接上连发 6 个带 JSON body、`Origin` 为外站的 POST）。
- e2e 偶发 `page.goto: net::ERR_ABORTED`：2026-10-20 全量跑出现过 1 次（25/27），之后没有复现。可能的原因已在 2026-10-21 找到并修复：Tailwind v4 默认扫描整个仓库，样式经 `?url` 引入、不能热替换，所以 e2e 运行期间改 README 或 docs 会让 dev 页面整页刷新（同一天的举报用例偶发失败就是这样复现的）。`src/styles.css` 改为 `source('.')` 只扫描 `src/`。CI 里 Playwright 仍重试 1 次并保留 trace。
- 用隧道联调时，支付商后台的 test webhook 指向临时地址，隧道失效后要更新 URL（Dodo 用 `dodo-setup.mjs --webhook-id`，Stripe 用 `stripe-setup.mjs --webhook-id`）。
- Dodo 收银台显示的商户名取自注册信息，上 live 前在 Dodo 后台改成品牌名。
- Dodo 回跳 URL 带买家邮箱（`?email=`）。Worker 在渲染前 302 去掉，页面、GA4 和浏览器历史里都没有；但 Workers 日志里第一次请求的 URL 仍带邮箱。
- 安全排查中暂未改动的项：
  - 邮箱移出 `ADMIN_EMAILS` 后不会自动降级，要在后台手动取消管理员（README 已写明）。
  - `wrangler.jsonc` 默认 `APP_ENV=development`，部署时必须改成 `production`（README 部署第 5 步）。否则 Cookie 不带 Secure，mock 服务商和弱 `SESSION_SECRET` 也不会被拦截。`npm run deploy` 先跑的 `npm run doctor` 会拦下；直接 `wrangler deploy` 则不会。
- D1 备份在 Worker 内存里拼出整库 SQL 再压缩，适合几十 MB 以内的库（本地 1.4 万行、压缩后约 0.8 MB 时正常）。数据量接近 Worker 内存上限（128 MB）前要改成按表分段写入 R2 multipart，或改用 Cloudflare 的 D1 导出 API。

## 模板增强计划（2026-10-21）

来源是对多款商业 SaaS 模板的对标，只借鉴思路，不复制代码。详细分析在 `.tmp/template-benchmark/report.md`（只在作者本机）。编号沿用报告编号，按批次顺序落地：

1. 第一批，第一个热词站上线前完成：
   - ~~#2~~ 已完成（2026-10-21）。支付回调一致性：找不到订单的 paid 事件记为 orphan 并告警（不返回 5xx，多个站可能共用商户号）；实付金额或币种和订单不一致时不入账、标记并告警；补乱序、金额不符、孤儿事件测试。
   - ~~#1~~ 已完成（2026-10-21）。支付回跳主动对账：`PaymentProvider` 增加查单方法；成功页长时间 pending 时由服务端向支付商查单，复用 `processPaymentEvent` 入账；Cron 兜底扫描 pending 订单；后台订单详情可手动查单。
   - ~~#3~~ 已完成（2026-10-21）。部署前体检 `npm run doctor`：检查 `APP_ENV`、所选服务商的必填 secret（只核对名字）、绑定、误用 mock、域名一致；`npm run deploy` 先跑；后台显示配置健康状态。
   - ~~#4~~ 已完成（2026-10-21）。线上只读 smoke：独立的 Playwright 配置指向线上地址，只做只读断言，包括 mock 和测试接口在生产返回 404。
   - ~~#5~~ 已完成（2026-10-21）。`AGENTS.md`（`CLAUDE.md` 只引用它）加按模块拆分的 docs：`docs/env.md` 环境变量表、`docs/payments.md` 支付商接入。派生新站的流程 README 已经写全，没有再拆一份。
   - ~~#14~~ 已完成（2026-10-21）。e2e 验收目录 `tests/e2e/CATALOG.md`：按 P0/P1 列出每个风险对应的用例和断言要点，单列未覆盖项和原因；单元测试核对目录和用例一致。
2. 第二批，多站复用：
   - ~~#25~~ 已完成（2026-10-21）。新站 quick-start skill `.claude/skills/new-hot-site/`：一句话需求整理成固定字段的站点简介，只改白名单文件，缺失信息写成 `TODO(site)`（doctor 在正式环境拦下），最后 typecheck、test、build、`seo:check` 和离线 doctor。
   - ~~#11~~ 已完成（2026-10-21）。上游同步 skill `sync-upstream` 和同步计划脚本 `scripts/sync-plan.mjs`（按层合并，基线取 merge-base，提交带 `Template-sync` trailer）；上线体检 skill `launch-audit`（只读，报告给出能否上线的结论）。
   - ~~#12~~ 已完成（2026-10-21）。部署 workflow 示例（手动触发：migrate → deploy → smoke）和 secrets 同步脚本（先 dry-run 列差异）。
   - ~~#13~~ 已完成（2026-10-21）。Waffo 与 Dodo 的 sandbox e2e（`tests/sandbox`，`npm run test:sandbox`）：真实收银台和测试卡，验证成功卡只入账一次、拒付不入账；没有隧道时靠查单入账，`SANDBOX_WEBHOOK=1` 时再验证 webhook 去重和 Dodo 部分退款。默认不进 CI，说明见 `docs/payments.md`。webhook 模式已手动跑过（2026-10-21），两家 setup 脚本都支持 `--webhook-id` 改 test webhook 地址。
   - ~~#26~~ 已完成（2026-10-21）。首页可选转化区块：痛点（`problem`）和“自己拍 vs 用本站”逐行对比（`withWithout`），文案设为 `null` 就不渲染；套餐可选 `anchorPriceCents` 划线原价和“Save X%”，只能填真实卖过的价格。不加评价区块：新站没有真实评价。
   - ~~#33~~ 已完成（2026-10-21）。可选的 yir.ai 视频服务商，见下文。
   - ~~#34~~ 已完成（2026-10-25）。可选的 NanoAPI 视频服务商，见下文。
   - ~~#35~~ 已完成（2026-10-25）。多舞蹈风格（`site.styles`），见下文。
3. 第三批，变现：
   - ~~#6~~ 已完成（2026-10-21）。积分分批次与过期，见下文。
   - ~~#9~~ 已完成（2026-10-21）。兑换码，见下文。
   - ~~#8~~ 已完成（2026-10-21）。邀请奖励（只发积分，不发现金），见下文。
   - ~~#10~~ 已完成（2026-10-21）。后台运营参数与服务商连接测试（密钥不进数据库），见下文。
   - ~~#7~~ 已完成（2026-10-21）。订阅（月付、年付），见下文。
4. P2 按需：运维脚本、~~群聊付款通知~~（已完成，见下文）、营销邮件订阅、多家统计、在线客服、~~`llms.txt`~~（已完成，见 #36）、协作模板、Demo 模式、RBAC、只读的“以用户身份查看”、AdSense 开关、回信转发、仅邀请注册、注册来源问卷、dependabot。

**#33 yir.ai 视频服务商**（群友建议，2026-10-21 评估并接入）

- 第二个可选 `VideoProvider`（`VIDEO_PROVIDER=yir`，密钥 `YIR_API_KEY`，配置 `site.video.yir`），默认仍用 fal。用法见 README 的“视频服务商”。
- 不替换 fal 的原因：yir 没有 fal `wan/v2.2-14b/animate/replace` 这类角色替换模型。接入用 Kling 2.6 Motion Control（reference 模式：照片 + 模板源视频）。
- 已实现：
  - 提交带 `Idempotency-Key`（任务 id）；照片签名地址按任务创建时间生成，重新提交时请求体不变，避免 409。
  - webhook（`/api/webhooks/yir`，只有 https 地址才带）只作为“该去查了”的信号，结果用密钥重新拉取；成片出来后立即转存 R2。
  - 失败一律退积分，按 yir 的 `retryable` 决定重投还是判失败；账单已结算时记实际成本，否则按 `costCentsPerSecond` 估算。
  - 没配 Key、Key 失效、余额不足、Key 月度额度用完时触发“视频服务商账户”告警，1 个就告警；doctor 和后台配置检查要求 `YIR_API_KEY`。
  - 测试：`tests/unit/yir.test.ts` 按 yir 文档构造响应，覆盖提交、查询、错误映射和成本；smoke 巡检检查未签名的 yir 回调返回 401。
- 和原计划不同的地方：
  - 不带 `max_cost`：yir 对用 URL 引用素材的请求拒绝 `max_cost`。单价按参考视频秒数计，模板源视频时长固定；整体花费改为在 yir Console 给 Key 设月度额度。
  - `routing.only` 默认不限定（`routingOnly: null`，按 Key 的 Routing Profile 选，可故障切换）：Kling Motion Control 在 yir 上有哪些渠道还没确认，锁死渠道后无法切换。需要限定时填渠道 ID，隐私政策列出实际渠道。
- 未验证（2026-10-21 决定模板不做实测，只交付功能）：没有用真实 key 跑过；Motion Control 的效果、单价（`costCentsPerSecond: 7` 是估算）和结算时机，由选用 yir 的热词站自己用 3–5 条真实素材验证。
- README 里的 yir 链接是作者的推荐链接，已在 README 中披露；代码和默认配置不带推荐标识。
- 2026-10-24 补充两步走（`site.video.yir.scene`，默认关闭）：Christmas Dance AI 实测发现 Motion Control 的成片背景取自用户照片，和“跳源视频里的舞”不符。先用图片模型把人合成进源视频首帧，再做动作参考，背景和动作都对上了（6 秒约 $0.012 + $0.33）。
  - 第一步的合成图传进 yir Files API，第二步用固定 `file_id` 引用（结果地址每次查询都重新签名，直接用会让幂等请求体变化）。`VideoStatus` 的 pending 可带 `next`，jobs.ts 按旧任务 id 抢占后写回下一步的任务。
  - 测试：`yir.test.ts` 覆盖两步的请求体、幂等键、重复推进不重复 PUT、文件未就绪、合成失败和成本合计；`jobs.test.ts` 覆盖进入下一步和并发推进只写一次。
  - 同期评估过 MiniMax H3 作为动作参考模型：中途硬切场景、动作跟不上、时长不准、最长 15 秒，不采用。

**#34 NanoAPI 视频服务商**（2026-10-25）
- 第三个可选 `VideoProvider`（`VIDEO_PROVIDER=nanoapi`，密钥 `NANOAPI_API_KEY`，配置 `site.video.nanoapi`），默认仍用 fal。用 genjutsu-1.0 的 `motion_control` 或 `replace_object`，用法见 README 的“视频服务商”。
  - 创建任务没有幂等键，重复提交会重复扣费：创建前先列出最近 3 小时（最多 5 页）的任务，`input.image_urls` 含本任务的签名图片地址且 `input.video_url` 相同就沿用它的 id；列表查不了就按错误映射抛错，不盲目创建。
  - webhook（`/api/webhooks/nanoapi`）同 fal、yir，只当“该查了”的信号；轮询间隔 30 秒；成片出来后立即转存 R2。`billing.charged` 作为实际成本，没有则按 `costCentsPerSecond` 估算。
  - 没配 Key、Key 失效、余额不足、账户停用时触发“视频服务商账户”告警；doctor 和后台配置检查要求 `NANOAPI_API_KEY`；测试连接查 `/v1/balance`。
  - 测试：`tests/unit/nanoapi.test.ts` 按 NanoAPI 文档构造响应，覆盖创建请求体、去重（命中、分页、列表失败）、错误映射、状态和成本；smoke 巡检检查未签名的回调返回 401。
- 实测（2026-10-25，480p）：
  - 模板完整流程跑通一单：dev server + 白名单代理 + localhost.run 隧道，`VIDEO_PROVIDER=nanoapi`。创建、webhook、轮询、转存 R2 都正常，`provider_cost_cents` 记的是实扣的 70 美分（6 秒 $0.702）。真实列表接口按 `created_after` 过滤，返回的 `input` 里有 `image_urls` 和 `video_url`，去重能匹配上。
  - 效果：用精灵装源视频加一张普通照片测试。`motion_control` 保留人脸和场景，但衣服是照片里的；`replace_object` 保留服装，但人脸像原舞者。先用 nano-banana-2 给照片换装，再跑 `motion_control`，能做到“本人穿精灵装跳舞”。
  - 计费：`replace_object` 向上取整（6.04 秒按 7 秒）；`billing.charged` 在任务成功时已结算。
  - 媒体：NanoAPI 下载素材用浏览器 UA，读视频要 Range。不支持 Range 或不带扩展名的视频地址都以 `internal_error` 失败，并全额退款。
  - 未验证：后台“测试连接”按钮没有点过（直接调 `/v1/balance` 正常）；换装这一步没有接进 NanoAPI provider。


**#35 多舞蹈风格**（2026-10-25）

- 一个站点可以配多种风格（如“精灵舞”和“圣诞派对舞”）：`site.styles[]` 每项有自己的 `id`（写入 `generations.template_id`）、各时长档位的源视频 `sources`、可选的 `prompt`、yir 两步走的 `scene`（首帧 + 合成 prompt）和首页素材 `examples`。第一个是默认风格；只有一种时界面和以前一样。
- 配置迁移：`template.id` 和 `durations[].source` 移到 `styles[0]`；`site.examples` 只留全站共用的 `ideas`；`site.video.yir.scene` 拆成共用的 `sceneImage`（模型、分辨率、成本）和风格自己的 `scene`。导出 `Style`、`findStyle`、`defaultStyle`。
- 服务端：`POST /api/generations` 接受 `styleId`，缺省用默认风格，不存在返回 400 `invalid_style`；`jobs.ts` 按 `template_id` 找源视频，风格或源视频没了按 `invalid_input` 失败退积分；`VideoProvider.costCents(seconds, styleId)`，yir 只在该风格有 `scene` 时加合成图费用。积分、幂等键、两步走的固定 `file_id` 与写回逻辑没有改动。
- 前端：生成器多于一种风格时在时长上方出现风格单选（`?style=<id>` 预选）；首页 hero 加风格标签（`tablist`，方向键可用）并与生成器同步；“Made with”每种风格一行（服务端渲染）；`seo.ts` 用默认风格的素材。
- 测试：`tests/unit/styles.test.ts`（id 不重复、sources 覆盖所有时长、en/zh 文案齐全）、yir 与 nanoapi 的按风格 prompt、两步走判断、`jobs.test.ts` 风格缺失时失败；e2e 2 个（API 的默认风格与 `invalid_style`；多风格站点的标签、选择和记录，模板只有一种风格时跳过）。
- 未验证：多风格界面只在临时加第二个风格的配置下跑过 e2e，模板默认仍是一种风格；真实 provider 没有按风格实测。

**#36 转化、GEO 与告警通道**（2026-10-25，按 web.cafe 新词站复盘的结论）

- 付费墙放在想生成的那一刻：已登录且余额不足时，生成器主按钮直接下单够用的最便宜的积分包（`cheapestPackageCovering`），下方链接到价格页；没有够用的包时仍跳价格页。下单逻辑抽成 `src/lib/checkout.ts` 的 `useCheckout`，价格页和生成器共用，暂停收款规则不变。
- 价格页：`pricing.approx` 换成 `pricing.makes`，按 `packageMakes` 列出买得起的最长和最短时长各能做几条；网格列数按包数（2、3、4）排列。单条包（正好一条最短时长）由站点在 `site.packages` 里加。
- `/llms.txt`：由 `site` 和英文文案生成（关键事实、页面、指南、条款），`seo:check` 和线上 smoke 检查它。复盘里没有证据表明它带来推荐，作为低成本项。
- 告警通道：所有告警和 D1 备份失败同时发到 `PAYMENT_NOTIFY_WEBHOOK_URL`（KV 去重）；新增“视频服务商余额”告警，每小时查一次，低于 10 美元告警。余额查询抽成 `src/server/video-balance.ts`，测试连接共用。
- 测试：`tests/unit/pricing.test.ts`（`packageMakes`、`cheapestPackageCovering`）、`tests/unit/llms.test.ts`、`tests/unit/alerts.test.ts`（余额阈值、聊天群去重）；e2e 2 个（生成器就地购买到积分到账；暂停收款时就地购买禁用）。
- 未验证：线上聊天群实际收到告警（飞书关键词）；余额告警在真实 yir 账户上触发。

**#37 第二套主题、右下角同意卡片、页脚“问问 AI”**（2026-10-26，参考竞品 rumpelstiltskinai.dance 的外观）

- 主题：`site.theme` 写到 `<html data-skin>`；颜色、标题字体、圆角、主按钮、页脚、Logo 底色都改成 CSS 变量，原样式为 `classic`，新增 `acid`（锌黑 / 奶白、黄绿强调、无衬线粗标题、小圆角）。页脚和语言链接、Logo 去掉写死的颜色。
- 同意横幅改成右下角小卡片（手机上贴底），加 × 只收起本次；文案缩短。“接受”和“拒绝”仍同样大小。
- 页脚“问问 AI”：`/llms.txt` 链接和 5 个带预填提问的 AI 按钮（`src/lib/ask-ai.ts`，图标来自 simple-icons CC0 和 @lobehub/icons MIT），`nofollow`。
- 测试：`tests/unit/theme.test.ts`；e2e `seo.spec.ts` 1 个（问问 AI 链接、中文提问、llms.txt）。acid 和 classic 的亮色、暗色、手机截图在 `.tmp/theme-acid/`。
- 未验证：同意卡片没有 e2e（模板默认不填 `ga4Id`），只用临时 `ga4Id` 在浏览器里看过显示和 ×；各家 AI 是否按预填提问自动提交、Gemini 预填走的是 Google AI Mode。

**#6 积分分批次与过期**（2026-10-21）

- 迁移 `0009_credit_grants.sql`：批次表 `credit_grants`、扣减明细 `credit_allocations`、断言表 `credit_guard`；现有余额转成永不过期的 `legacy` 批次。
- 扣费先扣最早到期的批次（永不过期的最后扣），分配用窗口函数在 SQL 里算，`credit_guard` 的 CHECK 保证扣足，否则整个 batch 回滚；不需要应用层先读后写，并发不会超扣。
- 生成失败按明细原路退回（迁移前扣费的任务退成新批次）；退款回收先扣该订单的批次；Cron 每 5 分钟作废到期批次并写 `expire` 流水，扣费前也先作废该用户的到期批次。
- 入口：`site.signupBonusValidDays`、后台补发有效期、账单页到期提示、后台用户详情的批次表、导出数据含 `creditGrants`。
- 测试：`tests/unit/credits.test.ts`（`node:sqlite` 上执行全部迁移，每步核对流水之和 = 缓存余额 = 批次剩余之和）；e2e `credits.spec.ts`（先扣限时积分、失败原路退回、到期作废、并发扣费）。
- 未验证：线上 D1 执行迁移 0009 和窗口函数（本地 miniflare 已通过）；单个用户批次很多时的扣费性能（每次扣费扫描该用户剩余 > 0 的批次，有 `(user_id, expires_at)` 索引）。上线前需要 `npm run db:migrate:remote`。

**#9 兑换码**（2026-10-21）

- 迁移 `0010_redeem_codes.sql`：`redeem_codes`（积分、可用次数、已用次数、积分有效期、兑换截止、停用时间）和 `redeem_uses`（每个账号每个码一行，主键 `(code, user_id)`）。
- 后台 `/admin/redeem-codes`：一次生成最多 1000 个随机码（一条 `json_each` 语句插入整批，不受 D1 查询数和参数个数限制）或一个指定活动码，按批导出 CSV（BOM、防公式注入），停用；生成和停用写审计日志。
- 用户在设置页兑换（`POST /api/redeem`），按用户和 IP 限流，配置了 Turnstile 时需要人机验证。兑换得到 `redeem` 批次，复用 #6 的到期与扣费规则。
- 并发：预检查只用来给出准确错误码；batch 里带条件写兑换记录，`credit_guard` 断言写入成功，再加次数（`used_count <= max_uses` 的 CHECK 兜底）和发积分。
- 测试：`tests/unit/redeem.test.ts`（码的格式；在 `node:sqlite` 上跑兑换，包括预检查之后码被用完或停用）；e2e `redeem.spec.ts`（后台生成、CSV、停用、设置页兑换、各种拒绝、5 人并发兑换 3 次的活动码）。
- 未验证：线上 D1 执行迁移 0010（需要 `npm run db:migrate:remote`）；配置 Turnstile 后的兑换（与留言、举报共用同一套校验，单元测试覆盖）。

**#8 邀请奖励**（2026-10-21）

- 迁移 `0011_referrals.sql`：`users.referral_code`（唯一，第一次打开设置页时生成）和 `referrals`（每个被邀请人一行，记邀请人、IP 哈希、状态、奖励订单）。
- 流程：`/i/<码>` 写 `vt_ref` Cookie（30 天）→ 新用户注册时在同一个 batch 里绑定 → 首单付款时和购买入账同一个 batch 给邀请人发 `referral` 积分 → 奖励订单退款时整笔回收（`referral_refund`，最多扣到 0）。
- 规则在 `site`：`referralRewardCredits`（默认 10，0 = 关闭）、`referralMaxPerIp`（同一邀请人同一 IP 最多 3 个注册，超出的记为拒绝）、`referralMonthlyCap`（每个邀请人任意 30 天最多 20 次奖励，已回收的也计入）。付款时邀请人已封禁或注销则不发。
- 并发：发奖励和回收都带 `credit_guard` 断言，断言失败时去掉奖励部分重跑 batch，购买入账和退款本身不受影响；同一被邀请人两单并发入账只发一次，两笔退款并发只回收一次。
- 入口：设置页邀请卡片（链接、复制、统计），后台 `/admin/referrals`（按时间范围的邀请人排行和最近邀请），导出数据含双方各自一侧的记录，隐私政策在功能开启时说明 Cookie 和 IP 哈希。
- 测试：`tests/unit/referrals.test.ts`（在 `node:sqlite` 上跑绑定、发奖、上限、并发、回收）；e2e `referrals.spec.ts`（链接注册、首单奖励、退款回收、无效码和老用户、同 IP 上限、后台页面、导出数据）。
- 未验证：线上 D1 执行迁移 0011（需要 `npm run db:migrate:remote`）；线上 `cf-connecting-ip` 的真实取值（本地只能模拟回环地址）；奖励金额和上限是默认值，热词站按客单价调整。

**#10 运营设置与测试连接**（2026-10-21）

- 迁移 `0012_settings.sql`：`settings`（key、JSON 值、修改人、修改时间），另给 `generations.created_at` 加索引供每日上限计数。
- 参数（`src/server/settings.ts`，后台 `/admin/settings`）：维护模式、暂停收款、收款渠道、各语言全站公告、注册赠送积分与有效期、邀请奖励积分、全站每日生成上限。只存和 `site.ts` 不同的值，保存成默认值时删行；读取走 KV（`settings:v1`，`cacheTtl` 60 秒），保存时用 D1 当前值刷新 KV；存值不合法或字段已删除时回退默认值。每次修改写审计，记录前后值；只写有变化的项。
- 生效点：维护模式拦生成和下单（503，管理员放行），支付回调、登录、查看照常；暂停收款只拦下单（503 `checkout_paused`，管理员放行），价格页按钮显示“支付即将开放”；收款渠道覆盖 `PAYMENT_PROVIDER`，只影响新订单（下单、`/api/me`、后台配置检查和支付测试连接），保存前用 `checkConfig` 检查目标支付商，旧订单按 `getOrderProvider` 找原支付商；公告和维护提示经 `/api/me` 下发；每日上限按 UTC 自然日计数，预检查给出 429，并发由 batch 里的 `credit_guard` 断言兜底；注册赠送、邀请奖励改读运营参数。`site.referralRewardCredits` 为 0 时邀请奖励锁定为 0（隐私政策按 `site.ts` 生成）；运营参数设为 0 时暂停邀请，暂停期间付款的首单记为 `paused` 拒绝，恢复后不会用之后的订单补发。
- 测试连接（`src/server/probes.ts`）：R2、KV 写读删；发信给管理员发测试邮件；Dodo 逐个套餐查商品核对价格和币种（低于 `site.ts` 为失败，因为付款会被判金额不符）；Waffo 用不存在的订单号查单验证签名；fal、yir 查余额（低于 10 美元提示，2026-10-25 起与余额告警共用阈值，fal Key 没有 billing 权限时只提示）；OpenAI 查审核模型。只读或自行清理，说明里的密钥值替换为 `***`，每次测试写审计。
- 测试：`tests/unit/settings.test.ts`（提交校验、合并、KV 缓存、每日上限在 SQLite 上回滚）、`tests/unit/probes.test.ts`（各服务商分支与脱敏）、`tests/unit/referrals.test.ts` 新增暂停用例；e2e `settings.spec.ts` 6 个（权限与校验、注册赠送与审计、维护模式、公告、每日上限、后台页面与测试连接）。另用 `.dev.vars` 的 test 凭据实测 Dodo、Waffo 的支付探测，结果都是正常，输出里没有密钥值。
- 测试单元的 D1 外壳补了 `first(column)` 语义和 KV 外壳；`admin.spec.ts` 的密钥泄露检查原来只去双引号，`.dev.vars` 里单引号的值实际没被检查，已修正。
- 未验证：线上 D1 执行迁移 0012（需要 `npm run db:migrate:remote`）；线上 KV `cacheTtl` 60 秒的实际生效延迟；fal、yir、OpenAI 的真实探测（需要真实 key）；真实发信的测试邮件投递。

**#7 订阅**（2026-10-21）

- 迁移 `0013_subscriptions.sql`：`subscriptions`（支付商订阅号、套餐、锁定的每期价格、状态、到期取消、当期起止、当期订单、年付补发进度、最近状态事件时间），`orders.subscription_id`。
- 开关 `site.subscriptionsEnabled`（默认开），套餐在 `site.plans`，默认月付 $14.90、年付 $149，每月都发 60 积分。关掉开关只停卖新订阅（定价页、条款和 FAQ 隐藏，下单拒绝套餐，doctor、测试连接和 setup 跳过套餐），已有订阅照常续费和管理。使用手册 [docs/subscriptions.md](docs/subscriptions.md)，规则和两家支付商的差异见 [docs/payments.md](docs/payments.md) 的“订阅”。
- 每次扣款一张订单（续费订单号由支付商付款 ID 派生，重复投递只建一次），积分是当月结束作废的 `subscription` 批次，复用 #6 的到期与扣费规则；年付由 Cron 按月补发。状态事件按发生时间防乱序。退款只回收这张订单发过的订阅批次，之后停止补发。
- 入口：定价页的订阅区（年付显示相对月付的折扣）；账单页订阅卡片（续费日、到期取消与撤销、扣款失败提示、客户门户）；后台用户详情的订阅表；同一时间只能有一个订阅，还会续费时不能注销账号。条款、退款政策和 FAQ 按是否开订阅生成。
- 支付商：Dodo 用 API 取消和撤销，门户按客户 ID 现取；Waffo 用 API 取消，撤销只能在客户门户里操作，门户需要新变量 `WAFFO_STORE_ID`。setup 脚本为套餐建订阅商品并订阅相关 webhook 事件；doctor 检查套餐有商品、Waffo 有 `WAFFO_STORE_ID`；Dodo 测试连接也核对套餐价格。
- 测试：`tests/unit/subscriptions.test.ts`（日历月相加、补发窗口、首付、续费、金额不符、逾期恢复、乱序、退款、Dodo 和 Waffo 事件映射）；e2e `subscriptions.spec.ts` 2 个（月付全流程含账单页操作、年付补发与退款），截图在 `.tmp/subscriptions/`；新的 mock 和 dev 端点（连同 #6 的 `/api/dev/expire-credits`）登记进了 smoke 的 404 列表。
- 不支持：换套餐（在支付商门户里关掉）、试用期、暂停。
- test 店铺实测（2026-10-21）：两家都用 setup 脚本建了月付、年付商品，sandbox 订阅用例经隧道收真实 webhook。Waffo 首付、激活、当月积分、门户、取消续费全部通过；Dodo 首付、激活、积分和门户地址通过，取消续费返回 403（test 密钥缺 Subscriptions 写入）。
- 实测发现并修复：Waffo 首付事件不带周期，本站先按付款时间推算，之后状态事件给出的周期只到日期，当月积分的到期时间和当期结束对不上。现在状态事件校正周期时，和订阅的更新放进同一个 batch 对齐当期批次的到期时间（`alignSubscriptionGrantStatement`，乱序的旧事件不改），有单元测试；测试用的 D1 外壳 batch 补上每条语句的 `meta.changes`。
- 未验证：真实续费和扣款失败（test 模式触发不了）；Dodo 的取消与撤销（补上密钥权限后重跑 `--grep 订阅`）；Dodo 订阅商品的 `subscription_period_count` 设成 10 年是否合适；线上 D1 执行迁移 0013（需要 `npm run db:migrate:remote`）。默认开启订阅和定价是产品取舍，热词站按需调整。

**安全待决策项处理**（2026-10-21）

- 账号以 Google `sub` 为准：同一邮箱换了 `sub` 返回 409 `account_conflict`（登录页提示联系客服），已封禁或注销的账号返回 403 `account_disabled`；dev 登录建的账号第一次 Google 登录时绑定 `sub`。
- 迁移 `0014_deleted_accounts.sql`：注销时记录邮箱的加盐哈希（盐是 `SESSION_SECRET`），同一邮箱重新注册不发注册赠送、不绑定邀请人。设置页注销说明和隐私政策已写明。
- Google 授权码流程加 PKCE（S256）和 nonce，cookie 里存 `state|verifier|nonce|redirect`；One Tap 先请求 `/api/auth/google/nonce`（cookie 限 `/api/auth/google`、`SameSite=Strict`、10 分钟），提交时核对 id_token 的 nonce。旧格式 cookie 按登录过期处理。
- 举报回执只发给已登录、且填写本人账号邮箱（忽略大小写）的举报人；管理员提醒和处理结果照发。
- 上传缺 `Content-Length` 返回 411，超限 413，都不读请求体；成片超过 100 MB 判失败退积分，没有长度时边读边计数，48 MB 停止。
- 支付结果页带 `order` 以外的参数时 Worker 302 去掉，替代原来的前端去参数。
- 测试：`tests/unit/auth.test.ts`、`google.test.ts`（本地 RSA 密钥签 id_token）、`output-download.test.ts`，`security.test.ts` 跟着 cookie 格式更新；e2e 的举报邮件和支付结果页用例补了断言。工件在 `.tmp/security-fixes/`。
- 未验证：线上 Google 回调和 One Tap（要真实 client id）；上传 411 没有自动化测试（浏览器总会带长度）；线上 D1 执行迁移 0014（需要 `npm run db:migrate:remote`）。

**依赖与 CI**（2026-10-21）

- `@playwright/test` 升到 1.64.1（支持 Ubuntu 26.04），CI 和部署示例的 job 改回 `ubuntu-latest`。
- `src/styles.css` 的 Tailwind 只扫描 `src/`：之前会把 README、docs 里像类名的词编进 CSS（构建产物少了约 1.3 KB），dev 下改文档还会让页面整页刷新。

**成片分享、D1 备份、付款通知、归因 Cookie**（2026-10-22）

- 成片分享页 `/v/<id>`：个人中心“分享”生成 16 位随机链接，可复制、停止分享（旧链接 404，重新分享换新链接）。页面显示视频、AI 标识、引导制作和举报入口，响应头和 meta 都是 noindex，不含用户信息和 generation id。封面由浏览器截一帧（1200×630 JPEG），服务端校验类型、大小并过内容审核（不通过 422 `share_rejected`），截帧失败就用站点默认 OG 图。成片到期或被下架后页面和媒体 410；举报可以只给分享链接，后台下架时自动定位视频。开关 `site.share.enabled`；迁移 `0015_shares.sql`；导出数据和隐私政策已更新。
- D1 每日备份：Cron 每天（UTC）把整库导出成 SQL、gzip 后写到 R2 的 `backups/d1/<日期>.sql.gz`，保留 30 天；`sessions` 只导结构；每天最多试 3 次，失败发 `backup_failed` 告警。`scripts/restore-d1.mjs` 只往空库恢复（目标库非空时拒绝）。本地往返核对：导出 23 张表、1.4 万行，恢复到空库后除 `sessions` 外逐表行数和内容哈希一致，积分余额与批次剩余之和一致，迁移记录完整。
- 付款即时通知：配置密钥 `PAYMENT_NOTIFY_WEBHOOK_URL` 后，每笔订单首次入账（含续费和后台补单）发一条消息，按地址识别 Telegram、飞书、Discord；发送失败只写日志，不影响入账，报错里不带地址。
- `vt_attr` 归因 Cookie 改为同意后才写入：没开同意横幅时照旧；开了横幅时先暂存在页面内存，接受后写入，拒绝或撤回时删除。
- 测试：e2e `share.spec.ts` 2 个；单元测试 `backup.test.ts`、`chat-notify.test.ts`、`attribution-consent.test.ts`。工件在 `.tmp/security-fixes/` 和 `.tmp/restore-d1/`。
- 未验证：见上文“未验证”的分享、备份、付款通知三条。

**宣传视频**（2026-10-22）

- `docs/media/shrimpreel-promo-{en,zh}.mp4`（72 秒，1080p，无声），README 两份顶部嵌入播放器。画面是本地 dev 环境的真实截图（mock 支付和 mock 视频服务商造的演示数据），示例站和素材是占位演示。
- README 里嵌的是 GitHub 附件链接（`user-attachments`），仓库里的 mp4 GitHub 只给下载、不能播放。重录后要把新 mp4 重新上传成附件并替换 README 两份里的链接。
- 界面或功能有大改时重录。`docs/` 属于共用层，视频会随模板合并进各热词站仓库；站点不需要时可以删掉。

## 下一步

按上面的“模板增强计划”推进（第一、二、三批已完成，剩 P2 按需项）。其余事项按 [docs/SAAS_VIDEO_FEATURES.md](docs/SAAS_VIDEO_FEATURES.md) 的“建议顺序”推进：

1. 第一个热词站 [Christmas Dance AI](https://christmasdanceai.com) 已于 2026-10-24 上线（yir 两步走，2026-10-25 加精灵舞风格），线上 smoke 9/9、`seo:check` 0 error；README 两份的“用 ShrimpReel 做的站”用卡片图 `docs/media/showcase-christmas-dance-ai.jpg` 展示它。剩余：
   - 线上真实付款和真实生成未验证（支付只在 Dodo、Waffo 沙盒跑过）。
   - 运行 `npm run seo:check -- --base https://<domain> --production` 和 `/seo-audit https://<domain>`（含 Core Web Vitals）。
2. P0 剩余项：
   - C2PA 加成片内烧录水印：本地技术验证已完成。接下来在 Docker 里实测，再接入 Worker（`POSTPROCESS_PROVIDER`，默认关闭，因为开启后 deploy 需要 Docker 和 Workers Paid）；生产签名证书见 [docs/SAAS_VIDEO_FEATURES.md](docs/SAAS_VIDEO_FEATURES.md) 的 P0-1。
   - 未成年人和名人检测：OpenAI 的图片类别不覆盖这两类。
3. P1：
   - 首单转化：2026-10-25 定为不做免费生成（成本高、易被刷），改用站点层的单条积分包和生成器就地购买（见 #36）；带水印的免费试用不再计划。
   - 分享页开放索引：目前一律 noindex，等有了人工挑选的优质成片再决定是否开放部分页面。
   - 上线时确认使用 Workers Paid，否则 D1 Time Travel 只有 7 天。
   - 错误追踪：前端错误目前只进 Workers Logs，堆栈是压缩后的行列号；需要 source map 还原或聚合告警时换成 Sentry。
   - 订单详情页提供发票下载：Dodo 可由服务端代理 `GET /invoices/payments/{payment_id}`（返回 PDF，每条记录每分钟限 5 次），未实测；Waffo 由支付商直接给买家发收据和发票，没有找到公开的下载接口，详情页继续提示查收邮件。
4. P2（等有数据再定）：视频 sitemap、`apple-touch-icon` 与 web manifest、海报改 webp/avif、公开页 SSR HTML 边缘缓存、邮箱 magic link 登录、营销邮件、后台 webhook 手动重放与复购 cohort。
