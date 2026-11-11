#!/usr/bin/env node
// 把本地密钥文件同步到 Worker 的 secrets。默认只出计划：列名字和差异，不打印任何值；加 --apply 才写入，
// 值经 stdin 交给 `wrangler secret bulk`，不落临时文件。
// 已存在的 secret 默认不覆盖（换 SESSION_SECRET 会让所有登录和已签名的图片地址失效），要覆盖加 --overwrite。
// 远端多出来的 secret 只列出，不删除。
//
//   node scripts/sync-secrets.mjs                                    # 读 .dev.vars.production，对比 wrangler.jsonc 的 Worker
//   node scripts/sync-secrets.mjs --apply                            # 写入远端还没有的 secret
//   node scripts/sync-secrets.mjs --apply --overwrite                # 已存在的也覆盖
//   node scripts/sync-secrets.mjs -c wrangler.staging.jsonc --file .dev.vars.staging
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { STYLES, sellingPlans, site } from '../src/config/site.ts'
import { checkConfig, isWeakSessionSecret } from '../src/server/config-health.ts'
import { configBindings, parseSecretNames, readWranglerConfig } from './doctor.mjs'

const EXAMPLE_FILE = fileURLToPath(new URL('../.dev.vars.example', import.meta.url))
const WRANGLER_BIN = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))

// KEY=VALUE，支持 export 前缀、成对引号和未加引号时的行尾 # 注释。报错只给行号，不带内容（可能含密钥）
export function parseDotenv(text) {
  const entries = []
  const errors = []
  text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const line = raw.trim()
      if (!line || line.startsWith('#')) return
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
      if (!match) return errors.push(`第 ${index + 1} 行不是 KEY=VALUE`)
      const quoted = /^(['"])(.*)\1$/.exec(match[2])
      entries.push([match[1], quoted ? quoted[2] : match[2].replace(/\s+#.*$/, '')])
    })
  return { entries, errors }
}

// .dev.vars.example 登记的密钥名和占位值（注释掉的可选密钥也算）
export function exampleSecrets(text) {
  return new Map([...text.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => [m[1], m[2].trim()]))
}

// remoteNames：远端已有的 secret 名字，null = 读不到
export function planSecrets({ entries, example, remoteNames, config, overwrite = false, siteDomain = site.domain, packageIds = site.packages.map((p) => p.id), planIds = sellingPlans.map((p) => p.id), styleProviders = STYLES.flatMap((s) => (s.provider ? [s.provider] : [])) }) {
  const known = exampleSecrets(example)
  const vars = config.vars ?? {}
  const errors = []
  const values = {}
  const seen = new Set()
  for (const [name, value] of entries) {
    if (seen.has(name)) {
      errors.push(`${name} 重复出现`)
      continue
    }
    seen.add(name)
    if (name in vars) errors.push(`${name} 是 wrangler.jsonc 里的 var，不是密钥`)
    else if (!known.has(name)) errors.push(`${name} 不在 .dev.vars.example 里：拼错了，或新增密钥时没有登记`)
    else if (!value.trim()) errors.push(`${name} 的值为空`)
    else if (known.get(name) && value.trim() === known.get(name)) errors.push(`${name} 仍是 .dev.vars.example 里的占位值`)
    else if (name === 'SESSION_SECRET' && isWeakSessionSecret(value.trim())) errors.push('SESSION_SECRET 短于 32 个字符：用 openssl rand -hex 32 生成')
    else values[name] = value
  }

  const remote = remoteNames ?? []
  const names = Object.keys(values)
  const existing = names.filter((name) => remote.includes(name))
  const add = names.filter((name) => !remote.includes(name))
  const update = overwrite ? existing : []
  // 同步后仍缺的必填密钥：按 vars 选的服务商算，规则与 doctor 相同
  const after = new Set([...remote, ...names])
  const missing = checkConfig({
    vars,
    secrets: Object.fromEntries([...after].map((name) => [name, true])),
    bindings: configBindings(config),
    packageIds,
    planIds,
    styleProviders,
    siteDomain,
  })
    .filter((issue) => issue.level === 'error' && known.has(issue.key))
    .map((issue) => issue.message)
  return {
    errors,
    add,
    update,
    kept: overwrite ? [] : existing,
    remoteOnly: remote.filter((name) => !seen.has(name)),
    missing,
    payload: Object.fromEntries([...add, ...update].map((name) => [name, values[name]])),
  }
}

// 万一 wrangler 的输出里带出了值，替换掉再打印
export function redact(output, values) {
  return values.filter((v) => v.length >= 4).reduce((text, value) => text.split(value).join('***'), output)
}

function runWrangler(args, input) {
  const result = spawnSync(process.execPath, [WRANGLER_BIN, ...args], { encoding: 'utf8', input })
  return { ok: result.status === 0, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` }
}

const isGitIgnored = (file) => spawnSync('git', ['check-ignore', '-q', file]).status === 0

// 返回退出码。deps 供测试替换 wrangler 和 git
export function main(args, { wrangler = runWrangler, gitIgnored = isGitIgnored, log = console.log } = {}) {
  const arg = (...names) => {
    const index = args.findIndex((a) => names.includes(a))
    return index >= 0 ? args[index + 1] : undefined
  }
  const configFile = arg('-c', '--config') ?? 'wrangler.jsonc'
  const file = arg('--file') ?? '.dev.vars.production'
  const apply = args.includes('--apply')
  const overwrite = args.includes('--overwrite')
  const fail = (message) => (log(`✗ ${message}`), 1)

  if (!existsSync(file)) return fail(`找不到 ${file}：从 .dev.vars.example 复制一份，填上线用的值`)
  if (!gitIgnored(file)) return fail(`${file} 没有被 .gitignore 忽略，可能被提交进仓库；用 .dev.vars.<环境> 这样的文件名`)

  const config = readWranglerConfig(configFile)
  const parsed = parseDotenv(readFileSync(file, 'utf8'))
  const list = wrangler(['secret', 'list', '--format', 'json', '-c', configFile])
  const remoteNames = list.ok ? parseSecretNames(list.output) : null
  const plan = planSecrets({ entries: parsed.entries, example: readFileSync(EXAMPLE_FILE, 'utf8'), remoteNames, config, overwrite })
  const errors = [...parsed.errors, ...plan.errors]

  log(`同步密钥：${file} → Worker ${config.name}（${configFile}，APP_ENV=${config.vars?.APP_ENV ?? '(空)'}）`)
  log(remoteNames ? `远端已有 ${remoteNames.length} 个 secret` : '读不到远端 secret 列表：未登录 wrangler，或 Worker 还不存在')
  const section = (title, items) => items.length && log(`\n${title}（${items.length}）：\n${items.map((i) => `  ${i}`).join('\n')}`)
  section('新增', plan.add)
  section('覆盖', plan.update)
  section('已存在，不覆盖（要覆盖加 --overwrite）', plan.kept)
  section('只在远端，不会删除', plan.remoteOnly)
  section('同步后仍缺（doctor 会拦下部署）', plan.missing)
  section('✗ 文件有错误，不会写入', errors)
  if (errors.length) return 1

  const count = Object.keys(plan.payload).length
  if (!apply) return log(`\n只出了计划，没有写入。确认后加 --apply 写入 ${count} 个。`), 0
  if (remoteNames === null && !overwrite) return fail('读不到远端 secret，无法确认不会覆盖已有的值；确认要写入（例如 Worker 还不存在）时加 --overwrite')
  if (!count) return log('\n没有需要写入的 secret。'), 0
  const result = wrangler(['secret', 'bulk', '-c', configFile], JSON.stringify(plan.payload))
  log(redact(result.output, Object.values(plan.payload)).trim())
  return result.ok ? 0 : fail('wrangler secret bulk 失败，见上面的输出')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2))
