<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })

interface RagStats {
  totalChats: number
  avgChunksReturned: number
  avgRerankScore: number
  avgCitations: number
  pctHasCitation: number
  pctRewriterUsed: number
  pctRerankerUsed: number
  latencyP50: number
  latencyP95: number
}
interface DayRow {
  day: string
  count: number
  pctHasCitation: number
}
interface RecentRow {
  id: number
  createdAt: string
  userEmail: string | null
  chunksReturned: number
  citationsEmitted: number
  rerankAvg: number | null
  latencyMs: number | null
  hasCitation: boolean
}
interface RagQualityResponse {
  windowDays: number
  stats: RagStats
  perDay: DayRow[]
  recent: RecentRow[]
}

const data = ref<RagQualityResponse | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    data.value = await $fetch<RagQualityResponse>('/api/admin/rag-quality')
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    loading.value = false
  }
}
onMounted(load)

function pct(n: number) {
  return `${(n * 100).toFixed(1)} %`
}
function num(n: number, digits = 2) {
  return n.toLocaleString('fr-FR', { maximumFractionDigits: digits })
}
function fmtMs(n: number | null) {
  if (n == null) return '—'
  return `${n.toLocaleString('fr-FR')} ms`
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

/* ---- Bar chart for per-day counts -------------------------------------- */
const CHART_H = 110
const CHART_W = 720

const chartData = computed(() => {
  if (!data.value) return null

  const today = new Date()
  const allDays: string[] = []
  for (let i = data.value.windowDays - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    allDays.push(d.toISOString().slice(0, 10))
  }

  const map = new Map(data.value.perDay.map(r => [r.day, r]))
  const bars = allDays.map((day) => {
    const row = map.get(day)
    return {
      day,
      count: row?.count ?? 0,
      pctHasCitation: row?.pctHasCitation ?? 0,
    }
  })

  const maxCount = Math.max(...bars.map(b => b.count), 1)
  const pad = 4
  const barW = (CHART_W - pad * 2) / allDays.length - 1
  const barH = CHART_H - 8

  return { bars, maxCount, pad, barW, barH }
})
</script>

<template>
  <div class="admin-page">
    <h1 class="page-title">Qualité RAG</h1>
    <p class="page-sub">30 derniers jours — instrumenté sur chaque tour de chat.</p>

    <div v-if="loading" class="loading">Chargement…</div>
    <div v-else-if="error" class="error">{{ error }}</div>

    <template v-else-if="data">
      <!-- Stat cards -->
      <div class="cards-grid">
        <div class="stat-card">
          <div class="stat-val">{{ data.stats.totalChats.toLocaleString('fr-FR') }}</div>
          <div class="stat-lbl">Tours de chat</div>
        </div>
        <div class="stat-card" :class="{ 'stat-card--warn': data.stats.pctHasCitation < 0.5 && data.stats.totalChats > 0 }">
          <div class="stat-val">{{ pct(data.stats.pctHasCitation) }}</div>
          <div class="stat-lbl">% avec citation</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">{{ num(data.stats.avgChunksReturned) }}</div>
          <div class="stat-lbl">Chunks moy. / tour</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">{{ num(data.stats.avgCitations) }}</div>
          <div class="stat-lbl">Citations moy. / tour</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">{{ num(data.stats.avgRerankScore) }}</div>
          <div class="stat-lbl">Score rerank moy.</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">{{ pct(data.stats.pctRewriterUsed) }}</div>
          <div class="stat-lbl">% rewriter</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">{{ pct(data.stats.pctRerankerUsed) }}</div>
          <div class="stat-lbl">% reranker</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">{{ fmtMs(data.stats.latencyP50) }}</div>
          <div class="stat-lbl">Latence p50</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">{{ fmtMs(data.stats.latencyP95) }}</div>
          <div class="stat-lbl">Latence p95</div>
        </div>
      </div>

      <!-- Daily bar chart -->
      <div class="chart-card">
        <div class="chart-header">
          <span class="chart-title">Tours / jour (barre = nombre, opacité = % avec citation)</span>
        </div>
        <template v-if="chartData && chartData.bars.some(b => b.count > 0)">
          <svg :viewBox="`0 0 ${CHART_W} ${CHART_H}`" class="chart-svg">
            <g v-for="(bar, bi) in chartData.bars" :key="bar.day">
              <rect
                v-if="bar.count > 0"
                :x="chartData.pad + bi * (chartData.barW + 1)"
                :y="chartData.barH - chartData.barH * (bar.count / chartData.maxCount)"
                :width="chartData.barW"
                :height="chartData.barH * (bar.count / chartData.maxCount)"
                fill="currentColor"
                :opacity="0.25 + 0.75 * bar.pctHasCitation"
                rx="1"
              />
            </g>
          </svg>
          <div class="chart-labels">
            <span>{{ chartData.bars[0]?.day }}</span>
            <span>{{ chartData.bars[chartData.bars.length - 1]?.day }}</span>
          </div>
        </template>
        <div v-else class="chart-empty">Aucun tour de chat sur la période</div>
      </div>

      <!-- Recent turns -->
      <section class="section">
        <h2 class="section-title">50 tours les plus récents</h2>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Heure</th>
                <th>Utilisateur</th>
                <th>Chunks</th>
                <th>Citations</th>
                <th>Rerank moy.</th>
                <th>Latence</th>
                <th>Citation ?</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in data.recent" :key="r.id">
                <td class="mono">{{ fmtDate(r.createdAt) }}</td>
                <td>{{ r.userEmail ?? '—' }}</td>
                <td class="mono">{{ r.chunksReturned }}</td>
                <td class="mono">{{ r.citationsEmitted }}</td>
                <td class="mono">{{ r.rerankAvg != null ? num(r.rerankAvg) : '—' }}</td>
                <td class="mono">{{ fmtMs(r.latencyMs) }}</td>
                <td>
                  <span v-if="r.hasCitation" class="badge badge--ok">oui</span>
                  <span v-else class="badge badge--warn">non</span>
                </td>
              </tr>
              <tr v-if="data.recent.length === 0">
                <td colspan="7" class="empty-cell">Aucune donnée</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.admin-page { @apply px-8 py-8 max-w-6xl; }
.page-title { @apply font-serif text-2xl text-ink-900 dark:text-ink-100 mb-1; }
.page-sub { @apply text-sm text-ink-500 dark:text-ink-400 mb-6; }
.loading, .error { @apply text-sm text-ink-500 dark:text-ink-400; }
.cards-grid { @apply grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6; }
.stat-card {
  @apply rounded-lg border border-ink-200/60 dark:border-ink-800/60 p-4;
  background: theme('colors.ink.50');
}
html.dark .stat-card { background: theme('colors.ink.900'); }
.stat-card--warn { @apply border-amber-300 dark:border-amber-700; background: theme('colors.amber.50'); }
html.dark .stat-card--warn { background: theme('colors.amber.900' / 20%); }
.stat-val { @apply font-sans text-xl font-semibold text-ink-900 dark:text-ink-100 tabular-nums; }
.stat-lbl { @apply font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400 mt-0.5; }
.chart-card {
  @apply rounded-lg border border-ink-200/60 dark:border-ink-800/60 p-5 mb-6 text-accent-500 dark:text-accent-400;
  background: theme('colors.ink.50');
}
html.dark .chart-card { background: theme('colors.ink.900'); }
.chart-header { @apply mb-4; }
.chart-title { @apply font-sans text-[11px] uppercase tracking-[0.08em] font-semibold text-ink-500 dark:text-ink-400; }
.chart-svg { @apply w-full; height: 110px; }
.chart-labels { @apply flex justify-between mt-1 font-mono text-[10px] text-ink-400 dark:text-ink-600 tabular-nums; }
.chart-empty { @apply text-sm text-ink-400 dark:text-ink-600 py-6 text-center; }
.section { @apply mb-6; }
.section-title { @apply font-sans text-[11px] uppercase tracking-[0.09em] font-semibold text-ink-500 dark:text-ink-400 mb-3; }
.table-wrap { @apply rounded-lg border border-ink-200/60 dark:border-ink-800/60 overflow-x-auto; }
.data-table { @apply w-full text-sm text-left; }
.data-table thead { @apply bg-ink-100 dark:bg-ink-900/60; }
.data-table th { @apply px-4 py-2.5 font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400 font-semibold whitespace-nowrap; }
.data-table td { @apply px-4 py-2.5 border-t border-ink-200/50 dark:border-ink-800/50 text-ink-700 dark:text-ink-300; background: theme('colors.ink.50'); }
html.dark .data-table td { background: theme('colors.ink.900'); }
.mono { @apply font-mono text-xs tabular-nums; }
.badge { @apply inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide; }
.badge--ok { @apply bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400; }
.badge--warn { @apply bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400; }
.empty-cell { @apply text-center py-8 text-sm text-ink-400 dark:text-ink-600; }
</style>
