import { acceptHMRUpdate, defineStore } from 'pinia'

export interface McpTokenRow {
  id: number
  name: string | null
  prefix: string
  lastUsedAt: string | number | Date | null
  createdAt: string | number | Date
}

interface State {
  tokens: McpTokenRow[]
  loaded: boolean
  loading: boolean
  /** Clear-text token shown ONCE after creation. Cleared on dialog close. */
  freshToken: string | null
  /** Metadata for the row that owns `freshToken`, surfaced alongside it. */
  freshTokenMeta: McpTokenRow | null
}

/**
 * MCP bearer tokens for the active user. Loaded lazily by `McpTokensDialog`
 * the first time it opens. Mutations are optimistic with rollback on error
 * (matches `stores/favorites.ts` / `stores/tree.ts` patterns).
 *
 * The clear-text token (`freshToken`) is held in memory only — never
 * persisted, and cleared on dialog dismissal so closing-then-reopening the
 * dialog doesn't redisplay an old secret.
 */
export const useMcpTokensStore = defineStore('mcpTokens', {
  state: (): State => ({
    tokens: [],
    loaded: false,
    loading: false,
    freshToken: null,
    freshTokenMeta: null,
  }),

  actions: {
    async load(force = false): Promise<void> {
      if (this.loaded && !force) return
      this.loading = true
      try {
        const res = await $fetch<{ tokens: McpTokenRow[] }>('/api/mcp/tokens')
        this.tokens = res.tokens
        this.loaded = true
      }
      finally {
        this.loading = false
      }
    },

    async create(name?: string): Promise<McpTokenRow> {
      const res = await $fetch<{ token: string, mcpToken: McpTokenRow }>(
        '/api/mcp/tokens',
        {
          method: 'POST',
          body: name ? { name } : {},
        },
      )
      // Prepend so newest-first matches the server order.
      this.tokens = [res.mcpToken, ...this.tokens]
      this.freshToken = res.token
      this.freshTokenMeta = res.mcpToken
      return res.mcpToken
    },

    async revoke(id: number): Promise<void> {
      const prev = this.tokens
      // Optimistic remove.
      this.tokens = this.tokens.filter(t => t.id !== id)
      try {
        await $fetch(`/api/mcp/tokens/${id}`, { method: 'DELETE' })
      }
      catch (err) {
        this.tokens = prev
        throw err
      }
    },

    /** Forget the clear-text token. Called when the post-creation modal closes. */
    clearFresh() {
      this.freshToken = null
      this.freshTokenMeta = null
    },

    reset() {
      this.tokens = []
      this.loaded = false
      this.loading = false
      this.freshToken = null
      this.freshTokenMeta = null
    },
  },
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useMcpTokensStore, import.meta.hot))
}
