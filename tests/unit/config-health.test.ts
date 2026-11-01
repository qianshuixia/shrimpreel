import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REQUIRED_BINDINGS, checkConfig, type ConfigInput } from '#/server/config-health'
import { sellingPlans, site } from '#/config/site'
import { configBindings, findSiteTodos, parsePendingMigrations, parseSecretNames, readWranglerConfig, runDoctor } from '../../scripts/doctor.mjs'

const SECRET = 'a'.repeat(64)

// 一份可以直接上线的配置：任何规则都不应报告
function ready(overrides: { vars?: Record<string, string>; secrets?: ConfigInput['secrets'] } = {}): ConfigInput {
  return {
    vars: {
      APP_ENV: 'production',
      SITE_URL: 'https://moonhop.ai',
      PAYMENT_PROVIDER: 'waffo',
      VIDEO_PROVIDER: 'fal',
      MODERATION_PROVIDER: 'openai',
      OUTPUT_MODERATION: 'frames',
      ADMIN_EMAILS: 'ops@moonhop.ai',
      EMAIL_FROM: 'noreply@mail.moonhop.ai',
      WAFFO_ENVIRONMENT: 'prod',
      WAFFO_PRODUCTS: '{"starter":"PROD_1","party":"PROD_2"}',
      GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
      TURNSTILE_SITE_KEY: '0x4AAA',
      ...overrides.vars,
    },
    secrets: {
      SESSION_SECRET: SECRET,
      GOOGLE_CLIENT_SECRET: 'g',
      WAFFO_MERCHANT_ID: 'm',
      WAFFO_PRIVATE_KEY: 'k',
      FAL_KEY: 'f',
      OPENAI_API_KEY: 'o',
      TURNSTILE_SECRET_KEY: 't',
      RESEND_API_KEY: 're_x',
      ...overrides.secrets,
    },
    bindings: [...REQUIRED_BINDINGS, 'MEDIA_TRANSFORM'],
    packageIds: ['starter', 'party'],
    siteDomain: 'moonhop.ai',
  }
}

const keys = (input: ConfigInput) => checkConfig(input).map((i) => `${i.level}:${i.key}`)

describe('checkConfig', () => {
  it('完整的生产配置没有任何报告；www 子域名和发信子域名算同一站点', () => {
    expect(checkConfig(ready())).toEqual([])
    expect(checkConfig(ready({ vars: { SITE_URL: 'https://www.moonhop.ai' } }))).toEqual([])
  })

  it('只要求所选服务商的密钥；运行时能看到值时拦截弱 SESSION_SECRET，doctor 只核对名字', () => {
    const dodo = ready({
      vars: { PAYMENT_PROVIDER: 'dodo', DODO_ENVIRONMENT: 'live', DODO_PRODUCTS: '{"starter":"p1","party":"p2"}' },
      secrets: { DODO_API_KEY: 'd' },
    })
    expect(checkConfig(dodo)).toEqual([expect.objectContaining({ level: 'error', key: 'DODO_WEBHOOK_SECRET' })])
    expect(keys(ready({ vars: { VIDEO_PROVIDER: 'yir' } }))).toEqual(['error:YIR_API_KEY'])
    expect(keys(ready({ vars: { VIDEO_PROVIDER: 'yir' }, secrets: { YIR_API_KEY: 'y' } }))).toEqual([])
    expect(keys(ready({ vars: { VIDEO_PROVIDER: 'nanoapi' } }))).toEqual(['error:NANOAPI_API_KEY'])
    expect(keys(ready({ secrets: { SESSION_SECRET: 'change-me-to-a-long-random-string' } }))).toEqual(['error:SESSION_SECRET'])
    expect(keys(ready({ secrets: { SESSION_SECRET: ' ' } }))).toEqual(['error:SESSION_SECRET'])
    expect(keys(ready({ secrets: { SESSION_SECRET: true } }))).toEqual([])
  })

  it('开发默认值：APP_ENV、本地地址、mock 服务商都报错', () => {
    const input = ready({
      vars: { APP_ENV: 'development', SITE_URL: 'http://localhost:3000', PAYMENT_PROVIDER: 'mock', VIDEO_PROVIDER: 'mock', MODERATION_PROVIDER: 'mock' },
    })
    expect(keys(input)).toEqual(['error:APP_ENV', 'error:SITE_URL', 'error:PAYMENT_PROVIDER', 'error:VIDEO_PROVIDER', 'error:MODERATION_PROVIDER'])
  })

  it('成片输出审核：frames 要有 MEDIA_TRANSFORM 绑定；off 在有输入审核时警告；mock 和未知值报错', () => {
    expect(checkConfig({ ...ready(), bindings: REQUIRED_BINDINGS })).toEqual([expect.objectContaining({ level: 'error', key: 'OUTPUT_MODERATION', message: expect.stringContaining('MEDIA_TRANSFORM') })])
    expect(keys(ready({ vars: { OUTPUT_MODERATION: 'off' } }))).toEqual(['warn:OUTPUT_MODERATION'])
    // 没配置等同 off（合并模板前的站点）
    expect(keys(ready({ vars: { OUTPUT_MODERATION: '' } }))).toEqual(['warn:OUTPUT_MODERATION'])
    // 输入审核本来就是 none 时，off 不再重复警告
    expect(keys(ready({ vars: { OUTPUT_MODERATION: 'off', MODERATION_PROVIDER: 'none' } }))).toEqual(['warn:MODERATION_PROVIDER'])
    expect(keys(ready({ vars: { MODERATION_PROVIDER: 'none' } }))).toEqual(['warn:MODERATION_PROVIDER', 'warn:OUTPUT_MODERATION'])
    expect(keys(ready({ vars: { OUTPUT_MODERATION: 'mock' } }))).toEqual(['error:OUTPUT_MODERATION'])
    expect(keys(ready({ vars: { OUTPUT_MODERATION: 'all' } }))).toEqual(['error:OUTPUT_MODERATION'])
  })

  it('商品映射缺包或不是 JSON 对象、生产仍用 test 店铺、预发用正式店铺', () => {
    expect(checkConfig(ready({ vars: { WAFFO_PRODUCTS: '{"starter":"PROD_1"}' } }))).toEqual([
      expect.objectContaining({ key: 'WAFFO_PRODUCTS', message: expect.stringContaining('party') }),
    ])
    expect(keys(ready({ vars: { WAFFO_PRODUCTS: '["PROD_1"]' } }))).toContain('error:WAFFO_PRODUCTS')
    expect(keys(ready({ vars: { WAFFO_PRODUCTS: '{oops' } }))).toContain('error:WAFFO_PRODUCTS')
    expect(keys(ready({ vars: { WAFFO_ENVIRONMENT: 'test' } }))).toEqual(['warn:WAFFO_ENVIRONMENT'])
    const staging = ready({ vars: { APP_ENV: 'staging', SITE_URL: 'https://shrimp-staging.dev-team.workers.dev' } })
    expect(keys(staging)).toEqual(['warn:WAFFO_ENVIRONMENT'])
  })

  it('开了订阅：订阅套餐也要有商品；Waffo 还要 WAFFO_STORE_ID（客户门户）', () => {
    const withPlans = { ...ready(), planIds: ['monthly', 'yearly'] }
    expect(checkConfig(withPlans)).toEqual([
      expect.objectContaining({ key: 'WAFFO_PRODUCTS', message: expect.stringContaining('monthly、yearly') }),
      expect.objectContaining({ key: 'WAFFO_STORE_ID' }),
    ])
    const complete = ready({ vars: { WAFFO_PRODUCTS: '{"starter":"PROD_1","party":"PROD_2","monthly":"PROD_3","yearly":"PROD_4"}', WAFFO_STORE_ID: 'STO_1' } })
    expect(checkConfig({ ...complete, planIds: ['monthly', 'yearly'] })).toEqual([])
    // Dodo 的客户门户不需要额外配置
    const dodo = ready({ vars: { PAYMENT_PROVIDER: 'dodo', DODO_ENVIRONMENT: 'live', DODO_PRODUCTS: '{"starter":"p1","party":"p2","monthly":"p3","yearly":"p4"}' }, secrets: { DODO_API_KEY: 'k', DODO_WEBHOOK_SECRET: 's' } })
    expect(keys({ ...dodo, planIds: ['monthly', 'yearly'] })).toEqual([])
  })

  it('Stripe：Key 的 test / live 模式要和 STRIPE_ENVIRONMENT 一致；doctor 只知道密钥名时不核对前缀', () => {
    const stripe = (environment: string, key: string | true) =>
      ready({
        vars: { PAYMENT_PROVIDER: 'stripe', STRIPE_ENVIRONMENT: environment, STRIPE_PRODUCTS: '{"starter":"price_1","party":"price_2"}' },
        secrets: { STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: 'whsec_1' },
      })
    expect(keys(stripe('live', 'sk_live_1'))).toEqual([])
    expect(keys(stripe('live', 'rk_live_1'))).toEqual([])
    expect(keys(stripe('live', true))).toEqual([])
    expect(keys(stripe('live', 'sk_test_1'))).toEqual(['error:STRIPE_SECRET_KEY'])
    expect(keys(stripe('test', 'sk_test_1'))).toEqual(['warn:STRIPE_ENVIRONMENT'])
    expect(keys(stripe('test', 'sk_live_1'))).toEqual(['error:STRIPE_SECRET_KEY', 'warn:STRIPE_ENVIRONMENT'])
    expect(keys(stripe('live', 'pk_live_1'))).toEqual(['error:STRIPE_SECRET_KEY'])
  })

  it('域名不一致、站点和邮箱仍是占位值、缺绑定', () => {
    expect(keys(ready({ vars: { SITE_URL: 'https://other.ai' } }))).toEqual(['error:SITE_URL'])
    expect(keys({ ...ready(), siteDomain: 'example.com', vars: { ...ready().vars, SITE_URL: 'https://moonhop.ai' } })).toEqual([
      'error:SITE_URL',
      'error:site.domain',
    ])
    expect(keys(ready({ vars: { ADMIN_EMAILS: 'admin@example.com', EMAIL_FROM: 'noreply@example.com', TURNSTILE_SITE_KEY: '' } }))).toEqual([
      'warn:TURNSTILE_SITE_KEY',
      'warn:ADMIN_EMAILS',
      'error:EMAIL_FROM',
    ])
    expect(keys(ready({ vars: { ADMIN_EMAILS: ' , ', EMAIL_FROM: 'noreply@other.ai' } }))).toEqual(['error:ADMIN_EMAILS', 'warn:EMAIL_FROM'])
    expect(checkConfig({ ...ready(), bindings: ['DB', 'MEDIA', 'MEDIA_TRANSFORM'] })).toEqual([
      expect.objectContaining({ key: 'bindings', message: expect.stringContaining('KV、VIDEO_QUEUE') }),
    ])
  })

  it('发信渠道：生产环境没配 RESEND_API_KEY 提示 Workers Free 限制；配了则只在发件域名与站点不同时提示去 Resend 验证', () => {
    const noKey = { secrets: { RESEND_API_KEY: undefined } }
    expect(keys(ready(noKey))).toEqual(['warn:RESEND_API_KEY'])
    expect(keys(ready({ secrets: { RESEND_API_KEY: '  ' } }))).toEqual(['warn:RESEND_API_KEY'])
    expect(keys(ready({ secrets: { RESEND_API_KEY: true } }))).toEqual([])
    // 与 Email Service Onboard 提示各说各的，不重复
    expect(keys(ready({ ...noKey, vars: { EMAIL_FROM: 'noreply@other.ai' } }))).toEqual(['warn:RESEND_API_KEY', 'warn:EMAIL_FROM'])
    expect(checkConfig(ready({ vars: { EMAIL_FROM: 'noreply@other.ai' } }))).toEqual([
      expect.objectContaining({ key: 'EMAIL_FROM', message: expect.stringContaining('Resend') }),
    ])
    // 预发环境、EMAIL_FROM 为空时不提示 Workers Free
    expect(keys(ready({ ...noKey, vars: { APP_ENV: 'staging' } }))).not.toContain('warn:RESEND_API_KEY')
    expect(keys(ready({ ...noKey, vars: { EMAIL_FROM: '' } }))).toEqual(['warn:EMAIL_FROM'])
  })
})

describe('doctor', () => {
  const template = readWranglerConfig('wrangler.jsonc')

  it('wrangler.jsonc 提供代码用到的全部绑定', () => {
    expect(configBindings(template)).toEqual(expect.arrayContaining([...REQUIRED_BINDINGS]))
  })

  it('解析 wrangler 输出：migration 表格、已全部应用、secret JSON 前后夹提示行、异常输出', () => {
    const table = `Migrations to be applied:\n┌──────────────────┐\n│ name             │\n├──────────────────┤\n│ 0007_admin_lookup.sql │\n├──┤\n│ 0008_order_reconcile.sql │\n└──┘`
    expect(parsePendingMigrations(table)).toEqual(['0007_admin_lookup.sql', '0008_order_reconcile.sql'])
    expect(parsePendingMigrations('Resource location: remote\n✅ No migrations to apply!')).toEqual([])
    expect(parsePendingMigrations('✘ [ERROR] Authentication error')).toBeNull()
    expect(parseSecretNames('⛅️ wrangler\n[{"name":"FAL_KEY","type":"secret_text"},{"name":"SESSION_SECRET","type":"secret_text"}]\n')).toEqual([
      'FAL_KEY',
      'SESSION_SECRET',
    ])
    expect(parseSecretNames('✘ [ERROR] Worker not found [code: 10007]')).toBeNull()
  })

  // 把模板配置改成一份可上线的配置，再逐项破坏
  const deployable = (): Record<string, any> => ({
    ...structuredClone(template),
    // doctor 按 site.packages 和 sellingPlans 核对商品表，站点改了积分包也不用改这里
    vars: { ...ready().vars, WAFFO_PRODUCTS: JSON.stringify(Object.fromEntries([...site.packages, ...sellingPlans].map((p) => [p.id, `PROD_${p.id}`]))), WAFFO_STORE_ID: 'STO_1' },
    d1_databases: [{ ...template.d1_databases[0], database_id: 'b7c0f5d2-1111-2222-3333-444455556666' }],
    kv_namespaces: [{ binding: 'KV', id: '9f8e7d6c5b4a39281706f5e4d3c2b1a0' }],
    routes: [{ pattern: 'moonhop.ai', custom_domain: true }],
    workers_dev: false,
    // 模板默认不声明 Media 绑定；这里模拟站点启用了 OUTPUT_MODERATION=frames
    media: { binding: 'MEDIA_TRANSFORM' },
  })
  const allSecrets = Object.keys(ready().secrets)
  const doctorKeys = (config: Record<string, any>, options: Parameters<typeof runDoctor>[1] = {}) =>
    runDoctor(config, { secretNames: allSecrets, pendingMigrations: [], siteDomain: 'moonhop.ai', ...options }).map((i) => `${i.level}:${i.key}`)

  it('可上线的配置通过；缺 secret、未应用 migration、查询失败都报错', () => {
    expect(doctorKeys(deployable())).toEqual([])
    expect(doctorKeys(deployable(), { secretNames: allSecrets.filter((n) => n !== 'FAL_KEY') })).toEqual(['error:FAL_KEY'])
    expect(doctorKeys(deployable(), { pendingMigrations: ['0008_order_reconcile.sql'] })).toEqual(['error:migrations'])
    // 读不到 secret 列表时只报一条，不把每个密钥都报成缺失
    expect(doctorKeys(deployable(), { secretNames: null, pendingMigrations: null })).toEqual(['error:secrets', 'error:migrations'])
    expect(doctorKeys(deployable(), { secretNames: undefined, pendingMigrations: undefined })).toEqual(['warn:secrets', 'warn:migrations'])
  })

  it('占位资源 id、routes 与 SITE_URL 不一致、缺死信消费、缺 Cron、正式站仍开 workers.dev', () => {
    const broken = deployable()
    broken.d1_databases[0].database_id = '00000000-0000-0000-0000-000000000000'
    broken.kv_namespaces[0].id = '0'.repeat(32)
    broken.routes = ['www.other.ai/*']
    broken.queues.consumers = broken.queues.consumers.slice(0, 1)
    delete broken.triggers
    expect(doctorKeys(broken)).toEqual(['error:d1_databases', 'error:kv_namespaces', 'error:queues', 'error:triggers', 'error:routes'])

    const noRoutes = { ...deployable(), routes: undefined, workers_dev: undefined }
    expect(doctorKeys(noRoutes)).toEqual(['warn:workers_dev'])
  })

  it('预发：SITE_URL 必须是本 Worker 的 workers.dev 地址', () => {
    const staging = {
      ...deployable(),
      name: 'shrimp-staging',
      routes: undefined,
      vars: { ...deployable().vars, APP_ENV: 'staging', WAFFO_ENVIRONMENT: 'test', SITE_URL: 'https://shrimp-staging.dev-team.workers.dev' },
    }
    expect(doctorKeys(staging)).toEqual([])
    expect(doctorKeys({ ...staging, vars: { ...staging.vars, SITE_URL: 'https://other-staging.dev-team.workers.dev' } })).toEqual(['error:SITE_URL'])
  })

  it('站点文件里的 TODO(site)：正式站报错，其它环境只提醒', () => {
    const root = mkdtempSync(join(tmpdir(), 'site-todo-'))
    mkdirSync(join(root, 'src/config'), { recursive: true })
    mkdirSync(join(root, 'src/content'))
    writeFileSync(join(root, 'src/config/site.ts'), "export const site = {\n  supportEmail: 'TODO(site): 客服邮箱',\n}\n")
    writeFileSync(join(root, 'src/content/en.ts'), "// TODO(site): 换成真实案例\nexport const en = {}\n")
    writeFileSync(join(root, 'src/content/notes.md'), 'TODO(site): 不在检查范围\n')
    writeFileSync(join(root, 'wrangler.jsonc'), '{}\n')
    const todos = findSiteTodos(root)
    expect(todos.map((t) => `${t.file}:${t.line}`)).toEqual(['src/config/site.ts:2', 'src/content/en.ts:1'])

    expect(doctorKeys(deployable(), { siteTodos: todos })).toEqual(['error:site-todo'])
    const staging = { ...deployable(), vars: { ...deployable().vars, APP_ENV: 'staging' } }
    expect(doctorKeys(staging, { siteTodos: todos })).toContain('warn:site-todo')
  })
})
