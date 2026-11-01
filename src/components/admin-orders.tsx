import { api, errorCode } from '#/lib/api'
import type { ReconcileStatus } from '#/server/reconcile'
import { displayToMinor } from '#/server/payments/amount'
import { adminAction, money, promptNote } from './admin'

// /api/admin/orders 与 /api/admin/orders/:id 返回的订单行（orders 表 + 用户邮箱）
export type AdminOrder = {
  id: string
  user_id: string
  user_email: string
  provider: string
  package_id: string
  credits: number
  amount_cents: number
  currency: string
  status: string
  provider_order_id: string | null
  provider_payment_id: string | null
  paid_amount: string | null
  paid_currency: string | null
  paid_amount_cents: number | null
  refunded_amount_cents: number
  refunded_credits: number
  source: string | null
  medium: string | null
  campaign: string | null
  country: string | null
  device: string | null
  created_at: string
  paid_at: string | null
  refunded_at: string | null
  dispute_id: string | null
  dispute_status: 'open' | 'won' | 'lost' | null
  dispute_credits: number
  disputed_at: string | null
}

// 争议处理中显示“争议中”；败诉后订单本身已是 refunded，胜诉后回到普通状态
export function orderStatus(o: Pick<AdminOrder, 'status' | 'refunded_amount_cents'> & { dispute_status?: AdminOrder['dispute_status'] }) {
  if (o.dispute_status === 'open') return 'disputed'
  return o.status === 'paid' && o.refunded_amount_cents > 0 ? 'partially_refunded' : o.status
}

export const DISPUTE_LABEL = { open: '争议中', won: '争议胜诉', lost: '争议败诉' } as const

// provider：调用支付商退款 API 实际退钱，积分等退款 webhook 回来再回收；local：只本地记账（支付商后台已退但 webhook 丢失时用）
async function refund(order: AdminOrder, mode: 'provider' | 'local') {
  const currency = order.paid_currency ?? order.currency
  const remainingCents = Math.max(0, (order.paid_amount_cents ?? order.amount_cents) - order.refunded_amount_cents)
  const input = prompt(`退款订单 ${order.id}：退款金额（${currency}），最多 ${money(remainingCents, currency)}，留空 = 退全部剩余`, '')
  if (input === null) return false
  const amountCents = input.trim() ? displayToMinor(input, currency) : null
  if (input.trim() && (amountCents === null || amountCents <= 0 || amountCents > remainingCents)) {
    alert('退款金额无效')
    return false
  }
  const hint =
    mode === 'provider'
      ? `将调用 ${order.provider} 退款 API 实际退钱，积分在退款 webhook 到达后按金额比例回收。\nWaffo 每笔支付只能退款一次（14 天内）；Dodo 30 天内可多次部分退款，从商户钱包余额扣，余额不足会被拒；Stripe 可多次部分退款，余额不足时挂起到余额够了再退。`
      : '仅本地记账并按比例回收积分，不会调用支付商（用于已在支付商后台退款但 webhook 丢失的情况）。'
  const note = promptNote(`${hint}\n请输入原因：`)
  if (!note) return false
  let refundId: string | null = null
  if (mode === 'local' && order.provider !== 'mock') {
    // 与退款 webhook 共用幂等键，webhook 迟到也不会重复回收积分
    refundId = promptNote(`请填写支付商退款单号（Waffo 为 REF_ 开头，不是 TKT_ 工单号；Dodo 为 refund_id；Stripe 为 re_ 开头）：`)
    if (!refundId) return false
  }
  if (!(await adminAction(`/api/admin/orders/${order.id}/refund`, { note, amountCents, mode, refundId }))) return false
  if (mode === 'provider') alert('退款已提交，订单与积分会在支付商回调后更新。')
  return true
}

const RECONCILE_RESULT: Record<ReconcileStatus, string> = {
  processed: '支付商确认已付款，已按正常流程入账。',
  duplicate: '支付商确认已付款，这笔已入过账。',
  unpaid: '支付商那边没有成功的付款。',
  mismatch: '查到付款，但金额或商品与订单不符，没有入账。请到支付事件页核对后补单或退款。',
  review: '这笔订单已有金额/商品不符的付款事件，不再自动查单。请到支付事件页核对后补单或退款。',
  orphan: '查到的付款对不上本站订单。',
  ignored: '查到的付款不属于本站。',
  throttled: '正在查单，请稍后再试。',
  skipped: '订单已是终态，或该支付商不支持查单。',
}

async function reconcile(order: AdminOrder) {
  try {
    const { status } = await api<{ status: ReconcileStatus }>(`/api/admin/orders/${order.id}/reconcile`, { method: 'POST' })
    alert(RECONCILE_RESULT[status] ?? status)
    return status === 'processed' || status === 'duplicate'
  } catch (err) {
    const detail = err instanceof Error && err.message !== errorCode(err) ? `
${err.message}` : ''
    alert(`查单失败：${errorCode(err)}${detail}`)
    return false
  }
}

async function markPaid(order: AdminOrder) {
  const note = promptNote(`补单 ${order.id}：发放 ${order.credits} 积分。\n请先点“查单”或在支付商后台确认已收款，并填写凭证（如支付流水号）：`)
  return Boolean(note && (await adminAction(`/api/admin/orders/${order.id}/mark-paid`, { note })))
}

// 订单列表与订单详情共用的退款 / 查单 / 补单按钮；操作成功后调用 onDone 刷新
export function OrderActions({ order: o, onDone }: { order: AdminOrder; onDone: () => unknown }) {
  const run = async (action: Promise<boolean>) => {
    if (await action) await onDone()
  }
  return (
    <>
      {/* Waffo 每笔支付只能退一次，退过后只能"仅记账" */}
      {o.status === 'paid' && !(o.provider === 'waffo' && o.refunded_amount_cents > 0) ? (
        <button
          type="button"
          className="btn-ghost px-2.5 py-1 text-xs"
          onClick={() => run(refund(o, o.provider === 'mock' ? 'local' : 'provider'))}
          data-testid={`refund-${o.id}`}
        >
          退款
        </button>
      ) : null}
      {o.status === 'paid' && o.provider !== 'mock' ? (
        <button type="button" className="btn-ghost px-2.5 py-1 text-xs text-muted" onClick={() => run(refund(o, 'local'))}>
          仅记账
        </button>
      ) : null}
      {o.status === 'pending' || o.status === 'failed' || o.status === 'canceled' ? (
        <>
          <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => run(reconcile(o))} data-testid={`reconcile-${o.id}`}>
            查单
          </button>
          <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => run(markPaid(o))} data-testid={`mark-paid-${o.id}`}>
            补单
          </button>
        </>
      ) : null}
    </>
  )
}
