import { acceptHMRUpdate, defineStore } from 'pinia'
import { useStorage } from '@vueuse/core'
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
  /**
   * `documents.updatedAt` (unix seconds) at answer time. The UI surfaces a
   * "stale source" badge when this is greater than the message's `createdAt`.
   * Only set for `kind === 'note'` sources.
   */
  docUpdatedAt?: number
  /** Source kind: 'note' (default) or 'web' (Wave 2 / N5). */
  kind?: 'note' | 'web'
  /** URL for web sources — what `openSource` opens in a new tab. */
  url?: string
}

/** Proposed tool call surfaced by the server (Wave 4 / N8). In-memory only. */
export interface PendingToolCall {
  name: string
  arguments: Record<string, unknown>
}

export interface UIChatMessage {
  id: number | string         // negative / string for optimistic rows
  role: 'user' | 'assistant' | 'system'
  content: string
  sources: ChatSource[]
  pending?: boolean
  errored?: boolean
  /** Thumbs feedback (Wave 2 / N3). NULL/undefined = none, 1 = up, -1 = down. */
  userFeedback?: number | null
  /** Unix seconds — used by the stale-source badge to compare against doc updatedAt. */
  createdAt?: number
  /** Suggested next questions (Wave 2 / N4); chips rendered under the latest assistant reply. */
  followups?: string[]
  /** True when the server auto-triggered web search for this turn (user asked in natural language, toggle was off). */
  webAutoTriggered?: boolean
  /** Number of web hits found by the auto-triggered search; 0 = nothing matched. */
  webAutoHits?: number
  /** Per-turn debug meta (model used, web state, retrieval query, …). Populated from the SSE `meta` frame. */
  meta?: {
    model: string | null
    webRequested: boolean
    webAuto: boolean
    webHits: number
    /** Diagnostic payload from the web-search side-call (endpoint, status, raw sample, error, parser version). Null when web wasn't attempted. */
    webDebug: { endpoint: string, model: string, status: number | null, error?: string | null, rawSample?: string | null, parserVersion?: string | null } | null
    noteHits: number
    retrievalQuery: string
    rewriterUsed: boolean
    rerankerUsed: boolean
    rerankScoreAvg: number | null
    reasoning: boolean
    attachmentId: number | null
    allowWrites: boolean
    scopeDocId: number | null
    scopeFolderId: number | null
    temperature: number | null
  }
  /**
   * Working source list emitted by the server BEFORE the answer finishes
   * streaming (Wave 4 / N9). The UI renders a "searching X, Y, Z" hint
   * under the still-pending bubble; the final `done` frame replaces these
   * with the cited subset in `sources`.
   */
  partialSources?: ChatSource[]
  /**
   * Pending tool calls the assistant proposed (Wave 4 / N8). The bubble
   * renders an approve/reject card per call. In-memory only — once the
   * user decides, we POST to the approve endpoint and clear this.
   */
  pendingToolCalls?: PendingToolCall[]
  /**
   * Debug panel payload (Wave 3 / I5). Lazy: fetched on the first time the
   * user opens the inline debug panel for this message. `null` means the
   * server confirmed there's no matching rag_quality_logs row within the
   * 60s join window; `undefined` means we haven't asked yet.
   */
  debug?: {
    chunksReturned: number
    citationsEmitted: number
    rerankScoreAvg?: number | null
    rewriterUsed: boolean
    rerankerUsed: boolean
    latencyMs?: number | null
  } | null
}

interface PendingCitation {
  docId: number
  snippet: string
}

interface State {
  open: boolean
  /**
   * Height of the bottom-docked chat panel, in CSS pixels. Persisted to
   * localStorage so the dock keeps its size across reloads (VSCode-style).
   */
  dockHeight: number
  currentSessionId: number | null
  sessions: ChatSession[]
  /**
   * Whether more sessions are available past the current page (Wave 4 / I8).
   * Tracked alongside `sessions` so the UI can render a "Load more" affordance.
   */
  sessionsHasMore: boolean
  /** Active search query for the session history list. */
  sessionsSearch: string
  loadingMoreSessions: boolean
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
  /**
   * AbortController for the in-flight chat stream. Held so `stop()` can
   * abort the fetch mid-stream; the server reacts to the cancelled
   * ReadableStream and stops the Mistral SSE consumer.
   */
  abortController: AbortController | null
  /**
   * Persisted toggle for the "search the web if my notes don't answer"
   * fallback (Wave 2 / N5). Backed by useStorage so it survives reloads.
   */
  webFallbackEnabled: boolean
  /**
   * Persisted toggle for the "deep reasoning" mode (Wave 3 / N6). When on,
   * /api/ai/chat routes the conversation through `magistral-medium-latest`
   * with a slightly warmer temperature default.
   */
  reasoningEnabled: boolean
  /**
   * Persisted toggle for allowing the assistant to call note-mutation tools
   * (Wave 4 / N8). Each call still requires per-action approval.
   */
  allowWritesEnabled: boolean
  /**
   * Attachment queued for the next `send()` (Wave 4 / N7). The composer
   * shows a thumbnail; chat.send forwards the id to the server.
   */
  pendingAttachmentId: number | null
}

interface SessionDetailResponse {
  session: ChatSession
  messages: ChatMessage[]
}

interface SessionsListResponse {
  sessions: ChatSession[]
  hasMore: boolean
}

interface BranchResponse {
  session: ChatSession
  messages: ChatMessage[]
}

interface ToolCallApproveResponse {
  ok: boolean
  accepted: boolean
  message: {
    id: number | null
    role: 'assistant'
    content: string
    sources: ChatSource[]
    createdAt: number
  }
}

function adaptMessage(m: ChatMessage): UIChatMessage {
  // Drizzle wraps `created_at` (integer / mode: 'timestamp') in a JS Date on
  // read. Coerce to unix-seconds so the UI doesn't have to deal with two
  // shapes (the SSE `done` frame emits unix-seconds; persisted rows match).
  const createdAt = m.createdAt instanceof Date
    ? Math.floor(m.createdAt.getTime() / 1000)
    : (typeof m.createdAt === 'number' ? m.createdAt : undefined)
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    sources: (m.sources ?? []) as ChatSource[],
    userFeedback: m.userFeedback ?? null,
    createdAt,
  }
}

/**
 * Module-level reactive ref bound to localStorage. Pinia state seeds from
 * this on store creation; the setter below mirrors writes back.
 */
function readPersistedWebFallback(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return useStorage<boolean>('noteforge-chat-web-fallback', false).value === true
  }
  catch {
    return false
  }
}

function readPersistedReasoning(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return useStorage<boolean>('noteforge-chat-reasoning', false).value === true
  }
  catch {
    return false
  }
}

function readPersistedAllowWrites(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return useStorage<boolean>('noteforge-chat-allow-writes', false).value === true
  }
  catch {
    return false
  }
}

/** Min / max / default for the bottom dock height (px). */
export const DOCK_MIN_HEIGHT = 220
export const DOCK_MAX_HEIGHT = 900
const DOCK_DEFAULT_HEIGHT = 400

function clampDockHeight(px: number): number {
  if (!Number.isFinite(px)) return DOCK_DEFAULT_HEIGHT
  return Math.min(DOCK_MAX_HEIGHT, Math.max(DOCK_MIN_HEIGHT, Math.round(px)))
}

function readPersistedDockHeight(): number {
  if (typeof window === 'undefined') return DOCK_DEFAULT_HEIGHT
  try {
    return clampDockHeight(useStorage<number>('noteforge-chat-dock-height', DOCK_DEFAULT_HEIGHT).value)
  }
  catch {
    return DOCK_DEFAULT_HEIGHT
  }
}

export const useChatStore = defineStore('chat', {
  state: (): State => ({
    open: false,
    dockHeight: readPersistedDockHeight(),
    currentSessionId: null,
    sessions: [],
    sessionsHasMore: false,
    sessionsSearch: '',
    loadingMoreSessions: false,
    messages: [],
    scopeFolderId: null,
    scopeDocId: null,
    workspaceId: null,
    loadingSessions: false,
    loadingMessages: false,
    sending: false,
    pendingQuestion: null,
    pendingCitation: null,
    abortController: null,
    webFallbackEnabled: readPersistedWebFallback(),
    reasoningEnabled: readPersistedReasoning(),
    allowWritesEnabled: readPersistedAllowWrites(),
    pendingAttachmentId: null,
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

    /**
     * Persist + update the bottom dock height (clamped). Mirrors the value to
     * localStorage so the dock keeps its size across reloads.
     */
    setDockHeight(px: number) {
      const next = clampDockHeight(px)
      this.dockHeight = next
      if (typeof window !== 'undefined') {
        try {
          useStorage<number>('noteforge-chat-dock-height', DOCK_DEFAULT_HEIGHT).value = next
        }
        catch { /* localStorage disabled — ignore */ }
      }
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
        const query: Record<string, string | number> = { workspaceId }
        const q = this.sessionsSearch.trim()
        if (q.length > 0) query.q = q
        const res = await $fetch<SessionsListResponse>('/api/ai/chat/sessions', { query })
        this.sessions = res.sessions
        this.sessionsHasMore = res.hasMore
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
        const query: Record<string, string | number> = { workspaceId, docId }
        const q = this.sessionsSearch.trim()
        if (q.length > 0) query.q = q
        const res = await $fetch<SessionsListResponse>('/api/ai/chat/sessions', { query })
        this.sessions = res.sessions
        this.sessionsHasMore = res.hasMore
      }
      finally {
        this.loadingSessions = false
      }
    },

    /** Wave 4 / I8 — set the search query and refetch from offset=0. */
    async searchSessions(q: string): Promise<void> {
      this.sessionsSearch = q
      if (this.workspaceId == null) return
      if (this.scopeDocId != null) {
        await this.loadSessionsForDoc(this.workspaceId, this.scopeDocId)
      }
      else {
        await this.loadSessions(this.workspaceId)
      }
    },

    /** Wave 4 / I8 — append the next page to the existing list. */
    async loadMoreSessions(): Promise<void> {
      if (this.workspaceId == null) return
      if (!this.sessionsHasMore || this.loadingMoreSessions) return
      this.loadingMoreSessions = true
      try {
        const query: Record<string, string | number> = {
          workspaceId: this.workspaceId,
          offset: this.sessions.length,
        }
        const q = this.sessionsSearch.trim()
        if (q.length > 0) query.q = q
        if (this.scopeDocId != null) query.docId = this.scopeDocId
        const res = await $fetch<SessionsListResponse>('/api/ai/chat/sessions', { query })
        // De-dup just in case the server returns overlapping rows.
        const seen = new Set(this.sessions.map(s => s.id))
        for (const s of res.sessions) {
          if (!seen.has(s.id)) this.sessions.push(s)
        }
        this.sessionsHasMore = res.hasMore
      }
      finally {
        this.loadingMoreSessions = false
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
    async regenerate(
      assistantMessageId: number | string,
      opts?: {
        model?: string
        temperature?: number
        webFallback?: boolean
        reasoning?: boolean
        allowWrites?: boolean
      },
    ): Promise<void> {
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
      await this.send(content, opts)
    },

    /**
     * Persist a thumbs up / down (or clear) on an assistant message
     * (Wave 2 / N3). Optimistic: local state updates immediately;
     * rolls back on network failure.
     */
    async setFeedback(messageId: number | string, value: -1 | 0 | 1): Promise<void> {
      if (typeof messageId !== 'number') return
      const target = this.messages.find(m => m.id === messageId)
      if (!target || target.role !== 'assistant') return

      const previous = target.userFeedback ?? null
      target.userFeedback = value === 0 ? null : value

      try {
        await $fetch(`/api/ai/chat/messages/${messageId}/feedback`, {
          method: 'POST',
          body: { feedback: value },
        })
      }
      catch (err) {
        console.error('[chat] setFeedback failed', err)
        target.userFeedback = previous
      }
    },

    /**
     * Persist + update the web-fallback toggle (Wave 2 / N5). The value is
     * mirrored into localStorage so it survives reloads.
     */
    setWebFallbackEnabled(value: boolean) {
      this.webFallbackEnabled = value
      if (typeof window !== 'undefined') {
        try {
          useStorage<boolean>('noteforge-chat-web-fallback', false).value = value
        }
        catch { /* localStorage disabled — ignore */ }
      }
    },

    /**
     * Persist + update the deep-reasoning toggle (Wave 3 / N6). Mirrors the
     * value to localStorage so it survives reloads.
     */
    setReasoningEnabled(value: boolean) {
      this.reasoningEnabled = value
      if (typeof window !== 'undefined') {
        try {
          useStorage<boolean>('noteforge-chat-reasoning', false).value = value
        }
        catch { /* localStorage disabled — ignore */ }
      }
    },

    /**
     * Persist + update the "allow note edits" toggle (Wave 4 / N8). Each
     * tool call still requires per-action approval — this flag just lets the
     * model PROPOSE one.
     */
    setAllowWritesEnabled(value: boolean) {
      this.allowWritesEnabled = value
      if (typeof window !== 'undefined') {
        try {
          useStorage<boolean>('noteforge-chat-allow-writes', false).value = value
        }
        catch { /* localStorage disabled — ignore */ }
      }
    },

    /** Wave 4 / N7 — queue / clear an attachment for the next send. */
    setPendingAttachment(attachmentId: number | null) {
      this.pendingAttachmentId = attachmentId
    },

    /**
     * Wave 4 / N8 — approve or reject a proposed tool call. On approve the
     * server executes the underlying notes.ts primitive and returns an
     * assistant follow-up message that we splice into the conversation.
     */
    async respondToToolCall(
      messageId: number | string,
      callIndex: number,
      accept: boolean,
    ): Promise<void> {
      if (this.currentSessionId == null) return
      const target = this.messages.find(m => m.id === messageId)
      if (!target || !target.pendingToolCalls) return
      const call = target.pendingToolCalls[callIndex]
      if (!call) return

      // Optimistically clear this call so the card disappears immediately.
      const remaining = target.pendingToolCalls.filter((_, i) => i !== callIndex)
      target.pendingToolCalls = remaining.length > 0 ? remaining : undefined

      try {
        const res = await $fetch<ToolCallApproveResponse>(
          `/api/ai/chat/sessions/${this.currentSessionId}/tool-call/approve`,
          {
            method: 'POST',
            body: { accept, toolCall: { name: call.name, arguments: call.arguments } },
          },
        )
        this.messages.push({
          id: res.message.id ?? `tc-${Date.now()}`,
          role: res.message.role,
          content: res.message.content,
          sources: res.message.sources,
          createdAt: res.message.createdAt,
        })
      }
      catch (err) {
        console.error('[chat] respondToToolCall failed', err)
        // Put the call back so the user can retry.
        target.pendingToolCalls = [...(target.pendingToolCalls ?? []), call]
      }
    },

    /**
     * Fetch the per-message debug payload (Wave 3 / I5) and stash it on the
     * message. Lazy: only called when the user opens the inline debug panel.
     * No-ops on optimistic / non-persisted ids.
     */
    async fetchDebug(messageId: number | string): Promise<void> {
      if (typeof messageId !== 'number') return
      const target = this.messages.find(m => m.id === messageId)
      if (!target || target.role !== 'assistant') return
      try {
        const debug = await $fetch<UIChatMessage['debug']>(
          `/api/ai/chat/messages/${messageId}/debug`,
        )
        target.debug = debug ?? null
      }
      catch (err) {
        console.error('[chat] fetchDebug failed', err)
        target.debug = null
      }
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
     * Abort the in-flight chat stream. Safe to call when nothing is sending.
     * The server detects the closed ReadableStream and stops consuming
     * Mistral SSE, so no further tokens are billed.
     */
    stop() {
      const ac = this.abortController
      if (!ac) return
      try { ac.abort() }
      catch { /* noop */ }
    },

    /**
     * Stream-send the message. Uses native `fetch` so we can read the SSE
     * body via a ReadableStream (note: `$fetch` swallows the stream).
     *
     * `opts` allows per-turn overrides for the model (e.g. Magistral
     * reasoning toggle), temperature (regenerate-with-options), web-search
     * fallback, attached image (vision), and agentic tool calls. None of
     * them are required — defaults preserve the current behavior.
     */
    async send(
      message: string,
      opts?: {
        model?: string
        temperature?: number
        webFallback?: boolean
        reasoning?: boolean
        attachmentId?: number | null
        allowWrites?: boolean
      },
    ): Promise<void> {
      const trimmed = message.trim()
      if (trimmed.length === 0 || this.sending) return
      if (this.workspaceId == null) throw new Error('No active workspace')

      this.sending = true
      const ac = new AbortController()
      this.abortController = ac

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

      // Default the web-fallback flag to the persisted toggle when caller
      // hasn't passed an explicit value. Per-turn overrides (regenerate /
      // edit-and-resend chained through opts) still win.
      const useWebFallback = opts?.webFallback ?? this.webFallbackEnabled
      // Same pattern for the deep-reasoning toggle (Wave 3 / N6). When
      // reasoning is on AND the caller didn't pin a model, we DON'T send
      // `model` either — let the server pick Magistral. That keeps the
      // regen-options popover (which always sends `model`) independent.
      const useReasoning = opts?.reasoning ?? this.reasoningEnabled
      const useAllowWrites = opts?.allowWrites ?? this.allowWritesEnabled
      // Wave 4 / N7 — pull the queued attachment and clear it so the next
      // send isn't accidentally tied to the same image.
      const attachmentId = opts?.attachmentId ?? this.pendingAttachmentId
      this.pendingAttachmentId = null

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
            ...(opts?.model ? { model: opts.model } : {}),
            ...(opts?.temperature != null ? { temperature: opts.temperature } : {}),
            ...(useWebFallback ? { webFallback: true } : {}),
            ...(useReasoning ? { reasoning: true } : {}),
            ...(attachmentId != null ? { attachmentId } : {}),
            ...(useAllowWrites ? { allowWrites: true } : {}),
          }),
          signal: ac.signal,
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
            else if (event.type === 'partial_sources' && Array.isArray(event.sources)) {
              // Wave 4 / N9 — show "searching X, Y, Z" while the answer
              // streams. Cleared / overridden by the final `done` frame.
              a.partialSources = event.sources as ChatSource[]
            }
            else if (event.type === 'web_auto') {
              // Server detected a "search the web" intent in the user
              // message and ran web search even though the toggle was off.
              // We flag the assistant message so the UI shows a small badge.
              a.webAutoTriggered = true
              if (typeof event.hits === 'number') a.webAutoHits = event.hits
            }
            else if (event.type === 'meta') {
              // Per-turn debug meta. Snapshot whatever the server sent —
              // the debug panel renders this as a small grid + copy-paste blob.
              const wd = event.webDebug
              const webDebug = wd && typeof wd === 'object'
                ? {
                    endpoint: typeof (wd as { endpoint?: unknown }).endpoint === 'string' ? (wd as { endpoint: string }).endpoint : '',
                    model: typeof (wd as { model?: unknown }).model === 'string' ? (wd as { model: string }).model : '',
                    status: typeof (wd as { status?: unknown }).status === 'number' ? (wd as { status: number }).status : null,
                    error: typeof (wd as { error?: unknown }).error === 'string' ? (wd as { error: string }).error : null,
                    rawSample: typeof (wd as { rawSample?: unknown }).rawSample === 'string' ? (wd as { rawSample: string }).rawSample : null,
                    parserVersion: typeof (wd as { parserVersion?: unknown }).parserVersion === 'string' ? (wd as { parserVersion: string }).parserVersion : null,
                  }
                : null
              a.meta = {
                model: typeof event.model === 'string' ? event.model : null,
                webRequested: event.webRequested === true,
                webAuto: event.webAuto === true,
                webHits: typeof event.webHits === 'number' ? event.webHits : 0,
                webDebug,
                noteHits: typeof event.noteHits === 'number' ? event.noteHits : 0,
                retrievalQuery: typeof event.retrievalQuery === 'string' ? event.retrievalQuery : '',
                rewriterUsed: event.rewriterUsed === true,
                rerankerUsed: event.rerankerUsed === true,
                rerankScoreAvg: typeof event.rerankScoreAvg === 'number' ? event.rerankScoreAvg : null,
                reasoning: event.reasoning === true,
                attachmentId: typeof event.attachmentId === 'number' ? event.attachmentId : null,
                allowWrites: event.allowWrites === true,
                scopeDocId: typeof event.scopeDocId === 'number' ? event.scopeDocId : null,
                scopeFolderId: typeof event.scopeFolderId === 'number' ? event.scopeFolderId : null,
                temperature: typeof event.temperature === 'number' ? event.temperature : null,
              }
            }
            else if (event.type === 'tool_call_pending' && Array.isArray(event.calls)) {
              // Wave 4 / N8 — assistant proposes a write. The UI renders an
              // approve / reject card under the bubble.
              const calls = (event.calls as unknown[]).filter(
                (c): c is PendingToolCall =>
                  !!c && typeof c === 'object'
                  && typeof (c as PendingToolCall).name === 'string'
                  && !!(c as PendingToolCall).arguments,
              )
              if (calls.length > 0) a.pendingToolCalls = calls
            }
            else if (event.type === 'delta' && typeof event.text === 'string') {
              a.content += event.text
            }
            else if (event.type === 'followups' && Array.isArray(event.items)) {
              const items = (event.items as unknown[])
                .filter((it): it is string => typeof it === 'string' && it.trim().length > 0)
              a.followups = items.slice(0, 3)
            }
            else if (event.type === 'done') {
              a.pending = false
              if (Array.isArray(event.sources)) a.sources = event.sources as ChatSource[]
              // Drop the partial-sources hint once the cited list is in.
              a.partialSources = undefined
              if (typeof event.sessionId === 'number') {
                this.currentSessionId = event.sessionId
              }
              // Wave 2 / I4: swap the optimistic string id with the
              // persisted numeric one so the feedback POST can target it.
              // Fallback to Date.now() in unix-seconds when the server
              // didn't return a createdAt (older deployments).
              if (typeof event.messageId === 'number') a.id = event.messageId
              if (typeof event.createdAt === 'number') a.createdAt = event.createdAt
              else a.createdAt = Math.floor(Date.now() / 1000)
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
        const isAbort = (err as { name?: string }).name === 'AbortError'
        if (a) {
          a.pending = false
          if (isAbort) {
            // User clicked Stop — keep whatever tokens we already streamed.
            if (a.content.length === 0) a.content = '[stopped]'
          }
          else {
            a.errored = true
            a.content = `Sorry — ${(err as Error).message ?? 'network error'}`
          }
        }
      }
      finally {
        this.sending = false
        this.abortController = null
      }
    },

    reset() {
      this.open = false
      this.currentSessionId = null
      this.sessions = []
      this.sessionsHasMore = false
      this.sessionsSearch = ''
      this.messages = []
      this.scopeFolderId = null
      this.scopeDocId = null
      this.workspaceId = null
      this.pendingQuestion = null
      this.pendingAttachmentId = null
    },
  },
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChatStore, import.meta.hot))
}
