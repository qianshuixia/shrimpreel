import { useNavigate, useRouterState } from '@tanstack/react-router'
import { ChevronDown, Languages, LogOut, Menu, Moon, Sun, X } from 'lucide-react'
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { LOCALE_META, LOCALES } from '#/config/site'
import { htmlLang, switchLocalePath, useContent, useLocale, useLocalePath } from '#/lib/i18n'
import { useSession } from '#/lib/session'
import { LocalLink, Logo } from './ui'

export function Nav() {
  const c = useContent()
  const lp = useLocalePath()
  const [open, setOpen] = useState(false)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  useEffect(() => setOpen(false), [pathname])

  const links = [
    { href: `${lp('/')}#features`, label: c.nav.features },
    { href: `${lp('/')}#examples`, label: c.nav.examples },
    { href: lp('/guides'), label: c.guides.nav },
    { href: lp('/pricing'), label: c.nav.pricing },
  ]

  return (
    <header className="site-header sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur">
      <nav className="container-page flex h-16 items-center justify-between gap-4">
        <Logo />
        <div className="hidden items-center gap-10 md:flex">
          {links.map((link) => (
            <a key={link.href} href={link.href} className="eyebrow text-fg/80 hover:text-fg">
              {link.label}
            </a>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <LanguageSwitcher />
          <ThemeToggle />
          <div className="hidden md:block">
            <AccountButton />
          </div>
          <button
            type="button"
            className="grid size-9 place-items-center rounded-full hover:bg-bg-soft md:hidden"
            aria-label={c.nav.menu}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </nav>
      {open ? (
        <div className="border-t border-line bg-bg md:hidden">
          <div className="container-page flex flex-col gap-4 py-5">
            {links.map((link) => (
              <a key={link.href} href={link.href} className="eyebrow" onClick={() => setOpen(false)}>
                {link.label}
              </a>
            ))}
            <AccountButton />
          </div>
        </div>
      ) : null}
    </header>
  )
}

function AccountButton() {
  const c = useContent()
  const lp = useLocalePath()
  const { user, loading, signOut } = useSession()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  if (loading) return <span className="inline-block h-9 w-20" aria-hidden />
  if (!user) {
    return (
      <LocalLink to="/sign-in" className="eyebrow px-2 py-2 hover:text-accent-text" data-testid="nav-sign-in">
        {c.nav.signIn}
      </LocalLink>
    )
  }
  const initial = (user.name ?? user.email).slice(0, 1).toUpperCase()
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full border border-line bg-card py-1 pr-3 pl-1 text-sm"
        aria-expanded={open}
        data-testid="account-menu"
      >
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="size-7 rounded-full" referrerPolicy="no-referrer" />
        ) : (
          <span className="grid size-7 place-items-center rounded-full bg-ink text-xs font-semibold text-ink-fg">{initial}</span>
        )}
        <span className="font-medium" data-testid="nav-credits">
          {c.nav.credits(user.credits)}
        </span>
        <ChevronDown className="size-4 text-muted" />
      </button>
      {open ? (
        <div className="card absolute right-0 z-50 mt-2 w-56 overflow-hidden p-1.5 shadow-lg">
          <p className="truncate px-3 py-2 text-xs text-muted">{user.email}</p>
          {[
            { to: '/dashboard', label: c.nav.dashboard },
            { to: '/dashboard/billing', label: c.nav.billing },
            { to: '/dashboard/settings', label: c.nav.settings },
          ].map((item) => (
            <LocalLink key={item.to} to={item.to} className="block rounded-lg px-3 py-2 text-sm hover:bg-bg-soft" onClick={() => setOpen(false)}>
              {item.label}
            </LocalLink>
          ))}
          {user.role === 'admin' ? (
            <a href="/admin" className="block rounded-lg px-3 py-2 text-sm hover:bg-bg-soft">
              {c.nav.admin}
            </a>
          ) : null}
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-bg-soft"
            onClick={async () => {
              setOpen(false)
              await signOut()
              await navigate({ href: lp('/') })
            }}
          >
            <LogOut className="size-4" /> {c.nav.signOut}
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function ThemeToggle() {
  const c = useContent()
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null)
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
  }, [])
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    localStorage.setItem('theme', next)
    setTheme(next)
  }
  return (
    <button type="button" onClick={toggle} aria-label={c.nav.toggleTheme} className="grid size-9 place-items-center rounded-full hover:bg-bg-soft">
      {theme === 'dark' ? <Moon className="size-4.5" /> : <Sun className="size-4.5" />}
    </button>
  )
}

// 各语言版本的同一页面：普通 <a href hreflang>（整页跳转，爬虫可跟随），hreflang 与 head 里的 alternate 一致。
// hash 只在浏览器里有，点击时再拼上，避免 SSR 与水合的 href 不一致
export function useLocaleLinks() {
  const current = useLocale()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const search = useRouterState({ select: (s) => s.location.searchStr })
  return LOCALES.map((locale) => ({
    locale,
    current: locale === current,
    href: switchLocalePath(pathname, locale) + (search ?? ''),
    tag: htmlLang(locale),
    name: LOCALE_META[locale].name,
  }))
}

function withHash(event: ReactMouseEvent<HTMLAnchorElement>) {
  if (location.hash) event.currentTarget.href = event.currentTarget.href.split('#')[0] + location.hash
}

export function LanguageSwitcher() {
  const c = useContent()
  const links = useLocaleLinks()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('focusin', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('focusin', close)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label={c.nav.language}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="grid size-9 place-items-center rounded-full hover:bg-bg-soft"
      >
        <Languages className="size-4.5" />
      </button>
      {open ? (
        <ul className="card absolute right-0 z-50 mt-2 w-40 p-1.5 shadow-lg">
          {links.map((link) => (
            <li key={link.locale}>
              <a
                href={link.href}
                hrefLang={link.locale}
                lang={link.tag}
                aria-current={link.current ? 'page' : undefined}
                onClick={withHash}
                className={`block rounded-lg px-3 py-2 text-sm hover:bg-bg-soft ${link.current ? 'font-semibold' : ''}`}
              >
                {link.name}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

// 页脚：始终渲染全部语言链接，SSR HTML 里就有，给爬虫和不用 JS 的访客
export function LanguageLinks() {
  const c = useContent()
  const links = useLocaleLinks()
  return (
    <nav aria-label={c.nav.language} className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <Languages className="size-4" aria-hidden />
      {links.map((link) => (
        <a
          key={link.locale}
          href={link.href}
          hrefLang={link.locale}
          lang={link.tag}
          aria-current={link.current ? 'page' : undefined}
          onClick={withHash}
          className={link.current ? 'font-semibold text-footer-fg' : 'text-footer-fg/75 hover:text-footer-fg'}
        >
          {link.name}
        </a>
      ))}
    </nav>
  )
}
