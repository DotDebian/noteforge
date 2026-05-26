<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Document, Folder } from '~/server/database/schema'
import { useDialog } from '~/composables/useDialog'
import { useTreeStore } from '~/stores/tree'
import { useLocale } from '~/composables/useLocale'

const { t } = useLocale()
useHead(() => ({ title: t('doc.head.trash') }))

const route = useRoute()
const dialog = useDialog()
const treeStore = useTreeStore()

const workspaceId = computed(() => Number(route.params.workspaceId))

type TrashDoc = Omit<Document, 'markdown' | 'contentJson'>
interface TrashResponse { documents: TrashDoc[], folders: Folder[] }

const { data, pending, error, refresh } = await useFetch<TrashResponse>(
  '/api/trash',
  { query: { workspaceId }, watch: [workspaceId] },
)

const items = computed(() => {
  const docs = data.value?.documents ?? []
  const folders = data.value?.folders ?? []
  type Row =
    | { kind: 'doc', id: number, title: string, deletedAt: Date | null }
    | { kind: 'folder', id: number, title: string, deletedAt: Date | null }
  const rows: Row[] = []
  for (const f of folders) {
    rows.push({
      kind: 'folder',
      id: f.id,
      title: f.name || t('trash.untitledFolder'),
      deletedAt: toDate(f.deletedAt),
    })
  }
  for (const d of docs) {
    rows.push({
      kind: 'doc',
      id: d.id,
      title: d.title || t('doc.untitled'),
      deletedAt: toDate(d.deletedAt),
    })
  }
  rows.sort((a, b) => {
    const ta = a.deletedAt ? a.deletedAt.getTime() : 0
    const tb = b.deletedAt ? b.deletedAt.getTime() : 0
    return tb - ta
  })
  return rows
})

function toDate(v: unknown): Date | null {
  if (v == null) return null
  if (v instanceof Date) return v
  const d = new Date(v as string | number)
  return Number.isNaN(d.getTime()) ? null : d
}

const busyId = ref<string | null>(null)
function key(kind: 'doc' | 'folder', id: number): string {
  return `${kind}:${id}`
}

async function onRestoreDoc(id: number) {
  busyId.value = key('doc', id)
  try {
    await $fetch(`/api/documents/${id}/restore`, { method: 'POST' })
    await refresh()
    // Refresh sidebar tree so the restored doc shows up.
    if (treeStore.workspaceId === workspaceId.value) {
      await treeStore.fetchWorkspaceTree(workspaceId.value, true)
    }
  }
  catch (err) {
    await dialog.alert({
      title: t('trash.restoreFailedTitle'),
      message: (err as Error).message || t('trash.restoreFailedDoc'),
    })
  }
  finally {
    busyId.value = null
  }
}

async function onRestoreFolder(id: number) {
  busyId.value = key('folder', id)
  try {
    await $fetch(`/api/folders/${id}/restore`, { method: 'POST' })
    await refresh()
    if (treeStore.workspaceId === workspaceId.value) {
      await treeStore.fetchWorkspaceTree(workspaceId.value, true)
    }
  }
  catch (err) {
    await dialog.alert({
      title: t('trash.restoreFailedTitle'),
      message: (err as Error).message || t('trash.restoreFailedFolder'),
    })
  }
  finally {
    busyId.value = null
  }
}

async function onForeverDoc(id: number, name: string) {
  const ok = await dialog.confirm({
    title: t('trash.foreverDocTitle', { name }),
    message: t('trash.foreverDocMsg'),
    confirmLabel: t('trash.deleteForever'),
    destructive: true,
  })
  if (!ok) return
  busyId.value = key('doc', id)
  try {
    await $fetch(`/api/documents/${id}/forever`, { method: 'DELETE' })
    await refresh()
  }
  catch (err) {
    await dialog.alert({
      title: t('trash.deleteFailedTitle'),
      message: (err as Error).message || t('trash.deleteFailedDoc'),
    })
  }
  finally {
    busyId.value = null
  }
}

async function onForeverFolder(id: number, name: string) {
  const ok = await dialog.confirm({
    title: t('trash.foreverDocTitle', { name }),
    message: t('trash.foreverFolderMsg'),
    confirmLabel: t('trash.deleteForever'),
    destructive: true,
  })
  if (!ok) return
  busyId.value = key('folder', id)
  try {
    await $fetch(`/api/folders/${id}/forever`, { method: 'DELETE' })
    await refresh()
  }
  catch (err) {
    await dialog.alert({
      title: t('trash.deleteFailedTitle'),
      message: (err as Error).message || t('trash.deleteFailedFolder'),
    })
  }
  finally {
    busyId.value = null
  }
}

async function onEmptyTrash() {
  const rows = items.value
  if (rows.length === 0) return
  const ok = await dialog.confirm({
    title: t('trash.emptyConfirmTitle'),
    message: rows.length === 1
      ? t('trash.emptyConfirmMsgOne', { n: rows.length })
      : t('trash.emptyConfirmMsg', { n: rows.length }),
    confirmLabel: t('trash.empty'),
    destructive: true,
  })
  if (!ok) return

  // Delete folders first (each subtree may take its docs with it). Then any
  // standalone docs still left in the trash.
  for (const r of rows) {
    if (r.kind !== 'folder') continue
    try { await $fetch(`/api/folders/${r.id}/forever`, { method: 'DELETE' }) }
    catch (err) { console.error('[trash] forever delete folder failed', err) }
  }
  await refresh()
  const remainingDocs = (data.value?.documents ?? []).map(d => d.id)
  for (const docId of remainingDocs) {
    try { await $fetch(`/api/documents/${docId}/forever`, { method: 'DELETE' }) }
    catch (err) { console.error('[trash] forever delete doc failed', err) }
  }
  await refresh()
}

function formatRelative(date: Date | null): string {
  if (!date) return ''
  const diff = (Date.now() - date.getTime()) / 1000
  if (diff < 60) return t('trash.time.justNow')
  if (diff < 3600) return t('history.rel.minutes', { n: Math.floor(diff / 60) })
  if (diff < 86400) return t('history.rel.hours', { n: Math.floor(diff / 3600) })
  if (diff < 86400 * 30) return t('history.rel.days', { n: Math.floor(diff / 86400) })
  return date.toLocaleDateString()
}
</script>

<template>
  <div class="trash-page">
    <header class="trash-header">
      <div class="crumbs">
        <NuxtLink :to="`/w/${workspaceId}`" class="crumb">{{ t('trash.crumbWorkspace') }}</NuxtLink>
        <span class="crumb-sep" aria-hidden="true">/</span>
        <span class="crumb crumb--current">{{ t('trash.crumbTrash') }}</span>
      </div>

      <button
        type="button"
        class="empty-btn"
        :disabled="items.length === 0"
        @click="onEmptyTrash"
      >
        {{ t('trash.empty') }}
      </button>
    </header>

    <section class="trash-body">
      <div v-if="pending && !data" class="state">
        <p class="state-text">{{ t('trash.loading') }}</p>
      </div>

      <div v-else-if="error" class="state">
        <p class="state-text">{{ t('trash.loadFailed') }}</p>
        <button class="ghost-btn" @click="refresh()">{{ t('trash.tryAgain') }}</button>
      </div>

      <div v-else-if="items.length === 0" class="state">
        <h2 class="state-title">{{ t('trash.noItems') }}</h2>
        <p class="state-text">{{ t('trash.noItemsLede') }}</p>
      </div>

      <ul v-else class="trash-list">
        <li
          v-for="row in items"
          :key="`${row.kind}-${row.id}`"
          class="row"
        >
          <span class="row-icon" :class="`row-icon--${row.kind}`" aria-hidden="true">
            <svg v-if="row.kind === 'folder'" viewBox="0 0 16 16" width="14" height="14">
              <path
                d="M2 4a1 1 0 0 1 1-1h3l2 2h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.25"
                stroke-linejoin="round"
              />
            </svg>
            <svg v-else viewBox="0 0 16 16" width="14" height="14">
              <path
                d="M4 2h5l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z M9 2v3h3"
                fill="none"
                stroke="currentColor"
                stroke-width="1.25"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          <span class="row-title">{{ row.title }}</span>
          <span class="row-meta">
            <span class="row-kind">{{ row.kind === 'folder' ? t('trash.kindFolder') : t('trash.kindDocument') }}</span>
            <span v-if="row.deletedAt" class="row-time">
              {{ t('trash.deletedPrefix') }} {{ formatRelative(row.deletedAt) }}
            </span>
          </span>
          <span class="row-actions">
            <button
              type="button"
              class="action-btn"
              :disabled="busyId === `${row.kind}:${row.id}`"
              @click="row.kind === 'folder' ? onRestoreFolder(row.id) : onRestoreDoc(row.id)"
            >
              {{ t('trash.restore') }}
            </button>
            <button
              type="button"
              class="action-btn action-btn--destructive"
              :disabled="busyId === `${row.kind}:${row.id}`"
              @click="row.kind === 'folder' ? onForeverFolder(row.id, row.title) : onForeverDoc(row.id, row.title)"
            >
              {{ t('trash.deleteForever') }}
            </button>
          </span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.trash-page {
  @apply flex-1 min-w-0 min-h-0 flex flex-col px-10 lg:px-14 pt-10;
  max-width: 100%;
}
.trash-header {
  @apply shrink-0 flex items-center justify-between mb-8 pb-4 border-b border-ink-200/60;
}
html.dark .trash-header {
  border-bottom-color: theme('colors.ink.800' / 60%);
}
.crumbs {
  @apply flex items-center gap-2 font-sans uppercase text-[11px] font-semibold tracking-[0.08em] text-ink-500 dark:text-ink-400;
}
.crumb { @apply text-ink-500 dark:text-ink-400; transition: color 120ms ease; }
.crumb:hover { color: theme('colors.ink.800'); }
html.dark .crumb:hover { color: theme('colors.ink.100'); }
.crumb--current {
  @apply font-semibold tracking-[0.14em] text-ink-800 dark:text-ink-100;
}
.crumb-sep { @apply text-ink-300 dark:text-ink-600; }

.empty-btn {
  @apply font-sans uppercase text-[11px] font-semibold tracking-[0.08em] text-ink-700 dark:text-ink-200 px-3 py-2 rounded;
  border: 1px solid theme('colors.ink.200');
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease, opacity 120ms ease;
}
html.dark .empty-btn { border-color: theme('colors.ink.800'); }
.empty-btn:hover:not(:disabled) {
  background: theme('colors.accent.50');
  color: theme('colors.accent.700');
  border-color: theme('colors.accent.300');
}
html.dark .empty-btn:hover:not(:disabled) {
  background: theme('colors.accent.900' / 30%);
  color: theme('colors.accent.200');
  border-color: theme('colors.accent.700');
}
.empty-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.trash-body {
  @apply flex-1 min-h-0 overflow-auto pb-12;
}

.state {
  @apply max-w-[480px] mx-auto pt-12;
}
.state-title {
  @apply font-serif text-[1.6rem] tracking-tight text-ink-900 dark:text-ink-100 mb-2;
}
.state-text {
  @apply text-[13px] text-ink-600 dark:text-ink-300 mb-4;
}

.ghost-btn {
  @apply font-sans uppercase text-[11px] font-semibold tracking-[0.08em] text-ink-700 dark:text-ink-200 px-3 py-2 rounded;
  border: 1px solid theme('colors.ink.200');
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
html.dark .ghost-btn { border-color: theme('colors.ink.800'); }
.ghost-btn:hover {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
  border-color: theme('colors.ink.300');
}
html.dark .ghost-btn:hover {
  background: theme('colors.ink.800');
  color: theme('colors.ink.50');
  border-color: theme('colors.ink.700');
}

.trash-list {
  @apply flex flex-col gap-2 max-w-3xl xl:max-w-4xl;
}
.row {
  @apply grid items-center gap-3 px-3 py-2.5 rounded;
  grid-template-columns: 16px minmax(0, 1fr) auto auto;
  background: theme('colors.ink.50' / 70%);
  border: 1px solid theme('colors.ink.200' / 60%);
  transition: background 120ms ease, border-color 120ms ease;
}
html.dark .row {
  background: theme('colors.ink.900' / 60%);
  border-color: theme('colors.ink.800' / 60%);
}
.row:hover {
  background: theme('colors.ink.100' / 60%);
  border-color: theme('colors.ink.200');
}
html.dark .row:hover {
  background: theme('colors.ink.800' / 50%);
  border-color: theme('colors.ink.700');
}
.row-icon {
  @apply inline-flex items-center justify-center text-ink-500 dark:text-ink-400;
}
.row-icon--folder { @apply text-accent-600 dark:text-accent-400; }
.row-title {
  @apply truncate text-[13.5px] text-ink-900 dark:text-ink-100;
}
.row-meta {
  @apply flex items-center gap-2 font-sans uppercase text-[10px] font-semibold tracking-[0.08em] text-ink-500 dark:text-ink-400 whitespace-nowrap;
}
.row-kind { @apply text-ink-400 dark:text-ink-500; }
.row-time { @apply text-ink-500 dark:text-ink-400; }
.row-actions { @apply flex items-center gap-1.5; }
.action-btn {
  @apply font-sans uppercase text-[10.5px] font-semibold tracking-[0.08em] text-ink-700 dark:text-ink-200 px-2.5 py-1.5 rounded;
  border: 1px solid theme('colors.ink.200');
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease, opacity 120ms ease;
}
html.dark .action-btn { border-color: theme('colors.ink.800'); }
.action-btn:hover:not(:disabled) {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
  border-color: theme('colors.ink.300');
}
html.dark .action-btn:hover:not(:disabled) {
  background: theme('colors.ink.800');
  color: theme('colors.ink.50');
  border-color: theme('colors.ink.700');
}
.action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.action-btn--destructive {
  color: theme('colors.accent.700');
}
html.dark .action-btn--destructive {
  color: theme('colors.accent.300');
}
.action-btn--destructive:hover:not(:disabled) {
  background: theme('colors.accent.50');
  color: theme('colors.accent.700');
  border-color: theme('colors.accent.300');
}
html.dark .action-btn--destructive:hover:not(:disabled) {
  background: theme('colors.accent.900' / 30%);
  color: theme('colors.accent.200');
  border-color: theme('colors.accent.700');
}
</style>
