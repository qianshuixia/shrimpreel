# AGENTS.md

给在本仓库改代码的 agent 和人看的约定。用法、部署和设计说明见 [README.zh-CN.md](README.zh-CN.md)，进度见 [ROADMAP.md](ROADMAP.md)。这里只写从代码里不容易看出来、违反了会出事的规则。

## 改动前

- 本仓库是模板，热词站是以它为 `upstream` 的独立仓库。站点差异只放在 `src/config/site.ts`、`src/content/*`、`public/*`、`seed/`、`wrangler.jsonc` 和 `package.json` 的 `name`；其它文件的修复在模板里做，再合并到各站。
  - 这份清单还写在 `scripts/sync-plan.mjs` 的 `layerOf`（同步计划按它分层，`tests/unit/sync-plan.test.ts` 核对）和 new-hot-site skill 的白名单里，改动时三处一起改。
  - 站点只能用 `git merge` 同步模板（`sync-upstream` skill），同步基线取 `git merge-base`；合并提交带 `Template-sync: <sha>` trailer。
- 代码注释、docs 用简体中文；commit message 用英文。
- 在站点仓库上新词按 `.claude/skills/new-hot-site/SKILL.md` 做。缺的信息写成 `TODO(site): …`，只能放在 `src/config/site.ts`、`src/content/*.ts`、`wrangler.jsonc` 里（`scripts/doctor.mjs` 只扫这些文件，正式环境报错）。
- `.claude/` 默认不入库，只放行项目自己的 skill。新增 skill 时在 `.gitignore` 里给它的目录加一行 `!.claude/skills/<name>/`。

## 积分与支付

- 积分变动用 `src/server/credits.ts` 的 `ledgerStatements` / `clawbackStatements`，和业务状态更新放进同一个 `db.batch`。`idempotency_key` 要能从业务对象推出来（`order:<id>`、`generation:<id>` 等），重试时保持不变。
  - 生成失败退积分用 `generationRefundStatements`（按扣费明细原路退回，幂等键 `generation_refund:<id>`），到期作废用 `expireStatements`。不要绕过这些函数直接改 `users.credits` 或 `credit_grants`：余额是批次剩余之和的缓存，三者要始终一致（`tests/unit/credits.test.ts` 核对）。
- 支付商的事件只能经 `src/server/orders.ts` 的 `processPaymentEvent` 落库：webhook、主动查单（`src/server/reconcile.ts`）和 mock 支付都走它。
  - 唯一绕过它的是后台补单（`src/server/admin.ts` 的 `/orders/:id/mark-paid`），用的是同一个 `order:<id>` 幂等键，所以之后迟到的 webhook 不会重复加积分。新增入账路径也必须用这个键。
- 新增支付商按 [docs/payments.md](docs/payments.md) 的清单做，webhook 的返回码语义也在那里。
- 浏览器传来的只能是订单号，不能是付款状态或金额。

## 环境与开关

- 新增环境变量时同时改：`wrangler.jsonc` 和 `wrangler.staging.jsonc` 的 `vars`（两边键要一致，`tests/unit/staging.test.ts` 会检查）、`.dev.vars.example`（密钥；`scripts/sync-secrets.mjs` 拒绝未登记的键，`scripts/sync-plan.mjs` 靠它发现模板新增的密钥）、`npm run cf:types` 重新生成 `worker-configuration.d.ts`（可选密钥写进 `src/env.d.ts`）、`src/server/config-health.ts` 的上线检查规则、[docs/env.md](docs/env.md)；本地开发要和生产取不同值的，加进 `vite.config.ts` 的 `LOCAL_DEV_VARS`。
- `isProduction(env)`（`APP_ENV` 为 `production` 或 `staging`）下必须拒绝 `mock` 服务商、开发登录和 `/api/dev/*`。新增的开发或 mock 端点第一行调用 `isLocalDevRequest`，并在 `tests/smoke/production.spec.ts` 的 404 列表里登记。
- `src/server/config-health.ts` 不能有 import：`scripts/doctor.mjs` 用 Node 直接加载它。
- 密钥只能检查有没有、够不够强，不能出现在日志、接口响应或报错里。

## 文案

- 用户能看到的文案（页面、邮件、错误提示）都要有 `en` 和 `zh` 两份：页面文案在 `src/content/en.ts`、`zh.ts`（`zh` 由 `Content` 类型约束，缺键 typecheck 报错），邮件在 `src/server/email-templates.ts`。组件里不写死字符串。
- 后台 `/admin` 只有中文。
- 文案里的关键词、品牌、天数等从 `site` 读取，不写死。
- 不编造评价、使用人数和划线原价：`anchorPriceCents` 只填真实卖过的价格。首页可选区块（`problem`、`withWithout`）设为 `null` 就不渲染。

## 数据库

- 迁移放在 `migrations/`，按 `000N_<snake_case>.sql` 递增编号，不修改已发布的迁移。部署前 `npm run db:migrate:remote`；`npm run doctor` 会报告远端未应用的迁移。

## 测试

- 每次改完跑 `npm run typecheck && npm test`。改动过程中的 e2e 只跑相关的 spec 加 `smoke.spec.ts`（`npx playwright test tests/e2e/<名字>.spec.ts`，或 `-g '<标题片段>'`），对照表在 [tests/e2e/CATALOG.md](tests/e2e/CATALOG.md) 的“改哪里跑哪些”。
- 完整的 `npm run test:e2e`（需要先 `npm run seed:local`，串行约 10 分钟）在一批改动收尾、提交或合并到站点之前跑一次；动到积分、支付、权限、`src/server.ts` 或 `src/server/app.ts` 这类全站入口时也跑完整的。推送到 `main` 和 PR 时 CI 会跑完整 e2e。
- 同一时间只跑一套 e2e：Playwright 每次运行会清空 `.tmp/video-template-e2e/`，并发运行会互删 trace。端口被占用时用 `E2E_PORT=<port>` 换端口。
- e2e 运行期间不要改 `src/`：dev server 热更新会让正在跑的用例假失败。
- 改了支付商代码（`src/server/payments/`）或下单、回跳、查单流程时，有 test 凭据就跑 `SANDBOX_PROVIDER=dodo|waffo npm run test:sandbox`（见 `docs/payments.md`）。它会自己起 dev server，所以端口不能被占用。
- 新增、改名或删除 e2e 用例时同步 [tests/e2e/CATALOG.md](tests/e2e/CATALOG.md)（按风险归类，写断言要点），`tests/unit/catalog.test.ts` 会核对。改动让某个风险失去覆盖时，写进它的“未覆盖”表。
- 临时文件和测试工件放 `.tmp/<task-slug>/`（已在 `.gitignore`）。
- 用户可见行为的改动同步 README 两份（`README.md`、`README.zh-CN.md`）和 ROADMAP。
