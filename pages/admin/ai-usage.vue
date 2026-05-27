<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })

interface DailyRow { day: string, model: string, promptTokens: number, completionTokens: number, totalTokens: number }
interface ModelOpRow { model: string, operation: string, promptTokens: number, completionTokens: number, totalTokens: number }
interface UserRow { id: number, email: string, displayName: string | null, totalTokens: number }
interface UsageData {
  dailyRows: DailyRow[]
  byModelOp: ModelOpRow[]
  users: UserRow[]
}

// Mistral pricing (USD / M tokens) as of 2025
const PRICING: Record<string, { prompt: number, completion: number }> = {
  'mistral-embed': { prompt: 0.1, completion: 0 },
  'mistral-small-latest': { prompt: 0.2, completion: 0.6 },
  'mistral-large-latest': { prompt: 2, completion: 6 },
  'mistral-ocr-latest': { prompt: 1, completion: 0 },
}
const USD_TO_EUR = 0.93

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = PRICING[model] ?? { prompt: 1, completion: 1 }
  return ((promptTokens * pricing.prompt + completionTokens * pricing.completion) / 1_000_000) * USD_TO_EUR
}

const data = ref<UsageData | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const selectedUserId = ref<number | null>(null)
const days = ref(30)

async function load() {
  loading.value = true
  error.value = null
  try {
    const params = new URLSearchParams({ days: String(days.value) })
    if (selectedUserId.value) params.set('userId', String(selectedUserId.value))
    data.value = await $fetch<UsageData>(`/api/admin/ai-usage?${params}`)
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    loading.value = false
  }
}
onMounted(load)
watch([selectedUserId, days], load)

/* ---------- Chart -------------------------------------------------------- */
const CHART_H = 100
const CHART_W = 600

const models = computed(() => {
  if (!data.value) return []
  return [...new Set(data.value.dailyRows.map(r => r.model))].sort()
})

const MODEL_COLORS = [
  '#f97316', '#6366f1', '#10b981', '#f59e0b', '#ec4899', '#14b8a6',
]

const chartData = computed(() => {
  if (!data.value || data.value.dailyRows.length === 0) return null

  // Build day list
  const today = new Date()
  const allDays: string[] = []
  for (let i = days.value - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    allDays.push(d.toISOString().slice(0, 10))
  }

  const ms = models.value
  // day → model → total
  const map = new Map<string, Map<string, number>>()
  for (const r of data.value.dailyRows) {
    if (!map.has(r.day)) map.set(r.day, new Map())
    map.get(r.day)!.set(r.model, (map.get(r.day)!.get(r.model) ?? 0) + r.totalTokens)
  }

  const barData = allDays.map(day => ({
    day,
    stacks: ms.map(m => map.get(day)?.get(m) ?? 0),
    total: ms.reduce((s, m) => s + (map.get(day)?.get(m) ?? 0), 0),
  }))

  const maxTotal = Math.max(...barData.map(b => b.total), 1)
  const pad = 4
  const barW = (CHART_W - pad * 2) / allDays.length - 1
  const barH = CHART_H - 8

  return { barData, maxTotal, pad, barW, barH, ms }
})

/* ---------- Totals ------------------------------------------------------- */
const totalByModel = computed(() => {
  if (!data.value) return []
  const map = new Map<string, { promptTokens: number, completionTokens: number, totalTokens: number }>()
  for (const r of data.value.byModelOp) {
    const prev = map.get(r.model) ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    map.set(r.model, {
      promptTokens: prev.promptTokens + r.promptTokens,
      completionTokens: prev.completionTokens + r.completionTokens,
      totalTokens: prev.totalTokens + r.totalTokens,
    })
  }
  return [...map.entries()].map(([model, v]) => ({
    model,
    ...v,
    costEur: estimateCost(model, v.promptTokens, v.completionTokens),
  })).sort((a, b) => b.totalTokens - a.totalTokens)
})

const totalCostEur = computed(() => totalByModel.value.reduce((s, r) => s + r.costEur, 0))

function fmtEur(n: number) { return n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 4 }) }
</script>

<template>
  <div class="admin-page">
    <h1 class="page-title">Tokens IA</h1>

    <!-- Filters -->
    <div class="filters">
      <select v-model="days" class="sel">
        <option :value="7">7 jours</option>
        <option :value="30">30 jours</option>
        <option :value="90">90 jours</option>
        <option :value="365">365 jours</option>
      </select>
      <select v-model="selectedUserId" class="sel">
        <option :value="null">Tous les utilisateurs</option>
        <option v-for="u in data?.users ?? []" :key="u.id" :value="u.id">
          {{ u.email }} ({{ u.totalTokens.toLocaleString('fr-FR') }} tokens)
        </option>
      </select>
    </div>

    <div v-if="loading" class="loading">Chargement…</div>
    <div v-else-if="error" class="error">{{ error }}</div>

    <template v-else-if="data">
      <!-- Stacked bar chart -->
      <div class="chart-card">
        <div class="chart-header">
          <span class="chart-title">Tokens / jour (empilé par modèle)</span>
          <div class="legend">
            <span v-for="(m, i) in models" :key="m" class="legend-item">
              <span class="legend-dot" :style="{ background: MODEL_COLORS[i] ?? '#888' }" />
              {{ m }}
            </span>
          </div>
        </div>
        <template v-if="chartData && chartData.barData.some(b => b.total > 0)">
          <svg :viewBox="`0 0 ${CHART_W} ${CHART_H}`" class="chart-svg">
            <g v-for="(bar, bi) in chartData.barData" :key="bar.day">
              <g v-if="bar.total > 0">
                <template v-for="(val, mi) in bar.stacks" :key="mi">
                  <rect
                    v-if="val > 0"
                    :x="chartData.pad + bi * (chartData.barW + 1)"
                    :y="chartData.barH - chartData.barH * (bar.stacks.slice(0, mi + 1).reduce((a, b) => a + b, 0) / chartData.maxTotal)"
                    :width="chartData.barW"
                    :height="chartData.barH * (val / chartData.maxTotal)"
                    :fill="MODEL_COLORS[mi] ?? '#888'"
                    opacity="0.85"
                    rx="1"
                  />
                </template>
              </g>
            </g>
          </svg>
          <div class="chart-labels">
            <span>{{ chartData.barData[0]?.day }}</span>
            <span>{{ chartData.barData[chartData.barData.length - 1]?.day }}</span>
          </div>
        </template>
        <div v-else class="chart-empty">Aucune consommation sur la période</div>
      </div>

      <!-- Cost summary -->
      <div class="cost-banner">
        Coût estimé (période complète) :
        <strong>{{ fmtEur(totalCostEur) }}</strong>
        <span class="cost-note">basé sur les tarifs publics Mistral</span>
      </div>

      <!-- By model -->
      <section class="section">
        <h2 class="section-title">Totaux par modèle</h2>
        <table class="data-table">
          <thead>
            <tr>
              <th>Modèle</th>
              <th>Tokens prompt</th>
              <th>Tokens completion</th>
              <th>Total</th>
              <th>Coût estimé (€)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in totalByModel" :key="r.model">
              <td class="mono">{{ r.model }}</td>
              <td class="mono">{{ r.promptTokens.toLocaleString('fr-FR') }}</td>
              <td class="mono">{{ r.completionTokens.toLocaleString('fr-FR') }}</td>
              <td class="mono font-semibold">{{ r.totalTokens.toLocaleString('fr-FR') }}</td>
              <td class="mono">{{ fmtEur(r.costEur) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- By operation -->
      <section class="section">
        <h2 class="section-title">Détail par opération</h2>
        <table class="data-table">
          <thead>
            <tr>
              <th>Modèle</th>
              <th>Opération</th>
              <th>Prompt</th>
              <th>Completion</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in data.byModelOp" :key="`${r.model}-${r.operation}`">
              <td class="mono">{{ r.model }}</td>
              <td class="mono">{{ r.operation }}</td>
              <td class="mono">{{ r.promptTokens.toLocaleString('fr-FR') }}</td>
              <td class="mono">{{ r.completionTokens.toLocaleString('fr-FR') }}</td>
              <td class="mono">{{ r.totalTokens.toLocaleString('fr-FR') }}</td>
            </tr>
            <tr v-if="data.byModelOp.length === 0">
              <td colspan="5" class="empty-cell">Aucune donnée</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
  </div>
</template>

<style scoped>
.admin-page { @apply px-8 py-8 max-w-5xl; }
.page-title { @apply font-serif text-2xl text-ink-900 dark:text-ink-100 mb-6; }
.filters { @apply flex gap-3 mb-6; }
.sel {
  @apply px-3 py-1.5 text-sm rounded border border-ink-300 dark:border-ink-700 bg-ink-50 dark:bg-ink-900 text-ink-800 dark:text-ink-200 outline-none;
}
.loading, .error { @apply text-sm text-ink-500 dark:text-ink-400; }
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
.chart-svg { @apply w-full; height: 100px; }
.chart-labels { @apply flex justify-between mt-1 font-mono text-[10px] text-ink-400 dark:text-ink-600 tabular-nums; }
.chart-empty { @apply text-sm text-ink-400 dark:text-ink-600 py-6 text-center; }
.cost-banner {
  @apply rounded-lg border border-accent-200 dark:border-accent-800/60 px-5 py-3 text-sm text-ink-800 dark:text-ink-200 mb-6 flex items-center gap-3 flex-wrap;
  background: theme('colors.accent.50');
}
html.dark .cost-banner {
  background: theme('colors.accent.900' / 20%);
}
.cost-note { @apply text-xs text-ink-500 dark:text-ink-400; }
.section { @apply mb-6; }
.section-title { @apply font-sans text-[11px] uppercase tracking-[0.09em] font-semibold text-ink-500 dark:text-ink-400 mb-3; }
.data-table { @apply w-full text-sm text-left rounded-lg border border-ink-200/60 dark:border-ink-800/60 overflow-hidden; }
.data-table thead { @apply bg-ink-100 dark:bg-ink-900/60; }
.data-table th { @apply px-4 py-2.5 font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400 font-semibold; }
.data-table td { @apply px-4 py-2.5 border-t border-ink-200/50 dark:border-ink-800/50 text-ink-700 dark:text-ink-300; background: theme('colors.ink.50'); }
html.dark .data-table td { background: theme('colors.ink.900'); }
.mono { @apply font-mono text-xs tabular-nums; }
.empty-cell { @apply text-center py-8 text-sm text-ink-400 dark:text-ink-600; }
</style>
