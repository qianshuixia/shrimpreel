// 内容安全策略：先以 Content-Security-Policy-Report-Only 下发，违规报告写进 Worker 日志（[csp]）。
// 线上观察一段时间没有误报后，把 server.ts 里的响应头名改成 Content-Security-Policy 即可强制执行。
// 页面内联脚本（主题、GA4 引导、TanStack 水合数据）都带每次请求生成的 nonce（router 的 ssr.nonce），不放开 'unsafe-inline'。
// 第三方来源按官方文档放行，接入新服务时在这里补：
//   GA4（不含广告功能）https://developers.google.com/tag-platform/security/guides/csp
//   Google 登录与 One Tap https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid
//   Turnstile https://developers.cloudflare.com/turnstile/reference/content-security-policy/
//   Microsoft Clarity https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-csp
//   Cloudflare Web Analytics：脚本在 static.cloudflareinsights.com，数据发到 cloudflareinsights.com
// 支付收银台是整页跳转，不受 CSP 限制。

export const CSP_REPORT_PATH = '/api/csp-report'

export function createNonce() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
}

export function contentSecurityPolicy(nonce: string) {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      'https://www.googletagmanager.com',
      'https://static.cloudflareinsights.com',
      'https://challenges.cloudflare.com',
      'https://accounts.google.com/gsi/client',
      'https://*.clarity.ms',
    ],
    // React 的 style 属性属于内联样式，只能放开 'unsafe-inline'（style-src 里有 nonce 时它会被忽略，所以这里不加 nonce）
    'style-src': ["'self'", "'unsafe-inline'", 'https://accounts.google.com/gsi/style'],
    // blob:：生成器里上传前的照片预览
    'img-src': ["'self'", 'data:', 'blob:', 'https://www.googletagmanager.com', 'https://*.google-analytics.com', 'https://*.clarity.ms', 'https://c.bing.com'],
    'connect-src': [
      "'self'",
      'https://www.googletagmanager.com',
      'https://*.google-analytics.com',
      // GA4 官方清单就是 *.google.com（会发到 region1.analytics.google.com 等）
      'https://*.google.com',
      'https://cloudflareinsights.com',
      'https://accounts.google.com/gsi/',
      'https://*.clarity.ms',
      'https://c.bing.com',
    ],
    'frame-src': ['https://challenges.cloudflare.com', 'https://accounts.google.com/gsi/'],
    'frame-ancestors': ["'self'"],
    'form-action': ["'self'"],
    'base-uri': ["'self'"],
    'object-src': ["'none'"],
    'report-uri': [CSP_REPORT_PATH],
  }
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ')
}

// 只开放当前用不到的高敏感能力；Google 登录的 FedCM（identity-credentials-get）保持默认
export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'

// 浏览器的 CSP 报告有两种格式：report-uri 的 {"csp-report": {...}}，Reporting API 的 [{type, body}]。
// 日志只留定位问题需要的字段；URL 去掉 query 和 hash（支付回跳地址带买家邮箱）
export function summarizeCspReports(raw: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const items = Array.isArray(parsed) ? parsed.map((r) => (r as { body?: unknown })?.body) : [(parsed as { 'csp-report'?: unknown })?.['csp-report']]
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const r = item as Record<string, unknown>
    const pick = (...keys: string[]) => keys.map((k) => r[k]).find((v) => typeof v === 'string' || typeof v === 'number')
    const directive = pick('effective-directive', 'effectiveDirective', 'violated-directive')
    if (directive === undefined) return []
    const blocked = stripUrl(pick('blocked-uri', 'blockedURL'))
    const page = stripUrl(pick('document-uri', 'documentURL'))
    const source = stripUrl(pick('source-file', 'sourceFile'))
    const line = pick('line-number', 'lineNumber')
    return [`${directive} blocked=${blocked || '-'} page=${page || '-'}${source ? ` source=${source}${line ? `:${line}` : ''}` : ''}`]
  })
}

export function stripUrl(value: string | number | undefined) {
  if (value === undefined) return ''
  const text = String(value).slice(0, 300)
  // inline、eval、data 等关键字原样保留
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text
  try {
    const url = new URL(text)
    return `${url.origin}${url.pathname}`
  } catch {
    return text.split(/[?#]/)[0]!
  }
}
