import { ShieldCheck, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { applyAttributionConsent } from '#/lib/attribution'
import { CONSENT_OPEN_EVENT, consentDefault, readConsent, saveConsent, type Consent } from '#/lib/consent'
import { useContent } from '#/lib/i18n'
import { LocalLink } from './ui'

// 统计同意横幅（配置了 GA4 或 Clarity 时渲染）。选择存在 localStorage，服务端无从得知，挂载后才决定是否显示；
// 只对没选择过、且地区默认 denied（EEA、英国、瑞士、未知国家）的访客自动弹出，其他地区只能从页脚打开；
// 右下角小卡片，不挡正文；“接受”和“拒绝”同样大小，× 只收起本次（不记录，下次访问再问）。
// 页脚“Cookie 设置”派发 CONSENT_OPEN_EVENT 重新打开
export function ConsentBanner({ ga4Id }: { ga4Id: string }) {
  const c = useContent()
  const [open, setOpen] = useState(false)
  // 默认已开启统计 Cookie 的地区：从页脚打开时说明的是“默认开启、可拒绝”
  const [optOut, setOptOut] = useState(false)
  useEffect(() => {
    const stored = readConsent()
    setOpen(stored === null && consentDefault() === 'denied')
    setOptOut(stored === null && consentDefault() === 'granted')
    const reopen = () => setOpen(true)
    window.addEventListener(CONSENT_OPEN_EVENT, reopen)
    return () => window.removeEventListener(CONSENT_OPEN_EVENT, reopen)
  }, [])
  if (!open) return null

  const choose = (value: Consent) => {
    saveConsent(ga4Id, value)
    applyAttributionConsent(value)
    setOptOut(false)
    setOpen(false)
  }
  return (
    <section
      aria-label={c.consent.title}
      data-testid="consent-banner"
      className="fixed inset-x-2 bottom-2 z-40 rounded-(--card-radius) border border-line bg-card p-4 text-fg shadow-2xl sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[360px] sm:p-5"
    >
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-accent-text" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{c.consent.title}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            {optOut ? c.consent.bodyOptOut : c.consent.body}{' '}
            <LocalLink to="/privacy-policy" className="underline hover:text-fg">
              {c.consent.learnMore}
            </LocalLink>
          </p>
        </div>
        <button
          type="button"
          aria-label={c.consent.dismiss}
          title={c.consent.dismiss}
          className="-mt-1 -mr-1 grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-bg-soft hover:text-fg"
          onClick={() => setOpen(false)}
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" className="btn-ghost px-3 py-2 text-xs" onClick={() => choose('denied')}>
          {c.consent.reject}
        </button>
        <button type="button" className="btn-ghost px-3 py-2 text-xs" onClick={() => choose('granted')}>
          {c.consent.accept}
        </button>
      </div>
    </section>
  )
}
