import { Link, createFileRoute } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { AdminPage, LoadState, Status, money, shortDate, useAdminData } from '#/components/admin'
import { DISPUTE_LABEL, OrderActions, orderStatus, type AdminOrder } from '#/components/admin-orders'

export const Route = createFileRoute('/admin/orders/$id')({
  component: AdminOrderDetail,
})

type Detail = {
  order: AdminOrder & { user_credits: number }
  events: { id: string; provider: string; event_id: string; event_type: string; status: string; error: string | null; created_at: string }[]
  ledger: { id: string; delta: number; reason: string; note: string | null; created_at: string }[]
  audit: { id: string; action: string; detail: string | null; created_at: string; admin_email: string | null }[]
  emails: { id: string; template: string; to_email: string; status: string; last_error: string | null; created_at: string; sent_at: string | null }[]
}

const EMAIL_STATUS: Record<string, string> = { pending: '待发送', sent: '已发送', failed: '发送失败', skipped: '未发送' }

type TimelineItem = { key: string; at: string; kind: string; title: string; detail?: string | null; status?: string }

// 把订单生命周期里分散在各表的记录合成一条时间线
function timeline(d: Detail): TimelineItem[] {
  const o = d.order
  const items: TimelineItem[] = [{ key: 'created', at: o.created_at, kind: '订单', title: `创建订单（${o.provider}）` }]
  for (const e of d.events) items.push({ key: e.id, at: e.created_at, kind: '支付商事件', title: e.event_type, detail: e.error ?? e.event_id, status: e.status })
  for (const l of d.ledger) items.push({ key: l.id, at: l.created_at, kind: '积分', title: `${l.reason} ${l.delta > 0 ? `+${l.delta}` : l.delta}`, detail: l.note })
  for (const a of d.audit) items.push({ key: a.id, at: a.created_at, kind: '管理员', title: `${a.action}（${a.admin_email ?? '—'}）`, detail: a.detail })
  for (const m of d.emails)
    items.push({ key: m.id, at: m.created_at, kind: '邮件', title: `${m.template} → ${m.to_email}（${EMAIL_STATUS[m.status] ?? m.status}）`, detail: m.last_error })
  return items.sort((a, b) => a.at.localeCompare(b.at))
}

function AdminOrderDetail() {
  const { id } = Route.useParams()
  const { data, error, loading, reload } = useAdminData<Detail>(`/api/admin/orders/${encodeURIComponent(id)}`)
  const o = data?.order
  const paidCurrency = o ? (o.paid_currency ?? o.currency) : 'USD'

  return (
    <AdminPage
      title={`订单 ${id}`}
      actions={
        <Link to="/admin/orders" className="btn-ghost px-3 py-1.5 text-sm">
          <ArrowLeft className="size-4" /> 订单列表
        </Link>
      }
    >
      <LoadState loading={loading && !data} error={error} />
      {o && data ? (
        <>
          <div className="card space-y-3 p-5 text-sm" data-testid="admin-order-detail">
            <dl className="grid grid-cols-[120px_1fr] gap-y-2">
              <dt className="text-muted">状态</dt>
              <dd>
                <Status value={orderStatus(o)} />
              </dd>
              <dt className="text-muted">用户</dt>
              <dd>
                <Link to="/admin/users/$id" params={{ id: o.user_id }} className="hover:underline">
                  {o.user_email}
                </Link>
                <span className="ml-2 text-xs text-muted">当前余额 {o.user_credits} 积分</span>
              </dd>
              <dt className="text-muted">套餐</dt>
              <dd>
                {o.package_id} · {o.credits} 积分
              </dd>
              <dt className="text-muted">标价</dt>
              <dd>{money(o.amount_cents, o.currency)}</dd>
              <dt className="text-muted">实收</dt>
              <dd>
                {o.paid_amount_cents === null ? '—' : money(o.paid_amount_cents, paidCurrency)}
                {o.paid_amount && o.paid_currency && o.paid_currency !== o.currency ? (
                  <span className="ml-2 text-xs text-muted">
                    支付商回传 {o.paid_amount} {o.paid_currency}
                  </span>
                ) : null}
              </dd>
              <dt className="text-muted">已退</dt>
              <dd data-testid="admin-order-refunded">
                {money(o.refunded_amount_cents, paidCurrency)} · {o.refunded_credits} 积分
              </dd>
              {o.dispute_status ? (
                <>
                  <dt className="text-muted">争议</dt>
                  <dd data-testid="admin-order-dispute">
                    {DISPUTE_LABEL[o.dispute_status]}
                    <span className="ml-2 font-mono text-xs text-muted">{o.dispute_id}</span>
                    <span className="block text-xs text-muted">
                      {shortDate(o.disputed_at)} · 开启时回收 {o.dispute_credits} 积分
                    </span>
                  </dd>
                </>
              ) : null}
              <dt className="text-muted">支付商</dt>
              <dd className="font-mono text-xs">
                {o.provider}
                {o.provider_order_id ? <span className="block text-muted">order: {o.provider_order_id}</span> : null}
                {o.provider_payment_id ? <span className="block text-muted">payment: {o.provider_payment_id}</span> : null}
              </dd>
              <dt className="text-muted">创建 / 支付</dt>
              <dd>
                {shortDate(o.created_at)} / {shortDate(o.paid_at)}
              </dd>
              <dt className="text-muted">退款时间</dt>
              <dd>{shortDate(o.refunded_at)}</dd>
              <dt className="text-muted">来源</dt>
              <dd className="text-xs">
                {[o.source, o.medium, o.campaign, o.country, o.device].filter(Boolean).join(' · ') || '—'}
              </dd>
            </dl>
            <div className="flex flex-wrap gap-2 border-t border-line pt-3">
              <OrderActions order={o} onDone={reload} />
            </div>
          </div>

          <section className="space-y-3">
            <h2 className="font-semibold">时间线</h2>
            <ol className="card divide-y divide-line text-sm" data-testid="order-timeline">
              {timeline(data).map((item) => (
                <li key={item.key} className="grid gap-1 px-5 py-3 sm:grid-cols-[170px_90px_1fr]">
                  <span className="whitespace-nowrap text-xs text-muted">{shortDate(item.at)}</span>
                  <span className="text-xs text-muted">{item.kind}</span>
                  <span className="min-w-0">
                    <span className="font-medium">{item.title}</span>
                    {item.status ? (
                      <span className="ml-2">
                        <Status value={item.status} />
                      </span>
                    ) : null}
                    {item.detail ? <span className="block break-all text-xs text-muted">{item.detail}</span> : null}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </>
      ) : null}
    </AdminPage>
  )
}
