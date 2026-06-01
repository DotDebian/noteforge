<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useChatStore, type ChatSource, type PendingToolCall, type UIChatMessage } from '~/stores/chat'
import { useWorkspacesStore } from '~/stores/workspaces'
import { useTreeStore } from '~/stores/tree'
import { renderMarkdown } from '~/composables/useMarkdownView'
import { useLocale } from '~/composables/useLocale'

const { t, locale } = useLocale()
const router = useRouter()

const emit = defineEmits<{
  (e: 'open-doc', docId: number): void
}>()

const chat = useChatStore()
const workspaces = useWorkspacesStore()
const tree = useTreeStore()

const {
  open, dockHeight, sessions, messages, currentSessionId, scopeFolderId, scopeDocId,
  sending, loadingSessions, pendingQuestion, webFallbackEnabled, reasoningEnabled,
  allowWritesEnabled, pendingAttachmentId, sessionsHasMore, loadingMoreSessions,
} = storeToRefs(chat)

/* ---------- Bottom dock resize (VSCode-style) ----------
 *
 * The dock is a flex child at the bottom of `.app-main`; dragging the handle
 * on its top edge resizes it. We track the pointer delta against the height
 * at drag-start and push the clamped value back to the store (which persists
 * it). Dragging up grows the panel, so height = startHeight + (startY - y). */
const resizing = ref(false)
let resizeStartY = 0
let resizeStartHeight = 0

function onResizePointerMove(e: PointerEvent) {
  if (!resizing.value) return
  chat.setDockHeight(resizeStartHeight + (resizeStartY - e.clientY))
}

function endResize() {
  if (!resizing.value) return
  resizing.value = false
  window.removeEventListener('pointermove', onResizePointerMove)
  window.removeEventListener('pointerup', endResize)
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
}

function startResize(e: PointerEvent) {
  e.preventDefault()
  resizing.value = true
  resizeStartY = e.clientY
  resizeStartHeight = dockHeight.value
  window.addEventListener('pointermove', onResizePointerMove)
  window.addEventListener('pointerup', endResize)
  // Suppress text selection / show the resize cursor for the whole drag.
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'ns-resize'
}

const draft = ref('')
const composer = ref<HTMLTextAreaElement | null>(null)
const scrollArea = ref<HTMLElement | null>(null)
const sessionsOpen = ref(false)

const workspaceId = computed(() => workspaces.currentWorkspaceId)

// Flat list of folders for the scope selector. Folders are keyed by id; we
// just show their flat name (the tree store keeps a 1-level depth in `folders`).
const folderOptions = computed(() =>
  [...tree.folders].sort((a, b) => a.name.localeCompare(b.name)),
)

/* ---------- Scroll lock (Wave 4 / I9) ----------
 *
 * When the user scrolls up to re-read context, we MUST NOT yank them back to
 * the latest token on every delta. We track distance from the bottom on the
 * scroll listener; when it crosses a threshold the autoscroll watcher is
 * disabled and a floating "jump to latest" button appears. Clicking it (or
 * scrolling close enough to the bottom on your own) re-enables autoscroll. */
const SCROLL_LOCK_THRESHOLD = 120
const userIsAwayFromBottom = ref(false)

function updateScrollLock() {
  const el = scrollArea.value
  if (!el) return
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight
  userIsAwayFromBottom.value = distance > SCROLL_LOCK_THRESHOLD
}

function scrollToBottom(force = false) {
  nextTick(() => {
    const el = scrollArea.value
    if (!el) return
    if (!force && userIsAwayFromBottom.value) return
    el.scrollTop = el.scrollHeight
  })
}

function jumpToLatest() {
  userIsAwayFromBottom.value = false
  scrollToBottom(true)
}

watch(messages, () => scrollToBottom(), { deep: true })

async function refreshSessions() {
  if (workspaceId.value == null) return
  if (scopeDocId.value != null) {
    await chat.loadSessionsForDoc(workspaceId.value, scopeDocId.value)
  }
  else {
    await chat.loadSessions(workspaceId.value)
  }
}

watch(open, async (isOpen) => {
  if (!isOpen) return
  if (workspaceId.value != null && chat.workspaceId !== workspaceId.value) {
    chat.setWorkspace(workspaceId.value)
  }
  await refreshSessions()
  const pending = chat.consumePendingQuestion()
  if (pending) {
    draft.value = pending
    await nextTick()
    composer.value?.focus({ preventScroll: true })
  }
  else {
    composer.value?.focus({ preventScroll: true })
  }
  scrollToBottom()
})

// If the drawer is already open and another part of the app (e.g. the
// editor's "cite paragraph in chat" bubble menu button) queues a question,
// the `open` watch above will not fire (true→true is not a change). Watch
// `pendingQuestion` directly so the composer prefills regardless.
watch(pendingQuestion, async (next) => {
  if (!next) return
  if (!open.value) return  // openWithScope sets open=true first; the open watch handles that path
  const pending = chat.consumePendingQuestion()
  if (!pending) return
  draft.value = pending
  await nextTick()
  composer.value?.focus({ preventScroll: true })
})

// Re-fetch the session list when the user toggles between doc scope and
// workspace scope while the drawer is open — the two lists are disjoint.
watch(scopeDocId, async () => {
  if (open.value) await refreshSessions()
})

watch(workspaceId, (id) => {
  if (id != null) chat.setWorkspace(id)
})

async function onSend() {
  const text = draft.value.trim()
  if (!text || sending.value) return
  draft.value = ''
  // The store reads `pendingAttachmentId` and clears it. We keep the
  // thumbnail reactive via storeToRefs so the composer empties on its own.
  await chat.send(text)
}

/* ---------- Attach image (Wave 4 / N7) ---------- */
const fileInput = ref<HTMLInputElement | null>(null)
const attachUploading = ref(false)

function triggerAttachPick() {
  if (attachUploading.value || sending.value) return
  fileInput.value?.click()
}

async function onAttachPick(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''  // allow re-picking the same file later
  if (!file) return
  if (workspaceId.value == null) return

  attachUploading.value = true
  try {
    const form = new FormData()
    form.append('workspaceId', String(workspaceId.value))
    form.append('file', file)
    const res = await $fetch<{ id: number, url: string }>('/api/uploads', {
      method: 'POST',
      body: form,
    })
    chat.setPendingAttachment(res.id)
  }
  catch (err) {
    console.error('[chat] attach upload failed', err)
  }
  finally {
    attachUploading.value = false
  }
}

function clearAttachment() {
  chat.setPendingAttachment(null)
}

const pendingAttachmentUrl = computed(() => {
  const id = pendingAttachmentId.value
  return id != null ? `/api/uploads/${id}` : null
})

/* ---------- Session search & pagination (Wave 4 / I8) ---------- */
const sessionsSearchInput = ref('')
let sessionsSearchTimer: ReturnType<typeof setTimeout> | null = null

function onSessionsSearchInput(value: string) {
  sessionsSearchInput.value = value
  if (sessionsSearchTimer) clearTimeout(sessionsSearchTimer)
  sessionsSearchTimer = setTimeout(() => {
    void chat.searchSessions(value)
  }, 250)
}

async function onLoadMoreSessions() {
  await chat.loadMoreSessions()
}

/* ---------- Conversation export (Wave 4 / N10) ---------- */
function onExportSession(id: number) {
  // Browser handles the download via Content-Disposition. We use window.open
  // so the user keeps the drawer open (vs. navigating away).
  window.open(`/api/ai/chat/sessions/${id}/export`, '_blank', 'noopener,noreferrer')
}

/* ---------- Tool calls (Wave 4 / N8) ---------- */
async function approveToolCall(m: UIChatMessage, idx: number) {
  if (typeof m.id !== 'number' && typeof m.id !== 'string') return
  await chat.respondToToolCall(m.id, idx, true)
}

async function rejectToolCall(m: UIChatMessage, idx: number) {
  if (typeof m.id !== 'number' && typeof m.id !== 'string') return
  await chat.respondToToolCall(m.id, idx, false)
}

function formatToolCallSummary(call: PendingToolCall): string {
  const args = call.arguments
  if (call.name === 'create_note') {
    return `create_note · "${(args.title as string | undefined) ?? '(no title)'}"`
  }
  if (call.name === 'update_note') {
    return `update_note · #${args.documentId ?? '?'}`
  }
  if (call.name === 'delete_note') {
    return `delete_note · #${args.documentId ?? '?'}`
  }
  return call.name
}

function formatToolCallArgs(call: PendingToolCall): string {
  try {
    return JSON.stringify(call.arguments, null, 2)
  }
  catch {
    return String(call.arguments)
  }
}

/* ---------- No-notes-matched help card (Wave 4 / I10) ---------- */
const NO_NOTES_HINT_RE = /(don't|do not|no notes|aucune|je n'ai|pas trouvé)/i

function showNoNotesHelp(m: UIChatMessage): boolean {
  if (m.role !== 'assistant' || m.pending || m.errored) return false
  if (m.sources.length > 0) return false
  // Only the very first turn — once there's history, the user already
  // knows the model has limited data and we'd rather not nag.
  if (messages.value.filter(x => x.role === 'assistant').length !== 1) return false
  const lower = m.content.toLowerCase()
  return NO_NOTES_HINT_RE.test(lower)
}

async function onEnableWebAndRetry(m: UIChatMessage) {
  chat.setWebFallbackEnabled(true)
  // Find the preceding user message and re-send it via the regenerate path.
  if (typeof m.id !== 'number') return
  await chat.regenerate(m.id, { webFallback: true })
}

function onGoToWorkspace() {
  const id = workspaceId.value
  if (id == null) return
  chat.close()
  router.push(`/workspace/${id}`)
}

async function newSession() {
  chat.newSession()
  await nextTick()
  composer.value?.focus({ preventScroll: true })
}

async function pickSession(id: number) {
  sessionsOpen.value = false
  await chat.selectSession(id)
  scrollToBottom()
}

async function removeSession(id: number) {
  await chat.deleteSession(id)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void onSend()
  }
}

function onStop() {
  chat.stop()
}

/* ---------------- Copy answer to clipboard ---------------- */
const copiedId = ref<number | string | null>(null)
async function onCopy(m: UIChatMessage) {
  if (!m.content) return
  try {
    await navigator.clipboard.writeText(m.content)
    copiedId.value = m.id
    setTimeout(() => {
      if (copiedId.value === m.id) copiedId.value = null
    }, 1500)
  }
  catch {
    // Older browsers / insecure contexts — fall back to a textarea hack.
    const ta = document.createElement('textarea')
    ta.value = m.content
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus(); ta.select()
    try { document.execCommand('copy'); copiedId.value = m.id }
    catch { /* noop */ }
    document.body.removeChild(ta)
    setTimeout(() => {
      if (copiedId.value === m.id) copiedId.value = null
    }, 1500)
  }
}

function openSource(s: ChatSource) {
  // Web sources don't have an in-app destination — pop the URL in a new tab.
  if (s.kind === 'web' && s.url) {
    window.open(s.url, '_blank', 'noopener,noreferrer')
    return
  }
  // Prefer the per-source `highlight` (the single sentence inside the chunk
  // that actually supports the AI's claim, computed server-side post-stream).
  // Fall back to the full `snippet` for older messages.
  const target = s.highlight && s.highlight.length >= 12 ? s.highlight : s.snippet
  chat.queueCitation(s.docId, target)
  chat.close()
  emit('open-doc', s.docId)
}

/* ---------------- Edit / regenerate (per-message actions) ---------------- */

const editingId = ref<number | string | null>(null)
const editDraft = ref('')

function isPersisted(id: number | string): id is number {
  return typeof id === 'number'
}

function startEdit(msgId: number | string, content: string) {
  if (sending.value) return
  if (!isPersisted(msgId)) return
  editingId.value = msgId
  editDraft.value = content
}

function cancelEdit() {
  editingId.value = null
  editDraft.value = ''
}

async function saveEdit(msgId: number | string) {
  if (sending.value) return
  if (!isPersisted(msgId)) return
  const next = editDraft.value.trim()
  if (next.length === 0) return
  const id = msgId
  cancelEdit()
  await chat.editAndResend(id, next)
}

async function onRegenerate(msgId: number | string) {
  if (sending.value) return
  if (!isPersisted(msgId)) return
  await chat.regenerate(msgId)
}

/* ---------------- Regenerate options popover (Wave 2 / I3) ---------------- */

// Ordered cheapest → most expensive. `mistral-medium-latest` is the default —
// roughly 5× cheaper than Large for ~95% of the quality on RAG-grounded chats.
// `mistral-large-latest` is opt-in for the cases where Medium drifts.
const REGEN_MODELS = [
  { id: 'mistral-small-latest', label: 'Small (fast, $)' },
  { id: 'mistral-medium-latest', label: 'Medium (default, $$)' },
  { id: 'mistral-large-latest', label: 'Large (best, $$$)' },
  { id: 'magistral-medium-latest', label: 'Deep reasoning ($$$)' },
] as const

const regenOpenForId = ref<number | string | null>(null)
const regenModel = ref<string>('mistral-medium-latest')
const regenTemp = ref<number>(0.2)

function toggleRegenOptions(msgId: number | string) {
  if (regenOpenForId.value === msgId) {
    regenOpenForId.value = null
    return
  }
  // Reset to sensible defaults each time we open — matches the chat.post.ts
  // defaults so what the user sees mirrors what the server would do.
  regenModel.value = 'mistral-medium-latest'
  regenTemp.value = 0.2
  regenOpenForId.value = msgId
}

function closeRegenOptions() {
  regenOpenForId.value = null
}

async function regenWithOptions(msgId: number | string) {
  if (sending.value) return
  if (!isPersisted(msgId)) return
  const model = regenModel.value
  const temperature = Number(regenTemp.value)
  closeRegenOptions()
  await chat.regenerate(msgId, { model, temperature })
}

/* ---------------- Feedback (Wave 2 / N3) ---------------- */

async function onFeedback(m: UIChatMessage, direction: 1 | -1) {
  if (typeof m.id !== 'number') return
  const current = m.userFeedback ?? 0
  // Click on the active side → clear. Click on the other side → switch.
  const next = current === direction ? 0 : direction
  await chat.setFeedback(m.id, next as -1 | 0 | 1)
}

/* ---------------- Stale source badge (Wave 2 / I4) ---------------- */

function isStaleSource(m: UIChatMessage, s: ChatSource): boolean {
  if (s.kind === 'web') return false
  if (typeof m.createdAt !== 'number') return false
  if (typeof s.docUpdatedAt !== 'number') return false
  // Add a small slack so equal timestamps don't false-positive on the
  // common "doc saved within the same second" path.
  return s.docUpdatedAt > m.createdAt + 1
}

/* ---------------- Suggested follow-ups (Wave 2 / N4) ---------------- */

const lastAssistantId = computed(() => {
  for (let i = messages.value.length - 1; i >= 0; i--) {
    const m = messages.value[i]
    if (m && m.role === 'assistant' && !m.pending && !m.errored) return m.id
  }
  return null
})

function isLastAssistant(m: UIChatMessage): boolean {
  return lastAssistantId.value === m.id
}

async function onFollowup(question: string) {
  if (sending.value) return
  draft.value = question
  await nextTick()
  await onSend()
}

/* ---------------- Web fallback toggle (Wave 2 / N5) ---------------- */

function onToggleWebFallback(e: Event) {
  const checked = (e.target as HTMLInputElement).checked
  chat.setWebFallbackEnabled(checked)
}

/* ---------------- Deep reasoning toggle (Wave 3 / N6) ---------------- */

function onToggleReasoning(e: Event) {
  const checked = (e.target as HTMLInputElement).checked
  chat.setReasoningEnabled(checked)
}

/* ---------------- Allow note edits toggle (Wave 4 / N8) ---------------- */

function onToggleAllowWrites(e: Event) {
  const checked = (e.target as HTMLInputElement).checked
  chat.setAllowWritesEnabled(checked)
}

/* ---------------- Debug panel (Wave 3 / I5) ---------------- */

const debugOpenFor = ref<Set<number | string>>(new Set())

function isDebugOpen(id: number | string): boolean {
  return debugOpenFor.value.has(id)
}

async function toggleDebug(m: UIChatMessage) {
  if (debugOpenFor.value.has(m.id)) {
    // Close: copy the set so Vue picks up the change reactively.
    const next = new Set(debugOpenFor.value)
    next.delete(m.id)
    debugOpenFor.value = next
    return
  }
  const next = new Set(debugOpenFor.value)
  next.add(m.id)
  debugOpenFor.value = next
  if (m.debug === undefined && typeof m.id === 'number') {
    await chat.fetchDebug(m.id)
  }
}

function formatRerank(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return value.toFixed(2)
}

function formatLatency(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

function shortEndpoint(url: string): string {
  if (!url) return '—'
  try {
    const u = new URL(url)
    return `${u.hostname}${u.pathname}`
  }
  catch { return url.slice(0, 60) }
}

/* ---------------- Debug blob copier (paste-to-share) ---------------- */

const debugCopiedId = ref<number | string | null>(null)

/** Find the preceding user message text (best-effort) for context. */
function previousUserContent(m: UIChatMessage): string {
  const idx = messages.value.findIndex(x => x.id === m.id)
  if (idx <= 0) return ''
  for (let i = idx - 1; i >= 0; i--) {
    const prev = messages.value[i]
    if (prev && prev.role === 'user') return prev.content
  }
  return ''
}

async function copyDebug(m: UIChatMessage) {
  const blob = {
    locale: locale.value,
    sessionId: currentSessionId.value,
    messageId: m.id,
    role: m.role,
    user: previousUserContent(m),
    assistant: m.content,
    sources: m.sources.map(s => ({
      title: s.title,
      kind: s.kind ?? 'note',
      url: s.url,
      docId: s.docId,
      citation: s.citation,
    })),
    followups: m.followups ?? [],
    webAutoTriggered: m.webAutoTriggered === true,
    webAutoHits: m.webAutoHits,
    meta: m.meta ?? null,
    debug: m.debug ?? null,
  }
  const text = `\`\`\`json\n${JSON.stringify(blob, null, 2)}\n\`\`\``
  try {
    await navigator.clipboard.writeText(text)
    debugCopiedId.value = m.id
    setTimeout(() => {
      if (debugCopiedId.value === m.id) debugCopiedId.value = null
    }, 1800)
  }
  catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus(); ta.select()
    try { document.execCommand('copy'); debugCopiedId.value = m.id } catch {}
    document.body.removeChild(ta)
    setTimeout(() => {
      if (debugCopiedId.value === m.id) debugCopiedId.value = null
    }, 1800)
  }
}

/* ---------------- Branching (fork a session at a message) ---------------- */

const branchingId = ref<number | string | null>(null)

async function onBranch(msgId: number | string) {
  if (sending.value) return
  if (!isPersisted(msgId)) return
  if (branchingId.value != null) return
  branchingId.value = msgId
  try {
    await chat.branchFromMessage(msgId)
  }
  finally {
    branchingId.value = null
  }
}

/**
 * Lookup table for parent session titles, used by the "↪ branched from …"
 * tooltip in the history list. If the parent isn't in the local list (was
 * deleted, lives outside the current scope, etc.) we fall back to a generic
 * label rather than hiding the indicator entirely.
 */
const sessionTitlesById = computed(() => {
  const map = new Map<number, string>()
  for (const s of sessions.value) map.set(s.id, s.title)
  return map
})

function isBranch(session: { parentSessionId: number | null }): boolean {
  return session.parentSessionId != null
}

/**
 * Current session metadata used by the inline branch indicator at the top
 * of the message list. Null when the current session isn't a branch (most
 * of the time).
 */
const currentBranchInfo = computed(() => {
  const id = currentSessionId.value
  if (id == null) return null
  const s = sessions.value.find(x => x.id === id)
  if (!s || s.parentSessionId == null) return null
  return {
    parentSessionId: s.parentSessionId,
    branchFromMessageId: s.branchFromMessageId,
    parentTitle: sessionTitlesById.value.get(s.parentSessionId) ?? null,
  }
})

async function openParentSession() {
  const info = currentBranchInfo.value
  if (!info) return
  await pickSession(info.parentSessionId)
}

function branchedFromLabel(parentId: number | null): string {
  if (parentId == null) return ''
  const t = sessionTitlesById.value.get(parentId)
  return t
    ? L.value.branchedFrom.replace('{title}', t)
    : L.value.branchedFromUnknown
}

/* ---------------- Local i18n (avoid editing useLocale.ts) ---------------- */

const L = computed(() => locale.value === 'fr'
  ? {
      branch: 'Brancher',
      branchTitle: 'Brancher d’ici (créer une copie jusqu’à ce message)',
      branchPending: 'Branchement…',
      branchedFrom: 'Branché depuis « {title} »',
      branchedFromUnknown: 'Branché depuis une session',
      optionsTitle: 'Options',
      webAutoOn: 'Recherche web activée pour ce tour',
      webAutoEmpty: 'Recherche web : aucun résultat',
      webAutoTitle: 'NoteForge a détecté que vous demandiez une recherche web et l’a lancée pour ce tour, même si l’option est désactivée.',
      debugCopy: 'Copier',
      debugCopied: 'Copié',
      debugCopyTitle: 'Copier les infos debug (à coller pour rapporter un souci)',
    }
  : {
      branch: 'Branch',
      branchTitle: 'Branch from here (copy up to this message into a new session)',
      branchPending: 'Branching…',
      branchedFrom: 'Branched from "{title}"',
      branchedFromUnknown: 'Branched from another session',
      optionsTitle: 'Options',
      webAutoOn: 'Web search auto-enabled for this turn',
      webAutoEmpty: 'Web search returned no results',
      webAutoTitle: 'NoteForge detected a web-search intent in your message and ran a one-off search even though the option is off.',
      debugCopy: 'Copy',
      debugCopied: 'Copied',
      debugCopyTitle: 'Copy debug info (paste it back when reporting an issue)',
    })

/* ---------------- Composer focus + options popover ---------------- */

const composerFocused = ref(false)
const optionsOpen = ref(false)

const anyOptionEnabled = computed(() =>
  webFallbackEnabled.value || reasoningEnabled.value || allowWritesEnabled.value,
)

function toggleOptions() {
  optionsOpen.value = !optionsOpen.value
}

/**
 * Close the options popover when the user clicks anywhere outside of it.
 * Bound on mount, cleaned up on unmount.
 */
function handleDocumentClick(e: MouseEvent) {
  if (!optionsOpen.value) return
  const t = e.target as HTMLElement | null
  if (!t) return
  if (t.closest('.composer-options-popover')) return
  if (t.closest('.composer-icon-btn')) return
  optionsOpen.value = false
}

function onEditKeydown(e: KeyboardEvent, msgId: number | string) {
  if (e.key === 'Escape') {
    e.preventDefault()
    cancelEdit()
    return
  }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    void saveEdit(msgId)
  }
}

/**
 * Wave 4 / N7 — extract a leading `![image](/api/uploads/<id>)` so we can
 * render it as a thumbnail above the user-message text. Returns the image
 * url plus the cleaned message body (with the image markdown stripped).
 */
const USER_IMAGE_RE = /^!\[image\]\((\/api\/uploads\/\d+)\)\s*\n*/
function extractUserAttachment(content: string): { url: string | null, body: string } {
  const m = content.match(USER_IMAGE_RE)
  if (!m) return { url: null, body: content }
  return { url: m[1] ?? null, body: content.slice(m[0].length) }
}

onMounted(() => {
  if (workspaceId.value != null && chat.workspaceId !== workspaceId.value) {
    chat.setWorkspace(workspaceId.value)
  }
  document.addEventListener('mousedown', handleDocumentClick, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleDocumentClick, true)
  endResize()
})

// Title of the doc the chat is currently pinned to (if any). The tree store
// only carries lightweight rows; this works for any doc that lives in the
// current workspace's tree (which is what "Ask this doc" enforces).
const scopedDocTitle = computed(() => {
  const id = scopeDocId.value
  if (id == null) return null
  const found = tree.documents.find(d => d.id === id)
  return found?.title || t('chat.pinnedFallback')
})

function setScope(value: string) {
  // Selecting the special "doc" entry is only meaningful when a doc scope is
  // already active (set via "Ask this doc"). Folder ids are numeric.
  if (value === 'workspace') {
    chat.setScopeDoc(null)
    chat.setScopeFolder(null)
    return
  }
  if (value === 'doc') {
    // Keep the existing scopeDocId as-is.
    chat.setScopeFolder(null)
    return
  }
  chat.setScopeDoc(null)
  chat.setScopeFolder(Number(value))
}

const scopeValue = computed(() => {
  if (scopeDocId.value != null) return 'doc'
  if (scopeFolderId.value != null) return String(scopeFolderId.value)
  return 'workspace'
})
</script>

<template>
  <!-- Desktop: bottom-docked panel (VSCode-style) — a flex child of `.app-main`
       that pushes content up. Mobile: the CSS pins it (position: fixed) so it
       OVERLAYS content instead, with a tap-to-dismiss backdrop below md. -->
  <Transition name="fade">
    <div
      v-if="open"
      class="chat-mobile-backdrop md:hidden"
      aria-hidden="true"
      @click="chat.close()"
    />
  </Transition>
  <Transition name="slide-up">
    <aside
      v-if="open"
      class="chat-dock flex w-full shrink-0 flex-col border-t border-ink-200 bg-white dark:border-ink-800/60 dark:bg-ink-900"
      :class="{ 'chat-dock--resizing': resizing }"
      :style="{ height: dockHeight + 'px' }"
    >
      <!-- Resize handle: drag the top edge to grow / shrink the dock. -->
      <div
        class="dock-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        :aria-label="t('chat.resize')"
        :title="t('chat.resize')"
        @pointerdown="startResize"
      />
        <!-- Header -->
        <header class="flex items-center gap-2 border-b border-ink-200 px-4 py-3 dark:border-ink-800/60">
          <div class="flex-1 min-w-0">
            <h2 class="font-serif text-base font-semibold text-ink-900 dark:text-ink-50">{{ t('chat.title') }}</h2>
            <p class="truncate text-xs text-ink-500 dark:text-ink-400">
              <template v-if="scopedDocTitle">
                {{ t('chat.subtitlePinnedPrefix') }} <span class="font-medium text-ink-700 dark:text-ink-200">{{ scopedDocTitle }}</span>
              </template>
              <template v-else>
                {{ t('chat.subtitleDefault') }}
              </template>
            </p>
          </div>
          <button
            class="rounded-md p-1.5 text-ink-500 hover:bg-ink-100 hover:text-ink-800 dark:text-ink-400 dark:hover:bg-ink-800 dark:hover:text-ink-50"
            :title="t('chat.newChat')"
            @click="newSession"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <button
            class="rounded-md p-1.5 text-ink-500 hover:bg-ink-100 hover:text-ink-800 dark:text-ink-400 dark:hover:bg-ink-800 dark:hover:text-ink-50"
            :title="t('chat.history')"
            @click="sessionsOpen = !sessionsOpen"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 5h18M3 12h18M3 19h18"/></svg>
          </button>
          <button
            class="rounded-md p-1.5 text-ink-500 hover:bg-ink-100 hover:text-ink-800 dark:text-ink-400 dark:hover:bg-ink-800 dark:hover:text-ink-50"
            :title="t('chat.close')"
            @click="chat.close()"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </header>

        <!-- Scope selector -->
        <div class="flex items-center gap-2 border-b border-ink-100 px-4 py-2 text-xs text-ink-600 dark:border-ink-800/60 dark:text-ink-300">
          <span class="font-medium text-ink-700 dark:text-ink-200">{{ t('chat.scope') }}</span>
          <select
            :value="scopeValue"
            class="flex-1 rounded-md border border-ink-200 bg-white px-2 py-1 text-xs focus:border-accent-400 focus:outline-none dark:border-ink-800 dark:bg-ink-800 dark:text-ink-100"
            @change="setScope(($event.target as HTMLSelectElement).value)"
          >
            <option value="workspace">{{ t('chat.scope.workspace') }}</option>
            <option v-if="scopedDocTitle" value="doc">
              {{ t('chat.scope.thisDoc', { title: scopedDocTitle }) }}
            </option>
            <option v-for="f in folderOptions" :key="f.id" :value="f.id">
              {{ f.name }}
            </option>
          </select>
        </div>

        <!-- Sessions list (collapsible) -->
        <div
          v-if="sessionsOpen"
          class="max-h-72 overflow-y-auto border-b border-ink-100 bg-ink-50/60 px-2 py-2 dark:border-ink-800/60 dark:bg-ink-950/60"
        >
          <input
            type="search"
            :value="sessionsSearchInput"
            class="session-search"
            :placeholder="t('chat.sessionSearch')"
            @input="onSessionsSearchInput(($event.target as HTMLInputElement).value)"
          >
          <p v-if="loadingSessions" class="px-2 py-1 text-xs text-ink-400 dark:text-ink-500">{{ t('chat.sessions.loading') }}</p>
          <p v-else-if="sessions.length === 0 && sessionsSearchInput.trim().length > 0" class="px-2 py-1 text-xs text-ink-400 dark:text-ink-500">
            {{ t('chat.sessionSearchEmpty') }}
          </p>
          <p v-else-if="sessions.length === 0" class="px-2 py-1 text-xs text-ink-400 dark:text-ink-500">
            {{ t('chat.sessions.empty') }}
          </p>
          <ul class="space-y-0.5">
            <li
              v-for="s in sessions"
              :key="s.id"
              class="group flex items-center gap-1 rounded-md px-1"
              :class="[
                currentSessionId === s.id
                  ? 'bg-accent-100 dark:bg-accent-900/40'
                  : 'hover:bg-ink-100 dark:hover:bg-ink-800/60',
                isBranch(s) ? 'session-row--branch' : '',
              ]"
            >
              <button
                class="flex-1 truncate px-2 py-1 text-left text-xs text-ink-800 dark:text-ink-200"
                :title="isBranch(s) ? branchedFromLabel(s.parentSessionId) : undefined"
                @click="pickSession(s.id)"
              >
                <span
                  v-if="isBranch(s)"
                  class="branch-glyph"
                  aria-hidden="true"
                >↪</span>
                {{ s.title || t('chat.sessions.untitled') }}
              </button>
              <button
                class="rounded p-1 text-ink-400 opacity-0 hover:text-accent-600 group-hover:opacity-100 dark:text-ink-500 dark:hover:text-accent-300"
                :title="t('chat.exportSession')"
                @click="onExportSession(s.id)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v12M6 12l6 6 6-6M4 20h16"/></svg>
              </button>
              <button
                class="rounded p-1 text-ink-400 opacity-0 hover:text-red-500 group-hover:opacity-100 dark:text-ink-500 dark:hover:text-red-400"
                :title="t('chat.sessions.delete')"
                @click="removeSession(s.id)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
              </button>
            </li>
          </ul>
          <button
            v-if="sessionsHasMore"
            type="button"
            class="session-load-more"
            :disabled="loadingMoreSessions"
            @click="onLoadMoreSessions"
          >
            {{ t('chat.loadMoreSessions') }}
          </button>
        </div>

        <!-- Messages -->
        <main
          ref="scrollArea"
          class="relative flex-1 space-y-3 overflow-y-auto px-4 py-4"
          @scroll.passive="updateScrollLock"
        >
          <!-- Branch lineage banner. Only renders for forked sessions. -->
          <div
            v-if="currentBranchInfo"
            class="branch-banner"
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path
                d="M5 2v5.5a2.5 2.5 0 0 0 2.5 2.5H11 M11 6v7 M5 10v3"
                fill="none" stroke="currentColor" stroke-width="1.4"
                stroke-linecap="round" stroke-linejoin="round"
              />
              <circle cx="5" cy="2" r="1.2" fill="currentColor" />
              <circle cx="11" cy="6" r="1.2" fill="currentColor" />
            </svg>
            <span class="flex-1 truncate">
              {{ currentBranchInfo.parentTitle
                ? L.branchedFrom.replace('{title}', currentBranchInfo.parentTitle)
                : L.branchedFromUnknown }}
            </span>
            <button
              type="button"
              class="branch-banner-link"
              @click="openParentSession"
            >
              {{ t('chat.openParent') }}
            </button>
          </div>

          <p
            v-if="messages.length === 0"
            class="mx-auto mt-12 max-w-[28ch] text-center text-sm text-ink-400 dark:text-ink-500"
          >
            {{ t('chat.empty') }}
          </p>

          <div
            v-for="m in messages"
            :key="m.id"
            class="msg-wrap group"
            :class="m.role === 'user' ? 'msg-wrap--user' : 'msg-wrap--assistant'"
          >
            <div
              class="max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-sm"
              :class="m.role === 'user'
                ? 'bg-accent-500 text-white dark:bg-ink-700 dark:text-ink-50'
                : m.errored
                  ? 'bg-red-50 text-red-800 ring-1 ring-red-200 dark:bg-red-900/30 dark:text-red-200 dark:ring-red-900/60'
                  : 'bg-ink-100 text-ink-900 dark:bg-ink-800 dark:text-ink-100'"
            >
              <!-- Inline editor for user messages -->
              <div v-if="m.role === 'user' && editingId === m.id" class="edit-block">
                <textarea
                  v-model="editDraft"
                  rows="2"
                  class="edit-area"
                  :placeholder="t('chat.placeholder')"
                  :disabled="sending"
                  @keydown="onEditKeydown($event, m.id)"
                />
                <div class="edit-actions">
                  <button
                    type="button"
                    class="edit-btn edit-btn--ghost"
                    :disabled="sending"
                    @click="cancelEdit"
                  >
                    {{ t('chat.editCancel') }}
                  </button>
                  <button
                    type="button"
                    class="edit-btn edit-btn--primary"
                    :disabled="sending || editDraft.trim().length === 0"
                    @click="saveEdit(m.id)"
                  >
                    {{ t('chat.editSave') }}
                  </button>
                </div>
              </div>

              <template v-else>
                <!-- User-message thumbnail (Wave 4 / N7) -->
                <template v-if="m.role === 'user'">
                  <img
                    v-if="extractUserAttachment(m.content).url"
                    :src="extractUserAttachment(m.content).url!"
                    :alt="t('chat.attachLabel')"
                    class="msg-thumb"
                  >
                  <p class="whitespace-pre-wrap break-words">{{ extractUserAttachment(m.content).body || (m.pending ? '…' : '') }}</p>
                </template>
                <template v-else>
                  <div
                    v-if="m.content"
                    class="msg-md break-words"
                  >
                    <span v-html="renderMarkdown(m.content)" />
                    <!-- Streaming caret (Wave 4 / I9) -->
                    <span v-if="m.pending" class="stream-caret" aria-hidden="true">▍</span>
                  </div>
                  <p
                    v-else
                    class="whitespace-pre-wrap break-words"
                  >{{ m.pending ? '…' : '' }}</p>
                </template>

                <!-- Partial sources hint (Wave 4 / N9) — only while streaming -->
                <div
                  v-if="m.role === 'assistant' && m.pending && m.partialSources && m.partialSources.length"
                  class="partial-sources"
                >
                  <span class="partial-sources-title">{{ t('chat.searchingNotes') }}</span>
                  <span class="partial-sources-list">
                    <span
                      v-for="(s, i) in m.partialSources.slice(0, 4)"
                      :key="`${m.id}-ps-${i}`"
                      class="partial-source-chip"
                    >{{ s.title || (s.kind === 'web' ? 'Web' : `#${s.docId}`) }}</span>
                    <span v-if="m.partialSources.length > 4" class="partial-source-chip">+{{ m.partialSources.length - 4 }}</span>
                  </span>
                </div>

                <!-- Auto-triggered web search badge -->
                <div
                  v-if="m.role === 'assistant' && m.webAutoTriggered"
                  class="web-auto-badge"
                  :title="L.webAutoTitle"
                >
                  <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                    <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4" />
                    <path d="M2 8h12 M8 2c2 2 2 10 0 12 M8 2c-2 2-2 10 0 12" fill="none" stroke="currentColor" stroke-width="1.2" />
                  </svg>
                  <span>{{ m.webAutoHits && m.webAutoHits > 0 ? L.webAutoOn : L.webAutoEmpty }}</span>
                </div>

                <!-- Tool-call approval cards (Wave 4 / N8) -->
                <div
                  v-if="m.role === 'assistant' && m.pendingToolCalls && m.pendingToolCalls.length"
                  class="tool-calls"
                >
                  <p class="tool-calls-title">{{ t('chat.toolPreviewTitle') }}</p>
                  <div
                    v-for="(call, idx) in m.pendingToolCalls"
                    :key="`${m.id}-tc-${idx}`"
                    class="tool-call-card"
                  >
                    <div class="tool-call-head">{{ formatToolCallSummary(call) }}</div>
                    <pre class="tool-call-args">{{ formatToolCallArgs(call) }}</pre>
                    <div class="tool-call-actions">
                      <button
                        type="button"
                        class="tool-call-btn tool-call-btn--reject"
                        @click="rejectToolCall(m, idx)"
                      >
                        {{ t('chat.toolPreviewReject') }}
                      </button>
                      <button
                        type="button"
                        class="tool-call-btn tool-call-btn--approve"
                        @click="approveToolCall(m, idx)"
                      >
                        {{ t('chat.toolPreviewApprove') }}
                      </button>
                    </div>
                  </div>
                </div>

                <!-- No-notes-matched help card (Wave 4 / I10) -->
                <div
                  v-if="showNoNotesHelp(m)"
                  class="empty-help"
                >
                  <p class="empty-help-title">{{ t('chat.noNotesMatchedTitle') }}</p>
                  <p class="empty-help-hint">{{ t('chat.noNotesMatchedHint') }}</p>
                  <div class="empty-help-actions">
                    <button
                      v-if="!webFallbackEnabled"
                      type="button"
                      class="empty-help-btn"
                      @click="onEnableWebAndRetry(m)"
                    >
                      {{ t('chat.webFallback') }}
                    </button>
                    <button
                      type="button"
                      class="empty-help-btn empty-help-btn--ghost"
                      @click="onGoToWorkspace"
                    >
                      {{ t('sidebar.workspace') }}
                    </button>
                  </div>
                </div>

                <!-- Source chips for assistant messages -->
                <div
                  v-if="m.role === 'assistant' && m.sources.length"
                  class="mt-2 flex flex-wrap gap-1"
                >
                  <button
                    v-for="(s, i) in m.sources"
                    :key="`${m.id}-${i}`"
                    class="source-chip"
                    :class="s.kind === 'web' ? 'source-chip--web' : 'source-chip--note'"
                    :title="s.kind === 'web' ? `${s.title}\n${s.url || ''}` : (s.highlight || s.snippet)"
                    @click="openSource(s)"
                  >
                    <span
                      v-if="isStaleSource(m, s)"
                      class="stale-dot"
                      :title="t('chat.staleSource')"
                      aria-hidden="true"
                    >⚠</span>
                    <span v-if="s.kind === 'web'" class="web-glyph" aria-hidden="true">🌐</span>
                    <span>
                      [#{{ s.citation ?? i + 1 }}]
                      <template v-if="s.kind === 'web'">
                        {{ s.title || t('chat.sourceWeb') }}
                      </template>
                      <template v-else>
                        {{ s.title || t('chat.sourceFallback', { id: s.docId }) }}
                      </template>
                    </span>
                  </button>
                </div>

                <!-- Debug panel — inline meta from the SSE `meta` frame +
                     persisted retrieval-quality metrics (lazy-fetched). -->
                <div
                  v-if="m.role === 'assistant' && isDebugOpen(m.id)"
                  class="debug-panel"
                >
                  <div class="debug-header">
                    <span class="debug-header-title">Debug</span>
                    <button
                      type="button"
                      class="debug-copy-btn"
                      :title="L.debugCopyTitle"
                      @click="copyDebug(m)"
                    >
                      {{ debugCopiedId === m.id ? L.debugCopied : L.debugCopy }}
                    </button>
                  </div>

                  <!-- Live meta from the SSE meta frame. Available immediately,
                       no API call. -->
                  <dl v-if="m.meta" class="debug-grid">
                    <div class="debug-item">
                      <dt>Model</dt>
                      <dd>{{ m.meta.model || '—' }}</dd>
                    </div>
                    <div class="debug-item">
                      <dt>Temp</dt>
                      <dd>{{ m.meta.temperature ?? '—' }}</dd>
                    </div>
                    <div class="debug-item debug-item--wide">
                      <dt>Web</dt>
                      <dd>
                        <template v-if="m.meta.webRequested || m.meta.webAuto">
                          {{ m.meta.webAuto ? 'auto' : 'toggle' }} · {{ m.meta.webHits }} hits
                        </template>
                        <template v-else>off</template>
                      </dd>
                    </div>
                    <div class="debug-item">
                      <dt>Note hits</dt>
                      <dd>{{ m.meta.noteHits }}</dd>
                    </div>
                    <div class="debug-item">
                      <dt>Rewriter</dt>
                      <dd>{{ m.meta.rewriterUsed ? 'on' : 'off' }}</dd>
                    </div>
                    <div class="debug-item">
                      <dt>Reranker</dt>
                      <dd>
                        {{ m.meta.rerankerUsed ? 'on' : 'off' }}
                        <span v-if="m.meta.rerankScoreAvg != null" class="debug-note">
                          ({{ formatRerank(m.meta.rerankScoreAvg) }})
                        </span>
                      </dd>
                    </div>
                    <div class="debug-item">
                      <dt>Reasoning</dt>
                      <dd>{{ m.meta.reasoning ? 'on' : 'off' }}</dd>
                    </div>
                    <div class="debug-item">
                      <dt>Allow writes</dt>
                      <dd>{{ m.meta.allowWrites ? 'on' : 'off' }}</dd>
                    </div>
                    <div class="debug-item debug-item--wide">
                      <dt>Scope</dt>
                      <dd>
                        <template v-if="m.meta.scopeDocId != null">doc #{{ m.meta.scopeDocId }}</template>
                        <template v-else-if="m.meta.scopeFolderId != null">folder #{{ m.meta.scopeFolderId }}</template>
                        <template v-else>workspace</template>
                      </dd>
                    </div>
                    <div class="debug-item debug-item--wide">
                      <dt>Retrieval query</dt>
                      <dd class="debug-query">{{ m.meta.retrievalQuery || '—' }}</dd>
                    </div>
                    <template v-if="m.meta.webDebug">
                      <div class="debug-item">
                        <dt>Web endpoint</dt>
                        <dd class="debug-query">{{ shortEndpoint(m.meta.webDebug.endpoint) }}</dd>
                      </div>
                      <div class="debug-item">
                        <dt>Web HTTP</dt>
                        <dd>{{ m.meta.webDebug.status ?? '—' }} ({{ m.meta.webDebug.model }})</dd>
                      </div>
                      <div v-if="m.meta.webDebug.error" class="debug-item debug-item--wide">
                        <dt>Web error</dt>
                        <dd class="debug-query debug-err">{{ m.meta.webDebug.error }}</dd>
                      </div>
                      <div v-if="m.meta.webDebug.rawSample" class="debug-item debug-item--wide">
                        <dt>Web raw (trimmed)</dt>
                        <dd class="debug-query">{{ m.meta.webDebug.rawSample }}</dd>
                      </div>
                    </template>
                  </dl>

                  <!-- Persisted rag_quality_logs row (latency, citations).
                       Lazy-fetched on panel open. -->
                  <p v-if="m.debug === undefined" class="debug-loading">
                    {{ t('chat.sessions.loading') }}
                  </p>
                  <dl v-else-if="m.debug" class="debug-grid debug-grid--persisted">
                    <div class="debug-item">
                      <dt>{{ t('chat.debugRetrieved') }}</dt>
                      <dd>{{ m.debug.chunksReturned }}</dd>
                    </div>
                    <div class="debug-item">
                      <dt>{{ t('chat.debugCited') }}</dt>
                      <dd>{{ m.debug.citationsEmitted }}</dd>
                    </div>
                    <div class="debug-item">
                      <dt>{{ t('chat.debugLatency') }}</dt>
                      <dd>{{ formatLatency(m.debug.latencyMs) }}</dd>
                    </div>
                  </dl>
                </div>

                <!-- Suggested follow-up chips (latest assistant only) -->
                <div
                  v-if="m.role === 'assistant' && isLastAssistant(m) && m.followups && m.followups.length"
                  class="followups"
                >
                  <p class="followups-title">{{ t('chat.suggestedFollowupsTitle') }}</p>
                  <div class="followups-row">
                    <button
                      v-for="(q, i) in m.followups"
                      :key="`${m.id}-fu-${i}`"
                      type="button"
                      class="followup-chip"
                      :disabled="sending"
                      @click="onFollowup(q)"
                    >
                      {{ q }}
                    </button>
                  </div>
                </div>
              </template>
            </div>

            <!-- Hover action bar: regenerate (assistant) / edit (user) -->
            <div
              v-if="isPersisted(m.id) && editingId !== m.id"
              class="msg-actions"
            >
              <button
                v-if="m.role === 'assistant' && !m.pending && !m.errored && m.content"
                type="button"
                class="msg-action-btn"
                :title="t('chat.copyTitle')"
                :aria-label="t('chat.copyTitle')"
                @click="onCopy(m)"
              >
                <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                  <rect x="5" y="5" width="9" height="9" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4" />
                  <path d="M3 11V3a1 1 0 0 1 1-1h7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                </svg>
                <span>{{ copiedId === m.id ? t('chat.copied') : t('chat.copy') }}</span>
              </button>

              <!-- Thumbs feedback (Wave 2 / N3) -->
              <button
                v-if="m.role === 'assistant' && !m.pending && !m.errored && m.content"
                type="button"
                class="msg-action-btn feedback-btn"
                :class="{ 'feedback-btn--up': (m.userFeedback ?? 0) === 1 }"
                :title="t('chat.thumbsUp')"
                :aria-label="t('chat.thumbsUp')"
                :aria-pressed="(m.userFeedback ?? 0) === 1"
                @click="onFeedback(m, 1)"
              >
                <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                  <path
                    v-if="(m.userFeedback ?? 0) === 1"
                    d="M6 6.5l3-5 c0.6 0 1.3 0.7 1.3 1.4l-0.6 3h3.4 c0.8 0 1.4 0.7 1.2 1.5l-1 4.6 c-0.2 0.7-0.8 1.2-1.5 1.2H6V6.5z M2.5 6.5h2.5V14H2.5z"
                    fill="currentColor"
                    stroke="currentColor"
                    stroke-width="0.6"
                    stroke-linejoin="round"
                  />
                  <path
                    v-else
                    d="M6 6.5l3-5 c0.6 0 1.3 0.7 1.3 1.4l-0.6 3h3.4 c0.8 0 1.4 0.7 1.2 1.5l-1 4.6 c-0.2 0.7-0.8 1.2-1.5 1.2H6V6.5z M2.5 6.5h2.5V14H2.5z"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.3"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
              <button
                v-if="m.role === 'assistant' && !m.pending && !m.errored && m.content"
                type="button"
                class="msg-action-btn feedback-btn"
                :class="{ 'feedback-btn--down': (m.userFeedback ?? 0) === -1 }"
                :title="t('chat.thumbsDown')"
                :aria-label="t('chat.thumbsDown')"
                :aria-pressed="(m.userFeedback ?? 0) === -1"
                @click="onFeedback(m, -1)"
              >
                <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                  <path
                    v-if="(m.userFeedback ?? 0) === -1"
                    d="M10 9.5l-3 5 c-0.6 0-1.3-0.7-1.3-1.4l0.6-3H2.9 c-0.8 0-1.4-0.7-1.2-1.5l1-4.6 c0.2-0.7 0.8-1.2 1.5-1.2H10V9.5z M13.5 9.5H11V2h2.5z"
                    fill="currentColor"
                    stroke="currentColor"
                    stroke-width="0.6"
                    stroke-linejoin="round"
                  />
                  <path
                    v-else
                    d="M10 9.5l-3 5 c-0.6 0-1.3-0.7-1.3-1.4l0.6-3H2.9 c-0.8 0-1.4-0.7-1.2-1.5l1-4.6 c0.2-0.7 0.8-1.2 1.5-1.2H10V9.5z M13.5 9.5H11V2h2.5z"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.3"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>

              <!-- Regenerate + options caret (Wave 2 / I3) -->
              <span
                v-if="m.role === 'assistant' && !m.pending && !m.errored"
                class="regen-group"
              >
                <button
                  type="button"
                  class="msg-action-btn regen-main"
                  :disabled="sending"
                  :title="t('chat.regenerateTitle')"
                  :aria-label="t('chat.regenerateTitle')"
                  @click="onRegenerate(m.id)"
                >
                  <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                    <path
                      d="M14 8a6 6 0 1 1-1.76-4.24 M14 2v3.5h-3.5"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                  <span>{{ t('chat.regenerate') }}</span>
                </button>
                <button
                  type="button"
                  class="msg-action-btn regen-caret"
                  :disabled="sending"
                  :aria-label="t('chat.regenerateRun')"
                  :aria-expanded="regenOpenForId === m.id"
                  @click="toggleRegenOptions(m.id)"
                >
                  <svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">
                    <path d="M1.5 3 L4 5.5 L6.5 3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
                <div
                  v-if="regenOpenForId === m.id"
                  class="regen-popover"
                  role="dialog"
                >
                  <label class="regen-label">
                    <span>{{ t('chat.regenerateModel') }}</span>
                    <select v-model="regenModel" class="regen-input">
                      <option v-for="opt in REGEN_MODELS" :key="opt.id" :value="opt.id">
                        {{ opt.label }}
                      </option>
                    </select>
                  </label>
                  <label class="regen-label">
                    <span>{{ t('chat.regenerateTemp') }} <span class="regen-temp-val">{{ Number(regenTemp).toFixed(1) }}</span></span>
                    <input
                      v-model.number="regenTemp"
                      type="range"
                      min="0"
                      max="1"
                      step="0.1"
                      class="regen-slider"
                    >
                  </label>
                  <div class="regen-actions">
                    <button
                      type="button"
                      class="regen-cancel"
                      @click="closeRegenOptions"
                    >
                      {{ t('chat.editCancel') }}
                    </button>
                    <button
                      type="button"
                      class="regen-run"
                      :disabled="sending"
                      @click="regenWithOptions(m.id)"
                    >
                      {{ t('chat.regenerateRun') }}
                    </button>
                  </div>
                </div>
              </span>
              <button
                v-if="m.role === 'assistant' && !m.pending && !m.errored && m.content"
                type="button"
                class="msg-action-btn"
                :title="t('chat.debugTitle')"
                :aria-label="t('chat.debugTitle')"
                :aria-pressed="isDebugOpen(m.id)"
                @click="toggleDebug(m)"
              >
                <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                  <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4" />
                  <circle cx="8" cy="5" r="0.9" fill="currentColor" />
                  <path d="M8 7.5v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                </svg>
              </button>
              <button
                v-if="m.role === 'user'"
                type="button"
                class="msg-action-btn"
                :disabled="sending"
                :title="t('chat.editTitle')"
                @click="startEdit(m.id, m.content)"
              >
                <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                  <path
                    d="M11 2l3 3-8.5 8.5H2v-3.5L10.5 1.5 11 2z"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                <span>{{ t('chat.edit') }}</span>
              </button>
              <button
                type="button"
                class="msg-action-btn"
                :disabled="sending || branchingId !== null"
                :title="L.branchTitle"
                @click="onBranch(m.id)"
              >
                <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                  <!-- Fork glyph: vertical trunk that splits into two branches. -->
                  <path
                    d="M5 2v5.5a2.5 2.5 0 0 0 2.5 2.5H11 M11 6v7 M5 10v3"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                  <circle cx="5" cy="2" r="1.2" fill="currentColor" />
                  <circle cx="11" cy="6" r="1.2" fill="currentColor" />
                  <circle cx="11" cy="13" r="1.2" fill="currentColor" />
                  <circle cx="5" cy="13" r="1.2" fill="currentColor" />
                </svg>
                <span v-if="branchingId === m.id">{{ L.branchPending }}</span>
                <span v-else>{{ L.branch }}</span>
              </button>
            </div>
          </div>
        </main>

        <!-- Jump-to-latest floater (Wave 4 / I9) -->
        <Transition name="fade">
          <button
            v-if="userIsAwayFromBottom"
            type="button"
            class="jump-latest"
            :title="t('chat.openParent')"
            @click="jumpToLatest"
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path d="M3 6l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </Transition>

        <!-- Composer -->
        <footer class="composer-footer">
          <div class="composer-box" :class="{ 'composer-box--focus': composerFocused }">
            <!-- Pending attachment thumbnail (Wave 4 / N7) -->
            <div v-if="pendingAttachmentUrl" class="composer-attach">
              <img :src="pendingAttachmentUrl" :alt="t('chat.attachLabel')" class="composer-attach-thumb">
              <button
                type="button"
                class="composer-attach-clear"
                :title="t('chat.attachClear')"
                :aria-label="t('chat.attachClear')"
                @click="clearAttachment"
              >
                <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
                  <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                </svg>
              </button>
            </div>

            <textarea
              ref="composer"
              v-model="draft"
              rows="2"
              :placeholder="t('chat.placeholder')"
              class="composer-textarea"
              :disabled="sending"
              @keydown="onKeydown"
              @focus="composerFocused = true"
              @blur="composerFocused = false"
            />

            <!-- Bottom action row: options popover + attach (left), send/stop (right) -->
            <div class="composer-actions">
              <div class="composer-actions-left">
                <button
                  type="button"
                  class="composer-icon-btn"
                  :class="{ 'composer-icon-btn--active': anyOptionEnabled }"
                  :disabled="sending"
                  :title="L.optionsTitle"
                  :aria-label="L.optionsTitle"
                  :aria-expanded="optionsOpen"
                  @click="toggleOptions"
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                    <path d="M3 4h6 M11 4h2 M3 8h2 M7 8h6 M3 12h8 M13 12h0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                    <circle cx="10" cy="4" r="1.3" fill="currentColor" />
                    <circle cx="6" cy="8" r="1.3" fill="currentColor" />
                    <circle cx="12" cy="12" r="1.3" fill="currentColor" />
                  </svg>
                  <span
                    v-if="anyOptionEnabled"
                    class="composer-options-dot"
                    aria-hidden="true"
                  />
                </button>
                <button
                  type="button"
                  class="composer-icon-btn"
                  :class="{ 'composer-icon-btn--active': !!pendingAttachmentUrl }"
                  :disabled="sending || attachUploading"
                  :title="t('chat.attach')"
                  :aria-label="t('chat.attach')"
                  @click="triggerAttachPick"
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                    <path
                      d="M9.5 3.5l-5 5a2.5 2.5 0 1 0 3.5 3.5l6-6a4 4 0 1 0-5.5-5.5l-6 6"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </button>
                <input
                  ref="fileInput"
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  class="hidden"
                  @change="onAttachPick"
                >
              </div>

              <div class="composer-actions-right">
                <button
                  v-if="sending"
                  type="button"
                  class="composer-send composer-send--stop"
                  :title="t('chat.stopTitle')"
                  :aria-label="t('chat.stopTitle')"
                  @click="onStop"
                >
                  <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                    <rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor" />
                  </svg>
                  <span>{{ t('chat.stop') }}</span>
                </button>
                <button
                  v-else
                  type="button"
                  class="composer-send"
                  :disabled="draft.trim().length === 0"
                  @click="onSend"
                >
                  <span>{{ t('chat.send') }}</span>
                  <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                    <path d="M2 8l11-5-4 11-2-4-5-2z" fill="currentColor" />
                  </svg>
                </button>
              </div>
            </div>

            <!-- Options popover (anchored to the icon button, lives inside the box) -->
            <Transition name="opts">
              <div
                v-if="optionsOpen"
                class="composer-options-popover"
                @click.stop
              >
                <p class="composer-options-title">{{ L.optionsTitle }}</p>
                <label class="composer-option" :title="t('chat.webFallbackTitle')">
                  <input
                    type="checkbox"
                    :checked="webFallbackEnabled"
                    @change="onToggleWebFallback"
                  >
                  <span class="composer-option-text">
                    <span class="composer-option-icon" aria-hidden="true">🌐</span>
                    {{ t('chat.webFallback') }}
                  </span>
                </label>
                <label class="composer-option" :title="t('chat.reasoningTitle')">
                  <input
                    type="checkbox"
                    :checked="reasoningEnabled"
                    @change="onToggleReasoning"
                  >
                  <span class="composer-option-text">
                    <span class="composer-option-icon" aria-hidden="true">🧠</span>
                    {{ t('chat.reasoning') }}
                  </span>
                </label>
                <label class="composer-option" :title="t('chat.toolAllowWritesTitle')">
                  <input
                    type="checkbox"
                    :checked="allowWritesEnabled"
                    @change="onToggleAllowWrites"
                  >
                  <span class="composer-option-text">
                    <span class="composer-option-icon" aria-hidden="true">✎</span>
                    {{ t('chat.toolAllowWrites') }}
                  </span>
                </label>
              </div>
            </Transition>
          </div>
        </footer>
    </aside>
  </Transition>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 180ms ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
/* Bottom dock: slides up from the bottom edge. While actively resizing we
   pin the cursor and drop the children's pointer interactions so the drag is
   smooth even when the pointer races ahead of layout. */
.chat-dock {
  box-shadow: 0 -8px 24px theme('colors.ink.900' / 8%);
}
html.dark .chat-dock {
  box-shadow: 0 -8px 24px theme('colors.ink.950' / 45%);
}
.chat-dock--resizing {
  cursor: ns-resize;
}

/* Resize handle — a slim grab strip on the dock's top edge. The visible bar
   is a centered pill that brightens on hover; the hit area is the full width. */
.dock-resize-handle {
  @apply relative flex h-1.5 w-full shrink-0 cursor-ns-resize items-center justify-center;
  touch-action: none;
}
.dock-resize-handle::before {
  content: '';
  @apply h-1 w-10 rounded-full bg-ink-300 transition-colors;
}
html.dark .dock-resize-handle::before {
  background: theme('colors.ink.700');
}
.dock-resize-handle:hover::before {
  background: theme('colors.accent.400');
}

/* Open / close: animate the dock's HEIGHT (0 ↔ target) rather than a
   transform. The dock is a flex sibling, so a transform would grab its full
   layout height in one frame — the main content would jump up and the slide
   then played on top, reading as a flicker. Growing the height instead lets
   the content reflow in sync, smoothly. `overflow: hidden` clips the panel's
   own content while it's shorter than its natural size; the messages area
   (flex-1) absorbs the growth so the header/composer don't squish. The
   `.chat-dock` prefix raises specificity above the mobile `height: 70vh`
   rule so the collapsed state wins during enter/leave on small screens too. */
.slide-up-enter-active,
.slide-up-leave-active {
  transition: height 200ms cubic-bezier(0.2, 0.7, 0.2, 1);
  overflow: hidden;
}
.chat-dock.slide-up-enter-from,
.chat-dock.slide-up-leave-to {
  height: 0 !important;
}

/* Mobile: the chat OVERLAYS the content instead of pushing it up. Pinning the
   dock to the viewport (position: fixed) takes it out of the flex flow so
   `.app-main-content` keeps its full height behind it. Fills most of the
   viewport and honours the iOS home-indicator safe area. */
@media (max-width: 767px) {
  .chat-dock {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 50;
    height: 70vh !important;
    padding-bottom: env(safe-area-inset-bottom, 0);
  }
}
/* Backdrop behind the overlaid chat on mobile — tap to dismiss. */
.chat-mobile-backdrop {
  @apply fixed inset-0 z-40 bg-ink-950/30 backdrop-blur-[1px];
}

/* Per-message action bar (regenerate / edit / copy / branch).
 *
 * Discoverability matters on touch devices (no :hover): show the bar at a
 * subdued opacity persistently, then brighten on pointer hover or keyboard
 * focus. Devices with a real hover (`@media (hover: hover)`) hide the bar
 * by default to keep the bubble clean — they get the original behavior. */
.msg-wrap {
  @apply flex flex-col gap-1;
}
.msg-wrap--user {
  @apply items-end;
}
.msg-wrap--assistant {
  @apply items-start;
}
.msg-actions {
  @apply flex flex-wrap items-center gap-1 px-1 transition-opacity;
  opacity: 0.7;
}
.msg-actions:focus-within {
  @apply opacity-100;
}
@media (hover: hover) {
  .msg-actions { opacity: 0; }
  .group:hover .msg-actions,
  .msg-actions:focus-within {
    opacity: 1;
  }
}
@media (hover: hover) and (max-width: 767px) {
  /* Defensive: some phones report hover:hover incorrectly. Force visible. */
  .msg-actions { opacity: 0.7; }
}

/* Branch lineage banner shown at the top of a forked session. */
.branch-banner {
  @apply mb-2 flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[11px];
  background: theme('colors.accent.50');
  border-color: theme('colors.accent.200');
  color: theme('colors.accent.800');
}
html.dark .branch-banner {
  background: rgba(120, 113, 108, 0.12);
  border-color: theme('colors.accent.800');
  color: theme('colors.accent.200');
}
.branch-banner-link {
  @apply rounded px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em];
  color: theme('colors.accent.700');
}
html.dark .branch-banner-link {
  color: theme('colors.accent.200');
}
.branch-banner-link:hover {
  background: theme('colors.accent.100');
}
html.dark .branch-banner-link:hover {
  background: rgba(120, 113, 108, 0.25);
}
.msg-action-btn {
  @apply inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-sans uppercase font-semibold tracking-[0.06em] text-ink-500 dark:text-ink-400;
  transition: background 120ms ease, color 120ms ease, opacity 120ms ease;
}
.msg-action-btn:hover:not(:disabled) {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
}
html.dark .msg-action-btn:hover:not(:disabled) {
  background: theme('colors.ink.800');
  color: theme('colors.ink.50');
}
.msg-action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Branched session row in the history panel. The leading "↪" marker
   is rendered inline; we lean on the existing `space-y` spacing and
   add a subtle left-padding so child branches read as one level
   nested under their (still flat-listed) siblings. */
.session-row--branch {
  padding-left: 6px;
  border-left: 2px solid theme('colors.accent.200');
}
html.dark .session-row--branch {
  border-left-color: theme('colors.accent.700');
}
.branch-glyph {
  @apply mr-1 inline-block text-ink-400 dark:text-ink-500;
  font-size: 0.95em;
}

/* Inline edit composer (user message). */
.edit-block {
  @apply flex flex-col gap-2;
  min-width: 220px;
}
.edit-area {
  @apply w-full resize-none rounded-md border bg-white px-2 py-1.5 text-sm text-ink-900 placeholder:text-ink-400 focus:outline-none;
  border-color: theme('colors.ink.200');
}
html.dark .edit-area {
  background: theme('colors.ink.900');
  border-color: theme('colors.ink.700');
  color: theme('colors.ink.50');
}
.edit-area:focus {
  border-color: theme('colors.accent.400');
  box-shadow: 0 0 0 1px theme('colors.accent.300');
}
.edit-actions {
  @apply flex items-center justify-end gap-1.5;
}
.edit-btn {
  @apply inline-flex items-center justify-center rounded-md px-2 py-1 text-[11px] font-sans uppercase font-semibold tracking-[0.08em];
  transition: background 120ms ease, color 120ms ease, opacity 120ms ease;
}
.edit-btn--ghost {
  @apply text-white/80;
}
html.dark .edit-btn--ghost {
  @apply text-ink-200;
}
.edit-btn--ghost:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.18);
  color: white;
}
html.dark .edit-btn--ghost:hover:not(:disabled) {
  background: theme('colors.ink.700');
}
.edit-btn--primary {
  background: white;
  color: theme('colors.accent.700');
}
html.dark .edit-btn--primary {
  background: theme('colors.accent.500');
  color: white;
}
.edit-btn--primary:hover:not(:disabled) {
  background: theme('colors.accent.50');
  color: theme('colors.accent.800');
}
html.dark .edit-btn--primary:hover:not(:disabled) {
  background: theme('colors.accent.400');
  color: white;
}
.edit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Markdown rendered inside assistant bubbles. */
.msg-md :deep(p) {
  @apply my-1 leading-relaxed;
}
.msg-md :deep(p:first-child) { @apply mt-0; }
.msg-md :deep(p:last-child) { @apply mb-0; }
.msg-md :deep(h1),
.msg-md :deep(h2),
.msg-md :deep(h3),
.msg-md :deep(h4) {
  @apply mt-3 mb-1 font-serif font-semibold text-ink-900 dark:text-ink-50;
}
.msg-md :deep(h1) { @apply text-[1.05rem]; }
.msg-md :deep(h2) { @apply text-[1rem]; }
.msg-md :deep(h3),
.msg-md :deep(h4) { @apply text-[0.95rem]; }
.msg-md :deep(strong) { @apply font-semibold text-ink-900 dark:text-ink-50; }
.msg-md :deep(em) { @apply italic; }
.msg-md :deep(s),
.msg-md :deep(del) { @apply text-ink-500 dark:text-ink-400; }
.msg-md :deep(a) {
  @apply text-accent-700 underline decoration-accent-300 underline-offset-2 dark:text-accent-300 dark:decoration-accent-700;
}
.msg-md :deep(a:hover) {
  @apply text-accent-800 decoration-accent-500 dark:text-accent-200;
}
.msg-md :deep(ul),
.msg-md :deep(ol) {
  @apply my-1.5 pl-5 leading-relaxed;
}
.msg-md :deep(ul) { @apply list-disc; }
.msg-md :deep(ol) { @apply list-decimal; }
.msg-md :deep(li) { @apply my-0.5; }
.msg-md :deep(li > p) { @apply my-0; }
.msg-md :deep(blockquote) {
  @apply my-2 border-l-2 border-accent-300 pl-3 italic text-ink-700 dark:border-accent-700 dark:text-ink-200;
}
.msg-md :deep(code) {
  @apply rounded bg-ink-50 px-1 py-px font-mono text-[0.85em] text-ink-800 dark:bg-ink-950/50 dark:text-ink-100;
}
.msg-md :deep(pre) {
  @apply my-2 overflow-x-auto rounded bg-ink-950 p-2.5 text-[0.8rem] leading-relaxed text-ink-50 dark:bg-ink-950;
}
.msg-md :deep(pre code) {
  @apply bg-transparent p-0 text-inherit;
}
.msg-md :deep(hr) {
  @apply my-3 border-t border-ink-200/70 dark:border-ink-700/70;
}
.msg-md :deep(table) {
  @apply my-2 w-full border-collapse text-[0.85rem];
}
.msg-md :deep(th),
.msg-md :deep(td) {
  @apply border border-ink-200 px-2 py-1 text-left dark:border-ink-700;
}
.msg-md :deep(th) {
  @apply bg-ink-100/60 font-semibold dark:bg-ink-800/60;
}

/* ---------------- Wave 2: source chips, feedback, regen popover, followups ---------------- */
.source-chip {
  @apply inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 transition;
}
.source-chip--note {
  background: white;
  color: theme('colors.ink.700');
  --tw-ring-color: theme('colors.ink.200');
}
.source-chip--note:hover {
  background: theme('colors.accent.50');
  color: theme('colors.accent.700');
  --tw-ring-color: theme('colors.accent.300');
}
html.dark .source-chip--note {
  background: theme('colors.ink.900');
  color: theme('colors.ink.200');
  --tw-ring-color: theme('colors.ink.700');
}
html.dark .source-chip--note:hover {
  color: theme('colors.accent.300');
  --tw-ring-color: theme('colors.accent.500');
}
.source-chip--web {
  background: theme('colors.accent.100');
  color: theme('colors.accent.800');
  --tw-ring-color: theme('colors.accent.300');
}
.source-chip--web:hover {
  background: theme('colors.accent.200');
}
html.dark .source-chip--web {
  background: rgba(120, 113, 108, 0.18);
  color: theme('colors.accent.200');
  --tw-ring-color: theme('colors.accent.700');
}
.web-glyph {
  font-size: 10px;
  line-height: 1;
}
.stale-dot {
  display: inline-block;
  font-size: 10px;
  line-height: 1;
  color: theme('colors.amber.500');
}

.feedback-btn--up {
  color: theme('colors.accent.600') !important;
}
.feedback-btn--down {
  color: theme('colors.red.500') !important;
}

.regen-group {
  @apply relative inline-flex items-center;
  gap: 0;
}
.regen-main {
  border-top-right-radius: 0 !important;
  border-bottom-right-radius: 0 !important;
}
.regen-caret {
  border-top-left-radius: 0 !important;
  border-bottom-left-radius: 0 !important;
  padding-left: 4px !important;
  padding-right: 4px !important;
  border-left: 1px solid transparent;
}
.regen-caret:hover:not(:disabled) {
  border-left-color: theme('colors.ink.200');
}
html.dark .regen-caret:hover:not(:disabled) {
  border-left-color: theme('colors.ink.700');
}
.regen-popover {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  z-index: 30;
  width: 220px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: 8px;
  background: white;
  border: 1px solid theme('colors.ink.200');
  box-shadow: 0 10px 24px -10px rgba(0,0,0,0.18);
}
html.dark .regen-popover {
  background: theme('colors.ink.900');
  border-color: theme('colors.ink.700');
}
.regen-label {
  @apply flex flex-col gap-1 text-[10.5px] uppercase tracking-[0.06em] font-semibold text-ink-600 dark:text-ink-300;
}
.regen-input {
  @apply rounded-md border border-ink-200 bg-white px-2 py-1 text-[12px] font-normal normal-case tracking-normal text-ink-800 focus:border-accent-400 focus:outline-none dark:border-ink-700 dark:bg-ink-800 dark:text-ink-100;
}
.regen-slider {
  width: 100%;
}
.regen-temp-val {
  @apply font-mono normal-case tracking-normal text-ink-500 dark:text-ink-400;
}
.regen-actions {
  @apply flex items-center justify-end gap-1.5;
}
.regen-cancel {
  @apply rounded-md px-2 py-1 text-[10.5px] uppercase tracking-[0.06em] font-semibold text-ink-500 hover:bg-ink-100 dark:text-ink-400 dark:hover:bg-ink-800;
}
.regen-run {
  @apply rounded-md bg-accent-500 px-2 py-1 text-[10.5px] uppercase tracking-[0.06em] font-semibold text-white hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed;
}

.followups {
  @apply mt-2;
}
.followups-title {
  @apply mb-1 text-[10px] uppercase tracking-[0.08em] font-semibold text-ink-500 dark:text-ink-400;
}
.followups-row {
  @apply flex flex-col gap-1;
}
.followup-chip {
  @apply rounded-md px-2 py-1 text-left text-[12px] text-ink-700 ring-1 ring-ink-200 transition hover:bg-accent-50 hover:text-accent-700 hover:ring-accent-300 disabled:opacity-50 disabled:cursor-not-allowed dark:text-ink-200 dark:ring-ink-700 dark:hover:bg-ink-900 dark:hover:text-accent-300 dark:hover:ring-accent-500;
  background: white;
}
html.dark .followup-chip {
  background: theme('colors.ink.900');
}

.web-fallback-row {
  @apply mb-2 flex flex-wrap items-center gap-x-3 gap-y-1;
}
.web-fallback-toggle {
  @apply inline-flex items-center gap-1.5 text-[11px] text-ink-500 dark:text-ink-400 cursor-pointer select-none;
}
.web-fallback-toggle input {
  width: 13px;
  height: 13px;
  accent-color: theme('colors.accent.500');
}

/* ----------------- Composer redesign ----------------- */
.composer-footer {
  @apply border-t border-ink-200 px-3 py-3 dark:border-ink-800/60;
}
.composer-box {
  @apply relative flex flex-col rounded-2xl border bg-white px-2.5 pt-2 pb-1.5 shadow-sm transition-colors;
  border-color: theme('colors.ink.200');
}
html.dark .composer-box {
  background: theme('colors.ink.800');
  border-color: theme('colors.ink.700');
}
.composer-box--focus {
  border-color: theme('colors.accent.400');
  box-shadow: 0 0 0 3px rgba(217, 119, 6, 0.10);
}
html.dark .composer-box--focus {
  border-color: theme('colors.accent.500');
  box-shadow: 0 0 0 3px rgba(217, 119, 6, 0.18);
}

.composer-textarea {
  @apply w-full resize-none border-0 bg-transparent px-1 py-1 text-sm text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-0 dark:text-ink-100 dark:placeholder:text-ink-500;
  min-height: 44px;
  max-height: 200px;
}

.composer-attach {
  @apply mb-2 inline-flex items-center gap-2 self-start rounded-md border bg-ink-50 px-2 py-1;
  border-color: theme('colors.ink.200');
}
html.dark .composer-attach {
  background: theme('colors.ink.900');
  border-color: theme('colors.ink.700');
}
.composer-attach-thumb {
  height: 32px;
  width: auto;
  max-width: 64px;
  border-radius: 4px;
  object-fit: cover;
}
.composer-attach-clear {
  @apply inline-flex h-5 w-5 items-center justify-center rounded-full bg-ink-100 text-ink-600 hover:bg-red-100 hover:text-red-600 dark:bg-ink-700 dark:text-ink-300 dark:hover:bg-red-900/40 dark:hover:text-red-300;
}

.composer-actions {
  @apply mt-1 flex items-center justify-between gap-2;
}
.composer-actions-left,
.composer-actions-right {
  @apply flex items-center gap-1;
}

.composer-icon-btn {
  @apply relative inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-500 transition-colors;
}
.composer-icon-btn:hover:not(:disabled) {
  background: theme('colors.ink.100');
  color: theme('colors.ink.800');
}
html.dark .composer-icon-btn {
  color: theme('colors.ink.400');
}
html.dark .composer-icon-btn:hover:not(:disabled) {
  background: theme('colors.ink.700');
  color: theme('colors.ink.50');
}
.composer-icon-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.composer-icon-btn--active {
  background: theme('colors.accent.50');
  color: theme('colors.accent.700');
}
html.dark .composer-icon-btn--active {
  background: rgba(217, 119, 6, 0.16);
  color: theme('colors.accent.300');
}
.composer-options-dot {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: theme('colors.accent.500');
  box-shadow: 0 0 0 1.5px white;
}
html.dark .composer-options-dot {
  box-shadow: 0 0 0 1.5px theme('colors.ink.800');
}

.composer-send {
  @apply inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent-500 px-3 text-[12.5px] font-medium text-white shadow-sm transition-colors;
}
.composer-send:hover:not(:disabled) {
  background: theme('colors.accent.600');
}
.composer-send:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.composer-send--stop {
  background: theme('colors.red.500');
}
.composer-send--stop:hover {
  background: theme('colors.red.600');
}
html.dark .composer-send--stop {
  background: theme('colors.red.600');
}
html.dark .composer-send--stop:hover {
  background: theme('colors.red.700');
}

/* Options popover anchored bottom-left of the composer box */
.composer-options-popover {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  z-index: 30;
  min-width: 240px;
  @apply flex flex-col gap-1 rounded-xl border bg-white p-2 shadow-lg dark:bg-ink-900;
  border-color: theme('colors.ink.200');
}
html.dark .composer-options-popover {
  border-color: theme('colors.ink.700');
}
.composer-options-title {
  @apply mb-1 px-1 text-[10px] font-sans uppercase font-semibold tracking-[0.08em] text-ink-400 dark:text-ink-500;
}
.composer-option {
  @apply flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-ink-700 hover:bg-ink-50 dark:text-ink-200 dark:hover:bg-ink-800;
}
.composer-option input[type="checkbox"] {
  width: 14px;
  height: 14px;
  accent-color: theme('colors.accent.500');
  flex-shrink: 0;
}
.composer-option-text {
  @apply inline-flex flex-1 items-center gap-2;
}
.composer-option-icon {
  display: inline-block;
  width: 16px;
  text-align: center;
  font-size: 13px;
  opacity: 0.85;
}

/* Popover enter/leave */
.opts-enter-active,
.opts-leave-active {
  transition: opacity 120ms ease, transform 120ms ease;
}
.opts-enter-from,
.opts-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

/* Debug panel (Wave 3 / I5). */
.debug-panel {
  @apply mt-2 rounded-md border px-2 py-1.5 text-[11px];
  background: theme('colors.ink.50');
  border-color: theme('colors.ink.200');
  color: theme('colors.ink.600');
}
html.dark .debug-panel {
  background: theme('colors.ink.950');
  border-color: theme('colors.ink.800');
  color: theme('colors.ink.300');
}
.debug-loading {
  @apply text-[11px] italic;
}
.debug-grid {
  @apply grid grid-cols-2 gap-x-3 gap-y-1;
}
.debug-item {
  @apply flex flex-col;
}
.debug-item dt {
  @apply text-[10px] uppercase tracking-[0.06em] font-semibold text-ink-400 dark:text-ink-500;
}
.debug-item dd {
  @apply font-mono text-[11.5px] text-ink-700 dark:text-ink-200;
}
.debug-note {
  @apply ml-1 text-[10px] uppercase tracking-[0.06em] text-ink-400 dark:text-ink-500;
}
.debug-header {
  @apply mb-1.5 flex items-center justify-between;
}
.debug-header-title {
  @apply text-[10px] font-sans uppercase font-semibold tracking-[0.08em] text-ink-400 dark:text-ink-500;
}
.debug-copy-btn {
  @apply rounded-md px-1.5 py-0.5 text-[10px] font-sans uppercase font-semibold tracking-[0.06em] text-accent-700 hover:bg-accent-50 dark:text-accent-300 dark:hover:bg-accent-900/40;
}
.debug-item--wide {
  grid-column: span 2 / span 2;
}
.debug-query {
  word-break: break-word;
  @apply max-h-16 overflow-y-auto;
}
.debug-err {
  color: theme('colors.red.600');
}
html.dark .debug-err {
  color: theme('colors.red.300');
}
.debug-grid--persisted {
  @apply mt-1.5 border-t border-ink-200 pt-1.5 dark:border-ink-800;
}

/* ----------------- Wave 4 ----------------- */

/* Session list search input + load-more */
.session-search {
  @apply mb-1.5 w-full rounded-md border border-ink-200 bg-white px-2 py-1 text-xs text-ink-800 placeholder:text-ink-400 focus:border-accent-400 focus:outline-none dark:border-ink-700 dark:bg-ink-900 dark:text-ink-100 dark:placeholder:text-ink-500;
}
.session-load-more {
  @apply mt-1 w-full rounded-md px-2 py-1 text-[11px] font-sans uppercase font-semibold tracking-[0.06em] text-ink-500 hover:bg-ink-100 hover:text-ink-800 disabled:opacity-50 dark:text-ink-400 dark:hover:bg-ink-800 dark:hover:text-ink-50;
}

/* Attach button + thumbnail row */
.attach-btn {
  @apply mb-px inline-flex h-9 w-9 items-center justify-center rounded-lg border border-ink-200 bg-white text-ink-600 hover:bg-ink-50 hover:text-accent-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-ink-700 dark:bg-ink-800 dark:text-ink-300 dark:hover:bg-ink-700 dark:hover:text-accent-300;
}
.attach-row {
  @apply mb-2 inline-flex items-center gap-2 rounded-lg border border-ink-200 bg-white px-2 py-1.5 dark:border-ink-700 dark:bg-ink-800;
}
.attach-thumb {
  height: 36px;
  width: auto;
  max-width: 80px;
  border-radius: 4px;
  object-fit: cover;
}
.attach-clear {
  @apply inline-flex h-5 w-5 items-center justify-center rounded-full bg-ink-100 text-ink-600 hover:bg-red-100 hover:text-red-600 dark:bg-ink-700 dark:text-ink-300 dark:hover:bg-red-900/40 dark:hover:text-red-300;
}
.hidden { display: none; }

/* Inline user-message thumbnail */
.msg-thumb {
  display: block;
  max-height: 240px;
  max-width: 100%;
  border-radius: 8px;
  margin-bottom: 6px;
  object-fit: contain;
  background: rgba(0,0,0,0.04);
}

/* Streaming cursor */
.stream-caret {
  display: inline-block;
  margin-left: 1px;
  color: theme('colors.accent.600');
  animation: caret-blink 1s steps(1) infinite;
}
html.dark .stream-caret {
  color: theme('colors.accent.300');
}
@keyframes caret-blink {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
}

/* Partial sources hint */
.partial-sources {
  @apply mt-2 flex flex-wrap items-center gap-1.5 text-[11px] italic text-ink-500 dark:text-ink-400;
}
.partial-sources-title {
  @apply font-sans uppercase not-italic tracking-[0.06em] text-[10px];
}
.partial-sources-list {
  @apply flex flex-wrap gap-1;
}
.partial-source-chip {
  @apply inline-flex max-w-[14ch] truncate rounded-full bg-ink-200/60 px-2 py-px text-[10.5px] not-italic text-ink-600 dark:bg-ink-700 dark:text-ink-200;
}

/* Auto-triggered web search badge */
.web-auto-badge {
  @apply mt-2 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-sans uppercase font-semibold tracking-[0.06em];
  background: theme('colors.accent.50');
  color: theme('colors.accent.700');
  border: 1px solid theme('colors.accent.200');
}
html.dark .web-auto-badge {
  background: rgba(217, 119, 6, 0.14);
  color: theme('colors.accent.200');
  border-color: theme('colors.accent.800');
}

/* Tool call cards */
.tool-calls {
  @apply mt-2 flex flex-col gap-2;
}
.tool-calls-title {
  @apply text-[10px] uppercase tracking-[0.08em] font-semibold text-amber-700 dark:text-amber-300;
}
.tool-call-card {
  @apply rounded-md border px-2 py-1.5;
  background: theme('colors.amber.50');
  border-color: theme('colors.amber.300');
}
html.dark .tool-call-card {
  background: rgba(180, 83, 9, 0.12);
  border-color: theme('colors.amber.700');
}
.tool-call-head {
  @apply font-mono text-[11.5px] font-semibold text-ink-800 dark:text-ink-100;
}
.tool-call-args {
  @apply mt-1 max-h-28 overflow-auto rounded bg-white px-2 py-1 font-mono text-[10.5px] leading-snug text-ink-700 dark:bg-ink-950 dark:text-ink-200;
  white-space: pre-wrap;
  word-break: break-word;
}
.tool-call-actions {
  @apply mt-1.5 flex items-center justify-end gap-1.5;
}
.tool-call-btn {
  @apply rounded-md px-2 py-1 text-[10.5px] uppercase tracking-[0.06em] font-semibold transition;
}
.tool-call-btn--reject {
  @apply text-ink-600 hover:bg-ink-200 dark:text-ink-300 dark:hover:bg-ink-700;
}
.tool-call-btn--approve {
  @apply bg-accent-500 text-white hover:bg-accent-600;
}

/* No-notes-matched help */
.empty-help {
  @apply mt-2 rounded-md border px-2.5 py-2;
  background: theme('colors.accent.50');
  border-color: theme('colors.accent.200');
}
html.dark .empty-help {
  background: rgba(120, 113, 108, 0.12);
  border-color: theme('colors.accent.700');
}
.empty-help-title {
  @apply text-[12px] font-semibold text-accent-800 dark:text-accent-200;
}
.empty-help-hint {
  @apply mt-0.5 text-[11.5px] text-ink-700 dark:text-ink-300;
}
.empty-help-actions {
  @apply mt-1.5 flex flex-wrap gap-1.5;
}
.empty-help-btn {
  @apply rounded-md bg-accent-500 px-2 py-1 text-[10.5px] uppercase tracking-[0.06em] font-semibold text-white hover:bg-accent-600;
}
.empty-help-btn--ghost {
  @apply bg-transparent text-accent-700 ring-1 ring-accent-300 hover:bg-accent-100 dark:text-accent-200 dark:ring-accent-700 dark:hover:bg-accent-900/40;
}

/* Jump to latest floater */
.jump-latest {
  position: absolute;
  right: 14px;
  bottom: 14px;
  z-index: 5;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  background: theme('colors.accent.500');
  color: white;
  box-shadow: 0 6px 14px -6px rgba(0, 0, 0, 0.4);
}
.jump-latest:hover {
  background: theme('colors.accent.600');
}
</style>
