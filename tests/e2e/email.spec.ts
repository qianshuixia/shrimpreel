import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { formatPrice } from '#/config/site'
import { ORIGIN, PHOTO, buyPackage, devLogin, durationCredits, json, pkg, post, uniqueEmail, uploadPhoto } from './helpers'

// 本地 send_email binding 只模拟发送，不会真的发出；断言以发件箱（/api/dev/emails）为准
const ADMIN_EMAIL = 'admin@example.com'

type Email = {
  dedupe_key: string
  template: string
  to_email: string
  user_id: string | null
  locale: string
  params: Record<string, unknown>
  subject: string | null
  status: string
  attempts: number
  provider_message_id: string | null
}

async function outbox(request: APIRequestContext, filter: { to?: string; ref?: string }) {
  return (await json<{ emails: Email[] }>(request.get(`/api/dev/emails?${new URLSearchParams(filter)}`))).emails
}

async function generation(request: APIRequestContext, id: string) {
  return (await json<{ generation: { status: string } }>(request.get(`/api/generations/${id}`))).generation
}

async function generate(request: APIRequestContext, body: Record<string, unknown>) {
  const { upload } = await json<{ upload: { id: string } }>(uploadPhoto(request), 201)
  return (await json<{ generation: { id: string } }>(post(request, '/api/generations', { consent: true, uploadId: upload.id, durationId: 'short', ...body }), 201))
    .generation.id
}

async function reminders(request: APIRequestContext, takedownId: string, hours: number) {
  return (await json<{ reminded: number }>(post(request, '/api/dev/takedown-reminders', { takedownId, hours }))).reminded
}

test('支付邮件：同一事件重放、换事件 ID 重复回调都只发一封，用下单时的语言', async ({ request }) => {
  const email = uniqueEmail('mail-order')
  await devLogin(request, email)
  const { orderId } = await json<{ orderId: string }>(post(request, '/api/checkout', { packageId: 'starter', locale: 'zh' }))
  for (const eventId of [`evt_${orderId}`, `evt_${orderId}`, `evt_${orderId}_dup`]) {
    await json(post(request, '/api/mock-payments/complete', { orderId, outcome: 'paid', eventId }))
  }

  const emails = await outbox(request, { to: email })
  expect(emails.map((e) => e.dedupe_key)).toEqual([`order_paid:${orderId}`])
  expect(emails[0]).toMatchObject({
    template: 'order_paid',
    locale: 'zh',
    status: 'sent',
    attempts: 1,
    params: { orderId, credits: pkg('starter').credits, amount: formatPrice(pkg('starter').priceCents, pkg('starter').currency) },
  })
  expect(emails[0].subject).toContain(`${pkg('starter').credits} 个积分已到账`)
  expect(emails[0].provider_message_id).toBeTruthy()
})

test('生成邮件：成功、失败退积分各一封，跟随用户最近使用的语言；重复标记失败不重发', async ({ request, browser }) => {
  const email = uniqueEmail('mail-gen')
  const user = await devLogin(request, email)
  await buyPackage(request, 'starter')
  const ok = await generate(request, { locale: 'zh' })
  const bad = await generate(request, { locale: 'zh', mockOutcome: 'fail' })
  for (const [id, status] of [
    [ok, 'succeeded'],
    [bad, 'failed'],
  ]) {
    await expect.poll(async () => (await generation(request, id)).status, { timeout: 60_000, intervals: [1000] }).toBe(status)
  }

  // 已失败的任务再被管理员标记失败：不会二次退款，也不会二次发信
  const admin = await browser.newContext({ baseURL: ORIGIN })
  try {
    await devLogin(admin.request, ADMIN_EMAIL)
    await json(post(admin.request, `/api/admin/generations/${bad}/fail`, {}))
  } finally {
    await admin.close()
  }

  await expect
    .poll(async () => (await outbox(request, { to: email })).map((e) => e.dedupe_key).sort(), { timeout: 10_000 })
    .toEqual([`generation_failed:${bad}`, `generation_succeeded:${ok}`, expect.stringMatching(/^order_paid:/)])
  const byTemplate = Object.fromEntries((await outbox(request, { to: email })).map((e) => [e.template, e]))
  // 下单时是英文，之后在中文页面生成：每封邮件用发信当时的语言
  expect(byTemplate.order_paid).toMatchObject({ locale: 'en', status: 'sent' })
  expect(byTemplate.generation_succeeded).toMatchObject({ locale: 'zh', status: 'sent', user_id: user.id })
  expect(byTemplate.generation_succeeded.params.expiresAt).toEqual(expect.any(String))
  expect(byTemplate.generation_failed).toMatchObject({ locale: 'zh', status: 'sent', params: { generationId: bad, credits: durationCredits('short') } })
  expect(byTemplate.generation_failed.subject).toContain('积分已退回')
})

test('举报邮件：未登录举报不发回执，只提醒管理员；临近截止、超时各提醒一次；下架后通知举报人和作者，不再提醒；登录用户填本人邮箱才收回执', async ({ page, browser }, testInfo) => {
  const shot = async (name: string) => testInfo.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })

  // 被举报的作者（独一份的图片，避免下架时拉黑共用 fixture）
  const ownerEmail = uniqueEmail('mail-owner')
  const owner = await devLogin(page.request, ownerEmail)
  await buyPackage(page.request, 'starter')
  const { upload } = await json<{ upload: { id: string } }>(
    uploadPhoto(page.request, Buffer.concat([readFileSync(PHOTO), randomBytes(16)]) as Buffer<ArrayBuffer>),
    201,
  )
  const genId = (await json<{ generation: { id: string } }>(post(page.request, '/api/generations', { consent: true, uploadId: upload.id, durationId: 'short' }), 201))
    .generation.id
  await expect.poll(async () => (await generation(page.request, genId)).status, { timeout: 60_000, intervals: [1000] }).toBe('succeeded')

  const reporterEmail = uniqueEmail('mail-reporter')
  const anon = await browser.newContext({ baseURL: ORIGIN })
  const adminContext = await browser.newContext({ baseURL: ORIGIN })
  try {
    const { report } = await json<{ report: { id: string; dueAt: string } }>(
      post(anon.request, '/api/takedowns', {
        name: 'Mail Reporter',
        email: reporterEmail,
        contentRef: `video ${genId}`,
        reason: 'impersonation',
        attest: true, signature: 'Test Signature',
        locale: 'zh',
      }),
      201,
    )
    // 同一批写入的 created_at 相同，排序后比较。填写的邮箱没人验证过，未登录举报不发回执（防止借表单给任意地址发信）
    const keys = async () => (await outbox(anon.request, { ref: report.id })).map((e) => e.dedupe_key).sort()
    expect(await keys()).toEqual([`admin_takedown:${report.id}:new:${ADMIN_EMAIL}`])
    expect(await outbox(anon.request, { to: reporterEmail })).toEqual([])

    // SLA 48 小时、截止前 12 小时提醒：现在不提醒；+37h 临近截止；+49h 已超时；同一阶段重复跑 Cron 不重发
    expect(await reminders(anon.request, report.id, 0)).toBe(0)
    expect(await reminders(anon.request, report.id, 37)).toBe(1)
    expect(await reminders(anon.request, report.id, 37)).toBe(0)
    expect(await reminders(anon.request, report.id, 49)).toBe(1)
    expect(await reminders(anon.request, report.id, 49)).toBe(0)
    const alerts = await outbox(anon.request, { to: ADMIN_EMAIL, ref: report.id })
    expect(alerts.map((e) => e.params.stage)).toEqual(['new', 'due_soon', 'overdue'])
    expect(alerts.every((e) => e.locale === 'zh' && e.status === 'sent')).toBe(true)
    expect(alerts[2].subject).toContain('举报已超时')

    // 管理员下架：举报人收处理结果，作者收内容删除通知；审计里不记作者列表
    const admin = await adminContext.newPage()
    await devLogin(admin.request, ADMIN_EMAIL)
    await json(post(admin.request, `/api/admin/takedowns/${report.id}/resolve`, { action: 'remove', note: 'e2e: email flow' }))
    expect(await reminders(anon.request, report.id, 72)).toBe(0)
    expect(await keys()).toEqual([
      `admin_takedown:${report.id}:due_soon:${ADMIN_EMAIL}`,
      `admin_takedown:${report.id}:new:${ADMIN_EMAIL}`,
      `admin_takedown:${report.id}:overdue:${ADMIN_EMAIL}`,
      `content_removed:${report.id}:${owner.id}`,
      `takedown_resolved:${report.id}`,
    ])
    const [removed] = await outbox(anon.request, { to: ownerEmail, ref: report.id })
    expect(removed).toMatchObject({ template: 'content_removed', locale: 'en', status: 'sent', params: { reportId: report.id, videos: 1 } })
    const resolved = (await outbox(anon.request, { to: reporterEmail })).find((e) => e.template === 'takedown_resolved')
    expect(resolved).toMatchObject({ locale: 'zh', params: { outcome: 'removed' } })
    const { entries } = await json<{ entries: Array<{ target_id: string; detail: string }> }>(admin.request.get('/api/admin/audit'))
    expect(JSON.parse(entries.find((e) => e.target_id === report.id)!.detail)).not.toHaveProperty('owners')

    // 后台邮件页：按举报编号搜索；已发送的邮件不能重发
    const stats = await json<{ failedEmails: number }>(admin.request.get('/api/admin/stats'))
    expect(stats.failedEmails).toEqual(expect.any(Number))
    await admin.goto('/admin/emails')
    const rows = admin.getByTestId('admin-email-row')
    // 列表由客户端加载：出现即已水合，此前点搜索会走原生表单提交
    await expect(rows.first()).toBeVisible()
    await admin.getByPlaceholder('收件人 / 订单号 / 举报编号').fill(report.id)
    await admin.getByRole('button', { name: '搜索' }).click()
    await expect(rows).toHaveCount(5)
    await expect(admin.locator(`[data-testid="admin-email-row"][data-key="content_removed:${report.id}:${owner.id}"]`)).toContainText('已发送')
    await expect(rows.getByRole('button', { name: '重发' })).toHaveCount(0)
    await expect(admin.getByTestId('email-not-configured')).toHaveCount(0)
    const { emails } = await json<{ emails: Array<{ id: string }> }>(admin.request.get(`/api/admin/emails?q=${report.id}`))
    expect((await json<{ error: string }>(post(admin.request, `/api/admin/emails/${emails[0].id}/retry`, {}), 409)).error).toBe('email_not_retryable')
    await testInfo.attach('admin-emails', { body: await admin.screenshot({ fullPage: true }), contentType: 'image/png' })

    // 登录用户：填本人账号邮箱（大小写不同也算）才收回执；填别人的邮箱不发
    const leftover: string[] = []
    const loggedIn = async (email: string) => {
      const { report: own } = await json<{ report: { id: string } }>(
        post(page.request, '/api/takedowns', {
          name: 'Signed-in Reporter',
          email,
          contentRef: 'https://example.com/some-video',
          reason: 'other',
          attest: true, signature: 'Test Signature',
          locale: 'en',
        }),
        201,
      )
      leftover.push(own.id)
      return (await outbox(anon.request, { ref: own.id })).map((e) => e.template).sort()
    }
    expect(await loggedIn(ownerEmail.toUpperCase())).toEqual(['admin_takedown', 'takedown_received'])
    expect(await loggedIn(uniqueEmail('someone-else'))).toEqual(['admin_takedown'])
    const [receipt] = (await outbox(anon.request, { to: ownerEmail })).filter((e) => e.template === 'takedown_received')
    expect(receipt).toMatchObject({ locale: 'en', status: 'sent', user_id: owner.id })
    // 驳回这两条举报：后台队列每页 50 条，未处理的越积越多会把其它用例的举报挤到第二页
    for (const id of leftover) await json(post(admin.request, `/api/admin/takedowns/${id}/resolve`, { action: 'reject', note: 'e2e: cleanup' }))
  } finally {
    await anon.close()
    await adminContext.close()
  }
  await page.goto('/dashboard')
  await shot('owner-dashboard')
})

test('留言只提醒管理员、不给留言人发信；注销账号清掉该用户的发件记录', async ({ request }) => {
  const visitor = uniqueEmail('mail-contact')
  const message = `Billing question ${visitor}: <b>please</b> check my order.`
  await json(post(request, '/api/contact', { email: visitor, topic: 'billing', message }), 201)
  const alert = (await outbox(request, { to: ADMIN_EMAIL, ref: 'admin_contact:' })).find((e) => e.params.email === visitor)
  expect(alert).toMatchObject({ template: 'admin_contact', locale: 'zh', status: 'sent', params: { topic: 'billing', message } })
  expect(alert!.subject).toContain('新留言：账单')
  expect(await outbox(request, { to: visitor })).toEqual([])

  const email = uniqueEmail('mail-delete')
  await devLogin(request, email)
  await buyPackage(request, 'starter')
  expect(await outbox(request, { to: email })).toHaveLength(1)
  await json(request.delete('/api/account', { headers: { origin: ORIGIN } }))
  expect(await outbox(request, { to: email })).toEqual([])
})
