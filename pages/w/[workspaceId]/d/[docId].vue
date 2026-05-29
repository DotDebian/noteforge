<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useLocalizedTimeAgo } from '~/composables/useLocale'
import { useResizable } from '~/composables/useResizable'
import type { Editor } from '@tiptap/vue-3'
import type { Document, DocAnalysis } from '~/server/database/schema'
import { useTreeStore } from '~/stores/tree'
import { usePaletteStore } from '~/stores/palette'
import { useFavoritesStore } from '~/stores/favorites'
import { useChatStore } from '~/stores/chat'
import { useDialog } from '~/composables/useDialog'
import { useLocale } from '~/composables/useLocale'

const route = useRoute()
const treeStore = useTreeStore()
const palette = usePaletteStore()
const favoritesStore = useFavoritesStore()
const chat = useChatStore()
const dialog = useDialog()
const { t } = useLocale()

const docId = computed(() => Number(route.params.docId))
const workspaceId = computed(() => Number(route.params.workspaceId))

// Track recently opened docs for the command palette's "Recent" section.
watch(
  docId,
  (id) => {
    if (Number.isFinite(id) && id > 0) palette.pushRecent(id)
  },
  { immediate: true },
)

interface DocResponse { document: Document, analysis: DocAnalysis | null }

const { data, pending, error, refresh } = await useFetch<DocResponse>(
  () => `/api/documents/${docId.value}`,
  { watch: [docId] },
)
const doc = computed(() => data.value?.document ?? null)

// Locally tracked title so changes from the editor (via @update:title) show
// in the crumbs / sidebar / tab title without waiting for a refetch.
const liveTitle = ref<string>('')
watch(
  () => doc.value?.title,
  (t) => { if (t != null) liveTitle.value = t },
  { immediate: true },
)

// Live markdown surfaced by the editor's `@update:markdown` — used by the
// insights panel's stale-indicator (Sprint 3 / I7). Seeded from the fetched
// doc so the first stale check has something to compare against.
const liveMarkdown = ref<string>('')
watch(
  () => doc.value?.markdown,
  (m) => { if (m != null) liveMarkdown.value = m },
  { immediate: true },
)
function onMarkdownChange(next: string) {
  liveMarkdown.value = next
}

function onTitleChange(next: string) {
  liveTitle.value = next
  if (doc.value) {
    treeStore.patchDocumentLocal(doc.value.id, { title: next })
    favoritesStore.patchTitle(doc.value.id, next)
    // Keep useFetch's cached payload in sync so a route revisit still shows
    // the new title even if the doc hasn't been refetched yet.
    if (data.value) data.value.document.title = next
  }
}

const isFavorited = computed(() => {
  const d = doc.value
  return d ? favoritesStore.isFavorite(d.id) : false
})

async function onToggleFavorite() {
  if (!doc.value) return
  try {
    await favoritesStore.toggle(doc.value.id, doc.value.title || t('doc.untitled'))
  }
  catch (err) {
    await dialog.alert({
      title: t('doc.favorite.failed'),
      message: (err as Error).message || t('doc.favorite.tryAgain'),
    })
  }
}

useHead(() => ({
  title: liveTitle.value ? `${liveTitle.value} — ${t('doc.head.titleSuffix')}` : t('doc.head.title'),
}))

const updatedAt = computed(() => {
  const t = doc.value?.updatedAt
  if (!t) return null
  return t instanceof Date ? t : new Date(t as unknown as string)
})
const editedAgo = useLocalizedTimeAgo(() => updatedAt.value ?? new Date())

async function onDelete() {
  if (!doc.value) return
  const ok = await dialog.confirm({
    title: t('doc.delete.title', { name: doc.value.title || t('doc.untitled') }),
    message: t('doc.delete.message'),
    confirmLabel: t('doc.delete.confirm'),
    destructive: true,
  })
  if (!ok) return
  const deletedId = doc.value.id
  await treeStore.deleteDocument(deletedId)
  favoritesStore.removeLocal(deletedId)
  await navigateTo(`/w/${workspaceId.value}`)
}

function onOpenRelated(targetDocId: number) {
  if (targetDocId === docId.value) return
  navigateTo(`/w/${workspaceId.value}/d/${targetDocId}`)
}

const exportMenuOpen = ref(false)

// Delay the close so a click on an `<button @mousedown="onExport(...)">` item
// — which fires before `blur` resolves on the trigger — still has the menu
// mounted when its handler runs.
function onExportBlur() {
  window.setTimeout(() => { exportMenuOpen.value = false }, 140)
}

function onExport(format: 'html' | 'pdf' | 'docx' | 'md') {
  if (!doc.value) return
  exportMenuOpen.value = false
  const id = doc.value.id
  // `md` falls back to the legacy markdown export endpoint; the three rich
  // formats live on dedicated routes (see server/api/documents/[id]/).
  const url = format === 'md'
    ? `/api/documents/${id}/export`
    : `/api/documents/${id}/export.${format}`
  // Use a hidden anchor with `download` so the browser triggers a Save As
  // dialog instead of navigating away from the editor.
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noopener noreferrer'
  // Same-origin endpoint sets the Content-Disposition; download attr
  // defaults to the server-provided filename when present.
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function onAskThisDoc() {
  if (!doc.value) return
  chat.openWithScope({
    workspaceId: workspaceId.value,
    docId: doc.value.id,
  })
}

// Sprint 5 / F9 — public share dialog. `hasActiveShares` is a session-local
// signal: bumps when the dialog reports its current count. We don't load
// the count on doc open (would be one extra request per doc view), so the
// dot only appears after the user opens the dialog or creates a link
// in-session.
const shareOpen = ref(false)
const hasActiveShares = ref(false)
function onSharesChanged(count: number) {
  hasActiveShares.value = count > 0
}

// Sprint 5 / I9 — version history dialog.
const historyOpen = ref(false)
// Bumped on every restore so the editor remounts with the restored content.
// The editor only resets `setContent` on a docId CHANGE — same id with new
// markdown wouldn't repaint without this key.
const editorVersionKey = ref(0)
async function onRestored(restored: Document) {
  if (data.value) data.value.document = restored
  liveTitle.value = restored.title
  liveMarkdown.value = restored.markdown
  treeStore.patchDocumentLocal(restored.id, { title: restored.title })
  editorVersionKey.value++
  // Refetch to canonicalise updatedAt / any server-side derived fields.
  await refresh()
}

// Ref to the <DocumentEditor> component. It exposes the live Tiptap editor
// via defineExpose, which we forward to <DocumentOutline> in the rail.
// Vue unwraps the exposed ShallowRef when accessed from a template ref.
interface DocumentEditorExposed { editor: Editor | undefined }
const editorComp = ref<DocumentEditorExposed | null>(null)
const editorInstance = computed<Editor | null>(() => {
  const exposed = editorComp.value as unknown as DocumentEditorExposed | null
  return exposed?.editor ?? null
})

// Sprint 5 / F10 — mobile bottom-sheet for the rail content.
const insightsSheetOpen = ref(false)

/* ---------- Resizable rail (Outline / Insights / Backlinks) ----------
 *
 * Drag the handle on the rail's left edge to widen / narrow it, same gesture
 * as the chat dock. Width persists to localStorage and is clamped. The rail
 * is right-anchored with the handle on its left edge, so dragging left grows
 * it → `invert: true`. */
const RAIL_MIN_WIDTH = 280
const RAIL_MAX_WIDTH = 640
const RAIL_DEFAULT_WIDTH = 378
const railWidthStore = useLocalStorage('noteforge-doc-rail-width', RAIL_DEFAULT_WIDTH)
const railWidth = computed(() =>
  Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, Math.round(railWidthStore.value || RAIL_DEFAULT_WIDTH))),
)
const { resizing: railResizing, start: startRailResize, end: endRailResize } = useResizable({
  axis: 'x',
  invert: true,
  get: () => railWidth.value,
  set: (px) => { railWidthStore.value = Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, Math.round(px))) },
})
onBeforeUnmount(endRailResize)
</script>

<template>
  <div class="doc-page">
    <article class="doc-area">
      <header class="doc-header">
        <div class="doc-header-top">
          <div class="crumbs">
            <NuxtLink :to="`/w/${workspaceId}`" class="crumb">{{ t('doc.crumbs.workspace') }}</NuxtLink>
            <span class="crumb-sep" aria-hidden="true">/</span>
            <span class="crumb crumb--current">{{ liveTitle || t('doc.untitled') }}</span>
          </div>
          <div class="meta-info">
            <span v-if="updatedAt" class="meta-item">{{ t('doc.meta.editedPrefix') }} {{ editedAgo }}</span>
            <button
              v-if="doc"
              type="button"
              class="meta-star"
              :class="{ 'meta-star--on': isFavorited }"
              :title="isFavorited ? t('doc.meta.starOn') : t('doc.meta.starOff')"
              :aria-pressed="isFavorited"
              @click="onToggleFavorite"
            >
              <svg
                viewBox="0 0 16 16"
                width="14"
                height="14"
                aria-hidden="true"
                :fill="isFavorited ? 'currentColor' : 'none'"
              >
                <path
                  d="M8 1.8l1.85 3.96 4.35.55-3.2 2.99.83 4.3L8 11.6 4.17 13.6l.83-4.3-3.2-2.99 4.35-.55L8 1.8z"
                  stroke="currentColor"
                  stroke-width="1.25"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>

        <div class="meta">
          <button
            v-if="doc"
            type="button"
            class="meta-action"
            :title="t('doc.meta.askTitle')"
            @click="onAskThisDoc"
          >
            {{ t('doc.meta.ask') }}
          </button>
          <button
            v-if="doc"
            type="button"
            class="meta-action meta-action--share"
            :title="t('doc.meta.shareTitle')"
            @click="shareOpen = true"
          >
            {{ t('doc.meta.share') }}
            <span v-if="hasActiveShares" class="share-dot" aria-hidden="true" />
          </button>
          <div v-if="doc" class="meta-action-wrap">
            <button
              type="button"
              class="meta-action"
              :title="t('doc.meta.exportTitle')"
              :aria-haspopup="true"
              :aria-expanded="exportMenuOpen"
              @click="exportMenuOpen = !exportMenuOpen"
              @blur="onExportBlur"
            >
              {{ t('doc.meta.export') }}
              <span class="export-caret" aria-hidden="true">▾</span>
            </button>
            <div v-if="exportMenuOpen" class="export-menu" role="menu">
              <button type="button" class="export-item" role="menuitem" @mousedown.prevent="onExport('md')">
                Markdown (.md)
              </button>
              <button type="button" class="export-item" role="menuitem" @mousedown.prevent="onExport('html')">
                HTML
              </button>
              <button type="button" class="export-item" role="menuitem" @mousedown.prevent="onExport('pdf')">
                PDF
              </button>
              <button type="button" class="export-item" role="menuitem" @mousedown.prevent="onExport('docx')">
                Word (.docx)
              </button>
            </div>
          </div>
          <button
            v-if="doc"
            type="button"
            class="meta-action"
            :title="t('doc.meta.historyTitle')"
            @click="historyOpen = true"
          >
            {{ t('doc.meta.history') }}
          </button>
          <button
            v-if="doc"
            type="button"
            class="meta-action"
            :title="t('doc.meta.deleteTitle')"
            @click="onDelete"
          >
            {{ t('doc.meta.delete') }}
          </button>
          <!-- Mobile-only: opens the rail (Outline / Insights / Backlinks)
               as a bottom sheet. The desktop rail (.doc-rail) is hidden
               below lg, so this button surfaces the same data. -->
          <button
            v-if="doc"
            type="button"
            class="meta-action meta-action--insights lg:hidden"
            :title="t('doc.meta.insightsTitle')"
            @click="insightsSheetOpen = true"
          >
            {{ t('doc.meta.insights') }}
          </button>
        </div>
      </header>

      <div v-if="pending && !doc" class="skeleton">
        <div class="sk-title" />
        <div class="sk-line" />
        <div class="sk-line sk-line--short" />
        <div class="sk-line" />
      </div>

      <div v-else-if="error" class="errstate">
        <p class="eyebrow">{{ t('doc.error.cantLoad') }}</p>
        <h2 class="errtitle">{{ t('doc.error.sideways') }}</h2>
        <p class="errmsg">{{ error.message || t('doc.error.refused') }}</p>
        <button class="ghost-btn" @click="refresh()">{{ t('doc.error.tryAgain') }}</button>
      </div>

      <ClientOnly v-else-if="doc">
        <DocumentEditor
          ref="editorComp"
          :key="`${doc.id}-${editorVersionKey}`"
          :doc="doc"
          @update:title="onTitleChange"
          @update:markdown="onMarkdownChange"
        />
        <template #fallback>
          <div class="skeleton">
            <div class="sk-title" />
            <div class="sk-line" />
            <div class="sk-line sk-line--short" />
            <div class="sk-line" />
          </div>
        </template>
      </ClientOnly>
    </article>

    <!-- Drag handle for the rail. A full-height flex sibling (not inside the
         scrolling rail) so it stays pinned on the rail's left edge. lg+ only,
         matching the rail's own visibility. -->
    <div
      class="rail-resize-handle hidden lg:flex"
      :class="{ 'rail-resize-handle--active': railResizing }"
      role="separator"
      aria-orientation="vertical"
      :aria-label="t('doc.rail.resize')"
      :title="t('doc.rail.resize')"
      @pointerdown="startRailResize"
    />
    <aside
      class="doc-rail"
      :style="{ width: railWidth + 'px' }"
    >
      <DocumentOutline v-if="doc" :editor="editorInstance" />
      <DocumentInsightsPanel
        v-if="doc"
        :doc-id="doc.id"
        :live-markdown="liveMarkdown"
        @open-doc="onOpenRelated"
      />
      <DocumentBacklinks v-if="doc" :doc-id="doc.id" />
    </aside>

    <ShareDialog
      v-if="doc"
      :doc-id="doc.id"
      :is-open="shareOpen"
      @close="shareOpen = false"
      @shares-changed="onSharesChanged"
    />

    <VersionHistoryDialog
      v-if="doc"
      :doc-id="doc.id"
      :is-open="historyOpen"
      @close="historyOpen = false"
      @restored="onRestored"
    />

    <DocInsightsSheet
      v-if="doc"
      :is-open="insightsSheetOpen"
      :doc-id="doc.id"
      :live-markdown="liveMarkdown"
      :editor="editorInstance"
      @close="insightsSheetOpen = false"
      @open-doc="onOpenRelated"
    />
  </div>
</template>

<style scoped>
.doc-page {
  @apply h-full w-full flex min-w-0;
}

.doc-area {
  /* Fixed-height flex column so only the editor's own canvas scrolls.
     Previously this used `overflow-auto` which made the whole article
     scroll AS WELL as the editor canvas — double scrollbar. */
  @apply flex-1 min-w-0 min-h-0 flex flex-col px-10 lg:px-14 pt-10;
  max-width: 100%;
}

.doc-header {
  /* Two stacked rows: (crumbs ←→ edited+star) on top, chip actions below. */
  @apply shrink-0 flex flex-col gap-3 mb-4 pb-4 border-b border-ink-200/60;
}
html.dark .doc-header {
  border-bottom-color: theme('colors.ink.800' / 60%);
}
.doc-header-top {
  @apply flex flex-wrap items-center justify-between gap-x-3 gap-y-2;
}
.meta-info {
  /* Right-aligned cluster — "edited X ago" + favorite star. */
  @apply flex items-center gap-1.5 font-sans uppercase text-[11px] font-semibold tracking-[0.08em] text-ink-500 dark:text-ink-400;
}
@media (max-width: 767px) {
  .doc-header {
    @apply mb-4 pb-3 gap-2;
  }
}
.crumbs {
  /* Bumped to 11px/medium for legibility — was 10px/regular and the user
     flagged this as "illegible". */
  @apply flex items-center gap-2 font-sans uppercase text-[11px] font-semibold tracking-[0.08em] text-ink-500 dark:text-ink-400;
}
.crumb { @apply text-ink-500 dark:text-ink-400; transition: color 120ms ease; }
.crumb:hover { color: theme('colors.ink.800'); }
html.dark .crumb:hover { color: theme('colors.ink.100'); }
.crumb--current {
  /* The current doc title in the crumbs gets a touch more presence. */
  @apply font-semibold tracking-[0.14em] text-ink-800 dark:text-ink-100;
}
.crumb-sep { @apply text-ink-300 dark:text-ink-600; }

.meta {
  @apply flex flex-wrap items-center gap-x-2 gap-y-2 font-sans uppercase text-[11px] font-semibold tracking-[0.08em] text-ink-500 dark:text-ink-400;
}
.meta-item {
  @apply text-ink-500 dark:text-ink-400;
}
.meta-action {
  /* Pill chip — uppercase label with a soft border and hover-fill. min-h-9
     (36px) keeps a comfortable tap target on touch devices (F10). */
  @apply inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border uppercase text-[11px] font-semibold tracking-[0.08em] text-ink-600 dark:text-ink-300 transition-colors;
  border-color: theme('colors.ink.200');
  min-height: 2.25rem;
}
html.dark .meta-action {
  border-color: theme('colors.ink.700');
}
.meta-action:hover {
  background: theme('colors.ink.100' / 60%);
  color: theme('colors.accent.700');
  border-color: theme('colors.ink.300');
}
html.dark .meta-action:hover {
  background: theme('colors.ink.800' / 60%);
  color: theme('colors.accent.300');
  border-color: theme('colors.ink.600');
}

.meta-action--share {
  /* Gap is already handled by `.meta-action`; this variant is kept for the
     share-dot's sibling positioning if it ever needs special treatment. */
}

/* Export dropdown */
.meta-action-wrap {
  position: relative;
  display: inline-flex;
}
.export-caret {
  font-size: 0.65rem;
  margin-left: 0.15rem;
  opacity: 0.7;
}
.export-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 0.25rem;
  z-index: 40;
  min-width: 11rem;
  border-radius: 0.375rem;
  border: 1px solid theme('colors.ink.200');
  background: white;
  box-shadow: 0 10px 24px -8px rgb(0 0 0 / 0.18);
  padding: 0.25rem 0;
  overflow: hidden;
}
html.dark .export-menu {
  border-color: theme('colors.ink.800');
  background: theme('colors.ink.900');
}
.export-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 0.45rem 0.75rem;
  font-size: 0.8rem;
  letter-spacing: 0.04em;
  color: theme('colors.ink.700');
  background: transparent;
  border: 0;
  cursor: pointer;
  transition: background-color 0.12s ease, color 0.12s ease;
  text-transform: none;
  font-weight: 500;
}
html.dark .export-item {
  color: theme('colors.ink.200');
}
.export-item:hover {
  background: theme('colors.ink.100');
  color: theme('colors.accent.700');
}
html.dark .export-item:hover {
  background: theme('colors.ink.800');
  color: theme('colors.accent.300');
}
/* `lg:hidden` in the template is shadowed by `.meta-action { @apply inline-flex }`
   because scoped <style> is injected after Tailwind's utilities layer. Enforce
   the hide above the lg breakpoint in scoped CSS itself. */
@media (min-width: 1024px) {
  .meta-action--insights { display: none; }
}
.share-dot {
  @apply inline-block h-1.5 w-1.5 rounded-full bg-accent-500;
}

.meta-star {
  @apply inline-flex items-center justify-center h-6 w-6 -mx-1 rounded text-ink-500 dark:text-ink-400 transition-colors;
}
@media (max-width: 767px) {
  .meta-star {
    @apply h-9 w-9;
  }
}
.meta-star:hover {
  background: theme('colors.ink.100' / 60%);
  color: theme('colors.accent.700');
}
html.dark .meta-star:hover {
  background: theme('colors.ink.800' / 60%);
  color: theme('colors.accent.300');
}
.meta-star--on,
.meta-star--on:hover {
  color: theme('colors.accent.500');
}
html.dark .meta-star--on,
html.dark .meta-star--on:hover {
  color: theme('colors.accent.400');
}

.skeleton { @apply max-w-[680px] mx-auto pt-8; }
.sk-title {
  @apply h-8 w-2/3 rounded mb-8 bg-ink-100 dark:bg-ink-800;
  animation: shimmer 1.4s ease-in-out infinite;
}
.sk-line {
  @apply h-3 w-full rounded mb-3 bg-ink-100 dark:bg-ink-800;
  animation: shimmer 1.4s ease-in-out infinite;
}
.sk-line--short { @apply w-1/2; }
@keyframes shimmer {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}

.errstate { @apply max-w-[480px] mx-auto pt-12; }
.eyebrow {
  @apply label-mono mb-3;
}
.errtitle {
  @apply font-serif text-[1.6rem] tracking-tight text-ink-900 dark:text-ink-100 mb-2;
}
.errmsg {
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

.doc-rail {
  @apply relative hidden lg:flex flex-col shrink-0 overflow-auto;
  /* Width is user-resizable (bound inline, persisted, clamped 280–640px).
     378px default = enough for Summary / Tags / Use cases / Questions /
     Actions to sit on a single line with the panel's p-4 padding. */
  border-left: 1px solid theme('colors.ink.200' / 60%);
  background: theme('colors.ink.50');
}
html.dark .doc-rail {
  border-left-color: theme('colors.ink.800' / 60%);
  background: theme('colors.ink.900');
}
/* Resize grip — a full-height flex sibling sitting on the rail's left edge.
   The hit strip straddles the border (negative right margin pulls it over);
   the visible bar is a centered pill that brightens on hover / while active. */
.rail-resize-handle {
  @apply shrink-0 cursor-ew-resize items-center justify-center self-stretch;
  width: 7px;
  margin-right: -7px;
  z-index: 5;
  touch-action: none;
}
.rail-resize-handle::before {
  content: '';
  @apply h-10 w-1 rounded-full bg-ink-300 transition-colors;
}
html.dark .rail-resize-handle::before {
  background: theme('colors.ink.700');
}
.rail-resize-handle:hover::before,
.rail-resize-handle--active::before {
  background: theme('colors.accent.400');
}
</style>
