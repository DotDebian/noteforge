<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })

interface JobsStats {
  pending: number
  running: number
  completed24h: number
  failed24h: number
  avgDurationMs24h: number
}
type JobStatus = 'pending' | 'running' | 'completed' | 'failed'
interface JobRow {
  id: number
  type: string
  status: JobStatus
  userId: number | null
  userEmail: string | null
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
  errorMessage: string | null
  createdAt: string
}
interface JobsResponse {
  stats: JobsStats
  types: string[]
  jobs: JobRow[]
  total: number
  page: number
  limit: number
}

type StatusFilter = 'all' | JobStatus
const status = ref<StatusFilter>('all')
const typeFilter = ref<string>('')
const page = ref(1)
const limit = 50
const data = ref<JobsResponse | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    const params = new URLSearchParams({
      status: status.value,
      page: String(page.value),
      limit: String(limit),
    })
    if (typeFilter.value) params.set('type', typeFilter.value)
    data.value = await $fetch<JobsResponse>(`/api/admin/jobs?${params}`)
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    loading.value = false
  }
}

onMounted(load)
watch([status, typeFilter], () => { page.value = 1; load() })
watch(page, load)

const totalPages = computed(() => Math.max(1, Math.ceil((data.value?.total ?? 0) / limit)))

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}
function fmtDuration(ms: number | null) {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const min = Math.floor(ms / 60_000)
  const sec = Math.floor((ms % 60_000) / 1000)
  return `${min}m ${sec}s`
}
function truncate(s: string | null, len = 80) {
  if (!s) return '—'
  return s.length > len ? `${s.slice(0, len)}…` : s
}
</script>

<template>
  <div class="admin-page">
    <div class="page-header">
      <h1 class="page-title">Pipeline de jobs</h1>
      <button class="refresh-btn" :disabled="loading" @click="load">
        {{ loading ? 'Chargement…' : 'Rafraîchir' }}
      </button>
    </div>

    <div v-if="loading && !data" class="loading">Chargement…</div>
    <div v-else-if="error" class="error">{{ error }}</div>

    <template v-else-if="data">
      <!-- Stat cards -->
      <div class="cards-grid">
        <div class="stat-card">
          <div class="stat-val">{{ data.stats.pending.toLocaleString('fr-FR') }}</div>
          <div class="stat-lbl">En attente</div>
        </div>
        <div class="stat-card stat-card--info">
          <div class="stat-val">{{ data.stats.running.toLocaleString('fr-FR') }}</div>
          <div class="stat-lbl">En cours</div>
        </div>
        <div class="stat-card stat-card--ok">
          <div class="stat-val">{{ data.stats.completed24h.toLocaleString('fr-FR') }}</div>
          <div class="stat-lbl">Terminés (24h)</div>
        </div>
        <div class="stat-card" :class="{ 'stat-card--warn': data.stats.failed24h > 0 }">
          <div class="stat-val">{{ data.stats.failed24h.toLocaleString('fr-FR') }}</div>
          <div class="stat-lbl">Échecs (24h)</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">{{ fmtDuration(data.stats.avgDurationMs24h) }}</div>
          <div class="stat-lbl">Durée moy. (24h)</div>
        </div>
      </div>

      <!-- Filters -->
      <div class="filters">
        <select v-model="status" class="sel">
          <option value="all">Tous statuts</option>
          <option value="pending">En attente</option>
          <option value="running">En cours</option>
          <option value="completed">Terminés</option>
          <option value="failed">Échecs</option>
        </select>
        <select v-model="typeFilter" class="sel">
          <option value="">Tous types</option>
          <option v-for="t in data.types" :key="t" :value="t">{{ t }}</option>
        </select>
        <span class="total-badge">{{ data.total.toLocaleString('fr-FR') }} jobs</span>
      </div>

      <!-- Jobs table -->
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Type</th>
              <th>Statut</th>
              <th>Utilisateur</th>
              <th>Démarré</th>
              <th>Terminé</th>
              <th>Durée</th>
              <th>Erreur</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="j in data.jobs" :key="j.id">
              <td class="mono">#{{ j.id }}</td>
              <td class="mono">{{ j.type }}</td>
              <td>
                <span class="badge" :class="`badge--${j.status}`">{{ j.status }}</span>
              </td>
              <td>{{ j.userEmail ?? '—' }}</td>
              <td class="mono">{{ fmtDate(j.startedAt) }}</td>
              <td class="mono">{{ fmtDate(j.completedAt) }}</td>
              <td class="mono">{{ fmtDuration(j.durationMs) }}</td>
              <td class="err-cell" :title="j.errorMessage ?? ''">{{ truncate(j.errorMessage) }}</td>
            </tr>
            <tr v-if="data.jobs.length === 0">
              <td colspan="8" class="empty-cell">Aucun job</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div v-if="totalPages > 1" class="pagination">
        <button class="page-btn" :disabled="page <= 1" @click="page--">←</button>
        <span class="page-info">{{ page }} / {{ totalPages }}</span>
        <button class="page-btn" :disabled="page >= totalPages" @click="page++">→</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.admin-page { @apply px-8 py-8 max-w-6xl; }
.page-header { @apply flex items-center justify-between mb-6; }
.page-title { @apply font-serif text-2xl text-ink-900 dark:text-ink-100; }
.refresh-btn {
  @apply px-3 py-1.5 text-sm rounded border border-ink-300 dark:border-ink-700 text-ink-800 dark:text-ink-200 disabled:opacity-40;
  background: theme('colors.ink.100');
  transition: background 100ms;
}
html.dark .refresh-btn { background: theme('colors.ink.800'); }
.refresh-btn:not(:disabled):hover { @apply bg-accent-100 dark:bg-accent-900/30 border-accent-400 text-accent-700 dark:text-accent-300; }
.loading, .error { @apply text-sm text-ink-500 dark:text-ink-400; }
.cards-grid { @apply grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6; }
.stat-card {
  @apply rounded-lg border border-ink-200/60 dark:border-ink-800/60 p-4;
  background: theme('colors.ink.50');
}
html.dark .stat-card { background: theme('colors.ink.900'); }
.stat-card--ok { @apply border-emerald-200 dark:border-emerald-800/60; background: theme('colors.emerald.50'); }
html.dark .stat-card--ok { background: theme('colors.emerald.900' / 20%); }
.stat-card--info { @apply border-blue-200 dark:border-blue-800/60; background: theme('colors.blue.50'); }
html.dark .stat-card--info { background: theme('colors.blue.900' / 20%); }
.stat-card--warn { @apply border-red-300 dark:border-red-700; background: theme('colors.red.50'); }
html.dark .stat-card--warn { background: theme('colors.red.900' / 20%); }
.stat-val { @apply font-sans text-xl font-semibold text-ink-900 dark:text-ink-100 tabular-nums; }
.stat-lbl { @apply font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400 mt-0.5; }
.filters { @apply flex items-center gap-3 mb-4; }
.sel {
  @apply px-3 py-1.5 text-sm rounded border border-ink-300 dark:border-ink-700 bg-ink-50 dark:bg-ink-900 text-ink-800 dark:text-ink-200 outline-none;
}
.total-badge { @apply text-xs text-ink-500 dark:text-ink-400 font-sans ml-auto; }
.table-wrap { @apply rounded-lg border border-ink-200/60 dark:border-ink-800/60 overflow-x-auto; }
.data-table { @apply w-full text-sm text-left; }
.data-table thead { @apply bg-ink-100 dark:bg-ink-900/60; }
.data-table th { @apply px-4 py-2.5 font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400 font-semibold whitespace-nowrap; }
.data-table td { @apply px-4 py-2.5 border-t border-ink-200/50 dark:border-ink-800/50 text-ink-700 dark:text-ink-300; background: theme('colors.ink.50'); }
html.dark .data-table td { background: theme('colors.ink.900'); }
.mono { @apply font-mono text-xs tabular-nums; }
.err-cell { @apply text-xs text-red-600 dark:text-red-400 max-w-xs; }
.badge { @apply inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide; }
.badge--pending { @apply bg-ink-100 dark:bg-ink-800 text-ink-600 dark:text-ink-400; }
.badge--running { @apply bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400; }
.badge--completed { @apply bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400; }
.badge--failed { @apply bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400; }
.empty-cell { @apply text-center py-8 text-sm text-ink-400 dark:text-ink-600; }
.pagination { @apply flex items-center gap-3 mt-4 justify-end; }
.page-btn {
  @apply text-sm px-3 py-1 rounded border border-ink-300 dark:border-ink-700 text-ink-700 dark:text-ink-300 disabled:opacity-40;
  background: theme('colors.ink.50');
}
html.dark .page-btn { background: theme('colors.ink.900'); }
.page-info { @apply text-sm text-ink-600 dark:text-ink-400 tabular-nums; }
</style>
