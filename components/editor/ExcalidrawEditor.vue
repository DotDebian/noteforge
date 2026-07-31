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
  (e: 'update:markdown', value: string): void
}>()

const { t, locale } = useLocale()
const { isDark } = useTheme()

const docId = computed(() => props.doc.id)
const saver = useDocumentSaver(docId, 500)
const ago = useLocalizedTimeAgo(() => saver.lastSavedAt.value ?? new Date())

/**
 * Read straight off the prop rather than kept in a local ref: there is no title
 * input here, the header's "Rename" owns it. A ref seeded once would go stale
 * after a rename and bake the old name into the derived markdown's alt text.
 */
const docTitle = computed<string>(() => props.doc.title)

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

  const markdown = buildDrawingMarkdown({ scene, preview, title: docTitle.value })
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

/* -------------------------------------------------------------------------- */
/*  Fullscreen                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Two mechanisms, deliberately:
 *
 *  - `isFullscreen` drives a `position: fixed; inset: 0` class. That alone
 *    already hides the app chrome (sidebar, title row, topbar) and is what
 *    actually makes the canvas usable.
 *  - on top of it we ASK for native fullscreen, which additionally drops the
 *    browser's own chrome. It can be refused (permissions policy, an iframe,
 *    Safari quirks) — hence the try/catch, and hence the CSS being the source
 *    of truth rather than `document.fullscreenElement`.
 *
 * Excalidraw renders its menus and dialogs inside its own container, so they
 * follow the element into native fullscreen instead of being stranded on a
 * `document.body` portal.
 */
const shellRef = ref<HTMLDivElement | null>(null)
const isFullscreen = ref(false)

async function toggleFullscreen(): Promise<void> {
  if (isFullscreen.value) {
    isFullscreen.value = false
    if (typeof document !== 'undefined' && document.fullscreenElement) {
      try { await document.exitFullscreen() }
      catch { /* already gone */ }
    }
    return
  }
  isFullscreen.value = true
  const el = shellRef.value
  if (el?.requestFullscreen) {
    try { await el.requestFullscreen() }
    catch {
      // Native fullscreen refused — the CSS layer still gives the whole
      // viewport, so this is a degradation, not a failure.
    }
  }
}

/**
 * Escape (or F11) exits native fullscreen without going through our button.
 * Mirror that back into the CSS state, otherwise the canvas would stay pinned
 * over the app with no visible way out.
 */
function onNativeFullscreenChange(): void {
  if (!document.fullscreenElement && isFullscreen.value) isFullscreen.value = false
}

onMounted(() => {
  document.addEventListener('fullscreenchange', onNativeFullscreenChange)
})
onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onNativeFullscreenChange)
  // Leaving the page while fullscreen would strand the browser in it.
  if (typeof document !== 'undefined' && document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {})
  }
})
</script>

<template>
  <div
    ref="shellRef"
    class="excalidraw-shell"
    :class="{ 'is-fullscreen': isFullscreen }"
  >
    <!-- No title row: the canvas takes the whole area. Renaming lives in the
         document header ("Rename"), and the save indicator is the small pill
         pinned bottom-right next to the fullscreen button. -->
    <div class="excalidraw-area">
      <div ref="hostRef" class="excalidraw-host" />
      <p v-if="status === 'loading'" class="excalidraw-overlay">
        {{ t('doc.excalidraw.loading') }}
      </p>
      <p v-else-if="status === 'failed'" class="excalidraw-overlay is-error">
        {{ t('doc.excalidraw.failed') }}
      </p>
      <!-- Bottom-right: Excalidraw keeps its own UI top-left (toolbar), top-right
           (library) and bottom-left (zoom / undo), so this corner is the one
           spot that never collides.
           The save state used to ride in the title row; without it, this pill is
           the only feedback that the drawing is being persisted. -->
      <span v-if="statusLabel" class="save-pill" aria-live="polite">{{ statusLabel }}</span>
      <button
        type="button"
        class="fs-btn"
        :title="isFullscreen ? t('doc.excalidraw.collapse') : t('doc.excalidraw.expand')"
        :aria-label="isFullscreen ? t('doc.excalidraw.collapse') : t('doc.excalidraw.expand')"
        :aria-pressed="isFullscreen"
        @click="toggleFullscreen"
      >
        <svg v-if="!isFullscreen" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M6 2H2v4 M10 2h4v4 M6 14H2v-4 M10 14h4v-4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <svg v-else viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M2 6h4V2 M14 6h-4V2 M2 10h4v4 M14 10h-4v4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.excalidraw-shell {
  @apply flex flex-1 min-h-0 flex-col bg-ink-50;
}
html.dark .excalidraw-shell {
  background: theme('colors.ink.950');
}
/* CSS fullscreen. Kept even when native fullscreen is granted — the browser
   sizes the element to the screen and these rules stay harmless — so a refused
   `requestFullscreen()` still lands on a full-viewport canvas. */
.excalidraw-shell.is-fullscreen {
  @apply fixed inset-0;
  /* Above every piece of app chrome — the mobile topbar and sidebar drawer
     top out at 50, dialogs at 60. */
  z-index: 70;
}

.excalidraw-area {
  /* `relative` + an absolutely-positioned host: Excalidraw measures its
     container, and a flex child with an intrinsic size would fight it.
     No margin and no border — the canvas owns the whole area. */
  @apply relative min-h-0 flex-1;
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

.fs-btn {
  /* Above Excalidraw's own UI layer, which tops out below 10. */
  @apply absolute bottom-4 right-4 z-10 inline-flex h-8 w-8 items-center justify-center rounded-lg border border-ink-200 bg-white/90 text-ink-600 shadow-sm backdrop-blur transition-colors hover:bg-white hover:text-ink-900;
}
.save-pill {
  @apply pointer-events-none absolute bottom-4 right-14 z-10 rounded-lg border border-ink-200 bg-white/90 px-2.5 py-1.5 text-[11px] text-ink-500 shadow-sm backdrop-blur;
}
html.dark .save-pill {
  background: theme('colors.ink.900' / 90%);
  border-color: theme('colors.ink.700');
  color: theme('colors.ink.400');
}
html.dark .fs-btn {
  background: theme('colors.ink.900' / 90%);
  border-color: theme('colors.ink.700');
  color: theme('colors.ink.300');
}
html.dark .fs-btn:hover {
  background: theme('colors.ink.800');
  color: theme('colors.ink.50');
}
</style>
