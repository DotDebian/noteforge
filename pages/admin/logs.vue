<script setup lang="ts">
import { ref, computed, watch, onMounted, reactive } from 'vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogRow {
  id: number
  level: LogLevel
  source: string
  message: string
  context: Record<string, unknown> | null
  userId: number | null
  userEmail: string | null
  createdAt: string
}
interface LogsResponse {
  levelCounts24h: Record<LogLevel, number>
  sources: string[]
  logs: LogRow[]
  total: number
  page: number
  limit: number
}

type LevelFilter = 'all' | LogLevel
const level = ref<LevelFilter>('all')
const sourceFilter = ref<string>('')
const search = ref<string>('')
const page = ref(1)
const limit = 50
const data = ref<LogsResponse | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const expanded = reactive(new Set<number>())

async function load() {
  loading.value = true
  error.value = null
  try {
    const params = new URLSearchParams({
      level: level.value,
      page: String(page.value),
      limit: String(limit),
    })
    if (sourceFilter.value) params.set('source', sourceFilter.value)
    if (search.value.trim()) params.set('q', search.value.trim())
    data.value = await $fetch<LogsResponse>(`/api/admin/logs?${params}`)
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    loading.value = false
  }
}
onMounted(load)
watch([level, sourceFilter], () => { page.value = 1; load() })
watch(page, load)

let searchTimer: ReturnType<typeof setTimeout> | null = null
function onSearch(e: Event) {
  if (searchTimer) clearTimeout(searchTimer)
  const v = (e.target as HTMLInputElement).value
  searchTimer = setTimeout(() => {
    search.value = v
    page.value = 1
    load()
  }, 300)
}

const totalPages = computed(() => Math.max(1, Math.ceil((data.value?.total ?? 0) / limit)))

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function toggleExpand(id: number) {
  if (expanded.has(id)) expanded.delete(id)
  else expanded.add(id)
}

function ctxPreview(ctx: Record<string, unknown> | null) {
  if (!ctx) return ''
  const keys = Object.keys(ctx)
  if (keys.length === 0) return '{}'
  return `${keys.length} clé${keys.length > 1 ? 's' : ''}`
}
</script>

<template>
  <div class="admin-page">
    <h1 class="page-title">Logs applicatifs</h1>
    <p class="page-sub">Journal d'événements serveur — 24h pour les compteurs.</p>

    <div v-if="loading && !data" class="loading">Chargement…</div>
    <div v-else-if="error" class="error">{{ error }}</div>

    <template v-else-if="data">
      <!-- Level counts (24h) -->
      <div class="cards-grid">
        <div class="stat-card stat-card--err">
          <div class="stat-val">{{ data.levelCounts24h.error.toLocaleString('fr-FR') }}</div>
          <div class="stat-lbl">Erreurs (24h)</div>
        </div>
        <div class="stat-card stat-card--warn">
          <div class="stat-val">{{ data.levelCounts24h.warn.toLocaleString('fr-FR') }}</div>
          <div class="stat-lbl">Warnings (24h)</div>
        </div>
        <div class="stat-card stat-card--info">
          <div class="stat-val">{{ data.levelCounts24h.info.toLocaleString('fr-FR') }}</div>
          <div class="stat-lbl">Info (24h)</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">{{ data.levelCounts24h.debug.toLocaleString('fr-FR') }}</div>
          <div class="stat-lbl">Debug (24h)</div>
        </div>
      </div>

      <!-- Filters -->
      <div class="filters">
        <select v-model="level" class="sel">
          <option value="all">Tous niveaux</option>
          <option value="error">Erreurs</option>
          <option value="warn">Warnings</option>
          <option value="info">Info</option>
          <option value="debug">Debug</option>
        </select>
        <select v-model="sourceFilter" class="sel">
          <option value="">Toutes sources</option>
          <option v-for="s in data.sources" :key="s" :value="s">{{ s }}</option>
        </select>
        <input
          type="search"
          class="search-input"
          placeholder="Rechercher dans le message…"
          @input="onSearch"
        >
        <span class="total-badge">{{ data.total.toLocaleString('fr-FR') }} lignes</span>
      </div>

      <!-- Logs table -->
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Heure</th>
              <th>Niveau</th>
              <th>Source</th>
              <th>Message</th>
              <th>Contexte</th>
              <th>Utilisateur</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="log in data.logs" :key="log.id">
              <tr>
                <td class="mono">{{ fmtDate(log.createdAt) }}</td>
                <td>
                  <span class="badge" :class="`badge--${log.level}`">{{ log.level }}</span>
                </td>
                <td class="mono">{{ log.source }}</td>
                <td class="msg-cell">{{ log.message }}</td>
                <td>
                  <button
                    v-if="log.context"
                    class="ctx-btn"
                    :class="{ 'ctx-btn--open': expanded.has(log.id) }"
                    @click="toggleExpand(log.id)"
                  >
                    {{ ctxPreview(log.context) }}
                  </button>
                  <span v-else class="ctx-empty">—</span>
                </td>
                <td>{{ log.userEmail ?? '—' }}</td>
              </tr>
              <tr v-if="expanded.has(log.id) && log.context" class="ctx-row">
                <td colspan="6">
                  <pre class="ctx-json">{{ JSON.stringify(log.context, null, 2) }}</pre>
                </td>
              </tr>
            </template>
            <tr v-if="data.logs.length === 0">
              <td colspan="6" class="empty-cell">Aucun log</td>
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
.page-title { @apply font-serif text-2xl text-ink-900 dark:text-ink-100 mb-1; }
.page-sub { @apply text-sm text-ink-500 dark:text-ink-400 mb-6; }
.loading, .error { @apply text-sm text-ink-500 dark:text-ink-400; }
.cards-grid { @apply grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6; }
.stat-card {
  @apply rounded-lg border border-ink-200/60 dark:border-ink-800/60 p-4;
  background: theme('colors.ink.50');
}
html.dark .stat-card { background: theme('colors.ink.900'); }
.stat-card--err { @apply border-red-300 dark:border-red-700; background: theme('colors.red.50'); }
html.dark .stat-card--err { background: theme('colors.red.900' / 20%); }
.stat-card--warn { @apply border-amber-300 dark:border-amber-700; background: theme('colors.amber.50'); }
html.dark .stat-card--warn { background: theme('colors.amber.900' / 20%); }
.stat-card--info { @apply border-blue-200 dark:border-blue-800/60; background: theme('colors.blue.50'); }
html.dark .stat-card--info { background: theme('colors.blue.900' / 20%); }
.stat-val { @apply font-sans text-xl font-semibold text-ink-900 dark:text-ink-100 tabular-nums; }
.stat-lbl { @apply font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400 mt-0.5; }
.filters { @apply flex items-center gap-3 mb-4 flex-wrap; }
.sel {
  @apply px-3 py-1.5 text-sm rounded border border-ink-300 dark:border-ink-700 bg-ink-50 dark:bg-ink-900 text-ink-800 dark:text-ink-200 outline-none;
}
.search-input {
  @apply flex-1 min-w-[200px] max-w-md px-3 py-1.5 text-sm rounded border border-ink-300 dark:border-ink-700 bg-ink-50 dark:bg-ink-900 text-ink-900 dark:text-ink-100 outline-none;
}
.search-input:focus { @apply border-accent-500; }
.total-badge { @apply text-xs text-ink-500 dark:text-ink-400 font-sans ml-auto; }
.table-wrap { @apply rounded-lg border border-ink-200/60 dark:border-ink-800/60 overflow-x-auto; }
.data-table { @apply w-full text-sm text-left; }
.data-table thead { @apply bg-ink-100 dark:bg-ink-900/60; }
.data-table th { @apply px-4 py-2.5 font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400 font-semibold whitespace-nowrap; }
.data-table td { @apply px-4 py-2.5 border-t border-ink-200/50 dark:border-ink-800/50 text-ink-700 dark:text-ink-300; background: theme('colors.ink.50'); }
html.dark .data-table td { background: theme('colors.ink.900'); }
.mono { @apply font-mono text-xs tabular-nums; }
.msg-cell { @apply text-sm max-w-xl break-words; }
.badge { @apply inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide; }
.badge--debug { @apply bg-ink-100 dark:bg-ink-800 text-ink-600 dark:text-ink-400; }
.badge--info { @apply bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400; }
.badge--warn { @apply bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400; }
.badge--error { @apply bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400; }
.ctx-btn {
  @apply text-[11px] font-mono px-2 py-0.5 rounded border border-ink-300 dark:border-ink-700 text-ink-700 dark:text-ink-300;
  background: theme('colors.ink.50');
}
html.dark .ctx-btn { background: theme('colors.ink.900'); }
.ctx-btn:hover { @apply bg-ink-200 dark:bg-ink-800; }
.ctx-btn--open { @apply bg-accent-100 dark:bg-accent-900/40 border-accent-400 text-accent-700 dark:text-accent-300; }
.ctx-empty { @apply text-xs text-ink-400 dark:text-ink-600; }
.ctx-row td { @apply py-3; background: theme('colors.ink.100'); }
html.dark .ctx-row td { background: theme('colors.ink.950'); }
.ctx-json { @apply font-mono text-[11px] text-ink-700 dark:text-ink-300 whitespace-pre-wrap break-words m-0; }
.empty-cell { @apply text-center py-8 text-sm text-ink-400 dark:text-ink-600; }
.pagination { @apply flex items-center gap-3 mt-4 justify-end; }
.page-btn {
  @apply text-sm px-3 py-1 rounded border border-ink-300 dark:border-ink-700 text-ink-700 dark:text-ink-300 disabled:opacity-40;
  background: theme('colors.ink.50');
}
html.dark .page-btn { background: theme('colors.ink.900'); }
.page-info { @apply text-sm text-ink-600 dark:text-ink-400 tabular-nums; }
</style>
