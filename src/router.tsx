import { createRouter } from '@tanstack/react-router'
import { getGlobalStartContext } from '@tanstack/react-start'
import { loadContent, localeFromPathname } from './lib/i18n'
import { routeTree } from './routeTree.gen'
import type { Consent } from './lib/consent'
import type { ShareView } from './server/shares'

// 浏览器首屏：尽早开始下载当前语言的文案，和路由 chunk 并行（见 lib/i18n.ts）
const initialContent = typeof window === 'undefined' ? null : loadContent(localeFromPathname(window.location.pathname))

export function getRouter() {
  // CSP nonce：服务端取 src/server.ts 传入的请求上下文；客户端由框架从 <meta property="csp-nonce"> 读回。
  // 断言类型：没有全局中间件时，Start 1.169 把声明了 requestContext 的 getGlobalStartContext() 推成 never
  const context = getGlobalStartContext() as { nonce?: string } | undefined
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    ssr: { nonce: context?.nonce },
    // 水合不会重跑 beforeLoad，文案要在这里等到位，否则首屏渲染时 useContent 取不到
    hydrate: async () => {
      await initialContent
    },
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
    // share：分享页 /v/<id> 的数据，src/server.ts 渲染前查好（见 routes/{-$locale}/v.$shareId.tsx）
    // consentDefault：按访客国家算出的统计 Cookie 默认值，写在 <html data-consent-default> 上（见 lib/consent.ts）
    server: { requestContext: { nonce: string; share?: ShareView; consentDefault?: Consent } }
  }
}
