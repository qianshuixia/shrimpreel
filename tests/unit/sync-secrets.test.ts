import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { main, parseDotenv, planSecrets } from '../../scripts/sync-secrets.mjs'

const STRONG = 'a'.repeat(64)
const example = readFileSync(new URL('../../.dev.vars.example', import.meta.url), 'utf8')
// 选了 dodo、fal、openai，配了 Google 和 Turnstile：这 7 个密钥都必填
const config = {
  name: 'moonhop',
  vars: {
    APP_ENV: 'production',
    SITE_URL: 'https://moonhop.ai',
    PAYMENT_PROVIDER: 'dodo',
    VIDEO_PROVIDER: 'fal',
    MODERATION_PROVIDER: 'openai',
    GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
    TURNSTILE_SITE_KEY: '0x4AAA',
  },
}

describe('sync-secrets', () => {
  it('解析 KEY=VALUE；拒绝未登记、重复、var 同名、空值、占位值和弱 SESSION_SECRET，报错不带值', () => {
    const parsed = parseDotenv('\uFEFF# 注释\nexport FAL_KEY="fal:x # 不是注释"\nDODO_API_KEY=dodo_x # 行尾注释\r\nnot a pair secret-value-123\n')
    expect(parsed.entries).toEqual([
      ['FAL_KEY', 'fal:x # 不是注释'],
      ['DODO_API_KEY', 'dodo_x'],
    ])
    expect(parsed.errors).toEqual(['第 4 行不是 KEY=VALUE'])

    const bad = planSecrets({
      entries: [
        ['FAL_KEY', 'fal-1'],
        ['FAL_KEY', 'fal-2'],
        ['FAL_KYE', 'fal-3'],
        ['TURNSTILE_SITE_KEY', '0x4AAA'],
        ['OPENAI_API_KEY', ' '],
        ['SESSION_SECRET', 'change-me-to-a-long-random-string'],
      ],
      example,
      remoteNames: [],
      config,
    })
    expect(bad.errors).toEqual([
      'FAL_KEY 重复出现',
      'FAL_KYE 不在 .dev.vars.example 里：拼错了，或新增密钥时没有登记',
      'TURNSTILE_SITE_KEY 是 wrangler.jsonc 里的 var，不是密钥',
      'OPENAI_API_KEY 的值为空',
      'SESSION_SECRET 仍是 .dev.vars.example 里的占位值',
    ])
    expect(planSecrets({ entries: [['SESSION_SECRET', 'short']], example, remoteNames: [], config }).errors).toEqual([
      'SESSION_SECRET 短于 32 个字符：用 openssl rand -hex 32 生成',
    ])
    expect(JSON.stringify(bad.errors)).not.toMatch(/fal-1|fal-3|0x4AAA/)
  })

  it('计划：只新增远端没有的，已存在的默认不覆盖，远端多出的只列出；按所选服务商算出同步后仍缺的密钥', () => {
    const input = {
      entries: [
        ['SESSION_SECRET', STRONG],
        ['DODO_API_KEY', 'dodo_live'],
        ['FAL_KEY', 'fal-key'],
      ] as [string, string][],
      example,
      remoteNames: ['SESSION_SECRET', 'GOOGLE_CLIENT_SECRET', 'LEGACY_KEY'],
      config,
      // 不受站点风格指定的服务商影响
      styleProviders: [],
    }
    const plan = planSecrets(input)
    expect(plan).toMatchObject({ errors: [], add: ['DODO_API_KEY', 'FAL_KEY'], update: [], kept: ['SESSION_SECRET'], remoteOnly: ['GOOGLE_CLIENT_SECRET', 'LEGACY_KEY'] })
    expect(plan.payload).toEqual({ DODO_API_KEY: 'dodo_live', FAL_KEY: 'fal-key' })
    expect(plan.missing.map((m) => m.split(' ')[0])).toEqual(['缺少密钥', '缺少密钥', '缺少密钥'])
    expect(plan.missing.join('\n')).toMatch(/DODO_WEBHOOK_SECRET[\s\S]*OPENAI_API_KEY[\s\S]*TURNSTILE_SECRET_KEY/)

    const overwrite = planSecrets({ ...input, overwrite: true })
    expect(overwrite).toMatchObject({ update: ['SESSION_SECRET'], kept: [] })
    expect(Object.keys(overwrite.payload)).toEqual(['DODO_API_KEY', 'FAL_KEY', 'SESSION_SECRET'])
  })

  it('命令：默认只出计划；--apply 经 stdin 写入且输出脱敏；读不到远端、文件未被忽略或有错误时不写入', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-secrets-'))
    const wranglerFile = join(dir, 'wrangler.jsonc')
    const secretsFile = join(dir, '.dev.vars.production')
    writeFileSync(wranglerFile, JSON.stringify(config))
    writeFileSync(secretsFile, `SESSION_SECRET=${STRONG}\nFAL_KEY=fal-secret-value\n`)

    const run = (args: string[], { remote = '[{"name":"SESSION_SECRET","type":"secret_text"}]' as string | null, ignored = true } = {}) => {
      const calls: { args: string[]; input?: string }[] = []
      const lines: string[] = []
      const code = main(['-c', wranglerFile, '--file', secretsFile, ...args], {
        wrangler: (wargs, input) => {
          calls.push({ args: wargs, input })
          if (wargs[1] === 'list') return remote === null ? { ok: false, output: 'not found' } : { ok: true, output: remote }
          return { ok: true, output: `✨ Successfully created secret for key: FAL_KEY (echo fal-secret-value)` }
        },
        gitIgnored: () => ignored,
        log: (line) => lines.push(line),
      })
      return { code, bulk: calls.filter((c) => c.args[1] === 'bulk'), out: lines.join('\n') }
    }

    const dry = run([])
    expect(dry.code).toBe(0)
    expect(dry.bulk).toEqual([])
    expect(dry.out).toContain('新增（1）：\n  FAL_KEY')
    expect(dry.out).toContain('已存在，不覆盖')
    expect(dry.out).not.toMatch(/fal-secret-value|aaaaaaaa/)

    const applied = run(['--apply'])
    expect(applied.code).toBe(0)
    expect(applied.bulk).toHaveLength(1)
    expect(applied.bulk[0]!.args).toEqual(['secret', 'bulk', '-c', wranglerFile])
    expect(JSON.parse(applied.bulk[0]!.input!)).toEqual({ FAL_KEY: 'fal-secret-value' })
    expect(applied.out).toContain('(echo ***)')
    expect(applied.out).not.toContain('fal-secret-value')

    const unknownRemote = run(['--apply'], { remote: null })
    expect([unknownRemote.code, unknownRemote.bulk.length]).toEqual([1, 0])
    expect(unknownRemote.out).toContain('加 --overwrite')
    const forced = run(['--apply', '--overwrite'], { remote: null })
    expect(Object.keys(JSON.parse(forced.bulk[0]!.input!))).toEqual(['SESSION_SECRET', 'FAL_KEY'])

    const notIgnored = run(['--apply'], { ignored: false })
    expect([notIgnored.code, notIgnored.bulk.length]).toEqual([1, 0])
    expect(notIgnored.out).toContain('没有被 .gitignore 忽略')

    writeFileSync(secretsFile, `SESSION_SECRET=short\nFAL_KEY=fal-secret-value\n`)
    const invalid = run(['--apply'])
    expect([invalid.code, invalid.bulk.length]).toEqual([1, 0])
    expect(invalid.out).toContain('SESSION_SECRET 短于 32 个字符')

    expect(main(['--file', join(dir, 'missing')], { log: () => {} })).toBe(1)
  })
})
