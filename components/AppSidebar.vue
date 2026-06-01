<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useWorkspacesStore } from '~/stores/workspaces'
import { useTreeStore } from '~/stores/tree'
import { useFavoritesStore } from '~/stores/favorites'
import { useAuth } from '~/composables/useAuth'
import { useDialog } from '~/composables/useDialog'
import { useFileImport } from '~/composables/useFileImport'
import { useLocale } from '~/composables/useLocale'
import { useDragStore, type DragScope } from '~/stores/drag'
import { computeReorderPosition } from '~/composables/useReorder'
import { useSavedSearchesStore, type SavedSearchRow } from '~/stores/savedSearches'
import { useBulkSelectStore } from '~/stores/bulkSelect'

const mcpOpen = ref(false)
const shareOpen = ref(false)

defineProps<{ collapsed?: boolean }>()
const emit = defineEmits<{
  (e: 'toggle'): void
  (e: 'close-mobile'): void
}>()

const workspacesStore = useWorkspacesStore()
const treeStore = useTreeStore()
const favoritesStore = useFavoritesStore()
const savedSearchesStore = useSavedSearchesStore()
const bulkSelect = useBulkSelectStore()
const { user, logout } = useAuth()
const dialog = useDialog()
const { t } = useLocale()
const { busy: importBusy, importFiles } = useFileImport()
const dragStore = useDragStore()
const router = useRouter()
const { draggedDocId, overTarget, dragging, insertBefore, insertAtEndOf } = storeToRefs(dragStore)

const { current, workspaces } = storeToRefs(workspacesStore)
const { tree, loading: treeLoading } = storeToRefs(treeStore)
const { entries: favoriteEntries } = storeToRefs(favoritesStore)
const { sorted: savedSearches, expanded: savedExpanded } = storeToRefs(savedSearchesStore)

// Hardcoded French strings for the new bits — sidebar uses `t()` for the
// rest but the brief said to use local literals for the new features.
const L = {
  searchLink: 'Recherche',
  graphLink: 'Vue graphe',
  savedSearches: 'Recherches',
  noSaved: 'Aucune recherche sauvegardée.',
  bulkOn: 'Activer la sélection groupée',
  bulkOff: 'Quitter la sélection groupée',
  bulkSelected: (n: number) => n === 1 ? '1 sélectionné' : `${n} sélectionnés`,
  bulkMove: 'Déplacer…',
  bulkTrash: 'Corbeille',
  bulkTag: 'Tag +',
  bulkUntag: 'Tag -',
  bulkExport: 'Exporter ZIP',
  bulkAnalyze: 'Analyser & indexer',
  analyzeConfirmTitle: (n: number) => `Réanalyser ${n} note${n > 1 ? 's' : ''} ?`,
  analyzeConfirmBody: 'NoteForge va contacter Mistral pour chaque note sélectionnée (analyse + réindexation). Cela peut prendre plusieurs dizaines de secondes.',
  analyzeConfirmYes: 'Réanalyser',
  movePromptTitle: 'Déplacer vers…',
  movePromptMessage: 'Entrez l\'ID du dossier ou « racine » pour la racine.',
  movePromptPlaceholder: 'ex. 12 · racine',
  movePromptConfirm: 'Déplacer',
  tagPromptTitle: 'Ajouter un tag aux notes sélectionnées',
  tagPromptPlaceholder: 'ex. réunions',
  tagPromptConfirm: 'Ajouter',
  untagPromptTitle: 'Retirer un tag des notes sélectionnées',
  untagPromptConfirm: 'Retirer',
  trashConfirmTitle: (n: number) => `Mettre à la corbeille ${n} note${n > 1 ? 's' : ''} ?`,
  trashConfirmBody: 'Vous pourrez les restaurer depuis la corbeille.',
  trashConfirmYes: 'Mettre à la corbeille',
  renameSaved: 'Renommer',
  deleteSaved: 'Supprimer',
  deleteSavedTitle: (name: string) => `Supprimer « ${name} » ?`,
  deleteSavedBody: 'Cette action est définitive.',
  bulkError: 'Échec',
}

// Keep tree + favorites + saved-searches synced with active workspace
watch(
  () => current.value?.id ?? null,
  async (id) => {
    if (id == null) {
      treeStore.reset()
      favoritesStore.reset()
      savedSearchesStore.reset()
      return
    }
    await treeStore.fetchWorkspaceTree(id)
    favoritesStore.load(id).catch(() => { /* ignore */ })
    savedSearchesStore.load(id).catch(() => { /* ignore */ })
  },
  { immediate: false },
)

onMounted(async () => {
  if (!workspacesStore.loaded) await workspacesStore.fetchAll()
  if (current.value) {
    await treeStore.fetchWorkspaceTree(current.value.id)
    favoritesStore.load(current.value.id).catch(() => { /* ignore */ })
    savedSearchesStore.load(current.value.id).catch(() => { /* ignore */ })
  }
})

/* ---------- Saved searches ---------- */

async function onApplySavedSearch(s: SavedSearchRow) {
  if (!current.value) return
  const q: Record<string, string> = {}
  const qj = s.queryJson ?? {}
  if (qj.q) q.q = qj.q
  if (qj.tags && qj.tags.length > 0) q.tag = qj.tags[0]!
  if (typeof qj.folderId === 'number') q.folderId = String(qj.folderId)
  if (qj.dateFrom) q.dateFrom = qj.dateFrom
  if (qj.dateTo) q.dateTo = qj.dateTo
  if (qj.sort && qj.sort !== 'recent') q.sort = qj.sort
  await router.push({ path: `/w/${current.value.id}/search`, query: q })
}

async function onRenameSaved(s: SavedSearchRow, e: Event) {
  e.stopPropagation()
  e.preventDefault()
  const name = await dialog.prompt({
    title: L.renameSaved,
    defaultValue: s.name,
    confirmLabel: L.renameSaved,
  })
  if (!name || name === s.name) return
  try { await savedSearchesStore.rename(s.id, name) }
  catch (err) {
    await dialog.alert({ title: L.bulkError, message: (err as Error).message })
  }
}

async function onDeleteSaved(s: SavedSearchRow, e: Event) {
  e.stopPropagation()
  e.preventDefault()
  const ok = await dialog.confirm({
    title: L.deleteSavedTitle(s.name),
    message: L.deleteSavedBody,
    destructive: true,
  })
  if (!ok) return
  try { await savedSearchesStore.remove(s.id) }
  catch (err) {
    await dialog.alert({ title: L.bulkError, message: (err as Error).message })
  }
}

/* ---------- Bulk operations ---------- */

function onToggleBulk() {
  bulkSelect.toggle()
}

interface BulkResult {
  ok: number[]
  errors: { docId: number, message: string }[]
}

async function onBulkMove() {
  if (!current.value) return
  const raw = await dialog.prompt({
    title: L.movePromptTitle,
    message: L.movePromptMessage,
    placeholder: L.movePromptPlaceholder,
    confirmLabel: L.movePromptConfirm,
  })
  if (raw == null) return
  let folderId: number | null
  const trimmed = raw.trim().toLowerCase()
  if (trimmed === '' || trimmed === 'racine' || trimmed === 'root' || trimmed === 'null') {
    folderId = null
  }
  else {
    const n = Number(trimmed)
    if (!Number.isInteger(n) || n <= 0) {
      await dialog.alert({ title: L.bulkError, message: 'ID de dossier invalide.' })
      return
    }
    folderId = n
  }
  try {
    await $fetch<BulkResult>('/api/documents/bulk', {
      method: 'POST',
      body: {
        action: 'move',
        docIds: [...bulkSelect.selectedDocs],
        folderId,
      },
    })
    // Reload tree to reflect new locations.
    await treeStore.fetchWorkspaceTree(current.value.id, true)
    bulkSelect.exit()
  }
  catch (err) {
    await dialog.alert({ title: L.bulkError, message: (err as Error).message })
  }
}

async function onBulkTrash() {
  if (!current.value) return
  const n = bulkSelect.selectedDocs.length
  const ok = await dialog.confirm({
    title: L.trashConfirmTitle(n),
    message: L.trashConfirmBody,
    confirmLabel: L.trashConfirmYes,
    destructive: true,
  })
  if (!ok) return
  try {
    await $fetch<BulkResult>('/api/documents/bulk', {
      method: 'POST',
      body: {
        action: 'trash',
        docIds: [...bulkSelect.selectedDocs],
      },
    })
    await treeStore.fetchWorkspaceTree(current.value.id, true)
    bulkSelect.exit()
  }
  catch (err) {
    await dialog.alert({ title: L.bulkError, message: (err as Error).message })
  }
}

async function onBulkTagAdd() {
  const tag = await dialog.prompt({
    title: L.tagPromptTitle,
    placeholder: L.tagPromptPlaceholder,
    confirmLabel: L.tagPromptConfirm,
  })
  if (!tag) return
  try {
    const res = await $fetch<BulkResult>('/api/documents/bulk', {
      method: 'POST',
      body: {
        action: 'tag-add',
        docIds: [...bulkSelect.selectedDocs],
        tag,
      },
    })
    if (res.errors.length > 0) {
      await dialog.alert({
        title: L.bulkError,
        message: `${res.errors.length} note(s) ignorée(s). Vérifiez qu'elles ont une analyse IA.`,
      })
    }
    else {
      bulkSelect.exit()
    }
  }
  catch (err) {
    await dialog.alert({ title: L.bulkError, message: (err as Error).message })
  }
}

async function onBulkTagRemove() {
  const tag = await dialog.prompt({
    title: L.untagPromptTitle,
    placeholder: L.tagPromptPlaceholder,
    confirmLabel: L.untagPromptConfirm,
  })
  if (!tag) return
  try {
    await $fetch<BulkResult>('/api/documents/bulk', {
      method: 'POST',
      body: {
        action: 'tag-remove',
        docIds: [...bulkSelect.selectedDocs],
        tag,
      },
    })
    bulkSelect.exit()
  }
  catch (err) {
    await dialog.alert({ title: L.bulkError, message: (err as Error).message })
  }
}

async function onBulkAnalyze() {
  if (!current.value) return
  const n = bulkSelect.docCount
  if (n === 0) return
  const ok = await dialog.confirm({
    title: L.analyzeConfirmTitle(n),
    message: L.analyzeConfirmBody,
    confirmLabel: L.analyzeConfirmYes,
  })
  if (!ok) return
  try {
    const res = await $fetch<BulkResult>('/api/documents/bulk', {
      method: 'POST',
      body: {
        action: 'analyze',
        docIds: [...bulkSelect.selectedDocs],
      },
    })
    if (res.errors.length > 0) {
      await dialog.alert({
        title: L.bulkError,
        message: `${res.ok.length} note${res.ok.length > 1 ? 's' : ''} analysée${res.ok.length > 1 ? 's' : ''}. ${res.errors.length} échouée${res.errors.length > 1 ? 's' : ''}.`,
      })
    }
    bulkSelect.exit()
  }
  catch (err) {
    await dialog.alert({ title: L.bulkError, message: (err as Error).message })
  }
}

async function onBulkExport() {
  if (bulkSelect.selectedDocs.length === 0) return
  // Use a hidden form-style POST so the browser streams the ZIP straight to disk.
  try {
    const res = await fetch('/api/documents/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        action: 'export',
        docIds: [...bulkSelect.selectedDocs],
      }),
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `documents-${Date.now()}.zip`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }
  catch (err) {
    await dialog.alert({ title: L.bulkError, message: (err as Error).message })
  }
}

const isAdmin = computed(() => !!(user.value as { isAdmin?: boolean } | null)?.isAdmin)

const displayName = computed(() => {
  const u = user.value as { displayName?: string | null, email?: string } | null
  return u?.displayName || u?.email || 'You'
})
const initials = computed(() => {
  const u = user.value as { displayName?: string | null, email?: string } | null
  const src = (u?.displayName || u?.email || '?').trim()
  return src.slice(0, 1).toUpperCase()
})
const userEmail = computed(() => (user.value as { email?: string } | null)?.email ?? '')

async function onSelectWorkspace(id: number) {
  workspacesStore.setCurrent(id)
  await router.push(`/w/${id}`)
}

function onCreateWorkspace() {
  workspacesStore.openCreate()
}

async function onRenameWorkspace(id: number) {
  const ws = workspacesStore.workspaces.find(w => w.id === id)
  if (!ws) return
  const name = await dialog.prompt({
    title: t('workspace.rename.title'),
    defaultValue: ws.name,
    placeholder: t('workspace.rename.placeholder'),
    confirmLabel: t('workspace.rename.confirm'),
  })
  if (!name || name === ws.name) return
  await workspacesStore.rename(id, name)
}

async function onDeleteWorkspace(id: number) {
  const ws = workspacesStore.workspaces.find(w => w.id === id)
  if (!ws) return
  const ok = await dialog.confirm({
    title: t('workspace.delete.title', { name: ws.name }),
    message: t('workspace.delete.message'),
    confirmLabel: t('workspace.delete.confirm'),
    destructive: true,
  })
  if (!ok) return
  await workspacesStore.remove(id)
  const nextId = workspacesStore.currentWorkspaceId
  if (nextId != null) await router.push(`/w/${nextId}`)
  else await router.push('/')
}

async function onCreateRootDocument() {
  if (!current.value) return
  const doc = await treeStore.createDocument({ folderId: null })
  await router.push(`/w/${current.value.id}/d/${doc.id}`)
}

async function onCreateRootFolder() {
  const name = await dialog.prompt({
    title: t('folder.new.title'),
    placeholder: t('folder.new.placeholder'),
    confirmLabel: t('folder.new.confirm'),
  })
  if (!name) return
  await treeStore.createFolder({ name, parentId: null })
}

async function onImportFiles(files: File[]) {
  if (!current.value) return
  await importFiles(files, {
    workspaceId: current.value.id,
    parentFolderId: null,
  })
}

async function onLogout() {
  await logout()
  await navigateTo('/login')
}

/* ---------- Drag & drop: doc rows + root drop zone ---------- */

function onDocDragStart(e: DragEvent, docId: number) {
  if (!e.dataTransfer) return
  e.dataTransfer.setData('text/x-noteforge-doc', String(docId))
  e.dataTransfer.effectAllowed = 'move'
  dragStore.startDocDrag(docId, null)
}

function onDocDragEnd() {
  dragStore.end()
}

function onRootDragOver(e: DragEvent) {
  if (dragging.value == null) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  // Only the existing "drop into root" highlight is wired here. Per-row
  // reorder indicators are set by the rows' own dragover handlers.
  if (dragging.value.kind === 'doc') {
    dragStore.setOver('root')
  }
  else if (dragging.value.kind === 'folder') {
    // Highlight root iff the move is meaningful (folder not already at root).
    if (dragStore.canDropFolderInto('root', dragging.value.id)) {
      dragStore.setOverFolder('root')
    }
    else {
      dragStore.clearOver('root')
    }
  }
}

function onRootDragLeave(e: DragEvent) {
  // Only clear if leaving the container, not entering a child.
  const target = e.currentTarget as HTMLElement
  const related = e.relatedTarget as Node | null
  if (related && target.contains(related)) return
  dragStore.clearOver('root')
}

async function onRootDrop(e: DragEvent) {
  e.preventDefault()
  const drag = dragging.value
  const insert = insertBefore.value
  const atEnd = insertAtEndOf.value
  dragStore.end()

  if (drag == null) return

  // --- Folder drag ---
  if (drag.kind === 'folder') {
    // Reorder among root-level folder siblings (only when both source and
    // sibling-insert target are at root).
    if (
      insert
      && insert.kind === 'folder'
      && insert.scope === 'root'
      && drag.scope === 'root'
    ) {
      const peers = treeStore.folders
        .filter(f => (f.parentId ?? null) === null)
        .sort((a, b) => a.position - b.position || a.id - b.id)
      const pos = computeReorderPosition(peers, drag.id, insert.id)
      try { await treeStore.reorderFolder(drag.id, pos) }
      catch (err) {
        await dialog.alert({
          title: t('folder.reorder.failed'),
          message: (err as Error).message || t('folder.reorder.failedMsg'),
        })
      }
      return
    }

    // Cross-parent move to workspace root (folder was inside another folder).
    // Skip when the dragged folder is already at root (no-op).
    if (drag.scope !== 'root' && dragStore.canDropFolderInto('root', drag.id)) {
      try { await treeStore.moveFolder(drag.id, null) }
      catch (err) {
        await dialog.alert({
          title: t('folder.move.failed'),
          message: (err as Error).message || t('folder.move.failedMsg'),
        })
      }
    }
    return
  }

  // --- Doc drag ---
  if (drag.kind === 'doc') {
    const docId = drag.id

    // Cross-scope (from a folder into root): MOVE only, no position.
    if (drag.scopeId !== null) {
      try { await treeStore.moveDocument(docId, null) }
      catch (err) {
        await dialog.alert({
          title: t('doc.move.failed'),
          message: (err as Error).message || t('doc.move.failedMsg'),
        })
      }
      return
    }

    // Same scope (root) — reorder among root docs.
    const peers = treeStore.documents
      .filter(d => (d.folderId ?? null) === null)
      .sort((a, b) => a.position - b.position || a.id - b.id)

    let insertBeforeId: number | null = null
    if (insert && insert.kind === 'doc' && insert.scope === 'root') insertBeforeId = insert.id
    else if (atEnd && atEnd.scope === 'root') insertBeforeId = null
    else {
      // Dropped on the tree background with no per-row indicator — treat
      // as append to end of root.
      insertBeforeId = null
    }

    const pos = computeReorderPosition(peers, docId, insertBeforeId)
    try { await treeStore.reorderDoc(docId, pos) }
    catch (err) {
      await dialog.alert({
        title: t('doc.reorder.failed'),
        message: (err as Error).message || t('doc.reorder.failedMsg'),
      })
    }
  }
}

/* Per-row doc dragover/drop for root-level docs. */
function onRootDocDragOver(e: DragEvent, docId: number) {
  if (dragging.value == null) return
  if (dragging.value.kind === 'folder') return
  if (dragging.value.id === docId) return
  e.preventDefault()
  e.stopPropagation()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'

  const row = e.currentTarget as HTMLElement
  const rect = row.getBoundingClientRect()
  const y = e.clientY - rect.top
  const h = rect.height
  const targetScope: DragScope = 'root'

  if (y < h / 2) {
    dragStore.setInsertBefore({ kind: 'doc', id: docId, scope: targetScope, scopeId: null })
  }
  else {
    const peers = treeStore.tree.rootDocuments
    const idx = peers.findIndex(d => d.id === docId)
    const next = idx >= 0 ? peers[idx + 1] : undefined
    if (next) {
      dragStore.setInsertBefore({ kind: 'doc', id: next.id, scope: targetScope, scopeId: null })
    }
    else {
      dragStore.setInsertAtEnd('root', null)
    }
  }
}

async function onRootDocDrop(e: DragEvent) {
  // Delegate to the root drop handler — same logic.
  await onRootDrop(e)
}

/* Folder reorder at root: folder rows handle their own dragover (top/bottom
   bands). We additionally need the root container's dragover to clear the
   insert indicator when the cursor sits in empty space below the last
   sibling — that's handled by the existing onRootDragOver clearing /
   end-of-list logic. */
</script>

<template>
  <aside
    class="sidebar"
    :class="{ 'sidebar--collapsed': collapsed }"
    aria-label="Workspace navigation"
  >
    <!-- Top: wordmark + collapse / mobile close -->
    <header class="sidebar-header">
      <NuxtLink to="/" class="wordmark">
        <span class="wordmark-name">NoteForge</span>
        <span class="wordmark-dot" aria-hidden="true" />
      </NuxtLink>
      <!-- Desktop collapse toggle (>= md only) -->
      <button
        type="button"
        class="icon-btn sidebar-collapse-desktop hidden md:inline-flex"
        :title="collapsed ? t('sidebar.expand') : t('sidebar.collapse')"
        @click="emit('toggle')"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            :d="collapsed ? 'M6 4l4 4-4 4' : 'M10 4l-4 4 4 4'"
            fill="none"
            stroke="currentColor"
            stroke-width="1.25"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <!-- Mobile close (X) — slides the drawer out. < md only. -->
      <button
        type="button"
        class="icon-btn sidebar-close-mobile md:hidden"
        :title="t('sidebar.close')"
        :aria-label="t('sidebar.close')"
        @click="emit('close-mobile')"
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path
            d="M4 4l8 8 M12 4l-8 8"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </header>

    <div v-if="!collapsed" class="sidebar-body">
      <!-- Workspace switcher -->
      <section class="block">
        <div class="block-header">
          <span class="block-label">{{ t('sidebar.workspace') }}</span>
          <button
            v-if="current"
            type="button"
            class="icon-btn share-btn"
            :class="{ 'share-btn--shared': current.shared, 'share-btn--guest': current.role !== 'owner' }"
            :title="current.role === 'owner' ? 'Partager le workspace' : 'Voir les membres'"
            @click="shareOpen = true"
          >
            <!-- Two-people glyph — share affordance. -->
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <circle cx="5.5" cy="6" r="2" fill="none" stroke="currentColor" stroke-width="1.2" />
              <path d="M1.5 13.5c0-2.2 1.8-3.5 4-3.5s4 1.3 4 3.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              <circle cx="11" cy="5.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.2" />
              <path d="M14.5 12.5c0-1.6-1.4-2.7-3.5-2.7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
        </div>
        <WorkspaceSwitcher
          :workspaces="workspaces"
          :current="current"
          @select="onSelectWorkspace"
          @create="onCreateWorkspace"
          @rename="onRenameWorkspace"
          @delete="onDeleteWorkspace"
        />
      </section>

      <!-- Pinned / favorited docs -->
      <section v-if="current && favoriteEntries.length > 0" class="block block--pinned">
        <div class="block-label">{{ t('sidebar.pinned') }}</div>
        <div class="pinned-list">
          <NuxtLink
            v-for="fav in favoriteEntries"
            :key="`fav-${fav.docId}`"
            :to="`/w/${current.id}/d/${fav.docId}`"
            class="doc-row pinned-row"
            active-class="doc-row--active"
          >
            <svg
              class="pinned-star"
              viewBox="0 0 16 16"
              width="11"
              height="11"
              aria-hidden="true"
              fill="currentColor"
            >
              <path
                d="M8 1.8l1.85 3.96 4.35.55-3.2 2.99.83 4.3L8 11.6 4.17 13.6l.83-4.3-3.2-2.99 4.35-.55L8 1.8z"
              />
            </svg>
            <span class="doc-title">{{ fav.title || t('sidebar.untitled') }}</span>
          </NuxtLink>
        </div>
      </section>

      <!-- Quick links: search / graph -->
      <section v-if="current" class="block block--links">
        <NuxtLink
          :to="`/w/${current.id}/search`"
          class="nav-link"
          active-class="nav-link--active"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.25" />
            <path d="M10.5 10.5L13.5 13.5" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
          </svg>
          <span>{{ L.searchLink }}</span>
        </NuxtLink>

        <NuxtLink
          :to="`/w/${current.id}/graph`"
          class="nav-link"
          active-class="nav-link--active"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <circle cx="3.5" cy="4" r="1.5" fill="none" stroke="currentColor" stroke-width="1.25" />
            <circle cx="12.5" cy="4" r="1.5" fill="none" stroke="currentColor" stroke-width="1.25" />
            <circle cx="8" cy="12" r="1.5" fill="none" stroke="currentColor" stroke-width="1.25" />
            <path d="M5 4.7L7 11.3 M11 4.7L9 11.3 M5 4h6" fill="none" stroke="currentColor" stroke-width="1" />
          </svg>
          <span>{{ L.graphLink }}</span>
        </NuxtLink>
      </section>

      <!-- Saved searches -->
      <section v-if="current && savedSearches.length > 0" class="block block--saved">
        <button type="button" class="block-toggle" @click="savedSearchesStore.toggleExpanded">
          <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
            <path
              :d="savedExpanded ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'"
              fill="none"
              stroke="currentColor"
              stroke-width="1.25"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span class="block-label">{{ L.savedSearches }}</span>
        </button>
        <div v-if="savedExpanded" class="saved-list">
          <div
            v-for="s in savedSearches"
            :key="`saved-${s.id}`"
            class="saved-row"
            :title="s.name"
            @click="onApplySavedSearch(s)"
          >
            <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
              <path
                d="M4 2h6l3 3v9H4z M9 11h-2"
                fill="none"
                stroke="currentColor"
                stroke-width="1.1"
                stroke-linejoin="round"
              />
            </svg>
            <span class="saved-name">{{ s.name }}</span>
            <button
              type="button"
              class="saved-action"
              :title="L.renameSaved"
              @click.stop="onRenameSaved(s, $event)"
            >
              <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
                <path d="M3 13L13 3 M10 3h3v3" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" />
              </svg>
            </button>
            <button
              type="button"
              class="saved-action saved-action--danger"
              :title="L.deleteSaved"
              @click.stop="onDeleteSaved(s, $event)"
            >
              <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
                <path d="M4 4l8 8 M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
              </svg>
            </button>
          </div>
        </div>
      </section>

      <!-- File tree -->
      <section class="block block--grow">
        <div class="block-header">
          <span class="block-label">{{ t('sidebar.outline') }}</span>
          <div class="block-header-actions">
            <button
              v-if="current"
              type="button"
              class="icon-btn"
              :class="{ 'icon-btn--active': bulkSelect.isActive }"
              :title="bulkSelect.isActive ? L.bulkOff : L.bulkOn"
              :aria-pressed="bulkSelect.isActive"
              @click="onToggleBulk"
            >
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.1" />
                <path v-if="bulkSelect.isActive" d="M4.5 8l2 2 4-4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
            <NewItemMenu
              v-if="current"
              @new-document="onCreateRootDocument"
              @new-folder="onCreateRootFolder"
              @import-files="onImportFiles"
            />
          </div>
        </div>

        <div v-if="!current" class="empty-note">
          <p>{{ t('sidebar.noWorkspace') }}</p>
          <button class="ghost-btn" @click="onCreateWorkspace">{{ t('sidebar.newWorkspace') }}</button>
        </div>

        <div v-else-if="treeLoading && tree.folders.length === 0 && tree.rootDocuments.length === 0" class="empty-note">
          <p>{{ t('sidebar.loadingOutline') }}</p>
        </div>

        <div
          v-else
          class="tree"
          :class="{ 'tree--drop-target': overTarget === 'root' }"
          @dragover="onRootDragOver"
          @dragleave="onRootDragLeave"
          @drop="onRootDrop"
        >
          <FolderTreeNode
            v-for="folder in tree.folders"
            :key="`f-${folder.id}`"
            :folder="folder"
            :depth="0"
            :workspace-id="current.id"
          />
          <NuxtLink
            v-for="doc in tree.rootDocuments"
            :key="`d-${doc.id}`"
            :to="`/w/${current.id}/d/${doc.id}`"
            class="doc-row"
            :class="{
              'doc-row--dragging': draggedDocId === doc.id,
              'doc-row--insert-before':
                insertBefore !== null
                && insertBefore.kind === 'doc'
                && insertBefore.id === doc.id,
              'doc-row--bulk-selected': bulkSelect.isActive && bulkSelect.isDocSelected(doc.id),
              'doc-row--bulk-mode': bulkSelect.isActive,
            }"
            active-class="doc-row--active"
            :draggable="!bulkSelect.isActive"
            @dragstart="bulkSelect.isActive ? null : onDocDragStart($event, doc.id)"
            @dragend="bulkSelect.isActive ? null : onDocDragEnd()"
            @dragover="bulkSelect.isActive ? null : onRootDocDragOver($event, doc.id)"
            @drop="bulkSelect.isActive ? null : onRootDocDrop($event)"
            @click="bulkSelect.isActive ? (($event.preventDefault(), bulkSelect.toggleDoc(doc.id))) : null"
          >
            <input
              v-if="bulkSelect.isActive"
              type="checkbox"
              class="bulk-checkbox"
              :checked="bulkSelect.isDocSelected(doc.id)"
              @click.stop
              @change="bulkSelect.toggleDoc(doc.id)"
            >
            <span v-else class="doc-leaf" aria-hidden="true" />
            <span class="doc-title">{{ doc.title || t('sidebar.untitled') }}</span>
          </NuxtLink>

          <div
            v-if="insertAtEndOf !== null && insertAtEndOf.scope === 'root'"
            class="insert-line insert-line--end"
          />

          <div
            v-if="tree.folders.length === 0 && tree.rootDocuments.length === 0"
            class="empty-note"
          >
            <p>{{ t('sidebar.emptyWorkspace') }}</p>
            <button class="ghost-btn" @click="onCreateRootDocument">{{ t('sidebar.newDocument') }}</button>
          </div>
        </div>
      </section>
    </div>

    <!-- Window-wide markdown import dropzone (renders nothing until a drag enters). -->
    <ImportDropzone v-if="current" />

    <!-- Busy overlay while file-picker import (button) runs. -->
    <Teleport to="body">
      <div v-if="importBusy" class="dropzone-overlay dropzone-overlay--busy">
        <div class="dropzone-card">
          <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
            <path
              d="M12 3v12 M7 10l5 5 5-5 M4 18h16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <p class="dropzone-msg">{{ t('import.importing') }}</p>
          <p class="dropzone-hint">{{ t('import.ocrHint') }}</p>
        </div>
      </div>
    </Teleport>

    <!-- Bulk selection sticky action bar -->
    <div v-if="bulkSelect.isActive && !collapsed" class="bulk-bar">
      <div class="bulk-bar-header">
        <span class="bulk-count">{{ L.bulkSelected(bulkSelect.docCount) }}</span>
        <button type="button" class="icon-btn" :title="L.bulkOff" @click="bulkSelect.exit()">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M4 4l8 8 M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      <div class="bulk-actions">
        <button type="button" class="bulk-btn" :disabled="bulkSelect.docCount === 0" @click="onBulkMove">{{ L.bulkMove }}</button>
        <button type="button" class="bulk-btn" :disabled="bulkSelect.docCount === 0" @click="onBulkTagAdd">{{ L.bulkTag }}</button>
        <button type="button" class="bulk-btn" :disabled="bulkSelect.docCount === 0" @click="onBulkTagRemove">{{ L.bulkUntag }}</button>
        <button type="button" class="bulk-btn" :disabled="bulkSelect.docCount === 0" @click="onBulkAnalyze">{{ L.bulkAnalyze }}</button>
        <button type="button" class="bulk-btn" :disabled="bulkSelect.docCount === 0" @click="onBulkExport">{{ L.bulkExport }}</button>
        <button type="button" class="bulk-btn bulk-btn--danger" :disabled="bulkSelect.docCount === 0" @click="onBulkTrash">{{ L.bulkTrash }}</button>
      </div>
    </div>

    <!-- Daily-notes calendar (just above trash, per UX brief). -->
    <DailyNotesCalendar v-if="current && !collapsed && !bulkSelect.isActive" :workspace-id="current.id" />

    <!-- Footer: user -->
    <footer v-if="!collapsed" class="sidebar-footer">
      <NuxtLink
        v-if="current"
        :to="`/w/${current.id}/tags`"
        class="trash-link"
        active-class="trash-link--active"
        :title="t('tags.sidebar')"
      >
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path
            d="M2 7.5V3a1 1 0 0 1 1-1h4.5L14 8.5l-5.5 5.5L2 7.5z M5 5.5a0.75 0.75 0 1 1 0-1.5 0.75 0.75 0 0 1 0 1.5z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.25"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span>{{ t('tags.sidebar') }}</span>
      </NuxtLink>

      <NuxtLink
        v-if="current"
        :to="`/w/${current.id}/trash`"
        class="trash-link"
        active-class="trash-link--active"
        :title="t('sidebar.trash')"
      >
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path
            d="M3 4h10 M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1 M4 4l1 9a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l1-9 M7 7v4 M9 7v4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.25"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span>{{ t('sidebar.trash') }}</span>
      </NuxtLink>

      <NuxtLink
        v-if="isAdmin"
        to="/admin"
        class="trash-link"
        active-class="trash-link--active"
        title="Panneau d'administration"
      >
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path
            d="M2 3h12v2H2z M2 7h12v2H2z M2 11h7v2H2z M12 10l2 2-2 2"
            fill="none"
            stroke="currentColor"
            stroke-width="1.25"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span>Admin</span>
      </NuxtLink>

      <div class="user-row" :title="userEmail">
        <span class="avatar">{{ initials }}</span>
        <span class="user-name">{{ displayName }}</span>
        <button
          class="icon-btn"
          :title="t('mcp.openTitle')"
          :aria-label="t('mcp.openTitle')"
          @click="mcpOpen = true"
        >
          <!-- Plug glyph — MCP "install" affordance. -->
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path
              d="M6 1v3 M10 1v3 M4 4h8v3a4 4 0 0 1-4 4 4 4 0 0 1-4-4V4z M8 11v4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.25"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <NuxtLink to="/settings" class="icon-btn" :title="t('settings.title')" :aria-label="t('settings.title')">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path
              d="M8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 0 0 8 5.5z M13.5 8a5.5 5.5 0 0 0-.09-.97l1.27-.95-1.27-2.2-1.49.6a5.5 5.5 0 0 0-1.68-.97L9.97 2H6.03l-.27 1.51a5.5 5.5 0 0 0-1.68.97l-1.49-.6L1.32 6.08l1.27.95A5.6 5.6 0 0 0 2.5 8c0 .33.03.66.09.97l-1.27.95 1.27 2.2 1.49-.6c.5.4 1.06.74 1.68.97L6.03 14h3.94l.27-1.51c.62-.23 1.18-.57 1.68-.97l1.49.6 1.27-2.2-1.27-.95c.06-.31.09-.64.09-.97z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.1"
              stroke-linejoin="round"
            />
          </svg>
        </NuxtLink>
        <LangToggle />
        <ThemeToggle />
        <button class="icon-btn" :title="t('sidebar.signOut')" @click="onLogout">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path
              d="M9 3h3v10H9 M6 5l-3 3 3 3 M3 8h7"
              fill="none"
              stroke="currentColor"
              stroke-width="1.25"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
    </footer>

    <McpTokensDialog :is-open="mcpOpen" @close="mcpOpen = false" />
    <ShareWorkspaceDialog
      :is-open="shareOpen"
      :workspace-id="current?.id ?? null"
      :workspace-name="current?.name ?? ''"
      :is-owner="current?.role === 'owner'"
      @close="shareOpen = false"
    />
  </aside>
</template>

<style scoped>
.sidebar {
  @apply relative flex flex-col h-full shrink-0;
  width: 300px;
  background: theme('colors.ink.50');
  border-right: 1px solid theme('colors.ink.200' / 60%);
  transition: width 180ms ease, background-color 180ms ease, border-color 180ms ease;
}
html.dark .sidebar {
  background: theme('colors.ink.900');
  border-right-color: theme('colors.ink.800' / 60%);
}
/* Collapsed = fully retracted so the main content reclaims the full width.
   The expand affordance becomes a floating button in the layout (top-left),
   so we don't keep a 56px stub here. Width animates for a smooth slide. */
.sidebar--collapsed {
  width: 0;
  border-right-width: 0;
  overflow: hidden;
  pointer-events: none;
}

.sidebar-header {
  @apply flex items-center justify-between px-4 pt-4 pb-3;
  border-bottom: 1px solid theme('colors.ink.200' / 50%);
}
html.dark .sidebar-header {
  border-bottom-color: theme('colors.ink.800' / 60%);
}
.wordmark {
  @apply inline-flex items-baseline gap-1.5 text-ink-900 dark:text-ink-100;
}
.wordmark-name {
  @apply font-serif text-[0.98rem] tracking-tight;
}
.wordmark-dot {
  @apply inline-block h-1.5 w-1.5 rounded-full bg-accent-500;
  transform: translateY(-1px);
}

.sidebar-body {
  @apply flex-1 min-h-0 flex flex-col;
}

.block {
  @apply px-3 pt-4 pb-2;
}
.block--grow {
  @apply flex-1 min-h-0 flex flex-col;
}
.block-header {
  @apply flex items-center justify-between pr-1 mb-2;
}
.block-label {
  @apply label-mono px-1.5 mb-2;
}
.block-header .block-label {
  @apply mb-0;
}

.block--pinned {
  @apply pt-3 pb-1;
}
.pinned-list {
  @apply flex flex-col;
}
.pinned-row {
  @apply gap-2;
}
.pinned-star {
  @apply shrink-0 text-accent-500 dark:text-accent-400;
}

.tree {
  @apply flex-1 min-h-0 overflow-auto pb-2 rounded;
  transition: background 120ms ease, box-shadow 120ms ease;
}
.tree--drop-target {
  background: theme('colors.accent.50' / 70%);
  box-shadow: inset 0 0 0 1px theme('colors.accent.300');
}
html.dark .tree--drop-target {
  background: theme('colors.accent.900' / 30%);
  box-shadow: inset 0 0 0 1px theme('colors.accent.700');
}

.doc-row {
  @apply relative flex items-center gap-2 px-2 h-7 rounded text-[13px] text-ink-700 dark:text-ink-300 truncate;
  transition: background 120ms ease, color 120ms ease, opacity 120ms ease;
}
.doc-row--dragging { opacity: 0.4; }
.doc-row--insert-before::before {
  content: '';
  position: absolute;
  left: 4px;
  right: 4px;
  top: -1px;
  height: 2px;
  background: theme('colors.accent.500');
  border-radius: 1px;
  pointer-events: none;
  z-index: 2;
}
.insert-line {
  height: 2px;
  margin: 0 6px;
  background: theme('colors.accent.500');
  border-radius: 1px;
  pointer-events: none;
}
.insert-line--end { margin-top: 1px; }
.doc-row:hover {
  background: theme('colors.ink.100' / 70%);
  color: theme('colors.ink.900');
}
html.dark .doc-row:hover {
  background: theme('colors.ink.800' / 60%);
  color: theme('colors.ink.100');
}
.doc-row--active {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
  box-shadow: inset 2px 0 0 theme('colors.accent.500');
}
html.dark .doc-row--active {
  background: theme('colors.ink.800');
  color: theme('colors.ink.100');
}
.doc-leaf {
  @apply inline-block h-[3px] w-[3px] rounded-full bg-ink-300 dark:bg-ink-600 shrink-0;
}
.doc-title {
  @apply truncate;
}

.empty-note {
  @apply px-3 py-4 text-[12px] text-ink-500 dark:text-ink-400 leading-snug;
}
.ghost-btn {
  @apply mt-2 font-sans uppercase text-[11px] font-semibold tracking-[0.08em] text-ink-600 dark:text-ink-300 px-2 py-1 rounded;
  border: 1px solid theme('colors.ink.200');
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
html.dark .ghost-btn {
  border-color: theme('colors.ink.800');
}
.ghost-btn:hover {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
  border-color: theme('colors.ink.300');
}
html.dark .ghost-btn:hover {
  background: theme('colors.ink.800');
  color: theme('colors.ink.100');
  border-color: theme('colors.ink.700');
}

.icon-btn {
  @apply inline-flex items-center justify-center h-6 w-6 rounded text-ink-500 dark:text-ink-400;
  transition: background 120ms ease, color 120ms ease;
}
/* Mobile close button — bumped to 36px tap target (F10).
   `md:hidden` in the template is shadowed by `.icon-btn { @apply inline-flex }`
   because scoped <style> is injected after Tailwind's utilities layer. Enforce
   the hide above the md breakpoint in scoped CSS itself. */
.sidebar-close-mobile {
  @apply h-9 w-9;
}
@media (min-width: 768px) {
  .sidebar-close-mobile { display: none; }
}
/* Mirror of the above for the desktop collapse toggle: the `hidden` utility is
   shadowed by `.icon-btn { @apply inline-flex }` (scoped specificity wins), so
   the collapse arrow leaked onto mobile. Enforce the <md hide in scoped CSS. */
@media (max-width: 767px) {
  .sidebar-collapse-desktop { display: none; }
}
.icon-btn:hover {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
}
html.dark .icon-btn:hover {
  background: theme('colors.ink.800');
  color: theme('colors.ink.50');
}

.sidebar-footer {
  @apply px-3 py-3;
  border-top: 1px solid theme('colors.ink.200' / 50%);
}
html.dark .sidebar-footer {
  border-top-color: theme('colors.ink.800' / 60%);
}
.user-row {
  @apply flex items-center gap-2 px-1.5 py-1.5 rounded;
}
.user-row:hover {
  background: theme('colors.ink.100' / 70%);
}
html.dark .user-row:hover {
  background: theme('colors.ink.800' / 60%);
}
.avatar {
  @apply inline-flex items-center justify-center h-6 w-6 shrink-0 rounded-full font-sans font-semibold text-[11px] text-ink-700 dark:text-ink-200;
  background: theme('colors.ink.200' / 70%);
}
html.dark .avatar {
  background: theme('colors.ink.800' / 80%);
}
.user-name {
  @apply flex-1 min-w-0 truncate text-[12.5px] text-ink-800 dark:text-ink-200;
}

.trash-link {
  @apply flex items-center gap-2 px-2 py-1.5 mb-2 rounded text-[12.5px] text-ink-600 dark:text-ink-300;
  transition: background 120ms ease, color 120ms ease;
}
.trash-link:hover {
  background: theme('colors.ink.100' / 70%);
  color: theme('colors.ink.900');
}
html.dark .trash-link:hover {
  background: theme('colors.ink.800' / 60%);
  color: theme('colors.ink.100');
}
.trash-link--active {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
}
html.dark .trash-link--active {
  background: theme('colors.ink.800');
  color: theme('colors.ink.100');
}

/* ---------- Nav links (search / graph) ---------- */
.block--links {
  @apply pt-2 pb-1;
}
.nav-link {
  @apply flex items-center gap-2 px-2 py-1.5 rounded text-[12.5px] text-ink-700 dark:text-ink-300;
  transition: background 120ms ease, color 120ms ease;
}
.nav-link:hover {
  background: theme('colors.ink.100' / 70%);
  color: theme('colors.ink.900');
}
html.dark .nav-link:hover {
  background: theme('colors.ink.800' / 60%);
  color: theme('colors.ink.100');
}
.nav-link--active {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
  box-shadow: inset 2px 0 0 theme('colors.accent.500');
}
html.dark .nav-link--active {
  background: theme('colors.ink.800');
  color: theme('colors.ink.100');
}

/* ---------- Saved searches ---------- */
.block--saved {
  @apply pt-3 pb-1;
}
.block-toggle {
  @apply w-full flex items-center gap-1.5 px-1.5 mb-2 text-ink-500 dark:text-ink-400;
}
.block-toggle:hover { color: theme('colors.ink.800'); }
html.dark .block-toggle:hover { color: theme('colors.ink.100'); }
.saved-list {
  @apply flex flex-col;
}
.saved-row {
  @apply flex items-center gap-2 px-2 h-7 rounded text-[12.5px] text-ink-700 dark:text-ink-300 cursor-pointer;
  transition: background 120ms ease, color 120ms ease;
}
.saved-row:hover {
  background: theme('colors.ink.100' / 70%);
  color: theme('colors.ink.900');
}
html.dark .saved-row:hover {
  background: theme('colors.ink.800' / 60%);
  color: theme('colors.ink.100');
}
.saved-row svg { @apply shrink-0 text-ink-400 dark:text-ink-500; }
.saved-name { @apply flex-1 min-w-0 truncate; }
.saved-action {
  @apply inline-flex items-center justify-center h-5 w-5 rounded text-ink-400 dark:text-ink-500 opacity-0;
  transition: background 120ms ease, color 120ms ease, opacity 120ms ease;
}
.saved-row:hover .saved-action { @apply opacity-100; }
.saved-action:hover {
  background: theme('colors.ink.200' / 70%);
  color: theme('colors.ink.900');
}
html.dark .saved-action:hover {
  background: theme('colors.ink.700' / 70%);
  color: theme('colors.ink.50');
}
.saved-action--danger:hover { color: theme('colors.accent.700'); }
html.dark .saved-action--danger:hover { color: theme('colors.accent.300'); }

/* ---------- Bulk mode ---------- */
.block-header-actions {
  @apply flex items-center gap-1;
}
.icon-btn--active {
  background: theme('colors.accent.500');
  color: white;
}
.icon-btn--active:hover {
  background: theme('colors.accent.600');
  color: white;
}

/* Workspace share button — accent dot when the workspace already has
   members, dimmer styling for read-only members. */
.share-btn--shared {
  position: relative;
}
.share-btn--shared::after {
  content: '';
  position: absolute;
  top: 3px;
  right: 3px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: theme('colors.accent.500');
  border: 1px solid theme('colors.ink.50');
}
html.dark .share-btn--shared::after {
  border-color: theme('colors.ink.900');
}
.share-btn--guest {
  opacity: 0.7;
}
.bulk-checkbox {
  @apply h-3.5 w-3.5 shrink-0 accent-accent-500 cursor-pointer;
  margin: 0;
}
.doc-row--bulk-mode {
  cursor: pointer;
}
.doc-row--bulk-mode .doc-leaf { display: none; }
.doc-row--bulk-selected {
  background: theme('colors.accent.50');
  color: theme('colors.accent.900');
}
html.dark .doc-row--bulk-selected {
  background: theme('colors.accent.900' / 30%);
  color: theme('colors.accent.100');
}

.bulk-bar {
  @apply px-3 py-3 mx-3 mb-2 rounded;
  background: theme('colors.accent.50');
  border: 1px solid theme('colors.accent.200');
}
html.dark .bulk-bar {
  background: theme('colors.accent.900' / 40%);
  border-color: theme('colors.accent.800');
}
.bulk-bar-header {
  @apply flex items-center justify-between mb-2;
}
.bulk-count {
  @apply font-sans uppercase text-[11px] font-semibold tracking-[0.08em] text-accent-800 dark:text-accent-200 tabular-nums;
}
.bulk-actions {
  @apply flex flex-wrap gap-1.5;
}
.bulk-btn {
  @apply font-sans text-[11px] uppercase font-semibold tracking-[0.06em] px-2 py-1 rounded text-ink-800 dark:text-ink-100;
  background: theme('colors.ink.50');
  border: 1px solid theme('colors.ink.200');
  transition: background 100ms ease, color 100ms ease, border-color 100ms ease;
}
html.dark .bulk-btn {
  background: theme('colors.ink.900');
  border-color: theme('colors.ink.700');
}
.bulk-btn:hover {
  background: theme('colors.accent.100');
  border-color: theme('colors.accent.400');
}
html.dark .bulk-btn:hover {
  background: theme('colors.accent.900');
  border-color: theme('colors.accent.600');
}
.bulk-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.bulk-btn--danger { color: theme('colors.accent.700'); }
html.dark .bulk-btn--danger { color: theme('colors.accent.300'); }
.bulk-btn--danger:hover {
  background: theme('colors.accent.500');
  color: white;
}

/* Import-button busy overlay (mirrors ImportDropzone visuals). */
.dropzone-overlay {
  @apply fixed inset-0 z-50 flex items-center justify-center;
  background: theme('colors.ink.900' / 35%);
  backdrop-filter: blur(4px);
  pointer-events: none;
}
html.dark .dropzone-overlay {
  background: theme('colors.ink.950' / 55%);
}
.dropzone-overlay--busy {
  pointer-events: auto;
}
.dropzone-card {
  @apply flex flex-col items-center gap-2 px-8 py-6 rounded-lg text-ink-900 dark:text-ink-100;
  background: theme('colors.ink.50');
  border: 2px dashed theme('colors.accent.500');
  box-shadow: 0 10px 30px theme('colors.ink.900' / 25%);
}
html.dark .dropzone-card {
  background: theme('colors.ink.900');
  border-color: theme('colors.accent.400');
}
.dropzone-msg {
  @apply font-serif text-[18px] mt-1;
}
.dropzone-hint {
  @apply font-sans text-[11.5px] uppercase tracking-[0.1em] text-ink-500 dark:text-ink-400;
}
</style>
