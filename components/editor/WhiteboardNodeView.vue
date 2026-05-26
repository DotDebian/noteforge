<script setup lang="ts">
/**
 * Whiteboard NodeView.
 *
 * Mounts a Konva Stage in a fixed-height container. A small floating
 * toolbar (visible only when the node is selected) lets the user pick
 * a tool: pen / rectangle / ellipse / arrow / sticky / text / select /
 * delete / undo. The scene graph is serialized via `Konva.Node.toJSON()`
 * and stored base64-encoded in `attrs.scene`. A static data-URL preview
 * is also written to `attrs.preview` for future non-editor renders (e.g.
 * PDF export).
 *
 * Konva is browser-only: we lazy-import it inside `onMounted` so SSR /
 * test builds don't blow up.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { useDialog } from '~/composables/useDialog'
import { useLocale } from '~/composables/useLocale'

// Type-only Konva import. The runtime import happens inside `onMounted`.
// Using `import type` keeps Konva out of the SSR bundle.
import type KonvaNamespace from 'konva'

type KonvaModule = typeof KonvaNamespace

const props = defineProps(nodeViewProps)
const { locale } = useLocale()
const dialog = useDialog()

const L = computed(() => locale.value === 'fr'
  ? {
      pen: 'Crayon',
      rect: 'Rectangle',
      ellipse: 'Ellipse',
      arrow: 'Flèche',
      sticky: 'Note',
      text: 'Texte',
      select: 'Sélection',
      delete: 'Supprimer',
      undo: 'Annuler',
      clear: 'Effacer',
      colorAria: 'Couleur',
      title: 'Tableau blanc',
      clickToDraw: 'Cliquer pour dessiner',
      clearConfirmTitle: 'Effacer le tableau ?',
      clearConfirmMsg: 'Tous les éléments seront supprimés. Vous pouvez utiliser Annuler ensuite.',
      clearConfirm: 'Effacer',
      textPrompt: 'Texte',
      textPlaceholder: 'Tapez du texte…',
      textInsert: 'Insérer',
      stickyText: 'Note',
    }
  : {
      pen: 'Pen',
      rect: 'Rectangle',
      ellipse: 'Ellipse',
      arrow: 'Arrow',
      sticky: 'Sticky',
      text: 'Text',
      select: 'Select',
      delete: 'Delete',
      undo: 'Undo',
      clear: 'Clear',
      colorAria: 'Color',
      title: 'Whiteboard',
      clickToDraw: 'Click to draw',
      clearConfirmTitle: 'Clear the board?',
      clearConfirmMsg: 'All elements will be removed. You can use Undo afterwards.',
      clearConfirm: 'Clear',
      textPrompt: 'Text',
      textPlaceholder: 'Type some text…',
      textInsert: 'Insert',
      stickyText: 'Note',
    })

type Tool = 'pen' | 'rect' | 'ellipse' | 'arrow' | 'sticky' | 'text' | 'select'

const containerRef = ref<HTMLDivElement | null>(null)
const tool = ref<Tool>('pen')
const color = ref<string>('#0ea5e9')

let Konva: KonvaModule | null = null
let stage: KonvaNamespace.Stage | null = null
let drawLayer: KonvaNamespace.Layer | null = null
let isDrawing = false
let currentShape: KonvaNamespace.Shape | null = null
let startX = 0
let startY = 0
let lastSerialized = ''
// Trim history at this many snapshots so memory stays bounded for very
// long whiteboard sessions.
const HISTORY_LIMIT = 40
const history: string[] = []

const widthAttr = computed<number>(() =>
  Number((props.node.attrs as { width?: number }).width ?? 800))
const heightAttr = computed<number>(() =>
  Number((props.node.attrs as { height?: number }).height ?? 480))

function decodeScene(b64: string): unknown | null {
  if (!b64) return null
  try {
    const json = typeof window === 'undefined'
      ? Buffer.from(b64, 'base64').toString('utf-8')
      : decodeURIComponent(escape(window.atob(b64)))
    return JSON.parse(json) as unknown
  }
  catch (err) {
    console.warn('[whiteboard] could not decode scene', err)
    return null
  }
}

function encodeScene(scene: unknown): string {
  const json = JSON.stringify(scene)
  if (typeof window === 'undefined') return Buffer.from(json, 'utf-8').toString('base64')
  return window.btoa(unescape(encodeURIComponent(json)))
}

/**
 * Serialize the drawing layer to base64 JSON and persist via
 * `updateAttributes`. Also captures a small PNG preview (data URL) for
 * later non-editor rendering (export, sharing). Skips when nothing changed
 * since the last save.
 */
function persistScene(): void {
  if (!drawLayer || !stage) return
  const sceneJson = drawLayer.toJSON()
  const b64 = encodeScene(JSON.parse(sceneJson))
  if (b64 === lastSerialized) return
  lastSerialized = b64
  history.push(b64)
  if (history.length > HISTORY_LIMIT) history.shift()
  // Best-effort preview. toDataURL can fail for huge canvases; ignore.
  let preview = ''
  try {
    preview = stage.toDataURL({ pixelRatio: 0.5, mimeType: 'image/png' })
  }
  catch { /* ignore */ }
  props.updateAttributes({ scene: b64, preview })
}

/**
 * Rehydrate the drawing layer from a serialized scene. Used on mount and
 * on undo. The destination stage must exist.
 */
function hydrateScene(b64: string): void {
  if (!Konva || !stage) return
  const data = decodeScene(b64)
  // Remove the existing draw layer and replace with the loaded one.
  drawLayer?.destroy()
  if (data && typeof data === 'object') {
    try {
      const layer = Konva.Node.create(data, undefined) as unknown as KonvaNamespace.Layer
      drawLayer = layer
      stage.add(drawLayer)
    }
    catch (err) {
      console.warn('[whiteboard] could not restore layer; starting blank', err)
      drawLayer = new Konva.Layer()
      stage.add(drawLayer)
    }
  }
  else {
    drawLayer = new Konva.Layer()
    stage.add(drawLayer)
  }
  drawLayer.draw()
  // Re-attach delete-on-click behaviour for select tool. We don't store
  // listeners on shapes (they don't survive serialization); we rely on
  // bubbling from the stage in `onPointerDown`.
}

function nextHexColor(): string {
  // Cycle through a small palette when the user clicks the swatch.
  const palette = ['#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#0f172a']
  const idx = palette.indexOf(color.value)
  const next = palette[(idx + 1) % palette.length] ?? palette[0]!
  return next
}

function onPointerDown(e: PointerEvent): void {
  if (!Konva || !stage || !drawLayer) return
  // Block the browser's default drag-image gesture and ProseMirror's atom
  // drag — both of which would otherwise treat the stroke as a drag of the
  // whiteboard node itself.
  e.preventDefault()
  e.stopPropagation()
  const rect = stage.container().getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  startX = x
  startY = y

  if (tool.value === 'select') {
    // Click-to-select: pick the shape (or group, for sticky notes) under
    // the pointer and toggle a selected highlight. The `Delete` toolbar
    // button removes whatever is currently selected.
    const target = stage.getIntersection({ x, y })
    // Walk up from the inner shape to the top-level child of the draw
    // layer — sticky notes are Konva.Group, so the inner Rect/Text would
    // otherwise never match.
    let selectTarget: KonvaNamespace.Node | null = target ?? null
    while (selectTarget && selectTarget.getParent() && selectTarget.getParent() !== drawLayer) {
      selectTarget = selectTarget.getParent() as KonvaNamespace.Node
    }
    const children = [...(drawLayer.getChildren() as unknown as KonvaNamespace.Node[])]
    for (const c of children) {
      if (!c) continue
      const node = c as KonvaNamespace.Shape & { _origStroke?: string }
      const hasStroke = typeof node.stroke === 'function'
      if (node === selectTarget) {
        if (hasStroke) {
          node._origStroke = node.stroke() as string
          node.stroke('#f59e0b')
        }
        node.setAttr('selected', true)
      }
      else if (node.getAttr('selected')) {
        if (hasStroke) {
          node.stroke(node._origStroke ?? node.stroke())
        }
        node.setAttr('selected', false)
      }
    }
    drawLayer.batchDraw()
    return
  }

  isDrawing = true
  if (tool.value === 'pen') {
    const line = new Konva.Line({
      stroke: color.value,
      strokeWidth: 2.5,
      lineCap: 'round',
      lineJoin: 'round',
      points: [x, y, x, y],
      tension: 0.4,
    })
    drawLayer.add(line)
    currentShape = line
  }
  else if (tool.value === 'rect') {
    const rectShape = new Konva.Rect({
      x, y, width: 1, height: 1,
      stroke: color.value,
      strokeWidth: 2,
      cornerRadius: 4,
    })
    drawLayer.add(rectShape)
    currentShape = rectShape
  }
  else if (tool.value === 'ellipse') {
    const el = new Konva.Ellipse({
      x, y, radiusX: 1, radiusY: 1,
      stroke: color.value,
      strokeWidth: 2,
    })
    drawLayer.add(el)
    currentShape = el
  }
  else if (tool.value === 'arrow') {
    const arr = new Konva.Arrow({
      points: [x, y, x + 1, y + 1],
      stroke: color.value,
      fill: color.value,
      strokeWidth: 2,
      pointerLength: 10,
      pointerWidth: 10,
    })
    drawLayer.add(arr)
    currentShape = arr
  }
  else if (tool.value === 'sticky') {
    // Build a small sticky as a group: rect + text. Konva serializes
    // groups, so undo / persist work the same way.
    const group = new Konva.Group({ x, y, draggable: true })
    const bg = new Konva.Rect({
      width: 160, height: 100,
      fill: '#fef3c7',
      stroke: '#f59e0b',
      strokeWidth: 1,
      cornerRadius: 6,
      shadowBlur: 8,
      shadowColor: 'black',
      shadowOpacity: 0.1,
    })
    const txt = new Konva.Text({
      x: 8, y: 8,
      width: 144, height: 84,
      text: L.value.stickyText,
      fontSize: 14,
      fill: '#78350f',
      fontFamily: 'Inter, sans-serif',
    })
    group.add(bg)
    group.add(txt)
    drawLayer.add(group)
    isDrawing = false
    currentShape = null
    persistScene()
    return
  }
  else if (tool.value === 'text') {
    // Defer to a dialog prompt so the text is captured without a
    // contenteditable Konva textarea (which is finicky inside ProseMirror).
    void promptText(x, y)
    isDrawing = false
    currentShape = null
    return
  }
}

async function promptText(x: number, y: number): Promise<void> {
  const val = await dialog.prompt({
    title: L.value.textPrompt,
    placeholder: L.value.textPlaceholder,
    confirmLabel: L.value.textInsert,
  })
  if (!val || !Konva || !drawLayer) return
  const txt = new Konva.Text({
    x, y,
    text: val,
    fontSize: 18,
    fill: color.value,
    fontFamily: 'Inter, sans-serif',
    draggable: true,
  })
  drawLayer.add(txt)
  drawLayer.draw()
  persistScene()
}

function onPointerMove(e: PointerEvent): void {
  if (!isDrawing || !stage || !currentShape) return
  e.stopPropagation()
  const rect = stage.container().getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  if (tool.value === 'pen') {
    const line = currentShape as KonvaNamespace.Line
    const pts = line.points()
    line.points([...pts, x, y])
  }
  else if (tool.value === 'rect') {
    const rectShape = currentShape as KonvaNamespace.Rect
    rectShape.width(x - startX)
    rectShape.height(y - startY)
  }
  else if (tool.value === 'ellipse') {
    const el = currentShape as KonvaNamespace.Ellipse
    const dx = Math.abs(x - startX)
    const dy = Math.abs(y - startY)
    el.x(startX + (x - startX) / 2)
    el.y(startY + (y - startY) / 2)
    el.radiusX(dx / 2)
    el.radiusY(dy / 2)
  }
  else if (tool.value === 'arrow') {
    const arr = currentShape as KonvaNamespace.Arrow
    arr.points([startX, startY, x, y])
  }
  drawLayer?.batchDraw()
}

function onPointerUp(e: PointerEvent): void {
  if (!isDrawing) return
  e.stopPropagation()
  isDrawing = false
  currentShape = null
  persistScene()
}

function setTool(next: Tool): void {
  tool.value = next
}

function deleteSelected(): void {
  if (!drawLayer) return
  // Snapshot the children before destroying — `getChildren()` returns a
  // live array, and destroying mid-iteration would shift indices.
  const children = [...(drawLayer.getChildren() as unknown as KonvaNamespace.Node[])]
  let changed = false
  for (const c of children) {
    if (!c) continue
    if (c.getAttr('selected')) {
      c.destroy()
      changed = true
    }
  }
  if (changed) {
    drawLayer.batchDraw()
    persistScene()
  }
}

function undo(): void {
  if (!Konva || !stage) return
  if (history.length <= 1) {
    // Pop the only snapshot and clear.
    history.length = 0
    drawLayer?.destroyChildren()
    drawLayer?.draw()
    lastSerialized = ''
    props.updateAttributes({ scene: '', preview: '' })
    return
  }
  // Drop current; restore previous.
  history.pop()
  const prev = history[history.length - 1]
  if (prev) {
    lastSerialized = prev
    hydrateScene(prev)
    props.updateAttributes({ scene: prev })
  }
}

async function clearBoard(): Promise<void> {
  const ok = await dialog.confirm({
    title: L.value.clearConfirmTitle,
    message: L.value.clearConfirmMsg,
    confirmLabel: L.value.clearConfirm,
    destructive: true,
  })
  if (!ok) return
  if (!drawLayer) return
  drawLayer.destroyChildren()
  drawLayer.draw()
  persistScene()
}

onMounted(async () => {
  if (typeof window === 'undefined') return
  // Dynamic import keeps Konva out of SSR.
  const mod = await import('konva')
  Konva = mod.default as KonvaModule
  await nextTick()
  const container = containerRef.value
  if (!container) return
  stage = new Konva.Stage({
    container,
    width: widthAttr.value,
    height: heightAttr.value,
  })
  const initial = (props.node.attrs as { scene?: string }).scene ?? ''
  if (initial) {
    hydrateScene(initial)
    lastSerialized = initial
    history.push(initial)
  }
  else {
    drawLayer = new Konva.Layer()
    stage.add(drawLayer)
  }
  const dom = stage.container()
  dom.addEventListener('pointerdown', onPointerDown)
  dom.addEventListener('pointermove', onPointerMove)
  dom.addEventListener('pointerup', onPointerUp)
  dom.addEventListener('pointerleave', onPointerUp)
})

// React to external attr changes (e.g. another tab updated this doc).
watch(
  () => (props.node.attrs as { scene?: string }).scene ?? '',
  (next) => {
    if (!Konva || !stage) return
    if (next === lastSerialized) return
    lastSerialized = next
    hydrateScene(next)
  },
)

onBeforeUnmount(() => {
  if (stage) {
    const dom = stage.container()
    dom.removeEventListener('pointerdown', onPointerDown)
    dom.removeEventListener('pointermove', onPointerMove)
    dom.removeEventListener('pointerup', onPointerUp)
    dom.removeEventListener('pointerleave', onPointerUp)
    stage.destroy()
    stage = null
  }
  drawLayer = null
})
</script>

<template>
  <NodeViewWrapper
    as="div"
    class="whiteboard-nv"
    :class="{ 'is-selected': props.selected }"
  >
    <header
      class="whiteboard-toolbar"
      contenteditable="false"
    >
      <span class="whiteboard-title">{{ L.title }}</span>
      <div class="whiteboard-tools" role="toolbar">
        <button
          v-for="t in (['pen','rect','ellipse','arrow','sticky','text','select'] as Tool[])"
          :key="t"
          type="button"
          class="wb-btn"
          :class="{ 'wb-btn-active': tool === t }"
          :title="L[t]"
          :aria-pressed="tool === t"
          @click="setTool(t)"
        >
          <span v-if="t === 'pen'">✎</span>
          <span v-else-if="t === 'rect'">▭</span>
          <span v-else-if="t === 'ellipse'">○</span>
          <span v-else-if="t === 'arrow'">→</span>
          <span v-else-if="t === 'sticky'">▤</span>
          <span v-else-if="t === 'text'">T</span>
          <span v-else>◉</span>
        </button>
        <button
          type="button"
          class="wb-btn wb-swatch"
          :title="L.colorAria"
          :style="{ background: color }"
          :aria-label="L.colorAria"
          @click="color = nextHexColor()"
        >
          &nbsp;
        </button>
        <span class="wb-sep" aria-hidden="true" />
        <button
          type="button"
          class="wb-btn"
          :title="L.delete"
          @click="deleteSelected"
        >
          ✕
        </button>
        <button
          type="button"
          class="wb-btn"
          :title="L.undo"
          @click="undo"
        >
          ↶
        </button>
        <button
          type="button"
          class="wb-btn"
          :title="L.clear"
          @click="clearBoard"
        >
          ⌫
        </button>
      </div>
    </header>
    <div
      ref="containerRef"
      class="whiteboard-stage"
      :style="{ height: heightAttr + 'px' }"
      contenteditable="false"
      draggable="false"
      @dragstart.prevent
    />
  </NodeViewWrapper>
</template>

<style scoped>
.whiteboard-nv {
  @apply my-6 overflow-hidden rounded-lg border border-ink-200 bg-white;
  user-select: none;
}
html.dark .whiteboard-nv {
  background: theme('colors.ink.900');
  border-color: theme('colors.ink.800');
}
.whiteboard-nv.is-selected {
  @apply outline outline-2 outline-accent-500;
}
.whiteboard-toolbar {
  @apply flex flex-wrap items-center gap-1.5 border-b border-ink-200 bg-ink-50 px-3 py-2;
}
html.dark .whiteboard-toolbar {
  background: theme('colors.ink.950');
  border-bottom-color: theme('colors.ink.800');
}
.whiteboard-title {
  @apply mr-3 text-[11px] font-medium uppercase tracking-wider text-ink-500;
}
html.dark .whiteboard-title { color: theme('colors.ink.400'); }
.whiteboard-tools {
  @apply flex flex-wrap items-center gap-1;
}
.wb-btn {
  @apply inline-flex h-7 w-7 items-center justify-center rounded border border-ink-200 bg-white text-sm text-ink-700 transition-colors hover:bg-ink-100;
}
html.dark .wb-btn {
  background: theme('colors.ink.900');
  border-color: theme('colors.ink.800');
  color: theme('colors.ink.200');
}
html.dark .wb-btn:hover { background: theme('colors.ink.800'); }
.wb-btn-active {
  @apply border-accent-500 bg-accent-50 text-accent-700;
}
html.dark .wb-btn-active {
  background: theme('colors.accent.900' / 30%);
  border-color: theme('colors.accent.500');
  color: theme('colors.accent.300');
}
.wb-swatch {
  @apply border-2;
  width: 1.75rem;
}
.wb-sep {
  @apply mx-1 inline-block h-5 w-px bg-ink-200;
}
html.dark .wb-sep { background: theme('colors.ink.800'); }
.whiteboard-stage {
  @apply w-full bg-white;
  touch-action: none;
  cursor: crosshair;
  /* Block the browser's native drag-image gesture so the user's pen-strokes
     don't get hijacked into "drag this canvas as an image" actions. */
  -webkit-user-drag: none;
  user-select: none;
}
.whiteboard-stage canvas {
  pointer-events: auto;
  -webkit-user-drag: none;
  user-drag: none;
}
html.dark .whiteboard-stage {
  background: theme('colors.ink.950');
}
</style>
