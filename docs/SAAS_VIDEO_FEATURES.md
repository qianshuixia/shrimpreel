# AI 视频 SaaS 功能建议

调研时间：2026-10-20。法规和产品状态变化快，上线前请按文中链接复核。以下不是法律意见，涉及合规的条目上线前应请律师确认。

## 模板现状

已具备：Google 登录、积分包（一次性购买）、积分流水与幂等入账、订单与退款回收、Waffo/Dodo 两个 MoR 支付、生成队列与失败退积分、个人中心、交易邮件、管理后台（用户/订单/生成/举报下架/留言/支付事件/邮件/审计/经营报表）、来源归因（UTM 与广告点击 ID，首次和最近触达）与转化漏斗、上传类型校验、限流、CSRF、中英文、SEO 文章页、法律页、账号注销。

P0 已完成（2026-10-20）：AI 可见标识、举报下架、上传图片审核、数据保留、匿名表单的 Turnstile。各项下面的“状态”写明了做到哪一步，用法见 README 的“合规与内容安全”。

主要缺口：C2PA 与成片内水印；未成年人和名人检测；D1 自动备份；订阅和分享页。

## P0：上线前补齐（合规与风控）

### 1. AI 生成内容标识（可见标签 + 机器可读标记）

**状态**：部分完成。
- 已做：播放器上的可见角标和分享提示；下载文件名带 `ai-video` 和视频 ID。
- 技术验证已在本地完成（2026-10-20）：`containers/postprocess/` 一次处理同时完成烧录水印、C2PA 签名、封面和预览片段；Windows 原生 42 项检查通过。报告在 `.tmp/postprocess/report.md`（只在作者本机，`.tmp/` 不进仓库）。
- 未做：Docker 镜像和 Containers 实机运行、Worker 集成、生产签名证书。

- **为什么**：
  - 欧盟 AI Act 第 50 条的透明度义务从 2026-08-02 起执行。生成式系统的提供者要对合成的图片、视频等做机器可读标记，部署者要对 deepfake 做标注；面向公众的互联网内容可能落入适用范围。
  - 2026-08-02 前已上市的系统，第 50(2) 条有过渡期，到 2026-12-02。
  - 加州 SB 942（经 AB 853 修订）同样自 2026-08-02 起生效，要求可见披露加内嵌的潜在披露。
- **怎么做**：
  - 播放器和下载文件加可见的“AI generated”角标。
  - 成片写入 C2PA Content Credentials：`c2pa.created` 动作，`digitalSourceType` 取 `trainedAlgorithmicMedia`。MP4 原生支持 C2PA manifest。
  - 签名工具 c2patool / c2pa-rs 是 Rust CLI，不适合直接跑在 Worker 里。可以放到 Cloudflare Containers（2026-04-13 GA，需要 Workers Paid），由队列消费者调用。
  - 签名证书：信任列表上的 CA（截至 2026-04 有 DigiCert、SSL.com、Tauth Labs、Trufo）只给通过 C2PA Conformance Program 的生成器产品签发证书。通过之前可用自有证书签名，标记机器可读、防篡改有效，但验证器会提示签发者不受信任。
  - 成本：每 1000 个任务约 $0.13–0.41，含 `sleepAfter` 空闲计费。
  - 还没用真实 fal 输出验证过 MP4 兼容性，目前只测了 seed 模板和合成视频。
  - 模板现在默认写 XMP 元数据层：Worker 在成片末尾追加一个 XMP `uuid` box（`DigitalSourceType = trainedAlgorithmicMedia`、站点品牌、模型、创建时间、生成 id、验证链接，不含用户信息），免费检测工具是 `/verify` 页（浏览器里读文件，不上传）。C2PA 签名与烧录水印仍是 `containers/postprocess/` 的可选路径（需 Workers Paid + Containers）。XMP 在重新压缩或平台转码后会丢失，C2PA 同样会随转码丢失，二者都不防篡改。
- **来源**：
  - [EU Code of Practice on AI-generated content](https://digital-strategy.ec.europa.eu/en/policies/code-practice-ai-generated-content)
  - [Reed Smith：第 50 条指南与 Code of Practice](https://www.reedsmith.com/our-insights/blogs/viewpoints/102nbz0/transparency-obligations-for-ai-generated-content-the-code-of-practice-adequacy/)
  - [Greenberg Traurig：第 50 条透明度义务](https://www.gtlaw.com/en/insights/2026/6/deepfakes-chatbots-ai-generated-text-european-commission-details-transparency-obligations-under-the-ai-act)
  - [NatLawReview：加州 AI Transparency Act 时间线](https://natlawreview.com/article/californias-ongoing-ai-regulation-key-deadlines-arriving-2026-and-beyond)
  - [C2PA 生产实践](https://www.systemshardening.com/articles/ai-landscape/c2pa-content-credentials/)
  - [CAI：Getting a signing certificate](https://opensource.contentauthenticity.org/docs/signing/get-cert/)
  - [CAI：C2PA conformance program](https://opensource.contentauthenticity.org/docs/conformance/)
  - [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/)
  - [Containers GA 公告](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/)
- **注意**：加州法案的用户量门槛是否已被 2026 年的新法案取消，目前只有单一来源，需要查官方立法记录。

### 2. 举报与下架流程

**状态**：已完成。
- 举报入口：`/report`，页脚有链接。
- 后台：`/admin/takedowns`，48 小时队列，概览页显示超时数。
- 下架：按原图 SHA-256 删除全部副本并拉黑，写审计日志；法律页已加说明。

- **为什么**：
  - 美国 TAKE IT DOWN Act 的平台义务从 2026-05-19 起由 FTC 执法。平台要提供显眼的举报入口，在收到有效请求后 48 小时内删除未经同意的私密影像，并尽合理努力删除相同副本，每次违规最高罚 $53,088。
  - 主要承载用户内容的平台才属于 covered platform。现在成片只给本人看，风险较低；一旦做公开分享页或作品广场，基本会落入范围。
  - NO FAKES Act（S.4591）在 2026-07-02 进入参议院议程，尚未成为法律。它会对未经授权的肖像数字复制品建立通知—删除加反通知机制。
- **怎么做**：
  - 加举报表单，字段为：签名、内容定位、未同意声明、联系方式。
  - 新建 D1 表 `takedown_requests`，后台加一个带 48 小时 SLA 倒计时的队列；删除时同步删 R2 对象，并按内容哈希清理副本。
  - 每次处理都写入 `admin_audit`，便于主张善意免责。
  - 在法律页用平实的语言说明这套流程。
- **来源**：
  - [Covington Inside Privacy：TAKE IT DOWN Act 平台义务生效](https://www.insideprivacy.com/united-states/federal-trade-commission/the-take-it-down-acts-notice-and-removal-requirements-enter-into-effect/)
  - [CRS 法律简报](https://www.congress.gov/crs-product/LSB11314)
  - [Finnegan：平台须知](https://www.finnegan.com/en/insights/articles/the-take-it-down-act-is-now-in-full-effect-what-platforms-need-to-know.html)
  - [S.4591 NO FAKES Act of 2026](https://www.congress.gov/bill/119th-congress/senate-bill/4591)
  - [Holland & Knight：委员会推进 NO FAKES](https://www.hklaw.com/en/insights/publications/2026/06/senate-judiciary-committee-advances-legislation-to-protect-name)

### 3. 上传与成片的内容审核

**状态**：部分完成。
- 已做：上传时调用 OpenAI `omni-moderation-latest`（免费），审核不通过不落盘、不扣费。
- 未做：未成年人和名人检测，OpenAI 的图片类别不覆盖这两类。Workers AI 视觉模型的方案未评估。

- **为什么**：模板的核心风险是有人用别人（尤其是未成年人、名人）的照片生成视频。现在只有一个同意勾选框，没有任何检测。
- **怎么做**：
  - 上传后、扣积分前做图片审核，覆盖未成年人、裸露和名人，不通过就拒绝且不扣费。
  - 视频模型自带的安全过滤触发失败时，走现有的失败退积分路径。
  - Workers AI 上有视觉模型（Llama 3.2 Vision、Llama 4）可以用提示词做分类，Cloudflare 也有“serverless 图片内容管理”参考架构。
  - 但 Workers AI 上的 Llama Guard 目前只有 8B 文本版，没有专用图片审核模型，准确率需要自己评估；高风险场景可以接第三方审核 API。
- **来源**：
  - [Cloudflare 参考架构：Serverless image content management](https://developers.cloudflare.com/reference-architecture/diagrams/serverless/serverless-image-content-management/)
  - [Workers AI 模型目录](https://developers.cloudflare.com/workers-ai/models/)

### 4. 人脸照片与成片的数据保留

**状态**：已完成。
- Cron 清理 R2 并在 D1 标记 `expired_at`，个人中心显示“已过期”，隐私政策写明了保留期。
- R2 生命周期规则作为兜底，部署时配置（命令见 README）。

- **为什么**：上传的是人脸照片，属于敏感个人数据，现在 R2 里会一直保留。保留期越短，泄露和合规风险越小，隐私政策也更好写。
- **怎么做**：
  - 用 R2 生命周期规则按前缀自动删除，例如 `uploads/` 保留 7 天、`outputs/` 保留 30 天。规则用 `wrangler r2 bucket lifecycle add/set` 配置，到期后通常 24 小时内删除。
  - D1 对应记录由 Cron 标记为 expired，个人中心显示“已过期”。
  - 在隐私政策里写明保留期。
- **来源**：[R2 Object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)

### 5. 防薅羊毛

**状态**：部分完成。Turnstile 已接入联系和举报表单。登录和首次生成留到开放免费试用时再接。

- **为什么**：现在注册不送积分（`signupBonusCredits: 0`），风险较小。一旦要做免费试用，脚本批量注册会直接消耗模型费用。
- **怎么做**：
  - 登录和首次生成接入 Turnstile。它免费，但必须在服务端校验 token，并和现有的 Rate Limiting 一起用。
  - 免费额度按 Google 账号、IP 和设备多维限制，只开放低分辨率并加水印。
  - Cloudflare 的一次性邮箱检测（Account Abuse Protection）目前只对 Enterprise 开放 Early Access，小站暂时用不上；不过我们只做 Google 登录，这个问题本身就小很多。
- **来源**：
  - [Turnstile GA](https://blog.cloudflare.com/turnstile-ga/)
  - [Account Abuse Protection](https://developers.cloudflare.com/bots/account-abuse-protection/)

### 6. 数据库备份

**状态**：未做自动化。README 写了 Time Travel 恢复和 `wrangler d1 export` 手动导出的命令。

- **为什么**：D1 Time Travel 在 Workers Paid 上可以回到 30 天内任意时间点，但恢复是原地覆盖，也超不出这个窗口。订单和流水需要长期留档。
- **怎么做**：每天用 Workflows 把 D1 导出到 R2（官方有教程），R2 再配长期保留。
- **来源**：[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)

## P1：增长与变现

### 7. 免费试用 + 水印，付费去水印和高清

- **为什么**：Pollo AI 和 PixVerse 都是“注册送少量积分 → 免费成片带水印、限分辨率 → 付费去水印、解锁高清”的模式，这已经是行业惯例。
- **怎么做**：
  - 水印需要转码。Media Transformations 目前没有叠加图层的参数，所以要么让视频模型直接输出带水印的版本，要么在 Containers 里用 ffmpeg 处理。
  - `containers/postprocess/` 的 `label` 参数为空时不烧录水印，付费成片可以直接复用（C2PA 照常签名）。
  - 价格分层：标清和高清对应不同积分，与现有的 `durations` 配置合并成“时长 × 清晰度”二维定价。
- **来源**：
  - [Pollo AI 免费额度说明](https://intercom.help/actech/en/articles/17459495-is-pollo-ai-free-free-credits-and-paid-plans-explained)
  - [PixVerse 评测：额度与免费档](https://www.aimiracle.ai/ai-tool-review/pixverse-ai-review)

### 8. 订阅（与积分包并存）

- **为什么**：一次性积分包适合追热点的冲动消费，订阅提高复购。两家支付商都支持订阅，但规则不同。
- **Waffo Pancake**：
  - 周期可选周、月、季、年。
  - 续费失败进入 `past_due`，支付通道只重试一次，失败就直接取消。
  - 取消在当期结束时生效。
  - 升降级是“取消旧订阅 + 新开订阅”；在 Customer Portal 自助改套餐需要两个套餐在同一商品组，并开启 `selfServicePlanChange`。
- **Dodo Payments**：
  - 有内置的 credit-based billing：每个周期发放积分，可设过期和结转。
  - 但它不会在余额为 0 时阻止使用，按量扣减也是每分钟批处理一次，有延迟。
- **怎么做**：
  - 继续以自己的 `credit_ledger` 作为唯一账本。订阅续费 webhook 按 `subscription:<id>:<period>` 幂等发放积分，复用现有的 `payment_events` 去重机制。
  - 支付商的积分功能只作参考，不作为扣费依据。
  - 个人中心加“管理订阅”入口，跳转到支付商的 Customer Portal。
- **来源**：
  - [Waffo Subscriptions](https://docs.waffo.ai/features/subscriptions)
  - [Waffo MoR 说明](https://docs.waffo.ai/mor/what-is-mor)
  - [Dodo Credit-based billing](https://docs.dodopayments.com/features/credit-based-billing)

### 9. 交易邮件

**状态**：本地已完成（2026-10-20），尚未真实发信。用法见 README 的“交易邮件”。
- 用户邮件：积分到账、成片完成、生成失败退积分、举报回执与处理结果、视频因举报被删除。
- 管理员邮件：新举报、截止前 12 小时、超时、新留言。
- D1 发件箱按事件去重，临时错误退避重试，后台可查看和重发。
- 未做：营销邮件和退订、成片完成邮件里的缩略图（等 P1-10）、退信与投诉的回调处理。

- **为什么**：生成要等几分钟，用户常常会离开页面。“成片好了”的邮件是召回的关键，购买收据和失败退款通知也能减少工单。
- **怎么做**：Cloudflare Email Service 已于 2026-04-16 进入 public beta。Worker 通过 `send_email` binding 直接发送，不用管 API key，SPF/DKIM 由 Cloudflare 配置。给任意收件人发信需要 Workers Paid。
- **来源**：
  - [Email Sending public beta](https://developers.cloudflare.com/changelog/post/2026-04-16-email-sending-public-beta/)
  - [Email Service 文档](https://developers.cloudflare.com/email-service/)

### 10. 缩略图、预览片段与分享页

- **为什么**：
  - 个人中心和后台现在直接加载整段 MP4，比较慢。
  - 分享页（带 OG 视频卡片）是这类热点站最主要的自然传播方式。
- **怎么做**：
  - 用 Media Transformations 从 R2 里的成片截封面帧、切几秒预览，或转成低码率。
  - 限制：输入小于 100MB、时长不超过 10 分钟。计费为每月前 5000 次免费，之后每 1000 次 $0.5。
  - 如果启用了 Containers 后处理，封面（原尺寸 jpg）和 3 秒预览（无声、长边 480）在同一次 ffmpeg 里已经产出，不需要再调用 Media Transformations。
  - 分享页必须由用户主动公开，并且要在 P0-2 的举报下架流程上线之后再做。
- **来源**：
  - [Media Transformations](https://developers.cloudflare.com/stream/transform-videos/)
  - [Media binding](https://developers.cloudflare.com/stream/transform-videos/bindings)

### 11. 推荐奖励与联盟

- **怎么做**：
  - 自建邀请奖励：被邀请人完成首单后，双方各得积分，用 `referral:<orderId>` 作幂等键。在首单之后再发奖励可以防刷。
  - Dodo 也有联盟生态，第三方文章提到可对接 Affonso、Dub Partners、Rekomi，需要以 Dodo 官方文档为准。
- **来源**：
  - [Dodo Payments](https://dodopayments.com/)
  - [Rekomi：Dodo 联盟工具对比（第三方）](https://rekomi.com/blog/best-affiliate-software-for-dodo-payments)

### 12. 站内多模板

- **为什么**：Pollo AI 有上千个模板和特效，单模板站的客单价有上限。
- **怎么做**：把 `site.template` 从常量改成 D1 表加后台管理，一个热词站可以挂 2–5 个变体，例如不同舞步或不同滤镜。

## SEO：多站模板的风险

“每个热词一个站”与 Google 垃圾内容政策里的 **scaled content abuse** 直接相关：批量生产模板化、缺少原创价值的页面属于违规，开多个站来掩盖批量生产的规模也被明确点名。另外还有 **expired domain abuse**（用过期老域名承接低价值内容）。

建议：

- 每个站的首页卖点、FAQ 和文章都重写，配真实的成片示例。
- 站点之间不要互链成网。
- 不买过期老域名来做。
- 内容少时宁可少几页。

来源：[Google Search spam policies](https://developers.google.com/search/docs/essentials/spam-policies)

## P2：工程与运营

- **用 Workflows 重写生成流水线**：把“审核 → 提交 → 等回调 → 后处理（封面/水印/C2PA）→ 发邮件”串成一条 Workflow。
  - 每一步自动持久化并重试。
  - `step.waitForEvent` 直接等 fal 的 webhook，可以替代现在的“队列 + Cron 补查”。
  - 来源：[Workflows 文档](https://developers.cloudflare.com/workflows/)、[Workflows GA](https://blog.cloudflare.com/workflows-ga-production-ready-durable-execution/)
- **漏斗分析**：后台 `/admin/reports` 已有“访问 → 注册 → 下单 → 支付 → 首次生成”漏斗，以及按来源的转化表（访问按会话计，注册按首次触达，订单按最近触达）。配置 `site.analytics.ga4Id` 后，还会上报 `sign_up`、`begin_checkout`、`purchase`、`generate_video` 四个 GA4 事件。还缺“复购”这一步和按 cohort 的留存。
- **后台增强**：订单 CSV 导出、按天/来源/国家/支付商/套餐的收入报表已完成。还缺 webhook 失败重放和批量补偿积分。
- **多语言**：按热点来源国增加语言，例如 es、pt、ja、ko；语言列表在 `LOCALES`。
- **平台限制备忘**：
  - 请求体上限按 Cloudflare 套餐区分：Free/Pro 100MB，Business 200MB。
  - HTTP 请求的 CPU 时间默认 30 秒，最多可调到 5 分钟。
  - 队列消费者每次最多运行 15 分钟。
  - 现在 10MB 的上传上限离这些都很远。
  - 来源：[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

## 建议顺序

1. ~~P0-4 数据保留、P0-5 Turnstile~~、~~P0-1 可见 AI 标识~~、~~P0-2 举报下架~~、~~P0-3 图片审核~~（2026-10-20 已完成）。
2. ~~C2PA 技术验证~~（2026-10-20 本地完成，Docker 和 Containers 实机未验证）；D1 导出 Workflow。
3. 未成年人和名人检测方案评估。
4. ~~P1-9 交易邮件~~（2026-10-20 本地完成）、P1-10 缩略图，然后是 P1-7 免费试用加水印。
5. P1-8 订阅，视前几个站的复购数据再决定。
