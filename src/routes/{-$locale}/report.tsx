import { createFileRoute, useHydrated } from '@tanstack/react-router'
import { CircleCheck } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Turnstile } from '#/components/Turnstile'
import { ErrorText, Spinner } from '#/components/ui'
import { api, errorCode } from '#/lib/api'
import { getContent, localeFromParam, pageHead, useContent, useLocale } from '#/lib/i18n'
import { useSession } from '#/lib/session'

export const Route = createFileRoute('/{-$locale}/report')({
  head: ({ params }) => {
    const locale = localeFromParam(params.locale)
    const c = getContent(locale)
    return pageHead(locale, '/report', c.meta.reportTitle, c.meta.reportDescription)
  },
  component: ReportPage,
})

function ReportPage() {
  const t = useContent().report
  const locale = useLocale()
  const { user, config } = useSession()
  const [form, setForm] = useState({ name: '', email: '', contentRef: '', reason: 'intimate', details: '', isDepicted: false, attest: false, signature: '' })
  const [token, setToken] = useState<string | null>(null)
  const [resetKey, setResetKey] = useState(0)
  const [sending, setSending] = useState(false)
  const [sentId, setSentId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const siteKey = config?.turnstileSiteKey ?? null
  const hydrated = useHydrated()

  useEffect(() => {
    if (user) setForm((f) => (f.email ? f : { ...f, email: user.email }))
  }, [user])

  // 从分享页“举报这条视频”进来时带着链接（?content=），预先填好
  useEffect(() => {
    const content = new URLSearchParams(window.location.search).get('content')?.slice(0, 500)
    if (content) setForm((f) => (f.contentRef ? f : { ...f, contentRef: content }))
  }, [])

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setSending(true)
    try {
      const data = await api<{ report: { id: string } }>('/api/takedowns', { json: { ...form, locale, turnstileToken: token } })
      setSentId(data.report.id)
    } catch (err) {
      setError(errorCode(err))
      setResetKey((n) => n + 1)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="container-page max-w-2xl py-16">
      <h1 className="font-display text-5xl">{t.title}</h1>
      <p className="mt-4 text-muted">{t.body}</p>
      <p className="mt-3 text-sm text-muted">
        {t.urgent}{' '}
        <a href="https://report.cybertip.org/" target="_blank" rel="noreferrer" className="underline">
          {t.cybertip}
        </a>
      </p>
      {sentId ? (
        <p className="card mt-10 flex items-start gap-2 p-6 font-medium" data-testid="report-sent">
          <CircleCheck className="mt-0.5 size-5 shrink-0 text-emerald-600" /> {t.sent(sentId)}
        </p>
      ) : (
        <form onSubmit={submit} className="card mt-10 space-y-5 p-6" data-testid="report-form">
          <label className="block space-y-1.5 text-sm font-medium">
            <span>{t.name}</span>
            <input className="input" name="name" required maxLength={200} value={form.name} onChange={(e) => set('name', e.target.value)} />
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>{t.email}</span>
            <input className="input" name="email" type="email" required value={form.email} onChange={(e) => set('email', e.target.value)} />
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>{t.contentRef}</span>
            <input
              className="input"
              name="contentRef"
              required
              minLength={3}
              maxLength={2000}
              value={form.contentRef}
              onChange={(e) => set('contentRef', e.target.value)}
            />
            <span className="block text-xs font-normal text-muted">{t.contentRefHint}</span>
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>{t.reason}</span>
            <select className="input" name="reason" value={form.reason} onChange={(e) => set('reason', e.target.value)}>
              {Object.entries(t.reasons).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>{t.details}</span>
            <textarea className="input min-h-28" name="details" maxLength={5000} value={form.details} onChange={(e) => set('details', e.target.value)} />
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" name="isDepicted" checked={form.isDepicted} onChange={(e) => set('isDepicted', e.target.checked)} />
            <span>{t.isDepicted}</span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" name="attest" required checked={form.attest} onChange={(e) => set('attest', e.target.checked)} />
            <span>{t.attest}</span>
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>{t.signature}</span>
            <input className="input" name="signature" required maxLength={200} value={form.signature} onChange={(e) => set('signature', e.target.value)} />
          </label>
          {siteKey ? <Turnstile siteKey={siteKey} onToken={setToken} resetKey={resetKey} /> : null}
          <ErrorText code={error} />
          <button type="submit" className="btn-primary" disabled={!hydrated || sending || Boolean(siteKey && !token)}>
            {sending ? <Spinner /> : null} {t.submit}
          </button>
        </form>
      )}
    </div>
  )
}
