import { acceptHMRUpdate, defineStore } from 'pinia'
import type { Folder, Document } from '~/server/database/schema'

export interface FolderNode extends Folder {
  children: FolderNode[]
  documents: Document[]
}

export interface WorkspaceTree {
  folders: FolderNode[]
  rootDocuments: Document[]
}

interface WorkspaceDetailResponse {
  workspace: { id: number }
  folders: Folder[]
  documents?: Document[]
}

interface State {
  workspaceId: number | null
  folders: Folder[]
  documents: Document[]
  loaded: boolean
  loading: boolean
  expanded: Record<number, boolean>
}

function sortByPosition<T extends { position: number, id: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.position - b.position || a.id - b.id)
}

export const useTreeStore = defineStore('tree', {
  state: (): State => ({
    workspaceId: null,
    folders: [],
    documents: [],
    loaded: false,
    loading: false,
    expanded: {},
  }),

  getters: {
    /**
     * Materialised tree: root folders (with nested children + their docs)
     * and the workspace-level documents (folderId == null).
     */
    tree(state): WorkspaceTree {
      const byParent = new Map<number | null, Folder[]>()
      for (const folder of state.folders) {
        const key = folder.parentId ?? null
        if (!byParent.has(key)) byParent.set(key, [])
        byParent.get(key)!.push(folder)
      }

      const docsByFolder = new Map<number | null, Document[]>()
      for (const doc of state.documents) {
        const key = doc.folderId ?? null
        if (!docsByFolder.has(key)) docsByFolder.set(key, [])
        docsByFolder.get(key)!.push(doc)
      }

      const build = (parentId: number | null): FolderNode[] => {
        const here = sortByPosition(byParent.get(parentId) ?? [])
        return here.map<FolderNode>(f => ({
          ...f,
          children: build(f.id),
          documents: sortByPosition(docsByFolder.get(f.id) ?? []),
        }))
      }

      return {
        folders: build(null),
        rootDocuments: sortByPosition(docsByFolder.get(null) ?? []),
      }
    },
  },

  actions: {
    isExpanded(folderId: number): boolean {
      return this.expanded[folderId] ?? false
    },

    toggleExpanded(folderId: number) {
      this.expanded[folderId] = !this.expanded[folderId]
    },

    expand(folderId: number) {
      this.expanded[folderId] = true
    },

    async fetchWorkspaceTree(workspaceId: number, force = false): Promise<void> {
      if (this.workspaceId === workspaceId && this.loaded && !force) return
      this.workspaceId = workspaceId
      this.loading = true
      try {
        // /api/workspaces/:id returns { workspace, folders, counts } (no documents).
        // We fetch documents separately.
        const [detail, docsRes] = await Promise.all([
          $fetch<WorkspaceDetailResponse>(`/api/workspaces/${workspaceId}`),
          $fetch<{ documents: Document[] }>('/api/documents', { query: { workspaceId } }),
        ])
        this.folders = detail.folders ?? []
        this.documents = docsRes.documents ?? []
        this.loaded = true
      } finally {
        this.loading = false
      }
    },

    async createFolder(input: { name: string, parentId?: number | null }): Promise<Folder> {
      if (this.workspaceId == null) throw new Error('No active workspace')
      const res = await $fetch<{ folder: Folder }>('/api/folders', {
        method: 'POST',
        body: {
          workspaceId: this.workspaceId,
          parentId: input.parentId ?? null,
          name: input.name,
        },
      })
      const created = res.folder
      this.folders = [...this.folders, created]
      if (created.parentId != null) this.expand(created.parentId)
      return created
    },

    async createDocument(input: { title?: string, folderId?: number | null }): Promise<Document> {
      if (this.workspaceId == null) throw new Error('No active workspace')
      const res = await $fetch<{ document: Document }>('/api/documents', {
        method: 'POST',
        body: {
          workspaceId: this.workspaceId,
          folderId: input.folderId ?? null,
          title: input.title ?? 'Untitled',
        },
      })
      const created = res.document
      this.documents = [...this.documents, created]
      if (created.folderId != null) this.expand(created.folderId)
      return created
    },

    async renameFolder(id: number, name: string): Promise<void> {
      const res = await $fetch<{ folder: Folder }>(`/api/folders/${id}`, {
        method: 'PATCH',
        body: { name },
      })
      this.folders = this.folders.map(f => (f.id === id ? { ...f, ...res.folder } : f))
    },

    async renameDocument(id: number, title: string): Promise<void> {
      const res = await $fetch<{ document: Document }>(`/api/documents/${id}`, {
        method: 'PATCH',
        body: { title },
      })
      this.documents = this.documents.map(d => (d.id === id ? { ...d, ...res.document } : d))
    },

    /**
     * Pure helper: is `candidateId` a descendant of `potentialAncestorId`
     * in the current folder tree? Walks `candidateId`'s subtree via
     * parentId links — i.e. is there a chain from candidate up to ancestor
     * (excluding candidate === ancestor itself).
     *
     * Equivalent question: is `candidateId` reachable by walking down from
     * `potentialAncestorId` through `parentId` children?
     */
    isDescendantFolder(potentialAncestorId: number, candidateId: number): boolean {
      if (potentialAncestorId === candidateId) return false
      // Build a map for O(1) parent lookups while walking up from candidate.
      const byId = new Map<number, Folder>()
      for (const f of this.folders) byId.set(f.id, f)
      let cursor: number | null | undefined = byId.get(candidateId)?.parentId ?? null
      let safety = 0
      while (cursor != null && safety < 1000) {
        if (cursor === potentialAncestorId) return true
        cursor = byId.get(cursor)?.parentId ?? null
        safety++
      }
      return false
    },

    /**
     * Move a folder to a new parent (or to workspace root if `newParentId`
     * is null). Optimistic; rolls back on failure. Caller is responsible
     * for guarding against cycles/self-moves; we still no-op here when
     * the move is trivial (same parent) or invalid (self / descendant) as
     * a safety net — the server has its own cycle guard.
     */
    async moveFolder(folderId: number, newParentId: number | null): Promise<void> {
      const before = this.folders.find(f => f.id === folderId)
      if (!before) return
      if ((before.parentId ?? null) === newParentId) return
      if (newParentId === folderId) return
      if (newParentId !== null && this.isDescendantFolder(folderId, newParentId)) return

      // Optimistic
      this.folders = this.folders.map(f =>
        f.id === folderId ? { ...f, parentId: newParentId } : f,
      )

      try {
        const res = await $fetch<{ folder: Folder }>(`/api/folders/${folderId}`, {
          method: 'PATCH',
          body: { parentId: newParentId },
        })
        this.folders = this.folders.map(f => (f.id === folderId ? { ...f, ...res.folder } : f))
        if (newParentId != null) this.expand(newParentId)
      }
      catch (err) {
        // Roll back on failure
        this.folders = this.folders.map(f =>
          f.id === folderId ? { ...f, parentId: before.parentId } : f,
        )
        throw err
      }
    },

    /**
     * Move a document to a new folder (or to the workspace root if
     * `folderId === null`). Updates the local tree optimistically.
     */
    async moveDocument(id: number, folderId: number | null): Promise<void> {
      const before = this.documents.find(d => d.id === id)
      if (!before) return
      if ((before.folderId ?? null) === folderId) return
      // Optimistic
      this.documents = this.documents.map(d => (d.id === id ? { ...d, folderId } : d))
      try {
        const res = await $fetch<{ document: Document }>(`/api/documents/${id}`, {
          method: 'PATCH',
          body: { folderId },
        })
        this.documents = this.documents.map(d => (d.id === id ? { ...d, ...res.document } : d))
        if (folderId != null) this.expand(folderId)
      }
      catch (err) {
        // Roll back on failure
        this.documents = this.documents.map(d =>
          d.id === id ? { ...d, folderId: before.folderId } : d,
        )
        throw err
      }
    },

    /**
     * Optimistic local patch (used by the editor / external title edits)
     * so the sidebar reflects changes without a refetch.
     */
    patchDocumentLocal(id: number, patch: Partial<Document>) {
      this.documents = this.documents.map(d => (d.id === id ? { ...d, ...patch } : d))
    },

    /**
     * Reorder a document within its current folder. `newPosition` is a
     * pre-computed midpoint (see `computeReorderPosition` in
     * `composables/useReorder.ts`). On failure, rolls back to the previous
     * position. If midpoint collides with an existing value in the same
     * scope, falls back to a renumber pass.
     */
    async reorderDoc(docId: number, newPosition: number): Promise<void> {
      const before = this.documents.find(d => d.id === docId)
      if (!before) return
      const prevPosition = before.position

      // Optimistic local update.
      this.documents = this.documents.map(d =>
        d.id === docId ? { ...d, position: newPosition } : d,
      )

      try {
        const res = await $fetch<{ document: Document }>(`/api/documents/${docId}`, {
          method: 'PATCH',
          body: { position: newPosition },
        })
        this.documents = this.documents.map(d => (d.id === docId ? { ...d, ...res.document } : d))

        // Detect collisions in the same scope; renumber if needed.
        const scope = before.folderId ?? null
        const peers = this.documents.filter(d => (d.folderId ?? null) === scope)
        const positions = new Set<number>()
        let collides = false
        for (const p of peers) {
          if (positions.has(p.position)) { collides = true; break }
          positions.add(p.position)
        }
        if (collides) await this.renumberDocs(scope)
      }
      catch (err) {
        this.documents = this.documents.map(d =>
          d.id === docId ? { ...d, position: prevPosition } : d,
        )
        throw err
      }
    },

    /** Reorder a folder among its siblings (same `parentId`). */
    async reorderFolder(folderId: number, newPosition: number): Promise<void> {
      const before = this.folders.find(f => f.id === folderId)
      if (!before) return
      const prevPosition = before.position

      this.folders = this.folders.map(f =>
        f.id === folderId ? { ...f, position: newPosition } : f,
      )

      try {
        const res = await $fetch<{ folder: Folder }>(`/api/folders/${folderId}`, {
          method: 'PATCH',
          body: { position: newPosition },
        })
        this.folders = this.folders.map(f => (f.id === folderId ? { ...f, ...res.folder } : f))

        const scope = before.parentId ?? null
        const peers = this.folders.filter(f => (f.parentId ?? null) === scope)
        const positions = new Set<number>()
        let collides = false
        for (const p of peers) {
          if (positions.has(p.position)) { collides = true; break }
          positions.add(p.position)
        }
        if (collides) await this.renumberFolders(scope)
      }
      catch (err) {
        this.folders = this.folders.map(f =>
          f.id === folderId ? { ...f, position: prevPosition } : f,
        )
        throw err
      }
    },

    /**
     * Fallback when midpoint math has collided or run out of room: walk the
     * scope in current sort order and rewrite every position to a fresh
     * multiple of 1024. Best-effort: failures are swallowed (next
     * successful reorder will trigger another renumber).
     */
    async renumberDocs(folderId: number | null): Promise<void> {
      const peers = sortByPosition(this.documents.filter(d => (d.folderId ?? null) === folderId))
      const updates: Array<{ id: number, position: number }> = []
      peers.forEach((d, i) => {
        const fresh = (i + 1) * 1024
        if (d.position !== fresh) updates.push({ id: d.id, position: fresh })
      })
      // Optimistic local renumber.
      const map = new Map(updates.map(u => [u.id, u.position]))
      this.documents = this.documents.map(d =>
        map.has(d.id) ? { ...d, position: map.get(d.id)! } : d,
      )
      // Fire patches in parallel; swallow errors.
      await Promise.allSettled(
        updates.map(u =>
          $fetch(`/api/documents/${u.id}`, { method: 'PATCH', body: { position: u.position } }),
        ),
      )
    },

    async renumberFolders(parentId: number | null): Promise<void> {
      const peers = sortByPosition(this.folders.filter(f => (f.parentId ?? null) === parentId))
      const updates: Array<{ id: number, position: number }> = []
      peers.forEach((f, i) => {
        const fresh = (i + 1) * 1024
        if (f.position !== fresh) updates.push({ id: f.id, position: fresh })
      })
      const map = new Map(updates.map(u => [u.id, u.position]))
      this.folders = this.folders.map(f =>
        map.has(f.id) ? { ...f, position: map.get(f.id)! } : f,
      )
      await Promise.allSettled(
        updates.map(u =>
          $fetch(`/api/folders/${u.id}`, { method: 'PATCH', body: { position: u.position } }),
        ),
      )
    },

    async deleteFolder(id: number): Promise<void> {
      await $fetch(`/api/folders/${id}`, { method: 'DELETE' })
      // Cascade locally: drop the folder, descendants, and their docs.
      const dead = new Set<number>([id])
      let grew = true
      while (grew) {
        grew = false
        for (const f of this.folders) {
          if (f.parentId != null && dead.has(f.parentId) && !dead.has(f.id)) {
            dead.add(f.id)
            grew = true
          }
        }
      }
      this.folders = this.folders.filter(f => !dead.has(f.id))
      this.documents = this.documents.filter(d => d.folderId == null || !dead.has(d.folderId))
    },

    async deleteDocument(id: number): Promise<void> {
      await $fetch(`/api/documents/${id}`, { method: 'DELETE' })
      this.documents = this.documents.filter(d => d.id !== id)
    },

    reset() {
      this.workspaceId = null
      this.folders = []
      this.documents = []
      this.loaded = false
      this.expanded = {}
    },
  },
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTreeStore, import.meta.hot))
}
