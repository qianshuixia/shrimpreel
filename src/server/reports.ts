// 后台经营报表：收入（按天/来源/国家/支付商/套餐）、注册漏斗、按来源的转化、退款率、订单 CSV 导出。
// 金额一律按实收币种汇总净额（实收 − 已退），见 NET_CENTS。
import type { Hono } from 'hono'
import type { AppContext } from './types'

const NET_CENTS = 'COALESCE(paid_amount_cents, amount_cents) - refunded_amount_cents'
const CURRENCY = 'COALESCE(paid_currency, currency)'
const PAID = `status IN ('paid', 'refunded')`

function sinceFor(daysParam: string | undefined) {
  const days = Math.min(365, Math.max(1, Number.parseInt(daysParam ?? '30', 10) || 30))
  const since = new Date(Date.now() - days * 86400_000)
  return { days, since: since.toISOString(), sinceDay: since.toISOString().slice(0, 10) }
}

function groupedRevenue(db: D1Database, column: string, since: string) {
  return db
    .prepare(
      `SELECT ${column} AS key, ${CURRENCY} AS currency, COUNT(*) AS orders, SUM(${NET_CENTS}) AS cents,
       SUM(refunded_amount_cents) AS refunded_cents
       FROM orders WHERE ${PAID} AND paid_at >= ? GROUP BY 1, 2 ORDER BY cents DESC LIMIT 50`,
    )
    .bind(since)
}

export function registerReportRoutes(routes: Hono<AppContext>) {
  routes.get('/reports', async (c) => {
    const db = c.env.DB
    const { days, since, sinceDay } = sinceFor(c.req.query('days'))
    const [daily, bySource, byCountry, byProvider, byPackage, visits, visitsBySource, signupsBySource, funnel, refunds] =
      await db.batch([
        db
          .prepare(
            `SELECT substr(paid_at, 1, 10) AS day, ${CURRENCY} AS currency, COUNT(*) AS orders, SUM(${NET_CENTS}) AS cents
             FROM orders WHERE ${PAID} AND paid_at >= ? GROUP BY 1, 2 ORDER BY 1`,
          )
          .bind(since),
        groupedRevenue(db, `COALESCE(source, 'unknown') || ' / ' || COALESCE(medium, 'unknown')`, since),
        groupedRevenue(db, `COALESCE(country, 'unknown')`, since),
        groupedRevenue(db, 'provider', since),
        groupedRevenue(db, 'package_id', since),
        db.prepare('SELECT COALESCE(SUM(visits), 0) AS n FROM visit_stats WHERE day >= ?').bind(sinceDay),
        db
          .prepare(
            `SELECT source || ' / ' || medium AS key, SUM(visits) AS n FROM visit_stats WHERE day >= ?
             GROUP BY 1 ORDER BY n DESC LIMIT 50`,
          )
          .bind(sinceDay),
        db
          .prepare(
            `SELECT COALESCE(signup_source, 'unknown') || ' / ' || COALESCE(signup_medium, 'unknown') AS key, COUNT(*) AS n
             FROM users WHERE created_at >= ? GROUP BY 1 ORDER BY n DESC LIMIT 50`,
          )
          .bind(since),
        // 注册队列漏斗：窗口内新注册用户先收口为 cohort（仅走 idx_users_created），再按索引关联订单与生成（CROSS JOIN 锁定连接方向，禁止反扫全表）
        db
          .prepare(
            `WITH cohort AS MATERIALIZED (SELECT id FROM users WHERE created_at >= ?),
             user_orders AS (
               SELECT o.user_id, MAX(o.status IN ('paid', 'refunded')) AS has_paid
               FROM cohort c CROSS JOIN orders o
               WHERE o.user_id = c.id
               GROUP BY o.user_id
             ),
             user_gens AS (
               SELECT g.user_id
               FROM cohort c CROSS JOIN generations g
               WHERE g.user_id = c.id
               GROUP BY g.user_id
             )
             SELECT
               COUNT(*) AS signups,
               COALESCE(SUM(uo.user_id IS NOT NULL), 0) AS checkout,
               COALESCE(SUM(uo.has_paid), 0) AS paid,
               COALESCE(SUM(ug.user_id IS NOT NULL), 0) AS generated
             FROM cohort c
             LEFT JOIN user_orders uo ON uo.user_id = c.id
             LEFT JOIN user_gens ug ON ug.user_id = c.id`,
          )
          .bind(since),
        db
          .prepare(
            `SELECT ${CURRENCY} AS currency, SUM(COALESCE(paid_amount_cents, amount_cents)) AS gross_cents,
               SUM(refunded_amount_cents) AS refunded_cents, SUM(CASE WHEN refunded_amount_cents > 0 THEN 1 ELSE 0 END) AS refunded_orders,
               COUNT(*) AS orders
             FROM orders WHERE ${PAID} AND paid_at >= ? GROUP BY 1`,
          )
          .bind(since),
      ])

    // 按来源的转化表：访问（会话）→ 注册（首次触达）→ 付费订单（最近触达）
    const paidBySource = new Map<string, { orders: number; cents: Record<string, number> }>()
    for (const row of bySource!.results as Array<{ key: string; currency: string; orders: number; cents: number }>) {
      const entry = paidBySource.get(row.key) ?? { orders: 0, cents: {} }
      entry.orders += row.orders
      entry.cents[row.currency] = (entry.cents[row.currency] ?? 0) + row.cents
      paidBySource.set(row.key, entry)
    }
    const sources = new Map<string, { key: string; visits: number; signups: number; orders: number; cents: Record<string, number> }>()
    const sourceRow = (key: string) => {
      let row = sources.get(key)
      if (!row) sources.set(key, (row = { key, visits: 0, signups: 0, orders: 0, cents: {} }))
      return row
    }
    for (const row of visitsBySource!.results as Array<{ key: string; n: number }>) sourceRow(row.key).visits = row.n
    for (const row of signupsBySource!.results as Array<{ key: string; n: number }>) sourceRow(row.key).signups = row.n
    for (const [key, value] of paidBySource) Object.assign(sourceRow(key), { orders: value.orders, cents: value.cents })

    const f = (funnel!.results[0] ?? {}) as Record<string, number | null>
    return c.json({
      days,
      since,
      funnel: {
        visits: Number((visits!.results[0] as { n?: number } | undefined)?.n ?? 0),
        signups: Number(f.signups ?? 0),
        checkout: Number(f.checkout ?? 0),
        paid: Number(f.paid ?? 0),
        generated: Number(f.generated ?? 0),
      },
      daily: daily!.results,
      sources: [...sources.values()].sort((a, b) => b.orders - a.orders || b.signups - a.signups || b.visits - a.visits),
      byCountry: byCountry!.results,
      byProvider: byProvider!.results,
      byPackage: byPackage!.results,
      refunds: refunds!.results,
    })
  })

  routes.get('/orders.csv', async (c) => {
    const { since } = sinceFor(c.req.query('days'))
    const rows = await c.env.DB.prepare(
      `SELECT o.id, u.email, o.provider, o.package_id, o.credits, o.amount_cents, o.currency, o.status,
         o.paid_amount_cents, o.paid_currency, o.refunded_amount_cents, o.refunded_credits,
         o.source, o.medium, o.campaign, o.country, o.device, o.provider_payment_id, o.created_at, o.paid_at, o.refunded_at
       FROM orders o JOIN users u ON u.id = o.user_id WHERE o.created_at >= ? ORDER BY o.created_at DESC LIMIT 10000`,
    )
      .bind(since)
      .all<Record<string, unknown>>()
    const columns = rows.results[0] ? Object.keys(rows.results[0]) : ['id']
    const csv = [columns.join(','), ...rows.results.map((row) => columns.map((col) => csvCell(row[col])).join(','))].join('\r\n')
    return c.body(`\uFEFF${csv}\r\n`, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`,
    })
  })
}

export function csvCell(value: unknown) {
  if (value === null || value === undefined) return ''
  let text = String(value)
  // 防 CSV 公式注入（Excel 会执行 = + - @ 开头的单元格）；数字列（含负数）原样输出
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
