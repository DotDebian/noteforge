import { acceptHMRUpdate, defineStore } from 'pinia'

const RECENT_KEY = 'noteforge-recent-docs'
const RECENT_LIMIT = 10

interface State {
  isOpen: boolean
  query: string
  recentDocIds: number[]
}

function loadRecent(): number[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const ids: number[] = []
    for (const v of parsed) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) ids.push(v)
      if (ids.length >= RECENT_LIMIT) break
    }
    return ids
  }
  catch {
    return []
  }
}

function persistRecent(ids: number[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(ids))
  }
  catch {
    /* ignore quota / privacy errors */
  }
}

/**
 * Command palette (Ctrl/Cmd+K) store. Tracks open state, the current query
 * input, and a most-recent-first list of doc IDs persisted to localStorage
 * under `noteforge-recent-docs`.
 */
export const usePaletteStore = defineStore('palette', {
  state: (): State => ({
    isOpen: false,
    query: '',
    recentDocIds: loadRecent(),
  }),

  actions: {
    open() {
      this.query = ''
      this.isOpen = true
    },

    close() {
      this.isOpen = false
      this.query = ''
    },

    toggle() {
      if (this.isOpen) this.close()
      else this.open()
    },

    setQuery(q: string) {
      this.query = q
    },

    /**
     * Push the document to the top of the recents list (dedup), trim to
     * RECENT_LIMIT, and persist.
     */
    pushRecent(docId: number) {
      if (!Number.isFinite(docId) || docId <= 0) return
      const next = [docId, ...this.recentDocIds.filter(id => id !== docId)].slice(0, RECENT_LIMIT)
      this.recentDocIds = next
      persistRecent(next)
    },

    /** Remove a docId from the recents list (e.g. after deletion). */
    removeRecent(docId: number) {
      const next = this.recentDocIds.filter(id => id !== docId)
      if (next.length === this.recentDocIds.length) return
      this.recentDocIds = next
      persistRecent(next)
    },
  },
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePaletteStore, import.meta.hot))
}
