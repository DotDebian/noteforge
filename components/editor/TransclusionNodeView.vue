<script setup lang="ts">
/**
 * Transclusion NodeView — embeds another document inline as read-only HTML.
 *
 * Slug resolution:
 *   - If the slug is a positive integer, use it directly as the doc id.
 *   - Otherwise look up by case-insensitive exact title in the tree store.
 *
 * Resolved docs are cached in a module-level `Map<string, ...>` so multiple
 * transclusions of the same target on the same page only fetch once.
 * The cache is invalidated when the tree store reports a `lastModified`
 * change on the target doc — see the `watch` below.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { useTreeStore } from '~/stores/tree'
import { useLocale } from '~/composables/useLocale'
import { markdownToHtml } from '~/composables/useEditorMarkdown'

const props = defineProps(nodeViewProps)
const treeStore = useTreeStore()
const { locale } = useLocale()

const L = computed(() => locale.value === 'fr'
  ? {
      open: 'ouvrir',
      missing: 'Document introuvable :',
      loading: 'Chargement…',
      embed: 'Transclusion',
    }
  : {
      open: 'open',
      missing: 'Document not found:',
      loading: 'Loading…',
      embed: 'Transclusion',
    })

interface ResolvedDoc {
  id: number
  title: string
  markdown: string
  updatedAt?: number
}

// Module-level cache so multiple `![[X]]` on the same page share one fetch.
// Key is the resolved document id. We also separately memoize slug→id so
// title lookups don't have to scan the tree on every render.
const docCache = new Map<number, ResolvedDoc>()

const slug = computed<string>(() =>
  String((props.node.attrs as { slug?: string }).slug ?? '').trim())

const resolvedId = computed<number | null>(() => {
  const s = slug.value
  if (!s) return null
  // Integer path first.
  if (/^\d+$/.test(s)) {
    const n = Number.parseInt(s, 10)
    if (Number.isFinite(n) && n > 0) return n
    return null
  }
  const lower = s.toLowerCase()
  const docs = treeStore.documents
  // Case-insensitive exact title match.
  let hit = docs.find(d => (d.title ?? '').toLowerCase() === lower)
  if (hit) return hit.id
  // Path-style slug: `Folder/Sub/Doc Title` — match against the final
  // segment so the user can paste Obsidian-style paths without a rename.
  if (s.includes('/')) {
    const parts = s.split('/').map(p => p.trim()).filter(Boolean)
    const last = (parts[parts.length - 1] ?? '').toLowerCase()
    if (last) {
      hit = docs.find(d => (d.title ?? '').toLowerCase() === last)
      if (hit) return hit.id
    }
  }
  // Last-resort: case-insensitive substring match on title. We pick the
  // shortest title that contains the slug to avoid wild over-matches.
  const matches = docs.filter(d => (d.title ?? '').toLowerCase().includes(lower))
  if (matches.length === 1) return matches[0]!.id
  if (matches.length > 1) {
    matches.sort((a, b) => (a.title ?? '').length - (b.title ?? '').length)
    return matches[0]!.id
  }
  return null
})

const loading = ref(false)
const resolved = ref<ResolvedDoc | null>(null)

async function fetchDoc(id: number): Promise<ResolvedDoc | null> {
  const cached = docCache.get(id)
  if (cached) return cached
  try {
    const res = await $fetch<{ document: { id: number, title: string, markdown: string, updatedAt?: string | number } }>(
      `/api/documents/${id}`,
    )
    const updatedAtRaw = res.document.updatedAt
    const updatedAt = typeof updatedAtRaw === 'number'
      ? updatedAtRaw
      : updatedAtRaw
        ? new Date(updatedAtRaw).getTime()
        : undefined
    const doc: ResolvedDoc = {
      id: res.document.id,
      title: res.document.title,
      markdown: res.document.markdown ?? '',
      updatedAt,
    }
    docCache.set(id, doc)
    return doc
  }
  catch (err) {
    console.warn('[transclusion] could not fetch doc', id, err)
    return null
  }
}

async function load(): Promise<void> {
  const id = resolvedId.value
  if (id == null) {
    resolved.value = null
    return
  }
  loading.value = true
  try {
    resolved.value = await fetchDoc(id)
  }
  finally {
    loading.value = false
  }
}

const renderedHtml = computed<string>(() => {
  const r = resolved.value
  if (!r) return ''
  // Strip self-references so a circular `![[A]]` inside A doesn't loop
  // forever — replace nested `![[…]]` in the embedded markdown with a
  // visual placeholder.
  const safeMd = r.markdown.replace(/!\[\[[^\]]+\]\]/g, '↪︎')
  return markdownToHtml(safeMd)
})

// When the tree store reports a new title (e.g. user renamed the target),
// or the doc was edited, refresh the cache. We watch the doc's
// "updatedAt" field via the store's local doc list.
watch(
  () => {
    const id = resolvedId.value
    if (id == null) return null
    const found = treeStore.documents.find(d => d.id === id)
    if (!found) return null
    // Touch both `updatedAt` and `title` so renames also bust the cache.
    return `${found.id}:${String(found.updatedAt ?? '')}:${found.title}`
  },
  (key) => {
    const id = resolvedId.value
    if (id != null) docCache.delete(id)
    void load()
    void key
  },
)

// Re-resolve when the slug attribute changes (user retyped the embed).
watch(resolvedId, () => {
  void load()
})

onMounted(() => {
  void load()
})

function openTarget(): void {
  const id = resolvedId.value
  if (id == null) return
  if (typeof window === 'undefined') return
  // Pull workspace id from the URL — the editor is always rendered on
  // /w/:wsId/d/:docId. We could thread it through props from the editor
  // host, but the URL is canonical and saves a Tiptap option plumbing pass.
  const m = window.location.pathname.match(/^\/w\/(\d+)\//)
  const wsIdNum = m ? m[1] : ''
  if (wsIdNum) {
    window.location.href = `/w/${wsIdNum}/d/${id}`
  }
}
</script>

<template>
  <NodeViewWrapper
    as="div"
    class="transclusion-nv"
    :class="{ 'is-selected': props.selected }"
    data-drag-handle
  >
    <div
      v-if="resolvedId === null"
      class="transclusion-missing"
      contenteditable="false"
    >
      <span class="transclusion-missing-icon">⚠</span>
      <span class="transclusion-missing-text">{{ L.missing }} <code>{{ slug }}</code></span>
    </div>
    <div
      v-else
      class="transclusion-card"
      contenteditable="false"
    >
      <header class="transclusion-header">
        <button
          type="button"
          class="transclusion-title-btn"
          :title="L.open"
          @click="openTarget"
        >
          <span class="transclusion-arrow" aria-hidden="true">↪</span>
          <span class="transclusion-title">{{ resolved?.title ?? slug }}</span>
        </button>
        <button
          type="button"
          class="transclusion-open"
          @click="openTarget"
        >
          {{ L.open }}
        </button>
      </header>
      <div v-if="loading" class="transclusion-loading">
        {{ L.loading }}
      </div>
      <div
        v-else-if="resolved"
        class="transclusion-body prose-document"
        v-html="renderedHtml"
      />
    </div>
  </NodeViewWrapper>
</template>

<style scoped>
.transclusion-nv {
  @apply my-5;
}
.transclusion-missing {
  @apply flex items-center gap-2 rounded-md border border-red-200 bg-red-50/70 px-3 py-2 text-sm text-red-700;
}
html.dark .transclusion-missing {
  background: theme('colors.red.900' / 20%);
  border-color: theme('colors.red.800');
  color: theme('colors.red.300');
}
.transclusion-missing-icon { @apply font-bold; }
.transclusion-missing-text code {
  @apply rounded bg-red-100 px-1 py-0.5 font-mono text-xs;
}
html.dark .transclusion-missing-text code {
  background: theme('colors.red.900' / 40%);
}

.transclusion-card {
  @apply rounded-lg border border-ink-200 bg-ink-50/40 px-4 py-3;
  border-left: 3px solid theme('colors.accent.500');
}
html.dark .transclusion-card {
  background: theme('colors.ink.900' / 60%);
  border-color: theme('colors.ink.800');
  border-left-color: theme('colors.accent.400');
}
.transclusion-nv.is-selected .transclusion-card {
  @apply outline outline-2 outline-accent-500;
}
.transclusion-header {
  @apply mb-2 flex items-center gap-2;
}
.transclusion-title-btn {
  @apply flex flex-1 items-center gap-2 truncate text-left bg-transparent border-0 p-0 cursor-pointer;
}
.transclusion-arrow {
  @apply text-accent-500;
}
.transclusion-title {
  @apply truncate font-serif text-base font-semibold text-ink-900;
}
html.dark .transclusion-title { color: theme('colors.ink.50'); }
.transclusion-title-btn:hover .transclusion-title {
  @apply underline decoration-dotted underline-offset-2;
}
.transclusion-open {
  @apply ml-auto rounded px-2 py-0.5 text-[11px] uppercase tracking-wider text-ink-500 hover:bg-ink-100 hover:text-ink-700;
}
html.dark .transclusion-open:hover {
  background: theme('colors.ink.800');
  color: theme('colors.ink.100');
}
.transclusion-loading {
  @apply text-sm text-ink-400 italic;
}
.transclusion-body {
  @apply text-sm leading-relaxed text-ink-700;
}
html.dark .transclusion-body { color: theme('colors.ink.200'); }
.transclusion-body :deep(p) { @apply my-2; }
.transclusion-body :deep(h1),
.transclusion-body :deep(h2),
.transclusion-body :deep(h3) {
  @apply mt-3 font-serif font-semibold;
}
.transclusion-body :deep(h1) { @apply text-lg; }
.transclusion-body :deep(h2) { @apply text-base; }
.transclusion-body :deep(h3) { @apply text-sm; }
.transclusion-body :deep(ul),
.transclusion-body :deep(ol) {
  @apply my-1.5 pl-5;
}
.transclusion-body :deep(ul) { @apply list-disc; }
.transclusion-body :deep(ol) { @apply list-decimal; }
.transclusion-body :deep(code) {
  @apply rounded bg-ink-100 px-1 py-0.5 font-mono text-xs text-ink-800;
}
html.dark .transclusion-body :deep(code) {
  background: theme('colors.ink.800');
  color: theme('colors.ink.100');
}
.transclusion-body :deep(pre) {
  @apply my-2 overflow-x-auto rounded bg-ink-900 p-2 font-mono text-xs text-ink-50;
}
.transclusion-body :deep(a) {
  @apply text-accent-600 underline decoration-accent-300 underline-offset-2;
}
</style>
