<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { Editor } from '@tiptap/vue-3'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { useLocale } from '~/composables/useLocale'

const { t } = useLocale()

interface Props {
  editor: Editor | null | undefined
}
const props = defineProps<Props>()

interface OutlineHeading {
  level: number
  text: string
  pos: number
  id: string
}

const headings = shallowRef<OutlineHeading[]>([])
const activeId = ref<string | null>(null)

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let observer: IntersectionObserver | null = null
// Map a heading DOM element back to the OutlineHeading.id so the IO
// callback can update `activeId` without re-querying the doc.
const elementIdMap = new WeakMap<Element, string>()
// Track which heading is currently "active". We pick the entry with the
// smallest intersectionRatio>0 that's near the top, but really any
// intersecting heading wins — we just remember the last reported one.
const intersecting = new Set<string>()

function computeHeadings(ed: Editor): OutlineHeading[] {
  const out: OutlineHeading[] = []
  let counter = 0
  ed.state.doc.descendants((node: ProseMirrorNode, pos: number) => {
    if (node.type.name === 'heading') {
      const text = node.textContent.trim()
      if (text.length > 0) {
        const level = Number(node.attrs.level) || 1
        out.push({
          level,
          text,
          pos,
          id: `h-${pos}-${counter++}`,
        })
      }
      // Don't descend into heading children — textContent already covers it.
      return false
    }
    return true
  })
  return out
}

function ensureObserver(): IntersectionObserver {
  if (observer) return observer
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = elementIdMap.get(entry.target)
        if (!id) continue
        if (entry.isIntersecting) intersecting.add(id)
        else intersecting.delete(id)
      }
      // Pick the heading that appears first in document order among those
      // currently intersecting the band.
      if (intersecting.size === 0) return
      for (const h of headings.value) {
        if (intersecting.has(h.id)) {
          activeId.value = h.id
          return
        }
      }
    },
    {
      // Top ~30% of viewport is the "active" band. Headings above the band
      // (already passed) and below it (not yet reached) are inactive.
      rootMargin: '-30% 0px -60% 0px',
      threshold: 0,
    },
  )
  return observer
}

function headingElementFor(ed: Editor, pos: number): HTMLElement | null {
  try {
    // `pos` is the position OF the heading node; +1 enters the heading's
    // text. domAtPos returns the text/inline DOM; walk up to the H1/H2/H3.
    const at = ed.view.domAtPos(pos + 1)
    let el: Node | null = at.node
    while (el && el.nodeType !== 1) el = el.parentNode
    let cur = el as HTMLElement | null
    while (cur && !/^H[1-6]$/.test(cur.tagName)) {
      cur = cur.parentElement
    }
    return cur
  }
  catch {
    return null
  }
}

function reobserve(ed: Editor) {
  const io = ensureObserver()
  io.disconnect()
  intersecting.clear()
  for (const h of headings.value) {
    const el = headingElementFor(ed, h.pos)
    if (el) {
      elementIdMap.set(el, h.id)
      io.observe(el)
    }
  }
}

function recompute() {
  const ed = props.editor
  if (!ed) {
    headings.value = []
    activeId.value = null
    return
  }
  headings.value = computeHeadings(ed)
  if (!headings.value.some(h => h.id === activeId.value)) {
    activeId.value = headings.value[0]?.id ?? null
  }
  // Give Tiptap a frame to render new heading nodes to the DOM.
  requestAnimationFrame(() => {
    if (props.editor) reobserve(props.editor)
  })
}

function scheduleRecompute() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(recompute, 300)
}

function onClickHeading(h: OutlineHeading) {
  const ed = props.editor
  if (!ed) return
  ed.chain().focus().setTextSelection(h.pos + 1).run()
  requestAnimationFrame(() => {
    const el = headingElementFor(ed, h.pos)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
  activeId.value = h.id
}

/* -------------------------------------------------------------------- */
/*  Wire editor events (reactive — handles late-arriving editor)        */
/* -------------------------------------------------------------------- */

const editorRef = computed(() => props.editor ?? null)

function detach(ed: Editor) {
  ed.off('update', scheduleRecompute)
  ed.off('create', scheduleRecompute)
}

function attach(ed: Editor) {
  ed.on('update', scheduleRecompute)
  ed.on('create', scheduleRecompute)
  // Initial pass — the editor may already have content.
  recompute()
}

watch(
  editorRef,
  (next, prev) => {
    if (prev) detach(prev)
    if (next) attach(next)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
  if (observer) {
    observer.disconnect()
    observer = null
  }
  if (props.editor) detach(props.editor)
})

const visible = computed(() => headings.value.length >= 2)
</script>

<template>
  <nav v-if="visible" class="outline-panel" aria-label="Document outline">
    <h3 class="label-mono outline-label">
      {{ t('editor.outline.title') }}
    </h3>
    <ul class="outline-list">
      <li
        v-for="h in headings"
        :key="h.id"
      >
        <button
          type="button"
          class="outline-row"
          :class="{ 'outline-row--active': h.id === activeId }"
          :style="{ paddingLeft: `${8 + (h.level - 1) * 12}px` }"
          :title="h.text"
          @click="onClickHeading(h)"
        >
          <span class="outline-text">{{ h.text }}</span>
        </button>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.outline-panel {
  @apply px-4 pt-4 pb-3 border-b border-ink-200/60 font-sans;
}
html.dark .outline-panel {
  border-bottom-color: theme('colors.ink.800' / 60%);
}

.outline-label {
  @apply mb-2;
}

.outline-list {
  @apply flex flex-col;
}

/* Desktop: cap the outline so a heading-heavy doc doesn't squeeze the
   Insights / Backlinks panels out of the rail. The list scrolls internally;
   on mobile (DocInsightsSheet) the natural height is fine. */
@media (min-width: 1024px) {
  .outline-list {
    max-height: calc(33vh - 3.25rem);
    overflow-y: auto;
  }
}

.outline-row {
  @apply w-full text-left text-sm py-1 pr-2 rounded text-ink-600 dark:text-ink-300 transition-colors;
}
.outline-row:hover {
  @apply bg-ink-100 dark:bg-ink-800 text-ink-900 dark:text-ink-50;
}

.outline-row--active {
  @apply font-medium text-accent-600 dark:text-accent-400;
}

.outline-text {
  @apply block truncate;
}
</style>
