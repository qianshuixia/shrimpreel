import { sendEmails } from './email'
import { alertBucket, notifyAlertChat, type Alert } from './alerts'
import { adminAlerts } from './notifications'

// D1 每日备份：Cron（每 5 分钟）发现当天（UTC）还没有备份就导出一次，gzip 后存进 MEDIA 的 backups/d1/<日期>.sql.gz，
// 保留 BACKUP_RETENTION_DAYS 天。导出内容是建表语句加全部数据（sessions 只导结构），
// 恢复到空库：`node scripts/restore-d1.mjs`（见 README“数据备份”）。D1 自带的 Time Travel 只能回到 30 天内，
// 这份备份用于更久的留存、误删数据库或换账号迁移。
// 所有表的 SELECT 放在一个 db.batch 里执行：batch 是一个事务，拿到的是同一时刻的快照。
// backups/ 没有任何公开路由，/media/* 只读 templates/ 和 uploads/。

export const BACKUP_PREFIX = 'backups/d1/'
export const BACKUP_RETENTION_DAYS = 30
// 每天最多尝试几次：失败后下一次 Cron 重试，避免持续失败时每 5 分钟都跑一遍全表导出
const MAX_ATTEMPTS_PER_DAY = 3
// 只导结构不导数据的表：会话 token 哈希没有恢复价值，留在备份里只会增加泄露面
const SCHEMA_ONLY = new Set(['sessions'])
const PAGE_SIZE = 500
const INSERT_BATCH_ROWS = 25
const INSERT_MAX_CHARS = 48_000
// R2 Multipart 要求除最后一片外每片至少 5 MB；小于 5 MB 的小库直接单次 put，大于则分片落盘（峰值内存恒定 < 15 MB）
export const BACKUP_MULTIPART_BYTES = 5 * 1024 * 1024

type SqlValue = string | number | null | ArrayBuffer | number[]

// SQLite 字面量。D1 把 BLOB 返回成数字数组
export function sqlLiteral(value: SqlValue | boolean | bigint | undefined): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : Uint8Array.from(value)
  return `X'${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}'`
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`

interface SchemaRow {
  type: 'table' | 'index' | 'trigger' | 'view'
  name: string
  tbl_name: string
  sql: string | null
}

export interface DumpResult {
  sql: string
  tables: number
  rows: number
}

async function queryTablePage(
  db: D1Database,
  tableName: string,
  cursor: { useRowId: boolean; lastRowId: number; offset: number },
): Promise<{ rows: Array<Record<string, SqlValue>>; nextCursor: typeof cursor }> {
  if (cursor.useRowId) {
    try {
      const page = await db
        .prepare(`SELECT rowid AS __backup_rowid, * FROM ${ident(tableName)} WHERE rowid > ? ORDER BY rowid LIMIT ?`)
        .bind(cursor.lastRowId, PAGE_SIZE)
        .all<Record<string, SqlValue> & { __backup_rowid: number }>()
      const raw = page.results ?? []
      const last = raw.at(-1)?.__backup_rowid ?? cursor.lastRowId
      const rows = raw.map(({ __backup_rowid: _ignored, ...rest }) => rest)
      return { rows, nextCursor: { useRowId: true, lastRowId: last, offset: cursor.offset + rows.length } }
    } catch (error) {
      // WITHOUT ROWID 表回退 OFFSET 分页
      if (!(error instanceof Error && /no such column:\s*rowid/i.test(error.message))) throw error
    }
  }
  const page = await db
    .prepare(`SELECT * FROM ${ident(tableName)} LIMIT ? OFFSET ?`)
    .bind(PAGE_SIZE, cursor.offset)
    .all<Record<string, SqlValue>>()
  const rows = page.results ?? []
  return { rows, nextCursor: { useRowId: false, lastRowId: 0, offset: cursor.offset + rows.length } }
}

// 按页读取全部表并分片流出 SQL，避免整库 SELECT * 在 128 MB Isolate 里拼超大字符串 OOM
export async function streamDatabaseSql(
  db: D1Database,
  emit: (chunk: string) => Promise<void> | void,
  now = new Date(),
): Promise<{ tables: number; rows: number }> {
  const schema = await db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid`,
    )
    .all<SchemaRow>()
  const tables = schema.results.filter((row) => row.type === 'table')
  const dataTables = tables.filter((table) => !SCHEMA_ONLY.has(table.name))

  const header = [`-- D1 backup ${now.toISOString()}`, 'PRAGMA defer_foreign_keys = true;', ...tables.map((t) => `${t.sql};`)]
  await emit(`${header.join('\n')}\n`)

  let totalRows = 0
  for (const table of dataTables) {
    let cursor = { useRowId: true, lastRowId: -1, offset: 0 }
    for (;;) {
      const page = await queryTablePage(db, table.name, cursor)
      if (!page.rows.length) break
      cursor = page.nextCursor

      let batch: string[] = []
      let batchChars = 0
      let batchColumns: string[] | null = null
      const flush = async () => {
        if (!batch.length || !batchColumns) return
        const prefix = `INSERT INTO ${ident(table.name)} (${batchColumns.map(ident).join(', ')}) VALUES\n`
        await emit(`${prefix}${batch.join(',\n')};\n`)
        batch = []
        batchChars = 0
      }

      for (const row of page.rows) {
        const columns = Object.keys(row)
        const tuple = `(${columns.map((c) => sqlLiteral(row[c])).join(', ')})`
        if (batchColumns && (batch.length >= INSERT_BATCH_ROWS || batchChars + tuple.length > INSERT_MAX_CHARS || columns.length !== batchColumns.length)) {
          await flush()
        }
        batchColumns = columns
        batch.push(tuple)
        batchChars += tuple.length + 2
        totalRows++
      }
      await flush()
      if (page.rows.length < PAGE_SIZE) break
    }
  }

  const tail = schema.results.filter((row) => row.type !== 'table').map((row) => `${row.sql};`)
  if (tail.length) await emit(`${tail.join('\n')}\n`)
  return { tables: tables.length, rows: totalRows }
}

export async function dumpDatabase(db: D1Database, now = new Date()): Promise<DumpResult> {
  const chunks: string[] = []
  const stats = await streamDatabaseSql(db, (chunk) => {
    chunks.push(chunk)
  }, now)
  return { sql: chunks.join(''), tables: stats.tables, rows: stats.rows }
}

const dayOf = (now: Date) => now.toISOString().slice(0, 10)
export const backupKey = (day: string) => `${BACKUP_PREFIX}${day}.sql.gz`

export interface BackupSummary {
  key: string
  tables: number
  rows: number
  bytes: number
  deleted: string[]
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(total))
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

// 立即导出一次（覆盖当天已有的备份）：分页 SQL 流 → gzip 压缩流 → 达 5 MB 切入 R2 Multipart 分片，小库单次 put
export async function backupDatabase(env: Env, now = new Date(), multipartPartBytes = BACKUP_MULTIPART_BYTES): Promise<BackupSummary> {
  const key = backupKey(dayOf(now))
  const httpMetadata = { contentType: 'application/gzip' }
  const { readable, writable } = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>()
  const compressedStream = (readable as ReadableStream<BufferSource>).pipeThrough(new CompressionStream('gzip'))
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  let stats = { tables: 0, rows: 0 }
  const producer = (async () => {
    try {
      stats = await streamDatabaseSql(
        env.DB,
        async (chunk) => {
          if (chunk.length) await writer.write(new Uint8Array(encoder.encode(chunk)))
        },
        now,
      )
      await writer.close()
    } catch (error) {
      await writer.abort(error).catch(() => {})
      throw error
    }
  })()

  const reader = compressedStream.getReader()
  let pending: Uint8Array[] = []
  let pendingBytes = 0
  let totalBytes = 0
  const mp: { upload: R2MultipartUpload | null; parts: R2UploadedPart[]; partNumber: number } = {
    upload: null,
    parts: [],
    partNumber: 1,
  }
  const customMetadata = () => ({ tables: String(stats.tables), rows: String(stats.rows), createdAt: now.toISOString() })

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value.byteLength) continue
      totalBytes += value.byteLength
      pending.push(value)
      pendingBytes += value.byteLength
      while (pendingBytes > multipartPartBytes) {
        const combined = concatBytes(pending, pendingBytes)
        const part = combined.slice(0, multipartPartBytes)
        const tail = combined.slice(multipartPartBytes)
        pending = tail.byteLength ? [tail] : []
        pendingBytes = tail.byteLength
        if (!mp.upload) {
          mp.upload = await env.MEDIA.createMultipartUpload(key, {
            httpMetadata,
            customMetadata: { createdAt: now.toISOString() },
          })
        }
        mp.parts.push(await mp.upload.uploadPart(mp.partNumber++, part))
      }
    }
    await producer
    const remaining = concatBytes(pending, pendingBytes)
    if (mp.upload) {
      if (remaining.byteLength > 0) mp.parts.push(await mp.upload.uploadPart(mp.partNumber++, remaining))
      await mp.upload.complete(mp.parts)
    } else {
      await env.MEDIA.put(key, remaining, { httpMetadata, customMetadata: customMetadata() })
    }
  } catch (error) {
    if (mp.upload) await mp.upload.abort().catch(() => {})
    throw error
  }

  const cutoff = backupKey(dayOf(new Date(now.getTime() - BACKUP_RETENTION_DAYS * 86400_000)))
  const deleted: string[] = []
  let cursor: string | undefined
  do {
    const page = await env.MEDIA.list({ prefix: BACKUP_PREFIX, cursor })
    // 键里的日期是 YYYY-MM-DD，按字符串比较即按日期比较
    for (const object of page.objects) if (object.key < cutoff) deleted.push(object.key)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  if (deleted.length) await env.MEDIA.delete(deleted)
  return { key, tables: stats.tables, rows: stats.rows, bytes: totalBytes, deleted }
}

// Cron 入口：当天已有备份就跳过；失败记日志并按天给管理员发一次告警
export async function runDailyBackup(env: Env, now = new Date()) {
  const day = dayOf(now)
  if (await env.MEDIA.head(backupKey(day))) return null
  const attemptsKey = `backup:d1:attempts:${day}`
  const attempts = Number((await env.KV.get(attemptsKey)) ?? 0)
  if (attempts >= MAX_ATTEMPTS_PER_DAY) return null
  await env.KV.put(attemptsKey, String(attempts + 1), { expirationTtl: 2 * 86400 })
  try {
    const summary = await backupDatabase(env, now)
    console.log('[backup] d1', JSON.stringify(summary))
    return summary
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[alert] d1 backup failed', message)
    if (attempts + 1 >= MAX_ATTEMPTS_PER_DAY) {
      const alert: Alert = { kind: 'backup_failed', count: attempts + 1, total: null, windowMinutes: 24 * 60, detail: message.slice(0, 300) }
      await sendEmails(
        env,
        adminAlerts(env, `admin_alert:backup_failed:${day}`, () => ({
          template: 'admin_alert',
          params: alert,
        })),
      )
      await notifyAlertChat(env, alert, alertBucket(now.getTime()))
    }
    return null
  }
}
