<script setup lang="ts">
/**
 * Collapsible (`<details>`/`<summary>`) NodeView.
 *
 * Design notes:
 *   - The Tiptap node still serializes to `<details><summary>…</summary><div>…</div></details>`
 *     (see `extensions/collapsible.ts → renderHTML`) so markdown round-trip
 *     and HTML export are unchanged. The NodeView is purely presentational.
 *   - We DO NOT wrap the rendered DOM in `<details>` here. The browser
 *     paints a "Details" placeholder whenever `<summary>` isn't a direct
 *     child of `<details>`, and the editor's NodeViewContent slot has to
 *     introduce a wrapping `<div>` around the children — so the
 *     placeholder would always show. A plain `<div>` avoids that entirely
 *     and we drive the toggle ourselves.
 *   - Layout: CSS grid with the chevron in col 1, the summary title in
 *     col 2 (same row), and the body in col 2 of the next row. The body
 *     is `display: none` when not `.is-open`.
 */
import { computed } from 'vue'
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'

const props = defineProps(nodeViewProps)

const open = computed<boolean>(() => {
  const o = (props.node.attrs as { open?: boolean }).open
  return o !== false
})

function toggle(e: MouseEvent): void {
  e.preventDefault()
  e.stopPropagation()
  props.updateAttributes({ open: !open.value })
}
</script>

<template>
  <NodeViewWrapper
    as="div"
    class="collapsible-nv"
    :class="{ 'is-open': open }"
  >
    <button
      type="button"
      class="collapsible-toggle"
      contenteditable="false"
      :aria-expanded="open"
      :aria-label="open ? 'Collapse' : 'Expand'"
      @mousedown="toggle"
      @click.prevent.stop
    >
      <svg
        class="collapsible-chevron"
        viewBox="0 0 16 16"
        width="14"
        height="14"
        aria-hidden="true"
      >
        <polyline
          points="6,4 10,8 6,12"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <NodeViewContent class="collapsible-children" />
  </NodeViewWrapper>
</template>

<style scoped>
.collapsible-nv {
  /* Anchor for the absolutely-positioned chevron. Padding-left makes room
     for it so the title text never sits under the button. */
  position: relative;
  @apply my-5 rounded-lg border border-ink-200 bg-ink-50/60;
  padding: 0.5rem 0.75rem 0.5rem 2rem;
}
html.dark .collapsible-nv {
  border-color: theme('colors.ink.800');
  background: theme('colors.ink.900' / 60%);
}

.collapsible-toggle {
  /* Pinned to the top-left so it always sits next to the first line of the
     title — independent of how tall the body gets when open. */
  position: absolute;
  left: 0.4rem;
  top: 0.55rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.4rem;
  height: 1.4rem;
  margin: 0;
  padding: 0;
  background: transparent;
  border: 0;
  cursor: pointer;
  color: theme('colors.ink.500');
  border-radius: 0.25rem;
  transition: background-color 0.12s ease, color 0.12s ease;
}
.collapsible-toggle:hover {
  background: theme('colors.ink.100');
  color: theme('colors.ink.800');
}
html.dark .collapsible-toggle {
  color: theme('colors.ink.400');
}
html.dark .collapsible-toggle:hover {
  background: theme('colors.ink.800');
  color: theme('colors.ink.100');
}
.collapsible-chevron {
  transition: transform 0.15s ease;
}
.collapsible-nv.is-open .collapsible-chevron {
  transform: rotate(90deg);
}

.collapsible-children {
  min-width: 0;
}

.collapsible-children :deep(> summary.collapsible-summary) {
  display: block;
  padding: 0;
  margin: 0;
  font-weight: 600;
  font-family: theme('fontFamily.serif');
  color: theme('colors.ink.900');
  outline: none;
  list-style: none;
  cursor: text;
  min-height: 1.4rem;
  line-height: 1.4rem;
}
.collapsible-children :deep(> summary.collapsible-summary:empty)::before {
  content: 'Titre…';
  color: theme('colors.ink.400');
  font-weight: 400;
  font-style: italic;
  pointer-events: none;
}
.collapsible-children :deep(> summary.collapsible-summary::-webkit-details-marker) {
  display: none;
}
html.dark .collapsible-children :deep(> summary.collapsible-summary) {
  color: theme('colors.ink.50');
}
html.dark .collapsible-children :deep(> summary.collapsible-summary:empty)::before {
  color: theme('colors.ink.500');
}

.collapsible-children :deep(> div[data-collapsible-content]) {
  margin-top: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px dashed theme('colors.ink.200');
}
html.dark .collapsible-children :deep(> div[data-collapsible-content]) {
  border-top-color: theme('colors.ink.800');
}
.collapsible-nv:not(.is-open) .collapsible-children :deep(> div[data-collapsible-content]) {
  display: none;
}
</style>
