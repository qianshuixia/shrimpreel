import { createFileRoute } from '@tanstack/react-router'
import { CircleCheck, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ErrorText, Spinner } from '#/components/ui'
import { site } from '#/config/site'
import { api, errorCode } from '#/lib/api'
import { getContent, localeFromParam, pageHead, useContent } from '#/lib/i18n'

export const Route = createFileRoute('/{-$locale}/phone-upload')({
  head: ({ params }) => {
    const locale = localeFromParam(params.locale)
    const c = getContent(locale)
    const head = pageHead(locale, '/phone-upload', c.phoneUpload.title, c.phoneUpload.noToken)
    return { ...head, meta: [...head.meta, { name: 'robots', content: 'noindex' }] }
  },
  component: PhoneUploadPage,
})

// 手机端：扫码打开，token 在 URL fragment 里（不会发给服务器）。选一张照片传回电脑，审核在电脑端真正上传时做
function PhoneUploadPage() {
  const c = useContent()
  const t = c.phoneUpload
  const inputRef = useRef<HTMLInputElement>(null)
  const [token, setToken] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [sending, setSending] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setToken(location.hash.slice(1) || null)
    setReady(true)
  }, [])

  async function send(file: File | undefined) {
    if (!file || !token) return
    setError(null)
    // 先在手机上按类型和大小预检；真正的校验以服务端为准
    if (!(site.upload.contentTypes as readonly string[]).includes(file.type)) return setError('unsupported_file_type')
    if (file.size > site.upload.maxBytes) return setError('file_too_large')
    setSending(true)
    try {
      const form = new FormData()
      form.append('token', token)
      form.append('file', file)
      await api('/api/handoff/photo', { form })
      setDone(true)
    } catch (err) {
      setError(errorCode(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <main className="mx-auto max-w-md space-y-5 px-4 py-12 text-center">
      <h1 className="text-2xl font-semibold">{t.title}</h1>
      {!ready ? null : !token ? (
        <p className="text-sm text-muted" data-testid="phone-upload-no-token">
          {t.noToken}
        </p>
      ) : done ? (
        <p className="flex items-center justify-center gap-2 text-sm font-semibold" data-testid="phone-upload-done">
          <CircleCheck className="size-5 text-emerald-600" /> {t.done}
        </p>
      ) : (
        <>
          {/* 不加 capture：手机上可以选相册，也可以现拍 */}
          <input
            ref={inputRef}
            type="file"
            accept={site.upload.contentTypes.join(',')}
            className="sr-only"
            tabIndex={-1}
            aria-label={t.choose}
            data-testid="phone-upload-input"
            onChange={(event) => {
              void send(event.target.files?.[0])
              event.target.value = ''
            }}
          />
          <button type="button" disabled={sending} onClick={() => inputRef.current?.click()} className="btn-primary w-full py-6 text-base">
            {sending ? <Spinner /> : <Upload className="size-5" />} {sending ? t.uploading : t.choose}
          </button>
          <p className="text-xs text-muted">{c.generator.dropHint}</p>
          <ErrorText code={error} />
        </>
      )}
    </main>
  )
}
