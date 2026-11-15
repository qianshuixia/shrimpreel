// scripts/restore-d1.mjs 的类型声明，供 tests/unit/backup.test.ts 引用
export function splitSqlStatements(sql: string): string[]
export function buildRestoreChunks(statements: string[], options?: { maxBytes?: number; maxStatements?: number }): string[]
export function summarizeDump(sql: string): { tables: string[]; rows: Record<string, number>; header: string }
