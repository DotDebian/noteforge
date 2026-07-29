import { acceptHMRUpdate, defineStore } from 'pinia'

export interface McpConnectorRow {
  id: number
  name: string | null
  clientId: string
  secretPrefix: string
  lastUsedAt: string | number | Date | null
  createdAt: string | number | Date
}

interface State {
  connectors: McpConnectorRow[]
  loaded: boolean
  loading: boolean
  /** Clear-text client secret shown ONCE after creation. Cleared on dialog close. */
  freshSecret: string | null
  /** The connector that owns `freshSecret` — its clientId is displayed alongside. */
  freshConnector: McpConnectorRow | null
}

/**
 * OAuth connectors (claude.ai "custom connector") for the active user.
 *
 * Sibling of `stores/mcpTokens.ts`: same lifecycle, different credential.
 * A token is a header the client sends; a connector is a client id + secret
 * Claude uses to run the OAuth dance against our own authorization server.
 *
 * Like the token store, the clear secret lives in memory only and is dropped
 * on dialog dismissal so reopening never redisplays it.
 */
export const useMcpConnectorsStore = defineStore('mcpConnectors', {
  state: (): State => ({
    connectors: [],
    loaded: false,
    loading: false,
    freshSecret: null,
    freshConnector: null,
  }),

  actions: {
    async load(force = false): Promise<void> {
      if (this.loaded && !force) return
      this.loading = true
      try {
        const res = await $fetch<{ connectors: McpConnectorRow[] }>('/api/mcp/connectors')
        this.connectors = res.connectors
        this.loaded = true
      }
      finally {
        this.loading = false
      }
    },

    async create(name?: string): Promise<McpConnectorRow> {
      const res = await $fetch<{ clientSecret: string, connector: McpConnectorRow }>(
        '/api/mcp/connectors',
        {
          method: 'POST',
          body: name ? { name } : {},
        },
      )
      // Prepend so newest-first matches the server order.
      this.connectors = [res.connector, ...this.connectors]
      this.freshSecret = res.clientSecret
      this.freshConnector = res.connector
      return res.connector
    },

    async revoke(id: number): Promise<void> {
      const prev = this.connectors
      // Optimistic remove.
      this.connectors = this.connectors.filter(c => c.id !== id)
      try {
        await $fetch(`/api/mcp/connectors/${id}`, { method: 'DELETE' })
      }
      catch (err) {
        this.connectors = prev
        throw err
      }
    },

    /** Forget the clear-text secret. Called when the dialog closes. */
    clearFresh() {
      this.freshSecret = null
      this.freshConnector = null
    },

    reset() {
      this.connectors = []
      this.loaded = false
      this.loading = false
      this.freshSecret = null
      this.freshConnector = null
    },
  },
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useMcpConnectorsStore, import.meta.hot))
}
