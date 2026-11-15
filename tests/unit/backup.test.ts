import { DatabaseSync } from 'node:sqlite'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { backupDatabase, backupKey, dumpDatabase, sqlLiteral } from '#/server/backup'
import { buildRestoreChunks, splitSqlStatements, summarizeDump } from '../../scripts/restore-d1.mjs'
import { d1Shim, migrate } from './d1-sqlite'

// 导出、导入的完整往返在本地 D1 上验证（见 README“数据备份”），这里只覆盖字面量转义的边界
describe('sqlLiteral', () => {
  it('字符串里的单引号加倍，换行、分号、注释符原样保留在引号内', () => {
    expect(sqlLiteral("it's")).toBe("'it''s'")
    expect(sqlLiteral("a';DROP TABLE users;--\nb")).toBe("'a'';DROP TABLE users;--\nb'")
    expect(sqlLiteral('')).toBe("''")
  })

  it('NULL、数字、非有限数、BLOB', () => {
    expect(sqlLiteral(null)).toBe('NULL')
    expect(sqlLiteral(undefined)).toBe('NULL')
    expect(sqlLiteral(42)).toBe('42')
    expect(sqlLiteral(-1.5)).toBe('-1.5')
    expect(sqlLiteral(Number.NaN)).toBe('NULL')
    expect(sqlLiteral([0, 15, 255])).toBe("X'000fff'")
    expect(sqlLiteral(new Uint8Array([1, 2]).buffer)).toBe("X'0102'")
  })

  it('备份文件按 UTC 日期命名，字符串顺序就是日期顺序', () => {
    expect(backupKey('2026-10-21')).toBe('backups/d1/2026-10-21.sql.gz')
    expect(backupKey('2026-09-30') < backupKey('2026-10-01')).toBe(true)
  })
})

describe('分页备份与分片恢复往返', () => {
  it('分页导出、多行 INSERT、压缩落盘、summarizeDump 统计与空库重放完全一致（含分号/换行 JSON）', async () => {
    const src = new DatabaseSync(':memory:')
    migrate(src)
    const now = '2026-11-16T00:00:00.000Z'
    for (let i = 0; i < 30; i++) {
      src
        .prepare(`INSERT INTO users (id, email, role, status, credits, created_at) VALUES (?, ?, 'user', 'active', ?, ?)`)
        .run(`usr_${i}`, `u${i}@example.com`, i, now)
    }
    src
      .prepare(`INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('tok_1', 'usr_0', ?, ?)`)
      .run('2026-12-01T00:00:00.000Z', now)
    src
      .prepare(
        `INSERT INTO payment_events (id, provider, event_id, event_type, order_id, status, payload, created_at)
         VALUES ('pe_1', 'stripe', 'evt_1', 'paid', NULL, 'processed', ?, ?)`,
      )
      .run('{"note":"semi;colon\\nand;more\';"}', now)

    const dump = await dumpDatabase(d1Shim(src) as unknown as D1Database, new Date(now))
    const summary = summarizeDump(dump.sql)
    expect(summary.rows.users).toBe(30)
    expect(summary.rows.payment_events).toBe(1)
    expect(summary.rows.sessions ?? 0).toBe(0)

    const chunks = buildRestoreChunks(splitSqlStatements(dump.sql), { maxBytes: 1500, maxStatements: 10 })
    expect(chunks.length).toBeGreaterThan(1)

    const restored = new DatabaseSync(':memory:')
    for (const chunk of chunks) restored.exec(chunk)
    expect((restored.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(30)
    expect((restored.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(0)
    expect(restored.prepare('SELECT payload FROM payment_events WHERE id = ?').get('pe_1')).toEqual({
      payload: '{"note":"semi;colon\\nand;more\';"}',
    })

    const stored = new Map<string, Uint8Array>()
    const bucket = {
      put: vi.fn(async (key: string, value: Uint8Array) => {
        stored.set(key, new Uint8Array(value))
      }),
      list: vi.fn(async () => ({ objects: [], truncated: false })),
      delete: vi.fn(),
    }
    const db = d1Shim(src) as unknown as D1Database
    const env = { DB: db, MEDIA: bucket } as unknown as Env
    const backup = await backupDatabase(env, new Date(now))
    expect(backup.rows).toBe(dump.rows)
    const gunzipped = gunzipSync(stored.get(backup.key)!).toString('utf8')
    expect(gunzipped).toBe(dump.sql)

    // 超过分片阈值时切换 R2 Multipart Upload，分片合并压缩内容与 dump 完全一致
    const uploaded: Uint8Array[] = []
    const complete = vi.fn(async () => ({}))
    const abort = vi.fn(async () => {})
    const mpBucket = {
      createMultipartUpload: vi.fn(async () => ({
        uploadPart: vi.fn(async (partNumber: number, chunk: Uint8Array) => {
          uploaded.push(new Uint8Array(chunk))
          return { partNumber, etag: `e${partNumber}` }
        }),
        complete,
        abort,
      })),
      put: vi.fn(),
      list: vi.fn(async () => ({ objects: [], truncated: false })),
      delete: vi.fn(),
    }
    const mpBackup = await backupDatabase({ DB: db, MEDIA: mpBucket } as unknown as Env, new Date(now), 256)
    expect(mpBucket.put).not.toHaveBeenCalled()
    expect(mpBucket.createMultipartUpload).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(uploaded.length).toBeGreaterThan(1)
    const totalLen = uploaded.reduce((s, c) => s + c.byteLength, 0)
    const merged = new Uint8Array(totalLen)
    let pos = 0
    for (const part of uploaded) {
      merged.set(part, pos)
      pos += part.byteLength
    }
    expect(gunzipSync(merged).toString('utf8')).toBe(dump.sql)
    expect(mpBackup.bytes).toBe(totalLen)
    expect(abort).not.toHaveBeenCalled()
  })
})
