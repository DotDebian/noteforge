import { acceptHMRUpdate, defineStore } from 'pinia'

export interface FavoriteEntry {
  docId: number
  title: string
  createdAt: Date
}

interface FavoriteRowApi {
  docId: number
  title: string
  createdAt: string | number | Date
}

interface State {
  workspaceId: number | null
  /** docIds the current user has favorited within the active workspace. */
  ids: Set<number>
  /** Materialised list (most-recently-pinned first) used by the sidebar. */
  entries: FavoriteEntry[]
  loaded: boolean
  loading: boolean
}

function toDate(v: string | number | Date): Date {
  if (v instanceof Date) return v
  if (typeof v === 'number') return new Date(v * 1000)
  return new Date(v)
}

/**
 * Favorites (pinned docs) for the active workspace.
 *
 * Loaded on workspace switch via `load(workspaceId)`. Mutations
 * (`toggle(docId)`) are optimistic with rollback on network error.
 */
export const useFavoritesStore = defineStore('favorites', {
  state: (): State => ({
    workspaceId: null,
    ids: new Set<number>(),
    entries: [],
    loaded: false,
    loading: false,
  }),

  getters: {
    isFavorite(state) {
      return (docId: number): boolean => state.ids.has(docId)
    },
    count(state): number {
      return state.entries.length
    },
  },

  actions: {
    async load(workspaceId: number, force = false): Promise<void> {
      if (this.workspaceId === workspaceId && this.loaded && !force) return
      this.workspaceId = workspaceId
      this.loading = true
      try {
        const res = await $fetch<{ favorites: FavoriteRowApi[] }>('/api/favorites', {
          query: { workspaceId },
        })
        const list = (res.favorites ?? []).map<FavoriteEntry>(r => ({
          docId: r.docId,
          title: r.title,
          createdAt: toDate(r.createdAt),
        }))
        this.entries = list
        this.ids = new Set(list.map(f => f.docId))
        this.loaded = true
      }
      finally {
        this.loading = false
      }
    },

    /**
     * Toggle the favorite state for a doc. Optimistic: the local Set and
     * entries list are flipped immediately, then reverted if the network
     * call fails.
     *
     * `title` is optional; only used when newly favoriting to seed the
     * sidebar entry until the next `load`.
     */
    async toggle(docId: number, title?: string): Promise<boolean> {
      const wasFav = this.ids.has(docId)
      const prevEntries = this.entries
      const prevIds = new Set(this.ids)

      // Optimistic flip.
      if (wasFav) {
        this.ids.delete(docId)
        this.entries = this.entries.filter(e => e.docId !== docId)
      }
      else {
        this.ids.add(docId)
        this.entries = [
          { docId, title: title ?? 'Untitled', createdAt: new Date() },
          ...this.entries,
        ]
      }

      try {
        if (wasFav) {
          await $fetch(`/api/documents/${docId}/favorite`, { method: 'DELETE' })
        }
        else {
          await $fetch(`/api/documents/${docId}/favorite`, { method: 'POST' })
        }
        return !wasFav
      }
      catch (err) {
        // Rollback.
        this.ids = prevIds
        this.entries = prevEntries
        throw err
      }
    },

    /**
     * Keep a favorite entry's title in sync after the user renames a doc.
     */
    patchTitle(docId: number, title: string) {
      this.entries = this.entries.map(e =>
        e.docId === docId ? { ...e, title } : e,
      )
    },

    /**
     * Drop a doc from favorites locally (e.g. after deletion). The server
     * side is handled automatically by the FK cascade.
     */
    removeLocal(docId: number) {
      if (!this.ids.has(docId)) return
      this.ids.delete(docId)
      this.entries = this.entries.filter(e => e.docId !== docId)
    },

    reset() {
      this.workspaceId = null
      this.ids = new Set<number>()
      this.entries = []
      this.loaded = false
    },
  },
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useFavoritesStore, import.meta.hot))
}
