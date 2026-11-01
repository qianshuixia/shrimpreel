import { DEFAULT_LOCALE, LOCALE_META, isLocale, localePath, site, type Locale } from '#/config/site'
import type { AlertKind } from './alerts'

// 交易邮件模板。用户邮件每种语言一份（新增语言时类型检查会要求补齐），管理员邮件固定中文（后台是中文）。
// 用户输入（姓名、留言内容等）只出现在正文并全部转义，不进 Subject。

export interface TemplateParams {
  generation_succeeded: { generationId: string; expiresAt: string | null }
  generation_failed: { generationId: string; credits: number }
  order_paid: { orderId: string; credits: number; amount: string }
  takedown_received: { reportId: string; dueAt: string }
  takedown_resolved: { reportId: string; outcome: 'removed' | 'rejected' }
  content_removed: { reportId: string; videos: number }
  admin_takedown: { reportId: string; stage: 'new' | 'due_soon' | 'overdue'; reason: string; generationId: string | null; dueAt: string }
  admin_contact: { messageId: string; topic: string; email: string; message: string }
  // 支付争议：stage 是争议阶段或 fraud_warning（欺诈预警）；credits 为回收（opened）或补回（won）的积分；detail 为补充说明（如自动退款结果）
  admin_dispute: {
    orderId: string
    stage: 'opened' | 'won' | 'lost' | 'closed' | 'fraud_warning'
    credits: number
    amount: string | null
    reason: string | null
    detail: string | null
  }
  // count：异常数量；total：分母（只有失败率有）；windowMinutes：统计窗口（积压为“超过多少分钟未完成”）
  admin_alert: { kind: AlertKind; count: number; total: number | null; windowMinutes: number; detail: string | null }
}

export type EmailTemplate = keyof TemplateParams
type AdminTemplate = 'admin_takedown' | 'admin_contact' | 'admin_dispute' | 'admin_alert'
type UserTemplate = Exclude<EmailTemplate, AdminTemplate>

export interface RenderedEmail {
  subject: string
  text: string
  html: string
  replyTo: string
}

type Block = {
  subject: string
  heading: string
  paragraphs: string[]
  cta?: { label: string; url: string }
  footer?: string
  replyTo?: string // 默认 site.supportEmail
}
type Ctx = { siteUrl: string; locale: Locale }
type Render<K extends EmailTemplate> = (p: TemplateParams[K], ctx: Ctx) => Block

const brand = site.brandName

function link(ctx: Ctx, path: string) {
  return `${ctx.siteUrl}${localePath(ctx.locale, path)}`
}

function date(ctx: Ctx, iso: string, withTime = false) {
  return new Intl.DateTimeFormat(LOCALE_META[ctx.locale].tag, {
    dateStyle: 'medium',
    ...(withTime ? { timeStyle: 'short' } : {}),
    timeZone: 'UTC',
  }).format(new Date(iso)) + (withTime ? ' UTC' : '')
}

const AI_FOOTER: Record<Locale, string> = {
  en: `Videos made with ${brand} are AI-generated. Please label them as AI when you share them.`,
  zh: `${brand} 生成的视频均为 AI 生成，分享时请注明。`,
}

const REASONS_ZH: Record<string, string> = {
  intimate: '私密影像',
  impersonation: '冒用肖像',
  minor: '涉及未成年人',
  copyright: '版权',
  other: '其他',
}

const TOPICS_ZH: Record<string, string> = { general: '一般咨询', billing: '账单', bug: 'Bug', partnership: '合作' }

function span(minutes: number) {
  return minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`
}

type AlertParams = TemplateParams['admin_alert']
const ALERTS_ZH: Record<AlertKind, (p: AlertParams) => { title: string; summary: string; hint: string; path: string }> = {
  generation_failures: (p) => ({
    title: `生成失败率 ${Math.round((p.count / (p.total || p.count)) * 100)}%`,
    summary: `最近 ${span(p.windowMinutes)}完成的 ${p.total} 个生成任务中有 ${p.count} 个失败（不含管理员手动失败和举报下架）。失败任务已自动退积分。`,
    hint: '常见原因：视频服务商故障或限流、服务商账户余额不足、API Key 失效。',
    path: '/admin/generations',
  }),
  dead_letter: (p) => ({
    title: `${p.count} 个任务进入死信队列`,
    summary: `最近 ${span(p.windowMinutes)}有 ${p.count} 个生成任务的队列消息重试耗尽，已判失败并退积分。`,
    hint: '说明队列消费者在持续报错（服务商接口异常、R2 读写失败等），请在 Workers 日志里搜索 "video job failed"。',
    path: '/admin/generations',
  }),
  provider_account: (p) => ({
    title: `视频服务商账户异常：${p.count} 个任务失败`,
    summary: `最近 ${span(p.windowMinutes)}有 ${p.count} 个生成任务因服务商账户问题失败（${p.detail ?? ''}），已自动退积分。不处理的话之后的任务都会失败。`,
    hint: '按错误码处理：provider_not_configured 是没配密钥；YIR_UNAUTHORIZED 是密钥失效；YIR_INSUFFICIENT_BALANCE 到 yir 后台充值；YIR_SPEND_LIMIT_EXCEEDED 调高 API Key 的月度额度；nanoapi_invalid_api_key 是 NanoAPI 密钥失效；nanoapi_insufficient_balance 到 NanoAPI 后台充值；nanoapi_account_suspended 是账户被停用，联系 NanoAPI 支持。',
    path: '/admin/generations',
  }),
  provider_balance: (p) => ({
    title: '视频服务商余额不足',
    summary: `${p.detail ?? '余额偏低'}，已低于预警线。余额耗尽后所有生成任务都会失败（失败会退积分）。`,
    hint: '请尽快到视频服务商后台充值；高峰期前建议多充一些。余额每小时检查一次，持续偏低每 6 小时提醒一次。',
    path: '/admin/generations',
  }),
  job_backlog: (p) => ({
    title: `${p.count} 个任务积压`,
    summary: `${p.count} 个生成任务创建超过 ${span(p.windowMinutes)}仍未完成，超时后会自动判失败并退积分。`,
    hint: '可能是队列消费者没有运行、服务商排队过长，或 Cron 没有触发。',
    path: '/admin/generations',
  }),
  payment_webhook: (p) => ({
    title: `${p.count} 个支付回调处理失败`,
    summary: `最近 ${span(p.windowMinutes)}有 ${p.count} 个支付回调处理失败且没有重放成功，用户可能已付款但积分没到账。`,
    hint: '支付商会自动重试回调；持续失败请在后台“支付事件”页查看错误，修复后到支付商后台重发。',
    path: '/admin/events',
  }),
  payment_review: (p) => ({
    title: `${p.count} 笔付款待人工核对`,
    summary: `最近 ${span(p.windowMinutes)}有 ${p.count} 个付款成功回调没有入账：找不到对应订单，或实收金额、币种、商品和订单不一致。`,
    hint: '在“支付事件”页按状态筛选“孤儿事件”“金额/商品不符”查看原因；核实已付款就在订单页补单，否则到支付商后台退款。',
    path: '/admin/events',
  }),
  email_failures: (p) => ({
    title: `${p.count} 封邮件发送失败`,
    summary: `最近 ${span(p.windowMinutes)}有 ${p.count} 封邮件发送失败或多次重试仍未发出。`,
    hint: '如果是发件域名或配额问题，这封告警本身也可能发不出去，请同时查看 Workers 日志。修复后可在后台“邮件”页重发。',
    path: '/admin/emails',
  }),
  backup_failed: (p) => ({
    title: 'D1 每日备份失败',
    summary: `今天的数据库备份连续 ${p.count} 次失败，今天不再重试：${p.detail ?? ''}`,
    hint: '在 Workers 日志里搜索 "d1 backup failed"。数据库过大导致超时或超内存时，改用 wrangler d1 export 手动导出；D1 Time Travel 仍可恢复 30 天内的任意时刻。',
    path: '/admin',
  }),
}

// 告警的聊天群纯文本（alerts.ts 发到 PAYMENT_NOTIFY_WEBHOOK_URL），内容与告警邮件同源
export function alertChatText(p: AlertParams) {
  const alert = ALERTS_ZH[p.kind](p)
  return [`【${brand}】告警：${alert.title}`, alert.summary, p.detail ? `详情：${p.detail}` : '', alert.hint].filter(Boolean).join('\n')
}

const USER_TEMPLATES: { [K in UserTemplate]: Record<Locale, Render<K>> } = {
  generation_succeeded: {
    en: (p, ctx) => ({
      subject: `Your ${brand} video is ready`,
      heading: 'Your video is ready',
      paragraphs: [
        'Your AI video is ready to watch and download.',
        p.expiresAt ? `We keep it until ${date(ctx, p.expiresAt)}, then delete it automatically. Download a copy if you want to keep it.` : '',
      ],
      cta: { label: 'Open my videos', url: link(ctx, '/dashboard') },
      footer: AI_FOOTER.en,
    }),
    zh: (p, ctx) => ({
      subject: `你的 ${brand} 视频已生成`,
      heading: '视频已生成',
      paragraphs: ['你的 AI 视频已经可以观看和下载了。', p.expiresAt ? `成片保存到 ${date(ctx, p.expiresAt)}，之后会自动删除；需要长期保留请及时下载。` : ''],
      cta: { label: '查看我的视频', url: link(ctx, '/dashboard') },
      footer: AI_FOOTER.zh,
    }),
  },

  generation_failed: {
    en: (p, ctx) => ({
      subject: `Your ${brand} video failed — credits refunded`,
      heading: "We couldn't make your video",
      paragraphs: [
        `Something went wrong while generating your video. We've returned ${p.credits} credits to your balance.`,
        'You can try again with the same photo, or use a clear, front-facing one.',
      ],
      cta: { label: 'Try again', url: link(ctx, '/') },
    }),
    zh: (p, ctx) => ({
      subject: `你的 ${brand} 视频生成失败，积分已退回`,
      heading: '视频生成失败',
      paragraphs: [`这次生成没有成功，${p.credits} 个积分已退回你的账户。`, '可以用同一张照片再试一次，或者换一张正脸清晰的照片。'],
      cta: { label: '重新生成', url: link(ctx, '/') },
    }),
  },

  order_paid: {
    en: (p, ctx) => ({
      subject: `${p.credits} credits added to your ${brand} account`,
      heading: 'Credits added',
      paragraphs: [
        `Thanks for your purchase! ${p.credits} credits have been added to your account (order ${p.orderId}, ${p.amount}).`,
        'Your payment receipt is sent separately by our payment provider.',
      ],
      cta: { label: 'Create a video', url: link(ctx, '/') },
    }),
    zh: (p, ctx) => ({
      subject: `${p.credits} 个积分已到账`,
      heading: '积分已到账',
      paragraphs: [`感谢购买！${p.credits} 个积分已加到你的 ${brand} 账户（订单 ${p.orderId}，${p.amount}）。`, '付款收据由支付服务商另行发送。'],
      cta: { label: '开始生成', url: link(ctx, '/') },
    }),
  },

  takedown_received: {
    en: (p, ctx) => ({
      subject: `We received your report (${p.reportId})`,
      heading: 'Report received',
      paragraphs: [
        `Reference: ${p.reportId}. We'll review it by ${date(ctx, p.dueAt, true)} and email you the outcome.`,
        'To add information, such as a link or the file name of the video, reply to this email.',
      ],
    }),
    zh: (p, ctx) => ({
      subject: `我们已收到你的举报（${p.reportId}）`,
      heading: '已收到举报',
      paragraphs: [
        `举报编号：${p.reportId}。我们会在 ${date(ctx, p.dueAt, true)} 前处理完毕，结果会发到这个邮箱。`,
        '需要补充信息（例如视频链接或下载文件名）请直接回复本邮件。',
      ],
    }),
  },

  takedown_resolved: {
    en: (p) => ({
      subject: `Update on your report (${p.reportId})`,
      heading: p.outcome === 'removed' ? 'Content removed' : 'No action taken',
      paragraphs:
        p.outcome === 'removed'
          ? ['We reviewed your report and removed the content. The source photo is now blocked from being uploaded again.']
          : [
              "Based on the information provided, we couldn't identify content to remove.",
              "If you have a link or the video's file name (it contains an ID starting with gen_), reply to this email and we'll take another look.",
            ],
    }),
    zh: (p) => ({
      subject: `你的举报有了处理结果（${p.reportId}）`,
      heading: p.outcome === 'removed' ? '内容已删除' : '举报未通过',
      paragraphs:
        p.outcome === 'removed'
          ? ['我们核实了你的举报，已删除相关视频，并禁止同一张照片再次上传。']
          : [
              '根据目前提供的信息，我们没能定位到需要删除的内容。',
              '如果你有视频链接或下载文件名（文件名里有以 gen_ 开头的编号），请回复本邮件，我们会重新核查。',
            ],
    }),
  },

  content_removed: {
    en: (p) => ({
      subject: `A video in your ${brand} account was removed`,
      heading: 'Video removed',
      paragraphs: [
        `Following a report (${p.reportId}), we removed ${p.videos} video(s) made from the same photo and blocked that photo from future uploads.`,
        'Only upload photos of yourself or of people who agreed to it. If you think this was a mistake, reply to this email.',
      ],
    }),
    zh: (p) => ({
      subject: `你在 ${brand} 的视频已被删除`,
      heading: '视频已被删除',
      paragraphs: [
        `收到举报（${p.reportId}）后，我们删除了用同一张照片生成的 ${p.videos} 个视频，并禁止这张照片再次上传。`,
        '只能上传你本人或已取得对方同意的照片。如果你认为处理有误，请回复本邮件说明。',
      ],
    }),
  },
}

const ADMIN_RENDERERS: { [K in AdminTemplate]: Render<K> } = {
  admin_takedown: (p, ctx) => {
    const title = { new: '新举报', due_soon: '举报即将超时', overdue: '举报已超时' }[p.stage]
    return {
      subject: `[${brand}] ${title}：${p.reportId}`,
      heading: title,
      paragraphs: [
        `原因：${REASONS_ZH[p.reason] ?? p.reason}`,
        `视频：${p.generationId ?? '未能自动定位，需要人工查找'}`,
        `截止：${date({ ...ctx, locale: 'zh' }, p.dueAt, true)}`,
      ],
      cta: { label: '去处理', url: `${ctx.siteUrl}/admin/takedowns` },
    }
  },

  admin_contact: (p, ctx) => ({
    subject: `[${brand}] 新留言：${TOPICS_ZH[p.topic] ?? p.topic}`,
    heading: '新留言',
    paragraphs: [`来自：${p.email}（直接回复本邮件即可回复对方）`, p.message],
    cta: { label: '在后台查看', url: `${ctx.siteUrl}/admin/messages` },
    replyTo: p.email,
  }),

  admin_dispute: (p, ctx) => {
    const title = {
      opened: '收到支付争议（拒付）',
      won: '支付争议胜诉',
      lost: '支付争议败诉',
      closed: '支付争议已关闭',
      fraud_warning: '收到欺诈预警',
    }[p.stage]
    const summary = {
      opened: `订单 ${p.orderId} 被持卡人发起争议，已回收 ${p.credits} 积分（用户已花掉的部分扣不回）。请在支付商后台按期提交证据，逾期视为败诉。`,
      won: `订单 ${p.orderId} 的争议胜诉，资金留在商户，已补回 ${p.credits} 积分。`,
      lost: `订单 ${p.orderId} 的争议败诉，资金已退回持卡人，订单已记为全额退款（积分在争议开启时已回收）。`,
      closed: `订单 ${p.orderId} 的争议未成立就关闭了，资金留在商户，已补回 ${p.credits} 积分。`,
      fraud_warning: `订单 ${p.orderId} 收到发卡行的欺诈预警，尚未形成拒付。`,
    }[p.stage]
    return {
      subject: `[${brand}] ${title}：${p.orderId}`,
      heading: title,
      paragraphs: [summary, p.amount ? `争议金额：${p.amount}` : '', p.reason ? `原因：${p.reason}` : '', p.detail ? `说明：${p.detail}` : ''],
      cta: { label: '查看订单', url: `${ctx.siteUrl}/admin/orders/${encodeURIComponent(p.orderId)}` },
    }
  },

  admin_alert: (p, ctx) => {
    const alert = ALERTS_ZH[p.kind](p)
    return {
      subject: `[${brand}] 告警：${alert.title}`,
      heading: alert.title,
      paragraphs: [alert.summary, p.detail ? `详情：${p.detail}` : '', alert.hint],
      cta: { label: '去后台查看', url: `${ctx.siteUrl}${alert.path}` },
    }
  },
}

export const ADMIN_TEMPLATES = Object.keys(ADMIN_RENDERERS) as readonly EmailTemplate[]

export function isEmailTemplate(value: string): value is EmailTemplate {
  return Object.hasOwn(USER_TEMPLATES, value) || Object.hasOwn(ADMIN_RENDERERS, value)
}

function isAdminTemplate(template: EmailTemplate): template is AdminTemplate {
  return Object.hasOwn(ADMIN_RENDERERS, template)
}

export function renderEmail<K extends EmailTemplate>(template: K, params: TemplateParams[K], options: { siteUrl: string; locale: string | null }): RenderedEmail {
  const ctx: Ctx = { siteUrl: options.siteUrl.replace(/\/$/, ''), locale: isLocale(options.locale ?? undefined) ? (options.locale as Locale) : DEFAULT_LOCALE }
  const render = (isAdminTemplate(template) ? ADMIN_RENDERERS[template] : USER_TEMPLATES[template as UserTemplate][ctx.locale]) as Render<K>
  const block = render(params, ctx)
  const paragraphs = block.paragraphs.filter(Boolean)
  // Subject 只由固定文案和系统生成的 id 组成；仍去掉换行，防止邮件头注入
  const subject = block.subject.replace(/[\r\n]+/g, ' ').slice(0, 200)
  const text = [
    block.heading,
    '',
    ...paragraphs.flatMap((p) => [p, '']),
    ...(block.cta ? [`${block.cta.label}: ${block.cta.url}`, ''] : []),
    ...(block.footer ? [block.footer, ''] : []),
    `— ${brand} · ${site.supportEmail}`,
  ].join('\n')
  return { subject, text, html: layout(block, paragraphs), replyTo: block.replyTo ?? site.supportEmail }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
}

function layout(block: Block, paragraphs: string[]) {
  const p = (value: string) =>
    `<p style="margin:0 0 14px;font-size:15px;line-height:24px;color:#27272a;white-space:pre-wrap">${escapeHtml(value)}</p>`
  const cta = block.cta
    ? `<p style="margin:22px 0 4px"><a href="${escapeHtml(block.cta.url)}" style="display:inline-block;background:#18181b;color:#ffffff;padding:12px 20px;border-radius:8px;font-size:15px;font-weight:600;text-decoration:none">${escapeHtml(block.cta.label)}</a></p>`
    : ''
  const footer = block.footer ? `<p style="margin:0 0 8px">${escapeHtml(block.footer)}</p>` : ''
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif">
<div style="max-width:520px;margin:0 auto;padding:32px 20px">
<div style="font-size:17px;font-weight:700;color:#18181b;margin-bottom:20px">${escapeHtml(brand)}</div>
<div style="background:#ffffff;border-radius:12px;padding:28px 26px">
<h1 style="margin:0 0 16px;font-size:21px;line-height:28px;color:#18181b">${escapeHtml(block.heading)}</h1>
${paragraphs.map(p).join('\n')}${cta}
</div>
<div style="padding:18px 6px 0;font-size:12px;line-height:18px;color:#71717a">${footer}<p style="margin:0">${escapeHtml(brand)} · <a href="mailto:${escapeHtml(site.supportEmail)}" style="color:#71717a">${escapeHtml(site.supportEmail)}</a></p></div>
</div></body></html>`
}
