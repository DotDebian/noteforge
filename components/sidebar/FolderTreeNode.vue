<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue'
import { storeToRefs } from 'pinia'
import { useTreeStore, type FolderNode } from '~/stores/tree'
import { useDragStore, type DragScope } from '~/stores/drag'
import { useBulkSelectStore } from '~/stores/bulkSelect'
import { useDialog } from '~/composables/useDialog'
import { useLocale } from '~/composables/useLocale'
import { computeReorderPosition } from '~/composables/useReorder'

const { t } = useLocale()

const props = defineProps<{
  folder: FolderNode
  depth: number
  workspaceId: number
}>()

const treeStore = useTreeStore()
const dragStore = useDragStore()
const bulkSelect = useBulkSelectStore()
const dialog = useDialog()
const { expanded, documents: allDocs, folders: allFolders } = storeToRefs(treeStore)
const { draggedDocId, overTarget, dragging, insertBefore, insertAtEndOf } = storeToRefs(dragStore)

const isDropTarget = computed(() => overTarget.value === props.folder.id)

const isOpen = computed(() => expanded.value[props.folder.id] ?? false)

const indent = computed(() => 8 + props.depth * 14)

/**
 * Is a folder currently being dragged, AND this row represents either
 * that folder itself OR one of its descendants? Such rows are invalid
 * drop targets — we render them dimmed with a "no drop" cursor.
 */
const isInvalidFolderDropTarget = computed(() => {
  const d = dragging.value
  if (d == null || d.kind !== 'folder') return false
  if (d.id === props.folder.id) return true
  return treeStore.isDescendantFolder(d.id, props.folder.id)
})

// The folder ITSELF participates in its parent's scope (its siblings = all
// folders sharing the same parentId).
const parentScope = computed<{ scope: DragScope, scopeId: number | null }>(() => ({
  scope: props.folder.parentId == null ? 'root' : 'folder',
  scopeId: props.folder.parentId ?? null,
}))

// Show insert-before indicator above this folder row when it matches.
const showInsertBeforeFolder = computed(() =>
  insertBefore.value !== null
  && insertBefore.value.kind === 'folder'
  && insertBefore.value.id === props.folder.id,
)

// Show end-of-children indicator at the bottom of this folder's open children.
const showInsertAtEndHere = computed(() =>
  insertAtEndOf.value !== null
  && insertAtEndOf.value.scope === 'folder'
  && insertAtEndOf.value.scopeId === props.folder.id,
)

const menuOpen = ref(false)
const menuEl = ref<HTMLElement | null>(null)
// When the menu is opened via right-click we pin it at the cursor;
// otherwise it anchors to the row's "⋯" button as before.
const ctxPos = ref<{ x: number, y: number } | null>(null)
const menuStyle = computed<Record<string, string> | undefined>(() => {
  if (!ctxPos.value) return undefined
  return {
    position: 'fixed',
    left: `${ctxPos.value.x}px`,
    top: `${ctxPos.value.y}px`,
    right: 'auto',
  }
})
function toggleMenu(e: Event) {
  e.stopPropagation()
  ctxPos.value = null
  menuOpen.value = !menuOpen.value
}
function closeMenu() {
  menuOpen.value = false
  ctxPos.value = null
}
function onRowContextMenu(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  ctxPos.value = { x: e.clientX, y: e.clientY }
  menuOpen.value = true
}

function onDocumentClick(e: MouseEvent) {
  if (!menuOpen.value || !menuEl.value) return
  if (!menuEl.value.contains(e.target as Node)) closeMenu()
}
if (typeof window !== 'undefined') {
  document.addEventListener('click', onDocumentClick, true)
  onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick, true))
}

function toggle() {
  treeStore.toggleExpanded(props.folder.id)
}

async function onNewDoc() {
  closeMenu()
  const doc = await treeStore.createDocument({ folderId: props.folder.id })
  treeStore.expand(props.folder.id)
  await navigateTo(`/w/${props.workspaceId}/d/${doc.id}`)
}

async function onNewSubfolder() {
  closeMenu()
  const name = await dialog.prompt({
    title: t('folder.newSub.title'),
    message: t('folder.newSub.inside', { name: props.folder.name }),
    placeholder: t('folder.new.placeholder'),
    confirmLabel: t('folder.new.confirm'),
  })
  if (!name) return
  await treeStore.createFolder({ name, parentId: props.folder.id })
  treeStore.expand(props.folder.id)
}

async function onRename() {
  closeMenu()
  const name = await dialog.prompt({
    title: t('folder.rename.title'),
    defaultValue: props.folder.name,
    placeholder: t('folder.new.placeholder'),
    confirmLabel: t('sidebar.rename'),
  })
  if (!name || name === props.folder.name) return
  await treeStore.renameFolder(props.folder.id, name)
}

async function onDelete() {
  closeMenu()
  const ok = await dialog.confirm({
    title: t('folder.delete.title', { name: props.folder.name }),
    message: t('folder.delete.message'),
    confirmLabel: t('folder.delete.confirm'),
    destructive: true,
  })
  if (!ok) return
  await treeStore.deleteFolder(props.folder.id)
}

async function onDeleteDoc(docId: number, title: string) {
  const ok = await dialog.confirm({
    title: t('doc.delete.title', { name: title || t('doc.untitled') }),
    message: t('doc.delete.message'),
    confirmLabel: t('doc.delete.confirm'),
    destructive: true,
  })
  if (!ok) return
  await treeStore.deleteDocument(docId)
}

/* ---------- Drag & drop ---------- */

function onDocDragStart(e: DragEvent, docId: number) {
  if (bulkSelect.isActive) return
  if (!e.dataTransfer) return
  e.dataTransfer.setData('text/x-noteforge-doc', String(docId))
  e.dataTransfer.effectAllowed = 'move'
  dragStore.startDocDrag(docId, props.folder.id)
}

function onDocDragEnd() {
  dragStore.end()
}

function onFolderDragStart(e: DragEvent) {
  if (bulkSelect.isActive) return
  if (!e.dataTransfer) return
  e.dataTransfer.setData('text/x-noteforge-folder', String(props.folder.id))
  e.dataTransfer.effectAllowed = 'move'
  dragStore.startFolderDrag(props.folder.id, props.folder.parentId ?? null)
}

function onFolderDragEnd() {
  dragStore.end()
}

/**
 * Folder row dragover (works for both doc and folder drags):
 *   - top 30% / bottom 30%: reorder zone — insert above this folder, or
 *     below it (= above its next sibling). Only fires when the dragged
 *     thing already shares this row's parent scope.
 *   - middle 40%: "drop INTO folder" — for docs this changes `folderId`,
 *     for folders this changes `parentId`. The middle-band highlight is
 *     suppressed when the move would be a no-op or invalid (self /
 *     descendant); invalid rows additionally render with reduced opacity
 *     and skip preventDefault so the browser shows the "no drop" cursor.
 */
function onFolderDragOver(e: DragEvent) {
  if (dragging.value == null) return
  const isFolderDrag = dragging.value.kind === 'folder'
  const isDocDrag = dragging.value.kind === 'doc'

  // Folder drag onto itself or any of its descendants: invalid target.
  // Do NOT preventDefault — that makes the browser show the "no drop"
  // cursor over these rows. We still stop propagation so the root
  // container's dragover doesn't paint a "drop into root" hint on top.
  if (isFolderDrag && isInvalidFolderDropTarget.value) {
    e.stopPropagation()
    dragStore.clearOver(props.folder.id)
    return
  }

  // Stop bubbling so the root tree's onRootDragOver doesn't overwrite
  // our overTarget back to 'root'. Without this, dropping a doc into a
  // sub-folder silently bounces to the workspace root.
  e.stopPropagation()
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'

  const row = e.currentTarget as HTMLElement
  const rect = row.getBoundingClientRect()
  const y = e.clientY - rect.top
  const h = rect.height
  const topBand = h * 0.30
  const bottomBand = h * 0.70

  if (y < topBand) {
    // Reorder: insert ABOVE this folder, in this folder's parent scope.
    dragStore.setOver(null)
    dragStore.clearOver(props.folder.id)
    if (isFolderDrag) {
      // Folders can only be reordered among folder siblings — if the dragged
      // folder isn't already a sibling of this row, the top/bottom band is
      // not a meaningful reorder target. Skip the indicator so the user
      // doesn't see a misleading rule.
      const sameSiblings =
        dragging.value.scope === parentScope.value.scope
        && dragging.value.scopeId === parentScope.value.scopeId
      if (sameSiblings) {
        dragStore.setInsertBefore({
          kind: 'folder',
          id: props.folder.id,
          scope: parentScope.value.scope,
          scopeId: parentScope.value.scopeId,
        })
      }
      else {
        dragStore.clearInsertBefore()
      }
    }
    else {
      // Doc dragged onto a folder-row top band: treat as reorder-among-docs
      // only if the doc shares the folder's parent (so it sits next to it
      // visually). Otherwise fall through to "move into folder" middle band.
      // Note: in current tree layout folders render ABOVE docs in the same
      // scope, so a doc landing above a folder is unusual. We allow it.
      if (
        isDocDrag
        && dragging.value.scope === parentScope.value.scope
        && dragging.value.scopeId === parentScope.value.scopeId
      ) {
        dragStore.setInsertBefore({
          kind: 'folder', // visually points at the folder row
          id: props.folder.id,
          scope: parentScope.value.scope,
          scopeId: parentScope.value.scopeId,
        })
      }
      else {
        // Cross-scope: just treat as into-folder.
        dragStore.clearInsertBefore()
        dragStore.setOver(props.folder.id)
      }
    }
  }
  else if (y > bottomBand) {
    // Reorder: insert BELOW this folder = insert before the NEXT folder
    // sibling in the same parent scope. If this is the last folder, the
    // indicator goes nowhere (next row's dragover will handle it).
    dragStore.setOver(null)
    dragStore.clearOver(props.folder.id)
    if (isFolderDrag) {
      const sameSiblings =
        dragging.value.scope === parentScope.value.scope
        && dragging.value.scopeId === parentScope.value.scopeId
      if (!sameSiblings) {
        // Cross-parent: bottom band of a non-sibling row is not a valid
        // reorder slot. (Cross-parent moves use the middle band.)
        dragStore.clearInsertBefore()
      }
      else {
        const siblings = allFolders.value
          .filter(f => (f.parentId ?? null) === (props.folder.parentId ?? null))
          .sort((a, b) => a.position - b.position || a.id - b.id)
        const idx = siblings.findIndex(f => f.id === props.folder.id)
        const next = idx >= 0 ? siblings[idx + 1] : undefined
        if (next && next.id !== dragging.value.id) {
          dragStore.setInsertBefore({
            kind: 'folder',
            id: next.id,
            scope: parentScope.value.scope,
            scopeId: parentScope.value.scopeId,
          })
        }
        else {
          // Last folder OR next sibling IS the dragged one — clear indicator.
          dragStore.clearInsertBefore()
        }
      }
    }
    else {
      dragStore.clearInsertBefore()
    }
  }
  else {
    // Middle band — drop INTO folder.
    dragStore.clearInsertBefore()
    if (isFolderDrag) {
      // Only show the "drop into" highlight if the move is actually allowed
      // (target is not the dragged folder's current parent — that's a no-op).
      if (dragStore.canDropFolderInto(props.folder.id, dragging.value.id)) {
        dragStore.setOverFolder(props.folder.id)
      }
      else {
        dragStore.clearOver(props.folder.id)
      }
    }
    else if (isDocDrag) {
      dragStore.setOver(props.folder.id)
    }
  }
}

function onFolderDragLeave(e: DragEvent) {
  const target = e.currentTarget as HTMLElement
  const related = e.relatedTarget as Node | null
  if (related && target.contains(related)) return
  dragStore.clearOver(props.folder.id)
  // Clear our own insert-before claim if it points at this row.
  if (
    insertBefore.value
    && insertBefore.value.id === props.folder.id
    && insertBefore.value.kind === 'folder'
  ) {
    dragStore.clearInsertBefore()
  }
}

async function onFolderDrop(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()

  const drag = dragging.value
  const insert = insertBefore.value
  const intoTarget = overTarget.value
  // Snapshot drag state, then end so any subsequent UI updates are clean.
  dragStore.end()

  if (drag == null) return

  // --- Folder drag ---
  if (drag.kind === 'folder') {
    if (drag.id === props.folder.id) return

    // Middle band ⇒ "drop INTO this folder" (change parentId).
    if (intoTarget === props.folder.id) {
      if (!dragStore.canDropFolderInto(props.folder.id, drag.id)) return
      try { await treeStore.moveFolder(drag.id, props.folder.id) }
      catch (err) {
        await dialog.alert({
          title: t('folder.move.failed'),
          message: (err as Error).message || t('folder.move.failedMsg'),
        })
      }
      return
    }

    // Reorder among folder siblings (only valid when sibling scopes match).
    if (
      insert
      && insert.kind === 'folder'
      && drag.scope === insert.scope
      && drag.scopeId === insert.scopeId
    ) {
      const peers = allFolders.value
        .filter(f => (f.parentId ?? null) === insert.scopeId)
        .sort((a, b) => a.position - b.position || a.id - b.id)
      const pos = computeReorderPosition(peers, drag.id, insert.id)
      try { await treeStore.reorderFolder(drag.id, pos) }
      catch (err) {
        await dialog.alert({
          title: t('folder.reorder.failed'),
          message: (err as Error).message || t('folder.reorder.failedMsg'),
        })
      }
    }
    return
  }

  // --- Doc drag ---
  if (drag.kind === 'doc') {
    const docId = drag.id
    const targetFolderId = intoTarget === props.folder.id ? props.folder.id : null

    // "drop into folder" — middle band activated.
    if (targetFolderId !== null) {
      try { await treeStore.moveDocument(docId, targetFolderId) }
      catch (err) {
        await dialog.alert({
          title: 'Move failed',
          message: (err as Error).message || 'The document could not be moved.',
        })
      }
      return
    }
    // Doc dropped on a folder row's top/bottom band: folders and docs are
    // separate sub-lists, so this can't be a doc reorder. Drop is a no-op
    // unless the user landed on a doc row (handled by `onDocRowDrop`).
  }
}

/* ---------- Doc row drag handlers ---------- */

function onDocRowDragOver(e: DragEvent, docId: number, docFolderId: number | null) {
  if (dragging.value == null) return
  e.preventDefault()
  e.stopPropagation()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'

  // Folders cannot reorder into the doc list (they're separate sub-lists).
  if (dragging.value.kind === 'folder') return

  // Don't show indicator on the dragged row itself.
  if (dragging.value.id === docId) return

  const row = e.currentTarget as HTMLElement
  const rect = row.getBoundingClientRect()
  const y = e.clientY - rect.top
  const h = rect.height
  // Docs have only top/bottom (no "into" target).
  if (y < h / 2) {
    dragStore.setInsertBefore({
      kind: 'doc',
      id: docId,
      scope: docFolderId == null ? 'root' : 'folder',
      scopeId: docFolderId,
    })
  }
  else {
    // Bottom half — next sibling (or tail). Compute next sibling in this
    // folder's doc list.
    const peers = props.folder.documents
    const idx = peers.findIndex(d => d.id === docId)
    const next = idx >= 0 ? peers[idx + 1] : undefined
    if (next) {
      dragStore.setInsertBefore({
        kind: 'doc',
        id: next.id,
        scope: docFolderId == null ? 'root' : 'folder',
        scopeId: docFolderId,
      })
    }
    else {
      dragStore.setInsertAtEnd('folder', props.folder.id)
    }
  }
}

async function onDocRowDrop(e: DragEvent, hoverDocFolderId: number | null) {
  e.preventDefault()
  e.stopPropagation()

  const drag = dragging.value
  const insert = insertBefore.value
  const atEnd = insertAtEndOf.value
  dragStore.end()

  if (drag == null || drag.kind !== 'doc') return

  const docId = drag.id
  const targetScope: DragScope = hoverDocFolderId == null ? 'root' : 'folder'
  const targetScopeId = hoverDocFolderId

  // Cross-scope: do a folder MOVE only (no position change), per sprint brief.
  if (drag.scope !== targetScope || drag.scopeId !== targetScopeId) {
    try { await treeStore.moveDocument(docId, targetScopeId) }
    catch (err) {
      await dialog.alert({
        title: t('doc.move.failed'),
        message: (err as Error).message || t('doc.move.failedMsg'),
      })
    }
    return
  }

  // Same scope: reorder among docs.
  const peers = allDocs.value
    .filter(d => (d.folderId ?? null) === targetScopeId)
    .sort((a, b) => a.position - b.position || a.id - b.id)

  let insertBeforeId: number | null = null
  if (insert && insert.kind === 'doc') insertBeforeId = insert.id
  else if (atEnd) insertBeforeId = null

  const pos = computeReorderPosition(peers, docId, insertBeforeId)
  try { await treeStore.reorderDoc(docId, pos) }
  catch (err) {
    await dialog.alert({
      title: t('doc.reorder.failed'),
      message: (err as Error).message || t('doc.reorder.failedMsg'),
    })
  }
}
</script>

<template>
  <div class="node">
    <div
      class="row"
      :class="{
        'row--drop-target': isDropTarget,
        'row--insert-before': showInsertBeforeFolder,
        'row--invalid-target': isInvalidFolderDropTarget,
        'row--bulk-selected': bulkSelect.isActive && bulkSelect.isFolderSelected(folder.id),
      }"
      :style="{ paddingLeft: indent + 'px' }"
      :draggable="bulkSelect.isActive ? false : true"
      @dragstart="onFolderDragStart"
      @dragend="onFolderDragEnd"
      @dragover="onFolderDragOver"
      @dragleave="onFolderDragLeave"
      @drop="onFolderDrop"
      @contextmenu="onRowContextMenu"
    >
      <input
        v-if="bulkSelect.isActive"
        type="checkbox"
        class="bulk-checkbox"
        :checked="bulkSelect.isFolderSelected(folder.id)"
        @click.stop
        @change="bulkSelect.toggleFolder(folder.id)"
      >
      <button
        type="button"
        class="chevron"
        :aria-expanded="isOpen"
        :aria-label="isOpen ? t('sidebar.folderCollapse') : t('sidebar.folderExpand')"
        @click="toggle"
      >
        <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
          <path
            :d="isOpen ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'"
            fill="none"
            stroke="currentColor"
            stroke-width="1.25"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <button type="button" class="name-btn" :title="folder.name" @click="toggle">
        <span class="folder-name">{{ folder.name }}</span>
      </button>

      <div ref="menuEl" class="row-actions">
        <button
          type="button"
          class="action"
          :title="t('sidebar.newDocument')"
          @click.stop="onNewDoc"
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M3.5 2h6L13 5.5V14H3.5z M9 2v4h4" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          class="action"
          :title="t('sidebar.more')"
          :aria-expanded="menuOpen"
          @click="toggleMenu"
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <circle cx="3.5" cy="8" r="1" fill="currentColor" />
            <circle cx="8" cy="8" r="1" fill="currentColor" />
            <circle cx="12.5" cy="8" r="1" fill="currentColor" />
          </svg>
        </button>

        <Transition name="pop">
          <div
            v-if="menuOpen"
            class="menu"
            :class="{ 'menu--floating': ctxPos !== null }"
            :style="menuStyle"
            role="menu"
          >
            <button type="button" class="menu-item" role="menuitem" @click="onNewSubfolder">{{ t('sidebar.newSubfolder') }}</button>
            <button type="button" class="menu-item" role="menuitem" @click="onRename">{{ t('sidebar.rename') }}</button>
            <div class="menu-sep" />
            <button type="button" class="menu-item menu-item--danger" role="menuitem" @click="onDelete">{{ t('sidebar.delete') }}</button>
          </div>
        </Transition>
      </div>
    </div>

    <div v-if="isOpen" class="children">
      <FolderTreeNode
        v-for="child in folder.children"
        :key="`f-${child.id}`"
        :folder="child"
        :depth="depth + 1"
        :workspace-id="workspaceId"
      />
      <NuxtLink
        v-for="doc in folder.documents"
        :key="`d-${doc.id}`"
        :to="`/w/${workspaceId}/d/${doc.id}`"
        class="doc-row"
        :class="{
          'doc-row--dragging': draggedDocId === doc.id,
          'doc-row--insert-before':
            insertBefore !== null
            && insertBefore.kind === 'doc'
            && insertBefore.id === doc.id,
          'doc-row--bulk-mode': bulkSelect.isActive,
          'doc-row--bulk-selected': bulkSelect.isActive && bulkSelect.isDocSelected(doc.id),
        }"
        active-class="doc-row--active"
        :style="{ paddingLeft: (indent + 22) + 'px' }"
        :draggable="!bulkSelect.isActive"
        @dragstart="bulkSelect.isActive ? null : onDocDragStart($event, doc.id)"
        @dragend="bulkSelect.isActive ? null : onDocDragEnd()"
        @dragover="bulkSelect.isActive ? null : onDocRowDragOver($event, doc.id, folder.id)"
        @drop="bulkSelect.isActive ? null : onDocRowDrop($event, folder.id)"
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
        <span class="doc-title">{{ doc.title || t('doc.untitled') }}</span>
        <button
          v-if="!bulkSelect.isActive"
          type="button"
          class="doc-action"
          :title="t('sidebar.delete')"
          @click.stop.prevent="onDeleteDoc(doc.id, doc.title)"
        >
          <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
            <path d="M4 4l8 8 M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
          </svg>
        </button>
      </NuxtLink>
      <div v-if="showInsertAtEndHere" class="insert-line insert-line--end" />
    </div>
  </div>
</template>

<style scoped>
.node { @apply select-none; }

.row {
  @apply relative flex items-center gap-1 pr-1 h-7 rounded text-[12.5px] text-ink-700 dark:text-ink-300;
  transition: background 100ms ease, color 100ms ease, box-shadow 100ms ease;
}
.row:hover {
  background: theme('colors.ink.100' / 70%);
  color: theme('colors.ink.900');
}
html.dark .row:hover {
  background: theme('colors.ink.800' / 60%);
  color: theme('colors.ink.100');
}
.row--drop-target {
  background: theme('colors.accent.50');
  color: theme('colors.accent.800');
  box-shadow: inset 0 0 0 1px theme('colors.accent.400');
}
html.dark .row--drop-target {
  background: theme('colors.accent.900' / 40%);
  color: theme('colors.accent.200');
  box-shadow: inset 0 0 0 1px theme('colors.accent.600');
}
/* Folder drag landed on its own row or a descendant — invalid target. */
.row--invalid-target {
  @apply opacity-40 cursor-not-allowed;
}

/* 2px accent insert-indicator above the row. */
.row--insert-before::before,
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

.chevron {
  @apply inline-flex items-center justify-center h-5 w-4 shrink-0 text-ink-400 dark:text-ink-500 rounded;
}
.chevron:hover { color: theme('colors.ink.700'); }
html.dark .chevron:hover { color: theme('colors.ink.200'); }

.name-btn {
  @apply flex-1 min-w-0 text-left;
}
.folder-name {
  @apply truncate font-sans uppercase text-[11px] font-semibold tracking-[0.06em] text-ink-700 dark:text-ink-300;
}
.row:hover .folder-name { color: theme('colors.ink.900'); }
html.dark .row:hover .folder-name { color: theme('colors.ink.100'); }

.row-actions {
  @apply relative flex items-center gap-0.5 opacity-0 transition-opacity duration-100;
}
.row:hover .row-actions { @apply opacity-100; }
.row-actions:focus-within { @apply opacity-100; }

.action {
  @apply inline-flex items-center justify-center h-5 w-5 rounded text-ink-500 dark:text-ink-400;
  transition: background 100ms ease, color 100ms ease;
}
.action:hover {
  background: theme('colors.ink.200' / 70%);
  color: theme('colors.ink.900');
}
html.dark .action:hover {
  background: theme('colors.ink.700' / 70%);
  color: theme('colors.ink.50');
}

.menu {
  @apply absolute right-0 top-6 z-30 min-w-[160px] py-1 rounded;
  background: theme('colors.ink.50');
  border: 1px solid theme('colors.ink.200');
  box-shadow: 0 2px 12px -8px theme('colors.ink.900' / 18%);
}
/* Floating variant — opened by right-click and positioned at the cursor via
   inline `position: fixed` style. Override the deeper shadow to feel more
   like a native context menu. */
.menu--floating {
  @apply z-50;
  box-shadow: 0 10px 30px -10px theme('colors.ink.900' / 35%);
}
html.dark .menu {
  background: theme('colors.ink.900');
  border-color: theme('colors.ink.800');
  box-shadow: 0 8px 24px -8px theme('colors.ink.950' / 60%);
}
html.dark .menu--floating {
  box-shadow: 0 12px 36px -8px theme('colors.ink.950' / 80%);
}
.menu-item {
  @apply w-full px-3 h-8 text-left text-[12.5px] text-ink-800 dark:text-ink-200;
  transition: background 100ms ease;
}
.menu-item:hover { background: theme('colors.ink.100' / 70%); }
html.dark .menu-item:hover { background: theme('colors.ink.800' / 60%); }
.menu-item--danger { color: theme('colors.accent.700'); }
html.dark .menu-item--danger { color: theme('colors.accent.300'); }
.menu-item--danger:hover { color: theme('colors.accent.800'); }
html.dark .menu-item--danger:hover { color: theme('colors.accent.200'); }
.menu-sep { @apply my-1 border-t border-ink-200/70 dark:border-ink-800/70; }

.children {
  @apply relative;
}

.doc-row {
  @apply relative flex items-center gap-2 pr-1 h-7 rounded text-[13px] text-ink-700 dark:text-ink-300 truncate;
  transition: background 100ms ease, color 100ms ease, opacity 100ms ease;
}
.doc-row--dragging { opacity: 0.4; }
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
.doc-title { @apply truncate flex-1 min-w-0; }
.doc-action {
  @apply inline-flex items-center justify-center h-5 w-5 rounded text-ink-400 dark:text-ink-500 opacity-0;
  transition: background 100ms ease, color 100ms ease, opacity 100ms ease;
}
.doc-row:hover .doc-action { @apply opacity-100; }
.doc-action:hover {
  background: theme('colors.ink.200' / 70%);
  color: theme('colors.ink.900');
}
html.dark .doc-action:hover {
  background: theme('colors.ink.700' / 70%);
  color: theme('colors.ink.50');
}

.insert-line {
  height: 2px;
  margin: 0 4px;
  background: theme('colors.accent.500');
  border-radius: 1px;
  pointer-events: none;
}
.insert-line--end { margin-top: 1px; }

.pop-enter-from { opacity: 0; transform: translateY(-2px); }
.pop-enter-to { opacity: 1; transform: translateY(0); }
.pop-enter-active { transition: opacity 100ms ease, transform 100ms ease; }
.pop-leave-from { opacity: 1; }
.pop-leave-to { opacity: 0; }
.pop-leave-active { transition: opacity 80ms ease; }

.bulk-checkbox {
  @apply h-3.5 w-3.5 shrink-0 accent-accent-500 cursor-pointer;
  margin: 0 4px 0 0;
}
.doc-row--bulk-mode { cursor: pointer; }
.doc-row--bulk-mode .doc-leaf { display: none; }
.doc-row--bulk-selected {
  background: theme('colors.accent.50');
  color: theme('colors.accent.900');
}
html.dark .doc-row--bulk-selected {
  background: theme('colors.accent.900' / 30%);
  color: theme('colors.accent.100');
}
.row--bulk-selected {
  background: theme('colors.accent.50');
}
html.dark .row--bulk-selected {
  background: theme('colors.accent.900' / 30%);
}
</style>
