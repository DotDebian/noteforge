<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useDialog } from '~/composables/useDialog'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const dialog = useDialog()
const router = useRouter()

interface AdminUser {
  id: number
  email: string
  displayName: string | null
  createdAt: string
  lastLoginAt: string | null
  isAdmin: boolean
  disabledAt: string | null
  workspaceCount: number
  docCount: number
}

const users = ref<AdminUser[]>([])
const total = ref(0)
const page = ref(1)
const limit = 20
const q = ref('')
const loading = ref(true)
const error = ref<string | null>(null)
const actionLoading = ref<number | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    const params = new URLSearchParams({ page: String(page.value), limit: String(limit) })
    if (q.value.trim()) params.set('q', q.value.trim())
    const data = await $fetch<{ users: AdminUser[], total: number }>(`/api/admin/users?${params}`)
    users.value = data.users
    total.value = data.total
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    loading.value = false
  }
}

onMounted(load)
watch([page, q], load)

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / limit)))

let searchTimer: ReturnType<typeof setTimeout> | null = null
function onSearch(e: Event) {
  if (searchTimer) clearTimeout(searchTimer)
  const v = (e.target as HTMLInputElement).value
  searchTimer = setTimeout(() => {
    q.value = v
    page.value = 1
  }, 300)
}

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
}

async function doAction(user: AdminUser, action: 'disable' | 'enable' | 'promote' | 'demote') {
  const labels: Record<string, string> = {
    disable: `Désactiver ${user.email} ?`,
    enable: `Réactiver ${user.email} ?`,
    promote: `Promouvoir ${user.email} admin ?`,
    demote: `Rétrograder ${user.email} ?`,
  }
  const ok = await dialog.confirm({
    title: labels[action]!,
    message: action === 'disable'
      ? 'Le compte sera bloqué. Les données sont conservées.'
      : action === 'promote'
        ? 'Cet utilisateur aura accès au panneau admin.'
        : '',
    confirmLabel: action === 'disable' || action === 'demote' ? 'Confirmer' : 'Confirmer',
    destructive: action === 'disable',
  })
  if (!ok) return

  actionLoading.value = user.id
  try {
    await $fetch(`/api/admin/users/${user.id}`, {
      method: 'PATCH',
      body: { action },
    })
    await load()
  }
  catch (e) {
    await dialog.alert({ title: 'Erreur', message: (e as Error).message })
  }
  finally {
    actionLoading.value = null
  }
}
</script>

<template>
  <div class="admin-page">
    <h1 class="page-title">Utilisateurs</h1>

    <div class="toolbar">
      <input
        type="search"
        class="search-input"
        placeholder="Rechercher par email ou nom…"
        @input="onSearch"
      >
      <span class="total-badge">{{ total.toLocaleString('fr-FR') }} utilisateurs</span>
    </div>

    <div v-if="error" class="error">{{ error }}</div>

    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Email / Nom</th>
            <th>Inscrit le</th>
            <th>Dernière connexion</th>
            <th>WS / Docs</th>
            <th>Statut</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="u in users"
            :key="u.id"
            class="table-row"
            :class="{ 'table-row--disabled': !!u.disabledAt }"
          >
            <td>
              <button class="user-link" @click="router.push(`/admin/users/${u.id}`)">
                <span class="user-email">{{ u.email }}</span>
                <span v-if="u.displayName" class="user-name">{{ u.displayName }}</span>
              </button>
            </td>
            <td class="mono">{{ fmtDate(u.createdAt) }}</td>
            <td class="mono">{{ fmtDate(u.lastLoginAt) }}</td>
            <td class="mono">{{ u.workspaceCount }} / {{ u.docCount }}</td>
            <td>
              <span v-if="u.isAdmin" class="badge badge--admin">Admin</span>
              <span v-if="u.disabledAt" class="badge badge--disabled">Désactivé</span>
              <span v-if="!u.isAdmin && !u.disabledAt" class="badge badge--user">Actif</span>
            </td>
            <td>
              <div class="actions">
                <button
                  v-if="!u.disabledAt"
                  class="act-btn act-btn--danger"
                  :disabled="actionLoading === u.id"
                  title="Désactiver"
                  @click="doAction(u, 'disable')"
                >
                  Désactiver
                </button>
                <button
                  v-else
                  class="act-btn"
                  :disabled="actionLoading === u.id"
                  title="Réactiver"
                  @click="doAction(u, 'enable')"
                >
                  Réactiver
                </button>
                <button
                  v-if="!u.isAdmin"
                  class="act-btn"
                  :disabled="actionLoading === u.id"
                  title="Promouvoir admin"
                  @click="doAction(u, 'promote')"
                >
                  ↑ Admin
                </button>
                <button
                  v-else
                  class="act-btn act-btn--danger"
                  :disabled="actionLoading === u.id"
                  title="Rétrograder"
                  @click="doAction(u, 'demote')"
                >
                  ↓ Retirer admin
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="!loading && users.length === 0">
            <td colspan="6" class="empty-cell">Aucun utilisateur trouvé</td>
          </tr>
        </tbody>
      </table>
      <div v-if="loading" class="loading-overlay">Chargement…</div>
    </div>

    <!-- Pagination -->
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
.toolbar { @apply flex items-center gap-4 mb-4; }
.search-input {
  @apply flex-1 max-w-xs px-3 py-1.5 text-sm rounded border border-ink-300 dark:border-ink-700 bg-ink-50 dark:bg-ink-900 text-ink-900 dark:text-ink-100 outline-none;
}
.search-input:focus { @apply border-accent-500; }
.total-badge { @apply text-xs text-ink-500 dark:text-ink-400 font-sans ml-auto; }
.error { @apply text-sm text-red-600 dark:text-red-400 mb-3; }
.table-wrap { @apply relative rounded-lg border border-ink-200/60 dark:border-ink-800/60 overflow-x-auto; }
.data-table { @apply w-full text-sm text-left; }
.data-table thead { @apply bg-ink-100 dark:bg-ink-900/60; }
.data-table th { @apply px-4 py-2.5 font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400 font-semibold whitespace-nowrap; }
.data-table td { @apply px-4 py-2.5 border-t border-ink-200/50 dark:border-ink-800/50; }
.table-row { @apply text-ink-800 dark:text-ink-200; }
.table-row--disabled { @apply opacity-50; }
.user-link { @apply flex flex-col items-start text-left hover:text-accent-600 dark:hover:text-accent-400; transition: color 120ms; }
.user-email { @apply text-sm font-medium; }
.user-name { @apply text-xs text-ink-500 dark:text-ink-400; }
.mono { @apply font-mono text-xs tabular-nums text-ink-600 dark:text-ink-400; }
.badge {
  @apply inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide;
}
.badge--admin { @apply bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300; }
.badge--disabled { @apply bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400; }
.badge--user { @apply bg-ink-100 dark:bg-ink-800 text-ink-600 dark:text-ink-400; }
.actions { @apply flex gap-1.5 items-center; }
.act-btn {
  @apply text-[11px] font-sans px-2 py-0.5 rounded border border-ink-300 dark:border-ink-700 text-ink-700 dark:text-ink-300;
  background: theme('colors.ink.50');
  transition: background 100ms, color 100ms, border-color 100ms;
}
html.dark .act-btn { background: theme('colors.ink.900'); }
.act-btn:hover { @apply bg-ink-200 dark:bg-ink-800; }
.act-btn:disabled { @apply opacity-40 cursor-not-allowed; }
.act-btn--danger:hover { @apply bg-red-100 dark:bg-red-900/30 border-red-300 dark:border-red-700 text-red-700 dark:text-red-400; }
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
