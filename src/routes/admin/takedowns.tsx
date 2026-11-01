import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { AdminPage, FilterSelect, LoadState, PAGE_SIZE, Pager, Status, adminAction, promptNote, shortDate, useAdminData } from '#/components/admin'

export const Route = createFileRoute('/admin/takedowns')({
  component: AdminTakedowns,
})

type TakedownRow = {
  id: string
  reporter_name: string
  reporter_email: string
  reporter_user_id: string | null
  content_ref: string
  generation_id: string | null
  reason: string
  details: string | null
  is_depicted: number
  signature: string | null
  status: 'open' | 'removed' | 'rejected'
  due_at: string
  resolved_at: string | null
  resolution_note: string | null
  created_at: string
  generation_status: string | null
  generation_removed_at: string | null
  has_output: number | null
  owner_email: string | null
}

const REASONS: Record<string, string> = {
  intimate: '未经同意的私密内容',
  impersonation: '冒充 / 欺骗性深伪',
  minor: '涉及未成年人',
  copyright: '版权 / 商标',
  other: '其他',
}

// 举报处理：open 按截止时间升序。下架会删除同一原图的所有成片与原图，并拉黑该图片哈希
function AdminTakedowns() {
  const [status, setStatus] = useState<'open' | 'removed' | 'rejected'>('open')
  const [page, setPage] = useState(1)
  const { data, error, loading, reload } = useAdminData<{ takedowns: TakedownRow[] }>(`/api/admin/takedowns?status=${status}&page=${page}`)
  const rows = data?.takedowns ?? []
  const now = Date.now()

  async function remove(t: TakedownRow) {
    const generationId = prompt('要下架的生成任务 ID（gen_…）', t.generation_id ?? '')?.trim()
    if (!generationId) return
    const note = prompt('处理备注（可选）')?.trim() ?? ''
    const ok = await adminAction(
      `/api/admin/takedowns/${t.id}/resolve`,
      { action: 'remove', generationId, note },
      '确认下架？同一原图生成的所有视频和原图都会被删除，且无法恢复。',
    )
    if (ok) await reload()
  }

  async function reject(t: TakedownRow) {
    const note = promptNote('驳回原因（必填，会记录在审计日志）')
    if (!note) return
    if (await adminAction(`/api/admin/takedowns/${t.id}/resolve`, { action: 'reject', note })) await reload()
  }

  return (
    <AdminPage title="举报下架">
      <FilterSelect
        label="状态"
        value={status}
        onChange={(v) => {
          setStatus(v as 'open' | 'removed' | 'rejected')
          setPage(1)
        }}
        options={[
          ['open', '待处理'],
          ['removed', '已下架'],
          ['rejected', '已驳回'],
        ]}
      />
      <LoadState loading={loading && !data} error={error} empty={!!data && !rows.length} />
      <div className="space-y-3" data-testid="admin-takedowns">
        {rows.map((t) => {
          const overdue = t.status === 'open' && Date.parse(t.due_at) < now
          return (
            <div key={t.id} className="card space-y-3 p-5" data-testid="takedown-item" data-id={t.id}>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="chip">{REASONS[t.reason] ?? t.reason}</span>
                  <Status value={t.status} />
                  <span className="font-medium">{t.reporter_name}</span>
                  <a href={`mailto:${t.reporter_email}`} className="text-muted hover:underline">
                    {t.reporter_email}
                  </a>
                  {t.is_depicted ? <span className="text-xs text-muted">本人或授权代理</span> : null}
                </div>
                <div className="text-xs text-muted">
                  提交 {shortDate(t.created_at)} ·{' '}
                  <span className={overdue ? 'font-semibold text-red-600' : ''}>截止 {shortDate(t.due_at)}{overdue ? '（已超时）' : ''}</span>
                </div>
              </div>
              <p className="text-sm break-all">
                <span className="text-muted">内容：</span>
                {t.content_ref}
              </p>
              <p className="text-sm break-all" data-testid="takedown-signature">
                <span className="text-muted">电子签名：</span>
                {t.signature ?? '（无）'}
              </p>
              {t.details ? <p className="whitespace-pre-wrap text-sm leading-6">{t.details}</p> : null}
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
                {t.generation_id ? (
                  <>
                    <span className="font-mono">{t.generation_id}</span>
                    {t.owner_email ? <span>所属用户 {t.owner_email}</span> : <span>未找到该任务</span>}
                    {t.generation_status ? <Status value={t.generation_removed_at ? 'removed' : t.generation_status} /> : null}
                    {t.has_output ? (
                      <a href={`/api/admin/generations/${t.generation_id}/video`} target="_blank" rel="noreferrer" className="underline">
                        预览成片
                      </a>
                    ) : null}
                  </>
                ) : (
                  <span>未识别到任务 ID，需要人工定位</span>
                )}
              </div>
              {t.status === 'open' ? (
                <div className="flex gap-2">
                  <button type="button" className="btn-primary px-3 py-1.5 text-xs" onClick={() => remove(t)}>
                    下架内容
                  </button>
                  <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => reject(t)}>
                    驳回
                  </button>
                </div>
              ) : (
                <p className="text-xs text-muted">
                  {shortDate(t.resolved_at)} 处理{t.resolution_note ? `：${t.resolution_note}` : ''}
                </p>
              )}
            </div>
          )
        })}
      </div>
      <Pager page={page} onPage={setPage} hasMore={rows.length === PAGE_SIZE} />
    </AdminPage>
  )
}
