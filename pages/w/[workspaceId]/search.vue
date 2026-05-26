<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useWorkspacesStore } from '~/stores/workspaces'
import { useTreeStore } from '~/stores/tree'
import { useSavedSearchesStore } from '~/stores/savedSearches'
import { useDialog } from '~/composables/useDialog'

interface SearchDocumentResult {
  id: number
  title: string
  snippet: string
  tags: string[]
  folderId: number | null
  updatedAt: string | number | Date
  createdAt: string | number | Date
}

interface SearchResponse {
  documents: SearchDocumentResult[]
  total: number
}

interface TagAggregate {
  name: string
  count: number
  docIds: number[]
}

const route = useRoute()
const router = useRouter()
const workspacesStore = useWorkspacesStore()
const treeStore = useTreeStore()
const savedSearchesStore = useSavedSearchesStore()
const dialog = useDialog()

const workspaceId = computed(() => Number(route.params.workspaceId))

// French strings — keep dictionary local; the user said "hardcoded French is fine".
const L = {
  title: 'Recherche',
  placeholder: 'Rechercher dans vos notes…',
  filtersTag: 'Tag',
  filtersFolder: 'Dossier',
  filtersDateFrom: 'Depuis',
  filtersDateTo: 'Jusqu\'à',
  sort: 'Tri',
  sortRelevance: 'Pertinence',
  sortRecent: 'Récents',
  sortOldest: 'Anciens',
  noQuery: 'Tapez votre recherche ci-dessus, ou filtrez par tag / dossier / date.',
  noResults: 'Aucun résultat.',
  loading: 'Recherche en cours…',
  saveSearch: 'Sauvegarder cette recherche',
  saveSearchTitle: 'Nom de la recherche',
  saveSearchPlaceholder: 'Ex. « réunions ouvertes »',
  saveSearchConfirm: 'Sauvegarder',
  resetFilters: 'Réinitialiser',
  resultsCount: (n: number) => n === 1 ? '1 résultat' : `${n} résultats`,
  page: (cur: number, total: number) => `${cur} / ${total}`,
  prev: 'Précédent',
  next: 'Suivant',
  anyFolder: 'Tous les dossiers',
  rootFolder: 'Racine',
  anyTag: 'Tous les tags',
}

useHead(() => ({ title: `${L.title} — NoteForge` }))

/* ---------- URL state ---------- */
const initialQuery = String(route.query.q ?? '')
const initialTag = String(route.query.tag ?? '')
const initialFolderId = (() => {
  const raw = route.query.folderId
  if (raw === undefined || raw === '' || raw === null) return null
  if (raw === 'root') return 'root' as const
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
})()
const initialDateFrom = String(route.query.dateFrom ?? '')
const initialDateTo = String(route.query.dateTo ?? '')
const initialSort = (() => {
  const raw = String(route.query.sort ?? '')
  if (raw === 'relevance' || raw === 'recent' || raw === 'oldest') return raw
  return 'recent' as const
})()

const queryText = ref(initialQuery)
const selectedTag = ref<string>(initialTag)
const selectedFolder = ref<number | 'root' | null>(initialFolderId)
const dateFrom = ref<string>(initialDateFrom)
const dateTo = ref<string>(initialDateTo)
const sort = ref<'relevance' | 'recent' | 'oldest'>(initialSort)
const offset = ref(0)
const PAGE_SIZE = 20

/* ---------- Debounce ---------- */
const debouncedQuery = ref(queryText.value)
let debounceTimer: ReturnType<typeof setTimeout> | null = null
watch(queryText, (v) => {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => { debouncedQuery.value = v; offset.value = 0 }, 300)
})

/* ---------- Available tags / folders ---------- */
const { data: tagsData } = useFetch<{ tags: TagAggregate[] }>(
  () => `/api/workspaces/${workspaceId.value}/tags`,
  { watch: [workspaceId] },
)
const availableTags = computed<TagAggregate[]>(() => tagsData.value?.tags ?? [])

// Folder map for breadcrumb resolution.
const folderById = computed<Map<number, { name: string, parentId: number | null }>>(() => {
  const m = new Map<number, { name: string, parentId: number | null }>()
  for (const f of treeStore.folders) m.set(f.id, { name: f.name, parentId: f.parentId })
  return m
})

function folderBreadcrumb(folderId: number | null): string {
  if (folderId == null) return L.rootFolder
  const parts: string[] = []
  let cur: number | null = folderId
  let safety = 0
  while (cur != null && safety < 64) {
    const f = folderById.value.get(cur)
    if (!f) break
    parts.unshift(f.name)
    cur = f.parentId
    safety++
  }
  return parts.length > 0 ? parts.join(' / ') : L.rootFolder
}

const flatFolders = computed(() => {
  // Flat list with depth for the dropdown.
  const out: { id: number, label: string, depth: number }[] = []
  const byParent = new Map<number | null, { id: number, name: string, parentId: number | null }[]>()
  for (const f of treeStore.folders) {
    const key = f.parentId ?? null
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key)!.push({ id: f.id, name: f.name, parentId: f.parentId })
  }
  for (const list of byParent.values()) list.sort((a, b) => a.name.localeCompare(b.name))
  function walk(parent: number | null, depth: number) {
    const here = byParent.get(parent) ?? []
    for (const f of here) {
      out.push({ id: f.id, label: f.name, depth })
      walk(f.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
})

/* ---------- Sync URL from filters ---------- */
function pushQuery() {
  const q: Record<string, string> = {}
  if (debouncedQuery.value) q.q = debouncedQuery.value
  if (selectedTag.value) q.tag = selectedTag.value
  if (selectedFolder.value === 'root') q.folderId = 'root'
  else if (typeof selectedFolder.value === 'number') q.folderId = String(selectedFolder.value)
  if (dateFrom.value) q.dateFrom = dateFrom.value
  if (dateTo.value) q.dateTo = dateTo.value
  if (sort.value !== 'recent') q.sort = sort.value
  router.replace({ query: q })
}

watch([debouncedQuery, selectedTag, selectedFolder, dateFrom, dateTo, sort], () => {
  pushQuery()
  offset.value = 0
})

/* ---------- Fetch ---------- */
const searchUrl = computed(() => {
  const base = `/api/workspaces/${workspaceId.value}/search`
  const params = new URLSearchParams()
  if (debouncedQuery.value) params.set('q', debouncedQuery.value)
  if (selectedTag.value) params.set('tag', selectedTag.value)
  if (selectedFolder.value === 'root') params.set('folderId', 'root')
  else if (typeof selectedFolder.value === 'number') params.set('folderId', String(selectedFolder.value))
  if (dateFrom.value) params.set('dateFrom', dateFrom.value)
  if (dateTo.value) params.set('dateTo', dateTo.value)
  params.set('sort', sort.value)
  params.set('limit', String(PAGE_SIZE))
  params.set('offset', String(offset.value))
  return `${base}?${params.toString()}`
})

const { data, pending, refresh } = await useFetch<SearchResponse>(searchUrl, {
  watch: [searchUrl],
})

const docs = computed<SearchDocumentResult[]>(() => data.value?.documents ?? [])
const total = computed(() => data.value?.total ?? 0)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const currentPage = computed(() => Math.floor(offset.value / PAGE_SIZE) + 1)

function goPrev() {
  if (offset.value > 0) offset.value = Math.max(0, offset.value - PAGE_SIZE)
}
function goNext() {
  if (offset.value + PAGE_SIZE < total.value) offset.value += PAGE_SIZE
}

function resetFilters() {
  queryText.value = ''
  debouncedQuery.value = ''
  selectedTag.value = ''
  selectedFolder.value = null
  dateFrom.value = ''
  dateTo.value = ''
  sort.value = 'recent'
  offset.value = 0
}

async function onSaveSearch() {
  const name = await dialog.prompt({
    title: L.saveSearchTitle,
    placeholder: L.saveSearchPlaceholder,
    defaultValue: debouncedQuery.value || '',
    confirmLabel: L.saveSearchConfirm,
  })
  if (!name) return
  try {
    await savedSearchesStore.create({
      workspaceId: workspaceId.value,
      name,
      query: {
        q: debouncedQuery.value || undefined,
        tags: selectedTag.value ? [selectedTag.value] : undefined,
        folderId: typeof selectedFolder.value === 'number' ? selectedFolder.value : null,
        dateFrom: dateFrom.value || null,
        dateTo: dateTo.value || null,
        sort: sort.value,
      },
    })
  }
  catch (err) {
    await dialog.alert({
      title: 'Échec',
      message: (err as Error).message || 'La recherche n\'a pas pu être sauvegardée.',
    })
  }
}

/* ---------- Render markdown-style highlight ---------- */
function renderSnippet(s: string): string {
  // Escape HTML, then convert **…** to <mark>…</mark>.
  const escaped = s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped.replace(/\*\*([^*]+)\*\*/g, '<mark>$1</mark>')
}

function fmtDate(value: string | number | Date): string {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const now = Date.now()
  const diff = now - d.getTime()
  const day = 24 * 60 * 60 * 1000
  if (diff < day) return 'aujourd\'hui'
  if (diff < 2 * day) return 'hier'
  if (diff < 7 * day) return `il y a ${Math.floor(diff / day)} j`
  return d.toLocaleDateString('fr-FR', { year: 'numeric', month: 'short', day: 'numeric' })
}

// React to query-param changes triggered by saved-search activation in the sidebar.
watch(() => route.query, (q) => {
  const incomingQ = String(q.q ?? '')
  const incomingTag = String(q.tag ?? '')
  const incomingFolderRaw = q.folderId
  const incomingFolder: number | 'root' | null = (() => {
    if (incomingFolderRaw === undefined || incomingFolderRaw === '' || incomingFolderRaw === null) return null
    if (incomingFolderRaw === 'root') return 'root'
    const n = Number(incomingFolderRaw)
    return Number.isInteger(n) && n > 0 ? n : null
  })()
  const incomingFrom = String(q.dateFrom ?? '')
  const incomingTo = String(q.dateTo ?? '')
  const incomingSort = String(q.sort ?? '')
  const nextSort = incomingSort === 'relevance' || incomingSort === 'oldest' ? incomingSort : 'recent'

  if (incomingQ !== queryText.value) queryText.value = incomingQ
  if (incomingQ !== debouncedQuery.value) debouncedQuery.value = incomingQ
  if (incomingTag !== selectedTag.value) selectedTag.value = incomingTag
  if (incomingFolder !== selectedFolder.value) selectedFolder.value = incomingFolder
  if (incomingFrom !== dateFrom.value) dateFrom.value = incomingFrom
  if (incomingTo !== dateTo.value) dateTo.value = incomingTo
  if (nextSort !== sort.value) sort.value = nextSort
})

const wsName = computed(() => workspacesStore.current?.name ?? 'Workspace')
</script>

<template>
  <div class="search-page">
    <header class="search-header">
      <div class="crumbs">
        <NuxtLink :to="`/w/${workspaceId}`" class="crumb">{{ wsName }}</NuxtLink>
        <span class="crumb-sep" aria-hidden="true">/</span>
        <span class="crumb crumb--current">{{ L.title }}</span>
      </div>
      <div class="header-actions">
        <button type="button" class="ghost-btn" @click="resetFilters">{{ L.resetFilters }}</button>
        <button type="button" class="primary-btn" @click="onSaveSearch">{{ L.saveSearch }}</button>
      </div>
    </header>

    <div class="search-bar">
      <div class="search-input-wrap">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" class="search-icon">
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4" />
          <path d="M10.5 10.5L13.5 13.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
        <input
          v-model="queryText"
          type="text"
          class="search-input"
          :placeholder="L.placeholder"
          autofocus
        >
      </div>
    </div>

    <div class="filters">
      <label class="filter">
        <span class="filter-label">{{ L.filtersTag }}</span>
        <select v-model="selectedTag" class="select">
          <option value="">{{ L.anyTag }}</option>
          <option v-for="tag in availableTags" :key="tag.name" :value="tag.name">
            {{ tag.name }} ({{ tag.count }})
          </option>
        </select>
      </label>

      <label class="filter">
        <span class="filter-label">{{ L.filtersFolder }}</span>
        <select v-model="selectedFolder" class="select">
          <option :value="null">{{ L.anyFolder }}</option>
          <option value="root">{{ L.rootFolder }}</option>
          <option v-for="f in flatFolders" :key="f.id" :value="f.id">
            {{ '— '.repeat(f.depth) }}{{ f.label }}
          </option>
        </select>
      </label>

      <label class="filter">
        <span class="filter-label">{{ L.filtersDateFrom }}</span>
        <input v-model="dateFrom" type="date" class="select">
      </label>

      <label class="filter">
        <span class="filter-label">{{ L.filtersDateTo }}</span>
        <input v-model="dateTo" type="date" class="select">
      </label>

      <label class="filter">
        <span class="filter-label">{{ L.sort }}</span>
        <select v-model="sort" class="select">
          <option value="recent">{{ L.sortRecent }}</option>
          <option value="oldest">{{ L.sortOldest }}</option>
          <option value="relevance" :disabled="!debouncedQuery">{{ L.sortRelevance }}</option>
        </select>
      </label>
    </div>

    <div class="results">
      <p class="results-meta">
        {{ L.resultsCount(total) }}<span v-if="pending"> · …</span>
      </p>

      <div v-if="pending && docs.length === 0" class="state">
        <p>{{ L.loading }}</p>
      </div>
      <div v-else-if="docs.length === 0" class="state">
        <p>{{ debouncedQuery || selectedTag || selectedFolder ? L.noResults : L.noQuery }}</p>
      </div>

      <ul v-else class="hits">
        <li v-for="d in docs" :key="d.id" class="hit">
          <NuxtLink
            :to="{ path: `/w/${workspaceId}/d/${d.id}`, query: debouncedQuery ? { highlight: debouncedQuery } : {} }"
            class="hit-link"
          >
            <div class="hit-title">{{ d.title || 'Untitled' }}</div>
            <div class="hit-snippet" v-html="renderSnippet(d.snippet)" />
            <div class="hit-meta">
              <span class="hit-folder">{{ folderBreadcrumb(d.folderId) }}</span>
              <span class="hit-dot">·</span>
              <span class="hit-date">{{ fmtDate(d.updatedAt) }}</span>
              <template v-if="d.tags.length > 0">
                <span class="hit-dot">·</span>
                <span class="hit-tags">
                  <span v-for="t in d.tags.slice(0, 4)" :key="t" class="hit-tag">#{{ t }}</span>
                  <span v-if="d.tags.length > 4" class="hit-tag-more">+{{ d.tags.length - 4 }}</span>
                </span>
              </template>
            </div>
          </NuxtLink>
        </li>
      </ul>

      <div v-if="total > PAGE_SIZE" class="pager">
        <button type="button" class="ghost-btn" :disabled="offset === 0" @click="goPrev">{{ L.prev }}</button>
        <span class="pager-info">{{ L.page(currentPage, pageCount) }}</span>
        <button type="button" class="ghost-btn" :disabled="offset + PAGE_SIZE >= total" @click="goNext">{{ L.next }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-page {
  @apply flex-1 min-w-0 min-h-0 flex flex-col px-10 lg:px-14 pt-10 pb-10;
  max-width: 100%;
}
.search-header {
  @apply shrink-0 flex items-center justify-between mb-4 pb-3 border-b border-ink-200/60;
}
html.dark .search-header {
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

.header-actions { @apply flex items-center gap-2; }

.search-bar {
  @apply mb-4 max-w-3xl xl:max-w-4xl;
}
.search-input-wrap {
  @apply relative;
}
.search-icon {
  @apply absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 dark:text-ink-500;
}
.search-input {
  @apply w-full pl-9 pr-3 h-11 rounded text-[14px] bg-transparent text-ink-900 dark:text-ink-100;
  border: 1px solid theme('colors.ink.200');
  transition: border-color 120ms ease, background 120ms ease;
}
html.dark .search-input { border-color: theme('colors.ink.800'); }
.search-input:focus {
  outline: none;
  border-color: theme('colors.accent.400');
  background: theme('colors.ink.50' / 50%);
}
html.dark .search-input:focus {
  background: theme('colors.ink.900' / 50%);
  border-color: theme('colors.accent.500');
}

.filters {
  @apply flex flex-wrap gap-3 mb-6 max-w-3xl xl:max-w-4xl;
}
.filter {
  @apply flex flex-col gap-1;
}
.filter-label {
  @apply label-mono;
}
.select {
  @apply h-9 px-2 rounded text-[13px] bg-transparent text-ink-800 dark:text-ink-200;
  border: 1px solid theme('colors.ink.200');
  min-width: 140px;
}
html.dark .select { border-color: theme('colors.ink.800'); }

.results {
  @apply flex-1 min-h-0;
}
.results-meta {
  @apply label-mono mb-3;
}

.hits { @apply flex flex-col gap-3 max-w-3xl xl:max-w-4xl; }
.hit {
  @apply rounded;
  border: 1px solid theme('colors.ink.200' / 60%);
  transition: border-color 120ms ease, background 120ms ease;
}
html.dark .hit { border-color: theme('colors.ink.800' / 60%); }
.hit:hover {
  border-color: theme('colors.accent.300');
  background: theme('colors.ink.50' / 60%);
}
html.dark .hit:hover {
  border-color: theme('colors.accent.600');
  background: theme('colors.ink.900' / 60%);
}
.hit-link {
  @apply block px-4 py-3;
}
.hit-title {
  @apply font-serif text-[15px] text-ink-900 dark:text-ink-100 mb-1;
}
.hit-snippet {
  @apply text-[13px] text-ink-600 dark:text-ink-300 mb-2 leading-snug;
}
.hit-snippet :deep(mark) {
  background: theme('colors.accent.100');
  color: theme('colors.accent.900');
  padding: 0 2px;
  border-radius: 2px;
}
html.dark .hit-snippet :deep(mark) {
  background: theme('colors.accent.900' / 50%);
  color: theme('colors.accent.200');
}
.hit-meta {
  @apply flex flex-wrap items-center gap-1 font-sans text-[11px] text-ink-500 dark:text-ink-400;
}
.hit-folder { @apply uppercase tracking-[0.08em]; }
.hit-date { @apply tabular-nums; }
.hit-dot { @apply opacity-50; }
.hit-tags { @apply flex flex-wrap gap-1; }
.hit-tag {
  @apply inline-block px-1.5 py-0.5 rounded text-[10.5px] text-ink-600 dark:text-ink-300;
  background: theme('colors.ink.100' / 60%);
}
html.dark .hit-tag { background: theme('colors.ink.800' / 60%); }
.hit-tag-more {
  @apply inline-block px-1 text-[10.5px] text-ink-400 dark:text-ink-500;
}

.pager {
  @apply flex items-center justify-center gap-3 mt-6 max-w-3xl xl:max-w-4xl;
}
.pager-info {
  @apply font-sans text-[12px] text-ink-500 dark:text-ink-400 tabular-nums;
}

.state {
  @apply px-3 py-8 text-[13px] text-ink-500 dark:text-ink-400;
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
.ghost-btn:disabled { opacity: 0.45; cursor: not-allowed; }

.primary-btn {
  @apply font-sans uppercase text-[11px] font-semibold tracking-[0.08em] text-white px-3 py-2 rounded;
  background: theme('colors.accent.500');
  border: 1px solid theme('colors.accent.500');
  transition: background 120ms ease, border-color 120ms ease;
}
.primary-btn:hover {
  background: theme('colors.accent.600');
  border-color: theme('colors.accent.600');
}
</style>
