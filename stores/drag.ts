import { acceptHMRUpdate, defineStore } from 'pinia'
import { useTreeStore } from '~/stores/tree'

/**
 * Shared drag state for the sidebar tree.
 *
 * Two parallel concepts coexist:
 *
 * 1. **Move to folder** (existing): `draggedDocId` + `sourceFolderId` + `overTarget`.
 *    A doc dragged onto a folder row's *middle band* (or the root tree container)
 *    sets `overTarget` and shows the "drop into folder" highlight.
 *
 * 2. **Reorder** (new): `insertBefore` describes where the dragged thing would
 *    land if dropped *between* siblings. The component renders a 2px accent
 *    rule above the row whose `(kind, id)` matches.
 *
 *    We chose `insertBefore` (vs. `insertAfter`) because "above this row" is
 *    what the user sees, and the tail position (drop below the last sibling)
 *    is encoded as `insertBefore: null` paired with `scope`/`scopeId` —
 *    components query the scope when they need to know "is the indicator at
 *    the end of *my* list?".
 *
 *    `kind` lets the same store handle doc-vs-folder reorders.
 *    `scope` + `scopeId` capture the parent the dragged thing must share for
 *    the reorder to fire (same parent folder, or both at workspace root).
 */
export type DragKind = 'doc' | 'folder'
export type DragScope = 'root' | 'folder'

export interface InsertBefore {
  kind: DragKind
  id: number
  scope: DragScope
  scopeId: number | null
}

/** The thing currently being dragged. `folder` is the new sibling. */
export interface DraggingItem {
  kind: DragKind
  id: number
  /** Where the drag originated. `'root'` ⇒ workspaceId-less workspace root. */
  scope: DragScope
  scopeId: number | null
}

interface State {
  draggedDocId: number | null
  sourceFolderId: number | null
  overTarget: number | 'root' | null
  /** Current drag origin, populated for both doc and folder drags. */
  dragging: DraggingItem | null
  /** Row the dragged thing would be inserted ABOVE. */
  insertBefore: InsertBefore | null
  /**
   * Special tail-position marker: when the indicator should sit *after*
   * the last child of a scope (since there's no "next" row). `null` when
   * the indicator is not at the tail.
   */
  insertAtEndOf: { scope: DragScope, scopeId: number | null } | null
}

export const useDragStore = defineStore('drag', {
  state: (): State => ({
    draggedDocId: null,
    sourceFolderId: null,
    overTarget: null,
    dragging: null,
    insertBefore: null,
    insertAtEndOf: null,
  }),

  actions: {
    startDocDrag(docId: number, sourceFolderId: number | null) {
      this.draggedDocId = docId
      this.sourceFolderId = sourceFolderId
      this.overTarget = null
      this.dragging = {
        kind: 'doc',
        id: docId,
        scope: sourceFolderId == null ? 'root' : 'folder',
        scopeId: sourceFolderId,
      }
      this.insertBefore = null
      this.insertAtEndOf = null
    },

    startFolderDrag(folderId: number, parentId: number | null) {
      this.dragging = {
        kind: 'folder',
        id: folderId,
        scope: parentId == null ? 'root' : 'folder',
        scopeId: parentId,
      }
      this.insertBefore = null
      this.insertAtEndOf = null
      this.overTarget = null
    },

    setOver(target: number | 'root' | null) {
      // Don't show a highlight for the doc's current parent.
      if (target === 'root' && this.sourceFolderId === null) {
        this.overTarget = null
        return
      }
      if (typeof target === 'number' && this.sourceFolderId === target) {
        this.overTarget = null
        return
      }
      this.overTarget = target
    },
    /** Alias for `setOver`, used by folder-into-folder code paths for clarity. */
    setOverFolder(target: number | 'root' | null) {
      this.setOver(target)
    },
    clearOver(target: number | 'root') {
      if (this.overTarget === target) this.overTarget = null
    },

    setInsertBefore(target: InsertBefore | null) {
      this.insertBefore = target
      if (target !== null) this.insertAtEndOf = null
    },
    clearInsertBefore() {
      this.insertBefore = null
    },
    setInsertAtEnd(scope: DragScope, scopeId: number | null) {
      this.insertAtEndOf = { scope, scopeId }
      this.insertBefore = null
    },
    clearInsertAtEnd() {
      this.insertAtEndOf = null
    },

    /**
     * Can the folder `draggedFolderId` be dropped into `targetFolderId`?
     *
     * Rejects when:
     *   - target === dragged (drop on self),
     *   - target is a descendant of dragged (would create a cycle),
     *   - target IS the folder's current parent (would be a no-op).
     *
     * `'root'` ⇒ workspace root (parentId = null).
     */
    canDropFolderInto(
      targetFolderId: number | 'root',
      draggedFolderId: number,
    ): boolean {
      const tree = useTreeStore()
      const dragged = tree.folders.find(f => f.id === draggedFolderId)
      if (!dragged) return false

      const currentParent = dragged.parentId ?? null
      const targetAsParent: number | null = targetFolderId === 'root' ? null : targetFolderId

      // No-op move (already there).
      if (currentParent === targetAsParent) return false

      // Drop on self.
      if (targetAsParent === draggedFolderId) return false

      // Drop on a descendant of dragged.
      if (
        targetAsParent !== null
        && tree.isDescendantFolder(draggedFolderId, targetAsParent)
      ) return false

      return true
    },

    end() {
      this.draggedDocId = null
      this.sourceFolderId = null
      this.overTarget = null
      this.dragging = null
      this.insertBefore = null
      this.insertAtEndOf = null
    },
  },
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useDragStore, import.meta.hot))
}
