import { acceptHMRUpdate, defineStore } from 'pinia'
import type { Workspace } from '~/server/database/schema'

interface State {
  workspaces: Workspace[]
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
    current(state): Workspace | null {
      if (state.currentWorkspaceId == null) return null
      return state.workspaces.find(w => w.id === state.currentWorkspaceId) ?? null
    },
    hasAny(state): boolean {
      return state.workspaces.length > 0
    },
  },

  actions: {
    async fetchAll(force = false): Promise<Workspace[]> {
      if (this.loaded && !force) return this.workspaces
      this.loading = true
      try {
        const res = await $fetch<{ workspaces: Workspace[] }>('/api/workspaces')
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

    async create(name: string, emoji?: string): Promise<Workspace> {
      const res = await $fetch<{ workspace: Workspace }>('/api/workspaces', {
        method: 'POST',
        body: { name, emoji },
      })
      const created = res.workspace
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

    async rename(id: number, name: string, emoji?: string | null): Promise<Workspace> {
      const res = await $fetch<{ workspace: Workspace }>(`/api/workspaces/${id}`, {
        method: 'PATCH',
        body: { name, emoji },
      })
      this.workspaces = this.workspaces.map(w => (w.id === id ? res.workspace : w))
      return res.workspace
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
