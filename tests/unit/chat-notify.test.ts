import { describe, expect, it, vi } from 'vitest'
import { chatRequest, postChatMessage } from '#/server/chat-notify'
import { paidChatText } from '#/server/notifications'
import type { OrderRow } from '#/server/types'

const TEXT = '新付款 $9.90'

describe('chatRequest', () => {
  it('Telegram：chat_id 从查询串移到请求体，地址里不再带', () => {
    const request = chatRequest('https://api.telegram.org/bot123:abc/sendMessage?chat_id=-100200', TEXT)
    expect(request).toMatchObject({ kind: 'telegram', url: 'https://api.telegram.org/bot123:abc/sendMessage' })
    expect(request?.body).toMatchObject({ chat_id: '-100200', text: TEXT })
  })

  it('飞书、Lark、Discord 按各自格式；Discord 不解析 @everyone', () => {
    expect(chatRequest('https://open.feishu.cn/open-apis/bot/v2/hook/x', TEXT)?.body).toEqual({ msg_type: 'text', content: { text: TEXT } })
    expect(chatRequest('https://open.larksuite.com/open-apis/bot/v2/hook/x', TEXT)?.kind).toBe('feishu')
    expect(chatRequest('https://discord.com/api/webhooks/1/abc', TEXT)?.body).toEqual({ content: TEXT, allowed_mentions: { parse: [] } })
  })

  it('其他 https 地址发 {text}；Discord 域名下不是 webhook 路径的也按通用格式', () => {
    expect(chatRequest('https://hooks.slack.com/services/T/B/x', TEXT)).toMatchObject({ kind: 'generic', body: { text: TEXT } })
    expect(chatRequest('https://discord.com/other', TEXT)?.kind).toBe('generic')
  })

  it('非 https、无法解析、Telegram 缺 chat_id 都拒绝', () => {
    expect(chatRequest('http://hooks.slack.com/services/x', TEXT)).toBeNull()
    expect(chatRequest('not a url', TEXT)).toBeNull()
    expect(chatRequest('https://api.telegram.org/bot123:abc/sendMessage', TEXT)).toBeNull()
  })
})

describe('postChatMessage', () => {
  const secretUrl = 'https://api.telegram.org/botSECRET-TOKEN/sendMessage?chat_id=1'

  it('网络错误和非 2xx 的报错里不带地址（地址含 token）', async () => {
    const offline = vi.fn(() => Promise.reject(new TypeError(`fetch failed: ${secretUrl}`)))
    await expect(postChatMessage(secretUrl, TEXT, offline as unknown as typeof fetch)).rejects.toThrow(/^chat webhook \(telegram\) request failed: TypeError$/)
    const denied = vi.fn(() => Promise.resolve(new Response('{"ok":false}', { status: 403 })))
    const error = await postChatMessage(secretUrl, TEXT, denied as unknown as typeof fetch).catch((e: Error) => e)
    expect(String(error)).not.toContain('SECRET-TOKEN')
    expect(String(error)).toContain('HTTP 403')
  })

  it('飞书返回 200 但 code 非 0（关键词、签名不通过）也算失败', async () => {
    const fetcher = vi.fn(() => Promise.resolve(Response.json({ code: 19024, msg: 'Key Words Not Found' })))
    await expect(postChatMessage('https://open.feishu.cn/open-apis/bot/v2/hook/x', TEXT, fetcher as unknown as typeof fetch)).rejects.toThrow('code 19024')
    const ok = vi.fn(() => Promise.resolve(Response.json({ code: 0 })))
    await expect(postChatMessage('https://open.feishu.cn/open-apis/bot/v2/hook/x', TEXT, ok as unknown as typeof fetch)).resolves.toBeUndefined()
  })
})

describe('paidChatText', () => {
  it('按实收金额显示，带“新付款”关键词、订阅标记、来源和订单号', () => {
    const order = {
      id: 'ord_1',
      package_id: 'pro_monthly',
      credits: 500,
      amount_cents: 1990,
      currency: 'USD',
      paid_amount_cents: 1790,
      paid_currency: 'USD',
      subscription_id: 'sub_1',
      source: null,
      country: 'DE',
    } as OrderRow
    const text = paidChatText(order)
    expect(text).toContain('新付款 $17.90')
    expect(text).toContain('订阅 pro_monthly · 500 积分')
    expect(text).toContain('来源 direct · DE')
    expect(text).toContain('订单 ord_1')
  })

  it('清理恶意 source / country 中的换行与注入符号，不让通知伪造多行或 @ 提及', () => {
    const order = {
      id: 'ord_2',
      package_id: 'starter',
      credits: 20,
      amount_cents: 990,
      currency: 'USD',
      paid_amount_cents: 990,
      paid_currency: 'USD',
      subscription_id: null,
      source: 'bad\n新付款 $9999 @everyone [url]',
      country: 'U<S>\n',
    } as OrderRow
    const text = paidChatText(order)
    expect(text.split('\n')).toHaveLength(4)
    expect(text).not.toContain('@')
    expect(text).not.toContain('<')
  })
})
