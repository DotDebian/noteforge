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
    { label: 'Utilisateurs', value: t.users, icon: '👤' },
    { label: 'Espaces de travail', value: t.workspaces, icon: '🗂' },
    { label: 'Documents', value: t.documents, icon: '📄' },
    { label: 'Dossiers', value: t.folders, icon: '📁' },
    { label: 'Chunks vectorisés', value: t.chunks, icon: '🔢' },
  ]
})
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

    </template>
  </div>
</template>

<style scoped>
.admin-page {
  @apply px-8 py-8 max-w-4xl;
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

.chart-card {
  @apply rounded-lg border border-ink-200/60 dark:border-ink-800/60 p-5;
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
</style>
