import { defineEventHandler } from 'h3'
import { getRawDb } from '~/server/database/client'
import { requireAdmin } from '~/server/utils/require-admin'

/* -------------------------------------------------------------------------- */
/*  Pricing (USD per 1M tokens). EUR = USD * 0.93. Coarse signal only.        */
/* -------------------------------------------------------------------------- */

const USD_PER_M_BY_MODEL: Record<string, number> = {
  'mistral-embed': 0.10,
  'mistral-small-latest': 0.20,
  'mistral-large-latest': 2,
  'mistral-ocr-latest': 1,
}
const USD_TO_EUR = 0.93

function costEurFor(model: string, totalTokens: number): number {
  const usdPerM = USD_PER_M_BY_MODEL[model] ?? 0
  return (totalTokens / 1_000_000) * usdPerM * USD_TO_EUR
}

/* -------------------------------------------------------------------------- */

export interface AdminStatsResponse {
  totals: {
    users: number
    workspaces: number
    documents: number
    folders: number
    chunks: number
  }
  signupsPerDay: Array<{ day: string, count: number }>
  activeUsers: {
    day: number
    week: number
    month: number
  }
  topUsersByTokens: Array<{
    userId: number
    email: string
    displayName: string | null
    totalTokens: number
    costEur: number
  }>
  topUsersByDocs: Array<{
    userId: number
    email: string
    displayName: string | null
    docs: number
    workspaces: number
  }>
  languages: Array<{ language: string, count: number }>
  topTags: Array<{ tag: string, count: number }>
  cohorts: {
    weeks: string[]
    /** rows = cohort weeks, cols = week offsets, value = distinct active users from cohort that week. */
    data: number[][]
    /** size of each cohort (denominator for percent), parallel to weeks. */
    sizes: number[]
  }
}

export default defineEventHandler(async (event): Promise<AdminStatsResponse> => {
  await requireAdmin(event)
  const db = getRawDb()

  /* ---------- Existing totals + signups (preserved) ---------------------- */

  const usersCount = (db.prepare('SELECT count(*) AS cnt FROM users').get() as { cnt: number }).cnt
  const wsCount = (db.prepare('SELECT count(*) AS cnt FROM workspaces').get() as { cnt: number }).cnt
  const docsCount = (db.prepare('SELECT count(*) AS cnt FROM documents WHERE deleted_at IS NULL').get() as { cnt: number }).cnt
  const foldersCount = (db.prepare('SELECT count(*) AS cnt FROM folders WHERE deleted_at IS NULL').get() as { cnt: number }).cnt
  const chunksCount = (db.prepare('SELECT count(*) AS cnt FROM doc_chunks').get() as { cnt: number }).cnt

  const signupsPerDay = db.prepare(
    `SELECT date(created_at, 'unixepoch') AS day, count(*) AS cnt
     FROM users
     WHERE created_at >= unixepoch('now', '-30 days')
     GROUP BY day ORDER BY day`,
  ).all() as Array<{ day: string, cnt: number }>

  /* ---------- DAU / WAU / MAU ------------------------------------------- */

  const activeQuery = (days: number) => db.prepare(
    `SELECT count(DISTINCT user_id) AS cnt FROM (
       SELECT user_id FROM ai_usage_logs
       WHERE user_id IS NOT NULL AND created_at >= unixepoch('now', '-${days} days')
       UNION
       SELECT user_id FROM chat_sessions
       WHERE created_at >= unixepoch('now', '-${days} days')
       UNION
       SELECT id AS user_id FROM users
       WHERE last_login_at IS NOT NULL AND last_login_at >= unixepoch('now', '-${days} days')
     )`,
  ).get() as { cnt: number }

  const dau = activeQuery(1).cnt
  const wau = activeQuery(7).cnt
  const mau = activeQuery(30).cnt

  /* ---------- Top users by tokens (90 days) ----------------------------- */

  type TokensRow = {
    userId: number
    email: string
    displayName: string | null
    model: string
    totalTokens: number
  }
  const tokensRows = db.prepare(
    `SELECT u.id AS userId, u.email, u.display_name AS displayName,
            l.model AS model, sum(l.total_tokens) AS totalTokens
     FROM ai_usage_logs l
     JOIN users u ON u.id = l.user_id
     WHERE l.created_at >= unixepoch('now', '-90 days')
     GROUP BY u.id, l.model`,
  ).all() as TokensRow[]

  const byUserTokens = new Map<number, { userId: number, email: string, displayName: string | null, totalTokens: number, costEur: number }>()
  for (const r of tokensRows) {
    const cur = byUserTokens.get(r.userId) ?? { userId: r.userId, email: r.email, displayName: r.displayName, totalTokens: 0, costEur: 0 }
    cur.totalTokens += r.totalTokens
    cur.costEur += costEurFor(r.model, r.totalTokens)
    byUserTokens.set(r.userId, cur)
  }
  const topUsersByTokens = [...byUserTokens.values()]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 10)
    .map(u => ({ ...u, costEur: Number(u.costEur.toFixed(4)) }))

  /* ---------- Top users by docs ----------------------------------------- */

  const topUsersByDocs = db.prepare(
    `SELECT u.id AS userId, u.email, u.display_name AS displayName,
            count(d.id) AS docs,
            count(DISTINCT w.id) AS workspaces
     FROM users u
     JOIN workspaces w ON w.owner_id = u.id
     LEFT JOIN documents d ON d.workspace_id = w.id AND d.deleted_at IS NULL
     GROUP BY u.id
     ORDER BY docs DESC
     LIMIT 10`,
  ).all() as Array<{
    userId: number
    email: string
    displayName: string | null
    docs: number
    workspaces: number
  }>

  /* ---------- Languages distribution ------------------------------------ */

  const languages = (db.prepare(
    `SELECT language, count(*) AS cnt
     FROM doc_analyses
     WHERE language IS NOT NULL AND language <> ''
     GROUP BY language
     ORDER BY cnt DESC
     LIMIT 10`,
  ).all() as Array<{ language: string, cnt: number }>).map(r => ({ language: r.language, count: r.cnt }))

  /* ---------- Top tags (parse JSON in JS) ------------------------------- */

  const tagRows = db.prepare(
    `SELECT tags FROM doc_analyses WHERE tags IS NOT NULL AND tags <> '' AND tags <> '[]'`,
  ).all() as Array<{ tags: string }>

  const tagCounts = new Map<string, number>()
  for (const row of tagRows) {
    try {
      const parsed = JSON.parse(row.tags) as unknown
      if (Array.isArray(parsed)) {
        for (const t of parsed) {
          if (typeof t !== 'string') continue
          const norm = t.trim()
          if (!norm) continue
          tagCounts.set(norm, (tagCounts.get(norm) ?? 0) + 1)
        }
      }
    }
    catch {
      // Encrypted or malformed JSON: skip silently. Tag aggregation is best-effort.
    }
  }
  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([tag, count]) => ({ tag, count }))

  /* ---------- Cohort retention heatmap ---------------------------------- */

  type CohortRow = { signupWeek: string, activeWeek: string, cnt: number }
  const cohortRows = db.prepare(
    `WITH signup_weeks AS (
       SELECT id, strftime('%Y-%W', datetime(created_at, 'unixepoch')) AS signup_week
       FROM users WHERE created_at >= unixepoch('now', '-84 days')
     ),
     activity AS (
       SELECT DISTINCT user_id, strftime('%Y-%W', datetime(created_at, 'unixepoch')) AS active_week
       FROM ai_usage_logs WHERE user_id IS NOT NULL
       UNION
       SELECT DISTINCT user_id, strftime('%Y-%W', datetime(created_at, 'unixepoch')) AS active_week
       FROM chat_sessions
       UNION
       SELECT id AS user_id, strftime('%Y-%W', datetime(last_login_at, 'unixepoch')) AS active_week
       FROM users WHERE last_login_at IS NOT NULL
     )
     SELECT sw.signup_week AS signupWeek, a.active_week AS activeWeek,
            count(DISTINCT sw.id) AS cnt
     FROM signup_weeks sw
     JOIN activity a ON a.user_id = sw.id
     GROUP BY sw.signup_week, a.active_week`,
  ).all() as CohortRow[]

  // Cohort sizes (denominator)
  const cohortSizesRows = db.prepare(
    `SELECT strftime('%Y-%W', datetime(created_at, 'unixepoch')) AS signupWeek,
            count(*) AS cnt
     FROM users WHERE created_at >= unixepoch('now', '-84 days')
     GROUP BY signupWeek`,
  ).all() as Array<{ signupWeek: string, cnt: number }>
  const cohortSize = new Map(cohortSizesRows.map(r => [r.signupWeek, r.cnt]))

  // Build the last 12 ISO-ish weeks of cohorts (oldest first), then build matrix.
  function weekKey(d: Date): string {
    // strftime('%Y-%W') -> %W is week-of-year (00..53), week starts Monday-equivalent (SQLite: 0-based, Sunday-start).
    // Mirror that here: ((dayOfYear + 7 - sundayWeekday) / 7) % rendering — simplest equivalent: replicate SQLite formula.
    const year = d.getUTCFullYear()
    // Day-of-year (0-based)
    const start = Date.UTC(year, 0, 1)
    const diffDays = Math.floor((d.getTime() - start) / 86400000)
    // SQLite %W: weeks start on Monday-of-week-of-year, but actually it's days-since-first-Sunday-divided-by-7 floor.
    // Implement: ((diffDays + 7 - dow(jan1)) / 7) ... but in fact: %W = (julian - julian_of_first_monday_of_year + 7) / 7 floored — close enough for cohort buckets.
    // Use a stable bucket: ISO week number is fine; the heatmap cares about relative ordering, not the spec.
    // Use simple: floor((diffDays + janFirstWeekday) / 7), where janFirstWeekday is days from Sunday.
    const jan1 = new Date(Date.UTC(year, 0, 1))
    const janWeekday = jan1.getUTCDay() // 0=Sunday
    const week = Math.floor((diffDays + janWeekday) / 7)
    return `${year}-${week.toString().padStart(2, '0')}`
  }

  // Build the 12 most recent cohort weeks ending this week.
  const now = new Date()
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const weeks: string[] = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(todayUtc)
    d.setUTCDate(d.getUTCDate() - i * 7)
    weeks.push(weekKey(d))
  }

  const weekIndex = new Map(weeks.map((w, i) => [w, i] as const))
  // Matrix [cohortRowIdx][offsetCol] = count.
  const data: number[][] = weeks.map(() => Array<number>(12).fill(0))
  for (const r of cohortRows) {
    const ri = weekIndex.get(r.signupWeek)
    const ci = weekIndex.get(r.activeWeek)
    if (ri === undefined || ci === undefined) continue
    const offset = ci - ri
    if (offset < 0 || offset >= 12) continue
    const row = data[ri]
    if (row) row[offset] = r.cnt
  }
  const sizes = weeks.map(w => cohortSize.get(w) ?? 0)

  return {
    totals: {
      users: usersCount,
      workspaces: wsCount,
      documents: docsCount,
      folders: foldersCount,
      chunks: chunksCount,
    },
    signupsPerDay: signupsPerDay.map(r => ({ day: r.day, count: r.cnt })),
    activeUsers: { day: dau, week: wau, month: mau },
    topUsersByTokens,
    topUsersByDocs,
    languages,
    topTags,
    cohorts: { weeks, data, sizes },
  }
})
