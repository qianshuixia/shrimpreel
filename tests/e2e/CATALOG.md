# e2e 验收目录

按风险列出由哪个用例负责、断言了什么，以及哪些风险没有 e2e 覆盖、为什么。改支付、积分、权限或合规相关代码前先看这里，确认有没有用例兜底。

- P0：出错会造成资金或积分损失、越权、数据泄露、合规事故，或让站点无法使用。
- P1：影响体验、运营统计或可观测性，出错不会直接造成损失。

用例写成 `文件` › `标题`。`tests/unit/catalog.test.ts` 会双向核对：这里引用的标题必须存在，`tests/e2e` 和 `tests/sandbox` 里的每个用例也必须在这里出现。新增、改名或删除用例时要同步更新本文件。

e2e 跑在本地 dev server 上，支付、视频、审核服务商都是 mock，用 `/api/dev/*` 模拟 Cron 和死信消费者。真实支付商的收银台由 `tests/sandbox` 手动验收，见“支付商 sandbox”；其他真实服务商的对接只有单元测试，见文末。

## P0 资金与积分

### 支付事件只入账一次

- `payments.spec.ts` › `并发、重放、退款后迟到的支付事件：积分只入账一次、只回收一次`
  - 5 个并发 paid 事件只有 1 个是 processed；同一事件重放返回 duplicate；退款后迟到的 paid 不会让订单恢复成已支付。
- `email.spec.ts` › `支付邮件：同一事件重放、换事件 ID 重复回调都只发一封，用下单时的语言`
  - 换了事件 ID 的重复回调也只发一封到账邮件（`order_paid:<id>`）。
- `reconcile.spec.ts` › `Cron 对账与查单接口：退避、并发只入账一次、迟到 webhook 不重复、越权与金额不符不自动处理`
  - 5 个并发查单只有 1 个 processed，其余是 throttled 或 skipped；查单入账后迟到的 webhook 返回 duplicate。

### 金额、商品核对与孤儿付款

- `payments.spec.ts` › `付款金额或套餐与订单不符、找不到订单：不入账、告警，退款后结案`
  - 少付或买错套餐时返回 mismatch，不入账；只用了折扣或换了币种时照常入账；找不到订单的付款记为 orphan，其他站点的事件记为 ignored。
  - 健康检查的 `paymentReview` 为 3，退款结案后降为 2；后台能筛出 mismatch 事件。
- `reconcile.spec.ts` › `Cron 对账与查单接口：退避、并发只入账一次、迟到 webhook 不重复、越权与金额不符不自动处理`
  - 少付的订单查单结果为 mismatch，之后 Cron 不再自动查它；后台查单提示人工核对。

### webhook 丢失后的补救

- `reconcile.spec.ts` › `webhook 丢失：成功页久等未到账时主动查单，订单入账并显示成功`
  - 成功页约 15 秒后主动查单，订单变为 paid。
- `reconcile.spec.ts` › `Cron 对账与查单接口：退避、并发只入账一次、迟到 webhook 不重复、越权与金额不符不自动处理`
  - Cron 扫描：下单后 5 分钟内不查，11 分钟时查到 1 单已付、1 单未付；按指数退避，15 分钟时不查、23 分钟时再查 1 单。后台对丢失 webhook 的订单查单后入账，时间线里有查单记录和审计。

### 退款回收积分

- `payments.spec.ts` › `退款事件先于付款事件到达：先拒收等支付商重试，付款入账后重试的退款照常回收积分`
  - 退款先到时返回 500，订单保持 pending；付款入账后，重试的退款照常回收积分。
- `payments.spec.ts` › `积分已部分消费后退款：最多扣到 0，流水记录实际扣除量`
  - 余额最多扣到 0，流水记录实际扣除的剩余积分（套餐积分 − short 档）。
- `payments.spec.ts` › `两次部分退款：按金额比例回收积分，重放幂等，累计退满后订单转 refunded`
  - 按金额比例回收（先 15，再回收剩余的 45），重放不重复回收，累计退满后订单状态转为 refunded。
- `admin.spec.ts` › `管理员退款：参数校验、补登后迟到的同号 webhook 不重复扣、退剩余后订单关闭`
  - 缺备注或金额非法时报 `note_required`、`invalid_amount`；后台补登部分退款按金额比例回收积分后，同一退款单号的 webhook 迟到返回 duplicate；退剩余部分回收剩余积分，再退返回 409 `order_not_paid`；写入 2 条审计。
- `data-management.spec.ts` › `后台订单详情：搜索进入、金额校验失败可重试、部分退款与补单后时间线完整`
  - 超过可退金额时前端拦下，订单不变；改后的部分退款按比例回收积分；失败订单补单后发放积分，时间线有补单记录。

### 支付失败

- `payments.spec.ts` › `支付失败：结果页显示失败，订单 failed，余额不变`

### 生成扣费与退款

- `generation.spec.ts` › `余额不足返回 402，不产生任务也不产生流水`
- `generation.spec.ts` › `生成失败自动退回积分，失败任务没有视频`
  - 流水依次为 −full 档积分、+full 档积分；失败任务的 video 接口返回 404。
- `generation.spec.ts` › `并发轮询只落库一次、成片不被误删；后台记录服务商成本与毛利，未出片的失败任务不记成本`
  - 3 路并发 mock-finish 只落库一次，成片保留；mock 成本为 0，失败任务的成本为 NULL；后台显示毛利。
- `generation.spec.ts` › `风格：不带 styleId 用默认风格，不存在的风格返回 400 invalid_style 且不扣积分`
  - 不存在的 styleId 返回 `invalid_style`，余额不变、没有任务；不带 styleId 时 `templateId` 是默认风格，扣 short 档积分。
- `generation.spec.ts` › `首页切换 hero 标签与生成器同步，选第二个风格生成，记录里是所选风格；?style= 可预选`
  - 只在 `site.styles` 多于一个时运行（模板默认一个，会跳过）：hero 标签与生成器选中项同步，方向键切标签，“Made with”每个风格一行；所选风格写入 `templateId`；`?style=` 预选，无效 id 回到默认风格。
- `alerts.spec.ts` › `死信：任务判失败并只退一次积分；健康检查告警，同一时间桶重复执行不重发`
  - 死信消费者重复处理同一条消息（或和轮询并发）时，积分只退一次。

### 积分批次与到期

- `credits.spec.ts` › `积分批次：先扣快到期的补发积分，失败原路退回，到期作废并在账单页提示`
  - 扣减带有效期返回 `invalid_expiry`；后台补发 short 档少 1 的积分（1 天有效）后，生成 short 档先扣完补发的再扣购买的 1；失败后两个批次都恢复原值。
  - 账单页提示即将到期的补发积分；按“2 天后”作废两次，余额回到购买的积分，只写一条扣掉补发积分的 expire 流水，提示消失。
- `credits.spec.ts` › `并发扣费：余额只够一次时同时发起两个生成，一个成功一个 402，余额不为负`
  - 余额（购买 + 5 限时积分）够一次 full 档、不够两次，两个 full 档生成同时提交：一个 201、一个 402，余额只扣一次，只有一条生成扣费流水。

### 兑换码

- `redeem.spec.ts` › `兑换码：后台生成批次并导出 CSV，用户在设置页兑换，重复、用完、停用、非管理员都被拒绝`
  - 普通用户调用生成、列表、CSV 接口都是 403；后台页面生成 3 个码（7 积分、30 天有效），CSV 带 BOM、表头固定、码与页面一致。
  - 后台停用其中一个；用户在设置页输入小写、去掉横线的码兑换成功，余额 7、到期约 30 天、流水 `redeem` 的 ref 是码；再兑换同一个码显示 `already_redeemed` 文案。
  - 另一个用户兑换已用完的码 409 `code_used_up`，停用、格式不对、不存在的码都是 400 `invalid_code`；账单页流水显示“兑换码”。
- `redeem.spec.ts` › `活动码：指定码可被多人兑换，并发兑换不超出次数`
  - 指定码重复生成 409 `code_exists`，指定码配数量 2、数量 1001、备注为空都返回 400。
  - 可用 3 次的活动码被 5 个用户同时兑换：3 个 200、2 个 409，3 人各到账 2 积分，`used_count` = 3。

### 邀请奖励

- `referrals.spec.ts` › `邀请奖励：好友经链接注册并首单付款，邀请人得积分；第二单不再发，首单退款回收；无效码和老用户不绑定`
  - 设置页显示邀请链接 `/i/<8 位码>`；访问链接 302 回首页、带 `X-Robots-Tag: noindex` 并种 `vt_ref` cookie（小写码也认），注册时 cookie 被消费；无效码不种 cookie，老用户经链接登录不绑定。
  - 好友首单付款：好友到账套餐积分，邀请人到账奖励，流水 `referral` 的 ref 是订单；第二单和没被邀请的用户付款都不再发。
  - 首单退款：邀请人的奖励整笔回收（`referral_refund`），退款重放返回 duplicate 不重复回收；`/api/referral` 统计和后台记录变为 reversed；后台邀请排行页显示“已回收”，普通用户访问后台接口 403。
- `referrals.spec.ts` › `邀请奖励：同一 IP 注册超过上限的不发奖励，后台显示拒绝原因`
  - 用 `cf-connecting-ip: 127.0.0.1` 模拟同一 IP 注册 `referralMaxPerIp + 1` 个账号：前面的是 pending，最后一个 rejected（`ip_limit`），它付款后邀请人余额仍为 0；后台页面显示拒绝原因。

### 订阅

- `subscriptions.spec.ts` › `月付：定价页订阅、积分当月作废、续费新建订单、扣款失败与恢复、到期取消与撤销、终止后可重新订阅`
  - 定价页显示订阅套餐和年付折扣；首付入账订阅的每月积分，`/api/credits/expiring` 的到期时间等于当期结束。
  - 已有订阅时再下单返回 409 `subscription_exists`，还会续费时注销返回 409 `subscription_active`。
  - 续费每期新建一张订单、同一订阅号；同一事件重放返回 duplicate；金额不符返回 mismatch 不入账。
  - 扣款失败时账单页显示提示，续费成功后恢复 active；账单页取消续费显示到期日，撤销后恢复续费提示；门户按钮跳到支付商门户（mock 回到账单页）；支付商终止后卡片显示已结束，可以重新订阅。截图在 `.tmp/subscriptions/`。
- `subscriptions.spec.ts` › `年付：按月补发（重复执行不重发）、状态事件乱序、退款只回收订阅积分并停止补发`
  - 首付只发第一个月；31 天后补发一次，重复执行不再发，订单的 `credits` 累加到两个月的积分。
  - 先到的更晚状态事件生效，迟到的更早事件返回 ignored。
  - 全额退款回收这张订单发过的积分（两个月），另买的积分包不受影响；之后不再补发，`nextGrantAt` 清空。

### 运营参数

- `settings.spec.ts` › `注册赠送和有效期改后立即用于新注册用户；改回默认值删掉存值，审计记录前后值`
  - 赠送 7、有效期 3 天：新用户余额 7、流水 `signup_bonus`、到期约 3 天后；审计记下每项的前后值；提交未变化的值不写库、不记审计；改回默认后存值删除，之后注册的用户不再赠送。
- `settings.spec.ts` › `维护模式：新生成和下单返回 503，已建订单的支付回调照常入账，管理员不受限；前台显示提示条`
  - 普通用户生成和下单返回 503 `maintenance`，余额不变；维护前建的订单付款照常到账；管理员照常下单；中英文首页显示对应语言的提示条，关闭后消失、生成恢复。
- `settings.spec.ts` › `暂停收款：价格页按钮变成“支付即将开放”，下单返回 503，生成和已建订单的回调照常，管理员不受限`
  - 普通用户下单返回 503 `checkout_paused`；暂停前建的订单付款照常到账，生成照常；管理员照常下单；中英文价格页按钮禁用并显示“支付即将开放”、顶部有说明、没有维护提示条；管理员也看到说明但按钮可点；关闭后按钮恢复。
- `settings.spec.ts` › `暂停收款：生成器里的就地购买按钮对普通用户禁用并显示“支付即将开放”`
  - 余额不足的普通用户在中英文首页生成器里，`generator-buy` 禁用并显示 `pricing.paused`。
- `settings.spec.ts` › `收款渠道：非法渠道连同其它改动整体拒绝、不记审计，下单仍走部署配置；后台下拉显示当前 PAYMENT_PROVIDER`
  - 提交 `paypal` 加维护模式返回 400，两项都不变、没有新审计；普通用户下单仍走部署的 mock；后台下拉首项写明当前 `PAYMENT_PROVIDER`，选项为 Waffo、Dodo、Stripe。目标支付商缺密钥、商品 ID 或 Key 模式不符时拒绝切换，由 `tests/unit/settings.test.ts` 覆盖（本地 `.dev.vars` 配得是否齐全因人而异）。
- `settings.spec.ts` › `全站每日生成上限：达到上限后返回 429 且不扣积分，调高后恢复`
  - 上限设为 1 时下一个任务返回 429 `daily_limit`，余额和 `generation` 流水不变；改回 0（不限）后可以生成。并发提交时 batch 内断言兜底由单元测试覆盖。

## P0 权限与安全

### 越权访问

- `admin.spec.ts` › `未登录与普通用户进不了后台，后台接口同样拒绝`
  - 未登录返回 401，普通用户返回 403。
- `generation.spec.ts` › `上传校验与越权：伪装 JPEG 返回 415，不能用别人的上传发起生成`
  - 用别人的 upload 返回 400 `invalid_upload`，别人的 `/media/uploads` 读不到。
- `data-management.spec.ts` › `用户账单与订单详情：实付与部分退款展示，他人订单接口与页面都拿不到`
  - 他人订单的用户接口返回 404，后台接口返回 403，页面显示找不到。
- `reconcile.spec.ts` › `Cron 对账与查单接口：退避、并发只入账一次、迟到 webhook 不重复、越权与金额不符不自动处理`
  - 对别人的订单查单返回 404。
- `attribution.spec.ts` › `后台报表页渲染漏斗与来源表；普通用户无权访问报表接口`
  - 普通用户访问报表和订单 CSV 返回 403。
- `data-management.spec.ts` › `后台用户：付费 / 封禁筛选、按积分排序、详情汇总与审计`
  - 非法的排序参数回退到默认排序，不会拼进 SQL。
- `settings.spec.ts` › `运营设置只有管理员能读写；未知参数、越界值整体拒绝；未知探测目标 404`
  - 未登录 401、普通用户 403（读、写、测试连接）；`FAL_KEY` 这类未知参数和越界值返回 400 `invalid_setting`，同一次提交里合法的项也不保存。

### CSRF 与开发入口

- `payments.spec.ts` › `未带同源 Origin 的写请求被 CSRF 校验拒绝`
  - 不带 Origin 或跨站的写请求返回 403。
- `attribution.spec.ts` › `dev 登录与 mock 支付只接受本机直连`
  - 带 `cf-connecting-ip` 或 `x-forwarded-for` 的请求（经隧道或代理）访问 dev 登录和 mock 支付都返回 404。
- `security-headers.spec.ts` › `CSP 报告接口：不要求同源、只回 204，超大或非 JSON 报告直接丢弃`
  - 只有 CSP 报告接口豁免同源校验，其他写接口仍返回 403。
- 线上开关由 smoke 巡检覆盖，见下文“部署后巡检”。

### 登录跳转

- `sign-in.spec.ts` › `登录后的跳转只落在站内：恶意 redirect 回退到个人中心，站内地址连同查询串和锚点保留`
  - 4 种会被浏览器解析成站外地址的 redirect 都回到 `/dashboard`，没有任何请求发往站外；站内地址连同查询串和锚点保留。
- `sign-in.spec.ts` › `登录页只显示已知错误码的文案：__proto__ 等原型属性名显示通用错误，页面不崩溃`

### 上线配置

- `admin.spec.ts` › `后台概览显示上线配置检查：本地开发配置报错，接口只回传问题不回传密钥值`
  - 本地配置下 `APP_ENV`、`PAYMENT_PROVIDER`、`SITE_URL` 报 error，没有绑定缺失；响应里不出现 `.dev.vars` 的值。

## P0 合规与用户数据

- `compliance.spec.ts` › `举报下架：匿名在 /report 举报 → 管理员下架 → 同一原图的全部视频删除、再次上传被拦截，其它视频不受影响`
  - 举报校验失败不入库；只给出下载文件名也能定位视频。管理员下架后，同一原图的 2 条视频返回 410 `media_removed`，无关视频仍可播放；同一张图再上传返回 422；已处理的举报再处理返回 409；审计记下架数量。
- `compliance.spec.ts` › `上传审核不通过返回 422，不落盘；之后正常图片仍可上传`
- `compliance.spec.ts` › `数据保留：进行中任务的原图不清理；到期后原图不能再用、成片按期过期，个人中心显示已过期`
  - 任务进行中的原图不清理；原图 7 天后过期，不能再用来生成；成片 30 天后过期，返回 410 `media_expired`；重复清理不会重复处理。
- `compliance.spec.ts` › `导出我的数据：设置页下载 JSON，含本人全部记录；不含他人数据和内部字段；未登录与注销后 401`
  - 导出包含账户、订单、流水、上传、生成、留言、举报和邮件；不含他人的订单、举报和邮箱，也不含 R2 路径、`provider_request_id`、邮件参数等内部字段；响应头为 `private, no-store`；注销后返回 401。
- `email.spec.ts` › `留言只提醒管理员、不给留言人发信；注销账号清掉该用户的发件记录`
  - 注销账号后发件记录被清除；不给留言人发信，避免被用来给任意地址发邮件。
- `share.spec.ts` › `公开分享：个人中心开启 → 匿名访客看到 noindex 的分享页和 AI 标识 → 他人无权操作 → 停止分享后旧链接 404，到期后 410`
  - 分享页响应头和 meta 都是 noindex，HTML 不含 generation id；视频支持 Range（206），`/zh` 前缀可用；举报入口把分享链接预填进举报表单；他人开启或停止分享返回 404；停止分享后旧链接和媒体 404，重新分享得到新链接；封面不是 JPEG 返回 415、审核不通过返回 422 `share_rejected`；成片到期后页面和封面 410，不能再分享（410 `media_expired`）。
- `share.spec.ts` › `分享链接被举报：凭分享链接即可定位视频，下架后分享页和媒体 410`
  - 举报只给带 `/zh` 前缀的分享链接，管理员下架时不传视频 ID 也能定位；下架后页面、视频、封面都是 410，`/api/shares/:id` 的状态为 `removed`。

## P0 主路径

- `smoke.spec.ts` › `新用户：登录 → 购买 → 生成 → 个人中心看到视频与账单`
  - 全程走 UI；成片带 AI 角标，`video/mp4` 返回 200；账单 1 条订单、2 条流水（+套餐积分、−short 档）。
- `smoke.spec.ts` › `中文站：购买流程全程保持 /zh 前缀`
  - 全程保留 `/zh` 前缀，`lang` 为 `zh-CN`。
- `smoke.spec.ts` › `生成器就地购买：余额不足时按钮是够用的最便宜的包，点击进收银台，付款后积分到账`
  - 余额不足时 `generator-buy` 显示“够补缺口的最便宜的包”的积分和价格（从 site 推导），旁边有指向 `/pricing` 的“查看全部套餐”；点击直达 mock 收银台，付款后导航栏积分 = 原余额 + 包积分。

## P1 交易邮件

- `email.spec.ts` › `支付邮件：同一事件重放、换事件 ID 重复回调都只发一封，用下单时的语言`
- `email.spec.ts` › `生成邮件：成功、失败退积分各一封，跟随用户最近使用的语言；重复标记失败不重发`
- `email.spec.ts` › `举报邮件：未登录举报不发回执，只提醒管理员；临近截止、超时各提醒一次；下架后通知举报人和作者，不再提醒；登录用户填本人邮箱才收回执`
  - 未登录举报填的邮箱收不到回执（表单不能被用来给任意地址发信）；截止前 12 小时和超时各提醒一次，同一阶段重复执行 Cron 不重发；下架后举报人和作者各收一封，之后不再提醒；已发送的邮件不能重发（409）；登录用户填本人邮箱（忽略大小写）收回执，填别人的邮箱不发。
- `email.spec.ts` › `留言只提醒管理员、不给留言人发信；注销账号清掉该用户的发件记录`

## P1 告警与错误上报

- `alerts.spec.ts` › `死信：任务判失败并只退一次积分；健康检查告警，同一时间桶重复执行不重发`
  - 失败率和死信告警各发一封；同一时间桶内重复检查不重发；`since` 格式非法返回 400。
- `client-errors.spec.ts` › `全局异常和未处理的 Promise 拒绝各报一次：带编号、页面地址不带 query；重复错误只报一次，每页最多 5 条，跨域 Script error 不报`
- `client-errors.spec.ts` › `渲染出错时显示错误页和错误编号，编号与上报一致；接口恢复后点重试回到正常页面`
- `client-errors.spec.ts` › `上报接口不要求同源、只回 204；非 JSON 或超大的上报直接丢弃`

## P1 安全响应头

- `security-headers.spec.ts` › `页面下发 CSP Report-Only 和 Permissions-Policy，内联脚本都带本次请求的 nonce；API 不带 CSP`
- `security-headers.spec.ts` › `公开页、登录后生成和后台都没有 CSP 违规与水合错误；不带 nonce 的注入脚本会被报告`
- `security-headers.spec.ts` › `CSP 报告接口：不要求同源、只回 204，超大或非 JSON 报告直接丢弃`

## P1 SEO 与多语言

- `seo.spec.ts` › `SSR 输出满足 seo-check 全部 error 级规则`
- `seo.spec.ts` › `中英文首页水合无报错，H1/标题与 SSR 一致`
- `seo.spec.ts` › `客户端路由切换后 head 同步更新（canonical 不残留上一页）`
- `seo.spec.ts` › `语言链接：SSR 中可抓取，点击后保留路径、查询参数和 hash`
- `seo.spec.ts` › `页脚“问问 AI”：SSR 中带 nofollow 链接，中文站用中文提问并附 llms.txt，llms.txt 可访问`
- `seo.spec.ts` › `文章封面：卡片和文章顶部显示，og:image 与 Article.image 用封面，SPA 切换后不残留；没填的用默认图`
  - 每个 `cover` 文件都能访问（路径写错即失败）；SSR 只有一个 `og:image` 且宽高声明在它后面；列表 → 文章 → 列表走 SPA 导航后 `og:image` 先换成封面、再恢复默认图。

## P1 运营与数据管理

- `attribution.spec.ts` › `来源归因：UTM 落地后 direct 回访，注册与订单仍记在原渠道，报表与 CSV 可见`
- `attribution.spec.ts` › `后台报表页渲染漏斗与来源表；普通用户无权访问报表接口`
- `admin.spec.ts` › `管理员调整积分与封禁：余额、流水、审计、会话同步生效`
  - 流水原因为 `admin_adjust`；扣成负数返回 400；封禁后会话立即失效。
- `data-management.spec.ts` › `用户账单与订单详情：实付与部分退款展示，他人订单接口与页面都拿不到`
- `data-management.spec.ts` › `后台订单详情：搜索进入、金额校验失败可重试、部分退款与补单后时间线完整`
- `data-management.spec.ts` › `后台用户：付费 / 封禁筛选、按积分排序、详情汇总与审计`
- `data-management.spec.ts` › `积分明细超过一页：加载更多后条目完整且不重复`
- `payments.spec.ts` › `未登录回到结果页：提示登录，不无限转圈；支付商回跳带的邮箱在渲染前就被 302 去掉`
  - 带 `email`、`status` 等参数的结果页（含 `/zh/` 前缀）先 302 到只带 `order` 的地址，响应 `Referrer-Policy: no-referrer`；`order` 里的特殊字符保持编码。
- `settings.spec.ts` › `全站公告按语言显示，提交时压成一行；清空后不显示`
- `settings.spec.ts` › `后台运营设置页：只提交改动项、显示修改人、恢复默认；测试连接逐项给出结果并记审计`
  - 确认框列出改动前后值；保存后显示修改人，恢复默认后显示“使用默认值”；本地 6 项测试连接都是“正常”，发信项给管理员发了测试邮件，每次测试记一条 `probe.run` 审计。

## 部署后巡检（tests/smoke）

`npm run test:smoke` 对线上地址只读巡检（运行方法见 README 的“部署后巡检”），覆盖 e2e 无法覆盖的线上开关：

- `production.spec.ts` › `开发与 mock 入口全部关闭：同源 POST 也是 404，页面也打不开`
- `production.spec.ts` › `跨站 POST 被 CSRF 拦下；未签名的支付与生成回调被拒`
- `production.spec.ts` › `健康检查与未登录会话：开发登录关闭，支付商不是 mock`
- `production.spec.ts` › `安全响应头：页面带 CSP，https 下有 HSTS，接口不带 CSP`
- 另有 sitemap 全部页面可打开、首页水合、未登录拒绝、robots 与环境一致等用例。

## 支付商 sandbox（tests/sandbox）

`SANDBOX_PROVIDER=dodo|waffo|stripe npm run test:sandbox` 用 `.dev.vars` 里的 test 凭据走真实收银台和测试卡，默认不进 CI（用法见 `docs/payments.md` 的“sandbox e2e”）。没有公网隧道时靠结果页的主动查单入账；设 `SANDBOX_WEBHOOK=1` 时还会等 webhook 到达，并跑依赖 webhook 的退款和订阅用例。

- `dodo.spec.ts` › `测试卡付款：跳回结果页显示到账，积分只入账一次，再次查单不重复入账`
- `dodo.spec.ts` › `拒付卡：不加积分，查单不会把失败的付款当成到账；有 webhook 时订单转 failed`
- `dodo.spec.ts` › `部分退款：退款 webhook 到达后按比例回收积分，订单仍是 paid`（仅 `SANDBOX_WEBHOOK=1`）
- `dodo.spec.ts` › `订阅：月付走真实收银台，webhook 激活订阅并发当月积分；取消续费和撤销同步到 Dodo，门户地址可打开，最后取消续费`（仅 `SANDBOX_WEBHOOK=1`）
  - 当期约一个月，周期来自 Dodo；当月积分的到期时间等于当期结束；取消、撤销后迟到的 `subscription.updated` 不把状态改回去，事件里没有 failed 或 mismatch。需要 API 密钥有 Subscriptions 写入。
- `waffo.spec.ts` › `测试卡付款：点 Done 跳回结果页显示到账，积分只入账一次，再次查单不重复入账`
- `waffo.spec.ts` › `拒付卡：Waffo 显示付款失败，查单不会把失败的付款当成到账，订单留在 pending`
- `waffo.spec.ts` › `订阅：月付走真实收银台，webhook 激活订阅并发当月积分；门户地址可打开，取消续费后 Waffo 回 canceling`（仅 `SANDBOX_WEBHOOK=1`）
  - 首付事件是 `subscription.payment_succeeded`，只入账一次；状态事件校正周期后，当月积分的到期时间仍等于当期结束；`canResume` 为 false（撤销只能在门户里）；取消后收到 `subscription.canceling`，积分不变。
- `stripe.spec.ts` › `测试卡付款：跳回结果页显示到账，积分只入账一次，再次查单不重复入账`
  - 用 `4000 0000 0000 0077`（直接进可用余额），后面的退款不会挂起；`provider_payment_id` 是 `pi_`，查单和 webhook 只入账一次。
- `stripe.spec.ts` › `拒付卡：收银台提示被拒、留在收银台，不加积分，查单不会把失败的付款当成到账`
- `stripe.spec.ts` › `部分退款：退款 webhook 到达后按比例回收积分，订单仍是 paid；重放同一退款不重复回收`（仅 `SANDBOX_WEBHOOK=1`）
- `stripe.spec.ts` › `订阅：月付走真实收银台，invoice.paid 建订阅并发当月积分；取消续费和撤销同步到 Stripe，门户地址可打开，最后取消续费`（仅 `SANDBOX_WEBHOOK=1`）
  - 首付只按 `invoice.paid` 入账一次；当月积分的到期时间等于当期结束；门户要先在 Stripe 后台保存配置。
- Waffo 退款不进用例：退款异步（12–22 分钟），每笔支付只能退一次。

## 只由单元测试覆盖

这些逻辑依赖外部服务或需要穷举边界，放在 `tests/unit`：

- 支付商对接：Waffo、Dodo、Stripe 的验签（篡改、重放、时间窗、test/live 不符、密钥轮换）、事件映射和查单（`waffo.test.ts`、`dodo.test.ts`、`stripe.test.ts`）。Stripe 另测验签后按固定 API 版本重取对象、折扣与少付、订阅首付以 `invoice.paid` 为准、退款按 `re_` 幂等。
- 退款规则：比例与四舍五入、按币种换算、退款单号格式、各支付商的退款期限、金额与商品核对（`refunds.test.ts`）。
- 积分账务：先到期先扣、余额不足整体回滚、明细原路退回、Cron 作废幂等、退款先扣该订单的批次、迁移前的旧余额与旧任务，每步核对流水之和 = 缓存余额 = 批次剩余之和（`credits.test.ts`，在 `node:sqlite` 上执行全部迁移）。
- 兑换码：码的生成、展示与输入规范化；兑换后的批次与有效期，重复、用完、停用、截止的错误码；预检查之后状态变化（并发用完、刚被停用）由 batch 内断言兜底（`redeem.test.ts`）。
- 邀请奖励：邀请码规范化、IP 加盐哈希（IPv6 按 /64）；邀请人被封禁或注销、30 天奖励上限（已回收的也计入）；同一被邀请人两单并发入账只发一次、两笔退款并发只回收一次、邀请人已花掉的最多扣到 0（`referrals.test.ts`）。
- 订阅：日历月相加（月末、闰年）、年付补发窗口与跳过已过期的月份；首付、续费订单号派生、续费金额核对、逾期恢复；首付不带周期时状态事件校正周期，当期积分的到期时间一起对齐；状态事件按发生时间防乱序、到期取消且当期结束后不再算有效订阅；退款只回收订阅批次并停止补发；Dodo、Waffo 订阅事件的映射（`subscriptions.test.ts`；Stripe 的在 `stripe.test.ts`）。
- 运营参数：提交校验（未知字段、越界、类型、长度）与公告规范化、存值合并时丢弃非法值、KV 缓存未命中读 D1 并回写、坏 JSON 行忽略；每日上限按 UTC 自然日计数、超出时整个 batch 回滚；邀请奖励暂停期间付款的首单记为 `paused`，恢复后第二单不补发（`settings.test.ts`、`referrals.test.ts`）。
- 测试连接：Dodo、Stripe 逐个套餐核对商品与价格（低于 site.ts 为失败、高于或币种不同为提示）、Key 无效与商品不存在；fal 和 yir 的余额与权限分支；R2、KV 不留探测数据；说明文字里的密钥值被替换（`probes.test.ts`）。Dodo、Waffo 的探测另用 test 凭据实测过一次。
- 第三方校验：Turnstile 的启用与失败分支，OpenAI 审核接口异常时拒绝（fail closed）（`compliance.test.ts`）。
- 发信重试：临时错误退避、永久错误不重试，邮件头注入（`email.test.ts`）。
- 生产开关：生产和预发拒绝 mock（`providers.test.ts`）、弱 `SESSION_SECRET`（`security.test.ts`）、上线配置与 doctor（`config-health.test.ts`）、预发配置与 robots（`staging.test.ts`）。
- 登录：Google 授权码流程的 PKCE 与 nonce、One Tap 的 nonce（`google.test.ts`）；账号以 Google `sub` 为准、注销过的邮箱重新注册不发赠送（`auth.test.ts`）。
- 成片下载：服务商返回的成片超过大小上限时不写 R2，没有 Content-Length 时边读边计数（`output-download.test.ts`）。
- 运维：D1 导出的 SQL 转义与备份文件命名（`backup.test.ts`）；付款即时通知按 webhook 地址识别 Telegram、飞书、Discord，报错里不带地址（`chat-notify.test.ts`）。
- 其他：告警阈值与时间桶（`alerts.test.ts`）、归因解析与 CSV 公式注入（`attribution.test.ts`）、归因 Cookie 在同意后才写入、拒绝时删除（`attribution-consent.test.ts`）、GA4 同意与撤回（`consent.test.ts`）、错误与 CSP 报告的脱敏（`client-error.test.ts`、`csp.test.ts`）。

## 未覆盖

| 风险 | 为什么没有 e2e | 现有保障 | 计划 |
| --- | --- | --- | --- |
| 真实支付商的 webhook 和退款 | 需要公网隧道和支付商后台的 webhook 地址，Waffo 退款还要等十几分钟 | 验签与映射的单元测试；sandbox e2e 无隧道时验证收银台、回跳和查单入账；webhook 模式手动跑 | 发版前按需跑 `SANDBOX_WEBHOOK=1` |
| 真实支付商的订阅续费、扣款失败，Dodo 的取消与撤销；Stripe 的异步付款方式和 `refund.failed` | test 模式触发不了续费和扣款失败（要等一个计费周期）；Dodo 的取消要 API 密钥有 Subscriptions 写入，模板的 test 密钥还没有 | 首付、激活、当月积分、门户和 Waffo 的取消由 sandbox 订阅用例覆盖（2026-10-21 手动跑过）；续费和扣款失败有按文档构造的映射单元测试，e2e 用 mock 订阅事件走同一套入账逻辑 | 补上密钥权限后重跑 Dodo 订阅用例；Stripe 退款后又失败时积分不会自动恢复，靠人工处理；第一个热词站上线后观察第一次真实续费 |
| 真实视频生成和 `/api/webhooks/fal`、`/api/webhooks/yir`、`/api/webhooks/nanoapi` 的成功回调 | 需要 `FAL_KEY`、`YIR_API_KEY` 或 `NANOAPI_API_KEY`，每次调用要付费；e2e 用 mock 服务商，靠轮询完成 | yir 的提交、查询、错误映射、实际成本和两步走（合成首帧 → 动作参考）有 provider 契约单元测试（`yir.test.ts`，按 yir 文档构造响应），进入下一步的落库由 `jobs.test.ts` 覆盖；NanoAPI 的创建、去重、查询、错误映射和成本有 `nanoapi.test.ts`，2026-10-25 用真实 key 经隧道手动跑通一单（webhook、转存 R2、实际成本、列表去重字段）；smoke 巡检检查未签名回调返回 401 | fal、yir 的 webhook 回调在第一个热词站上线后观察 |
| 真实发信与投递 | 本地 `send_email` binding 只模拟发送 | e2e 断言发件箱记录；单元测试覆盖渲染和重试 | 线上验证随第一个热词站 |
| Google OAuth 与 One Tap 登录 | 需要真实 Google 账号，e2e 用 dev 登录 | 单元测试覆盖跳转校验、PKCE、nonce 和按 `sub` 绑定 | 线上验证随第一个热词站 |
| Turnstile 浏览器端校验 | 需要真实站点密钥 | 服务端校验的单元测试 | 线上验证 |
| OpenAI 图片审核的真实调用 | 需要 `OPENAI_API_KEY` | e2e 用 mock 拒绝；单元测试覆盖响应解析和失败时拒绝 | 线上验证 |
| 运营参数在线上的生效延迟 | 本地 KV 没有边缘缓存，保存后立即生效；线上 `cacheTtl` 60 秒的实际表现要在部署后看 | 保存时直接刷新 KV；单元测试覆盖缓存读写 | 线上验证随第一个热词站 |
| fal、yir、NanoAPI、OpenAI 的测试连接 | 需要真实 key | `probes.test.ts` 按文档构造响应 | 第一个热词站配好 key 后在后台点一次 |
| 限流（`UPLOAD_LIMITER`、`GENERATE_LIMITER`、`AUTH_LIMITER`） | 要在 60 秒内打满额度；本地 binding 的计数是否和线上一致没有核实过 | 无 | 线上手工验证 |
| Queues 真实重试与死信、Cron 真实触发 | 真实死信要重试 10 次（约 35 分钟） | 用 `/api/dev/dead-letter`、`/api/dev/sweep`、`/api/dev/health-check` 等模拟 | 无 |
| 支付争议与拒付 | test 模式无法触发 | 不认识的事件记为 ignored（单元测试） | 遇到时再补 |
| Cookie 同意横幅 | 模板没有填 `ga4Id`，横幅不显示 | `consent.test.ts`（含按国家取默认值）；归因 Cookie 的同意逻辑由 `attribution-consent.test.ts` 覆盖 | 热词站填了 `ga4Id` 后手工检查，带 `cf-ipcountry: US` 和 `DE` 各访问一次 |
| 分享封面截帧和社交平台预览 | Playwright 的 Chromium 不带 H.264 解码，截帧返回 null，e2e 改为直接上传 fixture 照片；社交平台抓取需要公网地址 | 服务端封面校验（长度、JPEG、审核）由 `share.spec.ts` 覆盖；截帧失败时分享页回落到站点默认 OG 图 | 热词站上线后在 Chrome、Safari 各分享一次，用平台的链接调试工具检查预览 |
| D1 备份的线上 Cron 与恢复 | 模板不部署；本地只能用 `/api/dev/backup` 触发 | `backup.test.ts`；本地做过一次导出 → `scripts/restore-d1.mjs` 恢复的往返核对 | 热词站上线后确认 R2 每天有新文件，按 README 演练一次恢复 |
| 付款即时通知的真实发送 | 需要真实的 Telegram、飞书或 Discord webhook | `chat-notify.test.ts` 按各平台文档构造请求 | 热词站配置 webhook 后付一单测试款 |
| 移动端视口、Firefox 和 Safari | 只跑 Desktop Chrome，控制运行时间 | 无 | 按需加 project |
| 线上真实域名巡检 | 模板不部署 | smoke 巡检已在本地生产模式跑通 | 第一个热词站上线后执行 |
