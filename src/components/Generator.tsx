import { useRouterState } from '@tanstack/react-router'
import { CircleAlert, CircleCheck, Download, Smartphone, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { STYLES, cheapestPackageCovering, defaultStyle, findStyle, formatPrice, site, styleDurations, stylePhotoCount } from '#/config/site'
import { api, errorCode, isActiveGeneration, type Generation } from '#/lib/api'
import { track } from '#/lib/attribution'
import { useCheckout } from '#/lib/checkout'
import { useContent, useLocale, useLocalePath } from '#/lib/i18n'
import { clearDraft, loadDraft, saveDraft } from '#/lib/photo-draft'
import { signInHref, useSession } from '#/lib/session'
import { PhoneUploadPanel } from './PhoneUploadPanel'
import { AiBadge, ErrorText, GoogleIcon, LocalLink, Spinner, formatDate } from './ui'
import { preparePhoto } from '#/lib/prepare-photo'

type Photo = { file: File; previewUrl: string; uploadId: string | null }
type Slot = 0 | 1
type Photos = [Photo | null, Photo | null]

const POLL_MS = 3000

// styleId / onStyleChange：首页把风格状态提到外面，让 hero 标签和生成器同步；不传时生成器自己管
export function Generator({ styleId: controlledStyleId, onStyleChange }: { styleId?: string; onStyleChange?: (id: string) => void } = {}) {
  const c = useContent()
  const g = c.generator
  const lp = useLocalePath()
  const locale = useLocale()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { user, config, loading, refresh } = useSession()
  // 两个照片槽：第 1 槽 = 源视频左边的人（单人风格只用它），第 2 槽 = 右边的人；切回单人风格时第 2 槽保留在状态里但被忽略
  const [photos, setPhotos] = useState<Photos>([null, null])
  const [uploading, setUploading] = useState(0)
  const [ownStyleId, setOwnStyleId] = useState<string>(defaultStyle.id)
  const styleId = controlledStyleId ?? ownStyleId
  const selectStyle = onStyleChange ?? setOwnStyleId
  const currentStyle = findStyle(styleId) ?? defaultStyle
  const need = stylePhotoCount(currentStyle)
  const styleDurationList = styleDurations(currentStyle)
  const [durationId, setDurationId] = useState<string>(styleDurationList[styleDurationList.length - 1]!.id)
  const [consent, setConsent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState<Generation | null>(null)
  const [phoneOpen, setPhoneOpen] = useState(false)
  const rootRef = useRef<HTMLElement>(null)
  const photosRef = useRef<Photos>([null, null])
  photosRef.current = photos
  const photo = photos[0]
  // 当前风格需要的照片都已选好
  const photosReady = photos.slice(0, need).every((p) => p !== null)
  // 最近一次写进草稿的内容：恢复草稿后不重复写（否则每次访问都会把 24 小时重新计时），生成成功后不再写
  const draftRef = useRef<{ file: File; file2: File | null; styleId: string; durationId: string; consent: boolean } | null>(null)
  const draftClearedRef = useRef<File | null>(null)

  const checkout = useCheckout()
  const duration = styleDurationList.find((d) => d.id === durationId) ?? styleDurationList[styleDurationList.length - 1]!
  const shortfall = user ? Math.max(0, duration.credits - user.credits) : 0
  // 余额不足时直接在这里下单够用的最便宜积分包；没有够用的包就退回去价格页
  const coverPack = shortfall > 0 ? cheapestPackageCovering(shortfall) : undefined
  // 访客也先看到这个视频要多少积分、最便宜的够用的包多少钱
  const guestPack = !user ? cheapestPackageCovering(duration.credits) : undefined

  useEffect(() => () => {
    if (photos[0]) URL.revokeObjectURL(photos[0].previewUrl)
  }, [photos[0]])
  useEffect(() => () => {
    if (photos[1]) URL.revokeObjectURL(photos[1].previewUrl)
  }, [photos[1]])

  // 切换风格后，当前时长不在新风格的档位里就选它最长的档位
  useEffect(() => {
    if (!styleDurationList.some((d) => d.id === durationId)) setDurationId(styleDurationList[styleDurationList.length - 1]!.id)
  }, [styleId])

  // 挂载时（只在客户端）恢复登录或付款跳转前保存的草稿：照片、风格、时长、授权勾选
  useEffect(() => {
    let cancelled = false
    void loadDraft().then((draft) => {
      if (cancelled || !draft || photosRef.current[0]) return
      const file = new File([draft.file], draft.name, { type: draft.type })
      const file2 = draft.file2 ? new File([draft.file2], draft.name2 ?? 'photo-2', { type: draft.type2 ?? draft.file2.type }) : null
      const nextStyle = STYLES.some((s) => s.id === draft.styleId) ? draft.styleId : styleId
      // 时长按恢复出的风格自己的档位校验
      const nextStyleDurations = styleDurations(findStyle(nextStyle) ?? defaultStyle)
      const nextDuration = nextStyleDurations.some((d) => d.id === draft.durationId)
        ? draft.durationId
        : nextStyleDurations.some((d) => d.id === durationId)
          ? durationId
          : nextStyleDurations[nextStyleDurations.length - 1]!.id
      draftRef.current = { file, file2, styleId: nextStyle, durationId: nextDuration, consent: draft.consent === true }
      setPhotos([
        { file, previewUrl: URL.createObjectURL(file), uploadId: null },
        file2 ? { file: file2, previewUrl: URL.createObjectURL(file2), uploadId: null } : null,
      ])
      if (nextStyle !== styleId) selectStyle(nextStyle)
      setDurationId(nextDuration)
      setConsent(draft.consent === true)
      rootRef.current?.scrollIntoView({ block: 'start' })
    })
    return () => {
      cancelled = true
    }
    // 只在挂载时恢复一次
  }, [])

  // 有照片时，照片、风格、时长、授权勾选的变化都写进草稿
  const photoFile = photos[0]?.file
  const photoFile2 = photos[1]?.file ?? null
  useEffect(() => {
    if (!photoFile || draftClearedRef.current === photoFile) return
    const last = draftRef.current
    if (last && last.file === photoFile && last.file2 === photoFile2 && last.styleId === styleId && last.durationId === durationId && last.consent === consent) return
    draftRef.current = { file: photoFile, file2: photoFile2, styleId, durationId, consent }
    void saveDraft({
      file: photoFile,
      name: photoFile.name,
      type: photoFile.type,
      ...(photoFile2 ? { file2: photoFile2, name2: photoFile2.name, type2: photoFile2.type } : {}),
      styleId,
      durationId,
      consent,
    })
  }, [photoFile, photoFile2, styleId, durationId, consent])

  // 轮询当前任务直到结束；结束后刷新余额（失败时积分已退回）
  useEffect(() => {
    if (!generation || !isActiveGeneration(generation)) return
    const timer = setTimeout(async () => {
      try {
        const data = await api<{ generation: Generation }>(`/api/generations/${generation.id}`)
        setGeneration(data.generation)
        if (!isActiveGeneration(data.generation)) await refresh()
      } catch (err) {
        setError(errorCode(err))
        setGeneration({ ...generation })
      }
    }, POLL_MS)
    return () => clearTimeout(timer)
  }, [generation, refresh])

  async function upload(file: File) {
    setUploading((n) => n + 1)
    try {
      const form = new FormData()
      form.append('file', file)
      const data = await api<{ upload: { id: string } }>('/api/uploads', { form })
      return data.upload.id
    } finally {
      setUploading((n) => n - 1)
    }
  }

  async function selectFile(file: File | undefined, slot: Slot = 0) {
    if (!file) return
    setError(null)
    // 先查尺寸（太小 / 太窄太扁直接让用户换一张），再把大照片缩小（手机原图会让上传接口 CPU 超限），见 lib/prepare-photo.ts。
    // 放在格式检查前面：浏览器能解开的 HEIC 等格式缩完就是 JPEG
    const prepared = await preparePhoto(file)
    if (prepared.problem) return setError(prepared.problem)
    file = prepared.file
    if (!(site.upload.contentTypes as readonly string[]).includes(file.type)) return setError('unsupported_file_type')
    if (file.size > site.upload.maxBytes) return setError('file_too_large')
    const next: Photo = { file, previewUrl: URL.createObjectURL(file), uploadId: null }
    setPhotos((current) => (slot === 0 ? [next, current[1]] : [current[0], next]))
    setGeneration(null)
    if (!user) return
    try {
      const uploadId = await upload(file)
      setPhotos((current) => {
        const updated: Photos = [current[0], current[1]]
        if (updated[slot]?.file === file) updated[slot] = { ...updated[slot]!, uploadId }
        return updated
      })
    } catch (err) {
      setError(errorCode(err))
    }
  }

  async function generate() {
    const required = photos.slice(0, need)
    if (!photo || required.some((p) => p === null)) return setError('invalid_upload')
    setError(null)
    setSubmitting(true)
    try {
      // 还没上传的槽先传；uploadIds 的顺序 = 左、右
      const uploadIds: string[] = []
      for (const [index, item] of required.entries()) {
        const current = item!
        const uploadId = current.uploadId ?? (await upload(current.file))
        if (!current.uploadId) {
          setPhotos((now) => {
            const updated: Photos = [now[0], now[1]]
            if (updated[index as Slot]?.file === current.file) updated[index as Slot] = { ...current, uploadId }
            return updated
          })
        }
        uploadIds.push(uploadId)
      }
      const data = await api<{ generation: Generation }>('/api/generations', { json: { uploadIds, durationId: duration.id, styleId, locale, consent } })
      track('generate_video', { style_id: styleId, duration_id: duration.id, credits: data.generation.creditsCost })
      draftClearedRef.current = photo.file
      await clearDraft()
      setGeneration(data.generation)
      await refresh()
    } catch (err) {
      setError(errorCode(err))
      await refresh()
    } finally {
      setSubmitting(false)
    }
  }

  function reset() {
    setGeneration(null)
    setError(null)
  }

  const busy = uploading > 0 || submitting || (generation !== null && isActiveGeneration(generation))

  return (
    <section
      ref={rootRef}
      className="card space-y-5 p-5 shadow-[0_1px_0_var(--line),0_20px_40px_-24px_rgba(0,0,0,0.25)] sm:p-6"
      aria-labelledby="generator-title"
      data-testid="generator"
    >
      {/* 标题只给读屏和大纲用：页面 H1 之后接 H2，步骤标题是 H3 */}
      <h2 id="generator-title" className="sr-only">
        {g.title}
      </h2>
      {/* 1. 照片 */}
      <section className="space-y-3">
        <StepTitle n={1}>{g.stepPhoto}</StepTitle>
        {need === 2 ? (
          <div className="grid grid-cols-2 gap-3">
            <PhotoDrop photo={photos[0]} uploading={uploading > 0 && photos[0]?.uploadId === null} busy={busy} testId="photo-input" label={g.photoLeft} onFile={(file) => void selectFile(file, 0)} />
            <PhotoDrop photo={photos[1]} uploading={uploading > 0 && photos[1]?.uploadId === null} busy={busy} testId="photo-input-2" label={g.photoRight} onFile={(file) => void selectFile(file, 1)} />
          </div>
        ) : (
          <PhotoDrop photo={photo} uploading={uploading > 0} busy={busy} testId="photo-input" onFile={(file) => void selectFile(file, 0)} />
        )}
        <p className="text-xs leading-5 text-muted">{need === 2 ? g.duoGuidance : g.guidance}</p>
        {/* 桌面访客的照片多半在手机上：扫码传到这里；手机本身不需要 */}
        {phoneOpen ? (
          <PhoneUploadPanel
            onPhoto={(file) => void selectFile(file, need === 2 && photos[0] && !photos[1] ? 1 : 0)}
            onClose={() => setPhoneOpen(false)}
          />
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setPhoneOpen(true)}
            className="btn-ghost hidden px-3 py-1.5 text-xs md:inline-flex"
            data-testid="phone-upload-open"
          >
            <Smartphone className="size-4" /> {g.phoneOpen}
          </button>
        )}
      </section>

      {/* 2. 风格：只有一种风格时不显示 */}
      {STYLES.length > 1 ? (
        <section className="space-y-3">
          <StepTitle n={2}>{g.stepStyle}</StepTitle>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={g.stepStyle}>
            {STYLES.map((style) => {
              const active = style.id === styleId
              const copy = c.styles[style.id as keyof typeof c.styles]
              const thumb = style.examples.aiVersions[0]
              return (
                <button
                  key={style.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={busy}
                  data-testid={`style-${style.id}`}
                  onClick={() => selectStyle(style.id)}
                  className={`flex items-center gap-3 rounded-xl p-2 text-left transition ${active ? 'bg-card shadow-sm ring-2 ring-ink' : 'bg-bg-soft text-muted ring-1 ring-line hover:text-fg'}`}
                >
                  {thumb ? <img src={thumb.poster} alt="" loading="lazy" className="aspect-[3/4] w-10 shrink-0 rounded-md object-cover" /> : null}
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-fg">{copy.name}</span>
                    <span className="block text-xs text-muted">{copy.tagline}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      ) : null}

      {/* 时长 */}
      <section className="space-y-3">
        <StepTitle n={STYLES.length > 1 ? 3 : 2}>{g.stepLength}</StepTitle>
        <div
          className={`grid gap-1 rounded-xl bg-bg-soft p-1 ${styleDurationList.length === 1 ? 'grid-cols-1' : styleDurationList.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}
          role="radiogroup"
          aria-label={g.stepLength}
        >
          {styleDurationList.map((d) => {
            const active = d.id === duration.id
            return (
              <button
                key={d.id}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={busy}
                data-testid={`duration-${d.id}`}
                onClick={() => setDurationId(d.id)}
                className={`rounded-lg px-2 py-2 text-center transition ${active ? 'bg-card shadow-sm ring-1 ring-line' : 'text-muted hover:text-fg'}`}
              >
                <span className="block text-sm font-semibold">
                  {g.seconds(d.seconds)}
                  {'isFull' in d && d.isFull ? ` · ${g.full}` : ''}
                </span>
                <span className="block text-xs text-muted">{g.creditsLabel(d.credits)}</span>
              </button>
            )
          })}
        </div>
      </section>

      <label className="flex items-start gap-3 text-xs leading-5 text-muted">
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-[var(--ink)]"
          data-testid="consent"
        />
        <span>{g.consent}</span>
      </label>

      {/* CTA */}
      <div className="space-y-2">
        {loading ? (
          <div className="btn-primary w-full py-3.5 opacity-60">
            <Spinner />
          </div>
        ) : !user ? (
          <a href={signInHref(config, pathname, lp('/sign-in'))} className="btn-primary w-full py-3.5" data-testid="generator-sign-up">
            <GoogleIcon /> {g.ctaSignUp}
          </a>
        ) : shortfall > 0 && coverPack ? (
          <>
            <button
              type="button"
              className="btn-primary w-full py-3.5"
              disabled={checkout.pending !== null || checkout.paused}
              onClick={() => checkout.buy(coverPack.id)}
              data-testid="generator-buy"
            >
              {checkout.paused ? (
                c.pricing.paused
              ) : checkout.pending === coverPack.id ? (
                <>
                  <Spinner /> {c.pricing.buying}
                </>
              ) : (
                g.ctaBuyPack(coverPack.credits, formatPrice(coverPack.priceCents, coverPack.currency))
              )}
            </button>
            <p className="text-center text-xs">
              <LocalLink to="/pricing" className="text-muted underline" data-testid="generator-see-packs">
                {g.seePacks}
              </LocalLink>
            </p>
            <ErrorText code={checkout.error} />
          </>
        ) : shortfall > 0 ? (
          <LocalLink to="/pricing" className="btn-primary w-full py-3.5" data-testid="generator-buy">
            {g.ctaBuy}
          </LocalLink>
        ) : (
          <button
            type="button"
            className="btn-primary w-full py-3.5"
            disabled={busy || !photosReady || !consent}
            onClick={generate}
            data-testid="generate"
          >
            {submitting ? <Spinner /> : null}
            {g.ctaGenerate(duration.credits)}
          </button>
        )}
        {!loading && !user && photo ? (
          <p className="text-center text-xs text-muted" data-testid="generator-draft-kept">
            {g.draftKept}
          </p>
        ) : null}
        {guestPack && !loading ? (
          <p className="text-center text-xs text-muted" data-testid="generator-guest-price">
            {g.guestPrice(duration.credits, formatPrice(guestPack.priceCents, guestPack.currency))}
          </p>
        ) : null}
        {user ? (
          <p className="text-center text-xs text-muted" data-testid="generator-balance">
            {g.balance(user.credits)}
            {shortfall > 0 ? ` · ${g.needMore(shortfall)}` : ''}
          </p>
        ) : null}
        {user && photosReady && !consent && !generation ? <p className="text-center text-xs text-muted">{g.needConsent}</p> : null}
        <ErrorText code={error} />
      </div>

      {generation ? <GenerationResult generation={generation} onReset={reset} /> : null}
    </section>
  )
}

// 一个照片槽：隐藏的 input + 拖放/点击区。单人风格用完整版；双人风格并排两个，带左右标签（compact）
function PhotoDrop({
  photo,
  uploading,
  busy,
  testId,
  label,
  onFile,
}: {
  photo: Photo | null
  uploading: boolean
  busy: boolean
  testId: string
  label?: string
  onFile: (file: File | undefined) => void
}) {
  const g = useContent().generator
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const compact = label !== undefined
  return (
    <div className={compact ? 'space-y-1.5' : undefined}>
      {label ? <p className="text-xs font-semibold">{label}</p> : null}
      {/* 键盘与读屏从下面的按钮进入，隐藏的 input 不占 Tab 位 */}
      <input
        ref={inputRef}
        type="file"
        accept={site.upload.contentTypes.join(',')}
        className="sr-only"
        tabIndex={-1}
        aria-label={label ?? g.dropTitle}
        data-testid={testId}
        onChange={(event) => {
          onFile(event.target.files?.[0])
          event.target.value = ''
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          onFile(event.dataTransfer.files?.[0])
        }}
        className={`flex w-full items-center justify-center rounded-xl border-2 border-dashed text-center transition ${compact ? 'px-2 py-4' : 'px-4 py-6'} ${
          dragging ? 'border-accent bg-accent/5' : 'border-line hover:border-fg/40'
        }`}
      >
        {photo ? (
          <span className={`flex items-center gap-4 text-left ${compact ? 'flex-col gap-2 text-center' : ''}`}>
            <img src={photo.previewUrl} alt="" className={`rounded-lg object-cover ${compact ? 'size-16' : 'size-20'}`} />
            <span className="space-y-1">
              <span className="flex items-center gap-1.5 text-sm font-semibold">
                {uploading ? <Spinner /> : <CircleCheck className="size-4 text-emerald-600" />}
                {uploading ? g.uploading : g.uploaded}
              </span>
              <span className="block text-xs text-muted underline">{g.change}</span>
            </span>
          </span>
        ) : (
          <span className="flex flex-col items-center gap-2.5">
            <span className="grid size-11 place-items-center rounded-full bg-ink text-ink-fg">
              <Upload className="size-5" />
            </span>
            <span className="text-sm font-semibold">{g.dropTitle}</span>
            {compact ? null : <span className="text-xs text-muted">{g.dropHint}</span>}
          </span>
        )}
      </button>
    </div>
  )
}

function StepTitle({ n, children }: { n: number; children: string }) {
  return (
    <h3 className="flex items-center gap-2 text-sm font-semibold">
      <span className="grid size-5 place-items-center rounded-full bg-ink text-[11px] text-ink-fg">{n}</span>
      {children}
    </h3>
  )
}

function GenerationResult({ generation, onReset }: { generation: Generation; onReset: () => void }) {
  const g = useContent().generator
  const locale = useLocale()
  return (
    <div className="space-y-3 rounded-xl border border-line bg-bg-soft p-4" data-testid="generation-status" data-status={generation.status}>
      {isActiveGeneration(generation) ? (
        <p className="flex items-start gap-2 text-sm">
          <Spinner className="mt-0.5 size-4 shrink-0" />
          {generation.status === 'queued' ? g.queued : g.processing}
        </p>
      ) : generation.status === 'succeeded' && generation.videoUrl ? (
        <>
          <p className="flex items-center gap-2 text-sm font-semibold">
            <CircleCheck className="size-4 text-emerald-600" /> {g.succeeded}
          </p>
          <div className="relative mx-auto w-fit">
            <AiBadge />
            <video src={generation.videoUrl} controls playsInline className="max-h-[420px] rounded-lg bg-black" data-testid="generation-video" />
          </div>
          <p className="text-xs text-muted" data-testid="ai-notice">
            {g.aiNotice}
            {generation.expiresAt ? ` ${g.expiresOn(formatDate(generation.expiresAt, locale))}` : null}
          </p>
          <div className="flex flex-wrap gap-2">
            <a href={`${generation.videoUrl}?download=1`} className="btn-primary px-4 py-2" download>
              <Download className="size-4" /> {g.download}
            </a>
            <LocalLink to="/dashboard" className="btn-ghost px-4 py-2">
              {g.viewAll}
            </LocalLink>
            <button type="button" className="btn-ghost px-4 py-2" onClick={onReset}>
              {g.makeAnother}
            </button>
          </div>
        </>
      ) : (
        <div className="space-y-2 text-sm">
          <p className="flex items-center gap-2 font-semibold text-red-600 dark:text-red-400">
            <CircleAlert className="size-4" /> {g.failed}
          </p>
          {generation.refunded ? <p className="text-muted">{g.refunded}</p> : null}
          <button type="button" className="btn-ghost px-4 py-2" onClick={onReset}>
            {g.makeAnother}
          </button>
        </div>
      )}
    </div>
  )
}
