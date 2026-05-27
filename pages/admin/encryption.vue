<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })

interface Stats { total: number, migrated: number, legacy: number, broken: number }
interface PerEntityRow { entityType: string, count: number }
interface RecentFailureRow {
  id: number
  createdAt: string
  userId: number | null
  email: string | null
  entityType: string
  entityId: number | null
  field: string
  errorMessage: string | null
}
interface UserRow {
  id: number
  email: string
  encryptionEnabled: boolean
  hasWrappedDek: boolean
  hasRecovery: boolean
  hasKdfSalt: boolean
}
interface EncryptionData {
  stats: Stats
  failures: { total7d: number, byType: PerEntityRow[] }
  recentFailures: RecentFailureRow[]
  users: { total: number, page: number, limit: number, rows: UserRow[] }
}

const data = ref<EncryptionData | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const page = ref(1)
const limit = 50

async function load() {
  loading.value = true
  error.value = null
  try {
    const params = new URLSearchParams({ page: String(page.value), limit: String(limit) })
    data.value = await $fetch<EncryptionData>(`/api/admin/encryption?${params}`)
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    loading.value = false
  }
}

onMounted(load)
watch(page, load)

const totalPages = computed(() => {
  if (!data.value) return 1
  return Math.max(1, Math.ceil(data.value.users.total / limit))
})

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('fr-FR')
}
</script>

<template>
  <div class="admin-page">
    <h1 class="page-title">Chiffrement au repos</h1>

    <div v-if="loading && !data" class="loading">Chargement…</div>
    <div v-else-if="error" class="error">{{ error }}</div>

    <template v-if="data">
      <!-- Status cards -->
      <div class="metrics-grid">
        <div class="stat-card">
          <div class="stat-value stat-value--ok">{{ data.stats.migrated.toLocaleString('fr-FR') }}</div>
          <div class="stat-label label-mono">Utilisateurs chiffrés</div>
        </div>
        <div class="stat-card" :class="{ 'stat-card--warn': data.stats.legacy > 0 }">
          <div class="stat-value">{{ data.stats.legacy.toLocaleString('fr-FR') }}</div>
          <div class="stat-label label-mono">Legacy (non migrés)</div>
        </div>
        <div class="stat-card" :class="{ 'stat-card--err': data.stats.broken > 0 }">
          <div class="stat-value stat-value--err">{{ data.stats.broken.toLocaleString('fr-FR') }}</div>
          <div class="stat-label label-mono">État incohérent</div>
        </div>
        <div class="stat-card" :class="{ 'stat-card--warn': data.failures.total7d >= 5 }">
          <div class="stat-value">{{ data.failures.total7d.toLocaleString('fr-FR') }}</div>
          <div class="stat-label label-mono">Échecs déchiffrement (7j)</div>
        </div>
      </div>

      <!-- Failures by entity type -->
      <section v-if="data.failures.byType.length > 0" class="section">
        <h2 class="section-title">Échecs de déchiffrement par type d'entité (7j)</h2>
        <table class="data-table">
          <thead>
            <tr>
              <th>Type d'entité</th>
              <th>Nombre</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in data.failures.byType" :key="r.entityType">
              <td class="mono">{{ r.entityType }}</td>
              <td class="mono font-semibold">{{ r.count.toLocaleString('fr-FR') }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- Per-user state -->
      <section class="section">
        <h2 class="section-title">État chiffrement par utilisateur</h2>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Chiffré</th>
                <th>DEK wrappée</th>
                <th>Récupération</th>
                <th>Sel KDF</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in data.users.rows" :key="u.id" :class="{ 'row--broken': u.encryptionEnabled && !u.hasWrappedDek }">
                <td>{{ u.email }}</td>
                <td>
                  <span class="badge" :class="u.encryptionEnabled ? 'badge--ok' : 'badge--neutral'">
                    {{ u.encryptionEnabled ? 'Oui' : 'Non' }}
                  </span>
                </td>
                <td>
                  <span class="badge" :class="u.hasWrappedDek ? 'badge--ok' : 'badge--neutral'">
                    {{ u.hasWrappedDek ? 'Oui' : 'Non' }}
                  </span>
                </td>
                <td>
                  <span class="badge" :class="u.hasRecovery ? 'badge--ok' : 'badge--neutral'">
                    {{ u.hasRecovery ? 'Oui' : 'Non' }}
                  </span>
                </td>
                <td>
                  <span class="badge" :class="u.hasKdfSalt ? 'badge--ok' : 'badge--neutral'">
                    {{ u.hasKdfSalt ? 'Oui' : 'Non' }}
                  </span>
                </td>
              </tr>
              <tr v-if="data.users.rows.length === 0">
                <td colspan="5" class="empty-cell">Aucun utilisateur</td>
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
      </section>

      <!-- Recent decryption failures -->
      <section class="section">
        <h2 class="section-title">Échecs de déchiffrement récents (100 derniers)</h2>
        <table class="data-table">
          <thead>
            <tr>
              <th>Horodatage</th>
              <th>Utilisateur</th>
              <th>Type</th>
              <th>ID</th>
              <th>Champ</th>
              <th>Erreur</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in data.recentFailures" :key="r.id">
              <td class="mono">{{ fmtDate(r.createdAt) }}</td>
              <td>{{ r.email ?? `#${r.userId ?? '—'}` }}</td>
              <td class="mono">{{ r.entityType }}</td>
              <td class="mono">{{ r.entityId ?? '—' }}</td>
              <td class="mono">{{ r.field }}</td>
              <td class="mono cell-err">{{ r.errorMessage ?? '' }}</td>
            </tr>
            <tr v-if="data.recentFailures.length === 0">
              <td colspan="6" class="empty-cell">Aucun échec enregistré</td>
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

.metrics-grid { @apply grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6; }
.stat-card {
  @apply rounded-lg p-4 border border-ink-200/60 dark:border-ink-800/60;
  background: theme('colors.ink.50');
}
html.dark .stat-card { background: theme('colors.ink.900'); }
.stat-card--warn { @apply border-amber-300 dark:border-amber-700; background: theme('colors.amber.50'); }
html.dark .stat-card--warn { background: theme('colors.amber.900' / 20%); }
.stat-card--err { @apply border-red-300 dark:border-red-700; background: theme('colors.red.50'); }
html.dark .stat-card--err { background: theme('colors.red.900' / 20%); }
.stat-value { @apply font-sans text-2xl font-semibold text-ink-900 dark:text-ink-100 tabular-nums; }
.stat-value--ok { @apply text-green-600 dark:text-green-400; }
.stat-value--err { @apply text-red-600 dark:text-red-400; }
.stat-label { @apply mt-0.5 text-ink-500 dark:text-ink-400; }

.section { @apply mb-6; }
.section-title { @apply font-sans text-[11px] uppercase tracking-[0.09em] font-semibold text-ink-500 dark:text-ink-400 mb-3; }
.table-wrap { @apply relative rounded-lg border border-ink-200/60 dark:border-ink-800/60 overflow-x-auto; }
.data-table { @apply w-full text-sm text-left rounded-lg border border-ink-200/60 dark:border-ink-800/60 overflow-hidden; }
.data-table thead { @apply bg-ink-100 dark:bg-ink-900/60; }
.data-table th { @apply px-4 py-2.5 font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400 font-semibold; }
.data-table td { @apply px-4 py-2.5 border-t border-ink-200/50 dark:border-ink-800/50 text-ink-700 dark:text-ink-300; background: theme('colors.ink.50'); }
html.dark .data-table td { background: theme('colors.ink.900'); }
.row--broken td { background: theme('colors.red.50'); }
html.dark .row--broken td { background: theme('colors.red.900' / 15%); }
.mono { @apply font-mono text-xs tabular-nums; }
.cell-err { @apply text-red-600 dark:text-red-400; }
.badge {
  @apply inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide;
}
.badge--ok { @apply bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400; }
.badge--neutral { @apply bg-ink-100 dark:bg-ink-800 text-ink-500 dark:text-ink-500; }
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
