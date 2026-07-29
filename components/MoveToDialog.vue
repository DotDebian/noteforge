<script setup lang="ts">
/**
 * "Déplacer vers…" — destination picker for the sidebar's bulk move.
 *
 * Two cascading selects: workspace (defaults to the active one, viewer-role
 * workspaces are excluded since you can't write there) then folder — "Racine"
 * plus every active folder of that workspace, indented by depth.
 *
 * Folders for a workspace other than the active one aren't in the tree store,
 * so they're fetched from `GET /api/workspaces/:id` (which resolves the right
 * content key server-side — solo DEK or shared WEK) and memoised per open.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import type { Folder } from '~/server/database/schema'
import { useWorkspacesStore } from '~/stores/workspaces'

const props = defineProps<{
  open: boolean
  /** Notes selected on their own (those inside a selected folder travel with it). */
  docCount: number
  /** Folders selected — each moves with its whole subtree. */
  folderCount: number
  /**
   * Folders being moved: they and their descendants are not valid
   * destinations (a folder can't land inside itself).
   */
  excludeFolderIds?: number[]
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'confirm', payload: { workspaceId: number, folderId: number | null }): void
}>()

const L = {
  eyebrow: 'Sélection groupée',
  title: 'Déplacer vers…',
  lede: (docs: number, dirs: number) => {
    const parts: string[] = []
    if (docs > 0) parts.push(docs === 1 ? '1 note' : `${docs} notes`)
    if (dirs > 0) parts.push(dirs === 1 ? '1 dossier (avec tout son contenu)' : `${dirs} dossiers (avec tout leur contenu)`)
    if (parts.length === 0) return 'Rien de sélectionné.'
    return `${parts.join(' et ')} vers la destination choisie.`
  },
  workspaceLabel: 'Workspace',
  folderLabel: 'Dossier',
  root: 'Racine',
  loading: 'Chargement des dossiers…',
  shared: 'partagé',
  readOnlyHint: 'Les workspaces en lecture seule ne sont pas proposés.',
  crossWarning: 'Changement de workspace : les notes seront rechiffrées avec la clé de destination. Les liens publics existants seront révoqués et les liens entre notes pointant vers l\'ancien workspace seront retirés.',
  cancel: 'Annuler',
  confirm: 'Déplacer',
  confirming: 'Déplacement…',
  loadError: 'Impossible de charger les dossiers de ce workspace.',
}

const workspacesStore = useWorkspacesStore()
const { current, workspaces } = storeToRefs(workspacesStore)

/** Destinations the caller can actually write to. */
const targetWorkspaces = computed(() => workspaces.value.filter(w => w.role !== 'viewer'))

const workspaceId = ref<number | null>(null)
const folderId = ref<number | null>(null)
const folderCache = ref<Record<number, Folder[]>>({})
const loadingFolders = ref(false)
const error = ref<string | null>(null)
const workspaceSelect = ref<HTMLSelectElement | null>(null)

const crossWorkspace = computed(
  () => workspaceId.value != null && workspaceId.value !== current.value?.id,
)

interface FolderOption {
  id: number
  label: string
}

/**
 * Flatten the folder list into a depth-ordered option list. Indentation uses
 * NBSP because `<option>` collapses regular whitespace.
 */
const folderOptions = computed<FolderOption[]>(() => {
  const id = workspaceId.value
  if (id == null) return []
  const rows = folderCache.value[id]
  if (!rows) return []

  const byParent = new Map<number | null, Folder[]>()
  for (const f of rows) {
    const key = f.parentId ?? null
    const bucket = byParent.get(key)
    if (bucket) bucket.push(f)
    else byParent.set(key, [f])
  }

  // A folder being moved can't be its own destination, and neither can
  // anything beneath it — the whole branch is pruned from the options.
  const excluded = new Set(props.excludeFolderIds ?? [])

  const out: FolderOption[] = []
  const walk = (parentId: number | null, depth: number) => {
    for (const f of byParent.get(parentId) ?? []) {
      if (excluded.has(f.id)) continue
      out.push({ id: f.id, label: `${'  '.repeat(depth)}${depth > 0 ? '└ ' : ''}${f.name}` })
      walk(f.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
})

async function loadFolders(id: number) {
  if (folderCache.value[id]) return
  loadingFolders.value = true
  error.value = null
  try {
    const res = await $fetch<{ folders: Folder[] }>(`/api/workspaces/${id}`)
    folderCache.value = { ...folderCache.value, [id]: res.folders }
  }
  catch (e) {
    error.value = (e as Error).message || L.loadError
    folderCache.value = { ...folderCache.value, [id]: [] }
  }
  finally {
    loadingFolders.value = false
  }
}

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return
    // Fresh cache each time: folders may have been renamed / added since.
    folderCache.value = {}
    error.value = null
    folderId.value = null
    // Default to the active workspace — unless the caller is only a viewer
    // there, in which case it isn't a legal destination at all.
    const currentId = current.value?.id ?? null
    workspaceId.value = targetWorkspaces.value.some(w => w.id === currentId)
      ? currentId
      : targetWorkspaces.value[0]?.id ?? null
    if (workspaceId.value != null) await loadFolders(workspaceId.value)
    await nextTick()
    workspaceSelect.value?.focus()
  },
)

// Switching workspace invalidates the folder choice — a folder id only means
// something inside its own workspace.
watch(workspaceId, async (id) => {
  folderId.value = null
  if (props.open && id != null) await loadFolders(id)
})

function close() {
  if (props.busy) return
  emit('close')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}

function onSubmit() {
  if (props.busy || workspaceId.value == null || loadingFolders.value) return
  emit('confirm', { workspaceId: workspaceId.value, folderId: folderId.value })
}

function workspaceLabel(w: { name: string, emoji?: string | null, shared: boolean }): string {
  const base = w.emoji ? `${w.emoji} ${w.name}` : w.name
  return w.shared ? `${base} · ${L.shared}` : base
}
</script>

<template>
  <Teleport to="body">
    <Transition name="overlay">
      <div
        v-if="open"
        class="overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-to-title"
        @click.self="close"
        @keydown="onKeydown"
      >
        <Transition name="card" appear>
          <div v-if="open" class="card">
            <header class="head">
              <p class="eyebrow">{{ L.eyebrow }}</p>
              <h2 id="move-to-title" class="title">{{ L.title }}</h2>
              <p class="lede">{{ L.lede(docCount, folderCount) }}</p>
            </header>

            <form class="form" @submit.prevent="onSubmit">
              <label class="field">
                <span class="label">{{ L.workspaceLabel }}</span>
                <select ref="workspaceSelect" v-model.number="workspaceId" :disabled="busy">
                  <option v-for="w in targetWorkspaces" :key="w.id" :value="w.id">
                    {{ workspaceLabel(w) }}
                  </option>
                </select>
                <span class="hint">{{ L.readOnlyHint }}</span>
              </label>

              <label class="field">
                <span class="label">{{ L.folderLabel }}</span>
                <select v-model="folderId" :disabled="busy || loadingFolders">
                  <option :value="null">{{ L.root }}</option>
                  <option v-for="f in folderOptions" :key="f.id" :value="f.id">
                    {{ f.label }}
                  </option>
                </select>
                <span v-if="loadingFolders" class="hint">{{ L.loading }}</span>
              </label>

              <p v-if="crossWorkspace" class="warning">{{ L.crossWarning }}</p>
              <p v-if="error" class="error">{{ error }}</p>

              <div class="actions">
                <button type="button" class="ghost-btn" :disabled="busy" @click="close">
                  {{ L.cancel }}
                </button>
                <button
                  type="submit"
                  class="primary"
                  :disabled="busy || loadingFolders || workspaceId == null"
                >
                  <span v-if="!busy">{{ L.confirm }}</span>
                  <span v-else>{{ L.confirming }}</span>
                </button>
              </div>
            </form>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.overlay {
  @apply fixed inset-0 z-50 flex items-center justify-center px-6 py-10;
  background: theme('colors.ink.900' / 35%);
  backdrop-filter: blur(4px);
}
html.dark .overlay {
  background: theme('colors.ink.950' / 70%);
}

.card {
  @apply relative w-full max-w-[440px] rounded-lg bg-ink-50 dark:bg-ink-900 px-8 py-7;
  border: 1px solid theme('colors.ink.200');
  box-shadow: 0 24px 60px -20px theme('colors.ink.900' / 35%);
}
html.dark .card {
  border-color: theme('colors.ink.800');
  box-shadow: 0 24px 60px -20px theme('colors.ink.950' / 70%);
}

.head { @apply mb-6; }
.eyebrow { @apply label-mono mb-3; }
.title {
  @apply font-serif text-[1.7rem] leading-[1.1] tracking-tight text-ink-900 dark:text-ink-100 mb-2;
}
.lede { @apply text-[13px] leading-relaxed text-ink-600 dark:text-ink-300; }

.form { @apply flex flex-col gap-5; }
.field { @apply flex flex-col gap-2 border-0 p-0; }
.label { @apply label-mono; }

.field select {
  @apply w-full bg-transparent border-0 border-b border-ink-300 dark:border-ink-700 px-0 py-2 text-[15px] text-ink-900 dark:text-ink-100;
  outline: none;
  transition: border-color 140ms ease;
}
.field select:focus { @apply border-ink-900; }
html.dark .field select:focus { border-color: theme('colors.ink.100'); }
.field select:disabled { opacity: 0.55; cursor: not-allowed; }
.field select option {
  @apply bg-ink-50 text-ink-900;
}
html.dark .field select option {
  background: theme('colors.ink.900');
  color: theme('colors.ink.100');
}

.hint { @apply font-sans text-[11px] leading-snug text-ink-400 dark:text-ink-500; }

.warning {
  @apply font-sans text-[12px] leading-relaxed text-ink-600 dark:text-ink-300 rounded px-3 py-2;
  background: theme('colors.ink.100');
}
html.dark .warning { background: theme('colors.ink.800'); }

.actions { @apply flex items-center justify-end gap-3 pt-2; }

.primary {
  @apply inline-flex items-center justify-center h-10 px-5 rounded font-sans uppercase text-[11px] font-semibold tracking-[0.12em] text-white;
  background: theme('colors.ink.900');
  transition: background 120ms ease, color 120ms ease;
}
html.dark .primary {
  background: theme('colors.ink.800');
  color: theme('colors.ink.100');
}
.primary:hover:not(:disabled) { background: theme('colors.accent.600'); }
html.dark .primary:hover:not(:disabled) { background: theme('colors.accent.600'); color: theme('colors.ink.50'); }
.primary:disabled { opacity: 0.55; cursor: not-allowed; }

.ghost-btn {
  @apply inline-flex items-center justify-center h-10 px-4 rounded font-sans uppercase text-[11px] font-semibold tracking-[0.12em] text-ink-700 dark:text-ink-200;
  border: 1px solid theme('colors.ink.200');
  background: transparent;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}
html.dark .ghost-btn { border-color: theme('colors.ink.800'); }
.ghost-btn:hover:not(:disabled) {
  background: theme('colors.ink.100');
  border-color: theme('colors.ink.300');
  color: theme('colors.ink.900');
}
html.dark .ghost-btn:hover:not(:disabled) {
  background: theme('colors.ink.800');
  border-color: theme('colors.ink.700');
  color: theme('colors.ink.50');
}
.ghost-btn:disabled { opacity: 0.55; cursor: not-allowed; }

.error { @apply font-sans text-[12px] text-accent-700 dark:text-accent-300; }

/* Transitions */
.overlay-enter-from, .overlay-leave-to { opacity: 0; }
.overlay-enter-active, .overlay-leave-active { transition: opacity 140ms ease; }
.card-enter-from { opacity: 0; transform: translateY(8px) scale(0.98); }
.card-enter-to { opacity: 1; transform: translateY(0) scale(1); }
.card-enter-active { transition: opacity 160ms ease, transform 160ms ease; }
</style>
