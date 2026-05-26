<script setup lang="ts">
/**
 * Tiptap NodeView for fenced code blocks. Three responsibilities:
 *   - Render the editable code via <NodeViewContent /> (lowlight decorations
 *     keep working — they target the contentDOM at the ProseMirror level).
 *   - When `language === 'mermaid'`, render only the SVG diagram by default
 *     with an Edit button bottom-right that toggles to the code editor.
 *   - Re-render the diagram when the user flips the app theme.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { useLocale } from '~/composables/useLocale'

const props = defineProps(nodeViewProps)
const { t } = useLocale()

const language = computed<string | null>(() => {
  const lang = (props.node.attrs as { language?: string | null }).language
  return typeof lang === 'string' && lang.length > 0 ? lang : null
})
const isMermaid = computed(() => language.value === 'mermaid')
const code = computed<string>(() => props.node.textContent ?? '')

const svg = ref<string>('')
const errorMsg = ref<string>('')

// Mermaid only: preview is the default; user clicks Edit to see/modify the
// source. Non-mermaid blocks ignore this and always show their code.
const viewMode = ref<'preview' | 'code'>('preview')
function toggleView(): void {
  viewMode.value = viewMode.value === 'preview' ? 'code' : 'preview'
}

const showCode = computed(() => !isMermaid.value || viewMode.value === 'code')
const showPreview = computed(() => isMermaid.value && viewMode.value === 'preview')

/* -------------------------------------------------------------------- */
/*  Lightbox — fullscreen diagram with pan + zoom                       */
/* -------------------------------------------------------------------- */

const lightboxOpen = ref(false)
const panX = ref(0)
const panY = ref(0)
const zoom = ref(1)
let dragOrigin: { x: number, y: number, panX: number, panY: number } | null = null

function openLightbox(): void {
  if (errorMsg.value || !svg.value) return
  panX.value = 0
  panY.value = 0
  zoom.value = 1
  lightboxOpen.value = true
}
function closeLightbox(): void {
  lightboxOpen.value = false
  dragOrigin = null
}

function onLightboxWheel(e: WheelEvent): void {
  // Zoom centred on the cursor: the world point under the mouse stays put.
  const oldZoom = zoom.value
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
  const newZoom = Math.min(10, Math.max(0.1, oldZoom * factor))
  if (newZoom === oldZoom) return

  const vcx = window.innerWidth / 2
  const vcy = window.innerHeight / 2
  const dx = e.clientX - vcx
  const dy = e.clientY - vcy
  const ratio = newZoom / oldZoom
  // p_x_new = dx - ((dx - panX) / oldZoom) * newZoom = dx*(1-ratio) + panX*ratio
  panX.value = dx * (1 - ratio) + panX.value * ratio
  panY.value = dy * (1 - ratio) + panY.value * ratio
  zoom.value = newZoom
}

function onLightboxMouseDown(e: MouseEvent): void {
  if (e.button !== 0) return
  dragOrigin = { x: e.clientX, y: e.clientY, panX: panX.value, panY: panY.value }
  window.addEventListener('mousemove', onLightboxMouseMove)
  window.addEventListener('mouseup', onLightboxMouseUp)
}
function onLightboxMouseMove(e: MouseEvent): void {
  if (!dragOrigin) return
  panX.value = dragOrigin.panX + (e.clientX - dragOrigin.x)
  panY.value = dragOrigin.panY + (e.clientY - dragOrigin.y)
}
function onLightboxMouseUp(): void {
  dragOrigin = null
  window.removeEventListener('mousemove', onLightboxMouseMove)
  window.removeEventListener('mouseup', onLightboxMouseUp)
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && lightboxOpen.value) {
    e.preventDefault()
    closeLightbox()
  }
}

const lightboxTransform = computed(() =>
  `translate(${panX.value}px, ${panY.value}px) scale(${zoom.value})`,
)

// Each NodeView gets its own id so multiple mermaid blocks in the same
// document don't collide inside mermaid's temporary DOM element.
const renderId = `mermaid-${Math.random().toString(36).slice(2, 10)}`

let renderTimer: ReturnType<typeof setTimeout> | null = null
let themeObserver: MutationObserver | null = null

function isDarkMode(): boolean {
  return document.documentElement.classList.contains('dark')
}

async function renderMermaid(): Promise<void> {
  if (!isMermaid.value) {
    svg.value = ''
    errorMsg.value = ''
    return
  }
  const src = code.value.trim()
  if (!src) {
    svg.value = ''
    errorMsg.value = ''
    return
  }
  try {
    const { default: mermaid } = await import('mermaid')
    mermaid.initialize({
      startOnLoad: false,
      theme: isDarkMode() ? 'dark' : 'default',
      securityLevel: 'strict',
      // Stop mermaid from wandering all over the page if the user types
      // something that produces a huge diagram.
      maxTextSize: 50_000,
    })
    // `parse` throws on syntax errors before we try to render, so we don't
    // wipe the previous successful SVG on every transient bad keystroke.
    await mermaid.parse(src)
    const { svg: out } = await mermaid.render(renderId, src)
    svg.value = out
    errorMsg.value = ''
  }
  catch (err) {
    const msg = (err as Error).message ?? String(err)
    // mermaid throws long multi-line errors; first line is enough for chrome.
    errorMsg.value = msg.split('\n')[0]?.trim() ?? 'mermaid error'
  }
}

function scheduleRender(): void {
  if (renderTimer) clearTimeout(renderTimer)
  renderTimer = setTimeout(() => { void renderMermaid() }, 300)
}

watch([code, isMermaid], scheduleRender, { immediate: true })

onMounted(() => {
  // Re-render on theme flip so the diagram matches the surrounding UI.
  themeObserver = new MutationObserver(() => {
    if (isMermaid.value) scheduleRender()
  })
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  })
  window.addEventListener('keydown', onKeyDown)
})

onBeforeUnmount(() => {
  if (renderTimer) clearTimeout(renderTimer)
  themeObserver?.disconnect()
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('mousemove', onLightboxMouseMove)
  window.removeEventListener('mouseup', onLightboxMouseUp)
})
</script>

<template>
  <NodeViewWrapper as="div" class="cbnv">
    <!-- Code editor — always mounted (NodeViewContent must stay attached so
         ProseMirror can manage the contentDOM), but hidden via v-show in
         mermaid preview mode so toggling doesn't churn the doc. -->
    <div v-show="showCode" class="cbnv-code-wrap">
      <pre class="cbnv-code"><code
        :class="['hljs', language ? `language-${language}` : null]"
        spellcheck="false"
      ><NodeViewContent /></code></pre>
      <button
        v-if="isMermaid"
        type="button"
        class="cbnv-toggle"
        contenteditable="false"
        @click="toggleView"
      >
        {{ t('editor.mermaid.done') }}
      </button>
    </div>

    <!-- Mermaid preview — replaces the code visually in preview mode. -->
    <div
      v-if="showPreview"
      class="cbnv-preview"
      contenteditable="false"
    >
      <div v-if="errorMsg" class="cbnv-error">{{ errorMsg }}</div>
      <div
        v-else-if="svg"
        class="cbnv-svg"
        :title="t('editor.mermaid.zoom')"
        @click="openLightbox"
        v-html="svg"
      />
      <div v-else class="cbnv-empty">…</div>
      <button
        type="button"
        class="cbnv-toggle"
        @click.stop="toggleView"
      >
        {{ t('editor.mermaid.edit') }}
      </button>
    </div>

    <!-- Fullscreen lightbox: pan with drag, zoom with wheel, ESC to close. -->
    <Teleport to="body">
      <div
        v-if="lightboxOpen"
        class="ml-overlay"
        contenteditable="false"
        @click.self="closeLightbox"
        @wheel.prevent="onLightboxWheel"
        @mousedown.self="onLightboxMouseDown"
      >
        <div
          class="ml-canvas"
          :style="{ transform: lightboxTransform }"
          @mousedown.stop="onLightboxMouseDown"
          v-html="svg"
        />
        <button
          type="button"
          class="ml-close"
          :aria-label="t('editor.mermaid.close')"
          @click="closeLightbox"
        >
          ×
        </button>
      </div>
    </Teleport>
  </NodeViewWrapper>
</template>

<style scoped>
.cbnv {
  @apply my-6;
}
.cbnv-code-wrap {
  @apply relative;
}
/* Match the global .prose-document pre style (main.css applies via :deep
   inside the editor) — we replicate margin reset so the wrapper owns spacing. */
.cbnv-code {
  @apply my-0;
}
.cbnv-preview {
  @apply relative overflow-x-auto rounded-lg border border-ink-200 bg-white p-6;
}
html.dark .cbnv-preview {
  background: theme('colors.ink.900');
  border-color: theme('colors.ink.800');
}
.cbnv-svg {
  @apply flex justify-center;
}
.cbnv-svg :deep(svg) {
  @apply h-auto max-w-full;
}
.cbnv-error {
  @apply font-mono text-sm text-red-600 dark:text-red-400;
  white-space: pre-wrap;
}
.cbnv-empty {
  @apply text-center text-sm italic text-ink-400 dark:text-ink-500;
}

/* Edit / Done toggle — bottom-right, gentle on the preview pane. */
.cbnv-toggle {
  @apply absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-md border border-ink-200 bg-white/90 px-2 py-1 text-[0.7rem] uppercase tracking-wider text-ink-600 backdrop-blur transition-colors hover:bg-ink-50 hover:text-ink-900;
}
html.dark .cbnv-toggle {
  background: theme('colors.ink.800' / 90%);
  border-color: theme('colors.ink.700');
  color: theme('colors.ink.300');
}
html.dark .cbnv-toggle:hover {
  background: theme('colors.ink.700');
  color: theme('colors.ink.50');
}

.cbnv-svg {
  @apply cursor-zoom-in;
}

/* -------------------------------------------------------------------- */
/*  Mermaid lightbox (Teleport target lives in <body>)                  */
/* -------------------------------------------------------------------- */
.ml-overlay {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: rgba(15, 17, 24, 0.78);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  cursor: grab;
}
.ml-overlay:active {
  cursor: grabbing;
}
.ml-canvas {
  /* Centred by the flex parent. transform-origin defaults to centre, so
     scaling stays anchored and the translate pans afterwards. */
  transform-origin: 50% 50%;
  transition: none;
  /* Prevent the inner SVG from intercepting drag events as text-select. */
  user-select: none;
  pointer-events: auto;
}
.ml-canvas :deep(svg) {
  display: block;
  max-width: none;
  max-height: none;
  /* Make sure mermaid's SVG isn't shrunk to fit a tiny default size. */
  width: min(80vw, 1200px);
  height: auto;
  background: white;
  border-radius: 8px;
  padding: 1.5rem;
}
html.dark .ml-canvas :deep(svg) {
  background: theme('colors.ink.900');
}
.ml-close {
  position: fixed;
  top: 1rem;
  right: 1rem;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.12);
  color: white;
  font-size: 1.5rem;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s ease;
}
.ml-close:hover {
  background: rgba(255, 255, 255, 0.24);
}
</style>
