<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useWorkspacesStore } from '~/stores/workspaces'

interface GraphNode {
  id: number
  title: string
  folderId: number | null
  tags: string[]
}
interface GraphEdge {
  source: number
  target: number
  kind: 'link' | 'tag' | 'similar'
  tag?: string
  weight?: number
}
interface GraphResponse { nodes: GraphNode[], edges: GraphEdge[] }

const L = {
  title: 'Vue graphe',
  noData: 'Aucun document à afficher pour l\'instant.',
  loading: 'Chargement du graphe…',
  panelTitle: 'Contrôles',
  filterByTag: 'Filtrer par tag',
  anyTag: 'Tous les tags',
  zoomIn: 'Zoom +',
  zoomOut: 'Zoom -',
  reset: 'Recentrer',
  restart: 'Relancer la simulation',
  isolate: 'Isoler le nœud sélectionné',
  unisolate: 'Annuler l\'isolement',
  legendLinks: 'Liens markdown',
  legendTags: 'Tags partagés',
  legendSimilar: 'Notes similaires',
  showTags: 'Afficher les tags partagés',
  showSimilar: 'Afficher les notes similaires',
  selected: 'Sélectionné :',
  stats: (n: number, e: number) => `${n} notes · ${e} arêtes`,
}

useHead(() => ({ title: `${L.title} — NoteForge` }))

const route = useRoute()
const router = useRouter()
const workspacesStore = useWorkspacesStore()
const workspaceId = computed(() => Number(route.params.workspaceId))

const { data, pending } = await useFetch<GraphResponse>(
  () => `/api/workspaces/${workspaceId.value}/graph`,
  { watch: [workspaceId] },
)

const nodes = computed<GraphNode[]>(() => data.value?.nodes ?? [])
const edges = computed<GraphEdge[]>(() => data.value?.edges ?? [])

/* ---------- Tag → color mapping ---------- */
// 12 visually distinct hues, cycled. "untagged" is gray.
const PALETTE = [
  '#b54a18', '#0ea5e9', '#9333ea', '#16a34a',
  '#dc2626', '#0891b2', '#d97706', '#7c3aed',
  '#059669', '#db2777', '#2563eb', '#65a30d',
]
const UNTAGGED = '#9ca3af'

const allTags = computed<string[]>(() => {
  const s = new Set<string>()
  for (const n of nodes.value) for (const t of n.tags) s.add(t)
  return Array.from(s).sort()
})

const tagColor = computed<Map<string, string>>(() => {
  const m = new Map<string, string>()
  allTags.value.forEach((t, i) => m.set(t, PALETTE[i % PALETTE.length]!))
  return m
})

function colorForNode(n: GraphNode): string {
  const first = n.tags[0]
  if (!first) return UNTAGGED
  return tagColor.value.get(first) ?? UNTAGGED
}

/* ---------- Filters ---------- */
const filterTag = ref<string>('')
const selectedNodeId = ref<number | null>(null)
const isolated = ref(false)
// Edge-kind visibility. `link` edges are always shown (explicit, authored);
// tag + similarity edges are inferred and can be toggled off to declutter.
const showTagEdges = ref(true)
const showSimilarEdges = ref(true)

const filteredNodeIds = computed<Set<number>>(() => {
  if (!filterTag.value && (!isolated.value || selectedNodeId.value == null)) {
    return new Set(nodes.value.map(n => n.id))
  }
  const out = new Set<number>()
  if (filterTag.value) {
    for (const n of nodes.value) {
      if (n.tags.includes(filterTag.value)) out.add(n.id)
    }
  }
  else {
    for (const n of nodes.value) out.add(n.id)
  }
  if (isolated.value && selectedNodeId.value != null) {
    const keep = new Set<number>([selectedNodeId.value])
    for (const e of edges.value) {
      if (e.source === selectedNodeId.value) keep.add(e.target)
      else if (e.target === selectedNodeId.value) keep.add(e.source)
    }
    // Intersect.
    for (const id of out) if (!keep.has(id)) out.delete(id)
    if (out.size === 0) for (const id of keep) out.add(id)
  }
  return out
})

const filteredEdges = computed<GraphEdge[]>(() => {
  const ok = filteredNodeIds.value
  return edges.value.filter((e) => {
    if (e.kind === 'tag' && !showTagEdges.value) return false
    if (e.kind === 'similar' && !showSimilarEdges.value) return false
    return ok.has(e.source) && ok.has(e.target)
  })
})

/* ---------- Node degree (drives radius — more connected = bigger) ---------- */
const degreeById = computed<Map<number, number>>(() => {
  const m = new Map<number, number>()
  for (const e of filteredEdges.value) {
    m.set(e.source, (m.get(e.source) ?? 0) + 1)
    m.set(e.target, (m.get(e.target) ?? 0) + 1)
  }
  return m
})

function radiusForId(id: number): number {
  const deg = degreeById.value.get(id) ?? 0
  // 5px base, growing with sqrt(degree), capped so hubs don't dominate.
  return Math.min(12, 5 + Math.sqrt(deg) * 1.7)
}

/* ---------- Canvas + simulation ---------- */
interface Sim {
  id: number
  x: number
  y: number
  vx: number
  vy: number
  r: number
}

const canvasEl = ref<HTMLCanvasElement | null>(null)
const containerEl = ref<HTMLDivElement | null>(null)
const sims = ref<Map<number, Sim>>(new Map())
const zoom = ref(1)
const offsetX = ref(0)
const offsetY = ref(0)
const hoverId = ref<number | null>(null)

let rafId: number | null = null
let resizeObserver: ResizeObserver | null = null
let lastTickAt = 0

function ensureSims() {
  const present = new Set<number>()
  const w = containerEl.value?.clientWidth ?? 800
  const h = containerEl.value?.clientHeight ?? 600
  const cx = w / 2
  const cy = h / 2
  const r0 = Math.min(w, h) * 0.35
  for (const n of nodes.value) {
    present.add(n.id)
    if (!sims.value.has(n.id)) {
      const angle = (Math.random() * Math.PI * 2)
      const dist = r0 * (0.4 + Math.random() * 0.6)
      sims.value.set(n.id, {
        id: n.id,
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
        vx: 0,
        vy: 0,
        r: 6,
      })
    }
  }
  // Drop stale sims for removed nodes.
  for (const id of Array.from(sims.value.keys())) {
    if (!present.has(id)) sims.value.delete(id)
  }
}

/* ---------- Simulation step ----------
   Forces:
     - Repulsion: O(n²) Coulomb-like between every visible pair.
     - Attraction: spring along visible edges (link edges 2× stronger).
     - Gravity to canvas center.
   Stops when total kinetic energy < threshold for several frames. */

const KE_STOP = 0.5
const MAX_VEL = 30
const REPULSION = 1500
const SPRING_LINK = 0.025
const SPRING_SIMILAR = 0.02
const SPRING_TAG = 0.012
const SPRING_REST = 80
const GRAVITY = 0.012
const DAMP = 0.85

let lowEnergyFrames = 0
let energyExpiresAt = 0 // hard cap: don't sim forever

function step() {
  if (!containerEl.value) return
  const w = containerEl.value.clientWidth
  const h = containerEl.value.clientHeight
  const cx = w / 2
  const cy = h / 2

  const visibleIds = filteredNodeIds.value
  const visibleSims: Sim[] = []
  for (const s of sims.value.values()) if (visibleIds.has(s.id)) visibleSims.push(s)

  // Repulsion
  for (let i = 0; i < visibleSims.length; i++) {
    const a = visibleSims[i]!
    for (let j = i + 1; j < visibleSims.length; j++) {
      const b = visibleSims[j]!
      const dx = b.x - a.x
      const dy = b.y - a.y
      let d2 = dx * dx + dy * dy
      if (d2 < 0.01) d2 = 0.01
      const d = Math.sqrt(d2)
      // F = k / d²; spread over distance for direction.
      const f = REPULSION / d2
      const fx = (dx / d) * f
      const fy = (dy / d) * f
      a.vx -= fx
      a.vy -= fy
      b.vx += fx
      b.vy += fy
    }
  }

  // Springs
  for (const e of filteredEdges.value) {
    const a = sims.value.get(e.source)
    const b = sims.value.get(e.target)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01
    const k = e.kind === 'link'
      ? SPRING_LINK
      : e.kind === 'similar'
        ? SPRING_SIMILAR * (e.weight ?? 0.8)
        : SPRING_TAG
    const displ = d - SPRING_REST
    const fx = (dx / d) * displ * k
    const fy = (dy / d) * displ * k
    a.vx += fx
    a.vy += fy
    b.vx -= fx
    b.vy -= fy
  }

  // Gravity + integrate
  let energy = 0
  for (const s of visibleSims) {
    s.vx += (cx - s.x) * GRAVITY
    s.vy += (cy - s.y) * GRAVITY
    s.vx *= DAMP
    s.vy *= DAMP
    // Velocity clamp keeps the sim stable even when nodes start very close.
    if (s.vx > MAX_VEL) s.vx = MAX_VEL
    if (s.vx < -MAX_VEL) s.vx = -MAX_VEL
    if (s.vy > MAX_VEL) s.vy = MAX_VEL
    if (s.vy < -MAX_VEL) s.vy = -MAX_VEL
    s.x += s.vx
    s.y += s.vy
    energy += s.vx * s.vx + s.vy * s.vy
  }

  // Stop when settled.
  if (energy < KE_STOP) lowEnergyFrames++
  else lowEnergyFrames = 0

  draw()

  if (lowEnergyFrames > 30 || performance.now() > energyExpiresAt) {
    rafId = null
    return
  }
  rafId = requestAnimationFrame(step)
}

function draw() {
  const canvas = canvasEl.value
  const container = containerEl.value
  if (!canvas || !container) return
  const w = container.clientWidth
  const h = container.clientHeight
  const dpr = window.devicePixelRatio || 1
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr
    canvas.height = h * dpr
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr * zoom.value, 0, 0, dpr * zoom.value, dpr * offsetX.value, dpr * offsetY.value)
  ctx.clearRect(-offsetX.value / zoom.value, -offsetY.value / zoom.value, w / zoom.value + 2, h / zoom.value + 2)

  const visible = filteredNodeIds.value
  const sel = selectedNodeId.value

  // Edges
  ctx.lineWidth = 0.6
  for (const e of filteredEdges.value) {
    const a = sims.value.get(e.source)
    const b = sims.value.get(e.target)
    if (!a || !b) continue
    if (!visible.has(a.id) || !visible.has(b.id)) continue
    const highlight = sel != null && (e.source === sel || e.target === sel)
    if (e.kind === 'link') {
      ctx.strokeStyle = highlight ? '#b54a18' : 'rgba(120, 113, 108, 0.45)'
      ctx.lineWidth = highlight ? 1.4 : 0.9
    }
    else if (e.kind === 'similar') {
      // Semantic similarity — solid emerald, opacity scaled by cosine weight.
      const w = e.weight ?? 0.8
      const alpha = highlight ? 0.85 : 0.1 + (w - 0.78) * 1.4
      ctx.strokeStyle = `rgba(16, 185, 129, ${Math.max(0.1, Math.min(0.6, alpha))})`
      ctx.lineWidth = highlight ? 1.2 : 0.7
    }
    else {
      ctx.strokeStyle = highlight ? 'rgba(124, 58, 237, 0.7)' : 'rgba(124, 58, 237, 0.18)'
      ctx.lineWidth = highlight ? 1.1 : 0.5
      ctx.setLineDash([3, 2])
    }
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
    ctx.setLineDash([])
  }

  // Nodes
  const nodeById = new Map(nodes.value.map(n => [n.id, n] as const))
  for (const s of sims.value.values()) {
    if (!visible.has(s.id)) continue
    const node = nodeById.get(s.id)
    if (!node) continue
    const isHover = hoverId.value === s.id
    const isSelected = sel === s.id
    const base = radiusForId(s.id)
    const r = isSelected ? base + 3 : isHover ? base + 2 : base
    ctx.beginPath()
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2)
    ctx.fillStyle = colorForNode(node)
    ctx.fill()
    if (isSelected) {
      ctx.lineWidth = 2.5
      ctx.strokeStyle = '#1f2937'
      ctx.stroke()
    }
    else if (isHover) {
      ctx.lineWidth = 1.6
      ctx.strokeStyle = 'rgba(0,0,0,0.45)'
      ctx.stroke()
    }
  }

  // Hover label
  if (hoverId.value != null) {
    const s = sims.value.get(hoverId.value)
    const n = nodeById.get(hoverId.value)
    if (s && n) {
      const label = n.title || 'Sans titre'
      ctx.font = '12px "Inter", sans-serif'
      const metrics = ctx.measureText(label)
      const lw = metrics.width + 12
      const lh = 22
      const lx = s.x + 12
      const ly = s.y - 28
      ctx.fillStyle = 'rgba(28, 25, 23, 0.92)'
      ctx.fillRect(lx, ly, lw, lh)
      ctx.fillStyle = '#fafaf9'
      ctx.fillText(label, lx + 6, ly + 15)
    }
  }
}

function restartSim() {
  lowEnergyFrames = 0
  energyExpiresAt = performance.now() + 6000
  if (rafId == null) rafId = requestAnimationFrame(step)
}

function reset() {
  zoom.value = 1
  offsetX.value = 0
  offsetY.value = 0
  sims.value.clear()
  ensureSims()
  restartSim()
}

/* ---------- Interaction ---------- */
function screenToWorld(x: number, y: number) {
  return { x: (x - offsetX.value) / zoom.value, y: (y - offsetY.value) / zoom.value }
}

function hitTest(x: number, y: number): number | null {
  // Iterate in reverse — last drawn on top.
  const arr = Array.from(sims.value.values())
  for (let i = arr.length - 1; i >= 0; i--) {
    const s = arr[i]!
    if (!filteredNodeIds.value.has(s.id)) continue
    const dx = x - s.x
    const dy = y - s.y
    if (dx * dx + dy * dy <= (radiusForId(s.id) + 4) ** 2) return s.id
  }
  return null
}

let isPanning = false
let panStart = { x: 0, y: 0, ox: 0, oy: 0 }
let dragNodeId: number | null = null

function onMouseDown(e: MouseEvent) {
  if (!canvasEl.value) return
  const rect = canvasEl.value.getBoundingClientRect()
  const sx = e.clientX - rect.left
  const sy = e.clientY - rect.top
  const w = screenToWorld(sx, sy)
  const id = hitTest(w.x, w.y)
  if (id != null) {
    dragNodeId = id
    selectedNodeId.value = id
  }
  else {
    isPanning = true
    panStart = { x: e.clientX, y: e.clientY, ox: offsetX.value, oy: offsetY.value }
  }
}

function onMouseMove(e: MouseEvent) {
  if (!canvasEl.value) return
  const rect = canvasEl.value.getBoundingClientRect()
  const sx = e.clientX - rect.left
  const sy = e.clientY - rect.top
  const w = screenToWorld(sx, sy)

  if (dragNodeId != null) {
    const s = sims.value.get(dragNodeId)
    if (s) {
      s.x = w.x
      s.y = w.y
      s.vx = 0
      s.vy = 0
      restartSim()
    }
  }
  else if (isPanning) {
    offsetX.value = panStart.ox + (e.clientX - panStart.x)
    offsetY.value = panStart.oy + (e.clientY - panStart.y)
    draw()
  }
  else {
    const id = hitTest(w.x, w.y)
    if (id !== hoverId.value) {
      hoverId.value = id
      draw()
    }
  }
}

function onMouseUp() {
  dragNodeId = null
  isPanning = false
}

function onClick(e: MouseEvent) {
  if (!canvasEl.value) return
  // If we just panned, don't fire as click.
  if (isPanning || dragNodeId != null) return
  const rect = canvasEl.value.getBoundingClientRect()
  const sx = e.clientX - rect.left
  const sy = e.clientY - rect.top
  const w = screenToWorld(sx, sy)
  const id = hitTest(w.x, w.y)
  if (id != null) {
    void router.push(`/w/${workspaceId.value}/d/${id}`)
  }
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  const factor = e.deltaY > 0 ? 0.9 : 1.1
  const newZoom = Math.max(0.2, Math.min(4, zoom.value * factor))
  // Zoom toward cursor.
  if (canvasEl.value) {
    const rect = canvasEl.value.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    offsetX.value = mx - (mx - offsetX.value) * (newZoom / zoom.value)
    offsetY.value = my - (my - offsetY.value) * (newZoom / zoom.value)
  }
  zoom.value = newZoom
  draw()
}

function zoomIn() { zoom.value = Math.min(4, zoom.value * 1.2); draw() }
function zoomOut() { zoom.value = Math.max(0.2, zoom.value / 1.2); draw() }

watch([nodes, edges, filterTag, isolated, showTagEdges, showSimilarEdges], () => {
  ensureSims()
  restartSim()
})

onMounted(() => {
  ensureSims()
  restartSim()
  if (containerEl.value) {
    resizeObserver = new ResizeObserver(() => draw())
    resizeObserver.observe(containerEl.value)
  }
})

onBeforeUnmount(() => {
  if (rafId != null) cancelAnimationFrame(rafId)
  if (resizeObserver) resizeObserver.disconnect()
})

const selectedNode = computed<GraphNode | null>(() => {
  if (selectedNodeId.value == null) return null
  return nodes.value.find(n => n.id === selectedNodeId.value) ?? null
})

const wsName = computed(() => workspacesStore.current?.name ?? 'Workspace')
</script>

<template>
  <div class="graph-page">
    <header class="graph-header">
      <div class="crumbs">
        <NuxtLink :to="`/w/${workspaceId}`" class="crumb">{{ wsName }}</NuxtLink>
        <span class="crumb-sep" aria-hidden="true">/</span>
        <span class="crumb crumb--current">{{ L.title }}</span>
      </div>
      <span class="graph-stats">{{ L.stats(filteredNodeIds.size, filteredEdges.length) }}</span>
    </header>

    <div class="graph-body">
      <div ref="containerEl" class="canvas-wrap">
        <canvas
          ref="canvasEl"
          @mousedown="onMouseDown"
          @mousemove="onMouseMove"
          @mouseup="onMouseUp"
          @mouseleave="onMouseUp"
          @click="onClick"
          @wheel="onWheel"
        />
        <div v-if="pending && nodes.length === 0" class="overlay">{{ L.loading }}</div>
        <div v-else-if="nodes.length === 0" class="overlay">{{ L.noData }}</div>
      </div>

      <aside class="side-panel">
        <h2 class="panel-title">{{ L.panelTitle }}</h2>

        <div class="control">
          <label class="filter-label">{{ L.filterByTag }}</label>
          <select v-model="filterTag" class="select">
            <option value="">{{ L.anyTag }}</option>
            <option v-for="t in allTags" :key="t" :value="t">{{ t }}</option>
          </select>
        </div>

        <div class="control control--row">
          <button type="button" class="ghost-btn" @click="zoomIn">{{ L.zoomIn }}</button>
          <button type="button" class="ghost-btn" @click="zoomOut">{{ L.zoomOut }}</button>
        </div>

        <div class="control control--row">
          <button type="button" class="ghost-btn" @click="reset">{{ L.reset }}</button>
          <button type="button" class="ghost-btn" @click="restartSim">{{ L.restart }}</button>
        </div>

        <div v-if="selectedNode" class="control">
          <label class="filter-label">{{ L.selected }}</label>
          <NuxtLink
            :to="`/w/${workspaceId}/d/${selectedNode.id}`"
            class="selected-link"
          >
            {{ selectedNode.title || 'Sans titre' }}
          </NuxtLink>
          <button
            type="button"
            class="ghost-btn"
            @click="isolated = !isolated"
          >
            {{ isolated ? L.unisolate : L.isolate }}
          </button>
        </div>

        <div class="legend">
          <div class="legend-row">
            <span class="legend-line legend-line--link" /> <span>{{ L.legendLinks }}</span>
          </div>
          <label class="legend-row legend-toggle" :title="L.showSimilar">
            <input v-model="showSimilarEdges" type="checkbox" class="legend-check">
            <span class="legend-line legend-line--similar" /> <span>{{ L.legendSimilar }}</span>
          </label>
          <label class="legend-row legend-toggle" :title="L.showTags">
            <input v-model="showTagEdges" type="checkbox" class="legend-check">
            <span class="legend-line legend-line--tag" /> <span>{{ L.legendTags }}</span>
          </label>
        </div>

        <div v-if="allTags.length > 0" class="legend">
          <div v-for="tag in allTags.slice(0, 12)" :key="tag" class="legend-row">
            <span class="legend-dot" :style="{ background: tagColor.get(tag) }" />
            <span>{{ tag }}</span>
          </div>
          <div v-if="allTags.length > 12" class="legend-more">+{{ allTags.length - 12 }} autres</div>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.graph-page {
  @apply flex-1 min-w-0 min-h-0 flex flex-col;
}
.graph-header {
  @apply shrink-0 flex items-center justify-between px-8 pt-6 pb-3 border-b border-ink-200/60;
}
html.dark .graph-header {
  border-bottom-color: theme('colors.ink.800' / 60%);
}
.crumbs {
  @apply flex items-center gap-2 font-sans uppercase text-[11px] font-semibold tracking-[0.08em] text-ink-500 dark:text-ink-400;
}
.crumb { @apply text-ink-500 dark:text-ink-400; transition: color 120ms ease; }
.crumb:hover { color: theme('colors.ink.800'); }
html.dark .crumb:hover { color: theme('colors.ink.100'); }
.crumb--current {
  @apply font-semibold tracking-[0.14em] text-ink-800 dark:text-ink-100;
}
.crumb-sep { @apply text-ink-300 dark:text-ink-600; }
.graph-stats {
  @apply font-sans text-[11px] uppercase tracking-[0.08em] text-ink-500 dark:text-ink-400 tabular-nums;
}

.graph-body {
  @apply flex-1 min-h-0 flex;
}
.canvas-wrap {
  @apply relative flex-1 min-w-0 min-h-0;
  background: theme('colors.ink.50' / 50%);
}
html.dark .canvas-wrap { background: theme('colors.ink.950' / 40%); }
.canvas-wrap canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
}
.canvas-wrap canvas:active { cursor: grabbing; }
.overlay {
  @apply absolute inset-0 flex items-center justify-center text-[13px] text-ink-500 dark:text-ink-400;
  pointer-events: none;
}

.side-panel {
  @apply shrink-0 w-64 px-4 py-5 overflow-auto;
  border-left: 1px solid theme('colors.ink.200' / 60%);
  background: theme('colors.ink.50');
}
html.dark .side-panel {
  background: theme('colors.ink.900');
  border-left-color: theme('colors.ink.800' / 60%);
}
.panel-title {
  @apply font-serif text-[14px] text-ink-900 dark:text-ink-100 mb-4;
}

.control {
  @apply flex flex-col gap-1.5 mb-4;
}
.control--row {
  @apply flex-row;
}
.filter-label {
  @apply label-mono;
}
.select {
  @apply h-9 px-2 rounded text-[13px] bg-transparent text-ink-800 dark:text-ink-200;
  border: 1px solid theme('colors.ink.200');
}
html.dark .select { border-color: theme('colors.ink.800'); }

.ghost-btn {
  @apply font-sans uppercase text-[10.5px] font-semibold tracking-[0.08em] text-ink-700 dark:text-ink-200 px-2.5 py-1.5 rounded;
  border: 1px solid theme('colors.ink.200');
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  flex: 1;
}
html.dark .ghost-btn { border-color: theme('colors.ink.800'); }
.ghost-btn:hover {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
  border-color: theme('colors.ink.300');
}
html.dark .ghost-btn:hover {
  background: theme('colors.ink.800');
  color: theme('colors.ink.50');
  border-color: theme('colors.ink.700');
}

.selected-link {
  @apply text-[13px] text-accent-700 dark:text-accent-300 underline mb-2;
}

.legend {
  @apply flex flex-col gap-1.5 mt-4 pt-4 border-t border-ink-200/40;
}
html.dark .legend { border-top-color: theme('colors.ink.800' / 50%); }
.legend-row {
  @apply flex items-center gap-2 text-[12px] text-ink-600 dark:text-ink-300;
}
.legend-line {
  @apply inline-block w-5 h-0.5 rounded-full;
}
.legend-line--link { background: rgba(120, 113, 108, 0.7); height: 2px; }
.legend-line--similar { background: rgba(16, 185, 129, 0.7); height: 2px; }
.legend-line--tag {
  background: linear-gradient(to right, rgba(124,58,237,0.45) 50%, transparent 50%);
  background-size: 5px 100%;
  height: 1.5px;
}
.legend-toggle {
  @apply cursor-pointer select-none;
}
.legend-check {
  width: 13px;
  height: 13px;
  accent-color: theme('colors.accent.500');
  flex-shrink: 0;
}
.legend-dot {
  @apply inline-block w-2.5 h-2.5 rounded-full;
}
.legend-more {
  @apply text-[11px] text-ink-400 dark:text-ink-500 italic;
}
</style>
