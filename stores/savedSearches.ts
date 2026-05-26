import { acceptHMRUpdate, defineStore } from 'pinia'
import type { SavedSearch } from '~/server/database/schema'

export interface SavedSearchQuery {
  q?: string
  tags?: string[]
  folderId?: number | null
  dateFrom?: string | null
  dateTo?: string | null
  sort?: 'relevance' | 'recent' | 'oldest'
}

/**
 * Wire-format saved-search row. The server returns `queryJson` already
 * parsed (drizzle `mode: 'json'`) but we keep both shapes — older clients
 * may have stringified it.
 */
export interface SavedSearchRow {
  id: number
  userId: number
  workspaceId: number
  name: string
  queryJson: SavedSearchQuery
  position: number
  createdAt: string | number | Date
}

interface State {
  workspaceId: number | null
  items: SavedSearchRow[]
  loaded: boolean
  loading: boolean
  expanded: boolean
}

function asRow(s: SavedSearch | SavedSearchRow): SavedSearchRow {
  return {
    id: s.id,
    userId: s.userId,
    workspaceId: s.workspaceId,
    name: s.name,
    queryJson: (typeof s.queryJson === 'string'
      ? safeParse(s.queryJson)
      : (s.queryJson as SavedSearchQuery)) ?? {},
    position: s.position,
    createdAt: s.createdAt,
  }
}

function safeParse(raw: string): SavedSearchQuery {
  try { return JSON.parse(raw) as SavedSearchQuery }
  catch { return {} }
}

/**
 * Saved searches for the active workspace. Loaded lazily by the sidebar
 * (one-shot per workspace). Mutations are optimistic with rollback on
 * network error — matches the favorites / tree pattern.
 */
export const useSavedSearchesStore = defineStore('savedSearches', {
  state: (): State => ({
    workspaceId: null,
    items: [],
    loaded: false,
    loading: false,
    expanded: true,
  }),

  getters: {
    sorted(state): SavedSearchRow[] {
      return [...state.items].sort((a, b) => a.position - b.position || a.id - b.id)
    },
  },

  actions: {
    toggleExpanded() {
      this.expanded = !this.expanded
    },

    async load(workspaceId: number, force = false): Promise<void> {
      if (this.workspaceId === workspaceId && this.loaded && !force) return
      this.workspaceId = workspaceId
      this.loading = true
      try {
        const res = await $fetch<{ savedSearches: SavedSearchRow[] }>('/api/saved-searches', {
          query: { workspaceId },
        })
        this.items = (res.savedSearches ?? []).map(asRow)
        this.loaded = true
      }
      finally {
        this.loading = false
      }
    },

    async create(input: { workspaceId: number, name: string, query: SavedSearchQuery }): Promise<SavedSearchRow> {
      const res = await $fetch<{ savedSearch: SavedSearchRow }>('/api/saved-searches', {
        method: 'POST',
        body: {
          workspaceId: input.workspaceId,
          name: input.name,
          query: input.query,
        },
      })
      const created = asRow(res.savedSearch)
      this.items = [...this.items, created]
      return created
    },

    async rename(id: number, name: string): Promise<void> {
      const before = this.items.find(s => s.id === id)
      if (!before) return
      // Optimistic
      this.items = this.items.map(s => (s.id === id ? { ...s, name } : s))
      try {
        const res = await $fetch<{ savedSearch: SavedSearchRow }>(`/api/saved-searches/${id}`, {
          method: 'PATCH',
          body: { name },
        })
        const updated = asRow(res.savedSearch)
        this.items = this.items.map(s => (s.id === id ? updated : s))
      }
      catch (err) {
        // Rollback
        this.items = this.items.map(s => (s.id === id ? before : s))
        throw err
      }
    },

    async updateQuery(id: number, query: SavedSearchQuery): Promise<void> {
      const before = this.items.find(s => s.id === id)
      if (!before) return
      this.items = this.items.map(s => (s.id === id ? { ...s, queryJson: query } : s))
      try {
        const res = await $fetch<{ savedSearch: SavedSearchRow }>(`/api/saved-searches/${id}`, {
          method: 'PATCH',
          body: { query },
        })
        const updated = asRow(res.savedSearch)
        this.items = this.items.map(s => (s.id === id ? updated : s))
      }
      catch (err) {
        this.items = this.items.map(s => (s.id === id ? before : s))
        throw err
      }
    },

    async remove(id: number): Promise<void> {
      const prev = this.items
      this.items = this.items.filter(s => s.id !== id)
      try {
        await $fetch(`/api/saved-searches/${id}`, { method: 'DELETE' })
      }
      catch (err) {
        this.items = prev
        throw err
      }
    },

    reset() {
      this.workspaceId = null
      this.items = []
      this.loaded = false
      this.loading = false
    },
  },
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSavedSearchesStore, import.meta.hot))
}
