<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useDialog } from '~/composables/useDialog'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const dialog = useDialog()

interface HealthData {
  dbFileSizeBytes: number
  tableCounts: Array<{ table: string, count: number }>
  lastEmbedAt: string | null
  unindexedDocCount: number
  mcpTokens: {
    active: number
    revoked: number
    neverUsed: number
    total: number
  }
  indexDrift: {
    docChunks: number
    fts: number
    vec: number | null
    hasDrift: boolean
  }
  trash: {
    docs: number
    folders: number
    markdownBytes: number
  }
  dbGrowth: {
    snapshots: Array<{ day: string, sizeBytes: number }>
    currentBytes: number
    delta7d: number
    deltaPct7d: number
  }
}

const data = ref<HealthData | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const reindexDocId = ref('')
const reindexLoading = ref(false)
const reindexResult = ref<string | null>(null)
const snapshotLoading = ref(false)
const snapshotResult = ref<string | null>(null)
const purgeLoading = ref(false)
const purgeResult = ref<string | null>(null)

async function loadHealth() {
  data.value = await $fetch<HealthData>('/api/admin/health')
}

onMounted(async () => {
  try {
    await loadHealth()
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
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} Mo`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} Go`
}

function fmtSignedBytes(n: number): string {
  const sign = n >= 0 ? '+' : '−'
  return `${sign}${fmtBytes(Math.abs(n))}`
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
    reindexResult.value = `OK — ${res.chunksIndexed} chunks indexés pour le document #${id}`
    await loadHealth()
  }
  catch (e) {
    reindexResult.value = `Erreur : ${(e as Error).message}`
  }
  finally {
    reindexLoading.value = false
  }
}

async function captureSnapshot() {
  snapshotLoading.value = true
  snapshotResult.value = null
  try {
    await $fetch<{ snapshot: unknown }>('/api/admin/snapshot', { method: 'POST' })
    snapshotResult.value = 'Snapshot enregistré.'
    await loadHealth()
  }
  catch (e) {
    snapshotResult.value = `Erreur : ${(e as Error).message}`
  }
  finally {
    snapshotLoading.value = false
  }
}

async function purgeTrash() {
  const ok = await dialog.confirm({
    title: 'Vider la corbeille ?',
    message: 'Tous les documents et dossiers à la corbeille seront supprimés définitivement. Cette action est irréversible.',
    confirmLabel: 'Purger définitivement',
  })
  if (!ok) return

  purgeLoading.value = true
  purgeResult.value = null
  try {
    const res = await $fetch<{ docsDeleted: number, foldersDeleted: number }>('/api/admin/trash', {
      method: 'DELETE',
    })
    purgeResult.value = `OK — ${res.docsDeleted} documents et ${res.foldersDeleted} dossiers supprimés.`
    await loadHealth()
  }
  catch (e) {
    purgeResult.value = `Erreur : ${(e as Error).message}`
  }
  finally {
    purgeLoading.value = false
  }
}

/* ---------- Sparkline: DB size over time --------------------------------- */
const CHART_H = 80
const CHART_W = 560

const growthChart = computed(() => {
  const snaps = data.value?.dbGrowth.snapshots ?? []
  if (snaps.length < 2) return null

  // Bucket by day, taking the last value seen for that day.
  const days: string[] = []
  const today = new Date()
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    days.push(d.toISOString().slice(0, 10))
  }

  const map = new Map<string, number>()
  for (const s of snaps) map.set(s.day, s.sizeBytes)

  // Carry-forward fill so the line is continuous.
  let last = snaps[0]!.sizeBytes
  const values = days.map((d) => {
    const v = map.get(d)
    if (v !== undefined) last = v
    return last
  })

  const minVal = Math.min(...values)
  const maxVal = Math.max(...values)
  const span = Math.max(1, maxVal - minVal)
  const padLeft = 8
  const padRight = 8
  const w = CHART_W - padLeft - padRight

  const points = values.map((v, i) => {
    const x = padLeft + (i / (values.length - 1)) * w
    const y = CHART_H - 4 - (((v - minVal) / span) * (CHART_H - 12))
    return { x, y, v, day: days[i]! }
  })

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ')

  const areaD = `${pathD} L ${points[points.length - 1]!.x.toFixed(1)} ${CHART_H} L ${points[0]!.x.toFixed(1)} ${CHART_H} Z`

  return { points, pathD, areaD, days }
})

const deltaArrow = computed(() => {
  const d = data.value?.dbGrowth.delta7d ?? 0
  if (d > 0) return '↑'
  if (d < 0) return '↓'
  return '→'
})
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

      <!-- MCP tokens -->
      <section class="section">
        <h2 class="section-title label-mono">Tokens MCP</h2>
        <div class="mini-grid">
          <div class="mini-card">
            <div class="mini-val">{{ data.mcpTokens.active.toLocaleString('fr-FR') }}</div>
            <div class="mini-lbl">Actifs</div>
          </div>
          <div class="mini-card">
            <div class="mini-val">{{ data.mcpTokens.revoked.toLocaleString('fr-FR') }}</div>
            <div class="mini-lbl">Révoqués</div>
          </div>
          <div class="mini-card">
            <div class="mini-val">{{ data.mcpTokens.neverUsed.toLocaleString('fr-FR') }}</div>
            <div class="mini-lbl">Jamais utilisés</div>
          </div>
          <div class="mini-card">
            <div class="mini-val">{{ data.mcpTokens.total.toLocaleString('fr-FR') }}</div>
            <div class="mini-lbl">Total</div>
          </div>
        </div>
      </section>

      <!-- Index drift -->
      <section class="section">
        <h2 class="section-title label-mono">Cohérence des index</h2>
        <div class="mini-grid">
          <div class="mini-card" :class="{ 'mini-card--bad': data.indexDrift.hasDrift }">
            <div class="mini-val">{{ data.indexDrift.docChunks.toLocaleString('fr-FR') }}</div>
            <div class="mini-lbl">doc_chunks</div>
          </div>
          <div
            class="mini-card"
            :class="{ 'mini-card--bad': data.indexDrift.fts !== data.indexDrift.docChunks }"
          >
            <div class="mini-val">{{ data.indexDrift.fts.toLocaleString('fr-FR') }}</div>
            <div class="mini-lbl">FTS5 (BM25)</div>
          </div>
          <div
            class="mini-card"
            :class="{
              'mini-card--bad': data.indexDrift.vec !== null && data.indexDrift.vec !== data.indexDrift.docChunks,
              'mini-card--muted': data.indexDrift.vec === null,
            }"
          >
            <div class="mini-val">
              {{ data.indexDrift.vec === null ? '—' : data.indexDrift.vec.toLocaleString('fr-FR') }}
            </div>
            <div class="mini-lbl">vec0 (cosine)</div>
          </div>
        </div>
        <p v-if="data.indexDrift.hasDrift" class="drift-warning">
          Désynchronisation détectée — les compteurs devraient être identiques.
          Ré-indexez les documents concernés pour rétablir la cohérence.
        </p>
        <p v-else-if="data.indexDrift.vec === null" class="drift-info">
          Extension sqlite-vec indisponible — la recherche cosinus passe par le fallback JS.
        </p>
        <p v-else class="drift-ok">Index alignés.</p>
      </section>

      <!-- Trash -->
      <section class="section">
        <h2 class="section-title label-mono">Corbeille</h2>
        <div class="trash-card">
          <div class="trash-stats">
            <span class="trash-stat">
              <span class="trash-val">{{ data.trash.docs.toLocaleString('fr-FR') }}</span>
              <span class="trash-lbl">docs</span>
            </span>
            <span class="trash-stat">
              <span class="trash-val">{{ data.trash.folders.toLocaleString('fr-FR') }}</span>
              <span class="trash-lbl">dossiers</span>
            </span>
            <span class="trash-stat">
              <span class="trash-val">{{ fmtBytes(data.trash.markdownBytes) }}</span>
              <span class="trash-lbl">de markdown</span>
            </span>
          </div>
          <button
            class="danger-btn"
            :disabled="purgeLoading || (data.trash.docs === 0 && data.trash.folders === 0)"
            @click="purgeTrash"
          >
            {{ purgeLoading ? 'Purge en cours…' : 'Vider la corbeille (purge définitive)' }}
          </button>
        </div>
        <p v-if="purgeResult" class="action-result" :class="{ 'action-result--ok': purgeResult.startsWith('OK'), 'action-result--err': purgeResult.startsWith('Erreur') }">
          {{ purgeResult }}
        </p>
      </section>

      <!-- DB growth -->
      <section class="section">
        <div class="growth-header">
          <h2 class="section-title label-mono">Croissance de la BDD (30 jours)</h2>
          <button class="snapshot-btn" :disabled="snapshotLoading" @click="captureSnapshot">
            {{ snapshotLoading ? 'Capture…' : 'Capturer un snapshot' }}
          </button>
        </div>
        <div class="chart-card">
          <div class="growth-stats">
            <div class="growth-stat">
              <div class="growth-val">{{ fmtBytes(data.dbGrowth.currentBytes) }}</div>
              <div class="growth-lbl">Taille actuelle</div>
            </div>
            <div class="growth-stat">
              <div
                class="growth-val"
                :class="{
                  'growth-val--up': data.dbGrowth.delta7d > 0,
                  'growth-val--down': data.dbGrowth.delta7d < 0,
                }"
              >
                {{ deltaArrow }} {{ fmtSignedBytes(data.dbGrowth.delta7d) }}
                <span class="growth-pct">({{ data.dbGrowth.deltaPct7d.toFixed(1) }} %)</span>
              </div>
              <div class="growth-lbl">Δ 7 derniers jours</div>
            </div>
          </div>

          <template v-if="growthChart">
            <svg :viewBox="`0 0 ${CHART_W} ${CHART_H}`" class="chart-svg">
              <defs>
                <linearGradient id="growth-area-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="currentColor" stop-opacity="0.18" />
                  <stop offset="100%" stop-color="currentColor" stop-opacity="0.02" />
                </linearGradient>
              </defs>
              <path :d="growthChart.areaD" fill="url(#growth-area-grad)" class="chart-area" />
              <path
                :d="growthChart.pathD"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="chart-line"
              />
              <circle
                v-for="p in growthChart.points.filter((_, i) => i % 5 === 0 || i === growthChart!.points.length - 1)"
                :key="p.day"
                :cx="p.x"
                :cy="p.y"
                r="2.5"
                fill="currentColor"
                class="chart-dot"
              />
            </svg>
            <div class="chart-labels">
              <span class="chart-label-start">{{ growthChart.days[0] }}</span>
              <span class="chart-label-end">{{ growthChart.days[growthChart.days.length - 1] }}</span>
            </div>
          </template>
          <div v-else class="chart-empty">
            Pas assez de snapshots pour tracer une courbe. Lancez « Capturer un snapshot » pour commencer.
          </div>
        </div>
        <p v-if="snapshotResult" class="action-result" :class="{ 'action-result--ok': snapshotResult.startsWith('Snapshot'), 'action-result--err': snapshotResult.startsWith('Erreur') }">
          {{ snapshotResult }}
        </p>
      </section>

      <!-- Table counts -->
      <section class="section">
        <h2 class="section-title label-mono">Répartition par table</h2>
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
        <h2 class="section-title label-mono">Ré-indexer un document</h2>
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
        <p v-if="reindexResult" class="action-result" :class="{ 'action-result--ok': reindexResult.startsWith('OK'), 'action-result--err': reindexResult.startsWith('Erreur') }">
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

.section { @apply mb-7; }
.section-title { @apply text-ink-500 dark:text-ink-400 mb-3; }

/* Mini cards for tokens / drift */
.mini-grid { @apply grid grid-cols-2 sm:grid-cols-4 gap-3; }
.mini-card {
  @apply rounded-lg border border-ink-200/60 dark:border-ink-800/60 p-3;
  background: theme('colors.ink.50');
}
html.dark .mini-card { background: theme('colors.ink.900'); }
.mini-card--bad {
  @apply border-red-400 dark:border-red-700;
  background: theme('colors.red.50');
}
html.dark .mini-card--bad { background: theme('colors.red.900' / 20%); }
.mini-card--muted { @apply opacity-60; }
.mini-val { @apply font-sans text-base font-semibold text-ink-900 dark:text-ink-100 tabular-nums; }
.mini-card--bad .mini-val { @apply text-red-700 dark:text-red-300; }
.mini-lbl { @apply font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400 mt-0.5; }

.drift-warning { @apply mt-3 text-sm text-red-700 dark:text-red-300; }
.drift-info { @apply mt-3 text-sm text-ink-500 dark:text-ink-400; }
.drift-ok { @apply mt-3 text-sm text-green-700 dark:text-green-400; }

/* Trash card */
.trash-card {
  @apply rounded-lg border border-ink-200/60 dark:border-ink-800/60 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4;
  background: theme('colors.ink.50');
}
html.dark .trash-card { background: theme('colors.ink.900'); }
.trash-stats { @apply flex flex-wrap gap-6; }
.trash-stat { @apply flex flex-col; }
.trash-val { @apply font-sans text-base font-semibold text-ink-900 dark:text-ink-100 tabular-nums; }
.trash-lbl { @apply font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400; }

.danger-btn {
  @apply px-4 py-1.5 text-sm rounded border text-red-700 dark:text-red-300 disabled:opacity-40;
  background: theme('colors.red.50');
  border-color: theme('colors.red.300');
  transition: background 100ms;
}
html.dark .danger-btn {
  background: theme('colors.red.900' / 20%);
  border-color: theme('colors.red.700');
}
.danger-btn:not(:disabled):hover {
  background: theme('colors.red.100');
  border-color: theme('colors.red.400');
}
html.dark .danger-btn:not(:disabled):hover {
  background: theme('colors.red.900' / 40%);
}

/* Growth chart */
.growth-header { @apply flex items-center justify-between mb-3; }
.snapshot-btn {
  @apply px-3 py-1 text-xs rounded border border-ink-300 dark:border-ink-700 text-ink-700 dark:text-ink-300 disabled:opacity-40;
  background: theme('colors.ink.100');
  transition: background 100ms;
}
html.dark .snapshot-btn { background: theme('colors.ink.800'); }
.snapshot-btn:not(:disabled):hover { @apply bg-accent-100 dark:bg-accent-900/30 border-accent-400 text-accent-700 dark:text-accent-300; }

.chart-card {
  @apply rounded-lg border border-ink-200/60 dark:border-ink-800/60 p-5;
  background: theme('colors.ink.50');
}
html.dark .chart-card { background: theme('colors.ink.900'); }
.growth-stats { @apply flex flex-wrap gap-8 mb-4; }
.growth-stat { @apply flex flex-col; }
.growth-val { @apply font-sans text-lg font-semibold text-ink-900 dark:text-ink-100 tabular-nums; }
.growth-val--up { @apply text-amber-600 dark:text-amber-400; }
.growth-val--down { @apply text-green-700 dark:text-green-400; }
.growth-pct { @apply font-sans text-xs font-normal text-ink-500 dark:text-ink-400 ml-1; }
.growth-lbl { @apply font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400; }

.chart-svg {
  @apply w-full text-accent-500 dark:text-accent-400;
  height: 80px;
}
.chart-labels { @apply flex justify-between mt-1; }
.chart-label-start, .chart-label-end {
  @apply font-sans text-[10px] text-ink-400 dark:text-ink-600 tabular-nums;
}
.chart-empty { @apply text-sm text-ink-400 dark:text-ink-600 py-6 text-center; }

/* Tables */
.table-wrap { @apply rounded-lg border border-ink-200/60 dark:border-ink-800/60 overflow-hidden; }
.data-table { @apply w-full text-sm text-left; }
.data-table thead { @apply bg-ink-100 dark:bg-ink-900/60; }
.data-table th { @apply px-4 py-2.5 font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400 font-semibold; }
.data-table td { @apply px-4 py-2.5 border-t border-ink-200/50 dark:border-ink-800/50 text-ink-700 dark:text-ink-300; background: theme('colors.ink.50'); }
html.dark .data-table td { background: theme('colors.ink.900'); }
.mono { @apply font-mono text-xs tabular-nums; }

/* Reindex form */
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

/* Shared action result */
.action-result { @apply mt-3 text-sm; }
.action-result--ok { @apply text-green-700 dark:text-green-400; }
.action-result--err { @apply text-red-600 dark:text-red-400; }
</style>
