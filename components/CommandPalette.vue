<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import type { Document } from '~/server/database/schema'
import { usePaletteStore } from '~/stores/palette'
import { useWorkspacesStore } from '~/stores/workspaces'
import { useTreeStore } from '~/stores/tree'
import { useChatStore } from '~/stores/chat'
import { useDialog } from '~/composables/useDialog'
import { useTheme } from '~/composables/useTheme'
import { useLocale } from '~/composables/useLocale'

const { t } = useLocale()

const palette = usePaletteStore()
const workspacesStore = useWorkspacesStore()
const treeStore = useTreeStore()
const chatStore = useChatStore()
const dialog = useDialog()
const { toggle: toggleTheme } = useTheme()
const router = useRouter()

const { isOpen, query, recentDocIds } = storeToRefs(palette)
const { current: currentWorkspace, workspaces } = storeToRefs(workspacesStore)
const { documents: workspaceDocuments } = storeToRefs(treeStore)

const inputEl = ref<HTMLInputElement | null>(null)
const selectedIndex = ref(0)

/* --------------------------------------------------------------------- */
/*  Fuzzy match                                                          */
/* --------------------------------------------------------------------- */

/**
 * Subsequence match: every char of `needle` (lowercased) must appear in
 * `hay` (lowercased) in order, but not necessarily contiguously. Empty
 * needle always matches.
 */
function fuzzyMatch(needle: string, hay: string): boolean {
  if (needle.length === 0) return true
  const n = needle.toLowerCase()
  const h = hay.toLowerCase()
  let i = 0
  for (let j = 0; j < h.length && i < n.length; j++) {
    if (h[j] === n[i]) i++
  }
  return i === n.length
}

/* --------------------------------------------------------------------- */
/*  Sections                                                             */
/* --------------------------------------------------------------------- */

type IconKind = 'doc' | 'folder' | 'workspace' | 'action' | 'recent'

interface PaletteItem {
  id: string
  icon: IconKind
  label: string
  hint?: string
  run: () => void | Promise<void>
}

interface PaletteSection {
  key: string
  title: string
  items: PaletteItem[]
}

const docsById = computed<Map<number, Document>>(() => {
  const map = new Map<number, Document>()
  for (const d of workspaceDocuments.value) map.set(d.id, d)
  return map
})

function gotoDoc(docId: number) {
  const ws = currentWorkspace.value
  if (!ws) return
  palette.pushRecent(docId)
  palette.close()
  router.push(`/w/${ws.id}/d/${docId}`)
}

function gotoWorkspace(id: number) {
  workspacesStore.setCurrent(id)
  palette.close()
  router.push(`/w/${id}`)
}

/* ---- Recent docs ---- */
const recentItems = computed<PaletteItem[]>(() => {
  if (!currentWorkspace.value) return []
  const q = query.value.trim()
  const out: PaletteItem[] = []
  for (const id of recentDocIds.value) {
    const doc = docsById.value.get(id)
    if (!doc) continue
    const title = doc.title || t('doc.untitled')
    if (q.length > 0 && !fuzzyMatch(q, title)) continue
    out.push({
      id: `recent-${doc.id}`,
      icon: 'recent',
      label: title,
      run: () => gotoDoc(doc.id),
    })
    if (out.length >= 5) break
  }
  return out
})

/* ---- All docs ---- */
const docItems = computed<PaletteItem[]>(() => {
  const q = query.value.trim()
  // Hide the "all docs" section when there's no query — recents covers
  // the cold-open case. With a query, show matches.
  if (q.length === 0) return []
  const recentSet = new Set(recentItems.value.map(i => i.id.replace(/^recent-/, '')))
  const out: PaletteItem[] = []
  for (const doc of workspaceDocuments.value) {
    if (recentSet.has(String(doc.id))) continue
    const title = doc.title || t('doc.untitled')
    if (!fuzzyMatch(q, title)) continue
    out.push({
      id: `doc-${doc.id}`,
      icon: 'doc',
      label: title,
      run: () => gotoDoc(doc.id),
    })
    if (out.length >= 20) break
  }
  return out
})

/* ---- Actions ---- */
async function actionNewDocument() {
  const ws = currentWorkspace.value
  if (!ws) return
  palette.close()
  const doc = await treeStore.createDocument({ folderId: null })
  await router.push(`/w/${ws.id}/d/${doc.id}`)
}

async function actionNewFolder() {
  if (!currentWorkspace.value) return
  palette.close()
  const name = await dialog.prompt({
    title: t('folder.new.title'),
    placeholder: t('folder.new.placeholder'),
    confirmLabel: t('folder.new.confirm'),
  })
  if (!name) return
  await treeStore.createFolder({ name, parentId: null })
}

function actionOpenChat() {
  if (!currentWorkspace.value) return
  palette.close()
  chatStore.openWithQuestion()
}

function actionToggleTheme() {
  toggleTheme()
  palette.close()
}

function actionGoToTrash() {
  const ws = currentWorkspace.value
  if (!ws) return
  palette.close()
  router.push(`/w/${ws.id}/trash`)
}

function actionExportWorkspace() {
  const ws = currentWorkspace.value
  if (!ws) return
  palette.close()
  window.location.href = `/api/workspaces/${ws.id}/export`
}

interface ActionDef {
  id: string
  label: string
  keywords: string[]
  hint?: string
  run: () => void | Promise<void>
  requiresWorkspace: boolean
}

const actionDefs = computed<ActionDef[]>(() => [
  {
    id: 'a-new-doc',
    label: t('palette.action.newDoc'),
    keywords: ['new', 'document', 'doc', 'create', 'nouveau', 'créer'],
    hint: 'Ctrl+Alt+N',
    run: actionNewDocument,
    requiresWorkspace: true,
  },
  {
    id: 'a-new-folder',
    label: t('palette.action.newFolder'),
    keywords: ['new', 'folder', 'create', 'dossier', 'nouveau'],
    run: actionNewFolder,
    requiresWorkspace: true,
  },
  {
    id: 'a-open-chat',
    label: t('palette.action.openChat'),
    keywords: ['chat', 'ask', 'rag'],
    run: actionOpenChat,
    requiresWorkspace: true,
  },
  {
    id: 'a-toggle-theme',
    label: t('palette.action.toggleTheme'),
    keywords: ['theme', 'dark', 'light', 'mode', 'thème', 'sombre', 'clair'],
    run: actionToggleTheme,
    requiresWorkspace: false,
  },
  {
    id: 'a-trash',
    label: t('palette.action.trash'),
    keywords: ['trash', 'deleted', 'bin', 'corbeille'],
    run: actionGoToTrash,
    requiresWorkspace: true,
  },
  {
    id: 'a-export',
    label: t('palette.action.export'),
    keywords: ['export', 'download', 'zip', 'workspace', 'espace'],
    run: actionExportWorkspace,
    requiresWorkspace: true,
  },
])

const actionItems = computed<PaletteItem[]>(() => {
  const q = query.value.trim().toLowerCase()
  const hasWorkspace = currentWorkspace.value != null
  return actionDefs.value
    .filter((a) => {
      if (a.requiresWorkspace && !hasWorkspace) return false
      if (q.length === 0) return true
      if (fuzzyMatch(q, a.label)) return true
      return a.keywords.some(k => k.includes(q))
    })
    .map<PaletteItem>(a => ({
      id: a.id,
      icon: 'action',
      label: a.label,
      hint: a.hint,
      run: a.run,
    }))
})

/* ---- Workspaces ---- */
const workspaceItems = computed<PaletteItem[]>(() => {
  const q = query.value.trim()
  const currentId = currentWorkspace.value?.id ?? null
  const out: PaletteItem[] = []
  for (const ws of workspaces.value) {
    if (ws.id === currentId && q.length === 0) continue
    const name = ws.name
    if (q.length > 0 && !fuzzyMatch(q, name)) continue
    out.push({
      id: `ws-${ws.id}`,
      icon: 'workspace',
      label: ws.emoji ? `${ws.emoji}  ${name}` : name,
      hint: ws.id === currentId ? t('palette.workspaceCurrent') : undefined,
      run: () => gotoWorkspace(ws.id),
    })
  }
  return out
})

const sections = computed<PaletteSection[]>(() => {
  const out: PaletteSection[] = []
  if (recentItems.value.length > 0) out.push({ key: 'recent', title: t('palette.section.recent'), items: recentItems.value })
  if (docItems.value.length > 0) out.push({ key: 'docs', title: t('palette.section.docs'), items: docItems.value })
  if (actionItems.value.length > 0) out.push({ key: 'actions', title: t('palette.section.actions'), items: actionItems.value })
  if (workspaceItems.value.length > 0) out.push({ key: 'workspaces', title: t('palette.section.workspaces'), items: workspaceItems.value })
  return out
})

/** Flat list of items in render order — drives keyboard nav. */
const flatItems = computed<PaletteItem[]>(() => sections.value.flatMap(s => s.items))

/* --------------------------------------------------------------------- */
/*  Keyboard nav                                                         */
/* --------------------------------------------------------------------- */

watch(query, () => { selectedIndex.value = 0 })
watch(flatItems, (list) => {
  if (selectedIndex.value >= list.length) selectedIndex.value = 0
})

watch(isOpen, async (open) => {
  if (open) {
    selectedIndex.value = 0
    await nextTick()
    inputEl.value?.focus()
    inputEl.value?.select()
  }
})

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    palette.close()
    return
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    const total = flatItems.value.length
    if (total === 0) return
    selectedIndex.value = (selectedIndex.value + 1) % total
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    const total = flatItems.value.length
    if (total === 0) return
    selectedIndex.value = (selectedIndex.value - 1 + total) % total
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    const item = flatItems.value[selectedIndex.value]
    if (item) void item.run()
  }
}

function onBackdropClick() {
  palette.close()
}

function onPanelClick(e: MouseEvent) {
  // Keep clicks inside the panel from bubbling to the backdrop.
  e.stopPropagation()
}

function indexOfItem(itemId: string): number {
  return flatItems.value.findIndex(i => i.id === itemId)
}

function onItemClick(item: PaletteItem) {
  void item.run()
}

function onItemMouseMove(item: PaletteItem) {
  const idx = indexOfItem(item.id)
  if (idx !== -1) selectedIndex.value = idx
}
</script>

<template>
  <Teleport to="body">
    <Transition name="overlay">
      <div
        v-if="isOpen"
        class="overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        @click="onBackdropClick"
        @keydown="onKeydown"
      >
        <h2 id="command-palette-title" class="sr-only">{{ t('palette.title') }}</h2>
        <Transition name="card" appear>
          <div v-if="isOpen" class="panel" @click="onPanelClick">
            <div class="search">
              <svg class="search-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.25" />
                <path d="M11 11l3 3" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
              </svg>
              <input
                ref="inputEl"
                v-model="query"
                type="text"
                class="search-input"
                :placeholder="t('palette.placeholder')"
                autocomplete="off"
                spellcheck="false"
                :aria-label="t('palette.ariaLabel')"
                aria-controls="command-palette-list"
                :aria-activedescendant="flatItems[selectedIndex]?.id ?? undefined"
              />
              <kbd class="esc-hint">{{ t('palette.esc') }}</kbd>
            </div>

            <div id="command-palette-list" class="list" role="listbox">
              <div v-if="flatItems.length === 0" class="empty">
                <p>{{ t('palette.empty') }}</p>
              </div>

              <template v-for="section in sections" :key="section.key">
                <div class="section-title">{{ section.title }}</div>
                <button
                  v-for="item in section.items"
                  :id="item.id"
                  :key="item.id"
                  type="button"
                  role="option"
                  :aria-selected="flatItems[selectedIndex]?.id === item.id"
                  class="row"
                  :class="{ 'row--active': flatItems[selectedIndex]?.id === item.id }"
                  @click="onItemClick(item)"
                  @mousemove="onItemMouseMove(item)"
                >
                  <span class="row-icon" aria-hidden="true">
                    <!-- Doc -->
                    <svg v-if="item.icon === 'doc'" viewBox="0 0 16 16" width="13" height="13">
                      <path
                        d="M4 2.5h5l3 3V13a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 4 13zM9 2.5V5.5h3"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.2"
                        stroke-linejoin="round"
                      />
                    </svg>
                    <!-- Recent (clock) -->
                    <svg v-else-if="item.icon === 'recent'" viewBox="0 0 16 16" width="13" height="13">
                      <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.2" />
                      <path d="M8 5v3l2 1.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
                    </svg>
                    <!-- Workspace -->
                    <svg v-else-if="item.icon === 'workspace'" viewBox="0 0 16 16" width="13" height="13">
                      <rect x="2.5" y="3.5" width="11" height="9" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2" />
                      <path d="M2.5 6.5h11" fill="none" stroke="currentColor" stroke-width="1.2" />
                    </svg>
                    <!-- Action (chevron) -->
                    <svg v-else viewBox="0 0 16 16" width="13" height="13">
                      <path
                        d="M6 4l4 4-4 4"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.25"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                  </span>
                  <span class="row-label">{{ item.label }}</span>
                  <span v-if="item.hint" class="row-hint">{{ item.hint }}</span>
                </button>
              </template>
            </div>

            <footer class="foot">
              <span class="foot-hint"><kbd>↑</kbd><kbd>↓</kbd> {{ t('palette.foot.navigate') }}</span>
              <span class="foot-hint"><kbd>Enter</kbd> {{ t('palette.foot.select') }}</span>
              <span class="foot-hint"><kbd>{{ t('palette.esc') }}</kbd> {{ t('palette.foot.close') }}</span>
            </footer>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.overlay {
  @apply fixed inset-0 z-50 flex items-start justify-center px-6 pt-[12vh];
  background: theme('colors.ink.900' / 35%);
  backdrop-filter: blur(4px);
}
html.dark .overlay {
  background: theme('colors.ink.950' / 70%);
}

.panel {
  @apply relative w-full max-w-[640px] flex flex-col rounded-lg bg-ink-50 dark:bg-ink-900 overflow-hidden;
  max-height: 80vh;
  border: 1px solid theme('colors.ink.200');
  box-shadow: 0 24px 60px -20px theme('colors.ink.900' / 35%);
}
html.dark .panel {
  border-color: theme('colors.ink.800');
  box-shadow: 0 24px 60px -20px theme('colors.ink.950' / 70%);
}

.search {
  @apply flex items-center gap-3 px-4 py-3 shrink-0;
  border-bottom: 1px solid theme('colors.ink.200' / 60%);
}
html.dark .search {
  border-bottom-color: theme('colors.ink.800' / 60%);
}
.search-icon {
  @apply text-ink-400 dark:text-ink-500 shrink-0;
}
.search-input {
  @apply flex-1 min-w-0 bg-transparent border-0 outline-none text-[15px] text-ink-900 dark:text-ink-50;
}
.search-input::placeholder {
  @apply text-ink-400 dark:text-ink-500;
}
.esc-hint {
  @apply inline-flex items-center justify-center h-5 px-1.5 rounded font-mono text-[10px] text-ink-500 dark:text-ink-400;
  border: 1px solid theme('colors.ink.200');
  background: theme('colors.ink.100' / 60%);
}
html.dark .esc-hint {
  border-color: theme('colors.ink.700');
  background: theme('colors.ink.800' / 60%);
}

.list {
  @apply flex-1 min-h-0 overflow-auto py-1.5;
}

.section-title {
  @apply label-mono px-4 pt-3 pb-1.5;
}
.section-title:first-child {
  @apply pt-1.5;
}

.row {
  @apply w-full flex items-center gap-3 px-4 h-9 text-left text-[13.5px] text-ink-700 dark:text-ink-200;
  transition: background 80ms ease, color 80ms ease;
}
.row-icon {
  @apply inline-flex items-center justify-center h-5 w-5 shrink-0 text-ink-400 dark:text-ink-500;
}
.row-label {
  @apply flex-1 min-w-0 truncate;
}
.row-hint {
  @apply shrink-0 font-mono text-[11px] text-ink-400 dark:text-ink-500;
}
.row--active {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
}
html.dark .row--active {
  background: theme('colors.ink.800');
  color: theme('colors.ink.50');
}
.row--active .row-icon {
  color: theme('colors.accent.600');
}
html.dark .row--active .row-icon {
  color: theme('colors.accent.400');
}
.row--active .row-hint {
  color: theme('colors.ink.500');
}
html.dark .row--active .row-hint {
  color: theme('colors.ink.300');
}

.empty {
  @apply px-4 py-8 text-center text-[13px] text-ink-500 dark:text-ink-400;
}

.foot {
  @apply flex items-center gap-4 px-4 py-2 shrink-0 font-sans text-[11px] text-ink-500 dark:text-ink-400;
  border-top: 1px solid theme('colors.ink.200' / 60%);
}
html.dark .foot {
  border-top-color: theme('colors.ink.800' / 60%);
}
.foot-hint {
  @apply inline-flex items-center gap-1.5;
}
.foot kbd {
  @apply inline-flex items-center justify-center h-[18px] min-w-[18px] px-1 rounded font-mono text-[10px] text-ink-600 dark:text-ink-300;
  border: 1px solid theme('colors.ink.200');
  background: theme('colors.ink.100' / 60%);
}
html.dark .foot kbd {
  border-color: theme('colors.ink.700');
  background: theme('colors.ink.800' / 60%);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* Transitions */
.overlay-enter-from, .overlay-leave-to { opacity: 0; }
.overlay-enter-active, .overlay-leave-active { transition: opacity 140ms ease; }
.card-enter-from { opacity: 0; transform: translateY(-8px) scale(0.98); }
.card-enter-to { opacity: 1; transform: translateY(0) scale(1); }
.card-enter-active { transition: opacity 160ms ease, transform 160ms ease; }
</style>
