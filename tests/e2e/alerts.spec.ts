import { expect, test, type APIRequestContext } from '@playwright/test'
import { buyPackage, credits, devLogin, durationCredits, json, post, uniqueEmail, uploadPhoto } from './helpers'

// 健康检查与死信：真实死信要主队列重试 10 次（约 35 分钟），这里用 /api/dev/dead-letter 模拟死信消费者收到消息；
// 健康检查用 since 把统计窗口限定在本用例开始之后，不受之前运行留下的失败任务影响
const ADMIN_EMAIL = 'admin@example.com'

type HealthCheck = {
  stats: { generations: { finished: number; failed: number; topErrors: string | null }; deadLetters: number }
  alerts: Array<{ kind: string; count: number }>
  bucket: string
}

async function generate(request: APIRequestContext, mockOutcome: 'fail' | 'hang') {
  const { upload } = await json<{ upload: { id: string } }>(uploadPhoto(request), 201)
  return (await json<{ generation: { id: string } }>(post(request, '/api/generations', { consent: true, uploadId: upload.id, durationId: 'short', mockOutcome }), 201))
    .generation.id
}

async function status(request: APIRequestContext, id: string) {
  return (await json<{ generation: { status: string } }>(request.get(`/api/generations/${id}`))).generation.status
}

async function alertEmails(request: APIRequestContext, ref: string) {
  const { emails } = await json<{ emails: Array<{ template: string; to_email: string; locale: string; subject: string | null }> }>(
    request.get(`/api/dev/emails?${new URLSearchParams({ to: ADMIN_EMAIL, ref })}`),
  )
  return emails
}

test('死信：任务判失败并只退一次积分；健康检查告警，同一时间桶重复执行不重发', async ({ request }, testInfo) => {
  const since = new Date().toISOString()
  await devLogin(request, uniqueEmail('alert'))
  await buyPackage(request, 'starter')
  const before = await credits(request)

  // 服务商一直不完成，队列消息最终进入死信队列：任务判失败、退积分
  const stuck = await generate(request, 'hang')
  expect(await credits(request)).toBe(before - durationCredits('short'))
  await expect.poll(() => status(request, stuck), { timeout: 30_000, intervals: [500] }).toBe('processing')
  expect(await json(post(request, '/api/dev/dead-letter', { generationId: stuck }))).toEqual({ failed: true })
  expect(await status(request, stuck)).toBe('failed')
  expect(await credits(request)).toBe(before)

  // 死信消费者重试同一条消息（或轮询与死信并发）：不会二次退款
  expect(await json(post(request, '/api/dev/dead-letter', { generationId: stuck }))).toEqual({ failed: false })
  expect(await credits(request)).toBe(before)

  // 再失败 2 个：本窗口内 3/3 失败，触发失败率告警
  const failing = [await generate(request, 'fail'), await generate(request, 'fail')]
  for (const id of failing) {
    await expect.poll(() => status(request, id), { timeout: 60_000, intervals: [1000] }).toBe('failed')
  }
  expect(await credits(request)).toBe(before)

  const first = await json<HealthCheck>(post(request, '/api/dev/health-check', { since }))
  expect(first.stats.generations.failed).toBeGreaterThanOrEqual(3)
  expect(first.stats.generations.topErrors).toContain('mock_failure')
  expect(first.stats.deadLetters).toBeGreaterThanOrEqual(1)
  expect(first.alerts.map((a) => a.kind)).toEqual(expect.arrayContaining(['generation_failures', 'dead_letter']))

  const ref = `admin_alert:dead_letter:${first.bucket}`
  const sent = await alertEmails(request, ref)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ template: 'admin_alert', locale: 'zh' })
  expect(sent[0].subject).toContain('死信')
  expect(await alertEmails(request, `admin_alert:generation_failures:${first.bucket}`)).toHaveLength(1)

  // Cron 每 5 分钟跑一次：同一时间桶内问题仍在，也不重复发信
  const second = await json<HealthCheck>(post(request, '/api/dev/health-check', { since }))
  expect(second.bucket).toBe(first.bucket)
  expect(second.alerts.map((a) => a.kind)).toEqual(expect.arrayContaining(['dead_letter']))
  expect(await alertEmails(request, ref)).toHaveLength(1)

  // since 格式错误直接拒绝；不能对别人的（或不存在的）任务模拟死信
  expect((await json<{ error: string }>(post(request, '/api/dev/health-check', { since: 'yesterday' }), 400)).error).toBe('invalid_since')
  expect((await json<{ error: string }>(post(request, '/api/dev/dead-letter', { generationId: 'gen_missing' }), 404)).error).toBe('not_found')

  await testInfo.attach('health-check', { body: JSON.stringify({ first, second, sent }, null, 2), contentType: 'application/json' })
})
