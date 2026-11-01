import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { formatPrice } from '#/config/site'
import { api, errorCode } from '#/lib/api'
import { Spinner, StatusPill } from './ui'

// 后台统一的数据加载：deps 变化时重新请求，reload 用于操作后刷新
export function useAdminData<T>(path: string) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // 只采用最后一次请求的结果：连续切换筛选时，先发出的请求可能后返回，不能覆盖新结果
  const latest = useRef(0)

  const reload = useCallback(async () => {
    const seq = ++latest.current
    setLoading(true)
    try {
      const result = await api<T>(path)
      if (seq !== latest.current) return
      setData(result)
      setError(null)
    } catch (err) {
      if (seq !== latest.current) return
      setError(errorCode(err))
    } finally {
      if (seq === latest.current) setLoading(false)
    }
  }, [path])

  useEffect(() => {
    void reload()
  }, [reload])

  return { data, error, loading, reload }
}

// 需要备注的危险操作：prompt 收集备注，失败时 alert 错误码
export async function adminAction(path: string, json: unknown, confirmText?: string) {
  if (confirmText && !confirm(confirmText)) return false
  try {
    await api(path, { json })
    return true
  } catch (err) {
    // 支付商的拒绝原因（如余额不足、已有退款在处理）在 message 里，一并显示
    const detail = err instanceof Error && err.message !== errorCode(err) ? `\n${err.message}` : ''
    alert(`操作失败：${errorCode(err)}${detail}`)
    return false
  }
}

export function promptNote(message: string) {
  const note = prompt(message)?.trim()
  return note ? note : null
}

export function AdminPage({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-3xl">{title}</h1>
        {actions}
      </div>
      {children}
    </div>
  )
}

export function LoadState({ loading, error, empty }: { loading: boolean; error: string | null; empty?: boolean }) {
  if (error) return <p className="text-sm text-red-600">加载失败：{error}</p>
  if (loading) return <Spinner className="size-5" />
  if (empty) return <p className="text-sm text-muted">暂无数据</p>
  return null
}

export function money(cents: number | null | undefined, currency = 'USD') {
  return formatPrice(Number(cents ?? 0), currency)
}

// 估算毛利（USD 美分）= 消耗积分 × 每积分实收 − 服务商成本；还没有 USD 订单时无法折算
export function marginCents(credits: number, revenuePerCreditCents: number | null, costCents: number) {
  return revenuePerCreditCents === null ? null : Math.round(credits * revenuePerCreditCents) - costCents
}

export function shortDate(value: string | null | undefined) {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

const TONE: Record<string, 'ok' | 'warn' | 'bad' | 'muted'> = {
  paid: 'ok',
  succeeded: 'ok',
  processed: 'ok',
  active: 'ok',
  closed: 'muted',
  pending: 'muted',
  queued: 'muted',
  ignored: 'muted',
  processing: 'warn',
  refunded: 'warn',
  partially_refunded: 'warn',
  disputed: 'bad',
  open: 'warn',
  failed: 'bad',
  orphan: 'bad',
  mismatch: 'bad',
  canceled: 'muted',
  banned: 'bad',
  deleted: 'muted',
  removed: 'bad',
  rejected: 'muted',
  past_due: 'bad',
  expired: 'muted',
}

const LABEL: Record<string, string> = {
  paid: '已支付',
  pending: '待支付',
  failed: '失败',
  refunded: '已退款',
  partially_refunded: '部分退款',
  disputed: '争议中',
  canceled: '已取消',
  queued: '排队中',
  processing: '生成中',
  succeeded: '成功',
  processed: '已处理',
  ignored: '已忽略',
  orphan: '找不到订单',
  mismatch: '金额/商品不符',
  active: '正常',
  banned: '封禁',
  deleted: '已注销',
  open: '待处理',
  closed: '已关闭',
  removed: '已下架',
  rejected: '已驳回',
  past_due: '扣款失败',
  expired: '已结束',
}

export function Status({ value }: { value: string }) {
  return <StatusPill tone={TONE[value] ?? 'muted'}>{LABEL[value] ?? value}</StatusPill>
}

export function FilterSelect({
  value,
  onChange,
  options,
  label,
}: {
  value: string
  onChange: (value: string) => void
  options: [string, string][]
  label: string
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted">{label}</span>
      <select className="input w-auto py-1.5" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  )
}

export function Pager({ page, onPage, hasMore }: { page: number; onPage: (page: number) => void; hasMore: boolean }) {
  return (
    <div className="flex items-center justify-end gap-2 text-sm">
      <button type="button" className="btn-ghost px-3 py-1" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        上一页
      </button>
      <span className="text-muted">第 {page} 页</span>
      <button type="button" className="btn-ghost px-3 py-1" disabled={!hasMore} onClick={() => onPage(page + 1)}>
        下一页
      </button>
    </div>
  )
}

export const PAGE_SIZE = 50
