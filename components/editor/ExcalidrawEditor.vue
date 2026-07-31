<script setup lang="ts">
/**
 * Standalone drawing editor — the `type: 'excalidraw'` counterpart to
 * `DocumentEditor`.
 *
 * Mounts the Excalidraw React app as an island inside Vue. React, react-dom and
 * `@excalidraw/excalidraw` are lazy-imported on mount so a workspace with no
 * drawings never downloads them (~1.1 MB JS + 143 KB CSS in their own chunks).
 *
 * Every save writes BOTH columns, and the pairing matters:
 *   contentJson  the `.excalidraw` scene — source of truth.
 *   markdown     derived (`buildDrawingMarkdown`): the drawing's text, then a
 *                PNG data URL. It is what makes a drawing searchable,
 *                exportable, transcludable and shareable. See
 *                `utils/excalidraw-scene.ts`.
 *
 * Because a headless writer (MCP `write_drawing`) cannot render a PNG, a
 * drawing may arrive here with text but no image. `maybeHealPreview` notices
 * and re-persists once, which is the only path that ever regenerates it.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLocale, useLocalizedTimeAgo } from '~/composables/useLocale'
import { useTheme } from '~/composables/useTheme'
import { useDocumentSaver } from '~/composables/useDocumentSaver'
import {
  buildDrawingMarkdown,
  emptyExcalidrawScene,
  parseExcalidrawScene,
  type ExcalidrawScene,
} from '~/utils/excalidraw-scene'
import type { Document } from '~/server/database/schema'

import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'

// Type-only module handles — the runtime imports happen in `mountExcalidraw`.
type ReactModule = typeof import('react')
type ReactDomClientModule = typeof import('react-dom/client')
type ExcalidrawModule = typeof import('@excalidraw/excalidraw')
type ReactRoot = ReturnType<ReactDomClientModule['createRoot']>

interface Props { doc: Document }
const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'update:title', value: string): void
  (e: 'update:markdown', value: string): void
}>()

const { t, locale } = useLocale()
const { isDark } = useTheme()

const docId = computed(() => props.doc.id)
const saver = useDocumentSaver(docId, 500)
const ago = useLocalizedTimeAgo(() => saver.lastSavedAt.value ?? new Date())

const title = ref<string>(props.doc.title)

const statusLabel = computed<string>(() => {
  switch (saver.status.value) {
    case 'saving':
      return t('doc.status.saving')
    case 'error':
      return saver.error.value
        ? `${t('doc.status.errorPrefix')}: ${saver.error.value}`
        : t('doc.status.error')
    case 'saved':
      return saver.lastSavedAt.value
        ? t('doc.status.savedAt', { time: ago.value })
        : t('doc.status.saved')
    default:
      return saver.lastSavedAt.value
        ? t('doc.status.savedAt', { time: ago.value })
        : ''
  }
})

/* -------------------------------------------------------------------------- */
/*  Title                                                                      */
/* -------------------------------------------------------------------------- */

function onTitleInput(): void {
  const next = title.value.trim() || t('doc.untitled')
  saver.save({ title: next })
  emit('update:title', next)
}

function onTitleBlur(): void {
  if (title.value.trim().length === 0) {
    const fallback = t('doc.untitled')
    title.value = fallback
    emit('update:title', fallback)
  }
}

watch(() => props.doc.id, () => { title.value = props.doc.title })

/* -------------------------------------------------------------------------- */
/*  Excalidraw runtime                                                         */
/* -------------------------------------------------------------------------- */

const hostRef = ref<HTMLDivElement | null>(null)
const status = ref<'loading' | 'ready' | 'failed'>('loading')

let react: ReactModule | null = null
let excalidraw: ExcalidrawModule | null = null
let root: ReactRoot | null = null
let api: ExcalidrawImperativeAPI | null = null
let initialData: ExcalidrawInitialDataState = {}
let disposed = false

/** Seeded from the loaded scene so merely opening a drawing never saves it. */
let lastSceneVersion = -1
let lastBackground = ''

const PERSIST_DEBOUNCE_MS = 700
let persistTimer: ReturnType<typeof setTimeout> | null = null

// Preview budget. The PNG is inlined in the note's markdown, which is then
// encrypted, snapshotted into document_versions and (stripped) chunked — an
// unbounded canvas would make every one of those heavier.
const PREVIEW_MAX_DIM = 720
const PREVIEW_MAX_CHARS = 200_000

async function buildPreview(
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
): Promise<string> {
  if (!excalidraw || elements.length === 0) return ''
  try {
    for (const maxWidthOrHeight of [PREVIEW_MAX_DIM, Math.round(PREVIEW_MAX_DIM / 2)]) {
      const canvas = await excalidraw.exportToCanvas({
        elements,
        files,
        maxWidthOrHeight,
        exportPadding: 8,
        appState: {
          exportBackground: true,
          // Exports land on white paper — never bake the dark theme in,
          // whatever the editor happens to be showing.
          exportWithDarkMode: false,
          viewBackgroundColor: appState.viewBackgroundColor || '#ffffff',
        },
      })
      const url = canvas.toDataURL('image/png')
      if (url.length <= PREVIEW_MAX_CHARS) return url
    }
  }
  catch (err) {
    console.warn('[excalidraw] preview export failed', err)
  }
  return ''
}

async function persistNow(): Promise<void> {
  if (disposed || !api || !excalidraw) return
  const elements = api.getSceneElements()
  const appState = api.getAppState()
  const files = api.getFiles()

  const scene = JSON.parse(
    excalidraw.serializeAsJSON(elements, appState, files, 'local'),
  ) as ExcalidrawScene
  const preview = await buildPreview(elements, appState, files)
  if (disposed) return

  const markdown = buildDrawingMarkdown({ scene, preview, title: title.value })
  saver.save({ contentJson: scene, markdown })
  emit('update:markdown', markdown)
}

function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    void persistNow()
  }, PERSIST_DEBOUNCE_MS)
}

function handleChange(
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  _files: BinaryFiles,
): void {
  if (!excalidraw) return
  // Excalidraw fires onChange on pan, zoom and selection too. `getSceneVersion`
  // sums element versions, so it only moves when the drawing itself does.
  const version = excalidraw.getSceneVersion(elements)
  const background = appState.viewBackgroundColor ?? ''
  if (version === lastSceneVersion && background === lastBackground) return
  lastSceneVersion = version
  lastBackground = background
  schedulePersist()
}

function renderRoot(): void {
  if (!root || !react || !excalidraw) return
  root.render(react.createElement(excalidraw.Excalidraw, {
    initialData,
    excalidrawAPI: (instance: ExcalidrawImperativeAPI) => { api = instance },
    onChange: handleChange,
    theme: isDark.value ? 'dark' : 'light',
    langCode: locale.value === 'fr' ? 'fr-FR' : 'en',
    // The title input above owns the caret on load.
    autoFocus: false,
    UIOptions: {
      canvasActions: {
        // Theme follows the app shell; "save to file" is meaningless here —
        // the scene lives in the document, not on disk.
        toggleTheme: false,
        saveToActiveFile: false,
      },
    },
  }))
}

/**
 * A drawing written by a headless client has text but no rendered image. Detect
 * that and persist once so exports, transclusions and shares get their picture.
 */
function maybeHealPreview(scene: ExcalidrawScene): void {
  const hasElements = scene.elements.some(el => el && !el.isDeleted)
  const hasImage = (props.doc.markdown ?? '').includes('](data:image/')
  if (hasElements && !hasImage) schedulePersist()
}

async function mountExcalidraw(): Promise<void> {
  if (typeof window === 'undefined' || disposed) return
  // Must be set before the module evaluates its font definitions, or Excalidraw
  // falls back to fetching them from esm.sh.
  window.EXCALIDRAW_ASSET_PATH = '/excalidraw/'
  try {
    const [reactMod, reactDomMod, excMod] = await Promise.all([
      import('react'),
      import('react-dom/client'),
      import('@excalidraw/excalidraw'),
      import('@excalidraw/excalidraw/index.css'),
    ])
    if (disposed) return
    react = reactMod
    excalidraw = excMod
    await nextTick()
    const host = hostRef.value
    if (!host || disposed) return

    const scene = parseExcalidrawScene(props.doc.contentJson) ?? emptyExcalidrawScene()
    const appState = { ...scene.appState } as Record<string, unknown>
    // The `theme` prop drives light/dark from the app shell; a theme baked into
    // an old save must not win over the user's current setting.
    delete appState.theme

    lastSceneVersion = excMod.getSceneVersion(scene.elements as ExcalidrawElement[])
    lastBackground = (scene.appState.viewBackgroundColor as string) ?? ''

    initialData = {
      elements: scene.elements as ExcalidrawElement[],
      appState,
      files: scene.files as ExcalidrawInitialDataState['files'],
      scrollToContent: true,
    }

    root = reactDomMod.createRoot(host)
    renderRoot()
    status.value = 'ready'
    maybeHealPreview(scene)
  }
  catch (err) {
    console.error('[excalidraw] could not load the editor', err)
    status.value = 'failed'
  }
}

onMounted(() => { void mountExcalidraw() })

onBeforeUnmount(() => {
  disposed = true
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  const current = root
  root = null
  api = null
  // React forbids unmounting synchronously from inside its own lifecycle; the
  // microtask hop keeps `onBeforeUnmount` safe.
  if (current) queueMicrotask(() => current.unmount())
})

// Theme / locale are React props, not part of `initialData` — re-render only.
watch([isDark, locale], () => {
  if (status.value === 'ready') renderRoot()
})
</script>

<template>
  <div class="flex flex-1 min-h-0 flex-col bg-ink-50 dark:bg-ink-950">
    <!-- Title row — same rhythm as DocumentEditor so switching between a note
         and a drawing doesn't shift the page. -->
    <div class="mx-auto w-full max-w-3xl xl:max-w-4xl 2xl:max-w-6xl pt-4 md:px-6">
      <div class="mb-2 flex items-center justify-between gap-3">
        <span class="label-mono" aria-live="polite">{{ statusLabel }}</span>
        <span class="label-mono">{{ t('doc.excalidraw.badge') }}</span>
      </div>
      <input
        v-model="title"
        type="text"
        :placeholder="t('doc.editor.titlePlaceholder')"
        class="title-input"
        spellcheck="true"
        @input="onTitleInput"
        @blur="onTitleBlur"
      >
    </div>

    <!-- Canvas -->
    <div class="excalidraw-area">
      <div ref="hostRef" class="excalidraw-host" />
      <p v-if="status === 'loading'" class="excalidraw-overlay">
        {{ t('doc.excalidraw.loading') }}
      </p>
      <p v-else-if="status === 'failed'" class="excalidraw-overlay is-error">
        {{ t('doc.excalidraw.failed') }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.title-input {
  @apply w-full border-0 bg-transparent font-serif text-4xl font-semibold leading-tight tracking-tight text-ink-900 placeholder:text-ink-300 focus:outline-none focus:ring-0;
}
html.dark .title-input {
  color: theme('colors.ink.50');
}
html.dark .title-input::placeholder {
  color: theme('colors.ink.600');
}

.excalidraw-area {
  /* `relative` + an absolutely-positioned host: Excalidraw measures its
     container, and a flex child with an intrinsic size would fight it. */
  @apply relative mt-4 min-h-0 flex-1 border-t border-ink-200;
}
html.dark .excalidraw-area {
  border-top-color: theme('colors.ink.800');
}
.excalidraw-host {
  @apply absolute inset-0;
}
.excalidraw-overlay {
  @apply pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-ink-400;
}
.excalidraw-overlay.is-error {
  @apply text-red-600;
}
</style>
