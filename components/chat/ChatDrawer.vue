<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore, type ChatSource } from '~/stores/chat'
import { useWorkspacesStore } from '~/stores/workspaces'
import { useTreeStore } from '~/stores/tree'
import { renderMarkdown } from '~/composables/useMarkdownView'
import { useLocale } from '~/composables/useLocale'

const { t, locale } = useLocale()

const emit = defineEmits<{
  (e: 'open-doc', docId: number): void
}>()

const chat = useChatStore()
const workspaces = useWorkspacesStore()
const tree = useTreeStore()

const { open, sessions, messages, currentSessionId, scopeFolderId, scopeDocId, sending, loadingSessions, pendingQuestion } =
  storeToRefs(chat)

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

function scrollToBottom() {
  nextTick(() => {
    const el = scrollArea.value
    if (el) el.scrollTop = el.scrollHeight
  })
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
    composer.value?.focus()
  }
  else {
    composer.value?.focus()
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
  composer.value?.focus()
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
  await chat.send(text)
}

async function newSession() {
  chat.newSession()
  await nextTick()
  composer.value?.focus()
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

function openSource(s: ChatSource) {
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
    }
  : {
      branch: 'Branch',
      branchTitle: 'Branch from here (copy up to this message into a new session)',
      branchPending: 'Branching…',
      branchedFrom: 'Branched from "{title}"',
      branchedFromUnknown: 'Branched from another session',
    })

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

onMounted(() => {
  if (workspaceId.value != null && chat.workspaceId !== workspaceId.value) {
    chat.setWorkspace(workspaceId.value)
  }
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
  <Teleport to="body">
    <!-- Backdrop -->
    <Transition name="fade">
      <div
        v-if="open"
        class="fixed inset-0 z-40 bg-ink-950/20 backdrop-blur-[1px]"
        @click="chat.close()"
      />
    </Transition>

    <!-- Drawer -->
    <Transition name="slide">
      <aside
        v-if="open"
        class="chat-drawer fixed right-0 top-0 z-50 flex h-full w-full md:w-[420px] md:max-w-full flex-col border-l border-ink-200 bg-white shadow-2xl dark:border-ink-800/60 dark:bg-ink-900"
      >
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
          class="max-h-56 overflow-y-auto border-b border-ink-100 bg-ink-50/60 px-2 py-2 dark:border-ink-800/60 dark:bg-ink-950/60"
        >
          <p v-if="loadingSessions" class="px-2 py-1 text-xs text-ink-400 dark:text-ink-500">{{ t('chat.sessions.loading') }}</p>
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
                class="rounded p-1 text-ink-400 opacity-0 hover:text-red-500 group-hover:opacity-100 dark:text-ink-500 dark:hover:text-red-400"
                :title="t('chat.sessions.delete')"
                @click="removeSession(s.id)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
              </button>
            </li>
          </ul>
        </div>

        <!-- Messages -->
        <main ref="scrollArea" class="flex-1 space-y-3 overflow-y-auto px-4 py-4">
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
                <div
                  v-if="m.role === 'assistant' && m.content"
                  class="msg-md break-words"
                  v-html="renderMarkdown(m.content)"
                />
                <p
                  v-else
                  class="whitespace-pre-wrap break-words"
                >{{ m.content || (m.pending ? '…' : '') }}</p>

                <!-- Source chips for assistant messages -->
                <div
                  v-if="m.role === 'assistant' && m.sources.length"
                  class="mt-2 flex flex-wrap gap-1"
                >
                  <button
                    v-for="(s, i) in m.sources"
                    :key="`${m.id}-${i}`"
                    class="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-ink-700 ring-1 ring-ink-200 transition hover:bg-accent-50 hover:text-accent-700 hover:ring-accent-300 dark:bg-ink-900 dark:text-ink-200 dark:ring-ink-700 dark:hover:bg-ink-900 dark:hover:text-accent-300 dark:hover:ring-accent-500"
                    :title="s.highlight || s.snippet"
                    @click="openSource(s)"
                  >
                    [#{{ s.citation ?? i + 1 }}] {{ s.title || t('chat.sourceFallback', { id: s.docId }) }}
                  </button>
                </div>
              </template>
            </div>

            <!-- Hover action bar: regenerate (assistant) / edit (user) -->
            <div
              v-if="isPersisted(m.id) && editingId !== m.id"
              class="msg-actions"
            >
              <button
                v-if="m.role === 'assistant' && !m.pending && !m.errored"
                type="button"
                class="msg-action-btn"
                :disabled="sending"
                :title="t('chat.regenerateTitle')"
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

        <!-- Composer -->
        <footer class="border-t border-ink-200 px-3 py-3 dark:border-ink-800/60">
          <div class="flex items-end gap-2">
            <textarea
              ref="composer"
              v-model="draft"
              rows="2"
              :placeholder="t('chat.placeholder')"
              class="flex-1 resize-none rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-accent-400 focus:outline-none focus:ring-1 focus:ring-accent-300 dark:border-ink-800 dark:bg-ink-800 dark:text-ink-100 dark:placeholder:text-ink-500"
              :disabled="sending"
              @keydown="onKeydown"
            />
            <button
              class="rounded-lg bg-accent-500 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-600 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="sending || draft.trim().length === 0"
              @click="onSend"
            >
              <span v-if="sending">…</span>
              <span v-else>{{ t('chat.send') }}</span>
            </button>
          </div>
        </footer>
      </aside>
    </Transition>
  </Teleport>
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
.slide-enter-active,
.slide-leave-active {
  transition: transform 220ms cubic-bezier(0.2, 0.7, 0.2, 1);
}
.slide-enter-from,
.slide-leave-to {
  transform: translateX(100%);
}

/* Mobile (F10): full-screen overlay; honor iOS safe areas top + bottom. */
@media (max-width: 767px) {
  .chat-drawer {
    padding-top: env(safe-area-inset-top, 0);
    padding-bottom: env(safe-area-inset-bottom, 0);
    border-left-width: 0;
  }
}

/* Per-message hover action bar (regenerate / edit). */
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
  @apply flex items-center gap-1 px-1 opacity-0 transition-opacity;
}
.group:hover .msg-actions,
.msg-actions:focus-within {
  @apply opacity-100;
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
</style>
