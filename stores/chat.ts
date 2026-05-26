import { acceptHMRUpdate, defineStore } from 'pinia'
import type { ChatMessage, ChatSession } from '~/server/database/schema'
import { useDialog } from '~/composables/useDialog'

export interface ChatSource {
  docId: number
  chunkIdx: number
  snippet: string
  title?: string
  /** Best-matching sentence inside the chunk vs. the assistant's answer. */
  highlight?: string
  /** Citation number as written in the assistant message ([#N]). */
  citation?: number
}

export interface UIChatMessage {
  id: number | string         // negative / string for optimistic rows
  role: 'user' | 'assistant' | 'system'
  content: string
  sources: ChatSource[]
  pending?: boolean
  errored?: boolean
}

interface PendingCitation {
  docId: number
  snippet: string
}

interface State {
  open: boolean
  currentSessionId: number | null
  sessions: ChatSession[]
  messages: UIChatMessage[]
  scopeFolderId: number | null
  /** Doc-scoped chat (Sprint 4 / F11). Mutually exclusive with folder scope. */
  scopeDocId: number | null
  workspaceId: number | null
  loadingSessions: boolean
  loadingMessages: boolean
  sending: boolean
  pendingQuestion: string | null
  pendingCitation: PendingCitation | null
}

interface SessionDetailResponse {
  session: ChatSession
  messages: ChatMessage[]
}

interface BranchResponse {
  session: ChatSession
  messages: ChatMessage[]
}

function adaptMessage(m: ChatMessage): UIChatMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    sources: (m.sources ?? []) as ChatSource[],
  }
}

export const useChatStore = defineStore('chat', {
  state: (): State => ({
    open: false,
    currentSessionId: null,
    sessions: [],
    messages: [],
    scopeFolderId: null,
    scopeDocId: null,
    workspaceId: null,
    loadingSessions: false,
    loadingMessages: false,
    sending: false,
    pendingQuestion: null,
    pendingCitation: null,
  }),

  actions: {
    /**
     * Open the drawer. If a question is supplied it will be queued so the
     * ChatDrawer component can prefill the composer the moment it mounts.
     */
    openWithQuestion(q?: string) {
      this.open = true
      if (q && q.trim().length > 0) this.pendingQuestion = q.trim()
    },

    /**
     * Queue a citation jump for the document page. The DocumentEditor reads
     * and consumes this when it mounts (or when the existing editor sees the
     * value change for its current doc).
     */
    queueCitation(docId: number, snippet: string) {
      this.pendingCitation = { docId, snippet }
    },

    consumePendingCitation(forDocId: number): string | null {
      const c = this.pendingCitation
      if (!c || c.docId !== forDocId) return null
      this.pendingCitation = null
      return c.snippet
    },

    consumePendingQuestion(): string | null {
      const q = this.pendingQuestion
      this.pendingQuestion = null
      return q
    },

    close() {
      this.open = false
    },

    toggle() {
      this.open = !this.open
    },

    setWorkspace(workspaceId: number | null) {
      if (this.workspaceId === workspaceId) return
      this.workspaceId = workspaceId
      this.currentSessionId = null
      this.messages = []
      this.sessions = []
      this.scopeDocId = null
      this.scopeFolderId = null
    },

    setScopeFolder(folderId: number | null) {
      this.scopeFolderId = folderId
      // Folder and doc scope are mutually exclusive.
      if (folderId != null) this.scopeDocId = null
    },

    setScopeDoc(docId: number | null) {
      this.scopeDocId = docId
      if (docId != null) this.scopeFolderId = null
    },

    /**
     * Open the drawer pinned to a specific doc (Sprint 4 / F11 "Ask this doc").
     * Clears the current session so a fresh doc-scoped session is created on
     * the first send.
     */
    openWithScope(opts: { workspaceId: number, docId?: number | null, folderId?: number | null, message?: string }) {
      this.setWorkspace(opts.workspaceId)
      if (opts.docId != null) this.setScopeDoc(opts.docId)
      else if (opts.folderId != null) this.setScopeFolder(opts.folderId)
      else {
        this.scopeDocId = null
        this.scopeFolderId = null
      }
      this.currentSessionId = null
      this.messages = []
      this.open = true
      if (opts.message && opts.message.trim().length > 0) {
        this.pendingQuestion = opts.message.trim()
      }
    },

    async loadSessions(workspaceId: number): Promise<void> {
      this.workspaceId = workspaceId
      this.loadingSessions = true
      try {
        this.sessions = await $fetch<ChatSession[]>('/api/ai/chat/sessions', {
          query: { workspaceId },
        })
      }
      finally {
        this.loadingSessions = false
      }
    },

    /** Doc-scoped session list (Sprint 4 / F11). */
    async loadSessionsForDoc(workspaceId: number, docId: number): Promise<void> {
      this.workspaceId = workspaceId
      this.loadingSessions = true
      try {
        this.sessions = await $fetch<ChatSession[]>('/api/ai/chat/sessions', {
          query: { workspaceId, docId },
        })
      }
      finally {
        this.loadingSessions = false
      }
    },

    async selectSession(id: number | null): Promise<void> {
      if (id == null) {
        this.currentSessionId = null
        this.messages = []
        return
      }
      this.loadingMessages = true
      try {
        const detail = await $fetch<SessionDetailResponse>(`/api/ai/chat/sessions/${id}`)
        this.currentSessionId = detail.session.id
        this.workspaceId = detail.session.workspaceId
        this.scopeFolderId = detail.session.scopeFolderId ?? null
        this.scopeDocId = detail.session.scopeDocId ?? null
        this.messages = detail.messages.map(adaptMessage)
      }
      finally {
        this.loadingMessages = false
      }
    },

    newSession() {
      this.currentSessionId = null
      this.messages = []
    },

    async deleteSession(id: number): Promise<void> {
      await $fetch(`/api/ai/chat/sessions/${id}`, { method: 'DELETE' })
      this.sessions = this.sessions.filter(s => s.id !== id)
      if (this.currentSessionId === id) {
        this.currentSessionId = null
        this.messages = []
      }
    },

    /**
     * Regenerate an assistant reply. Finds the user message that immediately
     * preceded `assistantMessageId`, deletes that pair (and any later messages)
     * server-side AND locally, then re-streams a fresh answer for that same
     * user prompt.
     *
     * Only works on persisted messages (numeric ids). No-ops while sending.
     */
    async regenerate(assistantMessageId: number | string): Promise<void> {
      if (this.sending) return
      if (this.currentSessionId == null) return
      if (typeof assistantMessageId !== 'number') return

      const idx = this.messages.findIndex(m => m.id === assistantMessageId)
      if (idx <= 0) return
      const assistant = this.messages[idx]
      if (!assistant || assistant.role !== 'assistant') return

      // Walk back to the most recent user message — there should be exactly
      // one immediately before, but loop defensively in case a `system`
      // sneaks in.
      let userIdx = -1
      for (let i = idx - 1; i >= 0; i--) {
        const m = this.messages[i]
        if (m && m.role === 'user') { userIdx = i; break }
      }
      if (userIdx < 0) return
      const userMsg = this.messages[userIdx]
      if (!userMsg || typeof userMsg.id !== 'number') return

      const content = userMsg.content
      const sessionId = this.currentSessionId

      try {
        await $fetch(`/api/ai/chat/sessions/${sessionId}/messages`, {
          method: 'DELETE',
          body: { fromMessageId: userMsg.id },
        })
      }
      catch (err) {
        console.error('[chat] regenerate: delete failed', err)
        return
      }

      // Drop the user message + everything after it locally.
      this.messages = this.messages.slice(0, userIdx)
      await this.send(content)
    },

    /**
     * Edit a user message and re-send. PATCHes the message content, deletes
     * every later message (the now-stale assistant reply), updates the local
     * array, and streams a fresh answer.
     *
     * Only works on persisted messages (numeric ids). No-ops while sending.
     */
    async editAndResend(userMessageId: number | string, newContent: string): Promise<void> {
      if (this.sending) return
      if (this.currentSessionId == null) return
      if (typeof userMessageId !== 'number') return

      const trimmed = newContent.trim()
      if (trimmed.length === 0) return

      const idx = this.messages.findIndex(m => m.id === userMessageId)
      if (idx < 0) return
      const userMsg = this.messages[idx]
      if (!userMsg || userMsg.role !== 'user') return

      const sessionId = this.currentSessionId

      try {
        await $fetch(`/api/ai/chat/sessions/${sessionId}/messages/${userMessageId}`, {
          method: 'PATCH',
          body: { content: trimmed },
        })
      }
      catch (err) {
        console.error('[chat] editAndResend: patch failed', err)
        return
      }

      // Find the next persisted message id (if any) and delete from there on.
      // Anchoring on the first later message keeps the user's just-PATCHed
      // row intact while clearing the now-stale reply.
      let deleteFromId: number | null = null
      for (let i = idx + 1; i < this.messages.length; i++) {
        const m = this.messages[i]
        if (m && typeof m.id === 'number') { deleteFromId = m.id; break }
      }

      if (deleteFromId != null) {
        try {
          await $fetch(`/api/ai/chat/sessions/${sessionId}/messages`, {
            method: 'DELETE',
            body: { fromMessageId: deleteFromId },
          })
        }
        catch (err) {
          console.error('[chat] editAndResend: delete tail failed', err)
          return
        }
      }

      // Update locally: keep messages up to and including the edited user
      // message (with the new content), drop the rest. `send` will re-push
      // its own optimistic user + assistant rows, so we trim the edited
      // user message too — otherwise it would render twice.
      userMsg.content = trimmed
      this.messages = this.messages.slice(0, idx)
      await this.send(trimmed)
    },

    /**
     * Fork the current session at `messageId` (inclusive — that message and
     * every earlier one is copied into the new branch). Optimistic ids
     * (strings / negative numbers) are rejected since the row isn't
     * persisted yet — let the caller wait for the stream to finish.
     *
     * UX choice: after the POST succeeds we insert the new session at the
     * top of `state.sessions` (newest-first matches the GET response order)
     * and immediately switch the drawer to it. The parent session stays
     * intact — the user can still go back to it via the history list.
     *
     * Returns the new session for callers that want to chain on the result.
     */
    async branchFromMessage(messageId: number | string): Promise<ChatSession | null> {
      if (this.sending) return null
      if (this.currentSessionId == null) return null
      if (typeof messageId !== 'number' || messageId <= 0) return null

      const sessionId = this.currentSessionId

      let response: BranchResponse
      try {
        response = await $fetch<BranchResponse>(
          `/api/ai/chat/sessions/${sessionId}/branch`,
          {
            method: 'POST',
            body: { messageId },
          },
        )
      }
      catch (err) {
        console.error('[chat] branchFromMessage: failed', err)
        return null
      }

      // Insert the new branch at the top of the local list so it's
      // immediately visible in the history panel. If the user later calls
      // `loadSessions` we'll get a deterministic order from the server.
      this.sessions = [response.session, ...this.sessions.filter(s => s.id !== response.session.id)]

      // Switch the drawer to the new branch.
      this.currentSessionId = response.session.id
      this.scopeFolderId = response.session.scopeFolderId ?? null
      this.scopeDocId = response.session.scopeDocId ?? null
      this.messages = response.messages.map(adaptMessage)

      return response.session
    },

    /** True when the current session was created by branching from another. */
    isCurrentSessionBranch(): boolean {
      const id = this.currentSessionId
      if (id == null) return false
      const s = this.sessions.find(x => x.id === id)
      return s ? s.parentSessionId != null : false
    },

    /**
     * Stream-send the message. Uses native `fetch` so we can read the SSE
     * body via a ReadableStream (note: `$fetch` swallows the stream).
     */
    async send(message: string): Promise<void> {
      const trimmed = message.trim()
      if (trimmed.length === 0 || this.sending) return
      if (this.workspaceId == null) throw new Error('No active workspace')

      this.sending = true

      const tempUserId = `u-${Date.now()}`
      const tempAssistantId = `a-${Date.now()}`

      this.messages.push({
        id: tempUserId,
        role: 'user',
        content: trimmed,
        sources: [],
      })
      this.messages.push({
        id: tempAssistantId,
        role: 'assistant',
        content: '',
        sources: [],
        pending: true,
      })

      const findAssistant = (): UIChatMessage | undefined =>
        this.messages.find(m => m.id === tempAssistantId)

      try {
        const res = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
          },
          body: JSON.stringify({
            workspaceId: this.workspaceId,
            sessionId: this.currentSessionId ?? undefined,
            scopeFolderId: this.scopeFolderId,
            scopeDocId: this.scopeDocId,
            message: trimmed,
          }),
        })

        if (!res.ok || !res.body) {
          let detail = `HTTP ${res.status}`
          try {
            const data = await res.json() as { statusMessage?: string, data?: { detail?: string } }
            detail = data?.data?.detail ?? data?.statusMessage ?? detail
          }
          catch { /* ignore */ }

          // Friendly toast on rate-limit. The Retry-After header (seconds)
          // is set by `applyRateLimit` server-side.
          if (res.status === 429) {
            const retryAfter = Number(res.headers.get('Retry-After')) || 0
            const hint = retryAfter > 0
              ? `try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`
              : 'try again in a moment.'
            void useDialog().alert({
              title: 'Hold on a moment',
              message: `You're moving fast — ${hint}`,
            })
          }

          const a = findAssistant()
          if (a) {
            a.pending = false
            a.errored = true
            a.content = `Sorry — ${detail}`
          }
          return
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let createdSessionId: number | null = null
        let sources: ChatSource[] = []

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })

          let sep = buf.indexOf('\n\n')
          while (sep !== -1) {
            const frame = buf.slice(0, sep)
            buf = buf.slice(sep + 2)
            sep = buf.indexOf('\n\n')

            const payload = frame
              .split('\n')
              .filter(l => l.startsWith('data:'))
              .map(l => l.slice(5).trim())
              .join('\n')
            if (!payload) continue

            let event: { type: string, [k: string]: unknown }
            try {
              event = JSON.parse(payload) as { type: string }
            }
            catch {
              continue
            }

            const a = findAssistant()
            if (!a) continue

            if (event.type === 'session' && typeof event.sessionId === 'number') {
              createdSessionId = event.sessionId
              this.currentSessionId = event.sessionId
            }
            else if (event.type === 'sources' && Array.isArray(event.sources)) {
              sources = event.sources as ChatSource[]
              a.sources = sources
            }
            else if (event.type === 'delta' && typeof event.text === 'string') {
              a.content += event.text
            }
            else if (event.type === 'done') {
              a.pending = false
              if (Array.isArray(event.sources)) a.sources = event.sources as ChatSource[]
              if (typeof event.sessionId === 'number') {
                this.currentSessionId = event.sessionId
              }
            }
            else if (event.type === 'error') {
              a.pending = false
              a.errored = true
              const detail = typeof event.detail === 'string' ? event.detail : 'Mistral error'
              a.content = a.content
                ? `${a.content}\n\n[error: ${detail}]`
                : `Sorry — ${detail}`
            }
          }
        }

        const a = findAssistant()
        if (a) a.pending = false

        // Refresh the session list when a new session was created — pick the
        // right list depending on current scope so the new session shows up.
        if (createdSessionId != null && this.workspaceId != null) {
          const ws = this.workspaceId
          if (this.scopeDocId != null) {
            this.loadSessionsForDoc(ws, this.scopeDocId).catch(() => { /* noop */ })
          }
          else {
            this.loadSessions(ws).catch(() => { /* noop */ })
          }
        }
      }
      catch (err) {
        const a = findAssistant()
        if (a) {
          a.pending = false
          a.errored = true
          a.content = `Sorry — ${(err as Error).message ?? 'network error'}`
        }
      }
      finally {
        this.sending = false
      }
    },

    reset() {
      this.open = false
      this.currentSessionId = null
      this.sessions = []
      this.messages = []
      this.scopeFolderId = null
      this.scopeDocId = null
      this.workspaceId = null
      this.pendingQuestion = null
    },
  },
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChatStore, import.meta.hot))
}
