import { acceptHMRUpdate, defineStore } from 'pinia'

/**
 * Bulk selection state for the sidebar. Tracked as `number[]` rather than
 * `Set<number>` because Pinia's reactivity on raw `Set` mutations is finicky
 * — replacing the array is reliable and the perf cost is negligible at the
 * scale of sidebar selection (workspaces with ~1k docs at most).
 */
type Mode = 'idle' | 'active'

interface State {
  mode: Mode
  /** Selected doc ids — flat array, dedup invariant enforced by the setters. */
  selectedDocs: number[]
  /** Selected folder ids. */
  selectedFolders: number[]
}

export const useBulkSelectStore = defineStore('bulkSelect', {
  state: (): State => ({
    mode: 'idle',
    selectedDocs: [],
    selectedFolders: [],
  }),

  getters: {
    isActive: state => state.mode === 'active',
    docCount: state => state.selectedDocs.length,
    folderCount: state => state.selectedFolders.length,
    totalCount: state => state.selectedDocs.length + state.selectedFolders.length,
    hasSelection(state): boolean {
      return state.selectedDocs.length > 0 || state.selectedFolders.length > 0
    },
    isDocSelected: state => (id: number): boolean => state.selectedDocs.includes(id),
    isFolderSelected: state => (id: number): boolean => state.selectedFolders.includes(id),
  },

  actions: {
    enter() {
      this.mode = 'active'
    },

    exit() {
      this.mode = 'idle'
      this.clear()
    },

    toggle() {
      if (this.mode === 'active') this.exit()
      else this.enter()
    },

    clear() {
      this.selectedDocs = []
      this.selectedFolders = []
    },

    toggleDoc(id: number) {
      if (this.selectedDocs.includes(id)) {
        this.selectedDocs = this.selectedDocs.filter(d => d !== id)
      }
      else {
        this.selectedDocs = [...this.selectedDocs, id]
      }
    },

    toggleFolder(id: number) {
      if (this.selectedFolders.includes(id)) {
        this.selectedFolders = this.selectedFolders.filter(f => f !== id)
      }
      else {
        this.selectedFolders = [...this.selectedFolders, id]
      }
    },

    setDocs(ids: number[]) {
      this.selectedDocs = Array.from(new Set(ids))
    },

    setFolders(ids: number[]) {
      this.selectedFolders = Array.from(new Set(ids))
    },

    removeDoc(id: number) {
      this.selectedDocs = this.selectedDocs.filter(d => d !== id)
    },

    removeFolder(id: number) {
      this.selectedFolders = this.selectedFolders.filter(f => f !== id)
    },
  },
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useBulkSelectStore, import.meta.hot))
}
