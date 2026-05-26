<script setup lang="ts">
/**
 * Footnote reference NodeView. Renders a small superscript link with the
 * footnote's display index (1, 2, 3…) — NOT the raw label, which is just an
 * internal identifier like `bienvenue` or `1`. The index is computed by
 * scanning the doc for unique footnote-ref labels in document order. Clicking
 * scrolls the matching `<li id="footnote-LABEL">` in the same editor into
 * view (and flashes it so the highlight is visible).
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'

const props = defineProps(nodeViewProps)

const label = computed<string>(() => {
  const l = (props.node.attrs as { label?: string }).label
  return typeof l === 'string' && l.length > 0 ? l : '1'
})

// Tiptap NodeViews don't auto re-render when sibling nodes change, so we
// subscribe to the editor's `update` event and bump a tick that the
// `displayIndex` computed depends on. Without this, deleting an earlier ref
// would leave later refs showing stale numbers until they're touched.
const tick = ref(0)
function bumpTick(): void { tick.value++ }
onMounted(() => { props.editor.on('update', bumpTick) })
onBeforeUnmount(() => { props.editor.off('update', bumpTick) })

const displayIndex = computed<number>(() => {
  // Force re-eval on every doc update.
  void tick.value
  const seen = new Set<string>()
  const order: string[] = []
  props.editor.state.doc.descendants((n) => {
    if (n.type.name === 'footnoteRef') {
      const lab = (n.attrs as { label?: string }).label ?? ''
      if (lab && !seen.has(lab)) {
        seen.add(lab)
        order.push(lab)
      }
    }
  })
  const idx = order.indexOf(label.value)
  return idx >= 0 ? idx + 1 : 1
})

function onMouseDown(e: MouseEvent): void {
  // Block ProseMirror from setting a NodeSelection on this atom before our
  // click handler can fire — without this the click never reaches `onClick`
  // when the user hits the superscript with their mouse.
  e.preventDefault()
  e.stopPropagation()
  jumpToItem()
}

function onClick(e: MouseEvent): void {
  e.preventDefault()
  e.stopPropagation()
  jumpToItem()
}

function jumpToItem(): void {
  // Resolve the target by walking the editor state — more robust than a DOM
  // querySelector because it works even if mergeAttributes / parseHTML have
  // dropped one of the expected attributes (data-footnote-item / id /
  // data-label). If we find the node, we ask Tiptap for its DOM via
  // view.domAtPos and scroll that element. Tiptap's own scrollIntoView only
  // scrolls the PM viewport, not the surrounding `.editor-scroll` container,
  // so we do the manual native scroll on top.
  const ed = props.editor
  const wanted = label.value
  let itemPos = -1
  ed.state.doc.descendants((n, pos) => {
    if (itemPos !== -1) return false
    if (n.type.name === 'footnoteItem') {
      const lab = (n.attrs as { label?: string }).label ?? ''
      if (lab === wanted) {
        itemPos = pos
        return false
      }
    }
    return true
  })
  if (itemPos === -1) return

  // Defer one frame so any focus/selection side-effect from the click has
  // settled, then resolve the DOM node and walk up to the <li>.
  requestAnimationFrame(() => {
    try {
      const dom = ed.view.domAtPos(itemPos + 1)
      let el: HTMLElement | null = dom.node.nodeType === 1
        ? (dom.node as HTMLElement)
        : dom.node.parentElement
      while (el && el.tagName !== 'LI') el = el.parentElement
      if (!el) return
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('footnote-target-flash')
      window.setTimeout(() => el!.classList.remove('footnote-target-flash'), 1400)
    }
    catch (err) {
      console.warn('[footnote] scroll failed', err)
    }
  })
}
</script>

<template>
  <NodeViewWrapper
    as="sup"
    class="footnote-ref-nv"
    :data-label="label"
    :class="{ 'is-selected': props.selected }"
  >
    <a
      :href="`#footnote-${label}`"
      class="footnote-ref-link"
      :title="`Footnote ${displayIndex}`"
      contenteditable="false"
      @mousedown="onMouseDown"
      @click="onClick"
    >{{ displayIndex }}</a>
  </NodeViewWrapper>
</template>

<style scoped>
.footnote-ref-nv {
  @apply mx-0.5 inline-block align-super text-[0.75em] leading-none;
}
.footnote-ref-link {
  @apply rounded px-1 py-0 font-medium text-accent-600 no-underline;
  transition: background-color 0.12s ease;
}
.footnote-ref-link:hover {
  @apply bg-accent-100/70 text-accent-700;
}
html.dark .footnote-ref-link {
  color: theme('colors.accent.400');
}
html.dark .footnote-ref-link:hover {
  background: theme('colors.accent.900' / 40%);
  color: theme('colors.accent.300');
}
.footnote-ref-nv.is-selected .footnote-ref-link {
  @apply outline outline-2 outline-accent-500;
}
</style>
