import { createFileRoute } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { AdminPage, FilterSelect, LoadState, PAGE_SIZE, Pager, adminAction, shortDate, useAdminData } from '#/components/admin'
import { StatusPill } from '#/components/ui'

export const Route = createFileRoute('/admin/emails')({
  component: AdminEmails,
})

type EmailRow = {
  id: string
  dedupe_key: string
  template: string
  to_email: string
  locale: string
  subject: string | null
  status: 'pending' | 'sent' | 'failed' | 'skipped'
  attempts: number
  next_attempt_at: string
  provider_message_id: string | null
  last_error: string | null
  created_at: string
  sent_at: string | null
}

const STATUS: Record<EmailRow['status'], [string, 'ok' | 'warn' | 'bad' | 'muted']> = {
  pending: ['待发送', 'warn'],
  sent: ['已发送', 'ok'],
  failed: ['失败', 'bad'],
  skipped: ['未发送', 'muted'],
}

const TEMPLATES: Record<string, string> = {
  generation_succeeded: '视频已生成',
  generation_failed: '生成失败退积分',
  order_paid: '积分到账',
  takedown_received: '举报回执',
  takedown_resolved: '举报处理结果',
  content_removed: '内容被删除',
  admin_takedown: '举报提醒（管理员）',
  admin_contact: '留言提醒（管理员）',
  admin_dispute: '支付争议提醒（管理员）',
}

// 交易邮件发件箱：pending 由 Cron 每 5 分钟按退避重试（最多 5 次）；failed / skipped 可手动重发
function AdminEmails() {
  const [status, setStatus] = useState('')
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const params = new URLSearchParams({ page: String(page) })
  if (status) params.set('status', status)
  if (q) params.set('q', q)
  const { data, error, loading, reload } = useAdminData<{ emails: EmailRow[]; configured: boolean }>(`/api/admin/emails?${params}`)
  const rows = data?.emails ?? []

  function search(event: FormEvent) {
    event.preventDefault()
    setPage(1)
    setQ(input.trim())
  }

  async function retry(email: EmailRow) {
    if (await adminAction(`/api/admin/emails/${email.id}/retry`, {})) await reload()
  }

  return (
    <AdminPage title="邮件">
      {data && !data.configured ? (
        <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-200" data-testid="email-not-configured">
          未配置发信：设置 EMAIL_FROM 并添加 send_email binding（见 README「交易邮件」），新邮件会记为“未发送”。
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-4">
        <FilterSelect
          label="状态"
          value={status}
          onChange={(v) => {
            setStatus(v)
            setPage(1)
          }}
          options={[
            ['', '全部'],
            ['pending', '待发送'],
            ['sent', '已发送'],
            ['failed', '失败'],
            ['skipped', '未发送'],
          ]}
        />
        <form onSubmit={search} className="flex gap-2">
          <input className="input w-72 py-1.5" placeholder="收件人 / 订单号 / 举报编号" value={input} onChange={(e) => setInput(e.target.value)} />
          <button type="submit" className="btn-primary px-4 py-1.5">
            搜索
          </button>
        </form>
      </div>
      <LoadState loading={loading && !data} error={error} empty={!!data && !rows.length} />
      {rows.length ? (
        <div className="card overflow-x-auto">
          <table className="table-admin" data-testid="admin-emails">
            <thead>
              <tr className="whitespace-nowrap">
                <th>时间</th>
                <th>类型</th>
                <th>收件人</th>
                <th>主题</th>
                <th>状态</th>
                <th>次数</th>
                <th>错误</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} data-testid="admin-email-row" data-key={e.dedupe_key}>
                  <td className="whitespace-nowrap text-xs">{shortDate(e.sent_at ?? e.created_at)}</td>
                  <td className="whitespace-nowrap text-xs">{TEMPLATES[e.template] ?? e.template}</td>
                  <td className="text-xs">{e.to_email}</td>
                  <td className="max-w-xs truncate text-xs" title={e.subject ?? ''}>
                    {e.subject ?? '—'}
                  </td>
                  <td className="whitespace-nowrap">
                    <StatusPill tone={STATUS[e.status][1]}>{STATUS[e.status][0]}</StatusPill>
                  </td>
                  <td className="text-xs">{e.attempts}</td>
                  <td className="max-w-xs truncate text-xs text-red-600" title={e.last_error ?? ''}>
                    {e.status === 'pending' && e.last_error ? `${shortDate(e.next_attempt_at)} 重试 · ` : ''}
                    {e.last_error ?? ''}
                  </td>
                  <td>
                    {e.status === 'failed' || e.status === 'skipped' ? (
                      <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => retry(e)}>
                        重发
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <Pager page={page} onPage={setPage} hasMore={rows.length === PAGE_SIZE} />
    </AdminPage>
  )
}
