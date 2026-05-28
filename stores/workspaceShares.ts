import { acceptHMRUpdate, defineStore } from 'pinia'
import type { WorkspaceRole } from '~/server/database/schema'

export interface ShareMember {
  id: number
  userId: number
  email: string
  displayName: string | null
  role: WorkspaceRole
  createdAt: string | Date
}

interface State {
  /** workspaceId → loaded members. */
  byWorkspace: Record<number, ShareMember[]>
  loading: boolean
  /** Last error from a share/revoke/role-change op, for the dialog UI. */
  lastError: string | null
}

export const useWorkspaceSharesStore = defineStore('workspaceShares', {
  state: (): State => ({
    byWorkspace: {},
    loading: false,
    lastError: null,
  }),

  getters: {
    members:
      state =>
        (workspaceId: number): ShareMember[] =>
          state.byWorkspace[workspaceId] ?? [],
  },

  actions: {
    async fetch(workspaceId: number): Promise<ShareMember[]> {
      this.loading = true
      this.lastError = null
      try {
        const res = await $fetch<{ members: ShareMember[] }>(`/api/workspaces/${workspaceId}/shares`)
        this.byWorkspace = { ...this.byWorkspace, [workspaceId]: res.members }
        return res.members
      }
      finally {
        this.loading = false
      }
    },

    async share(workspaceId: number, email: string, role: 'editor' | 'viewer'): Promise<void> {
      this.lastError = null
      try {
        await $fetch(`/api/workspaces/${workspaceId}/shares`, {
          method: 'POST',
          body: { email, role },
        })
        // Refetch — the server may have upgraded the workspace to 'wek'
        // and added the owner's row too; easier to reload than reconcile.
        await this.fetch(workspaceId)
      }
      catch (err) {
        this.lastError = extractErrorCode(err) ?? 'share_failed'
        throw err
      }
    },

    async revoke(workspaceId: number, userId: number): Promise<void> {
      this.lastError = null
      try {
        await $fetch(`/api/workspaces/${workspaceId}/shares/${userId}`, { method: 'DELETE' })
        this.byWorkspace = {
          ...this.byWorkspace,
          [workspaceId]: (this.byWorkspace[workspaceId] ?? []).filter(m => m.userId !== userId),
        }
      }
      catch (err) {
        this.lastError = extractErrorCode(err) ?? 'revoke_failed'
        throw err
      }
    },

    async setRole(workspaceId: number, userId: number, role: 'editor' | 'viewer'): Promise<void> {
      this.lastError = null
      try {
        await $fetch(`/api/workspaces/${workspaceId}/shares/${userId}`, {
          method: 'PATCH',
          body: { role },
        })
        this.byWorkspace = {
          ...this.byWorkspace,
          [workspaceId]: (this.byWorkspace[workspaceId] ?? []).map(m =>
            m.userId === userId ? { ...m, role } : m,
          ),
        }
      }
      catch (err) {
        this.lastError = extractErrorCode(err) ?? 'role_change_failed'
        throw err
      }
    },

    clearError() {
      this.lastError = null
    },
  },
})

function extractErrorCode(err: unknown): string | null {
  const e = err as { data?: { statusMessage?: string }, statusMessage?: string, message?: string }
  return e?.data?.statusMessage ?? e?.statusMessage ?? e?.message ?? null
}

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWorkspaceSharesStore, import.meta.hot))
}
