<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDialog } from '~/composables/useDialog'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const route = useRoute()
const router = useRouter()
const dialog = useDialog()

interface UserDetail {
  user: {
    id: number
    email: string
    displayName: string | null
    createdAt: string
    lastLoginAt: string | null
    isAdmin: boolean
    disabledAt: string | null
    workspaceCount: number
    docCount: number
    chunkCount: number
    chatSessionCount: number
  }
  workspaces: Array<{ id: number, name: string, emoji: string | null, createdAt: string, docCount: number }>
  aiUsage: Array<{ model: string, operation: string, promptTokens: number, completionTokens: number, totalTokens: number }>
}

const data = ref<UserDetail | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const actionLoading = ref(false)

const userId = Number(route.params.id)

onMounted(async () => {
  try {
    data.value = await $fetch<UserDetail>(`/api/admin/users/${userId}`)
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    loading.value = false
  }
})

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })
}

async function doAction(action: 'disable' | 'enable' | 'promote' | 'demote') {
  if (!data.value) return
  const labels: Record<string, string> = {
    disable: `Désactiver ${data.value.user.email} ?`,
    enable: `Réactiver ${data.value.user.email} ?`,
    promote: `Promouvoir ${data.value.user.email} admin ?`,
    demote: `Rétrograder ${data.value.user.email} ?`,
  }
  const ok = await dialog.confirm({
    title: labels[action]!,
    message: action === 'disable' ? 'Les données sont conservées, le login est bloqué.' : '',
    confirmLabel: 'Confirmer',
    destructive: action === 'disable',
  })
  if (!ok) return
  actionLoading.value = true
  try {
    await $fetch(`/api/admin/users/${userId}`, { method: 'PATCH', body: { action } })
    data.value = await $fetch<UserDetail>(`/api/admin/users/${userId}`)
  }
  catch (e) {
    await dialog.alert({ title: 'Erreur', message: (e as Error).message })
  }
  finally {
    actionLoading.value = false
  }
}

function totalTokensForModel(model: string) {
  if (!data.value) return 0
  return data.value.aiUsage.filter(r => r.model === model).reduce((s, r) => s + r.totalTokens, 0)
}
</script>

<template>
  <div class="admin-page">
    <button class="back-btn" @click="router.push('/admin/users')">
      ← Utilisateurs
    </button>

    <div v-if="loading" class="loading">Chargement…</div>
    <div v-else-if="error" class="error">{{ error }}</div>
    <template v-else-if="data">
      <div class="user-header">
        <div class="user-avatar">{{ (data.user.displayName || data.user.email).slice(0, 1).toUpperCase() }}</div>
        <div class="user-meta">
          <h1 class="user-title">{{ data.user.displayName || data.user.email }}</h1>
          <p class="user-sub">{{ data.user.email }}</p>
        </div>
        <div class="header-badges">
          <span v-if="data.user.isAdmin" class="badge badge--admin">Admin</span>
          <span v-if="data.user.disabledAt" class="badge badge--disabled">Désactivé</span>
        </div>
        <div class="header-actions">
          <button v-if="!data.user.disabledAt" class="act-btn act-btn--danger" :disabled="actionLoading" @click="doAction('disable')">Désactiver</button>
          <button v-else class="act-btn" :disabled="actionLoading" @click="doAction('enable')">Réactiver</button>
          <button v-if="!data.user.isAdmin" class="act-btn" :disabled="actionLoading" @click="doAction('promote')">↑ Admin</button>
          <button v-else class="act-btn act-btn--danger" :disabled="actionLoading" @click="doAction('demote')">↓ Retirer admin</button>
        </div>
      </div>

      <!-- Stats -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-val">{{ fmtDate(data.user.createdAt) }}</div>
          <div class="stat-lbl">Inscrit le</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">{{ fmtDate(data.user.lastLoginAt) }}</div>
          <div class="stat-lbl">Dernière connexion</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">{{ data.user.workspaceCount }}</div>
          <div class="stat-lbl">Espaces de travail</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">{{ data.user.docCount }}</div>
          <div class="stat-lbl">Documents</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">{{ data.user.chunkCount.toLocaleString('fr-FR') }}</div>
          <div class="stat-lbl">Chunks indexés</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">{{ data.user.chatSessionCount }}</div>
          <div class="stat-lbl">Sessions chat</div>
        </div>
      </div>

      <!-- Workspaces -->
      <section class="section">
        <h2 class="section-title">Espaces de travail</h2>
        <div v-if="data.workspaces.length === 0" class="empty">Aucun espace</div>
        <div v-else class="ws-list">
          <div v-for="ws in data.workspaces" :key="ws.id" class="ws-row">
            <span class="ws-emoji">{{ ws.emoji || '📁' }}</span>
            <span class="ws-name">{{ ws.name }}</span>
            <span class="ws-docs">{{ ws.docCount }} docs</span>
            <span class="ws-date">{{ fmtDate(ws.createdAt) }}</span>
          </div>
        </div>
      </section>

      <!-- AI Usage -->
      <section v-if="data.aiUsage.length > 0" class="section">
        <h2 class="section-title">Consommation Mistral</h2>
        <table class="data-table">
          <thead>
            <tr>
              <th>Modèle</th>
              <th>Opération</th>
              <th>Tokens prompt</th>
              <th>Tokens completion</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in data.aiUsage" :key="`${r.model}-${r.operation}`">
              <td class="mono">{{ r.model }}</td>
              <td class="mono">{{ r.operation }}</td>
              <td class="mono">{{ r.promptTokens.toLocaleString('fr-FR') }}</td>
              <td class="mono">{{ r.completionTokens.toLocaleString('fr-FR') }}</td>
              <td class="mono font-semibold">{{ r.totalTokens.toLocaleString('fr-FR') }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
  </div>
</template>

<style scoped>
.admin-page { @apply px-8 py-8 max-w-4xl; }
.back-btn { @apply text-sm text-ink-500 dark:text-ink-400 hover:text-ink-900 dark:hover:text-ink-100 mb-6 block; transition: color 120ms; }
.loading, .error, .empty { @apply text-sm text-ink-500 dark:text-ink-400; }
.user-header { @apply flex items-center gap-4 mb-6; }
.user-avatar { @apply w-12 h-12 rounded-full bg-accent-100 dark:bg-accent-900/40 flex items-center justify-center text-xl font-semibold text-accent-700 dark:text-accent-300 shrink-0; }
.user-meta { @apply flex-1 min-w-0; }
.user-title { @apply font-serif text-2xl text-ink-900 dark:text-ink-100; }
.user-sub { @apply text-sm text-ink-500 dark:text-ink-400 truncate; }
.header-badges { @apply flex gap-2; }
.header-actions { @apply flex gap-2; }
.badge { @apply inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide; }
.badge--admin { @apply bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300; }
.badge--disabled { @apply bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400; }
.act-btn {
  @apply text-[11px] font-sans px-2.5 py-1 rounded border border-ink-300 dark:border-ink-700 text-ink-700 dark:text-ink-300 disabled:opacity-40;
  background: theme('colors.ink.50');
  transition: background 100ms;
}
html.dark .act-btn { background: theme('colors.ink.900'); }
.act-btn:hover { @apply bg-ink-200 dark:bg-ink-800; }
.act-btn--danger:hover { @apply bg-red-100 dark:bg-red-900/30 border-red-300 dark:border-red-700 text-red-700 dark:text-red-400; }
.stats-grid { @apply grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6; }
.stat-card { @apply rounded-lg border border-ink-200/60 dark:border-ink-800/60 p-3; background: theme('colors.ink.50'); }
html.dark .stat-card { background: theme('colors.ink.900'); }
.stat-val { @apply font-sans text-lg font-semibold text-ink-900 dark:text-ink-100 tabular-nums; }
.stat-lbl { @apply font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400; }
.section { @apply mb-6; }
.section-title { @apply font-sans text-[11px] uppercase tracking-[0.09em] font-semibold text-ink-500 dark:text-ink-400 mb-3; }
.ws-list { @apply rounded-lg border border-ink-200/60 dark:border-ink-800/60 overflow-hidden; }
.ws-row { @apply flex items-center gap-3 px-4 py-2.5 border-b last:border-b-0 border-ink-200/50 dark:border-ink-800/50 text-sm; background: theme('colors.ink.50'); }
html.dark .ws-row { background: theme('colors.ink.900'); }
.ws-emoji { @apply shrink-0; }
.ws-name { @apply flex-1 font-medium text-ink-800 dark:text-ink-200; }
.ws-docs { @apply text-xs text-ink-500 dark:text-ink-400 tabular-nums; }
.ws-date { @apply text-xs text-ink-400 dark:text-ink-600 tabular-nums ml-2; }
.data-table { @apply w-full text-sm text-left rounded-lg border border-ink-200/60 dark:border-ink-800/60 overflow-hidden; }
.data-table thead { @apply bg-ink-100 dark:bg-ink-900/60; }
.data-table th { @apply px-4 py-2.5 font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400 font-semibold; }
.data-table td { @apply px-4 py-2.5 border-t border-ink-200/50 dark:border-ink-800/50 text-ink-700 dark:text-ink-300; background: theme('colors.ink.50'); }
html.dark .data-table td { background: theme('colors.ink.900'); }
.mono { @apply font-mono text-xs tabular-nums; }
</style>
