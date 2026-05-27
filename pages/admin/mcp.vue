<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })

interface TokenAgg { total: number, active: number, revoked: number, neverUsed: number }
interface TopUserRow { userId: number, email: string | null, calls: number, lastSeen: string | null }
interface CallsPerToolRow {
  toolName: string
  total: number
  success: number
  failed: number
  p50: number
  p95: number
}
interface CallsPerDayRow { day: string, toolName: string, count: number, bucket: string }
interface RecentCallRow {
  id: number
  createdAt: string
  userId: number | null
  email: string | null
  toolName: string
  success: boolean
  latencyMs: number | null
  errorCode: string | null
}
interface McpData {
  tokens: TokenAgg
  topUsers: TopUserRow[]
  callsPerTool: CallsPerToolRow[]
  callsPerDay: CallsPerDayRow[]
  topToolNames: string[]
  recentCalls: RecentCallRow[]
}

const data = ref<McpData | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

onMounted(async () => {
  try {
    data.value = await $fetch<McpData>('/api/admin/mcp')
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    loading.value = false
  }
})

const CHART_H = 110
const CHART_W = 600

const TOOL_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#14b8a6', '#f97316', '#94a3b8']

const stackedDays = computed(() => {
  if (!data.value) return null
  const today = new Date()
  const allDays: string[] = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    allDays.push(d.toISOString().slice(0, 10))
  }
  const buckets = [...data.value.topToolNames, 'Autres']

  // day → bucket → count
  const map = new Map<string, Map<string, number>>()
  for (const r of data.value.callsPerDay) {
    if (!map.has(r.day)) map.set(r.day, new Map())
    const m = map.get(r.day)!
    m.set(r.bucket, (m.get(r.bucket) ?? 0) + r.count)
  }
  const barData = allDays.map(day => ({
    day,
    stacks: buckets.map(b => map.get(day)?.get(b) ?? 0),
    total: buckets.reduce((s, b) => s + (map.get(day)?.get(b) ?? 0), 0),
  }))
  const maxTotal = Math.max(...barData.map(b => b.total), 1)
  const pad = 4
  const barW = (CHART_W - pad * 2) / allDays.length - 1
  const barH = CHART_H - 8
  return { barData, maxTotal, pad, barW, barH, buckets }
})

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('fr-FR')
}
function fmtMs(n: number) { return `${n.toLocaleString('fr-FR')} ms` }
</script>

<template>
  <div class="admin-page">
    <h1 class="page-title">MCP — Tokens et appels</h1>

    <div v-if="loading" class="loading">Chargement…</div>
    <div v-else-if="error" class="error">{{ error }}</div>

    <template v-else-if="data">
      <!-- Stat cards -->
      <div class="metrics-grid">
        <div class="stat-card">
          <div class="stat-value">{{ data.tokens.total.toLocaleString('fr-FR') }}</div>
          <div class="stat-label label-mono">Tokens totaux</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ data.tokens.active.toLocaleString('fr-FR') }}</div>
          <div class="stat-label label-mono">Actifs</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ data.tokens.revoked.toLocaleString('fr-FR') }}</div>
          <div class="stat-label label-mono">Révoqués</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ data.tokens.neverUsed.toLocaleString('fr-FR') }}</div>
          <div class="stat-label label-mono">Jamais utilisés</div>
        </div>
      </div>

      <!-- Per-day stacked bar chart -->
      <div class="chart-card">
        <div class="chart-header">
          <span class="chart-title">Appels MCP / jour — 30 derniers jours (top 6 outils + autres)</span>
          <div class="legend">
            <span v-for="(b, i) in (stackedDays?.buckets ?? [])" :key="b" class="legend-item">
              <span class="legend-dot" :style="{ background: TOOL_COLORS[i] ?? '#888' }" />
              {{ b }}
            </span>
          </div>
        </div>
        <template v-if="stackedDays && stackedDays.barData.some(b => b.total > 0)">
          <svg :viewBox="`0 0 ${CHART_W} ${CHART_H}`" class="chart-svg">
            <g v-for="(bar, bi) in stackedDays.barData" :key="bar.day">
              <g v-if="bar.total > 0">
                <template v-for="(val, mi) in bar.stacks" :key="mi">
                  <rect
                    v-if="val > 0"
                    :x="stackedDays.pad + bi * (stackedDays.barW + 1)"
                    :y="stackedDays.barH - stackedDays.barH * (bar.stacks.slice(0, mi + 1).reduce((a, b) => a + b, 0) / stackedDays.maxTotal)"
                    :width="stackedDays.barW"
                    :height="stackedDays.barH * (val / stackedDays.maxTotal)"
                    :fill="TOOL_COLORS[mi] ?? '#888'"
                    opacity="0.85"
                    rx="1"
                  />
                </template>
              </g>
            </g>
          </svg>
          <div class="chart-labels">
            <span>{{ stackedDays.barData[0]?.day }}</span>
            <span>{{ stackedDays.barData[stackedDays.barData.length - 1]?.day }}</span>
          </div>
        </template>
        <div v-else class="chart-empty">Aucun appel MCP sur la période</div>
      </div>

      <!-- Per-tool stats -->
      <section class="section">
        <h2 class="section-title">Appels par outil (90 jours)</h2>
        <table class="data-table">
          <thead>
            <tr>
              <th>Outil</th>
              <th>Total</th>
              <th>Succès</th>
              <th>Échecs</th>
              <th>p50</th>
              <th>p95</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in data.callsPerTool" :key="r.toolName">
              <td class="mono">{{ r.toolName }}</td>
              <td class="mono font-semibold">{{ r.total.toLocaleString('fr-FR') }}</td>
              <td class="mono">{{ r.success.toLocaleString('fr-FR') }}</td>
              <td class="mono" :class="{ 'cell-warn': r.failed > 0 }">{{ r.failed.toLocaleString('fr-FR') }}</td>
              <td class="mono">{{ r.p50 > 0 ? fmtMs(r.p50) : '—' }}</td>
              <td class="mono">{{ r.p95 > 0 ? fmtMs(r.p95) : '—' }}</td>
            </tr>
            <tr v-if="data.callsPerTool.length === 0">
              <td colspan="6" class="empty-cell">Aucune donnée</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- Top users -->
      <section class="section">
        <h2 class="section-title">Top utilisateurs MCP (30 jours)</h2>
        <table class="data-table">
          <thead>
            <tr>
              <th>Utilisateur</th>
              <th>Appels</th>
              <th>Dernière activité</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in data.topUsers" :key="u.userId ?? -1">
              <td>{{ u.email ?? `#${u.userId ?? '—'}` }}</td>
              <td class="mono">{{ u.calls.toLocaleString('fr-FR') }}</td>
              <td class="mono">{{ fmtDate(u.lastSeen) }}</td>
            </tr>
            <tr v-if="data.topUsers.length === 0">
              <td colspan="3" class="empty-cell">Aucune donnée</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- Recent calls -->
      <section class="section">
        <h2 class="section-title">Appels récents (50 derniers)</h2>
        <table class="data-table">
          <thead>
            <tr>
              <th>Horodatage</th>
              <th>Utilisateur</th>
              <th>Outil</th>
              <th>Succès</th>
              <th>Latence</th>
              <th>Code erreur</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in data.recentCalls" :key="c.id">
              <td class="mono">{{ fmtDate(c.createdAt) }}</td>
              <td>{{ c.email ?? '—' }}</td>
              <td class="mono">{{ c.toolName }}</td>
              <td>
                <span class="badge" :class="c.success ? 'badge--ok' : 'badge--err'">
                  {{ c.success ? 'OK' : 'NOK' }}
                </span>
              </td>
              <td class="mono">{{ c.latencyMs != null ? fmtMs(c.latencyMs) : '—' }}</td>
              <td class="mono cell-err">{{ c.errorCode ?? '' }}</td>
            </tr>
            <tr v-if="data.recentCalls.length === 0">
              <td colspan="6" class="empty-cell">Aucun appel enregistré</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
  </div>
</template>

<style scoped>
.admin-page { @apply px-8 py-8 max-w-6xl; }
.page-title { @apply font-serif text-2xl text-ink-900 dark:text-ink-100 mb-6; }
.loading, .error { @apply text-sm text-ink-500 dark:text-ink-400; }

.metrics-grid { @apply grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6; }
.stat-card {
  @apply rounded-lg p-4 border border-ink-200/60 dark:border-ink-800/60;
  background: theme('colors.ink.50');
}
html.dark .stat-card { background: theme('colors.ink.900'); }
.stat-value { @apply font-sans text-2xl font-semibold text-ink-900 dark:text-ink-100 tabular-nums; }
.stat-label { @apply mt-0.5 text-ink-500 dark:text-ink-400; }

.chart-card {
  @apply rounded-lg border border-ink-200/60 dark:border-ink-800/60 p-5 mb-6;
  background: theme('colors.ink.50');
}
html.dark .chart-card { background: theme('colors.ink.900'); }
.chart-header { @apply flex items-start justify-between mb-4 gap-4 flex-wrap; }
.chart-title { @apply font-sans text-[11px] uppercase tracking-[0.08em] font-semibold text-ink-500 dark:text-ink-400; }
.legend { @apply flex flex-wrap gap-3; }
.legend-item { @apply flex items-center gap-1.5 text-xs text-ink-600 dark:text-ink-400 font-mono; }
.legend-dot { @apply w-2.5 h-2.5 rounded-sm shrink-0; }
.chart-svg { @apply w-full; height: 110px; }
.chart-labels { @apply flex justify-between mt-1 font-mono text-[10px] text-ink-400 dark:text-ink-600 tabular-nums; }
.chart-empty { @apply text-sm text-ink-400 dark:text-ink-600 py-6 text-center; }

.section { @apply mb-6; }
.section-title { @apply font-sans text-[11px] uppercase tracking-[0.09em] font-semibold text-ink-500 dark:text-ink-400 mb-3; }
.data-table { @apply w-full text-sm text-left rounded-lg border border-ink-200/60 dark:border-ink-800/60 overflow-hidden; }
.data-table thead { @apply bg-ink-100 dark:bg-ink-900/60; }
.data-table th { @apply px-4 py-2.5 font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400 font-semibold; }
.data-table td { @apply px-4 py-2.5 border-t border-ink-200/50 dark:border-ink-800/50 text-ink-700 dark:text-ink-300; background: theme('colors.ink.50'); }
html.dark .data-table td { background: theme('colors.ink.900'); }
.mono { @apply font-mono text-xs tabular-nums; }
.cell-warn { @apply text-amber-600 dark:text-amber-400; }
.cell-err { @apply text-red-600 dark:text-red-400; }
.badge { @apply inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide; }
.badge--ok { @apply bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400; }
.badge--err { @apply bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400; }
.empty-cell { @apply text-center py-8 text-sm text-ink-400 dark:text-ink-600; }
</style>
