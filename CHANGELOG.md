# Changelog

Notable changes to the template. Derived sites pick them up with `git merge` from upstream (see the `sync-upstream` skill). Earlier changes are in the git history.

中文说明在每条下方。

## 2026-11-08

### Fixed: phone photos no longer fail to upload; photos the video model can't take are rejected before upload

- Phone originals (7–9 MB) made `POST /api/uploads` end with `exceededCpu` on Workers Free (503 for the user): `base64Encode` built the moderation payload one byte at a time, about 2 s of CPU for 8 MB. It now converts in 32 KB chunks, and the browser shrinks photos over 1.5 MB, or with a long side over 2048 px, to a 2048 px JPEG first (`src/lib/prepare-photo.ts`, used by the generator and the phone upload page; EXIF orientation applied, a white background under transparent PNGs, formats the browser can't decode are sent as they are).
- New `site.upload.minSide` (300) and `site.upload.maxRatio` (2.5) follow Kling Motion Control's limits for reference images (each side at least 300 px, aspect ratio between 1:2.5 and 2.5:1). Photos outside them were accepted and then failed upstream; now the browser shows "pick another photo" (`photo_too_small` / `photo_bad_ratio`) and uploads nothing, and `readImageFile` re-checks the size from the JPEG / PNG / WebP header and returns 422 with the same codes for both `/api/uploads` and `/api/handoff/photo`. The shared e2e photo `tests/fixtures/photo.jpg` is now 300×400 (`scripts/generate-placeholder-media.mjs`). Contributed by ken-fs in #3.

Upgrading a site: merge upstream. `src/config/site.ts` and `src/content/en.ts`, `zh.ts` are site files, so the merge keeps your versions and typecheck fails until you add, in `site.ts`, `minSide: 300` and `maxRatio: 2.5` under `upload`, and in both content files the `errors.photo_too_small` and `errors.photo_bad_ratio` strings (copy them from the template). If your video provider has different reference-image limits, set those two values to its limits. `src/lib/prepare-photo.ts`, `src/server/media.ts`, `src/server/util.ts`, `src/components/Generator.tsx` and the phone upload page are template files; take the template's version on conflict.

修复：手机原图不再上传失败；视频模型收不了的照片在上传前就拦下。
- 手机原图（7–9 MB）让 `POST /api/uploads` 在 Workers 免费计划上以 `exceededCpu` 结束（用户看到 503）：`base64Encode` 逐字节拼字符串，8 MB 照片送审核前要约 2 秒 CPU。现在每次转 32 KB；浏览器先把大于 1.5 MB 或长边超过 2048 px 的照片缩成长边 2048 px 的 JPEG 再传（`src/lib/prepare-photo.ts`，生成器和手机传图页共用；按 EXIF 摆正，透明 PNG 先铺白底，浏览器解不开的格式原样传）。
- 新增 `site.upload.minSide`（300）和 `site.upload.maxRatio`（2.5），取自 Kling Motion Control 对参考图的限制（宽高都不小于 300 px，长宽比 1:2.5 到 2.5:1）。超出的照片以前会先被接受、到上游再失败；现在浏览器直接提示换一张（`photo_too_small` / `photo_bad_ratio`），不上传；`readImageFile` 从 JPEG / PNG / WebP 文件头再查一遍尺寸，`/api/uploads` 和 `/api/handoff/photo` 都按同样的错误码返回 422。e2e 通用照片 `tests/fixtures/photo.jpg` 改为 300×400（`scripts/generate-placeholder-media.mjs`）。由 ken-fs 在 #3 贡献。

站点升级：合并 upstream。`src/config/site.ts` 和 `src/content/en.ts`、`zh.ts` 属于站点文件，合并后保留站点的版本，补上下面几项前 typecheck 会报错：`site.ts` 的 `upload` 里加 `minSide: 300`、`maxRatio: 2.5`；两份文案的 `errors` 里加 `photo_too_small`、`photo_bad_ratio`（从模板复制）。视频服务商对参考图的限制不同时，把这两个值改成它的限制。`src/lib/prepare-photo.ts`、`src/server/media.ts`、`src/server/util.ts`、`src/components/Generator.tsx` 和手机传图页属于模板文件，冲突时取模板的版本。

### Fixed: full-page browser translation no longer crashes pages

- With Chrome / Google Translate translating the whole page, picking a photo in the generator (or any later React update in a translated block) threw `NotFoundError` from `insertBefore` / `removeChild`, and the root error boundary replaced the page with the error screen. `src/lib/translate-guard.ts` is now installed before hydration (the React issue #11538 patch): when the reference node has been moved into the translator's `<font>` nodes, the new node goes before the child that now holds it, and a moved node is removed from its current parent. Translation keeps working; untouched DOM takes the original code path. Contributed by ken-fs in #4.

Upgrading a site: merge upstream. `src/lib/translate-guard.ts` and `src/router.tsx` are template files; if `src/router.tsx` conflicts, take the template's version.

修复：浏览器整页翻译不再让页面崩到错误页。
- 开着 Chrome / Google 整页翻译时，在生成器里选照片（或翻译过的区块之后任何一次 React 更新）会从 `insertBefore` / `removeChild` 抛 `NotFoundError`，根路由错误边界把整页换成错误页。现在水合前装上 `src/lib/translate-guard.ts`（React issue #11538 的补丁）：参照节点被挪进翻译的 `<font>` 时，插到它现在所在的那个子节点前面；被挪走的节点从它现在的父节点删除。翻译照常可用，DOM 没被改过时走原来的方法。由 ken-fs 在 #4 贡献。

站点升级：合并 upstream。`src/lib/translate-guard.ts`、`src/router.tsx` 属于模板文件，`src/router.tsx` 冲突时取模板的版本。

## 2026-11-07

### Added: optional spec sheet on the home page

- New home content block `specs` (`{ eyebrow, title, rows: [{ label, value }] }`), rendered as a definition list right after "What is". One fact per row: who can star, upload formats, styles, lengths, output format, price, credit expiry, render time and refunds. The template default reads its values from `site`. AI answers tend to quote spec lists like this when they recommend a tool; set the block to `null` to hide it.

Upgrading a site: merge upstream. `src/content/en.ts` and `zh.ts` are site files, so the merge keeps your copy and typecheck fails until you add `specs` to both (the template's block is a good start, or `specs: null`). Write only facts the rest of your copy already promises, for example that pets are accepted.

新增：首页可选规格表。
- 首页新增文案区块 `specs`（`{ eyebrow, title, rows: [{ label, value }] }`），在 What is 之后渲染为定义列表，一行一个事实：谁能出镜、上传格式、风格、时长、成片格式、价格、积分有效期、生成时间和失败退款。模板默认值从 `site` 读取。AI 推荐工具时常照搬这类规格；设为 `null` 就不渲染。

站点升级：合并 upstream。`src/content/en.ts`、`zh.ts` 属于站点文件，合并后保留站点的文案，两份都补上 `specs` 前 typecheck 会报错（可以从模板的区块改起，或者写 `specs: null`）。只写站内其他文案已经承诺的事，例如支持宠物照片。

## 2026-11-05

### Changed: smaller e2e reports in CI

- With `CI` set, Playwright keeps traces and screenshots only for failed tests (`retain-on-failure`, `only-on-failure`); local runs still record every test. CI uploads only `report/` when the run fails, still for 3 days. A failed run's report drops from about 170–290 MB to a few MB per failing test, so private site repos no longer fill the account's Actions storage (500 MB on GitHub Free).

Upgrading a site: merge upstream. `playwright.config.ts` and `.github/workflows/ci.yml` are template files; if they conflict, take the template's version.

改动：CI 里的 e2e 报告变小。
- 设了 `CI` 时，Playwright 只给失败的用例保留 trace 和截图（`retain-on-failure`、`only-on-failure`），本地运行仍然每个用例都留。CI 只在失败时上传 `report/`，仍保留 3 天。一次失败的报告从 170–290 MB 降到每个失败用例几 MB，私有站点仓库不会再占满账号的 Actions 存储（GitHub Free 为 500 MB）。

站点升级：合并 upstream。`playwright.config.ts` 和 `.github/workflows/ci.yml` 属于模板文件，冲突时取模板的版本。

### Added: more key facts in `/llms.txt`

- The Key facts list now says when styles come with background music (`styles[].music`), that downloads are MP4 files without a visible watermark, and, with `aiMetadata.enabled`, that each video carries a machine-readable AI label.
- New `site.seo.llmsFacts` (default `[]`): extra English sentences appended to Key facts, for facts the config can't express and AI answers tend to get wrong, such as accepting pet photos or not being a similarly named competitor. Only state what the site copy already promises.

Upgrading a site: merge upstream. If `src/config/site.ts` conflicts, keep your values and add `llmsFacts: [] as string[]` to `site.seo`; fill it if AI answers confuse your site with another or miss what it supports.

新增：`/llms.txt` 补充关键事实。
- Key facts 会写明哪些风格自带配乐（`styles[].music`）、下载的是无可见水印的 MP4；开了 `aiMetadata.enabled` 时再注明每条成片带机器可读的 AI 标记。
- 新增 `site.seo.llmsFacts`（默认 `[]`）：追加到 Key facts 末尾的英文句子，写配置推不出来、AI 又常说错的事，例如能不能用宠物照片、和名字相近的竞品站不是一家。只写站内文案已经承诺的事。

站点升级：合并 upstream。`src/config/site.ts` 冲突时保留站点的值，在 `site.seo` 里加 `llmsFacts: [] as string[]`；AI 回答把本站和别的站混淆、或漏掉本站支持的功能时，把对应事实写进去。

## 2026-11-04

### Added: optional tables in guide articles

- An article section can carry `table: { head, rows }` (`ArticleTable` in `src/content/en.ts`). It renders after the section's paragraphs as a real `<table>`, the first column as row headers (`th scope="row"`), and scrolls sideways on narrow screens. Use it for comparisons and spec sheets, which readers and AI answers quote more easily than prose. The sample `howTo` article shows a length-to-credits table.

Upgrading a site: merge upstream. If `src/content/en.ts` conflicts, keep your site's copy and take the template's `ArticleTable` type and the `table?: ArticleTable` field on `ArticleContent.sections`. Adding tables to your own articles is optional.

新增：指南文章可选表格。
- 文章段落可以带 `table: { head, rows }`（类型 `ArticleTable`，在 `src/content/en.ts`）。渲染在该段文字之后，是真正的 `<table>`，第一列作行标题（`th scope="row"`），窄屏横向滚动。适合对比表和规格表，读者和 AI 回答都比大段文字更容易引用。模板示例文章 `howTo` 加了一张时长对应积分的表。

站点升级：合并 upstream。`src/content/en.ts` 冲突时保留站点文案，取模板的 `ArticleTable` 类型和 `ArticleContent.sections` 上的 `table?: ArticleTable` 字段。给自己的文章加表格是可选的。

## 2026-11-02

### Changed: the new-hot-site skill covers the newer site options

- The `new-hot-site` skill and its brief now set `styles[].music`, `aiMetadata.enabled` and `fraudWarningAutoRefund`, and say what accepting pet photos takes: a pet branch in the scene and video prompts (a real animal with its own paws and tail, no human hands), one real test per style before promising it, and matching upload, consent, terms and FAQ copy. Sample photos of pets or objects may be CC0 photos from Wikimedia Commons, labelled in `hero.creditNote` (`src/content/*.ts`).
- `.playwright-mcp/` (Playwright MCP console logs) is ignored.

Upgrading a site: merge upstream; nothing to change.

变更：new-hot-site skill 覆盖较新的站点选项。
- `new-hot-site` skill 和站点简介加上 `styles[].music`、`aiMetadata.enabled`、`fraudWarningAutoRefund` 的取值，并写明收宠物照片要做的事：首帧和视频 prompt 加宠物分支（保持真动物、用自己的爪子和尾巴、不出现人手），每种风格先用真实宠物照片实测一条再承诺，上传说明、同意框、条款和 FAQ 一起改。宠物、物品的示例照片可以用 Wikimedia Commons 上 CC0 的照片，在 `src/content/*.ts` 的 `hero.creditNote` 写清来源。
- `.gitignore` 忽略 `.playwright-mcp/`（Playwright MCP 的 console 日志）。

站点升级：合并 upstream 即可，不用改动。

### Added: optional per-style background music

- `site.styles[].music` (default `null`): one AAC file (`.m4a`, in `seed/templates/`, uploaded to R2 `templates/` like the source videos) per duration id. When set, after the video is stored in R2 and before output moderation and the XMP label, the server replaces the video's audio track with that music in pure JS (`mediabunny`, MPL-2.0; the video stream is copied as is, not re-encoded; `src/lib/music-mux.ts`, `src/server/music.ts`). It never fails a job or refunds credits: a missing music file, an object changed meanwhile, a video over 48 MB or an unreadable MP4 only logs a warning and leaves the video as the provider made it. With `music: null` nothing changes. The Worker bundle grows by roughly 0.5 MB.

Upgrading a site: merge upstream, then
1. If `src/config/site.ts` conflicts, add `music: null as Readonly<Record<string, string>> | null` to every style.
2. To enable it: put one `.m4a` per duration in `seed/templates/` (as long as the duration, fading out at the end), set `music: { short: '…m4a', … }`, and upload each with `npx wrangler r2 object put <name>-media/templates/<file>.m4a --file seed/templates/<file>.m4a --content-type audio/mp4 --remote`.
3. You must own a commercial license for the music (for example AI music you generated under terms that allow commercial use), never someone else's song.
4. If your site copy says the generated videos are silent, update it.

The music unit tests use their own fixtures in `tests/fixtures/` (`video-6s.mp4`, `music-6s.m4a`), so they pass in sites that replaced the template source videos.

新增：按风格可选的背景音乐。
- `site.styles[].music`（默认 `null`）：每个时长档位一段 AAC（`.m4a`，放在 `seed/templates/`，和源视频一样上传到 R2 的 `templates/`）。配了之后，成片存进 R2 后、输出审核和 XMP 标记之前，服务端用纯 JS（`mediabunny`，MPL-2.0；视频流原样拷贝、不重编码；`src/lib/music-mux.ts`、`src/server/music.ts`）把成片原有音轨换成这段音乐。任何情况下都不会让任务失败或退积分：音乐文件缺失、期间成片被改写、成片超过 48 MB、MP4 读不了，都只记 warn、成片保持服务商原样。`music: null` 时行为不变。Worker 产物大约增加 0.5 MB。

站点升级：合并 upstream，然后
1. `src/config/site.ts` 合并冲突时，给每个风格补上 `music: null as Readonly<Record<string, string>> | null`。
2. 要启用：每个时长档位放一段 `.m4a` 到 `seed/templates/`（时长等于档位、结尾自带淡出），配置 `music: { short: '…m4a', … }`，再逐个上传：`npx wrangler r2 object put <name>-media/templates/<file>.m4a --file seed/templates/<file>.m4a --content-type audio/mp4 --remote`。
3. 音乐必须拥有商用授权（例如自己生成、条款允许商用的 AI 音乐），不能用别人的歌。
4. 站点文案若写着生成的视频无声，要同步改。

背景音乐的单元测试用 `tests/fixtures/` 里自带的素材（`video-6s.mp4`、`music-6s.m4a`），站点换掉模板源视频后也能通过。

## 2026-11-01

### Added: machine-readable AI label, verify page, output moderation, consent records and dispute handling

- **AI label in the file**: before a video is marked ready, the queue appends an XMP packet to the MP4 (top-level `uuid` box) with IPTC `DigitalSourceType = trainedAlgorithmicMedia`, the brand, model, video id, creation time and verify URL (`src/lib/xmp.ts`, `src/server/xmp.ts`). New public page `/verify` (footer link) reads a file in the browser without uploading it; `GET /api/verify/:id` returns only the brand, creation time and model. Behind the site switch `site.aiMetadata.enabled`, **off by default**: when off, videos are untouched and `/verify`, the API, the footer link, the sitemap entry and the XMP sentence in the terms are gone (404). For the EU AI Act Art. 50(2) (systems already on the market have until 2026-12-02); California SB 942 only covers providers with over 1 million monthly visitors. C2PA and watermarks are still not included.
- **Output moderation**: new var `OUTPUT_MODERATION` (`off` by default, `frames`, `mock` outside production). `frames` samples 3 frames through the Cloudflare Media Transformations binding `MEDIA_TRANSFORM` and checks them with `MODERATION_PROVIDER`; a rejected video is deleted, the job fails with `output_moderation_rejected` and credits are refunded. The binding isn't declared by default because it only runs remotely in local dev.
- **Consent record**: `POST /api/generations` requires `consent: true` (400 `consent_required`) and stores `consent_at` and the consent text shown (migration `0016_consent_record.sql`). The takedown form has a required electronic signature (`signature`, shown in `/admin/takedowns`); the `report.name` label is now just "full name". The privacy policy has a "Children" section (not for under-13s).
- **Disputes and chargebacks**: Stripe `charge.dispute.created` / `closed` and `radar.early_fraud_warning.created`, and Dodo `dispute.*`, are processed by `processPaymentEvent`. Opening claws back the order's remaining credits (`dispute:<id>`), won or withdrawn gives them back (`dispute_won:<id>`), lost marks the order refunded; an actionable early fraud warning only notifies admins by default (they refund in the admin), and refunds the rest through the provider automatically only when the site switch `site.fraudWarningAutoRefund` is `true`. Admins get an `admin_dispute` email and chat notification; admin orders show the status (migration `0017_disputes.sql`). Waffo has no dispute webhook.

Upgrading a site: merge upstream, then
1. `npm run db:migrate:local`, and `npm run db:migrate:remote` before deploying (0016, 0017).
2. Copy: if `en.ts` / `zh.ts` conflict, keep your copy and add the new keys `meta.verifyTitle`, `meta.verifyDescription`, `footer.verify`, the `verify` section, `report.signature`, `errors.consent_required`, the updated `errors.invalid_report`, and the "Children" section of the privacy policy; the XMP sentence in the terms' "Generated videos" paragraph is now conditional on `s.aiMetadata.enabled`. If your `report.name` label says it serves as the signature, change it to just the name.
3. Webhooks: Stripe `node scripts/stripe-setup.mjs --apply --webhook <url> --webhook-id <id>`, Dodo the same with `dodo-setup.mjs`, or tick the new events in the dashboard (list in `docs/payments.md`, "争议与拒付").
4. Optional output moderation: add `"media": { "binding": "MEDIA_TRANSFORM" }` to `wrangler.jsonc`, set `OUTPUT_MODERATION` to `frames` and keep `MODERATION_PROVIDER=openai`. Media Transformations includes 5,000 transformations a month, then $0.50 per thousand; each video uses 3.
5. Custom clients calling `POST /api/generations` must send `consent: true`.
6. If `src/config/site.ts` conflicts, add the two new keys `aiMetadata: { enabled: false as boolean }` and `fraudWarningAutoRefund: false as boolean`. Sites with EU users should turn `aiMetadata.enabled` on.

新增：成片机器可读 AI 标记、验证页、输出审核、同意记录和支付争议处理。
- **成片内的 AI 标记（站点开关，默认关闭）**：成片标记完成前，队列在 MP4 末尾追加 XMP（顶层 `uuid` box），写入 IPTC `DigitalSourceType = trainedAlgorithmicMedia`、品牌、模型、视频 ID、生成时间和验证地址（`src/lib/xmp.ts`、`src/server/xmp.ts`）。新增公开页 `/verify`（页脚入口），在浏览器本地读取文件、不上传；`GET /api/verify/:id` 只返回品牌、生成时间和模型。由站点开关 `site.aiMetadata.enabled` 控制，**默认关闭**：关闭时成片保持原样，`/verify`、接口、页脚入口、sitemap 条目和服务条款里关于 XMP 的句子都不出现（返回 404）。依据是欧盟 AI Act 第 50(2) 条（已上市系统宽限到 2026-12-02）；加州 SB 942 只约束月访问量超过 100 万的服务商。C2PA 和水印仍未接入。
- **成片输出审核**：新增 var `OUTPUT_MODERATION`（默认 `off`，可选 `frames`，非生产可用 `mock`）。`frames` 经 Cloudflare Media Transformations 绑定 `MEDIA_TRANSFORM` 抽 3 帧交给 `MODERATION_PROVIDER`；不通过就删除成片，任务以 `output_moderation_rejected` 失败并退积分。绑定默认不声明，因为本地 dev 里它只能 remote 运行。
- **同意记录**：`POST /api/generations` 必须带 `consent: true`（否则 400 `consent_required`），并保存 `consent_at` 和当时展示的同意文案（迁移 `0016_consent_record.sql`）。举报表单新增必填的电子签名（`signature`，`/admin/takedowns` 可见）；`report.name` 的 label 改为只写“全名”。隐私政策新增“儿童”一节（不面向 13 岁以下）。
- **支付争议与拒付**：Stripe 的 `charge.dispute.created` / `closed`、`radar.early_fraud_warning.created` 和 Dodo 的 `dispute.*` 由 `processPaymentEvent` 处理。争议开启时回收订单剩余积分（`dispute:<id>`），胜诉或撤销时补回（`dispute_won:<id>`），败诉时订单记为已退款；可处理的欺诈预警默认只通知管理员、由管理员在后台退款，站点开关 `site.fraudWarningAutoRefund` 为 `true` 时才经支付商自动退掉剩余金额。管理员收到 `admin_dispute` 邮件和群通知，后台订单显示争议状态（迁移 `0017_disputes.sql`）。Waffo 没有争议 webhook。

站点升级：合并 upstream，然后
1. `npm run db:migrate:local`；部署前运行 `npm run db:migrate:remote`（0016、0017）。
2. 文案：`en.ts`、`zh.ts` 若冲突，保留站点文案，补上新键 `meta.verifyTitle`、`meta.verifyDescription`、`footer.verify`、`verify` 分区、`report.signature`、`errors.consent_required`、改过的 `errors.invalid_report`，以及隐私政策的“儿童”一节；服务条款“生成的视频”里关于 XMP 的句子改为按 `s.aiMetadata.enabled` 条件出现。站点的 `report.name` label 如果写着“作为电子签名”，改成只写全名。
3. webhook：Stripe 运行 `node scripts/stripe-setup.mjs --apply --webhook <url> --webhook-id <id>`，Dodo 用 `dodo-setup.mjs` 同样操作，或在支付商后台勾选新事件（清单见 `docs/payments.md` 的“争议与拒付”）。
4. 可选的输出审核：在 `wrangler.jsonc` 加 `"media": { "binding": "MEDIA_TRANSFORM" }`，把 `OUTPUT_MODERATION` 设为 `frames`，`MODERATION_PROVIDER` 保持 `openai`。Media Transformations 每月含 5000 次，超出每千次 $0.50；每条成片用 3 次。
5. 自己调用 `POST /api/generations` 的客户端必须带 `consent: true`。
6. `src/config/site.ts` 合并冲突时，补上两个新键 `aiMetadata: { enabled: false as boolean }` 和 `fraudWarningAutoRefund: false as boolean`；面向欧盟用户的站点建议开启 `aiMetadata.enabled`。

### Added: optional style demo and FAQ on article pages

- An article in `site.articles` can set `style` (a `styles[].id`): the page then shows that style's original and AI sample videos after the intro, and the closing button links to `/?style=<id>#create` so the style is preselected. An unknown id is ignored. An article's content can set `faq: [{ q, a }]`: the page renders a collapsible FAQ after the body and adds FAQPage JSON-LD. `howTo` in the template uses both. New copy keys `guides.styleDemo` and `guides.faqTitle`; the home FAQ list is now the shared `FaqList` component with the same output.

Upgrading a site: merge upstream. Nothing to change; to use it, add `style` / `faq` to an article, and add `guides.styleDemo` / `guides.faqTitle` to your `en.ts` and `zh.ts` if the merge conflicts there.

新增：文章页可选的风格样片和 FAQ。`site.articles` 里的文章可以填 `style`（`styles[].id`）：页面在导语后显示该风格的原片和 AI 样片，文末按钮链接到 `/?style=<id>#create` 预选风格，id 不存在就忽略。文章 content 可以填 `faq: [{ q, a }]`：正文后渲染折叠问答并输出 FAQPage JSON-LD。模板的 `howTo` 两项都用了。新增文案键 `guides.styleDemo`、`guides.faqTitle`；首页 FAQ 列表改用共用的 `FaqList` 组件，输出不变。站点升级：合并 upstream 即可，无需改动；想用就在文章上加 `style` / `faq`，合并时 `en.ts`、`zh.ts` 若冲突，保留站点的文案并补上这两个键。

### Fixed: the phone upload countdown no longer depends on the computer's clock

- `POST /api/handoff` also returns `expiresInMs`, and the QR panel counts down from the moment the response arrives. It used to subtract the computer's clock from the server's `expiresAt`, so a clock that was a few seconds off showed more than 10:00 or marked the code expired early and stopped polling.

Upgrading a site: merge upstream. No vars, secrets, migrations or copy changes.

修复：扫码传图的倒计时不再依赖本机时钟。`POST /api/handoff` 额外返回 `expiresInMs`，二维码面板从收到响应时开始倒数。以前用服务器的 `expiresAt` 减本机时间，本机时钟差几秒就会显示超过 10:00，或者提前显示过期并停止轮询。站点升级：合并 upstream 即可，没有新增 vars、密钥、迁移和文案。

## 2026-10-31

### Changed: run only the related e2e specs while working

- `AGENTS.md` no longer asks for the full `npm run test:e2e` (about 10 minutes, serial) after every change. While working, run `typecheck`, the unit tests and the specs related to the change plus `smoke.spec.ts`; run the full suite once before committing or merging into a site, or when touching credits, payments, permissions or the app entry points. CI still runs the full suite on pushes to `main` and on PRs.
- `tests/e2e/CATALOG.md` has a new "改哪里跑哪些" table mapping source areas to specs; the README shows the command for running selected specs.

Upgrading a site: merge upstream. No code changes.

调整：改动过程中只跑相关的 e2e。`AGENTS.md` 不再要求每次改完都跑完整的 `npm run test:e2e`（串行约 10 分钟）：改动过程中跑 typecheck、单元测试，以及和改动相关的 spec 加 `smoke.spec.ts`；一批改动收尾、提交或合并到站点前，或动到积分、支付、权限和全站入口时，跑一次完整的。推送到 `main` 和 PR 时 CI 照常跑完整 e2e。`tests/e2e/CATALOG.md` 新增“改哪里跑哪些”对照表，README 给出只跑部分 spec 的命令。站点升级：合并 upstream 即可，没有代码改动。

### Added: keep the generator draft across sign-in, and upload a photo from a phone

- The generator saves the chosen photo, style and length in IndexedDB (`src/lib/photo-draft.ts`, 24 hours) and restores them after sign-in or checkout. Signed-out visitors with a photo see that it is kept and the price of the cheapest pack covering the chosen length. The draft is cleared after a generation is created and on sign-out.
- On desktop the generator has a "Photo on your phone? Scan to upload" button that shows a QR code. The phone opens `/phone-upload#<token>`, picks a photo and uploads it to `/api/handoff/photo`; the desktop polls `/api/handoff/take` and gets the photo within a few seconds. Codes last 10 minutes and accept one photo. The relay uses R2 objects under `handoff/` (`src/server/handoff.ts`); the cron deletes them after an hour. Moderation happens when the desktop uploads the photo through `/api/uploads` as before.
- New dependency `uqr` (QR code matrix). New copy keys: `generator.draftKept`, `generator.guestPrice`, `generator.phone*`, the `phoneUpload` section and `errors.handoff_expired` / `errors.handoff_used`; the privacy policy's storage paragraph mentions the draft and the phone relay.

Upgrading a site: merge upstream and run `npm install`. If `src/content/en.ts` or `zh.ts` conflict, keep the site's values and add the new keys above (typecheck reports missing ones), plus the privacy policy sentence. No vars, secrets or migrations; the `handoff/` prefix in the existing R2 bucket is cleaned by the cron. After deploying, scan the QR code with a real phone once.

新增：生成器草稿跨登录保留，以及手机扫码传图。生成器把选好的照片、风格和时长存进 IndexedDB（`src/lib/photo-draft.ts`，24 小时），登录或付款回来后恢复；未登录且已选照片时，提示照片会保留，并显示够当前时长的最便宜积分包价格；生成任务创建后或退出登录时清除草稿。桌面端生成器新增“照片在手机里？扫码上传”按钮，显示二维码：手机打开 `/phone-upload#<token>` 选图并上传到 `/api/handoff/photo`，桌面轮询 `/api/handoff/take`，几秒内收到。二维码 10 分钟有效、只收一张；中转用 R2 的 `handoff/` 前缀（`src/server/handoff.ts`），cron 一小时后删除。审核仍在桌面照常调用 `/api/uploads` 时做。新增依赖 `uqr`（生成二维码矩阵）。新增文案键：`generator.draftKept`、`generator.guestPrice`、`generator.phone*`、`phoneUpload` 一节和 `errors.handoff_expired` / `errors.handoff_used`；隐私政策“存储与保留”加了草稿和手机中转的说明。站点升级：合并 upstream 后 `npm install`；`src/content/en.ts`、`zh.ts` 冲突时保留站点的值，补上以上新键（typecheck 会报缺的）和隐私政策那句。没有新增 vars、密钥和迁移；现有 R2 桶的 `handoff/` 前缀由 cron 清理。部署后用真手机扫一次码。

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
