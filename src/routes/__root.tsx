/// <reference types="vite/client" />
import { HeadContent, Outlet, Scripts, createRootRoute, useRouterState, type ErrorComponentProps } from '@tanstack/react-router'
import { useEffect, useState, type ReactNode } from 'react'
import { ConsentBanner } from '#/components/ConsentBanner'
import { Footer } from '#/components/Footer'
import { Nav } from '#/components/Nav'
import { LocalLink } from '#/components/ui'
import { site } from '#/config/site'
import { CONSENT_REQUIRED, clarityBootstrapScript, ga4BootstrapScript } from '#/lib/consent'
import { installErrorReporting, reportClientError } from '#/lib/error-report'
import { htmlLang, loadContent, localeFromPathname, useContent } from '#/lib/i18n'
import { SessionProvider } from '#/lib/session'
import { THEME_COLOR } from '#/lib/theme'
import css from '../styles.css?url'

// 首屏前设置主题，避免闪烁
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('theme');if(!t)t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t}catch(e){}})()`

// head 里的脚本由框架带上 CSP nonce（见 src/server/csp.ts），自定义内联脚本都放这里，不要直接写 <script>
function headScripts() {
  const scripts: Array<Record<string, unknown>> = [{ children: THEME_SCRIPT }]
  const { ga4Id, cfBeaconToken, umamiWebsiteId, clarityId } = site.analytics
  // GA4 要等访客在同意横幅点“接受”后才加载（见 lib/consent.ts）
  if (ga4Id) scripts.push({ children: ga4BootstrapScript(ga4Id) })
  if (cfBeaconToken) {
    scripts.push({
      src: 'https://static.cloudflareinsights.com/beacon.min.js',
      defer: true,
      'data-cf-beacon': JSON.stringify({ token: cfBeaconToken }),
    })
  }
  // Umami 经本站 /s/ 代理（见 server/umami.ts），无 Cookie，不等同意
  if (umamiWebsiteId) scripts.push({ src: '/s/script.js', defer: true, 'data-website-id': umamiWebsiteId })
  // Clarity 录屏：未同意时无 Cookie 模式，只在正式域名上加载
  if (clarityId) scripts.push({ children: clarityBootstrapScript(clarityId, site.domain) })
  return scripts
}

export const Route = createRootRoute({
  // 当前语言的文案（按语言拆包，见 lib/i18n.ts）；已加载时立即返回
  beforeLoad: async ({ location }) => {
    await loadContent(localeFromPathname(location.pathname))
  },
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: site.brandName },
      { name: 'theme-color', content: THEME_COLOR[site.theme] },
      { property: 'og:site_name', content: site.brandName },
      { property: 'og:type', content: 'website' },
      { property: 'og:image', content: `https://${site.domain}${site.ogImage}` },
      { property: 'og:image:width', content: String(site.seo.ogImageSize.width) },
      { property: 'og:image:height', content: String(site.seo.ogImageSize.height) },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:image', content: `https://${site.domain}${site.ogImage}` },
      ...(site.seo.googleVerification ? [{ name: 'google-site-verification', content: site.seo.googleVerification }] : []),
      ...(site.seo.bingVerification ? [{ name: 'msvalidate.01', content: site.seo.bingVerification }] : []),
    ],
    links: [
      { rel: 'stylesheet', href: css },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
    ],
    scripts: headScripts(),
  }),
  shellComponent: RootDocument,
  component: Outlet,
  notFoundComponent: NotFoundPage,
  errorComponent: ErrorPage,
})

function RootDocument({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  useEffect(installErrorReporting, [])
  return (
    <html lang={htmlLang(localeFromPathname(pathname))} data-skin={site.theme} suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <SessionProvider>{children}</SessionProvider>
        {CONSENT_REQUIRED ? <ConsentBanner ga4Id={site.analytics.ga4Id} /> : null}
        <Scripts />
      </body>
    </html>
  )
}

function SiteFrame({ children }: { children: ReactNode }) {
  return (
    <>
      <Nav />
      <main className="min-h-[60vh]">{children}</main>
      <Footer />
    </>
  )
}

function NotFoundPage() {
  const c = useContent()
  return (
    <SiteFrame>
      <div className="container-page max-w-xl py-28 text-center">
        <p className="eyebrow text-muted">404</p>
        <h1 className="mt-3 font-display text-5xl">{c.common.notFoundTitle}</h1>
        <p className="mt-4 text-muted">{c.common.notFoundBody}</p>
        <LocalLink to="/" className="btn-primary mt-8">
          {c.common.home}
        </LocalLink>
      </div>
    </SiteFrame>
  )
}

// 错误详情只写日志（SSR 进 Worker 日志，浏览器里的上报到 /api/client-error 再进 Worker 日志），页面上只展示错误编号，避免泄露内部信息
function ErrorPage({ error, reset }: ErrorComponentProps) {
  const c = useContent()
  const [errorId, setErrorId] = useState<string | null>(null)
  if (import.meta.env.SSR) console.error(error)
  useEffect(() => {
    console.error(error)
    setErrorId(reportClientError(error, 'boundary'))
  }, [error])
  return (
    <SiteFrame>
      <div className="container-page max-w-xl py-28 text-center">
        <h1 className="font-display text-4xl">{c.common.errorTitle}</h1>
        <p className="mt-4 text-muted">{c.common.errorBody}</p>
        {errorId ? (
          <p className="mt-2 text-xs text-muted" data-testid="error-id">
            {c.common.errorRef(errorId)}
          </p>
        ) : null}
        <div className="mt-8 flex justify-center gap-3">
          <button type="button" className="btn-primary" onClick={reset}>
            {c.common.retry}
          </button>
          <LocalLink to="/" className="btn-ghost">
            {c.common.home}
          </LocalLink>
        </div>
      </div>
    </SiteFrame>
  )
}
