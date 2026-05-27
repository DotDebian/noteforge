import { defineEventHandler } from 'h3'
import { getRawDb } from '~/server/database/client'
import { requireAdmin } from '~/server/utils/require-admin'

interface ToolStatRaw {
  toolName: string
  total: number
  success: number
  failed: number
}
interface ToolLatencyRaw {
  toolName: string
  latencyMs: number
}
interface TopUserRow {
  userId: number
  email: string
  calls: number
  lastSeen: number | null
}
interface PerDayRow {
  day: string
  toolName: string
  count: number
}
interface RecentCallRow {
  id: number
  createdAt: number
  userId: number | null
  email: string | null
  toolName: string
  success: number
  latencyMs: number | null
  errorCode: string | null
}

function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0
  const idx = Math.min(sortedAsc.length - 1, Math.floor(q * sortedAsc.length))
  return sortedAsc[idx] ?? 0
}

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = getRawDb()

  /* ---- Token aggregates ---- */
  const tokenAgg = db.prepare(
    `SELECT
       count(*) AS total,
       sum(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active,
       sum(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked,
       sum(CASE WHEN last_used_at IS NULL AND revoked_at IS NULL THEN 1 ELSE 0 END) AS neverUsed
     FROM mcp_tokens`,
  ).get() as { total: number, active: number, revoked: number, neverUsed: number }

  /* ---- Top users (last 30 days) ---- */
  const topUsers = db.prepare(
    `SELECT l.user_id AS userId,
            u.email AS email,
            count(*) AS calls,
            max(l.created_at) AS lastSeen
     FROM mcp_call_logs l
     LEFT JOIN users u ON u.id = l.user_id
     WHERE l.created_at >= unixepoch('now', '-30 days')
     GROUP BY l.user_id
     ORDER BY calls DESC
     LIMIT 20`,
  ).all() as TopUserRow[]

  /* ---- Per-tool stats (last 90 days) ---- */
  const toolStatsRaw = db.prepare(
    `SELECT tool_name AS toolName,
            count(*) AS total,
            sum(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success,
            sum(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed
     FROM mcp_call_logs
     WHERE created_at >= unixepoch('now', '-90 days')
     GROUP BY tool_name
     ORDER BY total DESC`,
  ).all() as ToolStatRaw[]

  const toolLatencies = db.prepare(
    `SELECT tool_name AS toolName, latency_ms AS latencyMs
     FROM mcp_call_logs
     WHERE created_at >= unixepoch('now', '-90 days')
       AND latency_ms IS NOT NULL`,
  ).all() as ToolLatencyRaw[]

  const latencyMap = new Map<string, number[]>()
  for (const row of toolLatencies) {
    const arr = latencyMap.get(row.toolName) ?? []
    arr.push(row.latencyMs)
    latencyMap.set(row.toolName, arr)
  }
  for (const arr of latencyMap.values()) arr.sort((a, b) => a - b)

  const callsPerTool = toolStatsRaw.map(t => {
    const arr = latencyMap.get(t.toolName) ?? []
    return {
      toolName: t.toolName,
      total: t.total,
      success: t.success,
      failed: t.failed,
      p50: percentile(arr, 0.5),
      p95: percentile(arr, 0.95),
    }
  })

  /* ---- Per day, stacked by top tools (last 30 days) ---- */
  const perDayRaw = db.prepare(
    `SELECT date(created_at, 'unixepoch') AS day,
            tool_name AS toolName,
            count(*) AS count
     FROM mcp_call_logs
     WHERE created_at >= unixepoch('now', '-30 days')
     GROUP BY day, tool_name
     ORDER BY day`,
  ).all() as PerDayRow[]

  const topToolNames = callsPerTool.slice(0, 6).map(t => t.toolName)
  const callsPerDay = perDayRaw.map(r => ({
    ...r,
    bucket: topToolNames.includes(r.toolName) ? r.toolName : 'Autres',
  }))

  /* ---- Recent calls ---- */
  const recentCalls = db.prepare(
    `SELECT l.id, l.created_at AS createdAt,
            l.user_id AS userId, u.email AS email,
            l.tool_name AS toolName, l.success, l.latency_ms AS latencyMs,
            l.error_code AS errorCode
     FROM mcp_call_logs l
     LEFT JOIN users u ON u.id = l.user_id
     ORDER BY l.created_at DESC
     LIMIT 50`,
  ).all() as RecentCallRow[]

  return {
    tokens: tokenAgg,
    topUsers: topUsers.map(u => ({
      ...u,
      lastSeen: u.lastSeen ? new Date(u.lastSeen * 1000).toISOString() : null,
    })),
    callsPerTool,
    callsPerDay,
    topToolNames,
    recentCalls: recentCalls.map(c => ({
      ...c,
      success: c.success === 1,
      createdAt: new Date(c.createdAt * 1000).toISOString(),
    })),
  }
})
