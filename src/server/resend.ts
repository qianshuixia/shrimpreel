import type { Mailer } from './email'

// Resend 发信渠道（可选）：配了 RESEND_API_KEY 且 EMAIL_FROM 非空时，所有交易邮件走它而不是 send_email binding。
// 抛出的错误带 code，沿用 email.ts 的 RETRYABLE_CODES 语义：限流、配额、5xx、网络错误可重试，其余 4xx 不重试。
// https://resend.com/docs/api-reference/emails/send-email
// https://resend.com/docs/api-reference/errors

export const RESEND_ENDPOINT = 'https://api.resend.com/emails'

function sendError(code: string, message: string, apiKey: string) {
  // 错误信息里绝不能带 API key（上游报错可能原样回显请求内容）
  return Object.assign(new Error(message.split(apiKey).join('***').slice(0, 300)), { code })
}

export function createResendMailer(apiKey: string): Mailer {
  return {
    async send({ from, to, subject, text, html, replyTo }) {
      let response: Response
      try {
        response = await fetch(RESEND_ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: `${from.name} <${from.email}>`, to: [to], subject, text, html, reply_to: replyTo }),
          signal: AbortSignal.timeout(15_000),
        })
      } catch (error) {
        throw sendError('E_INTERNAL_SERVER_ERROR', `resend network error: ${error instanceof Error ? error.message : String(error)}`, apiKey)
      }
      const body = (await response.json().catch(() => null)) as { id?: unknown; name?: unknown; message?: unknown } | null
      if (response.ok) {
        if (typeof body?.id !== 'string' || !body.id) throw sendError('E_INTERNAL_SERVER_ERROR', 'resend: 响应里没有邮件 id', apiKey)
        return { messageId: body.id }
      }
      const name = typeof body?.name === 'string' ? body.name : ''
      const detail = `${name || `http_${response.status}`}: ${typeof body?.message === 'string' ? body.message : `HTTP ${response.status}`}`
      if (response.status === 429) {
        const daily = name === 'daily_quota_exceeded' || name === 'monthly_quota_exceeded'
        throw sendError(daily ? 'E_DAILY_LIMIT_EXCEEDED' : 'E_RATE_LIMIT_EXCEEDED', detail, apiKey)
      }
      if (response.status >= 500) throw sendError('E_INTERNAL_SERVER_ERROR', detail, apiKey)
      // 域名未验证、key 无效、参数错误等：重试也没用
      const suffix = /^[a-z_]+$/.test(name) ? name.toUpperCase() : String(response.status)
      throw sendError(`E_RESEND_${suffix}`, detail, apiKey)
    },
  }
}
