<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })

interface TodayStats { success: number, failed: number }
interface WeekRow { day: string, success: number, failed: number }
interface SuspiciousRow { email: string, failCount: number, lastAttempt: string, lastIp: string | null }
interface RecentFailureRow {
  id: number
  createdAt: string
  email: string
  errorCode: string | null
  ipAddress: string | null
}
interface AuditResetRow {
  id: number
  createdAt: string
  action: string
  adminId: number
  adminEmail: string | null
  targetType: string | null
  targetId: number | null
}
interface SecurityData {
  today: TodayStats
  week: WeekRow[]
  suspicious: SuspiciousRow[]
  recentFailures: RecentFailureRow[]
  adminResets: AuditResetRow[]
}

const data = ref<SecurityData | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

onMounted(async () => {
  try {
    data.value = await $fetch<SecurityData>('/api/admin/security')
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    loading.value = false
  }
})

/* ---- Chart ---- */
const CHART_H = 110
const CHART_W = 600
const COLORS = { success: '#10b981', failed: '#ef4444' }

const chart = computed(() => {
  if (!data.value) return null
  const today = new Date()
  const days: string[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    days.push(d.toISOString().slice(0, 10))
  }
  const map = new Map(data.value.week.map(r => [r.day, r]))
  const barData = days.map(day => {
    const r = map.get(day)
    return {
      day,
      success: r?.success ?? 0,
      failed: r?.failed ?? 0,
      total: (r?.success ?? 0) + (r?.failed ?? 0),
    }
  })
  const maxTotal = Math.max(...barData.map(b => b.total), 1)
  const pad = 4
  const barW = (CHART_W - pad * 2) / days.length - 2
  const barH = CHART_H - 8
  return { barData, maxTotal, pad, barW, barH }
})

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('fr-FR')
}
</script>

<template>
  <div class="admin-page">
    <h1 class="page-title">Sécurité — Connexions</h1>

    <div v-if="loading" class="loading">Chargement…</div>
    <div v-else-if="error" class="error">{{ error }}</div>

    <template v-else-if="data">
      <!-- Cards -->
      <div class="metrics-grid">
        <div class="stat-card">
          <div class="stat-value stat-value--ok">{{ data.today.success.toLocaleString('fr-FR') }}</div>
          <div class="stat-label label-mono">Connexions réussies (aujourd'hui)</div>
        </div>
        <div class="stat-card" :class="{ 'stat-card--warn': data.today.failed >= 10 }">
          <div class="stat-value stat-value--err">{{ data.today.failed.toLocaleString('fr-FR') }}</div>
          <div class="stat-label label-mono">Échecs (aujourd'hui)</div>
        </div>
        <div class="stat-card" :class="{ 'stat-card--warn': data.suspicious.length > 0 }">
          <div class="stat-value">{{ data.suspicious.length.toLocaleString('fr-FR') }}</div>
          <div class="stat-label label-mono">Comptes suspects (24h)</div>
        </div>
      </div>

      <!-- 7-day chart -->
      <div class="chart-card">
        <div class="chart-header">
          <span class="chart-title">Connexions — 7 derniers jours</span>
          <div class="legend">
            <span class="legend-item">
              <span class="legend-dot" :style="{ background: COLORS.success }" /> Succès
            </span>
            <span class="legend-item">
              <span class="legend-dot" :style="{ background: COLORS.failed }" /> Échecs
            </span>
          </div>
        </div>
        <template v-if="chart && chart.barData.some(b => b.total > 0)">
          <svg :viewBox="`0 0 ${CHART_W} ${CHART_H}`" class="chart-svg">
            <g v-for="(bar, bi) in chart.barData" :key="bar.day">
              <g v-if="bar.total > 0">
                <rect
                  v-if="bar.success > 0"
                  :x="chart.pad + bi * (chart.barW + 2)"
                  :y="chart.barH - chart.barH * (bar.success / chart.maxTotal)"
                  :width="chart.barW"
                  :height="chart.barH * (bar.success / chart.maxTotal)"
                  :fill="COLORS.success"
                  opacity="0.85"
                  rx="1"
                />
                <rect
                  v-if="bar.failed > 0"
                  :x="chart.pad + bi * (chart.barW + 2)"
                  :y="chart.barH - chart.barH * ((bar.success + bar.failed) / chart.maxTotal)"
                  :width="chart.barW"
                  :height="chart.barH * (bar.failed / chart.maxTotal)"
                  :fill="COLORS.failed"
                  opacity="0.85"
                  rx="1"
                />
              </g>
            </g>
          </svg>
          <div class="chart-labels">
            <span v-for="b in chart.barData" :key="b.day">{{ b.day.slice(5) }}</span>
          </div>
        </template>
        <div v-else class="chart-empty">Aucune connexion sur la période</div>
      </div>

      <!-- Suspicious -->
      <section class="section">
        <h2 class="section-title">Activité suspecte (≥ 5 échecs / fenêtre de 60 min, 24h)</h2>
        <table class="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Échecs (fenêtre)</th>
              <th>Dernière tentative</th>
              <th>Dernière IP</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in data.suspicious" :key="r.email">
              <td class="mono cell-err">{{ r.email }}</td>
              <td class="mono font-semibold">{{ r.failCount.toLocaleString('fr-FR') }}</td>
              <td class="mono">{{ fmtDate(r.lastAttempt) }}</td>
              <td class="mono">{{ r.lastIp ?? '—' }}</td>
            </tr>
            <tr v-if="data.suspicious.length === 0">
              <td colspan="4" class="empty-cell">Aucune activité suspecte détectée</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- Recent failures -->
      <section class="section">
        <h2 class="section-title">Échecs récents (100 derniers)</h2>
        <table class="data-table">
          <thead>
            <tr>
              <th>Horodatage</th>
              <th>Email</th>
              <th>Code erreur</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in data.recentFailures" :key="r.id">
              <td class="mono">{{ fmtDate(r.createdAt) }}</td>
              <td>{{ r.email }}</td>
              <td class="mono cell-err">{{ r.errorCode ?? '—' }}</td>
              <td class="mono">{{ r.ipAddress ?? '—' }}</td>
            </tr>
            <tr v-if="data.recentFailures.length === 0">
              <td colspan="4" class="empty-cell">Aucun échec enregistré</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- Admin password resets -->
      <section class="section">
        <h2 class="section-title">Réinitialisations admin (audit)</h2>
        <table class="data-table">
          <thead>
            <tr>
              <th>Horodatage</th>
              <th>Admin</th>
              <th>Action</th>
              <th>Cible</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in data.adminResets" :key="r.id">
              <td class="mono">{{ fmtDate(r.createdAt) }}</td>
              <td>{{ r.adminEmail ?? `#${r.adminId}` }}</td>
              <td class="mono">{{ r.action }}</td>
              <td class="mono">{{ r.targetType ?? '' }}{{ r.targetId != null ? `#${r.targetId}` : '' }}</td>
            </tr>
            <tr v-if="data.adminResets.length === 0">
              <td colspan="4" class="empty-cell">Aucune réinitialisation enregistrée</td>
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

.metrics-grid { @apply grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6; }
.stat-card {
  @apply rounded-lg p-4 border border-ink-200/60 dark:border-ink-800/60;
  background: theme('colors.ink.50');
}
html.dark .stat-card { background: theme('colors.ink.900'); }
.stat-card--warn { @apply border-amber-300 dark:border-amber-700; background: theme('colors.amber.50'); }
html.dark .stat-card--warn { background: theme('colors.amber.900' / 20%); }
.stat-value { @apply font-sans text-2xl font-semibold text-ink-900 dark:text-ink-100 tabular-nums; }
.stat-value--ok { @apply text-green-600 dark:text-green-400; }
.stat-value--err { @apply text-red-600 dark:text-red-400; }
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
.cell-err { @apply text-red-600 dark:text-red-400; }
.empty-cell { @apply text-center py-8 text-sm text-ink-400 dark:text-ink-600; }
</style>
