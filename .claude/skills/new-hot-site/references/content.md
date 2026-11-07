# 重写文案

文案在 `src/content/en.ts` 和 `src/content/zh.ts`，两份都要改。关键词、品牌、平台、保留天数通过 `s`（`site`）插值，比如 `${k}`、`${b}`、`${s.trendPlatform}`；不要写死这些值。脚手架打印的“写死旧关键词的行”要先处理掉。

## 必须按新趋势重写的部分

只换关键词的站会被 Google 判为 [scaled content abuse](https://developers.google.com/search/docs/essentials/spam-policies#scaled-content)。下面这些要写出这个趋势自己的内容：动作、节奏、玩法、适合谁、常见问题。

| 位置 | 改什么 |
| --- | --- |
| `meta.homeTitle`、`meta.homeDescription` | 首页标题和描述 |
| `hero` | `title`、`subtitle`、`chips`；`creditNote` 换成真实素材后改成素材来源说明 |
| `whatIs` | 趋势是什么、怎么火起来的、本站怎么做；2 段 |
| `ideas.items` | 3 个这个趋势特有的用法 |
| `problem`、`withWithout` | 首页转化区块：不用本站时的难点（只写麻烦，不提产品）和“自己拍 vs 用本站”逐行对比。按这个趋势的动作和拍摄难点改；写不出真实的难点就设为 `null`，首页不渲染这一块 |
| `specs` | 首页规格表，一行一个事实：谁能出镜（成人、宠物）、上传格式、风格、时长、分辨率和格式、有没有声音、价格、积分有效期。模板默认从 `site` 读值；站点特有的事实（如支持宠物）照实补上，不写配置里没有的承诺 |
| `faq.items` | 前两条（是什么、照片要求）按趋势改；再加 1–2 条这个趋势特有的问题。其余计费、隐私的条目保留 |
| `finalCta` | 结尾号召 |
| `articles.trend` | 趋势背景文章：起源、为什么火、怎么参与、用 AI 做 |
| `articles.howTo` | 教程文章：照片、时长、生成、分享，加这个趋势特有的技巧 |
| `guides` | 文章列表页的标题和介绍 |

`howTo.steps`、`features`、`madeWith`、`pricing` 是产品流程，趋势相关的词已经插值，一般只调措辞。`generator`、`dashboard`、`billing`、`settings`、`errors`、`common` 等界面文案不用改。

`zh.ts` 不是逐句翻译：按中文用户的搜索习惯写，但结构和键要和 `en.ts` 一致（`Content` 类型会检查）。

## 事实与合规

- 不编造趋势的起源、原作者、日期和数据。不确定就写得概括一些，或者写成 `TODO(site): 核实起源` 交给用户。
- 不写“官方”“合作”之类的词：`footer.statement` 声明本站与平台和原作者无关，文案不能和它矛盾。
- 不承诺生成效果（“100% 像你”）、不承诺时长以外的东西。
- 不写用户评价和使用人数，除非是真实的、能拿出来源的；新站不放。
- 套餐的 `anchorPriceCents`（划线原价）只填这个套餐真实卖过的价格，新站一般不填。
- 法律页（`legal`）从 `site` 插值，一般不用改。退款期限写死在 `legal.refund`（14 天），改了要两份一起改。

## 日期

- `legal.updated`（两份文案各一处）改成脚手架用的日期（`--date`，默认今天）。
- `site.seo.publishedAt` / `updatedAt` 和文章日期由脚手架改好，不要手改成未来的日期。

## seo:check 会检查什么

error（必须修）：

- 首页 `<title>` 和 H1 含主关键词（`meta.homeTitle`、`hero.title`）。
- 每页恰好一个 H1、一个 canonical，hreflang 齐全。
- 文章 slug 只用小写字母、数字和连字符，不和站内路由冲突、不重复。

warn（逐条判断）：

- 标题 15–60 个字符宽度，描述 70–160；中文按 2 个宽度算。
- 首页描述含主关键词；文章标题含主关键词。
- 首页至少 2 个 H2 含主关键词（`howTo.title`、`whatIs.title`、`features.title` 等）。
- 首页正文覆盖每个长尾词（`site.seo.secondaryKeywords`）：在 `whatIs`、`ideas`、`faq` 里自然地写进去，不要堆在一句话里。只检查默认语言（`en`）的首页，长尾词一般是英文搜索词，`zh` 不必硬塞。
- 价格、联系、隐私、条款、退款页的描述是通用文案，模板已给短品牌名留了余量，一般不用改；品牌名特别长时注意不要超过 160。

## 写完后自查

1. `git grep -n "<旧关键词>" src/content` 没有结果（旧关键词见脚手架输出）。
2. `npm run typecheck` 通过（`zh.ts` 缺键会报错）。
3. 打开首页读一遍两种语言，看有没有和新趋势对不上的句子。
