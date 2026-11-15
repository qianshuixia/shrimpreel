// 来源归因：客户端把 first/last touch 写进 vt_attr cookie（见 src/lib/attribution.ts），
// 服务端在注册、下单、访问上报时读取并归类成 source / medium，写入 D1 供后台漏斗和来源报表使用。
import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { isTransitHost } from '../lib/referrer'
import { base64Decode } from './util'

export const ATTRIBUTION_COOKIE = 'vt_attr'

const TOUCH_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'msclkid',
  'ttclid',
  'fbclid',
  'ref',
  'referrer',
  'landing',
  'at',
] as const

export type Touch = Partial<Record<(typeof TOUCH_KEYS)[number], string>>
export interface Attribution {
  first?: Touch
  last?: Touch
}
export interface SourceInfo {
  source: string
  medium: string
  campaign: string | null
}

export function sanitizeTouch(value: unknown): Touch | undefined {
  if (!value || typeof value !== 'object') return undefined
  const touch: Touch = {}
  for (const key of TOUCH_KEYS) {
    const raw = (value as Record<string, unknown>)[key]
    if (typeof raw === 'string' && raw.trim()) touch[key] = raw.trim().slice(0, 300)
  }
  return Object.keys(touch).length ? touch : undefined
}

export function parseAttribution(cookie: string | undefined): Attribution | null {
  if (!cookie || cookie.length > 4096) return null
  try {
    const b64 = cookie.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(cookie.length / 4) * 4, '=')
    const json = JSON.parse(new TextDecoder().decode(base64Decode(b64))) as Record<string, unknown>
    const first = sanitizeTouch(json.first)
    const last = sanitizeTouch(json.last)
    return first || last ? { first, last } : null
  } catch {
    return null
  }
}

const SEARCH_ENGINES: Array<[RegExp, string]> = [
  [/(^|\.)google\./, 'google'],
  [/(^|\.)bing\.com$/, 'bing'],
  [/(^|\.)duckduckgo\.com$/, 'duckduckgo'],
  [/(^|\.)yahoo\./, 'yahoo'],
  [/(^|\.)yandex\./, 'yandex'],
  [/(^|\.)baidu\.com$/, 'baidu'],
  [/(^|\.)naver\.com$/, 'naver'],
  [/(^|\.)ecosia\.org$/, 'ecosia'],
  [/(^|\.)brave\.com$/, 'brave'],
]

// AI 助手要排在搜索引擎前面（gemini.google.com 不应算 google organic）
const AI_ASSISTANTS: Array<[RegExp, string]> = [
  [/(^|\.)(chatgpt\.com|chat\.openai\.com)$/, 'chatgpt'],
  [/(^|\.)perplexity\.ai$/, 'perplexity'],
  [/(^|\.)claude\.ai$/, 'claude'],
  [/^gemini\.google\.com$/, 'gemini'],
  [/(^|\.)copilot\.microsoft\.com$/, 'copilot'],
  [/(^|\.)deepseek\.com$/, 'deepseek'],
  [/(^|\.)you\.com$/, 'you'],
]

const SOCIAL: Array<[RegExp, string]> = [
  [/(^|\.)(facebook\.com|fb\.com|m\.facebook\.com)$/, 'facebook'],
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)(t\.co|twitter\.com|x\.com)$/, 'x'],
  [/(^|\.)tiktok\.com$/, 'tiktok'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube'],
  [/(^|\.)reddit\.com$/, 'reddit'],
  [/(^|\.)pinterest\./, 'pinterest'],
  [/(^|\.)linkedin\.com$/, 'linkedin'],
  [/(^|\.)discord(app)?\.com$/, 'discord'],
  [/(^|\.)t\.me$/, 'telegram'],
]

function hostOf(url: string | undefined) {
  if (!url) return null
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

function match(host: string, table: Array<[RegExp, string]>) {
  return table.find(([pattern]) => pattern.test(host))?.[1] ?? null
}

export function sanitizeAttributionLabel(value: string | undefined | null): string | null {
  if (!value) return null
  // 剥离控制字符、换行及 HTML/Markdown/群消息提及字符，防止通知与报表中伪造多行或提及注入
  const cleaned = value.replace(/[\u0000-\u001F\u007F<>[\]`@]/g, '').trim().slice(0, 100)
  return cleaned || null
}

const lower = (value: string | undefined) => sanitizeAttributionLabel(value)?.toLowerCase() ?? null

export function classifyTouch(touch: Touch | undefined, selfHost?: string | null): SourceInfo {
  if (!touch) return { source: 'direct', medium: 'none', campaign: null }
  const campaign = lower(touch.utm_campaign)
  if (touch.gclid) return { source: 'google', medium: 'cpc', campaign }
  if (touch.msclkid) return { source: 'bing', medium: 'cpc', campaign }
  if (touch.ttclid) return { source: 'tiktok', medium: 'cpc', campaign }
  const utmSource = lower(touch.utm_source) ?? lower(touch.ref)
  if (utmSource) return { source: utmSource, medium: lower(touch.utm_medium) ?? 'referral', campaign }
  if (touch.fbclid) return { source: 'facebook', medium: 'social', campaign }
  const host = hostOf(touch.referrer)
  if (!host || host === selfHost?.replace(/^www\./, '') || isTransitHost(host)) return { source: 'direct', medium: 'none', campaign }
  const ai = match(host, AI_ASSISTANTS)
  if (ai) return { source: ai, medium: 'ai', campaign }
  const engine = match(host, SEARCH_ENGINES)
  if (engine) return { source: engine, medium: 'organic', campaign }
  const social = match(host, SOCIAL)
  if (social) return { source: social, medium: 'social', campaign }
  return { source: sanitizeAttributionLabel(host) ?? 'direct', medium: 'referral', campaign }
}

export function deviceFromUserAgent(ua: string | undefined) {
  if (!ua) return 'unknown'
  if (/bot|crawl|spider|slurp|headless|lighthouse|preview/i.test(ua)) return 'bot'
  if (/ipad|tablet|kindle|silk|(android(?!.*mobile))/i.test(ua)) return 'tablet'
  if (/mobi|iphone|ipod|android|phone/i.test(ua)) return 'mobile'
  return 'desktop'
}

export interface RequestAttribution extends SourceInfo {
  country: string | null
  device: string
  json: string | null
}

// pick=first 用于注册（首次触达），pick=last 用于下单（最后一次非 direct 触达，没有则回落到首次触达）
export function requestAttribution(c: Context, pick: 'first' | 'last'): RequestAttribution {
  const attribution = parseAttribution(getCookie(c, ATTRIBUTION_COOKIE))
  const selfHost = new URL(c.req.url).hostname
  const first = classifyTouch(attribution?.first, selfHost)
  const last = classifyTouch(attribution?.last, selfHost)
  const info = pick === 'first' ? first : last.source === 'direct' && attribution?.first ? first : last
  const country = c.req.header('cf-ipcountry')
  return {
    ...info,
    country: country && country !== 'XX' && country !== 'T1' ? country : null,
    device: deviceFromUserAgent(c.req.header('user-agent')),
    json: attribution ? JSON.stringify(attribution) : null,
  }
}
