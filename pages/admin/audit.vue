<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })

interface AuditRow {
  id: number
  createdAt: string
  adminId: number
  adminEmail: string | null
  action: string
  targetType: string | null
  targetId: number | null
  payload: string | null
}
interface AdminPick { id: number, email: string, count: number }
interface ActionPick { action: string, count: number }
interface AuditData {
  total: number
  page: number
  limit: number
  rows: AuditRow[]
  filters: { admins: AdminPick[], actions: ActionPick[] }
}

const data = ref<AuditData | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const expanded = ref<Set<number>>(new Set())

const page = ref(1)
const limit = 50
const actionPrefix = ref<string>('')
const adminId = ref<number | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    const params = new URLSearchParams({ page: String(page.value), limit: String(limit) })
    if (actionPrefix.value) params.set('actionPrefix', actionPrefix.value)
    if (adminId.value) params.set('adminId', String(adminId.value))
    data.value = await $fetch<AuditData>(`/api/admin/audit?${params}`)
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    loading.value = false
  }
}

onMounted(load)
watch([page, actionPrefix, adminId], () => {
  if (page.value !== 1 && (actionPrefix.value !== '' || adminId.value !== null)) {
    // resetting filters should reset to page 1
  }
  load()
})

function resetFilters() {
  actionPrefix.value = ''
  adminId.value = null
  page.value = 1
}

const totalPages = computed(() => {
  if (!data.value) return 1
  return Math.max(1, Math.ceil(data.value.total / limit))
})

/* ---- Build action category list (everything before the first '.') ---- */
const actionCategories = computed(() => {
  if (!data.value) return []
  const seen = new Set<string>()
  for (const a of data.value.filters.actions) {
    const dot = a.action.indexOf('.')
    seen.add(dot > 0 ? a.action.slice(0, dot) : a.action)
  }
  return [...seen].sort()
})

function toggleRow(id: number) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('fr-FR')
}

function payloadSummary(payload: string | null): string {
  if (!payload) return ''
  return payload.length > 100 ? `${payload.slice(0, 100)}…` : payload
}

function payloadPretty(payload: string | null): string {
  if (!payload) return ''
  try {
    return JSON.stringify(JSON.parse(payload), null, 2)
  }
  catch {
    return payload
  }
}
</script>

<template>
  <div class="admin-page">
    <h1 class="page-title">Journal d'audit</h1>

    <div class="filters">
      <select v-model="actionPrefix" class="sel" @change="page = 1">
        <option value="">Toutes les catégories</option>
        <option v-for="c in actionCategories" :key="c" :value="c">{{ c }}</option>
      </select>
      <select v-model="adminId" class="sel" @change="page = 1">
        <option :value="null">Tous les admins</option>
        <option v-for="a in data?.filters.admins ?? []" :key="a.id" :value="a.id">
          {{ a.email }} ({{ a.count.toLocaleString('fr-FR') }})
        </option>
      </select>
      <button v-if="actionPrefix || adminId" class="reset-btn" @click="resetFilters">
        Réinitialiser
      </button>
      <span class="total-badge">{{ (data?.total ?? 0).toLocaleString('fr-FR') }} entrées</span>
    </div>

    <div v-if="error" class="error">{{ error }}</div>

    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Horodatage</th>
            <th>Admin</th>
            <th>Action</th>
            <th>Cible</th>
            <th>Payload</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="r in data?.rows ?? []" :key="r.id">
            <tr class="row" :class="{ 'row--expanded': expanded.has(r.id) }" @click="toggleRow(r.id)">
              <td class="mono">{{ fmtDate(r.createdAt) }}</td>
              <td>{{ r.adminEmail ?? `#${r.adminId}` }}</td>
              <td class="mono">{{ r.action }}</td>
              <td class="mono">{{ r.targetType ?? '' }}{{ r.targetId != null ? ` #${r.targetId}` : '' }}</td>
              <td class="mono payload-cell">{{ payloadSummary(r.payload) }}</td>
            </tr>
            <tr v-if="expanded.has(r.id) && r.payload" class="row-payload">
              <td colspan="5">
                <pre class="payload-pre">{{ payloadPretty(r.payload) }}</pre>
              </td>
            </tr>
          </template>
          <tr v-if="!loading && (data?.rows.length ?? 0) === 0">
            <td colspan="5" class="empty-cell">Aucune entrée</td>
          </tr>
        </tbody>
      </table>
      <div v-if="loading" class="loading-overlay">Chargement…</div>
    </div>

    <div v-if="totalPages > 1" class="pagination">
      <button class="page-btn" :disabled="page <= 1" @click="page--">←</button>
      <span class="page-info">{{ page }} / {{ totalPages }}</span>
      <button class="page-btn" :disabled="page >= totalPages" @click="page++">→</button>
    </div>
  </div>
</template>

<style scoped>
.admin-page { @apply px-8 py-8 max-w-6xl; }
.page-title { @apply font-serif text-2xl text-ink-900 dark:text-ink-100 mb-6; }
.filters { @apply flex gap-3 mb-4 items-center flex-wrap; }
.sel {
  @apply px-3 py-1.5 text-sm rounded border border-ink-300 dark:border-ink-700 bg-ink-50 dark:bg-ink-900 text-ink-800 dark:text-ink-200 outline-none;
}
.reset-btn {
  @apply text-xs px-2.5 py-1 rounded border border-ink-300 dark:border-ink-700 text-ink-600 dark:text-ink-400;
  background: theme('colors.ink.50');
}
html.dark .reset-btn { background: theme('colors.ink.900'); }
.reset-btn:hover { @apply bg-ink-200 dark:bg-ink-800; }
.total-badge { @apply text-xs text-ink-500 dark:text-ink-400 font-sans ml-auto; }
.error { @apply text-sm text-red-600 dark:text-red-400 mb-3; }
.table-wrap { @apply relative rounded-lg border border-ink-200/60 dark:border-ink-800/60 overflow-x-auto; }
.data-table { @apply w-full text-sm text-left; }
.data-table thead { @apply bg-ink-100 dark:bg-ink-900/60; }
.data-table th { @apply px-4 py-2.5 font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400 font-semibold whitespace-nowrap; }
.data-table td { @apply px-4 py-2.5 border-t border-ink-200/50 dark:border-ink-800/50 text-ink-700 dark:text-ink-300; background: theme('colors.ink.50'); }
html.dark .data-table td { background: theme('colors.ink.900'); }
.row { cursor: pointer; transition: background 100ms; }
.row:hover td { @apply bg-ink-100 dark:bg-ink-800/50; }
.row--expanded td { @apply bg-accent-50 dark:bg-accent-900/20; }
.row-payload td { @apply p-0 border-t-0; }
.payload-pre {
  @apply font-mono text-[11px] text-ink-700 dark:text-ink-300 whitespace-pre-wrap break-all px-4 py-3 m-0;
  background: theme('colors.ink.100');
}
html.dark .payload-pre { background: theme('colors.ink.950'); }
.mono { @apply font-mono text-xs tabular-nums; }
.payload-cell { @apply max-w-[36ch] truncate text-ink-500 dark:text-ink-400; }
.empty-cell { @apply text-center py-8 text-sm text-ink-400 dark:text-ink-600; }
.loading-overlay { @apply absolute inset-0 flex items-center justify-center text-sm text-ink-500 bg-ink-50/80 dark:bg-ink-950/80; }
.pagination { @apply flex items-center gap-3 mt-4 justify-end; }
.page-btn {
  @apply text-sm px-3 py-1 rounded border border-ink-300 dark:border-ink-700 text-ink-700 dark:text-ink-300 disabled:opacity-40;
  background: theme('colors.ink.50');
}
html.dark .page-btn { background: theme('colors.ink.900'); }
.page-info { @apply text-sm text-ink-600 dark:text-ink-400 tabular-nums; }
</style>
