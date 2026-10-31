// 统计同意：site.analytics 填了 ga4Id 或 clarityId 时生效（同意横幅、页脚“Cookie 设置”、归因 Cookie 都看 CONSENT_REQUIRED）。
// GA4 用 Consent Mode v2 basic 模式：同意生效之前不加载 gtag.js，也就不会向 Google 发任何请求；广告相关的三项始终 denied（模板不投放广告再营销）。
// Microsoft Clarity 始终加载，未同意时按 consentv2 denied 以无 Cookie 模式录制（每次页面浏览一个 ID），同意后才写 _clck/_clsk。
// 选择存 localStorage，页脚“Cookie 设置”可以重新选择；撤回同意时删除已写入的 _ga Cookie，Clarity 自己删除它的 Cookie。
// 没选择过时按地区取默认值：EEA、英国、瑞士和查不到国家的访客默认 denied 并弹横幅，其他地区默认 granted、不弹横幅
// （src/server.ts 按 cf-ipcountry 算出后写在 <html data-consent-default> 上，内联脚本和组件都从这里读）。
import { site } from '#/config/site'

export const CONSENT_KEY = 'consent.analytics'
export const CONSENT_OPEN_EVENT = 'consent:open'
export type Consent = 'granted' | 'denied'
export const CONSENT_REQUIRED = Boolean(site.analytics.ga4Id || site.analytics.clarityId)

const GTAG_SRC = 'https://www.googletagmanager.com/gtag/js?id='

// 需要先征得同意的地区：欧盟 27 国 + 冰岛、列支敦士登、挪威（EEA）+ 英国 + 瑞士
const CONSENT_FIRST_COUNTRIES = new Set(
  'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO GB CH'.split(' '),
)

// 服务端：按 cf-ipcountry 取默认值。缺失、XX（未知）、T1（Tor）都按需要同意处理
export function regionalConsentDefault(country: string | null | undefined): Consent {
  const code = country?.trim().toUpperCase() ?? ''
  if (!/^[A-Z]{2}$/.test(code) || code === 'XX' || code === 'T1' || CONSENT_FIRST_COUNTRIES.has(code)) return 'denied'
  return 'granted'
}

// 内联脚本片段：c 为存储的选择，没有时取 <html data-consent-default>
const READ_CONSENT_JS =
  `var c=null;try{c=localStorage.getItem(${JSON.stringify(CONSENT_KEY)})}catch(e){}` +
  "if(c!=='granted'&&c!=='denied')c=document.documentElement.getAttribute('data-consent-default')==='granted'?'granted':'denied';"

// <head> 内联脚本：先设默认同意状态，再排队 config；已同意（含地区默认同意）的访客直接加载 gtag.js。
// Dodo 回跳成功页时会在 URL 上附带 ?email=<买家邮箱>；GA 禁止收集 PII，page_location 先去掉它
export function ga4BootstrapScript(ga4Id: string) {
  const id = JSON.stringify(ga4Id)
  return [
    'window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}',
    READ_CONSENT_JS,
    "gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:c});",
    "gtag('js',new Date());var u=new URL(location.href);u.searchParams.delete('email');",
    `gtag('config',${id},{page_location:u.href});`,
    `if(c==='granted'){var s=document.createElement('script');s.async=true;s.src=${JSON.stringify(GTAG_SRC)}+${id};document.head.appendChild(s)}`,
  ].join('')
}

// <head> 内联脚本：Clarity 官方加载片段，加载前先给出同意状态。
// 只在正式域名（含 www）上运行，本地开发、e2e 和 staging 不录制；/admin 不录制。
// 依据 https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-consent-api-v2
export function clarityBootstrapScript(clarityId: string, domain: string) {
  const d = JSON.stringify(domain)
  return [
    `(function(){var h=location.hostname;if(h!==${d}&&h!=='www.'+${d})return;if(location.pathname.indexOf('/admin')===0)return;`,
    'window.clarity=window.clarity||function(){(window.clarity.q=window.clarity.q||[]).push(arguments)};',
    READ_CONSENT_JS,
    "window.clarity('consentv2',{ad_Storage:'denied',analytics_Storage:c});",
    `var t=document.createElement('script');t.async=true;t.src='https://www.clarity.ms/tag/'+${JSON.stringify(encodeURIComponent(clarityId))};document.head.appendChild(t)})()`,
  ].join('')
}

export function readConsent(): Consent | null {
  try {
    const value = localStorage.getItem(CONSENT_KEY)
    return value === 'granted' || value === 'denied' ? value : null
  } catch {
    return null
  }
}

// 客户端：本页的地区默认值（服务端渲染时为 denied）
export function consentDefault(): Consent {
  if (typeof document === 'undefined') return 'denied'
  return document.documentElement.getAttribute('data-consent-default') === 'granted' ? 'granted' : 'denied'
}

// 实际生效的同意状态：存储的选择优先，没有时用地区默认值
export function effectiveConsent(): Consent {
  return readConsent() ?? consentDefault()
}

type Gtag = (command: 'consent', action: 'update', params: Record<string, string>) => void
type Clarity = (command: 'consentv2', params: { ad_Storage: Consent; analytics_Storage: Consent }) => void

export function saveConsent(ga4Id: string, value: Consent) {
  try {
    localStorage.setItem(CONSENT_KEY, value)
  } catch {
    // 禁用存储时本次页面内仍然生效，下次访问再问
  }
  const gtag = (window as unknown as { gtag?: Gtag }).gtag
  gtag?.('consent', 'update', { analytics_storage: value })
  // 拒绝时 Clarity 删除已有 Cookie，转为无 Cookie 模式
  const clarity = (window as unknown as { clarity?: Clarity }).clarity
  clarity?.('consentv2', { ad_Storage: 'denied', analytics_Storage: value })
  if (value === 'granted') {
    if (ga4Id && !document.querySelector(`script[src^="${GTAG_SRC}"]`)) {
      const script = document.createElement('script')
      script.async = true
      script.src = GTAG_SRC + encodeURIComponent(ga4Id)
      document.head.appendChild(script)
    }
  } else {
    deleteGaCookies()
  }
}

// GA 默认把 Cookie 写在可写的最高一级域名上（cookie_domain: 'auto'），逐级尝试删除
function deleteGaCookies() {
  const names = document.cookie
    .split(';')
    .map((part) => part.split('=')[0]!.trim())
    .filter((name) => name === '_ga' || name.startsWith('_ga_') || name === '_gid')
  const labels = location.hostname.split('.')
  const domains = [''].concat(labels.slice(0, -1).map((_, i) => `; Domain=.${labels.slice(i).join('.')}`))
  for (const name of names) {
    for (const domain of domains) document.cookie = `${name}=; Max-Age=0; Path=/${domain}`
  }
}
