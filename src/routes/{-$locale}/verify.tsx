import { createFileRoute, notFound, useHydrated } from '@tanstack/react-router'
import { CircleCheck, CircleHelp, ShieldQuestion } from 'lucide-react'
import { useEffect, useState, type ChangeEvent } from 'react'
import { ErrorText, Spinner, formatDate } from '#/components/ui'
import { site } from '#/config/site'
import { api, errorCode } from '#/lib/api'
import { getContent, localeFromParam, pageHead, useContent, useLocale } from '#/lib/i18n'
import { GENERATION_ID_PATTERN, parseXmpAiInfo, readXmpFromBlob } from '#/lib/xmp'

export const Route = createFileRoute('/{-$locale}/verify')({
  // 站点开关 aiMetadata 关闭时没有这个页面（服务端渲染返回 404）
  beforeLoad: () => {
    if (!site.aiMetadata.enabled) throw notFound()
  },
  head: ({ params }) => {
    const locale = localeFromParam(params.locale)
    const c = getContent(locale)
    return pageHead(locale, '/verify', c.meta.verifyTitle, c.meta.verifyDescription)
  },
  component: VerifyPage,
})

type Lookup = { found: false } | { found: true; brand: string; createdAt: string; model: string; provider: string }
// marker：文件里的标识 + 服务端核对结果；no-marker：文件里没有标识；by-id：只带了 ID（来自元数据里的验证链接）
type Result =
  | { kind: 'marker'; id: string; lookup: Lookup }
  | { kind: 'no-marker' }
  | { kind: 'by-id'; id: string; lookup: Lookup }

function VerifyPage() {
  const t = useContent().verify
  const locale = useLocale()
  const hydrated = useHydrated()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)

  const lookup = (id: string) => api<Lookup>(`/api/verify/${encodeURIComponent(id)}`)

  // 元数据里的验证链接带着 ?id=：打开就直接查记录
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('id')
    if (!id || !GENERATION_ID_PATTERN.test(id)) return
    setBusy(true)
    lookup(id)
      .then((found) => setResult({ kind: 'by-id', id, lookup: found }))
      .catch(() => setError('lookupError'))
      .finally(() => setBusy(false))
  }, [])

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError(null)
    setResult(null)
    setBusy(true)
    try {
      let xmp: string | null
      try {
        xmp = await readXmpFromBlob(file)
      } catch {
        setError('readError')
        return
      }
      const info = xmp ? parseXmpAiInfo(xmp) : null
      if (!info) {
        setResult({ kind: 'no-marker' })
        return
      }
      try {
        setResult({ kind: 'marker', id: info.generationId, lookup: await lookup(info.generationId) })
      } catch (err) {
        setError(errorCode(err) === 'rate_limited' ? 'rate_limited' : 'lookupError')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="container-page max-w-2xl py-16">
      <h1 className="font-display text-5xl">{t.title}</h1>
      <p className="mt-4 text-muted">{t.body}</p>
      <div className="card mt-10 space-y-4 p-6">
        <label className="block space-y-1.5 text-sm font-medium">
          <span>{t.choose}</span>
          <input
            type="file"
            accept="video/mp4,video/quicktime,.mp4,.mov,.m4v"
            className="input"
            data-testid="verify-input"
            disabled={!hydrated || busy}
            onChange={onFile}
          />
        </label>
        {busy ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> {t.checking}
          </p>
        ) : null}
        <ErrorText code={error === 'readError' || error === 'lookupError' ? null : error} />
        {error === 'readError' || error === 'lookupError' ? (
          <p className="text-sm text-red-600" role="alert">
            {t[error]}
          </p>
        ) : null}
      </div>
      {result ? <ResultCard result={result} locale={locale} /> : null}
      <p className="mt-6 text-xs leading-relaxed text-muted">{t.caveat}</p>
    </div>
  )
}

function ResultCard({ result, locale }: { result: Result; locale: ReturnType<typeof useLocale> }) {
  const t = useContent().verify
  if (result.kind === 'no-marker') {
    return (
      <div className="card mt-6 p-6" data-testid="verify-result" data-state="no-marker">
        <p className="flex items-center gap-2 font-medium">
          <CircleHelp className="size-5 text-muted" /> {t.noMarkerTitle}
        </p>
        <p className="mt-2 text-sm text-muted">{t.noMarkerBody}</p>
      </div>
    )
  }
  if (!result.lookup.found) {
    return (
      <div className="card mt-6 p-6" data-testid="verify-result" data-state="not-found">
        <p className="flex items-center gap-2 font-medium">
          <ShieldQuestion className="size-5 text-amber-600" /> {t.notFoundTitle}
        </p>
        <p className="mt-2 text-sm text-muted">{t.notFoundBody}</p>
      </div>
    )
  }
  const found = result.lookup
  return (
    <div className="card mt-6 p-6" data-testid="verify-result" data-state="found">
      <p className="flex items-center gap-2 font-medium">
        <CircleCheck className="size-5 text-emerald-600" /> {t.foundTitle}
      </p>
      <p className="mt-2 text-sm text-muted">{result.kind === 'by-id' ? t.foundByIdBody : t.foundBody}</p>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted">{t.fields.generator}</dt>
        <dd data-testid="verify-brand">{found.brand}</dd>
        <dt className="text-muted">{t.fields.model}</dt>
        <dd>{found.model}</dd>
        <dt className="text-muted">{t.fields.created}</dt>
        <dd>{formatDate(found.createdAt, locale)}</dd>
        <dt className="text-muted">{t.fields.id}</dt>
        <dd className="font-mono break-all" data-testid="verify-id">
          {result.id}
        </dd>
      </dl>
    </div>
  )
}
