<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })

interface Stats {
  totals: {
    users: number
    workspaces: number
    documents: number
    folders: number
    chunks: number
  }
  signupsPerDay: Array<{ day: string, count: number }>
  activeUsers: { day: number, week: number, month: number }
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
    data: number[][]
    sizes: number[]
  }
}

const stats = ref<Stats | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

onMounted(async () => {
  try {
    stats.value = await $fetch<Stats>('/api/admin/stats')
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    loading.value = false
  }
})

/* ---------- Sparkline chart for signups ----------------------------------- */
const CHART_H = 80
const CHART_W = 560

const chartData = computed(() => {
  if (!stats.value?.signupsPerDay) return null
  const raw = stats.value.signupsPerDay

  // Fill in missing days in the last 30 days
  const days: string[] = []
  const today = new Date()
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    days.push(d.toISOString().slice(0, 10))
  }

  const map = new Map(raw.map(r => [r.day, r.count]))
  const values = days.map(d => map.get(d) ?? 0)

  const maxVal = Math.max(...values, 1)
  const padLeft = 8
  const padRight = 8
  const w = CHART_W - padLeft - padRight

  const points = values.map((v, i) => {
    const x = padLeft + (i / (values.length - 1)) * w
    const y = CHART_H - 4 - ((v / maxVal) * (CHART_H - 12))
    return { x, y, v, day: days[i]! }
  })

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ')

  const areaD = `${pathD} L ${points[points.length - 1]!.x.toFixed(1)} ${CHART_H} L ${points[0]!.x.toFixed(1)} ${CHART_H} Z`

  return { points, pathD, areaD, maxVal, days }
})

const metrics = computed(() => {
  if (!stats.value) return []
  const t = stats.value.totals
  return [
    { label: 'Utilisateurs', value: t.users },
    { label: 'Espaces de travail', value: t.workspaces },
    { label: 'Documents', value: t.documents },
    { label: 'Dossiers', value: t.folders },
    { label: 'Chunks vectorisés', value: t.chunks },
  ]
})

const activeMetrics = computed(() => {
  if (!stats.value) return []
  const a = stats.value.activeUsers
  return [
    { label: 'Actifs / jour (DAU)', value: a.day },
    { label: 'Actifs / semaine (WAU)', value: a.week },
    { label: 'Actifs / mois (MAU)', value: a.month },
  ]
})

/* ---------- Languages bar ------------------------------------------------ */
const languagesMax = computed(() => {
  if (!stats.value) return 1
  return Math.max(1, ...stats.value.languages.map(l => l.count))
})

const languagesTotal = computed(() => {
  if (!stats.value) return 0
  return stats.value.languages.reduce((acc, l) => acc + l.count, 0)
})

/* ---------- Tag cloud ---------------------------------------------------- */
const tagsMax = computed(() => {
  if (!stats.value) return 1
  return Math.max(1, ...stats.value.topTags.map(t => t.count))
})
const tagsMin = computed(() => {
  if (!stats.value || stats.value.topTags.length === 0) return 1
  return Math.max(1, Math.min(...stats.value.topTags.map(t => t.count)))
})

function tagSizeRem(count: number): string {
  const max = tagsMax.value
  const min = tagsMin.value
  if (max === min) return '0.9rem'
  const ratio = (count - min) / (max - min)
  const rem = 0.78 + ratio * 0.7 // 0.78rem to 1.48rem
  return `${rem.toFixed(2)}rem`
}

/* ---------- Cohort heatmap ----------------------------------------------- */
const cohortMax = computed(() => {
  if (!stats.value) return 1
  let m = 0
  for (let r = 0; r < stats.value.cohorts.data.length; r++) {
    const row = stats.value.cohorts.data[r]
    const size = stats.value.cohorts.sizes[r] ?? 0
    if (!row || size === 0) continue
    for (let c = 0; c < row.length; c++) {
      const v = row[c] ?? 0
      const pct = v / size
      if (pct > m) m = pct
    }
  }
  return m || 1
})

function cohortCellPct(row: number, col: number): number {
  if (!stats.value) return 0
  const size = stats.value.cohorts.sizes[row] ?? 0
  if (size === 0) return 0
  const r = stats.value.cohorts.data[row]
  if (!r) return 0
  return (r[col] ?? 0) / size
}

function cohortCellStyle(row: number, col: number): Record<string, string> {
  if (!stats.value) return {}
  const size = stats.value.cohorts.sizes[row] ?? 0
  const r = stats.value.cohorts.data[row]
  if (!r) return { opacity: '0' }
  if (size === 0) return { opacity: '0' }
  // Cells outside the realisable triangle (offset beyond now-cohort) get neutral background.
  const value = r[col] ?? 0
  if (value === 0) {
    return { background: 'transparent' }
  }
  const pct = value / size / cohortMax.value
  // accent-500 with variable opacity
  const opacity = Math.max(0.08, Math.min(1, pct))
  return { background: `rgb(249 115 22 / ${opacity.toFixed(3)})` }
}

function cohortCellTitle(row: number, col: number): string {
  if (!stats.value) return ''
  const r = stats.value.cohorts.data[row]
  const size = stats.value.cohorts.sizes[row] ?? 0
  const v = r?.[col] ?? 0
  const pct = size === 0 ? 0 : (v / size) * 100
  const week = stats.value.cohorts.weeks[row] ?? ''
  return `Cohorte ${week} · S+${col} · ${v}/${size} (${pct.toFixed(0)}%)`
}

function eurFmt(n: number): string {
  return n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
</script>

<template>
  <div class="admin-page">
    <h1 class="page-title">Aperçu</h1>

    <div v-if="loading" class="loading">Chargement…</div>
    <div v-else-if="error" class="error">{{ error }}</div>
    <template v-else-if="stats">

      <!-- Metric cards -->
      <div class="metrics-grid">
        <div v-for="m in metrics" :key="m.label" class="metric-card">
          <div class="metric-value">{{ m.value.toLocaleString('fr-FR') }}</div>
          <div class="metric-label">{{ m.label }}</div>
        </div>
      </div>

      <!-- Active users (DAU/WAU/MAU) -->
      <section class="section">
        <h2 class="section-title">Utilisateurs actifs</h2>
        <div class="active-grid">
          <div v-for="a in activeMetrics" :key="a.label" class="metric-card">
            <div class="metric-value">{{ a.value.toLocaleString('fr-FR') }}</div>
            <div class="metric-label">{{ a.label }}</div>
          </div>
        </div>
      </section>

      <!-- Signups chart -->
      <div class="chart-card">
        <div class="chart-header">
          <span class="chart-title">Nouveaux inscrits — 30 derniers jours</span>
        </div>
        <template v-if="chartData">
          <svg :viewBox="`0 0 ${CHART_W} ${CHART_H}`" class="chart-svg">
            <defs>
              <linearGradient id="area-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="currentColor" stop-opacity="0.18" />
                <stop offset="100%" stop-color="currentColor" stop-opacity="0.02" />
              </linearGradient>
            </defs>
            <path :d="chartData.areaD" fill="url(#area-grad)" class="chart-area" />
            <path :d="chartData.pathD" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="chart-line" />
            <circle
              v-for="p in chartData.points.filter((_, i) => i % 5 === 0 || i === chartData!.points.length - 1)"
              :key="p.day"
              :cx="p.x"
              :cy="p.y"
              r="2.5"
              fill="currentColor"
              class="chart-dot"
            />
          </svg>
          <div class="chart-labels">
            <span class="chart-label-start">{{ chartData.days[0] }}</span>
            <span class="chart-label-end">{{ chartData.days[chartData.days.length - 1] }}</span>
          </div>
        </template>
        <div v-else class="chart-empty">Aucune donnée</div>
      </div>

      <!-- Top users by tokens -->
      <section class="section">
        <h2 class="section-title">Top utilisateurs / tokens (90 j)</h2>
        <div class="table-card">
          <table v-if="stats.topUsersByTokens.length" class="data-table">
            <thead>
              <tr>
                <th class="th-left">Utilisateur</th>
                <th class="th-right">Tokens</th>
                <th class="th-right">Coût (EUR)</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in stats.topUsersByTokens" :key="u.userId">
                <td>
                  <div class="user-cell">
                    <span class="user-name">{{ u.displayName || u.email }}</span>
                    <span v-if="u.displayName" class="user-email">{{ u.email }}</span>
                  </div>
                </td>
                <td class="td-right tabular-nums">{{ u.totalTokens.toLocaleString('fr-FR') }}</td>
                <td class="td-right tabular-nums">{{ eurFmt(u.costEur) }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty-row">Aucune donnée</div>
        </div>
      </section>

      <!-- Top users by docs -->
      <section class="section">
        <h2 class="section-title">Top utilisateurs / docs</h2>
        <div class="table-card">
          <table v-if="stats.topUsersByDocs.length" class="data-table">
            <thead>
              <tr>
                <th class="th-left">Utilisateur</th>
                <th class="th-right">Documents</th>
                <th class="th-right">Espaces</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in stats.topUsersByDocs" :key="u.userId">
                <td>
                  <div class="user-cell">
                    <span class="user-name">{{ u.displayName || u.email }}</span>
                    <span v-if="u.displayName" class="user-email">{{ u.email }}</span>
                  </div>
                </td>
                <td class="td-right tabular-nums">{{ u.docs.toLocaleString('fr-FR') }}</td>
                <td class="td-right tabular-nums">{{ u.workspaces.toLocaleString('fr-FR') }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty-row">Aucune donnée</div>
        </div>
      </section>

      <!-- Languages -->
      <section class="section">
        <h2 class="section-title">Langues détectées</h2>
        <div class="table-card">
          <div v-if="stats.languages.length" class="bars">
            <div v-for="l in stats.languages" :key="l.language" class="bar-row">
              <span class="bar-label">{{ l.language }}</span>
              <div class="bar-track">
                <div class="bar-fill" :style="{ width: `${(l.count / languagesMax) * 100}%` }" />
              </div>
              <span class="bar-value tabular-nums">{{ l.count.toLocaleString('fr-FR') }}</span>
              <span class="bar-pct tabular-nums">{{ languagesTotal ? Math.round((l.count / languagesTotal) * 100) : 0 }}%</span>
            </div>
          </div>
          <div v-else class="empty-row">Aucune donnée</div>
        </div>
      </section>

      <!-- Top tags -->
      <section class="section">
        <h2 class="section-title">Top tags</h2>
        <div class="table-card">
          <div v-if="stats.topTags.length" class="tag-cloud">
            <span
              v-for="t in stats.topTags"
              :key="t.tag"
              class="tag-chip"
              :style="{ fontSize: tagSizeRem(t.count) }"
              :title="`${t.count} occurrence${t.count > 1 ? 's' : ''}`"
            >
              {{ t.tag }}
              <span class="tag-count">{{ t.count }}</span>
            </span>
          </div>
          <div v-else class="empty-row">Aucune donnée</div>
        </div>
      </section>

      <!-- Cohort heatmap -->
      <section class="section">
        <h2 class="section-title">Rétention par cohorte</h2>
        <div class="table-card heatmap-card">
          <div v-if="stats.cohorts.weeks.length" class="heatmap-wrap">
            <table class="heatmap">
              <thead>
                <tr>
                  <th class="hm-corner">Semaine</th>
                  <th class="hm-corner-size">Taille</th>
                  <th v-for="(_, col) in stats.cohorts.weeks" :key="col" class="hm-col-head">S+{{ col }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(week, row) in stats.cohorts.weeks" :key="week">
                  <th class="hm-row-head">{{ week }}</th>
                  <td class="hm-size tabular-nums">{{ stats.cohorts.sizes[row] ?? 0 }}</td>
                  <td
                    v-for="(_, col) in stats.cohorts.weeks"
                    :key="col"
                    class="hm-cell"
                    :class="{ 'hm-cell-empty': cohortCellPct(row, col) === 0 }"
                    :style="cohortCellStyle(row, col)"
                    :title="cohortCellTitle(row, col)"
                  >
                    <span v-if="(stats.cohorts.data[row]?.[col] ?? 0) > 0" class="hm-text">
                      {{ Math.round(cohortCellPct(row, col) * 100) }}%
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
            <div class="heatmap-legend">
              <span class="hm-legend-label">Moins</span>
              <span class="hm-legend-grad" />
              <span class="hm-legend-label">Plus</span>
            </div>
          </div>
          <div v-else class="empty-row">Aucune donnée</div>
        </div>
      </section>

    </template>
  </div>
</template>

<style scoped>
.admin-page {
  @apply px-8 py-8 max-w-5xl;
}
.page-title {
  @apply font-serif text-2xl text-ink-900 dark:text-ink-100 mb-6;
}
.loading, .error {
  @apply text-sm text-ink-500 dark:text-ink-400;
}
.metrics-grid {
  @apply grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6;
}
.metric-card {
  @apply rounded-lg p-4 border border-ink-200/60 dark:border-ink-800/60;
  background: theme('colors.ink.50');
}
html.dark .metric-card {
  background: theme('colors.ink.900');
}
.metric-value {
  @apply font-sans text-2xl font-semibold text-ink-900 dark:text-ink-100 tabular-nums;
}
.metric-label {
  @apply font-sans text-[11px] uppercase tracking-[0.08em] text-ink-500 dark:text-ink-400 mt-0.5;
}

.section {
  @apply mt-8;
}
.section-title {
  @apply font-sans text-[11px] uppercase tracking-[0.08em] font-semibold text-ink-500 dark:text-ink-400 mb-3;
}
.active-grid {
  @apply grid grid-cols-1 sm:grid-cols-3 gap-3;
}

.chart-card {
  @apply rounded-lg border border-ink-200/60 dark:border-ink-800/60 p-5 mt-8;
  background: theme('colors.ink.50');
}
html.dark .chart-card {
  background: theme('colors.ink.900');
}
.chart-header {
  @apply mb-4;
}
.chart-title {
  @apply font-sans text-[11px] uppercase tracking-[0.08em] font-semibold text-ink-500 dark:text-ink-400;
}
.chart-svg {
  @apply w-full text-accent-500 dark:text-accent-400;
  height: 80px;
}
.chart-labels {
  @apply flex justify-between mt-1;
}
.chart-label-start, .chart-label-end {
  @apply font-sans text-[10px] text-ink-400 dark:text-ink-600 tabular-nums;
}
.chart-empty {
  @apply text-sm text-ink-400 dark:text-ink-600 py-6 text-center;
}

/* ---- Generic table card ------------------------------------------------- */
.table-card {
  @apply rounded-lg border border-ink-200/60 dark:border-ink-800/60 overflow-hidden;
  background: theme('colors.ink.50');
}
html.dark .table-card {
  background: theme('colors.ink.900');
}
.data-table {
  @apply w-full text-sm;
}
.data-table thead th {
  @apply font-sans text-[10px] uppercase tracking-[0.08em] font-semibold text-ink-500 dark:text-ink-400 px-4 py-2.5 border-b border-ink-200/60 dark:border-ink-800/60;
}
.th-left {
  @apply text-left;
}
.th-right {
  @apply text-right;
}
.td-right {
  @apply text-right;
}
.data-table tbody td {
  @apply px-4 py-2.5 border-b border-ink-200/40 dark:border-ink-800/40 text-ink-800 dark:text-ink-200;
}
.data-table tbody tr:last-child td {
  @apply border-b-0;
}
.user-cell {
  @apply flex flex-col;
}
.user-name {
  @apply font-medium text-ink-900 dark:text-ink-100;
}
.user-email {
  @apply text-[11px] text-ink-500 dark:text-ink-400;
}
.empty-row {
  @apply text-sm text-ink-400 dark:text-ink-600 py-6 text-center;
}

/* ---- Languages bars ---------------------------------------------------- */
.bars {
  @apply p-4 flex flex-col gap-2.5;
}
.bar-row {
  @apply grid items-center gap-3;
  grid-template-columns: 7rem 1fr 4rem 3rem;
}
.bar-label {
  @apply font-mono text-xs text-ink-700 dark:text-ink-300 uppercase;
}
.bar-track {
  @apply h-2 rounded bg-ink-200/60 dark:bg-ink-800/60 overflow-hidden;
}
.bar-fill {
  @apply h-full rounded;
  background: theme('colors.accent.500');
}
html.dark .bar-fill {
  background: theme('colors.accent.400');
}
.bar-value {
  @apply text-xs text-ink-700 dark:text-ink-300 text-right;
}
.bar-pct {
  @apply text-[11px] text-ink-500 dark:text-ink-400 text-right;
}

/* ---- Tag cloud --------------------------------------------------------- */
.tag-cloud {
  @apply p-4 flex flex-wrap gap-2 items-baseline;
}
.tag-chip {
  @apply inline-flex items-baseline gap-1.5 rounded-full px-3 py-1 border border-ink-200/60 dark:border-ink-800/60 text-ink-800 dark:text-ink-200 leading-none;
  background: theme('colors.ink.100');
}
html.dark .tag-chip {
  background: theme('colors.ink.800');
}
.tag-count {
  @apply text-[10px] text-ink-500 dark:text-ink-400 tabular-nums;
}

/* ---- Cohort heatmap ---------------------------------------------------- */
.heatmap-card {
  @apply p-4;
}
.heatmap-wrap {
  @apply overflow-x-auto;
}
.heatmap {
  @apply text-xs border-collapse;
}
.heatmap th, .heatmap td {
  @apply text-center align-middle;
}
.hm-corner, .hm-corner-size {
  @apply font-sans text-[10px] uppercase tracking-[0.08em] font-semibold text-ink-500 dark:text-ink-400 px-2 py-1.5 text-left;
}
.hm-corner-size {
  @apply text-right pr-3;
}
.hm-col-head {
  @apply font-sans text-[10px] uppercase tracking-[0.06em] font-semibold text-ink-500 dark:text-ink-400 px-2 py-1.5;
  min-width: 3rem;
}
.hm-row-head {
  @apply font-mono text-[11px] text-ink-700 dark:text-ink-300 pr-3 py-1 text-left whitespace-nowrap;
}
.hm-size {
  @apply font-sans text-[11px] text-ink-500 dark:text-ink-400 pr-3 text-right;
}
.hm-cell {
  @apply rounded-sm h-7 relative;
  min-width: 3rem;
}
.hm-cell-empty {
  background: theme('colors.ink.100');
}
html.dark .hm-cell-empty {
  background: theme('colors.ink.800');
}
.hm-text {
  @apply text-[10px] font-medium tabular-nums text-ink-900 dark:text-ink-50;
  mix-blend-mode: difference;
  filter: invert(1);
}
html.dark .hm-text {
  mix-blend-mode: normal;
  filter: none;
  @apply text-ink-50;
}
.heatmap-legend {
  @apply flex items-center gap-2 mt-3 justify-end;
}
.hm-legend-label {
  @apply font-sans text-[10px] uppercase tracking-[0.08em] text-ink-500 dark:text-ink-400;
}
.hm-legend-grad {
  @apply h-2 w-24 rounded;
  background: linear-gradient(to right,
    rgb(249 115 22 / 0.08),
    rgb(249 115 22 / 1));
}
</style>
