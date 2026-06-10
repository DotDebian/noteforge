<script setup lang="ts">
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
  isolate: 'Isoler le nœud sélectionné',
  unisolate: 'Annuler l\'isolement',
  legendLinks: 'Liens markdown',
  legendTags: 'Tags partagés',
  legendSimilar: 'Notes similaires',
  showTags: 'Afficher les tags partagés',
  showSimilar: 'Afficher les notes similaires',
  selected: 'Sélectionné :',
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

/* ---------- Colour palette (by top-level folder, NOT by tag) ----------
   A handful of harmonious hues — one per top-level folder, cycled. Root-level
   docs (no folder) get a neutral slate. This is deliberately few colours: the
   old per-tag colouring cycled 280+ tags through 12 hues and meant nothing. */
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

const allTags = computed<string[]>(() => {
  const s = new Set<string>()
  for (const n of nodes.value) for (const t of n.tags) s.add(t)
  return Array.from(s).sort()
})

/* ---------- Radial-tree layout ----------
   A radial dendrogram: virtual workspace root at the centre, folders branch
   outward ring-by-ring (depth = ring), every document sits as a leaf on the
   outer rim. Deterministic — no physics, no jitter. Folders with no documents
   anywhere below them are pruned so empty branches don't waste angular space. */
interface TNode {
  key: string
  kind: 'root' | 'folder' | 'doc'
  id: number
  parent: TNode | null
  children: TNode[]
  depth: number
  group: string // top-level group key for colour: 'root' | `f${topFolderId}`
  leafStart: number
  leafEnd: number
  angle: number
  radius: number
  x: number
  y: number
  title: string
}

interface Layout {
  branches: Array<{ from: TNode, to: TNode }>
  docPos: Map<number, TNode>
  folderNodes: TNode[]
  root: TNode
  rOuter: number
  colorByGroup: Map<string, string>
  groups: Array<{ key: string, label: string, color: string }>
}

function polar(angle: number, radius: number) {
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

function buildLayout(ns: GraphNode[], fs: GraphFolder[]): Layout {
  const root: TNode = {
    key: 'root', kind: 'root', id: -1, parent: null, children: [], depth: 0,
    group: 'root', leafStart: 0, leafEnd: 0, angle: 0, radius: 0, x: 0, y: 0, title: '',
  }
  const byKey = new Map<string, TNode>([['root', root]])
  const folderIds = new Set(fs.map(f => f.id))
  const folderName = new Map(fs.map(f => [f.id, f.name] as const))

  for (const f of fs) {
    byKey.set(`f${f.id}`, {
      key: `f${f.id}`, kind: 'folder', id: f.id, parent: null, children: [], depth: 0,
      group: '', leafStart: 0, leafEnd: 0, angle: 0, radius: 0, x: 0, y: 0, title: f.name,
    })
  }
  for (const f of fs) {
    const node = byKey.get(`f${f.id}`)!
    const pKey = f.parentId != null && folderIds.has(f.parentId) ? `f${f.parentId}` : 'root'
    const parent = byKey.get(pKey) ?? root
    node.parent = parent
    parent.children.push(node)
  }
  for (const n of ns) {
    const node: TNode = {
      key: `d${n.id}`, kind: 'doc', id: n.id, parent: null, children: [], depth: 0,
      group: '', leafStart: 0, leafEnd: 0, angle: 0, radius: 0, x: 0, y: 0, title: n.title,
    }
    byKey.set(node.key, node)
    const pKey = n.folderId != null && folderIds.has(n.folderId) ? `f${n.folderId}` : 'root'
    const parent = byKey.get(pKey) ?? root
    node.parent = parent
    parent.children.push(node)
  }

  // Prune folder subtrees that contain no document.
  function docCount(node: TNode): number {
    if (node.kind === 'doc') return 1
    let c = 0
    for (const ch of node.children) c += docCount(ch)
    return c
  }
  function prune(node: TNode) {
    node.children = node.children.filter(ch => ch.kind !== 'folder' || docCount(ch) > 0)
    for (const ch of node.children) prune(ch)
  }
  prune(root)

  // Stable, pleasant order: folders before docs, then alphabetical.
  function sortChildren(node: TNode) {
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
      return a.title.localeCompare(b.title)
    })
    for (const ch of node.children) sortChildren(ch)
  }
  sortChildren(root)

  // Depth + colour group (the depth-1 ancestor decides the colour).
  function assign(node: TNode, depth: number, group: string) {
    node.depth = depth
    node.group = node.kind === 'root' ? 'root' : group
    for (const ch of node.children) {
      const childGroup = node.kind === 'root'
        ? (ch.kind === 'folder' ? `f${ch.id}` : 'root')
        : group
      assign(ch, depth + 1, childGroup)
    }
  }
  assign(root, 0, 'root')

  // Leaf indices via pre-order DFS; internal nodes get the centre of their span.
  let leafIdx = 0
  const allNodes: TNode[] = []
  function dfs(node: TNode) {
    allNodes.push(node)
    if (node.children.length === 0) {
      node.leafStart = node.leafEnd = leafIdx++
      return
    }
    let first = Number.POSITIVE_INFINITY
    let last = Number.NEGATIVE_INFINITY
    for (const ch of node.children) {
      dfs(ch)
      first = Math.min(first, ch.leafStart)
      last = Math.max(last, ch.leafEnd)
    }
    node.leafStart = first
    node.leafEnd = last
  }
  dfs(root)
  const numLeaves = Math.max(1, leafIdx)

  let maxFolderDepth = 0
  for (const n of allNodes) if (n.kind === 'folder') maxFolderDepth = Math.max(maxFolderDepth, n.depth)
  const ringDenom = maxFolderDepth + 1
  // Enough circumference for the leaves to breathe; pan/zoom handles the rest.
  const rOuter = Math.min(900, Math.max(200, numLeaves * 3.6))

  for (const n of allNodes) {
    n.angle = ((n.leafStart + n.leafEnd + 1) / 2 / numLeaves) * Math.PI * 2 - Math.PI / 2
    if (n.kind === 'root') n.radius = 0
    else if (n.kind === 'doc') n.radius = rOuter
    else n.radius = (rOuter * n.depth) / ringDenom
    const p = polar(n.angle, n.radius)
    n.x = p.x
    n.y = p.y
  }

  const branches = allNodes.filter(n => n.parent).map(n => ({ from: n.parent!, to: n }))
  const docPos = new Map<number, TNode>()
  const folderNodes: TNode[] = []
  for (const n of allNodes) {
    if (n.kind === 'doc') docPos.set(n.id, n)
    else if (n.kind === 'folder') folderNodes.push(n)
  }

  // Colours: one per top-level group, in tree order.
  const groupKeys: string[] = []
  const seen = new Set<string>()
  for (const n of allNodes) {
    if (n.group && !seen.has(n.group)) {
      seen.add(n.group)
      groupKeys.push(n.group)
    }
  }
  const colorByGroup = new Map<string, string>([['root', ROOT_COLOR]])
  let pi = 0
  for (const g of groupKeys) {
    if (g === 'root') continue
    colorByGroup.set(g, FOLDER_PALETTE[pi % FOLDER_PALETTE.length]!)
    pi++
  }
  const groups = groupKeys.map(g => ({
    key: g,
    label: g === 'root' ? L.rootGroup : (folderName.get(Number(g.slice(1))) || '—'),
    color: colorByGroup.get(g) ?? ROOT_COLOR,
  }))

  return { branches, docPos, folderNodes, root, rOuter, colorByGroup, groups }
}

const layout = computed<Layout>(() => buildLayout(nodes.value, graphFolders.value))

/* ---------- Relationship edges (drawn as chords over the tree) ---------- */
const relEdges = computed<GraphEdge[]>(() => {
  const pos = layout.value.docPos
  return edges.value.filter((e) => {
    if (e.kind === 'tag' && !showTagEdges.value) return false
    if (e.kind === 'similar' && !showSimilarEdges.value) return false
    return pos.has(e.source) && pos.has(e.target)
  })
})

const degreeById = computed<Map<number, number>>(() => {
  const m = new Map<number, number>()
  for (const e of relEdges.value) {
    m.set(e.source, (m.get(e.source) ?? 0) + 1)
    m.set(e.target, (m.get(e.target) ?? 0) + 1)
  }
  return m
})

function radiusForId(id: number): number {
  const deg = degreeById.value.get(id) ?? 0
  return Math.min(11, 4.5 + Math.sqrt(deg) * 1.5)
}

// Doc ids to keep lit; `null` means everything is lit (no filter / isolate).
const highlightIds = computed<Set<number> | null>(() => {
  const hasFilter = !!filterTag.value
  const hasIsolate = isolated.value && selectedNodeId.value != null
  if (!hasFilter && !hasIsolate) return null

  let set: Set<number> | null = null
  if (hasFilter) {
    set = new Set(nodes.value.filter(n => n.tags.includes(filterTag.value)).map(n => n.id))
  }
  if (hasIsolate) {
    const keep = new Set<number>([selectedNodeId.value!])
    for (const e of relEdges.value) {
      if (e.source === selectedNodeId.value) keep.add(e.target)
      else if (e.target === selectedNodeId.value) keep.add(e.source)
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

function fitView() {
  const c = containerEl.value
  if (!c) return
  const w = c.clientWidth
  const h = c.clientHeight
  const span = layout.value.rOuter * 2 + 80 // node radius + label headroom
  zoom.value = Math.max(0.2, Math.min(2.5, Math.min(w, h) / span))
  offsetX.value = w / 2
  offsetY.value = h / 2
}

function drawRadialLink(ctx: CanvasRenderingContext2D, from: TNode, to: TNode) {
  // Classic dendrogram bow: control points share the midpoint radius.
  const rm = (from.radius + to.radius) / 2
  const c1 = polar(from.angle, rm)
  const c2 = polar(to.angle, rm)
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, to.x, to.y)
  ctx.stroke()
}

function drawChord(ctx: CanvasRenderingContext2D, a: TNode, b: TNode) {
  // Hierarchical-ish bundling: bow through the midpoint of the two docs' parent
  // folders (pulled slightly inward), NOT the dead centre. Same-folder edges
  // share a parent so they bundle tightly toward that folder's junction; only
  // cross-folder edges dip deep — keeps the middle from becoming a knot.
  const pa = a.parent ?? a
  const pb = b.parent ?? b
  const cx = ((pa.x + pb.x) / 2) * 0.85
  const cy = ((pa.y + pb.y) / 2) * 0.85
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.quadraticCurveTo(cx, cy, b.x, b.y)
  ctx.stroke()
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

  const lay = layout.value
  const hl = highlightIds.value
  const sel = selectedNodeId.value
  const lit = (id: number) => hl == null || hl.has(id)
  const dark = isDark.value

  // 1. Tree branches — the readable skeleton, coloured by folder group.
  ctx.lineCap = 'round'
  for (const br of lay.branches) {
    const color = lay.colorByGroup.get(br.to.group) ?? ROOT_COLOR
    const litBranch = br.to.kind !== 'doc' || lit(br.to.id)
    ctx.strokeStyle = withAlpha(color, litBranch ? (dark ? 0.55 : 0.5) : 0.12)
    ctx.lineWidth = br.to.kind === 'folder' ? 1.6 : 1
    drawRadialLink(ctx, br.from, br.to)
  }

  // 2. Relationship chords — the actual insight, on top of the skeleton.
  for (const e of relEdges.value) {
    const a = lay.docPos.get(e.source)
    const b = lay.docPos.get(e.target)
    if (!a || !b) continue
    const onSel = sel != null && (e.source === sel || e.target === sel)
    const litEdge = lit(e.source) && lit(e.target)
    const dim = !litEdge && !onSel
    if (e.kind === 'link') {
      ctx.strokeStyle = onSel ? '#f59e0b' : withAlpha('#d97706', dim ? 0.1 : 0.7)
      ctx.lineWidth = onSel ? 2 : 1.4
      ctx.setLineDash([])
    }
    else if (e.kind === 'similar') {
      const weight = e.weight ?? 0.8
      const alpha = Math.max(0.28, Math.min(0.8, 0.28 + (weight - 0.78) * 1.8))
      ctx.strokeStyle = onSel ? '#34d399' : withAlpha('#10b981', dim ? 0.08 : alpha)
      ctx.lineWidth = onSel ? 1.8 : 1
      ctx.setLineDash([])
    }
    else {
      ctx.strokeStyle = onSel ? '#c084fc' : withAlpha('#a855f7', dim ? 0.07 : 0.4)
      ctx.lineWidth = onSel ? 1.5 : 0.8
      ctx.setLineDash([3, 3])
    }
    drawChord(ctx, a, b)
  }
  ctx.setLineDash([])

  // 3. Folder junctions — small muted dots so the structure reads.
  ctx.fillStyle = dark ? 'rgba(214, 211, 209, 0.5)' : 'rgba(87, 83, 78, 0.55)'
  for (const f of lay.folderNodes) {
    ctx.beginPath()
    ctx.arc(f.x, f.y, f.depth <= 1 ? 4 : 3, 0, Math.PI * 2)
    ctx.fill()
  }
  // Workspace centre.
  ctx.fillStyle = dark ? 'rgba(245, 245, 244, 0.85)' : 'rgba(41, 37, 36, 0.8)'
  ctx.beginPath()
  ctx.arc(lay.root.x, lay.root.y, 5, 0, Math.PI * 2)
  ctx.fill()

  // 4. Document nodes.
  for (const [id, n] of lay.docPos) {
    const isHover = hoverId.value === id
    const isSelected = sel === id
    const base = radiusForId(id)
    const r = isSelected ? base + 3 : isHover ? base + 2 : base
    const color = lay.colorByGroup.get(n.group) ?? ROOT_COLOR
    ctx.globalAlpha = lit(id) ? 1 : 0.18
    ctx.beginPath()
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    if (isSelected || isHover) {
      ctx.lineWidth = isSelected ? 2.5 : 1.6
      ctx.strokeStyle = dark ? 'rgba(245,245,244,0.9)' : 'rgba(28,25,23,0.6)'
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  // 5. Hover label.
  if (hoverId.value != null) {
    const s = lay.docPos.get(hoverId.value)
    if (s) {
      const label = s.title || L.untitled
      ctx.font = '12px "Inter", sans-serif'
      const lw = ctx.measureText(label).width + 12
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

function reset() {
  fitView()
  draw()
}

/* ---------- Interaction ---------- */
function screenToWorld(x: number, y: number) {
  return { x: (x - offsetX.value) / zoom.value, y: (y - offsetY.value) / zoom.value }
}

function hitTest(x: number, y: number): number | null {
  let best: number | null = null
  let bestD = Number.POSITIVE_INFINITY
  for (const [id, n] of layout.value.docPos) {
    const dx = x - n.x
    const dy = y - n.y
    const d2 = dx * dx + dy * dy
    const rr = (radiusForId(id) + 4) ** 2
    if (d2 <= rr && d2 < bestD) {
      bestD = d2
      best = id
    }
  }
  return best
}

let isPanning = false
let panStart = { x: 0, y: 0, ox: 0, oy: 0 }

// Single click selects (highlight + isolate); double-click opens the document.
function onMouseDown(e: MouseEvent) {
  if (!canvasEl.value) return
  const rect = canvasEl.value.getBoundingClientRect()
  const wld = screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
  const id = hitTest(wld.x, wld.y)
  if (id != null) {
    selectedNodeId.value = id
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

  if (isPanning) {
    offsetX.value = panStart.ox + (e.clientX - panStart.x)
    offsetY.value = panStart.oy + (e.clientY - panStart.y)
    draw()
    return
  }
  const id = hitTest(wld.x, wld.y)
  if (id !== hoverId.value) {
    hoverId.value = id
    draw()
  }
}

function onMouseUp() {
  isPanning = false
}

function onDblClick(e: MouseEvent) {
  if (!canvasEl.value) return
  const rect = canvasEl.value.getBoundingClientRect()
  const wld = screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
  const id = hitTest(wld.x, wld.y)
  if (id != null) void router.push(`/w/${workspaceId.value}/d/${id}`)
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

// Data change → re-fit + redraw. View / filter change → redraw only.
watch([() => nodes.value.length, () => graphFolders.value.length], () => { fitView(); draw() })
watch([filterTag, isolated, showTagEdges, showSimilarEdges, isDark], () => draw())

onMounted(() => {
  fitView()
  draw()
  if (containerEl.value) {
    resizeObserver = new ResizeObserver(() => draw())
    resizeObserver.observe(containerEl.value)
  }
})

onBeforeUnmount(() => {
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
      <span class="graph-stats">{{ L.stats(nodes.length, relEdges.length) }}</span>
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

        <div class="control">
          <button type="button" class="ghost-btn" @click="reset">{{ L.reset }}</button>
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

        <div v-if="layout.groups.length > 0" class="legend">
          <div v-for="g in layout.groups" :key="g.key" class="legend-row">
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
.legend-line--link { background: rgba(217, 119, 6, 0.8); height: 2px; }
.legend-line--similar { background: rgba(16, 185, 129, 0.8); height: 2px; }
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
