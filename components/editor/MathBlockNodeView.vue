<script setup lang="ts">
/**
 * Block LaTeX NodeView.
 *
 * Two states:
 *   - rendered: a centred `<div class="katex-host">` shows KaTeX in display
 *     mode. Click to enter source mode.
 *   - source-edit: a `<textarea>` exposes the raw formula. Ctrl/Cmd+Enter,
 *     Escape, or blur commits the change back to `attrs.formula`. Enter alone
 *     inserts a newline so multi-line equations (matrices, alignments) are
 *     editable comfortably.
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
const textareaRef = useTemplateRef<HTMLTextAreaElement>('textareaRef')

const rendered = computed<string>(() => {
  const src = formula.value.trim()
  if (!src) return '<span class="math-empty">∅</span>'
  try {
    return katex.renderToString(src, {
      displayMode: true,
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

function autosize(): void {
  const ta = textareaRef.value
  if (!ta) return
  ta.style.height = 'auto'
  ta.style.height = `${ta.scrollHeight}px`
}

function beginEdit(): void {
  draft.value = formula.value
  editing.value = true
  void nextTick(() => {
    textareaRef.value?.focus()
    autosize()
  })
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
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    commit()
  }
  else if (e.key === 'Escape') {
    e.preventDefault()
    cancel()
  }
}

watch(
  () => props.selected,
  (sel) => {
    if (sel && !editing.value) beginEdit()
  },
)

watch(draft, () => {
  if (editing.value) void nextTick(autosize)
})
</script>

<template>
  <NodeViewWrapper
    as="div"
    class="math-block-nv"
    :class="{ 'is-selected': props.selected, 'is-editing': editing }"
  >
    <textarea
      v-if="editing"
      ref="textareaRef"
      v-model="draft"
      class="math-block-input"
      spellcheck="false"
      autocomplete="off"
      :aria-label="'Block LaTeX formula'"
      rows="1"
      @keydown="onKeydown"
      @blur="commit"
    />
    <div
      v-else
      class="katex-host"
      contenteditable="false"
      @click="beginEdit"
      v-html="rendered"
    />
  </NodeViewWrapper>
</template>

<style scoped>
.math-block-nv {
  @apply my-6;
}
.katex-host {
  @apply flex cursor-pointer items-center justify-center rounded-lg border border-transparent px-4 py-3 transition-colors;
}
.katex-host:hover {
  @apply border-ink-200 bg-ink-50/60;
}
html.dark .katex-host:hover {
  background: theme('colors.ink.800' / 60%);
  border-color: theme('colors.ink.800');
}
.math-block-nv.is-selected .katex-host {
  @apply outline outline-2 outline-accent-500;
}
.math-block-input {
  @apply block w-full resize-none rounded-lg border border-accent-400 bg-white p-3 font-mono text-sm leading-relaxed text-ink-800 outline-none;
  min-height: 2.5rem;
}
html.dark .math-block-input {
  background: theme('colors.ink.900');
  border-color: theme('colors.accent.500');
  color: theme('colors.ink.100');
}
:deep(.katex-display) {
  @apply my-0;
}
:deep(.math-empty) {
  @apply font-mono text-sm text-ink-400;
}
:deep(.math-error) {
  @apply font-mono text-sm text-red-600;
  white-space: pre-wrap;
}
html.dark :deep(.math-error) {
  color: theme('colors.red.400');
}
</style>
