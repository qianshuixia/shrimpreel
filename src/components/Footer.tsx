import { LifeBuoy } from 'lucide-react'
import { ARTICLES, site } from '#/config/site'
import { ASK_AI, askAiUrl } from '#/lib/ask-ai'
import { CONSENT_OPEN_EVENT, CONSENT_REQUIRED } from '#/lib/consent'
import { absoluteUrl, useContent } from '#/lib/i18n'
import { LanguageLinks } from './Nav'
import { LocalLink, LogoMark } from './ui'

// 页脚只列前几篇文章，其余从 /guides 进入
const FOOTER_ARTICLES = 3

export function Footer() {
  const c = useContent()
  const columns = [
    {
      title: c.footer.resources,
      links: [
        { to: '/guides', label: c.guides.nav },
        ...ARTICLES.slice(0, FOOTER_ARTICLES).map((article) => ({ to: `/${article.slug}`, label: c.articles[article.key].title })),
        { to: '/pricing', label: c.nav.pricing },
        { to: '/contact', label: c.footer.contact },
      ],
    },
    {
      title: c.footer.legal,
      links: [
        { to: '/privacy-policy', label: c.footer.privacy },
        { to: '/terms-of-service', label: c.footer.terms },
        { to: '/refund-policy', label: c.footer.refund },
        { to: '/report', label: c.footer.report },
      ],
      // 启用 GA4 或 Clarity 时才有同意横幅，才需要“Cookie 设置”
      cookieSettings: CONSENT_REQUIRED,
    },
  ]
  // 页脚两种模式下都是深色，颜色取主题的 --footer-bg / --footer-fg
  return (
    <footer className="bg-footer text-footer-fg">
      <div className="container-page grid gap-12 py-16 md:grid-cols-[1.4fr_1fr_1fr]">
        <div className="space-y-5">
          <div className="flex items-center gap-2.5">
            <LogoMark />
            <span className="brand-name">{site.brandName}</span>
          </div>
          <p className="max-w-sm font-display text-lg leading-relaxed text-footer-fg/80 italic">{c.footer.statement}</p>
          <LanguageLinks />
        </div>
        {columns.map((column) => (
          <div key={column.title}>
            {/* h2：页脚前面可能只有 H1（登录页、404），用 h3 会跳级 */}
            <h2 className="eyebrow mb-4 text-footer-fg/60">{column.title}</h2>
            <ul className="space-y-3 text-sm">
              {column.links.map((link) => (
                <li key={link.to}>
                  <LocalLink to={link.to} className="text-footer-fg/85 hover:text-footer-fg">
                    {link.label}
                  </LocalLink>
                </li>
              ))}
              {'cookieSettings' in column && column.cookieSettings ? (
                <li>
                  <button
                    type="button"
                    onClick={() => window.dispatchEvent(new Event(CONSENT_OPEN_EVENT))}
                    className="text-footer-fg/85 hover:text-footer-fg"
                  >
                    {c.consent.settings}
                  </button>
                </li>
              ) : null}
            </ul>
          </div>
        ))}
      </div>
      <AskAi />
      <div className="border-t border-white/10">
        <div className="container-page flex flex-col gap-2 py-6 text-xs text-footer-fg/55 sm:flex-row sm:justify-between">
          <span>{c.footer.rights}</span>
          <a href={`mailto:${site.supportEmail}`} className="hover:text-footer-fg">
            {site.supportEmail}
          </a>
        </div>
      </div>
    </footer>
  )
}

// “问问 AI”：llms.txt 给 agent 读，几个按钮带预填提问打开各家 AI，看它们怎么介绍本站
function AskAi() {
  const c = useContent()
  const prompt = c.footer.askAiPrompt(absoluteUrl('/'), absoluteUrl('/llms.txt'))
  return (
    <div className="border-t border-white/10">
      <div className="container-page flex flex-col gap-4 py-8 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1.5 text-sm">
          <a href="/llms.txt" className="font-mono text-xs tracking-wide text-footer-fg/60 uppercase hover:text-footer-fg">
            {c.footer.agentDocs} · llms.txt
          </a>
          <p className="text-footer-fg/80">{c.footer.askAi}</p>
        </div>
        <ul className="flex gap-2" data-testid="ask-ai">
          {ASK_AI.map((ai) => (
            <li key={ai.id}>
              <a
                href={askAiUrl(ai, prompt)}
                target="_blank"
                rel="noopener nofollow"
                aria-label={c.footer.askAiLabel(ai.name)}
                title={c.footer.askAiLabel(ai.name)}
                className="grid size-9 place-items-center rounded-lg border border-white/15 text-footer-fg transition hover:border-white/40 hover:bg-white/5"
              >
                <svg viewBox="0 0 24 24" aria-hidden className="size-4" fill={ai.color}>
                  <path d={ai.path} fillRule={'evenOdd' in ai ? 'evenodd' : undefined} />
                </svg>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export function SupportButton() {
  const c = useContent()
  return (
    <LocalLink
      to="/contact"
      aria-label={c.support.label}
      title={c.support.label}
      className="fixed right-5 bottom-5 z-30 grid size-12 place-items-center rounded-full bg-ink text-ink-fg shadow-lg transition hover:scale-105"
    >
      <LifeBuoy className="size-5" />
    </LocalLink>
  )
}
