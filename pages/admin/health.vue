<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useDialog } from '~/composables/useDialog'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const dialog = useDialog()

interface HealthData {
  dbFileSizeBytes: number
  tableCounts: Array<{ table: string, count: number }>
  lastEmbedAt: string | null
  unindexedDocCount: number
}

const data = ref<HealthData | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const reindexDocId = ref('')
const reindexLoading = ref(false)
const reindexResult = ref<string | null>(null)

onMounted(async () => {
  try {
    data.value = await $fetch<HealthData>('/api/admin/health')
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    loading.value = false
  }
})

function fmtBytes(n: number) {
  if (n < 1024) return `${n} o`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`
  return `${(n / 1024 / 1024).toFixed(2)} Mo`
}

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('fr-FR')
}

async function reindex() {
  const id = Number(reindexDocId.value.trim())
  if (!Number.isFinite(id) || id <= 0) {
    await dialog.alert({ title: 'ID invalide', message: 'Entrez un ID de document entier positif.' })
    return
  }
  const ok = await dialog.confirm({
    title: `Ré-indexer le document #${id} ?`,
    message: 'Les chunks existants seront remplacés.',
    confirmLabel: 'Ré-indexer',
  })
  if (!ok) return

  reindexLoading.value = true
  reindexResult.value = null
  try {
    const res = await $fetch<{ chunksIndexed: number }>('/api/admin/reindex', {
      method: 'POST',
      body: { docId: id },
    })
    reindexResult.value = `✓ ${res.chunksIndexed} chunks indexés pour le document #${id}`
    // Refresh health data
    data.value = await $fetch<HealthData>('/api/admin/health')
  }
  catch (e) {
    reindexResult.value = `✗ Erreur : ${(e as Error).message}`
  }
  finally {
    reindexLoading.value = false
  }
}
</script>

<template>
  <div class="admin-page">
    <h1 class="page-title">Santé système</h1>

    <div v-if="loading" class="loading">Chargement…</div>
    <div v-else-if="error" class="error">{{ error }}</div>

    <template v-else-if="data">
      <!-- Overview -->
      <div class="overview-grid">
        <div class="overview-card">
          <div class="ov-val">{{ fmtBytes(data.dbFileSizeBytes) }}</div>
          <div class="ov-lbl">Taille de la BDD</div>
        </div>
        <div class="overview-card">
          <div class="ov-val">{{ fmtDate(data.lastEmbedAt) }}</div>
          <div class="ov-lbl">Dernier embed réussi</div>
        </div>
        <div class="overview-card" :class="{ 'overview-card--warn': data.unindexedDocCount > 0 }">
          <div class="ov-val">{{ data.unindexedDocCount }}</div>
          <div class="ov-lbl">Documents non indexés</div>
        </div>
      </div>

      <!-- Table counts -->
      <section class="section">
        <h2 class="section-title">Répartition par table</h2>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Table</th>
                <th>Lignes</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in data.tableCounts" :key="t.table">
                <td class="mono">{{ t.table }}</td>
                <td class="mono">{{ t.count.toLocaleString('fr-FR') }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Manual reindex -->
      <section class="section">
        <h2 class="section-title">Ré-indexer un document</h2>
        <div class="reindex-form">
          <input
            v-model="reindexDocId"
            type="number"
            min="1"
            class="reindex-input"
            placeholder="ID du document"
            @keydown.enter="reindex"
          >
          <button class="reindex-btn" :disabled="reindexLoading || !reindexDocId" @click="reindex">
            {{ reindexLoading ? 'En cours…' : 'Ré-indexer' }}
          </button>
        </div>
        <p v-if="reindexResult" class="reindex-result" :class="{ 'reindex-result--ok': reindexResult.startsWith('✓'), 'reindex-result--err': reindexResult.startsWith('✗') }">
          {{ reindexResult }}
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.admin-page { @apply px-8 py-8 max-w-3xl; }
.page-title { @apply font-serif text-2xl text-ink-900 dark:text-ink-100 mb-6; }
.loading, .error { @apply text-sm text-ink-500 dark:text-ink-400; }
.overview-grid { @apply grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6; }
.overview-card {
  @apply rounded-lg border border-ink-200/60 dark:border-ink-800/60 p-4;
  background: theme('colors.ink.50');
}
html.dark .overview-card { background: theme('colors.ink.900'); }
.overview-card--warn { @apply border-amber-300 dark:border-amber-700; background: theme('colors.amber.50'); }
html.dark .overview-card--warn { background: theme('colors.amber.900' / 20%); }
.ov-val { @apply font-sans text-lg font-semibold text-ink-900 dark:text-ink-100 tabular-nums; }
.ov-lbl { @apply font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400; }
.section { @apply mb-6; }
.section-title { @apply font-sans text-[11px] uppercase tracking-[0.09em] font-semibold text-ink-500 dark:text-ink-400 mb-3; }
.table-wrap { @apply rounded-lg border border-ink-200/60 dark:border-ink-800/60 overflow-hidden; }
.data-table { @apply w-full text-sm text-left; }
.data-table thead { @apply bg-ink-100 dark:bg-ink-900/60; }
.data-table th { @apply px-4 py-2.5 font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400 font-semibold; }
.data-table td { @apply px-4 py-2.5 border-t border-ink-200/50 dark:border-ink-800/50 text-ink-700 dark:text-ink-300; background: theme('colors.ink.50'); }
html.dark .data-table td { background: theme('colors.ink.900'); }
.mono { @apply font-mono text-xs tabular-nums; }
.reindex-form { @apply flex gap-3 items-center; }
.reindex-input {
  @apply w-40 px-3 py-1.5 text-sm rounded border border-ink-300 dark:border-ink-700 bg-ink-50 dark:bg-ink-900 text-ink-900 dark:text-ink-100 outline-none;
}
.reindex-input:focus { @apply border-accent-500; }
.reindex-btn {
  @apply px-4 py-1.5 text-sm rounded border border-ink-300 dark:border-ink-700 text-ink-800 dark:text-ink-200 disabled:opacity-40;
  background: theme('colors.ink.100');
  transition: background 100ms;
}
html.dark .reindex-btn { background: theme('colors.ink.800'); }
.reindex-btn:not(:disabled):hover { @apply bg-accent-100 dark:bg-accent-900/30 border-accent-400 text-accent-700 dark:text-accent-300; }
.reindex-result { @apply mt-3 text-sm font-mono; }
.reindex-result--ok { @apply text-green-600 dark:text-green-400; }
.reindex-result--err { @apply text-red-600 dark:text-red-400; }
</style>
