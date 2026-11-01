import { expect, test } from '@playwright/test'
import { site } from '#/config/site'
import { buyPackage, clawbackCredits, credits, devLogin, durationCredits, json, ledger, pkg, post, uniqueEmail, uploadPhoto } from './helpers'

const STARTER = pkg('starter').credits
const PARTY = pkg('party')

type Result = { status: 'processed' | 'duplicate' | 'ignored' | 'orphan' | 'mismatch'; note?: string }
type HealthCheck = { stats: { paymentReview: { count: number; latest: string | null } }; alerts: Array<{ kind: string; count: number }> }

test('并发、重放、退款后迟到的支付事件：积分只入账一次、只回收一次', async ({ request }) => {
  await devLogin(request, uniqueEmail('idem'))
  const { orderId } = await json<{ orderId: string }>(post(request, '/api/checkout', { packageId: 'party', locale: 'en' }))
  // 事件 id 在 provider 内全局唯一（与真实支付商一致），按订单加前缀，避免多次运行之间互相命中
  const complete = (outcome: string, eventId: string) =>
    json<Result>(post(request, '/api/mock-payments/complete', { orderId, outcome, eventId: `${orderId}_${eventId}` }))

  // 支付商重试：5 个不同 event id 的 paid 事件同时到达
  const results = await Promise.all([0, 1, 2, 3, 4].map((i) => complete('paid', `evt_paid_${i}`)))
  expect(results.filter((r) => r.status === 'processed')).toHaveLength(1)
  expect(await credits(request)).toBe(PARTY.credits)

  // 同一事件原样重放
  expect((await complete('paid', 'evt_paid_0')).status).toBe('duplicate')

  expect((await complete('refunded', 'evt_refund_1')).status).toBe('processed')
  expect(await credits(request)).toBe(0)
  expect((await complete('refunded', 'evt_refund_2')).status).toBe('duplicate')

  // 退款之后又来一条迟到的 paid：订单不能被“复活”
  expect((await complete('paid', 'evt_paid_late')).status).toBe('duplicate')
  expect(await credits(request)).toBe(0)

  const { order } = await json<{ order: { status: string } }>(request.get(`/api/orders/${orderId}`))
  expect(order.status).toBe('refunded')
  const entries = await ledger(request)
  expect(entries.map((e) => [e.reason, e.delta]).sort()).toEqual([
    ['order_refund', -PARTY.credits],
    ['purchase', PARTY.credits],
  ])
})

test('退款事件先于付款事件到达：先拒收等支付商重试，付款入账后重试的退款照常回收积分', async ({ request }) => {
  await devLogin(request, uniqueEmail('ooo'))
  const { orderId } = await json<{ orderId: string }>(post(request, '/api/checkout', { packageId: 'party', locale: 'en' }))
  const refund = () => post(request, '/api/mock-payments/complete', { orderId, outcome: 'refunded', eventId: `${orderId}_refund` })

  expect((await refund()).status()).toBe(500)
  expect((await json<{ order: { status: string } }>(request.get(`/api/orders/${orderId}`))).order.status).toBe('pending')

  await json(post(request, '/api/mock-payments/complete', { orderId, outcome: 'paid', eventId: `${orderId}_paid` }))
  expect(await credits(request)).toBe(PARTY.credits)
  // 支付商用同一个事件 id 重试：失败过的事件允许重新处理
  expect((await json<Result>(refund())).status).toBe('processed')
  expect(await credits(request)).toBe(0)
  expect((await json<{ order: { status: string } }>(request.get(`/api/orders/${orderId}`))).order.status).toBe('refunded')
})

test('付款金额或套餐与订单不符、找不到订单：不入账、告警，退款后结案', async ({ request }, testInfo) => {
  const since = new Date().toISOString()
  await devLogin(request, uniqueEmail('mismatch'))
  const checkout = async () => (await json<{ orderId: string }>(post(request, '/api/checkout', { packageId: 'starter', locale: 'en' }))).orderId
  const complete = (orderId: string, extra: Record<string, unknown>, tag: string) =>
    json<Result>(post(request, '/api/mock-payments/complete', { orderId, outcome: 'paid', eventId: `${orderId}_${tag}`, ...extra }))
  const orderStatus = async (orderId: string) => (await json<{ order: { status: string } }>(request.get(`/api/orders/${orderId}`))).order.status

  // 同币种少付、套餐不符：订单保持 pending，积分不变；同一事件重放不会再次处理
  const underpaid = await checkout()
  const short = await complete(underpaid, { paidAmountCents: 1 }, 'short')
  expect(short).toMatchObject({ status: 'mismatch' })
  expect(short.note).toContain('paid 1 <')
  expect((await complete(underpaid, { paidAmountCents: 1 }, 'short')).status).toBe('duplicate')
  const wrongPackage = await checkout()
  expect((await complete(wrongPackage, { packageId: 'party' }, 'pkg')).status).toBe('mismatch')
  expect(await credits(request)).toBe(0)
  expect(await orderStatus(underpaid)).toBe('pending')

  // 换币种（Adaptive Currency）或用了折扣码时金额不可比，照常入账
  const discounted = await checkout()
  expect((await complete(discounted, { paidAmountCents: 500, discounted: true }, 'dsc')).status).toBe('processed')
  const localCurrency = await checkout()
  expect((await complete(localCurrency, { paidAmountCents: 150000, paidCurrency: 'JPY' }, 'jpy')).status).toBe('processed')
  expect(await credits(request)).toBe(STARTER * 2)

  // 找不到订单：本站（或没带 site）记 orphan；共用商户号的其他站点的事件直接忽略
  const anyOrder = await checkout()
  expect((await complete(anyOrder, { orphan: true }, 'orphan')).status).toBe('orphan')
  expect((await complete(anyOrder, { orphan: true, site: 'other-site.example' }, 'other')).status).toBe('ignored')

  const first = await json<HealthCheck>(post(request, '/api/dev/health-check', { since }))
  expect(first.stats.paymentReview.count).toBe(3)
  expect(first.alerts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'payment_review', count: 3 })]))

  // 站长在支付商后台退款：没入账的订单直接结案为 refunded，不动积分，不再计入告警
  expect((await json<Result>(post(request, '/api/mock-payments/complete', { orderId: underpaid, outcome: 'refunded' }))).status).toBe('processed')
  expect(await orderStatus(underpaid)).toBe('refunded')
  expect(await credits(request)).toBe(STARTER * 2)
  const second = await json<HealthCheck>(post(request, '/api/dev/health-check', { since }))
  expect(second.stats.paymentReview.count).toBe(2)

  // 后台能按状态筛出待核对事件
  await devLogin(request, 'admin@example.com')
  const { events } = await json<{ events: Array<{ order_id: string | null; status: string; error: string | null }> }>(
    request.get('/api/admin/payment-events?status=mismatch'),
  )
  expect(events.find((e) => e.order_id === wrongPackage)).toMatchObject({ status: 'mismatch', error: 'package party is not starter' })

  await testInfo.attach('payment-review', { body: JSON.stringify({ first, second }, null, 2), contentType: 'application/json' })
})

test('积分已部分消费后退款：最多扣到 0，流水记录实际扣除量', async ({ request }) => {
  const short = durationCredits('short')
  test.skip(STARTER <= short, `starter(${STARTER}) 扣完 short(${short}) 后没有剩余，无法构造“部分消费”`)
  await devLogin(request, uniqueEmail('clawback'))
  const orderId = await buyPackage(request, 'starter')
  const { upload } = await json<{ upload: { id: string } }>(uploadPhoto(request), 201)
  await json(post(request, '/api/generations', { consent: true, uploadId: upload.id, durationId: 'short' }), 201)
  expect(await credits(request)).toBe(STARTER - short)

  await json(post(request, '/api/mock-payments/complete', { orderId, outcome: 'refunded' }))
  expect(await credits(request)).toBe(0)
  const refund = (await ledger(request)).find((e) => e.reason === 'order_refund')
  expect(refund?.delta).toBe(-(STARTER - short))
})

test('两次部分退款：按金额比例回收积分，重放幂等，累计退满后订单转 refunded', async ({ page }) => {
  await devLogin(page.request, uniqueEmail('partial'))
  const orderId = await buyPackage(page.request, 'party')
  const firstCents = Math.min(500, PARTY.priceCents - 1)
  const first = clawbackCredits(PARTY, firstCents)
  const refund = (eventId: string, amountCents: number) =>
    json<Result>(post(page.request, '/api/mock-payments/complete', { orderId, outcome: 'refunded', eventId: `${orderId}_${eventId}`, amountCents }))

  expect((await refund('rf_1', firstCents)).status).toBe('processed')
  expect(await credits(page.request)).toBe(PARTY.credits - first) // 按金额比例回收，公式同服务端 planRefund
  expect((await refund('rf_1', firstCents)).status).toBe('duplicate')
  expect(await credits(page.request)).toBe(PARTY.credits - first)

  type OrderView = { status: string; refundedAmountCents: number; refundedCredits: number }
  let { order } = await json<{ order: OrderView }>(page.request.get(`/api/orders/${orderId}`))
  expect(order).toMatchObject({ status: 'paid', refundedAmountCents: firstCents, refundedCredits: first })
  await page.goto('/dashboard/billing')
  await expect(page.getByTestId('orders-table')).toContainText('Partially refunded')

  // 第二笔退款超过剩余金额：按全额处理，只回收剩余积分
  expect((await refund('rf_2', PARTY.priceCents * 2)).status).toBe('processed')
  expect(await credits(page.request)).toBe(0)
  ;({ order } = await json<{ order: OrderView }>(page.request.get(`/api/orders/${orderId}`)))
  expect(order).toMatchObject({ status: 'refunded', refundedAmountCents: PARTY.priceCents, refundedCredits: PARTY.credits })
  expect((await refund('rf_3', 100)).status).toBe('duplicate')

  const refunds = (await ledger(page.request)).filter((e) => e.reason === 'order_refund').map((e) => e.delta)
  expect(refunds.sort((a, b) => a - b)).toEqual([-first, -(PARTY.credits - first)].sort((a, b) => a - b))
})

test('支付争议：opened 回收积分、重复投递不重复回收，won 补回；另一单 lost 记为全额退款，后台详情显示争议', async ({ page }) => {
  await devLogin(page.request, uniqueEmail('dispute'))
  const orderId = await buyPackage(page.request, 'party')
  const dispute = (outcome: string, eventId: string, extra: Record<string, unknown> = {}) =>
    json<Result & { credits?: number }>(post(page.request, '/api/mock-payments/complete', { orderId, outcome, eventId: `${orderId}_${eventId}`, ...extra }))
  type OrderView = { status: string; refundedCredits: number }
  const view = async () => (await json<{ order: OrderView }>(page.request.get(`/api/orders/${orderId}`))).order

  expect(await dispute('dispute_opened', 'dp_open')).toMatchObject({ status: 'processed', credits: PARTY.credits })
  expect(await credits(page.request)).toBe(0)
  // 同一事件重放、同一争议的新事件：不重复回收
  expect((await dispute('dispute_opened', 'dp_open')).status).toBe('duplicate')
  expect((await dispute('dispute_opened', 'dp_open_again')).status).toBe('duplicate')
  expect(await view()).toMatchObject({ status: 'paid', refundedCredits: PARTY.credits })

  expect(await dispute('dispute_won', 'dp_won')).toMatchObject({ status: 'processed', credits: PARTY.credits })
  expect(await credits(page.request)).toBe(PARTY.credits)
  expect((await dispute('dispute_won', 'dp_won_again')).status).toBe('duplicate')
  expect(await credits(page.request)).toBe(PARTY.credits)
  expect(await view()).toMatchObject({ status: 'paid', refundedCredits: 0 })
  expect((await ledger(page.request)).map((e) => [e.reason, e.delta]).sort()).toEqual(
    [
      ['dispute', -PARTY.credits],
      ['dispute_won', PARTY.credits],
      ['purchase', PARTY.credits],
    ].sort(),
  )

  // 另一单败诉：积分在 opened 时已回收，lost 只把订单记为全额退款
  const lostOrder = await buyPackage(page.request, 'starter')
  const lost = (outcome: string, eventId: string) =>
    json<Result>(post(page.request, '/api/mock-payments/complete', { orderId: lostOrder, outcome, eventId: `${lostOrder}_${eventId}`, disputeId: `dp_${lostOrder}` }))
  expect((await lost('dispute_opened', 'o')).status).toBe('processed')
  expect((await lost('dispute_lost', 'l')).status).toBe('processed')
  expect((await lost('dispute_lost', 'l')).status).toBe('duplicate')
  expect(await credits(page.request)).toBe(PARTY.credits)
  const { order } = await json<{ order: OrderView }>(page.request.get(`/api/orders/${lostOrder}`))
  expect(order).toMatchObject({ status: 'refunded', refundedCredits: STARTER })

  // 后台订单详情显示争议状态
  await devLogin(page.request, 'admin@example.com')
  await page.goto(`/admin/orders/${lostOrder}`)
  await expect(page.getByTestId('admin-order-dispute')).toContainText('争议败诉')
})

test('欺诈预警（fraudWarningAutoRefund 默认关闭）：不退款，订单与余额不变，管理员收到“未自动退款”的通知', async ({ page }) => {
  test.skip(site.fraudWarningAutoRefund, '站点开启了欺诈预警自动退款')
  await devLogin(page.request, uniqueEmail('fraud'))
  const orderId = await buyPackage(page.request, 'party')
  const warn = (eventId: string) =>
    json<Result>(post(page.request, '/api/mock-payments/complete', { orderId, outcome: 'fraud_warning', eventId: `${orderId}_${eventId}` }))

  const first = await warn('efw')
  expect(first.status).toBe('processed')
  expect(first.note).toContain('未自动退款')
  expect((await warn('efw')).status).toBe('duplicate')
  expect(await credits(page.request)).toBe(PARTY.credits)
  const { order } = await json<{ order: { status: string; refundedAmountCents: number; refundedCredits: number } }>(page.request.get(`/api/orders/${orderId}`))
  expect(order).toMatchObject({ status: 'paid', refundedAmountCents: 0, refundedCredits: 0 })

  const alerts = async () => {
    const { emails } = await json<{ emails: Array<{ template: string; params: { orderId: string; stage: string; detail: string | null } }> }>(
      page.request.get(`/api/dev/emails?${new URLSearchParams({ to: 'admin@example.com', ref: 'admin_dispute:fraud_warning' })}`),
    )
    return emails.filter((e) => e.params.orderId === orderId)
  }
  await expect.poll(async () => (await alerts()).length, { timeout: 10_000 }).toBe(1)
  expect((await alerts())[0]!.params).toMatchObject({ stage: 'fraud_warning', detail: expect.stringContaining('未自动退款') })
})

test('支付失败：结果页显示失败，订单 failed，余额不变', async ({ page }) => {
  await devLogin(page.request, uniqueEmail('fail'))
  await page.goto('/pricing')
  await page.getByTestId('buy-starter').click()
  await page.getByTestId('mock-fail').click()
  await expect(page.getByTestId('checkout-result')).toHaveAttribute('data-status', 'failed')
  expect(await credits(page.request)).toBe(0)
})

test('未登录回到结果页：提示登录，不无限转圈；支付商回跳带的邮箱在渲染前就被 302 去掉', async ({ page }) => {
  // 服务端先 302（页面、统计和浏览器历史都拿不到邮箱）；带语言前缀的结果页同样处理
  for (const [from, to] of [
    ['/checkout/success?email=buyer%40example.com&order=ord_signed_out&status=succeeded', '/checkout/success?order=ord_signed_out'],
    ['/zh/checkout/success?order=ord_a%26b&email=buyer%40example.com', '/zh/checkout/success?order=ord_a%26b'],
  ]) {
    const res = await page.request.get(from!, { maxRedirects: 0 })
    expect(res.status()).toBe(302)
    expect(res.headers()['location']).toBe(to)
    expect(res.headers()['referrer-policy']).toBe('no-referrer')
  }
  await page.goto('/checkout/success?order=ord_signed_out&email=buyer%40example.com&status=succeeded')
  await expect(page.getByTestId('checkout-result')).toContainText('Please sign in to continue.')
  await expect(page).toHaveURL(/\/checkout\/success\?order=ord_signed_out$/)
})

test('未带同源 Origin 的写请求被 CSRF 校验拒绝', async ({ request }) => {
  const response = await request.post('/api/auth/dev-login', { data: { email: uniqueEmail('csrf') } })
  expect(response.status()).toBe(403)
  const cross = await request.post('/api/auth/dev-login', { data: { email: uniqueEmail('csrf') }, headers: { origin: 'https://evil.example' } })
  expect(cross.status()).toBe(403)
})
