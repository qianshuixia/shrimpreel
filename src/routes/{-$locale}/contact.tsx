import { createFileRoute, useHydrated } from '@tanstack/react-router'
import { ArrowRight, CircleCheck } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Turnstile } from '#/components/Turnstile'
import { ErrorText, LocalLink, Spinner } from '#/components/ui'
import { api, errorCode } from '#/lib/api'
import { getContent, localeFromParam, pageHead, useContent } from '#/lib/i18n'
import { useSession } from '#/lib/session'

export const Route = createFileRoute('/{-$locale}/contact')({
  head: ({ params }) => {
    const locale = localeFromParam(params.locale)
    const c = getContent(locale)
    return pageHead(locale, '/contact', c.meta.contactTitle, c.meta.contactDescription)
  },
  component: ContactPage,
})

function ContactPage() {
  const c = useContent()
  const t = c.contact
  const { user, config } = useSession()
  const [email, setEmail] = useState('')
  const [topic, setTopic] = useState('general')
  const [message, setMessage] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [resetKey, setResetKey] = useState(0)
  const siteKey = config?.turnstileSiteKey ?? null
  const hydrated = useHydrated()

  useEffect(() => {
    if (user && !email) setEmail(user.email)
  }, [user, email])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setState('sending')
    try {
      await api('/api/contact', { json: { email, topic, message, turnstileToken: token } })
      setState('sent')
    } catch (err) {
      setError(errorCode(err))
      setState('idle')
      setResetKey((n) => n + 1)
    }
  }

  return (
    <div className="container-page max-w-2xl py-16">
      <h1 className="font-display text-5xl">{t.title}</h1>
      <p className="mt-4 text-muted">{t.body}</p>
      <LocalLink to="/guides" className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold hover:text-accent-text">
        {t.guides} <ArrowRight className="size-4" />
      </LocalLink>
      {state === 'sent' ? (
        <p className="card mt-10 flex items-center gap-2 p-6 font-medium" data-testid="contact-sent">
          <CircleCheck className="size-5 text-emerald-600" /> {t.sent}
        </p>
      ) : (
        <form onSubmit={submit} className="card mt-10 space-y-5 p-6">
          <label className="block space-y-1.5 text-sm font-medium">
            <span>{t.email}</span>
            <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>{t.topic}</span>
            <select className="input" value={topic} onChange={(e) => setTopic(e.target.value)}>
              {Object.entries(t.topics).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>{t.message}</span>
            <textarea
              className="input min-h-40"
              required
              minLength={10}
              maxLength={5000}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </label>
          {siteKey ? <Turnstile siteKey={siteKey} onToken={setToken} resetKey={resetKey} /> : null}
          <ErrorText code={error} />
          <button type="submit" className="btn-primary" disabled={!hydrated || state === 'sending' || Boolean(siteKey && !token)}>
            {state === 'sending' ? <Spinner /> : null} {t.send}
          </button>
        </form>
      )}
    </div>
  )
}
