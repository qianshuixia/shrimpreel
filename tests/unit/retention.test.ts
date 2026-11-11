import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { site } from '#/config/site'
import { sweepExpiredMedia } from '#/server/retention'
import { d1Shim, migrate } from './d1-sqlite'

// 排队或处理中的生成还要用的原图不能被清掉：双人生成的第二张照片也算在用
let sqlite: DatabaseSync
let env: Env
const old = new Date(Date.now() - (site.retention.uploadDays + 1) * 86_400_000).toISOString()

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  migrate(sqlite)
  env = { DB: d1Shim(sqlite), MEDIA: { delete: async () => {} } } as unknown as Env
  sqlite.prepare('INSERT INTO users (id, email, credits, created_at) VALUES (?, ?, 0, ?)').run('usr_1', 'u@example.com', old)
  for (const id of ['upl_1', 'upl_2', 'upl_3']) {
    sqlite
      .prepare('INSERT INTO uploads (id, user_id, r2_key, content_type, size_bytes, sha256, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run(id, 'usr_1', `k_${id}`, 'image/jpeg', `h_${id}`, old)
  }
  sqlite
    .prepare(
      `INSERT INTO generations (id, user_id, template_id, duration_id, duration_seconds, credits_cost, upload_id, second_upload_id, status, provider, created_at, updated_at)
       VALUES ('gen_1', 'usr_1', 't', 'short', 6, 6, 'upl_1', 'upl_2', ?, 'mock', ?, ?)`,
    )
    .run('queued', old, old)
})

const expired = () => sqlite.prepare('SELECT id FROM uploads WHERE expired_at IS NOT NULL ORDER BY id').all().map((r) => r.id)

describe('sweepExpiredMedia：在用的原图', () => {
  it('进行中的双人生成：两张照片都保留，没人用的第三张照常清理', async () => {
    await sweepExpiredMedia(env)
    expect(expired()).toEqual(['upl_3'])
  })

  it('生成结束后两张照片都能清理', async () => {
    sqlite.prepare("UPDATE generations SET status = 'failed' WHERE id = 'gen_1'").run()
    await sweepExpiredMedia(env)
    expect(expired()).toEqual(['upl_1', 'upl_2', 'upl_3'])
  })
})
