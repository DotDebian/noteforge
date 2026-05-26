<script setup lang="ts">
/**
 * Inline LaTeX NodeView.
 *
 * Two states:
 *   - rendered: a `<span class="katex-host">` shows KaTeX's HTML output. Click
 *     to enter source mode.
 *   - source-edit: a single-line `<input>` shows the raw `$…$` formula. Enter,
 *     Escape, or blur commits the change back to `attrs.formula`.
 *
 * The node is atomic (Tiptap won't let the caret enter it), so we drive the
 * edit/render toggle ourselves and use `updateAttributes` to persist edits.
 */
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import katex from 'katex'

const props = defineProps(nodeViewProps)

const formula = computed<string>(() => {
  const f = (props.node.attrs as { formula?: string }).formula
  return typeof f === 'string' ? f : ''
})

const editing = ref(false)
const draft = ref<string>(formula.value)
const inputRef = useTemplateRef<HTMLInputElement>('inputRef')

/**
 * KaTeX renders to a string of HTML. We use `throwOnError: false` so a typo
 * displays the source highlighted in red instead of breaking the whole
 * document render. Output defaults to `htmlAndMathml` for screen-reader
 * accessibility.
 */
const rendered = computed<string>(() => {
  const src = formula.value.trim()
  if (!src) return '<span class="math-empty">∅</span>'
  try {
    return katex.renderToString(src, {
      displayMode: false,
      throwOnError: false,
    })
  }
  catch (err) {
    const msg = (err as Error).message ?? String(err)
    const safe = msg.replace(/[<>&]/g, (c) =>
      c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;',
    )
    return `<span class="math-error">${safe}</span>`
  }
})

function beginEdit(): void {
  draft.value = formula.value
  editing.value = true
  void nextTick(() => inputRef.value?.focus())
}

function commit(): void {
  const next = draft.value
  if (next !== formula.value) {
    props.updateAttributes({ formula: next })
  }
  editing.value = false
}

function cancel(): void {
  draft.value = formula.value
  editing.value = false
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    commit()
  }
  else if (e.key === 'Escape') {
    e.preventDefault()
    cancel()
  }
}

// If ProseMirror's own selection lands on this node from outside (e.g. keyboard
// nav), open the editor — that matches the "selected = editable source" UX.
watch(
  () => props.selected,
  (sel) => {
    if (sel && !editing.value) beginEdit()
  },
)
</script>

<template>
  <NodeViewWrapper
    as="span"
    class="math-inline-nv"
    :class="{ 'is-selected': props.selected, 'is-editing': editing }"
  >
    <input
      v-if="editing"
      ref="inputRef"
      v-model="draft"
      type="text"
      class="math-inline-input"
      spellcheck="false"
      autocomplete="off"
      :aria-label="'Inline LaTeX formula'"
      @keydown="onKeydown"
      @blur="commit"
    >
    <span
      v-else
      class="katex-host"
      contenteditable="false"
      :title="formula"
      @click="beginEdit"
      v-html="rendered"
    />
  </NodeViewWrapper>
</template>

<style scoped>
.math-inline-nv {
  display: inline;
  white-space: nowrap;
}
.katex-host {
  @apply cursor-pointer rounded px-0.5;
  /* Subtle hover to hint editability without screaming. */
  transition: background-color 0.12s ease;
}
.katex-host:hover {
  @apply bg-accent-100/60;
}
html.dark .katex-host:hover {
  background: theme('colors.accent.900' / 30%);
}
.math-inline-nv.is-selected .katex-host {
  @apply outline outline-2 outline-accent-500;
}
.math-inline-input {
  @apply rounded border border-accent-400 bg-white px-1.5 py-0.5 font-mono text-[0.9em] text-ink-800 outline-none;
  min-width: 6ch;
}
html.dark .math-inline-input {
  background: theme('colors.ink.900');
  border-color: theme('colors.accent.500');
  color: theme('colors.ink.100');
}
:deep(.math-empty) {
  @apply font-mono text-sm text-ink-400;
}
:deep(.math-error) {
  @apply font-mono text-sm text-red-600;
}
html.dark :deep(.math-error) {
  color: theme('colors.red.400');
}
</style>
