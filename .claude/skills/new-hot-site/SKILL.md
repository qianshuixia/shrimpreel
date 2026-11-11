---
name: new-hot-site
description: 在 ShrimpReel 派生出的站点仓库里，把一句话热词需求变成可以本地跑通的新站：整理站点简介、跑 new-site 脚手架、改定价和生成参数、重写中英文案、换素材，最后跑 typecheck、test、seo:check 和 build。用户说“上新词”“建新站”“new hot site”“用模板做一个 XX 站”时使用。
---

# 上新词：从一句话到能本地跑通的新站

目标：在站点仓库里完成 README“上新词流程”的第 2–4 步和第 7 步的本地部分。Cloudflare 资源、支付商品、部署和上线后的检查要用到账号和费用，这个 skill 只列清单，不执行。

## 前提（不满足就停下说明）

1. 当前目录是站点仓库，不是模板本身：`git remote -v` 里有 `upstream` 指向模板。只有 `origin` 指向 `qianshuixia/shrimpreel` 时，先让用户按 README“上新词流程”第 1 步建站点仓库。
2. 工作区干净（`git status --short` 为空），这样最后能用 `git diff --stat` 给出完整改动。
3. 已 `npm install`。

## 只改白名单里的文件

- `src/config/site.ts`
- `src/content/*.ts`
- `public/*`（`public/_headers` 除外）
- `seed/templates/*`
- `wrangler.jsonc`、`package.json` 的 `name`、`wrangler.staging.jsonc`（都由脚手架改或删）
- `.tmp/new-site/`（站点简介和日志，不入库）

白名单外的文件（组件、路由、`src/server`、`src/styles.css`、迁移、测试）是各站共用的代码，改了会让以后 `git merge upstream/main` 冲突。确实需要改时先停下，说明原因并等用户确认；共用代码的 bug 应该回到模板里修。

## 缺信息时写 TODO(site)，不阻塞

用户没给、也不能从关键词合理推出的信息（真实域名、客服邮箱、授权素材、站长验证码等），写成可搜索的占位，继续往下做：

- 有格式要求的值（域名、邮箱、URL、日期、id）填一个合法的占位值，再在同一行加注释：`domain: 'moonhop.example.com', // TODO(site): 正式域名`。
- 纯展示文字可以直接写进字符串：`credit: 'TODO(site): 原作者 @handle · TikTok'`。

`npm run doctor` 会列出所有 `TODO(site)`：`APP_ENV=production` 时报错（`npm run deploy` 会被拦下），其它环境只提醒。只扫 `src/config/site.ts`、`src/content/*.ts` 和 `wrangler.jsonc`，所以素材的缺口写在 `site.ts` 里对应字段旁边。

能从关键词推出来的（口号、长尾词、文案、FAQ）直接写，不要留 TODO。

## 步骤

### 1. 整理站点简介

按 [references/brief.md](references/brief.md) 的字段把用户的需求整理成 `.tmp/new-site/brief.md`。关键词是唯一必填项；没有关键词就问用户，其它字段缺了按该文档的默认值处理。简介写好后给用户看一眼要点，不必等确认就继续。

### 2. 跑脚手架

```bash
node scripts/new-site.mjs --keyword "<关键词>" --domain <域名> --keywords "<长尾词1>,<长尾词2>" [--brand ...] [--slug ...] [--platform ...] 2>&1 | tee .tmp/new-site/scaffold-preview.log
```

先预览，核对品牌、slug、Worker 名、文章 slug 合理（中文关键词必须给 `--slug`），再加 `--write` 执行，输出存到 `.tmp/new-site/scaffold.log`。脚本最后打印的人工清单是后面几步的依据。

域名未定时用 `--domain <slug>.example.com`，再在 `site.ts` 的 `domain` 旁写 `// TODO(site): 正式域名`。定下域名后要同时改 `site.ts` 的 `domain`、`supportEmail` 和 `wrangler.jsonc` 的 `EMAIL_FROM`（`SITE_URL` 上线时再改，见第 6 步）。

### 3. 定价与生成参数（`src/config/site.ts`）

只在简介给出时改，否则保留模板值：

- `packages`：积分包的积分数和价格。`id` 不要改，支付商商品映射（`*_PRODUCTS`）按 id 对应。
- `durations`：时长档位和积分。源视频文件名在 `styles[].sources`（键 = 档位 id，文件名跟着风格 `id`），改了档位要同步每个风格的 `sources` 和 `seed/templates/` 的文件。
- `video.falModel`、`video.costCentsPerVideoSecond`、`video.sourceFps`：换模型时三个一起核对，成本用来算毛利和告警。
- 风格的 `prompt` 和 `scene`（yir 两步走的首帧图和合成 prompt）：按趋势写清要保留什么、换成什么。
  - 照片主体默认只收一位成年人。简介要收宠物时，`scene.prompt` 和视频 `prompt` 都要写宠物分支：保持真动物，用自己的头、毛色、爪子和尾巴，后腿站立，不出现人手。每种风格用真实宠物照片各实测一条再在文案里承诺；效果差的风格（比如服装把宠物变成人形身体）在文案里如实写、不推荐。上传说明、同意框、条款和 FAQ 一起改。
- 双人风格（可选）：`styles[].photos: 2`（第 1 张照片 = 源视频左边的人，第 2 张 = 右边）必须同时写 `provider: 'nanoapi'`；`styles[].durations` 是该风格自己的时长档位（id 全站唯一），此时 `sources`、`music` 的键用它们。
- `styles[].music`：每个时长档位一段有商用授权的 `.m4a`（做法见 CHANGELOG 2026-11-02）；没有就保持 `null`，文案不能说有配乐。
- `seo.llmsFacts`：`/llms.txt` 的 Key facts 里配置推不出来的英文事实句，例如收宠物照片、和名字相近的竞品站不是一家。只写文案里已经承诺的事；没有就留空数组。
- `aiMetadata.enabled`：面向欧盟用户的站打开（AI Act 第 50(2) 条，已上市系统宽限到 2026-12-02）。`fraudWarningAutoRefund` 保持 `false`，除非用户要求自动退款。
- `theme`：简介指定了外观就选 `classic` 或 `acid`（见 `src/lib/theme.ts`），否则保留模板值。
- `signupBonusCredits`、`signupBonusValidDays`（赠送积分有效期，0 = 永不过期）、`retention`、`takedownSlaHours`、`trendPlatform`。
- `examples.*.credit`：换成真实素材后写原作者；还是占位素材就保留 “Demo clip”。

### 4. 重写文案（`src/content/en.ts`、`zh.ts`）

按 [references/content.md](references/content.md) 做。这是最花时间、也最影响收录的一步：只换关键词的站会被 Google 判为 scaled content abuse。两份语言都要改，`zh.ts` 缺键时 typecheck 会报错。

### 5. 素材

- 有用户提供的授权素材：放进 `public/demo/`（同名替换）、`seed/templates/<风格 id>-<秒数>s.mp4`、`public/og.png`（1200×630）、`public/favicon.svg`，并在 `site.styles[].examples.*.credit` 写来源。
- 没有：运行 `node scripts/generate-placeholder-media.mjs`（需要 ffmpeg）生成原创占位素材，文件名按新的默认风格 `id`（`styles[0].id`）和品牌名生成。然后在 `site.ts` 的 `styles` 旁写 `// TODO(site): 换成真实的趋势源视频（seed/templates/）`、在 `styles[].examples` 旁写 `// TODO(site): 换成授权的展示素材并写 credit`。
- 没有 ffmpeg：把 `seed/templates/` 里的旧文件按新文件名复制一份，同样写上面两条 TODO。
- 最后 `git rm` 掉 `seed/templates/` 里旧风格 `id` 的源视频，只留 `site.styles[].sources` 和 `site.styles[].scene.frame` 用到的文件。
- 文章封面：`public/demo/` 定稿后，给每篇文章用 `node scripts/article-cover.mjs public/guides/<slug>.jpg --tag <分类> --title "<短标题>" [--layout …] <视频>@<秒> | <图片> …` 生成封面（选项见脚本开头）。按文章类型换版式，别全站一种：教程用 `before-after`（示例照片 → 对应成片），对比用 `vs`，规格、价格、排错用 `hero`，灵感用 `grid`；没有合适画面的主题（如穿搭）可以用 `full` 铺一张不含人物的配图。画面和标题不能暗示站点不支持的功能（如文章说不支持宠物，封面就不要放宠物）。在 `site.articles[].cover` 填 `/guides/<slug>.jpg`。删掉模板带来的、已不用的旧封面文件。
- 示例照片：人物用 AI 生成的虚构人物或本人授权的照片；宠物、物品可以用 Wikimedia Commons 上 CC0 的真实照片。哪些是 AI 生成、哪些是真实照片，在 `src/content/*.ts` 的 `hero.creditNote` 写清楚。
- 不要从网上下载趋势视频当素材，版权和肖像权都过不去。

### 6. wrangler vars 先不动

`wrangler.jsonc` 的 `vars` 现在是本地开发值：`SITE_URL` 是 localhost（下单回跳、媒体签名链接都用它），`ADMIN_EMAILS` 的 `admin@example.com` 被 e2e 用作管理员。脚手架已经改好资源名和 `EMAIL_FROM`，其余 vars 等上线时按 README“上新词流程”第 5 步一次性改成生产值。到时 `npm run doctor` 会拦下 localhost、占位邮箱和 mock 服务商，不需要再写 TODO。

用户给了管理员邮箱、Google Client ID、Turnstile site key 等上线才用的值时，记在简介里，最终汇报列出来。

### 7. 收尾验证

依次运行，每条的输出存到 `.tmp/new-site/`：

```bash
npm run typecheck
npm test
npm run build
npm run seo:check        # 需要先在另一个终端 npm run dev；3000 被占用时用 npx vite dev --port <端口>，再加 -- --base http://127.0.0.1:<端口>
node scripts/doctor.mjs --offline
git grep -n "TODO(site)" -- src wrangler.jsonc
```

- typecheck、test、build 必须通过；失败先修，修不好说明卡在哪。
- `seo:check` 的 error 必须修；warn 逐条判断，属于文案的回到第 4 步改。dev server 不会热更新 `src/content/*` 渲染出的 meta，改完文案要重启 dev server 再检查，否则看到的还是旧结果。
- doctor 在本地配置下会报 D1/KV 占位 id、mock 服务商等错误，这是预期的，部署前处理；只需确认 `site-todo` 列出的位置和你写的 TODO 一致。
- 不跑 e2e：它很慢，而且站点没改共用代码。用户要求时用 `npm run test:e2e`。

## 最终汇报

1. 新站一句话概况：品牌、关键词、域名、语言。
2. `git diff --stat` 和简介里每个字段落到了哪里。
3. 验证结果：每条命令和是否通过，seo:check 剩下的 warn。
4. 剩余的 `TODO(site)`（第 7 步 `git grep` 的结果）。
5. 上线前必须用户自己做的事（README“上新词流程”第 5–8 步）：创建 Cloudflare 资源并写回 id；把 vars 改成生产值（`APP_ENV=production`、`SITE_URL`、真实服务商、`ADMIN_EMAILS` 等，简介里记下的值一并列出）；`wrangler secret put` 各密钥；在支付商后台建商品；`npm run deploy`；上线后的 seo:check 和站长平台提交。

不提交、不推送、不部署，除非用户明确要求。
