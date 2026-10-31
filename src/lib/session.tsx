import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, errorCode, type ClientConfig, type PublicUser } from './api'
import { CONSENT_REQUIRED } from './consent'
import { captureAttribution, track } from './attribution'
import { clearDraft } from './photo-draft'

type SessionState = {
  user: PublicUser | null
  config: ClientConfig | null
  loading: boolean
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}

const SessionContext = createContext<SessionState | null>(null)

// 会话只在浏览器端加载（/api/me），SSR 输出未登录态，保证页面可缓存、SEO 稳定
export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null)
  const [config, setConfig] = useState<ClientConfig | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ user: PublicUser | null; config: ClientConfig }>('/api/me')
      setUser(data.user)
      setConfig(data.config)
    } catch (error) {
      console.error('session load failed', error)
    } finally {
      setLoading(false)
    }
  }, [])

  const signOut = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST', json: {} })
    setUser(null)
    // 共用电脑：退出登录时一并清掉还没用的照片草稿
    await clearDraft()
  }, [])

  useEffect(() => {
    captureAttribution(CONSENT_REQUIRED)
    void refresh()
  }, [refresh])

  // 新账号（创建 10 分钟内）首次出现时上报 GA4 sign_up；OAuth 跳转和 dev 登录都会走到这里
  useEffect(() => {
    if (!user || Date.now() - Date.parse(user.createdAt) > 10 * 60_000) return
    try {
      if (localStorage.getItem(`signup:${user.id}`)) return
      localStorage.setItem(`signup:${user.id}`, '1')
    } catch {
      return
    }
    track('sign_up', { method: config?.googleClientId ? 'google' : 'dev' })
  }, [user, config])

  const value = useMemo(() => ({ user, config, loading, refresh, signOut }), [user, config, loading, refresh, signOut])
  return (
    <SessionContext.Provider value={value}>
      {children}
      {!loading && !user && config?.googleClientId ? <GoogleOneTap clientId={config.googleClientId} onSignedIn={refresh} /> : null}
    </SessionContext.Provider>
  )
}

export function useSession() {
  const value = useContext(SessionContext)
  if (!value) throw new Error('useSession must be used inside SessionProvider')
  return value
}

// Google 登录入口：配置了 Google 直接跳 OAuth，否则去登录页（本地 dev 登录）
export function signInHref(config: ClientConfig | null, redirect: string, signInPath: string) {
  if (config?.googleClientId) return `/api/auth/google/start?redirect=${encodeURIComponent(redirect)}`
  return `${signInPath}?redirect=${encodeURIComponent(redirect)}`
}

type GoogleId = {
  accounts: {
    id: {
      initialize: (options: Record<string, unknown>) => void
      prompt: () => void
      cancel: () => void
    }
  }
}

function GoogleOneTap({ clientId, onSignedIn }: { clientId: string; onSignedIn: () => Promise<void> }) {
  useEffect(() => {
    if (location.pathname.startsWith('/admin') || location.pathname.includes('sign-in')) return
    let cancelled = false
    let nonce: Promise<string | null> | null = null
    const start = async () => {
      const google = (window as unknown as { google?: GoogleId }).google
      if (cancelled || !google) return
      // 服务端签发的 nonce 同时存在 cookie 里，提交 credential 时核对，防止截获的 id_token 被重放
      const value = await nonce
      if (cancelled || !value) return
      google.accounts.id.initialize({
        client_id: clientId,
        nonce: value,
        auto_select: false,
        cancel_on_tap_outside: true,
        itp_support: true,
        use_fedcm_for_prompt: true,
        callback: async ({ credential }: { credential: string }) => {
          try {
            await api('/api/auth/google/one-tap', { json: { credential } })
            await onSignedIn()
          } catch (error) {
            const code = errorCode(error)
            // 账号问题要让用户看到原因（例如这个邮箱已绑定另一个 Google 账号），其余失败只记日志
            if (code.startsWith('account_')) location.href = `/sign-in?error=${encodeURIComponent(code)}`
            else console.error('one tap failed', error)
          }
        },
      })
      google.accounts.id.prompt()
    }
    nonce = api<{ nonce: string }>('/api/auth/google/nonce')
      .then((data) => data.nonce)
      .catch((error) => {
        console.error('one tap nonce failed', error)
        return null
      })
    const existing = document.querySelector<HTMLScriptElement>('script[data-gsi]')
    if (existing) {
      void start()
    } else {
      const script = document.createElement('script')
      script.src = 'https://accounts.google.com/gsi/client'
      script.async = true
      script.dataset.gsi = '1'
      script.onload = () => void start()
      document.head.appendChild(script)
    }
    return () => {
      cancelled = true
      ;(window as unknown as { google?: GoogleId }).google?.accounts.id.cancel()
    }
  }, [clientId, onSignedIn])
  return null
}
