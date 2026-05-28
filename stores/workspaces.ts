import { acceptHMRUpdate, defineStore } from 'pinia'
import type { Workspace, WorkspaceRole } from '~/server/database/schema'

/**
 * Frontend-side workspace row — extends the server schema with the
 * caller's effective role and a `shared` flag (true iff at least one
 * non-owner member exists). Both come from `/api/workspaces`.
 */
export interface WorkspaceWithRole extends Workspace {
  role: WorkspaceRole
  shared: boolean
}

interface State {
  workspaces: WorkspaceWithRole[]
  currentWorkspaceId: number | null
  loaded: boolean
  loading: boolean
  creating: boolean
}

export const useWorkspacesStore = defineStore('workspaces', {
  state: (): State => ({
    workspaces: [],
    currentWorkspaceId: null,
    loaded: false,
    loading: false,
    creating: false,
  }),

  getters: {
    current(state): WorkspaceWithRole | null {
      if (state.currentWorkspaceId == null) return null
      return state.workspaces.find(w => w.id === state.currentWorkspaceId) ?? null
    },
    hasAny(state): boolean {
      return state.workspaces.length > 0
    },
    /** True when the caller can mutate content in the active workspace. */
    canEdit(): boolean {
      return this.current?.role !== 'viewer'
    },
    /** True when the caller can share / delete the active workspace. */
    isOwner(): boolean {
      return this.current?.role === 'owner'
    },
  },

  actions: {
    async fetchAll(force = false): Promise<WorkspaceWithRole[]> {
      if (this.loaded && !force) return this.workspaces
      this.loading = true
      try {
        const res = await $fetch<{ workspaces: WorkspaceWithRole[] }>('/api/workspaces')
        const list = res.workspaces
        this.workspaces = list
        this.loaded = true
        if (this.currentWorkspaceId == null && list[0]) {
          this.currentWorkspaceId = list[0].id
        }
        return list
      } finally {
        this.loading = false
      }
    },

    async create(name: string, emoji?: string): Promise<WorkspaceWithRole> {
      const res = await $fetch<{ workspace: Workspace }>('/api/workspaces', {
        method: 'POST',
        body: { name, emoji },
      })
      // Freshly-created workspaces are solo (mode 'dek') with the caller
      // as owner — no `workspace_shares` row exists yet.
      const created: WorkspaceWithRole = { ...res.workspace, role: 'owner', shared: false }
      this.workspaces = [...this.workspaces, created]
      this.currentWorkspaceId = created.id
      return created
    },

    setCurrent(id: number | null) {
      this.currentWorkspaceId = id
    },

    openCreate() {
      this.creating = true
    },

    closeCreate() {
      this.creating = false
    },

    async rename(id: number, name: string, emoji?: string | null): Promise<WorkspaceWithRole> {
      const res = await $fetch<{ workspace: Workspace }>(`/api/workspaces/${id}`, {
        method: 'PATCH',
        body: { name, emoji },
      })
      this.workspaces = this.workspaces.map((w) => {
        if (w.id !== id) return w
        // Preserve the role + shared flag — the PATCH endpoint returns
        // only the workspace row.
        return { ...res.workspace, role: w.role, shared: w.shared }
      })
      const updated = this.workspaces.find(w => w.id === id)!
      return updated
    },

    async remove(id: number): Promise<void> {
      await $fetch(`/api/workspaces/${id}`, { method: 'DELETE' })
      this.workspaces = this.workspaces.filter(w => w.id !== id)
      if (this.currentWorkspaceId === id) {
        this.currentWorkspaceId = this.workspaces[0]?.id ?? null
      }
    },

    reset() {
      this.workspaces = []
      this.currentWorkspaceId = null
      this.loaded = false
    },
  },
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWorkspacesStore, import.meta.hot))
}
