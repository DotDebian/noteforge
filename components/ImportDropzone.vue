<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { useWorkspacesStore } from '~/stores/workspaces'
import { useTreeStore } from '~/stores/tree'
import { useDialog } from '~/composables/useDialog'
import { useLocale } from '~/composables/useLocale'

const workspacesStore = useWorkspacesStore()
const treeStore = useTreeStore()
const dialog = useDialog()
const { t } = useLocale()

const active = ref(false)
const importing = ref(false)
let dragDepth = 0

const ALLOWED_EXTS = ['.md', '.markdown', '.txt'] as const
const MAX_FILES = 200
const MAX_DEPTH = 10
const MAX_BYTES = 10 * 1024 * 1024

interface CollectedFile {
  path: string
  content: string
}

interface ImportResponse {
  documents: { id: number, title: string, folderId: number | null }[]
  folders: { id: number, name: string, parentId: number | null }[]
}

/** What to surface to the user once the busy overlay is down. */
interface ImportOutcome {
  title: string
  message: string
}

function hasFileItems(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  if (!types) return false
  for (let i = 0; i < types.length; i++) {
    if (types[i] === 'Files') return true
  }
  return false
}

function onDragEnter(e: DragEvent) {
  if (!workspacesStore.currentWorkspaceId) return
  if (!hasFileItems(e)) return
  dragDepth++
  active.value = true
  e.preventDefault()
}

function onDragOver(e: DragEvent) {
  if (!workspacesStore.currentWorkspaceId) return
  if (!hasFileItems(e)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}

function onDragLeave(e: DragEvent) {
  if (!active.value) return
  dragDepth = Math.max(0, dragDepth - 1)
  // Browser fires dragleave when entering a child; only reset when depth
  // hits zero AND the cursor has actually left the window.
  if (dragDepth === 0) active.value = false
  e.preventDefault()
}

async function onDrop(e: DragEvent) {
  dragDepth = 0
  if (!active.value) return
  active.value = false
  e.preventDefault()

  const workspaceId = workspacesStore.currentWorkspaceId
  if (!workspaceId) return
  if (!e.dataTransfer) return

  importing.value = true
  let outcome: ImportOutcome
  try {
    outcome = await collectAndImport(e.dataTransfer, workspaceId)
  }
  catch (err) {
    const msg = err instanceof Error
      ? err.message
      : (err as { statusMessage?: string })?.statusMessage ?? 'Unknown error'
    outcome = { title: t('import.failedTitle'), message: msg }
  }
  finally {
    // Tear the busy overlay down BEFORE surfacing any dialog — otherwise the
    // result modal renders behind the still-mounted overlay (z-50 + busy
    // pointer-events), trapping it (and blocking dismissal).
    importing.value = false
  }

  await dialog.alert(outcome)
}

/**
 * Collect the dropped files, validate, POST to the import endpoint and
 * refresh the tree. Returns the dialog descriptor to show afterwards —
 * never opens a dialog itself, so the caller controls timing relative to
 * the busy overlay.
 */
async function collectAndImport(
  dataTransfer: DataTransfer,
  workspaceId: number,
): Promise<ImportOutcome> {
  const collected: CollectedFile[] = []
  const items = dataTransfer.items
  if (items && items.length > 0) {
    const promises: Promise<void>[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (!item || item.kind !== 'file') continue
      // webkitGetAsEntry is non-standard but widely supported in evergreen
      // browsers — feature-detect. Must be called synchronously here, before
      // any await, while the DataTransferItemList is still alive.
      const entry = typeof (item as { webkitGetAsEntry?: () => unknown }).webkitGetAsEntry === 'function'
        ? (item as { webkitGetAsEntry: () => FileSystemEntry | null }).webkitGetAsEntry()
        : null
      if (entry) {
        promises.push(walkEntry(entry, '', collected, 0))
      }
      else {
        const file = item.getAsFile()
        if (file) {
          const content = await readFileText(file)
          collected.push({ path: file.name, content })
        }
      }
    }
    await Promise.all(promises)
  }
  else if (dataTransfer.files) {
    // Fallback: flat file list (no folder structure).
    for (let i = 0; i < dataTransfer.files.length; i++) {
      const file = dataTransfer.files[i]
      if (!file) continue
      if (!hasAllowedExt(file.name)) continue
      const content = await readFileText(file)
      collected.push({ path: file.name, content })
    }
  }

  if (collected.length === 0) {
    return { title: t('import.noFilesTitle'), message: t('import.noFilesMsg') }
  }

  if (collected.length > MAX_FILES) {
    return {
      title: t('import.tooManyTitle'),
      message: t('import.tooManyMsg', { max: MAX_FILES, n: collected.length }),
    }
  }

  let bytes = 0
  for (const f of collected) bytes += new Blob([f.content]).size
  if (bytes > MAX_BYTES) {
    return {
      title: t('import.tooLargeTitle'),
      message: t('import.tooLargeMsg', { mb: Math.round(MAX_BYTES / (1024 * 1024)) }),
    }
  }

  const res = await $fetch<ImportResponse>('/api/import/markdown', {
    method: 'POST',
    body: {
      workspaceId,
      parentFolderId: null,
      files: collected,
    },
  })

  await treeStore.fetchWorkspaceTree(workspaceId, true)
  const docsPart = res.documents.length === 1
    ? t('import.completeOneDoc')
    : t('import.completeDocs', { n: res.documents.length })
  const foldersPart = res.folders.length === 0
    ? t('import.completePeriod')
    : res.folders.length === 1
      ? t('import.completeOneFolder')
      : t('import.completeFolders', { n: res.folders.length })
  return {
    title: t('import.completeTitle'),
    message: `${docsPart}${foldersPart}`,
  }
}

async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: CollectedFile[],
  depth: number,
): Promise<void> {
  if (depth > MAX_DEPTH) return
  if (out.length >= MAX_FILES) return

  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry
    if (!hasAllowedExt(fileEntry.name)) return
    const file = await getFile(fileEntry)
    const content = await readFileText(file)
    const relPath = prefix ? `${prefix}/${fileEntry.name}` : fileEntry.name
    out.push({ path: relPath, content })
    return
  }

  if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry
    const subPrefix = prefix ? `${prefix}/${dirEntry.name}` : dirEntry.name
    const reader = dirEntry.createReader()
    // readEntries returns batches — loop until empty.
    while (true) {
      const batch = await readEntries(reader)
      if (batch.length === 0) break
      for (const child of batch) {
        await walkEntry(child, subPrefix, out, depth + 1)
        if (out.length >= MAX_FILES) return
      }
    }
  }
}

function getFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject)
  })
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries(entries => resolve(entries), err => reject(err))
  })
}

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : '')
    fr.onerror = () => reject(fr.error ?? new Error('Failed to read file'))
    fr.readAsText(file)
  })
}

function hasAllowedExt(name: string): boolean {
  const lower = name.toLowerCase()
  return ALLOWED_EXTS.some(ext => lower.endsWith(ext))
}

onMounted(() => {
  window.addEventListener('dragenter', onDragEnter)
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('drop', onDrop)
})

onBeforeUnmount(() => {
  window.removeEventListener('dragenter', onDragEnter)
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('drop', onDrop)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="active || importing"
      class="dropzone-overlay"
      :class="{ 'dropzone-overlay--busy': importing }"
    >
      <div class="dropzone-card">
        <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
          <path
            d="M12 3v12 M7 10l5 5 5-5 M4 18h16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <p v-if="!importing" class="dropzone-msg">
          {{ t('import.drop') }}
        </p>
        <p v-else class="dropzone-msg">
          {{ t('import.importing') }}
        </p>
        <p class="dropzone-hint">
          {{ t('import.hint') }}
        </p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dropzone-overlay {
  @apply fixed inset-0 z-50 flex items-center justify-center;
  background: theme('colors.ink.900' / 35%);
  backdrop-filter: blur(4px);
  pointer-events: none;
}
html.dark .dropzone-overlay {
  background: theme('colors.ink.950' / 55%);
}
.dropzone-overlay--busy {
  pointer-events: auto;
}
.dropzone-card {
  @apply flex flex-col items-center gap-2 px-8 py-6 rounded-lg text-ink-900 dark:text-ink-100;
  background: theme('colors.ink.50');
  border: 2px dashed theme('colors.accent.500');
  box-shadow: 0 10px 30px theme('colors.ink.900' / 25%);
}
html.dark .dropzone-card {
  background: theme('colors.ink.900');
  border-color: theme('colors.accent.400');
}
.dropzone-msg {
  @apply font-serif text-[18px] mt-1;
}
.dropzone-hint {
  @apply font-sans text-[11.5px] uppercase tracking-[0.1em] text-ink-500 dark:text-ink-400;
}
</style>
