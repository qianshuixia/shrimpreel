# 站点简介

把用户的一句话需求整理成下面的表，保存为 `.tmp/new-site/brief.md`。每个字段写明取值和来源：`用户给的`、`推断`（写一句依据）或 `默认`。

| 字段 | 落到哪里 | 缺失时 |
| --- | --- | --- |
| 关键词 | `--keyword` → `site.keyword` | 必填，问用户 |
| 品牌名 | `--brand` → `site.brandName` | 默认 `<关键词> AI` |
| 域名 | `--domain` → `site.domain`、`EMAIL_FROM`；上线时的 `SITE_URL` | `<slug>.example.com` + `TODO(site)` |
| slug | `--slug` → 默认风格 `id`（`styles[0].id`）、文章 slug、`--name` 的默认值 | 关键词的 kebab-case；中文关键词必须给 |
| Worker 名 | `--name` → `wrangler.jsonc` 资源名、`package.json` 的 `name` | 默认等于 slug |
| 长尾词 | `--keywords` → `site.seo.secondaryKeywords` | 推断 3–5 个用户真会搜的词（`<关键词> filter`、`<关键词> dance` 之类），脚本会再补 `AI`、`video`、`trend` 三个 |
| 一句话口号 | `hero.subtitle`、`meta.homeDescription` | 从趋势本身推断，不留 TODO |
| 趋势来源平台 | `--platform` → `site.trendPlatform` | 保留模板值 |
| 趋势简介 | `whatIs`、`articles.trend` | 推断；不确定的事实（起源、作者、日期）不要编，写得概括一些 |
| 客服邮箱 | `--email` → `site.supportEmail` | 默认 `support@<域名>`；域名是占位时加 `TODO(site)` |
| 管理员邮箱 | 上线时的 `ADMIN_EMAILS`（本地保持 `admin@example.com`） | 留空，上线前补 |
| 语言 | `site.ts` 的 `LOCALES` | 保持 `en` + `zh`；要加语言见 README“上新词流程”第 3 步 |
| 积分包与价格 | `site.packages` | 保留模板值 |
| 时长档位 | `site.durations` | 保留模板值 |
| 视频模型 | `site.video.falModel` 等 | 保留模板值 |
| 照片主体 | 风格的 `prompt`、`scene.prompt`，文案里的上传说明、同意框和条款 | 只收一位成年人；收宠物见 SKILL.md 第 3 步 |
| 背景音乐 | `site.styles[].music` | `null`；用户给了有商用授权的音乐才配 |
| 面向欧盟用户 | `site.aiMetadata.enabled` | 不确定就按面向欧盟处理，打开 |
| 主色 | 只记录 | `src/styles.css` 不在白名单里，改色要先问用户 |
| 素材 | `public/demo/*`、`seed/templates/*`、`public/og.png`、`public/favicon.svg` | 占位素材 + `TODO(site)`，见 SKILL.md 第 5 步 |
| 参考链接 | 只记录 | 用户给的趋势原视频、竞品链接，只用来理解趋势，不下载素材 |

## 例子

用户说：“做一个 Moon Hop 的站，域名 moonhop.ai，TikTok 上很火的那个跳月球舞的模板”。

```markdown
| 字段 | 取值 | 来源 |
| --- | --- | --- |
| 关键词 | Moon Hop | 用户给的 |
| 品牌名 | Moon Hop AI | 默认 |
| 域名 | moonhop.ai | 用户给的 |
| slug | moon-hop | 默认 |
| 长尾词 | Moon Hop dance, Moon Hop filter, moon jump video | 推断：趋势是舞蹈 + 滤镜玩法 |
| 趋势来源平台 | TikTok | 用户给的 |
| 管理员邮箱 | TODO(site) | 缺 |
| 素材 | 占位素材 | 缺 |
```

对应命令：

```bash
node scripts/new-site.mjs --keyword "Moon Hop" --domain moonhop.ai --platform TikTok --keywords "Moon Hop dance,Moon Hop filter,moon jump video"
```
