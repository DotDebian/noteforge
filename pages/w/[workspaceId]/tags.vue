<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Document } from '~/server/database/schema'
import { useTreeStore } from '~/stores/tree'
import { useWorkspacesStore } from '~/stores/workspaces'
import { useLocale } from '~/composables/useLocale'

interface TagAggregate {
  name: string
  count: number
  docIds: number[]
}
interface TagsResponse { tags: TagAggregate[] }

const { t } = useLocale()
useHead(() => ({ title: `${t('tags.title')} — NoteForge` }))

const route = useRoute()
const treeStore = useTreeStore()
const workspacesStore = useWorkspacesStore()

const workspaceId = computed(() => Number(route.params.workspaceId))

const { data, pending, error, refresh } = await useFetch<TagsResponse>(
  () => `/api/workspaces/${workspaceId.value}/tags`,
  { watch: [workspaceId] },
)

// Tree store carries lightweight document rows for the current workspace.
// We use it for title lookup when displaying the filtered doc list — the tags
// endpoint only returns ids.
type LightDoc = Pick<Document, 'id' | 'title' | 'folderId'>
const fallbackDocs = ref<LightDoc[]>([])

watch(workspaceId, async (id) => {
  if (!Number.isFinite(id) || id <= 0) return
  if (treeStore.workspaceId !== id || !treeStore.loaded) {
    await treeStore.fetchWorkspaceTree(id).catch(() => { /* ignore */ })
  }
  if (treeStore.documents.length === 0) {
    try {
      const res = await $fetch<{ documents: LightDoc[] }>('/api/documents', {
        query: { workspaceId: id },
      })
      fallbackDocs.value = res.documents
    }
    catch {
      fallbackDocs.value = []
    }
  }
}, { immediate: true })

const titleByDoc = computed<Map<number, string>>(() => {
  const map = new Map<number, string>()
  for (const d of treeStore.documents) map.set(d.id, d.title)
  for (const d of fallbackDocs.value) if (!map.has(d.id)) map.set(d.id, d.title)
  return map
})

const tags = computed<TagAggregate[]>(() => data.value?.tags ?? [])

const selectedTag = ref<string | null>(null)

// When the data refreshes, drop any stale selection that no longer exists.
watch(tags, (next) => {
  if (selectedTag.value == null) return
  if (!next.some(t => t.name === selectedTag.value)) selectedTag.value = null
})

const activeTag = computed<TagAggregate | null>(() => {
  const name = selectedTag.value
  if (!name) return null
  return tags.value.find(t => t.name === name) ?? null
})

const activeDocs = computed(() => {
  const tag = activeTag.value
  if (!tag) return [] as { id: number, title: string }[]
  return tag.docIds.map(id => ({
    id,
    title: titleByDoc.value.get(id) || t('doc.untitled'),
  }))
})

const wsName = computed(() => workspacesStore.current?.name ?? t('workspace.title'))

function clearSelection() {
  selectedTag.value = null
}
</script>

<template>
  <div class="tags-page">
    <header class="tags-header">
      <div class="crumbs">
        <NuxtLink :to="`/w/${workspaceId}`" class="crumb">{{ wsName }}</NuxtLink>
        <span class="crumb-sep" aria-hidden="true">/</span>
        <span class="crumb crumb--current">{{ t('tags.title') }}</span>
      </div>
      <button v-if="selectedTag" type="button" class="ghost-btn" @click="clearSelection">
        {{ t('tags.clearFilter') }}
      </button>
    </header>

    <section class="tags-body">
      <div v-if="pending && !data" class="state">
        <p class="state-text">{{ t('tags.loading') }}</p>
      </div>

      <div v-else-if="error" class="state">
        <p class="state-text">{{ t('tags.loadFailed') }}</p>
        <button class="ghost-btn" @click="refresh()">{{ t('tags.tryAgain') }}</button>
      </div>

      <div v-else-if="tags.length === 0" class="state">
        <h2 class="state-title">{{ t('tags.emptyTitle') }}</h2>
        <p class="state-text">{{ t('tags.emptyLede') }}</p>
      </div>

      <template v-else>
        <p class="eyebrow">{{ t('tags.headerEyebrow') }}</p>
        <h1 class="title">{{ t('tags.headerTitle', { n: tags.length }) }}</h1>

        <ul class="tag-list">
          <li v-for="tag in tags" :key="tag.name">
            <button
              type="button"
              class="tag-chip"
              :class="{ 'tag-chip--active': selectedTag === tag.name }"
              :title="t('tags.chipTitle', { name: tag.name, n: tag.count })"
              @click="selectedTag = selectedTag === tag.name ? null : tag.name"
            >
              <span class="tag-name">{{ tag.name }}</span>
              <span class="tag-count">{{ tag.count }}</span>
            </button>
          </li>
        </ul>

        <section v-if="activeTag" class="filtered">
          <h2 class="filtered-title">
            {{ t('tags.filteredTitle', { name: activeTag.name, n: activeTag.count }) }}
          </h2>
          <ul v-if="activeDocs.length" class="doc-list">
            <li v-for="doc in activeDocs" :key="doc.id">
              <NuxtLink
                :to="`/w/${workspaceId}/d/${doc.id}`"
                class="doc-row"
              >
                <span class="doc-leaf" aria-hidden="true" />
                <span class="doc-title">{{ doc.title || t('doc.untitled') }}</span>
              </NuxtLink>
            </li>
          </ul>
          <p v-else class="state-text">{{ t('tags.noDocsForTag') }}</p>
        </section>
      </template>
    </section>
  </div>
</template>

<style scoped>
.tags-page {
  @apply flex-1 min-w-0 min-h-0 flex flex-col px-10 lg:px-14 pt-10;
  max-width: 100%;
}
.tags-header {
  @apply shrink-0 flex items-center justify-between mb-8 pb-4 border-b border-ink-200/60;
}
html.dark .tags-header {
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

.tags-body {
  @apply flex-1 min-h-0 overflow-auto pb-12;
}

.eyebrow {
  @apply label-mono mb-3;
}
.title {
  @apply font-serif text-[1.8rem] leading-[1.1] tracking-tight text-ink-900 dark:text-ink-100 mb-6;
}

.tag-list {
  @apply flex flex-wrap gap-2 max-w-3xl xl:max-w-4xl;
}
.tag-chip {
  @apply inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[12px] text-ink-700 dark:text-ink-200;
  background: theme('colors.ink.50');
  border: 1px solid theme('colors.ink.200');
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
html.dark .tag-chip {
  background: theme('colors.ink.900');
  border-color: theme('colors.ink.800');
}
.tag-chip:hover {
  background: theme('colors.accent.50');
  color: theme('colors.accent.700');
  border-color: theme('colors.accent.300');
}
html.dark .tag-chip:hover {
  background: theme('colors.accent.900' / 30%);
  color: theme('colors.accent.200');
  border-color: theme('colors.accent.700');
}
.tag-chip--active {
  background: theme('colors.accent.500');
  color: white;
  border-color: theme('colors.accent.500');
}
html.dark .tag-chip--active {
  background: theme('colors.accent.600');
  color: theme('colors.ink.50');
  border-color: theme('colors.accent.600');
}
.tag-chip--active:hover {
  background: theme('colors.accent.600');
  color: white;
  border-color: theme('colors.accent.600');
}
html.dark .tag-chip--active:hover {
  background: theme('colors.accent.700');
  color: theme('colors.ink.50');
}
.tag-name { @apply font-medium; }
.tag-count {
  @apply font-sans text-[11px] tabular-nums;
  opacity: 0.75;
}

.filtered {
  @apply mt-10 max-w-3xl xl:max-w-4xl;
}
.filtered-title {
  @apply font-serif text-[1.15rem] tracking-tight text-ink-900 dark:text-ink-100 mb-3;
}

.doc-list {
  @apply flex flex-col gap-1;
}
.doc-row {
  @apply flex items-center gap-2 px-2 py-1.5 rounded text-[13.5px] text-ink-800 dark:text-ink-200;
  transition: background 120ms ease, color 120ms ease;
}
.doc-row:hover {
  background: theme('colors.ink.100' / 70%);
  color: theme('colors.ink.900');
}
html.dark .doc-row:hover {
  background: theme('colors.ink.800' / 60%);
  color: theme('colors.ink.50');
}
.doc-leaf {
  @apply inline-block w-1.5 h-1.5 rounded-full bg-ink-300 dark:bg-ink-600 shrink-0;
}
.doc-title { @apply truncate; }

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
</style>
