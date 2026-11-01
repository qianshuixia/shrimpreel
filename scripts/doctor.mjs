#!/usr/bin/env node
// 部署前体检：按 wrangler 配置检查 APP_ENV、站点地址与域名、所选服务商需要的密钥（只核对名字）、绑定和资源 id、
// 误用 mock、Cron 与死信队列、站点文件里没填完的 TODO(site)，以及远端 D1 是否还有未应用的 migration。
// 有错误时退出码为 1，`npm run deploy` 先跑它。
//
//   npm run doctor                                  # 检查 wrangler.jsonc
//   npm run doctor -- -c wrangler.staging.jsonc     # 检查预发配置
//   npm run doctor -- --offline                     # 不访问 Cloudflare：跳过 secret 名字和远端 migration
//
// 规则与后台概览的“配置检查”卡片共用 src/server/config-health.ts。
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { sellingPlans, site } from '../src/config/site.ts'
import { checkConfig } from '../src/server/config-health.ts'

export function readWranglerConfig(file) {
  const { config, error } = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'))
  if (error) throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`)
  return config
}

export function configBindings(config) {
  return [
    config.assets?.binding,
    ...(config.d1_databases ?? []).map((d) => d.binding),
    ...(config.r2_buckets ?? []).map((b) => b.binding),
    ...(config.kv_namespaces ?? []).map((k) => k.binding),
    ...(config.queues?.producers ?? []).map((q) => q.binding),
    ...(config.ratelimits ?? []).map((r) => r.name),
    ...(config.send_email ?? []).map((e) => e.name),
    config.media?.binding,
  ].filter(Boolean)
}

const routeHost = (route) => {
  const pattern = typeof route === 'string' ? route : route.pattern
  return pattern.replace(/^https?:\/\//, '').split('/')[0].replace(/^\*\.?/, '').toLowerCase()
}

// `wrangler d1 migrations list` 的输出：没有待应用时打印 “No migrations to apply”，否则用表格列出文件名
export function parsePendingMigrations(output) {
  if (/No migrations to apply/i.test(output)) return []
  const names = [...output.matchAll(/\b(\d{4}_[\w.-]+\.sql)\b/g)].map((m) => m[1])
  return names.length ? [...new Set(names)] : null
}

// `wrangler secret list --format json`：[{ "name": "...", "type": "secret_text" }]，前后可能夹着 wrangler 的提示行
export function parseSecretNames(output) {
  const start = output.indexOf('[')
  const end = output.lastIndexOf(']')
  if (start < 0 || end < start) return null
  try {
    const list = JSON.parse(output.slice(start, end + 1))
    return Array.isArray(list) ? list.map((s) => s.name).filter((n) => typeof n === 'string') : null
  } catch {
    return null
  }
}

// 派生新站时没拿到的信息写成 `TODO(site): …`（见 .claude/skills/new-hot-site），上线前必须全部填完
export function findSiteTodos(root = fileURLToPath(new URL('..', import.meta.url))) {
  const files = ['src/config/site.ts', ...readdirSync(`${root}/src/content`).filter((f) => f.endsWith('.ts')).map((f) => `src/content/${f}`), 'wrangler.jsonc']
  return files.flatMap((file) =>
    readFileSync(`${root}/${file}`, 'utf8')
      .split('\n')
      .flatMap((text, index) => (text.includes('TODO(site)') ? [{ file, line: index + 1, text: text.trim() }] : [])),
  )
}

// secretNames / pendingMigrations：undefined = 没有核对（--offline），null = 查询失败
export function runDoctor(
  config,
  { secretNames, pendingMigrations, siteDomain = site.domain, packageIds = site.packages.map((p) => p.id), planIds = sellingPlans.map((p) => p.id), siteTodos = [] } = {},
) {
  const vars = config.vars ?? {}
  const issues = checkConfig({
    vars,
    // 没核对或查不到 secret 时先当作都已配置，下面单独报告
    secrets: secretNames ? Object.fromEntries(secretNames.map((name) => [name, true])) : new Proxy({}, { get: () => true }),
    bindings: configBindings(config),
    packageIds,
    planIds,
    siteDomain,
  })
  const error = (key, message) => issues.push({ level: 'error', key, message })
  const warn = (key, message) => issues.push({ level: 'warn', key, message })

  for (const db of config.d1_databases ?? []) {
    if (/^[0-]+$/.test(db.database_id ?? '')) error('d1_databases', `D1 ${db.binding} 的 database_id 仍是占位值：先 wrangler d1 create 再写回`)
  }
  for (const kv of config.kv_namespaces ?? []) {
    if (/^0+$/.test(kv.id ?? '')) error('kv_namespaces', `KV ${kv.binding} 的 id 仍是占位值：先 wrangler kv namespace create 再写回`)
  }
  const consumers = config.queues?.consumers ?? []
  for (const producer of config.queues?.producers ?? []) {
    const consumer = consumers.find((c) => c.queue === producer.queue)
    if (!consumer) error('queues', `队列 ${producer.queue} 没有 consumer：生成任务不会被处理`)
    else if (!consumer.dead_letter_queue || !consumers.some((c) => c.queue === consumer.dead_letter_queue)) {
      error('queues', `队列 ${producer.queue} 没有被消费的死信队列：重试耗尽的任务不会判失败、不会退积分`)
    }
  }
  if (!config.triggers?.crons?.length) error('triggers', '没有 Cron：过期清理、订单对账和健康告警都不会运行')

  const appEnv = vars.APP_ENV
  let siteHost = null
  try {
    siteHost = new URL(vars.SITE_URL).hostname.toLowerCase()
  } catch {}
  const routes = config.routes ?? (config.route ? [config.route] : [])
  if (siteHost && routes.length) {
    const hosts = routes.map(routeHost)
    if (!hosts.includes(siteHost)) error('routes', `SITE_URL 的域名 ${siteHost} 不在 routes 里（${hosts.join('、')}）`)
  } else if (siteHost && appEnv === 'staging') {
    if (!siteHost.startsWith(`${config.name}.`) || !siteHost.endsWith('.workers.dev')) {
      error('SITE_URL', `staging 的 SITE_URL 应是 https://${config.name}.<子域名>.workers.dev`)
    }
  } else if (appEnv === 'production' && config.workers_dev !== false) {
    warn('workers_dev', '自定义域名可用后设 "workers_dev": false 和 "preview_urls": false，否则 *.workers.dev 绕过域名上的 WAF 和限流')
  }

  if (siteTodos.length) {
    const where = siteTodos.slice(0, 5).map((t) => `${t.file}:${t.line}`).join('、')
    const message = `还有 ${siteTodos.length} 处 TODO(site) 没填（${where}${siteTodos.length > 5 ? ' 等' : ''}）：git grep -n "TODO(site)" -- src wrangler.jsonc 列出全部`
    if (appEnv === 'production') error('site-todo', message)
    else warn('site-todo', message)
  }

  if (secretNames === undefined) warn('secrets', '未核对 secret 名字（--offline）')
  else if (secretNames === null) {
    error('secrets', `无法读取 Worker ${config.name} 的 secret 列表：未登录 wrangler，或 Worker 还不存在（首次部署先 wrangler secret put，会提示创建）`)
  }
  if (pendingMigrations === undefined) warn('migrations', '未核对远端 migration（--offline）')
  else if (pendingMigrations === null) error('migrations', '无法查询远端 D1 的 migration 状态（wrangler d1 migrations list DB --remote 失败）')
  else if (pendingMigrations.length) {
    error('migrations', `远端 D1 有 ${pendingMigrations.length} 个未应用的 migration（${pendingMigrations.join('、')}）：先应用再部署新代码`)
  }
  return issues
}

// 直接用 node 跑 wrangler 的入口，不经过 shell（-c 的路径不会被拼进命令行）
const WRANGLER_BIN = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))

function wrangler(args) {
  const result = spawnSync(process.execPath, [WRANGLER_BIN, ...args], { encoding: 'utf8' })
  return { ok: result.status === 0, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` }
}

function main(args) {
  const arg = (short, long) => {
    const index = args.findIndex((a) => a === short || a === long)
    return index >= 0 ? args[index + 1] : undefined
  }
  const file = arg('-c', '--config') ?? 'wrangler.jsonc'
  const offline = args.includes('--offline')
  const config = readWranglerConfig(file)
  let secretNames
  let pendingMigrations
  if (!offline) {
    const secrets = wrangler(['secret', 'list', '--format', 'json', '-c', file])
    secretNames = secrets.ok ? parseSecretNames(secrets.output) : null
    const migrations = wrangler(['d1', 'migrations', 'list', 'DB', '--remote', '-c', file])
    pendingMigrations = migrations.ok ? parsePendingMigrations(migrations.output) : null
  }
  const issues = runDoctor(config, { secretNames, pendingMigrations, siteTodos: findSiteTodos() })

  console.log(`部署前体检：${file}（Worker ${config.name}，APP_ENV=${config.vars?.APP_ENV ?? '(空)'}）\n`)
  for (const issue of issues) console.log(`${issue.level === 'error' ? '✗' : '!'} ${issue.key}  ${issue.message}`)
  const errors = issues.filter((i) => i.level === 'error').length
  const warns = issues.length - errors
  console.log(`\n${errors} 个错误，${warns} 个提醒。${errors ? '修复错误后再部署。' : '可以部署。'}`)
  process.exitCode = errors ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2))
