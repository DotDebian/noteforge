<script setup lang="ts">
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from 'd3-force'
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useTheme } from '~/composables/useTheme'
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
interface GraphFolder {
  id: number
  name: string
  parentId: number | null
}
interface GraphResponse { nodes: GraphNode[], edges: GraphEdge[], folders: GraphFolder[] }

// d3-force mutates these in place (x/y/vx/vy each tick) — kept OUT of Vue's
// reactive graph on purpose; we redraw manually on the simulation's `tick`.
interface SimNode extends SimulationNodeDatum {
  id: number
  title: string
  group: string
}
interface SimLink extends SimulationLinkDatum<SimNode> {
  source: number | SimNode
  target: number | SimNode
  kind: 'link' | 'tag' | 'similar'
  weight?: number
}

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
  reshuffle: 'Réorganiser',
  isolate: 'Isoler le nœud sélectionné',
  unisolate: 'Annuler l\'isolement',
  legendLinks: 'Liens markdown',
  legendTags: 'Tags partagés',
  legendSimilar: 'Notes similaires',
  showTags: 'Afficher les tags partagés',
  showSimilar: 'Afficher les notes similaires',
  selected: 'Sélectionné :',
  settings: 'Réglages',
  simMin: 'Similarité min',
  tagMin: 'Tags partagés min',
  rootGroup: 'Racine',
  untitled: 'Sans titre',
  stats: (n: number, e: number) => `${n} notes · ${e} liens`,
}

useHead(() => ({ title: `${L.title} — NoteForge` }))

const route = useRoute()
const router = useRouter()
const workspacesStore = useWorkspacesStore()
const { isDark } = useTheme()
const workspaceId = computed(() => Number(route.params.workspaceId))

const { data, pending } = await useFetch<GraphResponse>(
  () => `/api/workspaces/${workspaceId.value}/graph`,
  { watch: [workspaceId] },
)

const nodes = computed<GraphNode[]>(() => data.value?.nodes ?? [])
const edges = computed<GraphEdge[]>(() => data.value?.edges ?? [])
const graphFolders = computed<GraphFolder[]>(() => data.value?.folders ?? [])

/* ---------- Colour palette (by top-level folder, NOT by tag) ---------- */
const FOLDER_PALETTE = [
  '#e0792b', '#3b82f6', '#10b981', '#a855f7',
  '#ec4899', '#eab308', '#14b8a6', '#f97316',
]
const ROOT_COLOR = '#94a3b8'

/* ---------- Controls / filters ---------- */
const filterTag = ref<string>('')
const selectedNodeId = ref<number | null>(null)
const isolated = ref(false)
const showTagEdges = ref(true)
const showSimilarEdges = ref(true)
// Edge thresholds: similar edges below this cosine % and tag edges below this
// shared-tag count are hidden (visual filter only — layout is unchanged).
const minSimilarPct = ref(78)
const minSharedTags = ref(1)

const allTags = computed<string[]>(() => {
  const s = new Set<string>()
  for (const n of nodes.value) for (const t of n.tags) s.add(t)
  return Array.from(s).sort()
})

/* ---------- Simulation state (non-reactive; redraw is manual) ---------- */
let sim: Simulation<SimNode, SimLink> | null = null
let simNodes: SimNode[] = []
let simLinks: SimLink[] = []
let degreeById = new Map<number, number>()
let fittedOnce = false
// Bumped whenever the graph is rebuilt, so reactive computeds re-derive.
const graphVersion = ref(0)

function endId(x: number | SimNode): number {
  return typeof x === 'number' ? x : x.id
}

// Top-level folder of a doc → its colour group. Root-level docs → 'root'.
function topGroup(folderId: number | null, parentOf: Map<number, number | null>): string {
  if (folderId == null || !parentOf.has(folderId)) return 'root'
  let cur = folderId
  const seen = new Set<number>()
  for (;;) {
    const p = parentOf.get(cur)
    if (p == null || !parentOf.has(p) || seen.has(cur)) break
    seen.add(cur)
    cur = p
  }
  return `f${cur}`
}

function nodeRadius(id: number): number {
  const deg = degreeById.get(id) ?? 0
  return Math.min(12, 4 + Math.sqrt(deg) * 1.6)
}

const palette = computed(() => {
  void graphVersion.value
  const folderName = new Map(graphFolders.value.map(f => [f.id, f.name] as const))
  const keys: string[] = []
  const seen = new Set<string>()
  for (const n of simNodes) {
    if (!seen.has(n.group)) {
      seen.add(n.group)
      keys.push(n.group)
    }
  }
  const colorByGroup = new Map<string, string>([['root', ROOT_COLOR]])
  let pi = 0
  for (const g of keys) {
    if (g === 'root') continue
    colorByGroup.set(g, FOLDER_PALETTE[pi % FOLDER_PALETTE.length]!)
    pi++
  }
  const list = keys.map(g => ({
    key: g,
    label: g === 'root' ? L.rootGroup : (folderName.get(Number(g.slice(1))) || '—'),
    color: colorByGroup.get(g) ?? ROOT_COLOR,
  }))
  return { colorByGroup, list }
})

function colorOf(group: string): string {
  return palette.value.colorByGroup.get(group) ?? ROOT_COLOR
}

// Visibility predicate shared by drawing, the link count, and isolate — so the
// threshold sliders, type toggles, and stats all agree.
function linkVisible(l: SimLink): boolean {
  if (l.kind === 'tag') return showTagEdges.value && (l.weight ?? 1) >= minSharedTags.value
  if (l.kind === 'similar') return showSimilarEdges.value && (l.weight ?? 0) * 100 >= minSimilarPct.value
  return true
}

const maxSharedTags = computed(() => {
  void graphVersion.value
  let m = 1
  for (const l of simLinks) if (l.kind === 'tag') m = Math.max(m, l.weight ?? 1)
  return m
})

const drawnLinkCount = computed(() => {
  void graphVersion.value
  return simLinks.filter(linkVisible).length
})

// Doc ids to keep lit; `null` means everything is lit (no filter / isolate).
const highlightIds = computed<Set<number> | null>(() => {
  void graphVersion.value
  const hasFilter = !!filterTag.value
  const hasIsolate = isolated.value && selectedNodeId.value != null
  if (!hasFilter && !hasIsolate) return null

  let set: Set<number> | null = null
  if (hasFilter) {
    set = new Set(nodes.value.filter(n => n.tags.includes(filterTag.value)).map(n => n.id))
  }
  if (hasIsolate) {
    const sel = selectedNodeId.value!
    const keep = new Set<number>([sel])
    for (const l of simLinks) {
      if (!linkVisible(l)) continue
      const s = endId(l.source)
      const t = endId(l.target)
      if (s === sel) keep.add(t)
      else if (t === sel) keep.add(s)
    }
    if (set) {
      for (const id of Array.from(set)) if (!keep.has(id)) set.delete(id)
    }
    else { set = keep }
  }
  return set
})

/* ---------- Canvas + view transform ---------- */
const canvasEl = ref<HTMLCanvasElement | null>(null)
const containerEl = ref<HTMLDivElement | null>(null)
const zoom = ref(1)
const offsetX = ref(0)
const offsetY = ref(0)
const hoverId = ref<number | null>(null)

let resizeObserver: ResizeObserver | null = null

function withAlpha(hex: string, a: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

/* ---------- Build / run the d3-force simulation ---------- */
function buildSim() {
  if (sim) { sim.stop(); sim = null }

  const parentOf = new Map<number, number | null>()
  for (const f of graphFolders.value) parentOf.set(f.id, f.parentId)

  simNodes = nodes.value.map(n => ({
    id: n.id,
    title: n.title,
    group: topGroup(n.folderId, parentOf),
  }))
  const byId = new Map(simNodes.map(n => [n.id, n]))

  simLinks = edges.value
    .filter(e => byId.has(e.source) && byId.has(e.target))
    .map(e => ({ source: e.source, target: e.target, kind: e.kind, weight: e.weight }))

  degreeById = new Map<number, number>()
  for (const l of simLinks) {
    degreeById.set(endId(l.source), (degreeById.get(endId(l.source)) ?? 0) + 1)
    degreeById.set(endId(l.target), (degreeById.get(endId(l.target)) ?? 0) + 1)
  }

  // Gentle per-group anchors arranged on a ring → folders drift into regions
  // without overriding the link/charge layout.
  const groupKeys = Array.from(new Set(simNodes.map(n => n.group)))
  const anchors = new Map<string, { x: number, y: number }>()
  const anchorR = groupKeys.length <= 1 ? 0 : 90 + groupKeys.length * 16
  groupKeys.forEach((g, i) => {
    const a = (i / groupKeys.length) * Math.PI * 2 - Math.PI / 2
    anchors.set(g, { x: Math.cos(a) * anchorR, y: Math.sin(a) * anchorR })
  })
  const anchorOf = (g: string) => anchors.get(g) ?? { x: 0, y: 0 }

  sim = forceSimulation<SimNode, SimLink>(simNodes)
    .force('link', forceLink<SimNode, SimLink>(simLinks)
      .id(d => d.id)
      .distance(l => (l.kind === 'link' ? 40 : l.kind === 'similar' ? 58 : 78))
      .strength(l => (l.kind === 'link' ? 0.7 : l.kind === 'similar' ? 0.4 : 0.12)))
    .force('charge', forceManyBody<SimNode>().strength(-180).distanceMax(420))
    .force('collide', forceCollide<SimNode>().radius(d => nodeRadius(d.id) + 3).iterations(2))
    .force('x', forceX<SimNode>(d => anchorOf(d.group).x).strength(0.05))
    .force('y', forceY<SimNode>(d => anchorOf(d.group).y).strength(0.05))
    .force('center', forceCenter<SimNode>(0, 0))
    .on('tick', draw)
    .on('end', () => {
      if (!fittedOnce) { fittedOnce = true; fitView(); draw() }
    })

  fittedOnce = false
  graphVersion.value++
  setInitialView()
  draw()
}

function setInitialView() {
  const c = containerEl.value
  if (!c) return
  const estR = 30 * Math.sqrt(Math.max(1, simNodes.length)) + 60
  zoom.value = Math.max(0.2, Math.min(2, Math.min(c.clientWidth, c.clientHeight) / (estR * 2 + 80)))
  offsetX.value = c.clientWidth / 2
  offsetY.value = c.clientHeight / 2
}

function fitView() {
  const c = containerEl.value
  if (!c || simNodes.length === 0) return
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const n of simNodes) {
    const r = nodeRadius(n.id)
    minX = Math.min(minX, (n.x ?? 0) - r)
    minY = Math.min(minY, (n.y ?? 0) - r)
    maxX = Math.max(maxX, (n.x ?? 0) + r)
    maxY = Math.max(maxY, (n.y ?? 0) + r)
  }
  const bw = Math.max(1, maxX - minX)
  const bh = Math.max(1, maxY - minY)
  const pad = 80
  zoom.value = Math.max(0.2, Math.min(3, Math.min((c.clientWidth - pad) / bw, (c.clientHeight - pad) / bh)))
  offsetX.value = c.clientWidth / 2 - ((minX + maxX) / 2) * zoom.value
  offsetY.value = c.clientHeight / 2 - ((minY + maxY) / 2) * zoom.value
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

  const hl = highlightIds.value
  const sel = selectedNodeId.value
  const lit = (id: number) => hl == null || hl.has(id)
  const dark = isDark.value

  // Edges.
  ctx.lineCap = 'round'
  for (const l of simLinks) {
    if (!linkVisible(l)) continue
    const a = l.source as SimNode
    const b = l.target as SimNode
    if (a.x == null || b.x == null) continue
    const onSel = sel != null && (a.id === sel || b.id === sel)
    const dim = !(lit(a.id) && lit(b.id)) && !onSel
    if (l.kind === 'link') {
      // Markdown links are binary (no weight) — fixed weight.
      ctx.strokeStyle = onSel ? '#f59e0b' : withAlpha('#d97706', dim ? 0.1 : 0.8)
      ctx.lineWidth = onSel ? 2.2 : 1.6
      ctx.setLineDash([])
    }
    else if (l.kind === 'similar') {
      // Width + opacity scale with cosine (0.78 floor → 1.0).
      const t = Math.max(0, Math.min(1, ((l.weight ?? 0.78) - 0.78) / 0.22))
      ctx.strokeStyle = onSel ? '#34d399' : withAlpha('#10b981', dim ? 0.08 : 0.3 + t * 0.5)
      ctx.lineWidth = onSel ? 2.6 : 0.8 + t * 2.4
      ctx.setLineDash([])
    }
    else {
      // Width scales with shared-tag count.
      const count = l.weight ?? 1
      ctx.strokeStyle = onSel ? '#c084fc' : withAlpha('#a855f7', dim ? 0.07 : 0.42)
      ctx.lineWidth = onSel ? 2 : Math.min(3, 0.7 + (count - 1) * 0.6)
      ctx.setLineDash([3, 3])
    }
    ctx.beginPath()
    ctx.moveTo(a.x, a.y ?? 0)
    ctx.lineTo(b.x, b.y ?? 0)
    ctx.stroke()
  }
  ctx.setLineDash([])

  // Nodes.
  for (const n of simNodes) {
    if (n.x == null || n.y == null) continue
    const isHover = hoverId.value === n.id
    const isSelected = sel === n.id
    const base = nodeRadius(n.id)
    const r = isSelected ? base + 3 : isHover ? base + 2 : base
    ctx.globalAlpha = lit(n.id) ? 1 : 0.18
    ctx.beginPath()
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
    ctx.fillStyle = colorOf(n.group)
    ctx.fill()
    if (isSelected || isHover) {
      ctx.lineWidth = isSelected ? 2.5 : 1.6
      ctx.strokeStyle = dark ? 'rgba(245,245,244,0.9)' : 'rgba(28,25,23,0.6)'
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  // Hover label.
  if (hoverId.value != null) {
    const s = simNodes.find(n => n.id === hoverId.value)
    if (s && s.x != null && s.y != null) {
      const label = s.title || L.untitled
      ctx.font = '12px "Inter", sans-serif'
      const lw = ctx.measureText(label).width + 12
      const lx = s.x + 12
      const ly = s.y - 28
      ctx.fillStyle = 'rgba(28, 25, 23, 0.92)'
      ctx.fillRect(lx, ly, lw, 22)
      ctx.fillStyle = '#fafaf9'
      ctx.fillText(label, lx + 6, ly + 15)
    }
  }
}

function reset() {
  fitView()
  draw()
}

function reshuffle() {
  sim?.alpha(0.9).restart()
}

/* ---------- Interaction ---------- */
function screenToWorld(x: number, y: number) {
  return { x: (x - offsetX.value) / zoom.value, y: (y - offsetY.value) / zoom.value }
}

function hitTest(x: number, y: number): SimNode | null {
  let best: SimNode | null = null
  let bestD = Number.POSITIVE_INFINITY
  for (const n of simNodes) {
    if (n.x == null || n.y == null) continue
    const dx = x - n.x
    const dy = y - n.y
    const d2 = dx * dx + dy * dy
    const rr = (nodeRadius(n.id) + 4) ** 2
    if (d2 <= rr && d2 < bestD) {
      bestD = d2
      best = n
    }
  }
  return best
}

let isPanning = false
let panStart = { x: 0, y: 0, ox: 0, oy: 0 }
let dragNode: SimNode | null = null

function onMouseDown(e: MouseEvent) {
  if (!canvasEl.value) return
  const rect = canvasEl.value.getBoundingClientRect()
  const wld = screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
  const n = hitTest(wld.x, wld.y)
  if (n) {
    selectedNodeId.value = n.id
    dragNode = n
    n.fx = n.x
    n.fy = n.y
    sim?.alphaTarget(0.3).restart()
    draw()
  }
  else {
    isPanning = true
    panStart = { x: e.clientX, y: e.clientY, ox: offsetX.value, oy: offsetY.value }
  }
}

function onMouseMove(e: MouseEvent) {
  if (!canvasEl.value) return
  const rect = canvasEl.value.getBoundingClientRect()
  const wld = screenToWorld(e.clientX - rect.left, e.clientY - rect.top)

  if (dragNode) {
    dragNode.fx = wld.x
    dragNode.fy = wld.y
    return // simulation tick redraws
  }
  if (isPanning) {
    offsetX.value = panStart.ox + (e.clientX - panStart.x)
    offsetY.value = panStart.oy + (e.clientY - panStart.y)
    draw()
    return
  }
  const n = hitTest(wld.x, wld.y)
  const id = n ? n.id : null
  if (id !== hoverId.value) {
    hoverId.value = id
    draw()
  }
}

function onMouseUp() {
  if (dragNode) {
    dragNode.fx = null
    dragNode.fy = null
    sim?.alphaTarget(0)
    dragNode = null
  }
  isPanning = false
}

function onDblClick(e: MouseEvent) {
  if (!canvasEl.value) return
  const rect = canvasEl.value.getBoundingClientRect()
  const wld = screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
  const n = hitTest(wld.x, wld.y)
  if (n) void router.push(`/w/${workspaceId.value}/d/${n.id}`)
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  const factor = e.deltaY > 0 ? 0.9 : 1.1
  const newZoom = Math.max(0.2, Math.min(4, zoom.value * factor))
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

// Data change → rebuild simulation. View / filter change → redraw only.
watch(data, () => buildSim())
watch([filterTag, isolated, showTagEdges, showSimilarEdges, minSimilarPct, minSharedTags, isDark], () => draw())

onMounted(() => {
  buildSim()
  if (containerEl.value) {
    resizeObserver = new ResizeObserver(() => draw())
    resizeObserver.observe(containerEl.value)
  }
})

onBeforeUnmount(() => {
  if (sim) sim.stop()
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
      <span class="graph-stats">{{ L.stats(nodes.length, drawnLinkCount) }}</span>
    </header>

    <div class="graph-body">
      <div ref="containerEl" class="canvas-wrap">
        <canvas
          ref="canvasEl"
          @mousedown="onMouseDown"
          @mousemove="onMouseMove"
          @mouseup="onMouseUp"
          @mouseleave="onMouseUp"
          @dblclick="onDblClick"
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
          <button type="button" class="ghost-btn" @click="reshuffle">{{ L.reshuffle }}</button>
        </div>

        <div class="settings">
          <span class="settings-title">{{ L.settings }}</span>
          <div class="control">
            <label class="filter-label range-label">
              {{ L.simMin }}<span class="range-val">{{ minSimilarPct }}%</span>
            </label>
            <input v-model.number="minSimilarPct" type="range" min="78" max="99" step="1" class="range">
          </div>
          <div v-if="maxSharedTags > 1" class="control">
            <label class="filter-label range-label">
              {{ L.tagMin }}<span class="range-val">{{ minSharedTags }}</span>
            </label>
            <input v-model.number="minSharedTags" type="range" min="1" :max="maxSharedTags" step="1" class="range">
          </div>
        </div>

        <div v-if="selectedNode" class="control">
          <label class="filter-label">{{ L.selected }}</label>
          <NuxtLink
            :to="`/w/${workspaceId}/d/${selectedNode.id}`"
            class="selected-link"
          >
            {{ selectedNode.title || L.untitled }}
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

        <div v-if="palette.list.length > 0" class="legend">
          <div v-for="g in palette.list" :key="g.key" class="legend-row">
            <span class="legend-dot" :style="{ background: g.color }" />
            <span class="legend-folder">{{ g.label }}</span>
          </div>
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

.settings {
  @apply flex flex-col gap-2 mb-4 pt-4 border-t border-ink-200/40;
}
html.dark .settings { border-top-color: theme('colors.ink.800' / 50%); }
.settings-title {
  @apply label-mono mb-1;
}
.range-label {
  @apply flex items-center justify-between;
}
.range-val {
  @apply font-sans text-[11px] font-semibold text-ink-700 dark:text-ink-200 tabular-nums normal-case tracking-normal;
}
.range {
  @apply w-full cursor-pointer;
  accent-color: theme('colors.accent.500');
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
.legend-line--link { background: rgba(217, 119, 6, 0.85); height: 2px; }
.legend-line--similar { background: rgba(16, 185, 129, 0.85); height: 2px; }
.legend-line--tag {
  background: linear-gradient(to right, rgba(168, 85, 247, 0.7) 50%, transparent 50%);
  background-size: 6px 100%;
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
  @apply inline-block w-2.5 h-2.5 rounded-full shrink-0;
}
.legend-folder {
  @apply truncate;
}
</style>
