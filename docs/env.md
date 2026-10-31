# 环境变量与站点配置

配置分三处，生效方式不同：

| 位置 | 内容 | 什么时候生效 |
| --- | --- | --- |
| `wrangler.jsonc` 的 `vars`（预发用 `wrangler.staging.jsonc`） | 非敏感的运行参数 | 构建时写进 `dist/server/wrangler.json`，`wrangler deploy` 读的是这份。改完要重新构建再部署（`npm run deploy` 会先构建）；只跑 `wrangler deploy` 会沿用上次构建的值。dev server 不用这里的生产值，见 `vite.config.ts` 的 `LOCAL_DEV_VARS` |
| Secret：本地写在 `.dev.vars`，线上用 `wrangler secret put <NAME>` 或 `node scripts/sync-secrets.mjs --apply`（读 `.dev.vars.production`）写入 | 密钥 | 运行时读取；写入会立即发布一个新版本 |
| `src/config/site.ts` | 关键词、品牌、域名、价格、统计 ID、站长验证等 | 编译进代码，改完要重新部署 |

浏览器拿不到任何环境变量：Google Client ID、Turnstile 站点密钥等前端需要的值由 `/api/me` 返回。项目里没有 `VITE_*` 变量。

`npm run doctor`（部署前）和后台概览的“上线配置检查”卡片（运行时）共用 `src/server/config-health.ts` 的规则：`APP_ENV` 为 production 或 staging 时，下表标为“上线必填”的缺了会报错。

## vars

| 名称 | 取值 | 上线必填 | 说明 |
| --- | --- | --- | --- |
| `APP_ENV` | `development`、`staging`、`production` | 是 | production 和 staging 下禁用 mock 服务商、开发登录和 `/api/dev/*`，Cookie 加 `Secure`。只有 production 允许搜索引擎抓取 |
| `SITE_URL` | `https://<domain>` | 是 | 用于 canonical、sitemap、邮件链接、视频服务商回调地址和 CSRF 同源校验。production 下要和 `site.domain` 是同一个站点 |
| `PAYMENT_PROVIDER` | `waffo`、`dodo`、`stripe`、`mock` | 是 | 新订单用哪个支付商。旧订单的退款和查单仍找原来的支付商。`mock` 只能在本地使用 |
| `WAFFO_ENVIRONMENT` | `test`、`prod` | 用 Waffo 时 | 决定 API 地址和验签公钥；webhook 里的 `mode` 和它不一致时拒收 |
| `WAFFO_PRODUCTS` | JSON，如 `{"starter":"PROD_xxx"}` | 用 Waffo 时 | 每个积分包和订阅套餐（`site.packages[].id`、`site.plans[].id`）对应的商品 ID，缺任何一个都报错（关掉订阅开关时不检查套餐，但已有订阅续费还要用，别删）。`scripts/waffo-setup.mjs` 可以生成 |
| `WAFFO_STORE_ID` | Waffo 的店铺 ID，如 `STO_xxx` | 用 Waffo 且开了订阅时 | 账单页“管理付款”的客户门户要用，空着时扣款失败的用户没法换卡。`waffo-setup.mjs --write-dev-vars` 会一起写入 |
| `DODO_ENVIRONMENT` | `test`、`live` | 用 Dodo 时 | 决定 API 地址 |
| `DODO_PRODUCTS` | 同上 | 用 Dodo 时 | `scripts/dodo-setup.mjs` 可以生成 |
| `STRIPE_ENVIRONMENT` | `test`、`live` | 用 Stripe 时 | webhook 里的 `livemode` 和它不一致时拒收；上线检查核对 `STRIPE_SECRET_KEY` 的前缀（`sk_test_` / `sk_live_`） |
| `STRIPE_PRODUCTS` | JSON，值是 Price ID，如 `{"starter":"price_xxx"}` | 用 Stripe 时 | 积分包用一次性价格，订阅套餐用 recurring 价格。`scripts/stripe-setup.mjs` 可以生成 |
| `VIDEO_PROVIDER` | `fal`、`yir`、`nanoapi`、`mock` | 是 | 模型和单价在 `site.video` 里配置，yir 的配置在 `site.video.yir`，NanoAPI 的在 `site.video.nanoapi` |
| `MODERATION_PROVIDER` | `openai`、`none`、`mock` | 是 | 上传图片的审核方式。`none` 不审核，检查时给出警告 |
| `GOOGLE_CLIENT_ID` | OAuth Client ID | 是 | 站点只有 Google 登录，留空就没人能登录 |
| `UMAMI_ORIGIN` | 不带路径的 https 地址，如 `https://umami.example.com` | 否 | Umami 实例地址，留空则不代理。只在 Worker 端使用（`/s/script.js`、`/s/api/send` 同域代理），不进前端，页面源码里看不到实例域名；格式不对时检查给出警告。实例要带 GeoLite2 数据库（Vercel 上部署时设 `BUILD_GEO=1` 再重新部署）：代理把访客 IP 放进 `payload.ip`，Umami 据此查国家，没有数据库会返回 500。只有 `APP_ENV=production` 才转发上报和取脚本（其它环境 `/s/script.js` 返回空 JS），`/admin` 页面不转发 |
| `TURNSTILE_SITE_KEY` | 站点密钥 | 否 | 留空则留言和举报表单不做人机校验，检查时给出警告 |
| `ADMIN_EMAILS` | 逗号分隔的邮箱 | 是 | 这些邮箱登录时自动成为管理员，同时接收举报、留言提醒和系统告警。从列表里删掉不会撤销管理员角色 |
| `EMAIL_FROM` | 发件地址 | 否 | 域名要先在 Cloudflare Email Service 完成 Onboard（配了 `RESEND_API_KEY` 时改为在 Resend 验证）。留空则不发信，后台“邮件”页记为 skipped |

## Secret

| 名称 | 什么时候需要 | 说明 |
| --- | --- | --- |
| `SESSION_SECRET` | 始终需要 | 用来签名交给视频服务商的图片地址和视频服务商回调 token，用 `openssl rand -hex 32` 生成。production 和 staging 下，少于 32 个字符或仍是 `.dev.vars.example` 里的示例值时，生成任务提交不出去，`/media/uploads/*` 返回 503 |
| `GOOGLE_CLIENT_SECRET` | 配了 `GOOGLE_CLIENT_ID` | |
| `WAFFO_MERCHANT_ID`、`WAFFO_PRIVATE_KEY` | `PAYMENT_PROVIDER=waffo` | 私钥支持 PKCS1 和 PKCS8，可以写成一行，换行用 `\n`。验签公钥已内置在代码里 |
| `DODO_API_KEY`、`DODO_WEBHOOK_SECRET` | `PAYMENT_PROVIDER=dodo` | API 密钥需要的权限见 README 的“第三方回调地址”；卖订阅还要 Subscriptions 读写和 Customers 写入，见 [subscriptions.md](subscriptions.md) |
| `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET` | `PAYMENT_PROVIDER=stripe` | secret key（`sk_`）或受限 Key（`rk_`，权限见 [payments.md](payments.md) 的“Stripe”）；webhook 密钥是端点的 `whsec_...`。可选 secret，类型声明在 `src/env.d.ts` |
| `FAL_KEY` | `VIDEO_PROVIDER=fal` | |
| `YIR_API_KEY` | `VIDEO_PROVIDER=yir` | 可选 secret，类型声明在 `src/env.d.ts`。建议在 yir Console 给这个 Key 设月度额度，见 README 的“视频服务商” |
| `NANOAPI_API_KEY` | `VIDEO_PROVIDER=nanoapi` | 可选 secret，类型声明在 `src/env.d.ts`。NanoAPI 没有月度额度，余额用完提交会返回 402，见 README 的“视频服务商” |
| `OPENAI_API_KEY` | `MODERATION_PROVIDER=openai` | 可选 secret，类型声明在 `src/env.d.ts` |
| `TURNSTILE_SECRET_KEY` | 配了 `TURNSTILE_SITE_KEY` | 同上 |
| `PAYMENT_NOTIFY_WEBHOOK_URL` | 可选 | 每笔订单首次入账（含后台补单）时往聊天群发一条付款消息：金额、套餐、积分、来源和订单号。按域名识别：Telegram 填 `https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>`；飞书 / Lark 填自定义机器人地址（不要开“签名校验”，可以用关键词“新付款”）；Discord 填频道 webhook；其他地址（如 Slack Incoming Webhook）发 `{"text": ...}`。发送失败只记日志，不影响入账。也会收到运维告警（健康检查、备份失败、视频服务商余额低于 10 美元；同一类告警每 6 小时最多一条），飞书关键词建议同时加“告警”。地址里带 token，所以放 secret。可选 secret，类型声明在 `src/env.d.ts` |
| `RESEND_API_KEY` | 可选 | 配了且 `EMAIL_FROM` 非空时，全部交易邮件改走 [Resend](https://resend.com/)（`POST /emails`），不再用 `send_email` binding；不配则行为不变。Workers Free 上 Email Service 只能发给 Cloudflare 里已验证的地址，Resend 免费档（每月 3000 封、每天 100 封）可以发给用户。发件域名要先在 Resend 的 Domains 验证，后台“测试连接”会注明走的是哪个渠道。可选 secret，类型声明在 `src/env.d.ts` |

切换支付商后，只要旧支付商还有订单可能退款或需要查单，就保留它的 secret。

## site.ts 中和上线有关的字段

- `domain`：正式域名，要和 `SITE_URL` 一致。production 下仍是占位值时 doctor 报错。
- `packages`：积分包。`id` 要在 `*_PRODUCTS` 里有对应的商品，页面上的价格要和支付商后台一致。
- `subscriptionsEnabled`、`plans`：订阅开关和套餐（`interval` 为 `month` 或 `year`，`credits` 是每月发放量）。套餐同样要在 `*_PRODUCTS` 里有商品；不卖订阅时把开关设为 `false`。用法见 [subscriptions.md](subscriptions.md)，入账规则见 [payments.md](payments.md) 的“订阅”。
- `video`：模型、源视频帧率和每视频秒的成本，用于估算毛利。
- `analytics.ga4Id`、`analytics.cfBeaconToken`、`analytics.umamiWebsiteId`、`analytics.clarityId`：统计。`umamiWebsiteId` 配合 `UMAMI_ORIGIN` 使用，同域代理、不写 Cookie、不受横幅控制。`clarityId` 是 Microsoft Clarity 项目 ID，只在正式域名加载，未同意时无 Cookie 录制。填了 `ga4Id` 或 `clarityId` 才启用 Cookie 同意：欧洲经济区、英国、瑞士和无法判断国家的访客默认关闭并弹横幅，其他地区默认开启、可在页脚“Cookie 设置”里拒绝（按 `cf-ipcountry` 判断，见 `src/lib/consent.ts`）；归因 Cookie `vt_attr` 跟随同一个同意状态。
- `share.enabled`：成片公开分享页，默认开启。换脸、真人类站点风险高时设为 `false`，个人中心的分享按钮和 `/v/<id>` 页面都不出现。
- `seo.googleVerification`、`seo.bingVerification`、`seo.indexNowKey`：站长验证和 IndexNow。用 `new-site.mjs` 派生新站时会被清空。

## 仅脚本和测试使用的变量

| 名称 | 用在哪里 |
| --- | --- |
| `E2E_PORT` | `npm run test:e2e`，dev server 端口，默认 3000 |
| `SMOKE_BASE_URL`、`SMOKE_EXPECT`、`SMOKE_ALLOW_MOCK` | `npm run test:smoke`，见 README 的“部署后巡检” |
| `BRAND_NAME` | `scripts/generate-placeholder-media.mjs`，占位素材上的品牌名 |

`waffo-setup.mjs`、`dodo-setup.mjs` 和 `stripe-setup.mjs` 从 `.dev.vars` 或同名环境变量读取凭据，不会打印密钥。

## 新增变量

新增变量时要同时改这些地方（`AGENTS.md` 有同样的清单）：

1. `wrangler.jsonc` 和 `wrangler.staging.jsonc` 的 `vars`。两份的键必须一致，`tests/unit/staging.test.ts` 会检查。
2. 如果是 secret，加进 `.dev.vars.example`。`sync-secrets.mjs` 会拒绝没登记的键，站点同步模板时也靠它发现新增的密钥。
3. 运行 `npm run cf:types`，重新生成 `worker-configuration.d.ts`。没写进 `.dev.vars` 的可选 secret，在 `src/env.d.ts` 里手动补上类型。
4. 在 `src/server/config-health.ts` 里加上线检查规则，在 `tests/unit/config-health.test.ts` 里加用例。
5. 更新本文件。
