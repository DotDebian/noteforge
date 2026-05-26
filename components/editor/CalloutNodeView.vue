<script setup lang="ts">
/**
 * Callout NodeView.
 *
 * Renders a coloured card with an icon, an optional editable title, and the
 * body (a `<NodeViewContent>` that hosts the inner blocks). The kind selector
 * surfaces on hover so the user can cycle info / tip / warn / quote without
 * re-typing the markdown header line.
 */
import { computed, ref } from 'vue'
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { useLocale } from '~/composables/useLocale'
import type { CalloutKind } from './extensions/callout'

const props = defineProps(nodeViewProps)
const { t } = useLocale()

const KINDS: readonly CalloutKind[] = ['info', 'tip', 'warn', 'quote'] as const

const kind = computed<CalloutKind>(() => {
  const k = (props.node.attrs as { kind?: string }).kind
  return (KINDS as readonly string[]).includes(k ?? '')
    ? (k as CalloutKind)
    : 'info'
})

const title = computed<string>(() => {
  const t2 = (props.node.attrs as { title?: string | null }).title
  return typeof t2 === 'string' ? t2 : ''
})

const editingTitle = ref(false)
const titleDraft = ref<string>(title.value)

function beginTitleEdit(): void {
  titleDraft.value = title.value
  editingTitle.value = true
}

function commitTitle(): void {
  const next = titleDraft.value.trim()
  const current = title.value
  if (next !== current) {
    props.updateAttributes({ title: next.length > 0 ? next : null })
  }
  editingTitle.value = false
}

function cancelTitle(): void {
  titleDraft.value = title.value
  editingTitle.value = false
}

function onTitleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    commitTitle()
  }
  else if (e.key === 'Escape') {
    e.preventDefault()
    cancelTitle()
  }
}

function setKind(next: CalloutKind): void {
  if (next === kind.value) return
  props.updateAttributes({ kind: next })
}

const kindLabel = computed<string>(() => t(`editor.callout.kind.${kind.value}`))
const defaultTitle = computed<string>(() => kindLabel.value)

// Unicode glyphs only (no emoji per repo rules). Picked to be visually
// distinct in both light and dark backgrounds.
const KIND_ICON: Record<CalloutKind, string> = {
  info: 'i',
  tip: '★',
  warn: '!',
  quote: '"',
}
</script>

<template>
  <NodeViewWrapper
    as="div"
    class="callout-nv"
    :data-kind="kind"
  >
    <div class="callout-card" :data-kind="kind">
      <header class="callout-header" contenteditable="false">
        <div class="callout-icon" :aria-hidden="true">{{ KIND_ICON[kind] }}</div>
        <div class="callout-title-wrap">
          <input
            v-if="editingTitle"
            v-model="titleDraft"
            type="text"
            class="callout-title-input"
            :aria-label="t('editor.callout.titleAria')"
            :placeholder="defaultTitle"
            spellcheck="true"
            @keydown="onTitleKeydown"
            @blur="commitTitle"
            @click.stop
          >
          <button
            v-else
            type="button"
            class="callout-title"
            :title="t('editor.callout.editTitle')"
            @click="beginTitleEdit"
          >
            <span v-if="title.length > 0">{{ title }}</span>
            <span v-else class="callout-title-default">{{ defaultTitle }}</span>
          </button>
        </div>
        <div class="callout-kind-picker" :aria-label="t('editor.callout.kindAria')">
          <button
            v-for="k in KINDS"
            :key="k"
            type="button"
            class="callout-kind-chip"
            :class="{ 'is-active': k === kind }"
            :title="t(`editor.callout.kind.${k}`)"
            @click="setKind(k)"
          >
            {{ t(`editor.callout.kind.${k}`) }}
          </button>
        </div>
      </header>
      <NodeViewContent class="callout-body" />
    </div>
  </NodeViewWrapper>
</template>

<style scoped>
.callout-nv {
  @apply my-5;
}
.callout-card {
  @apply rounded-lg border px-4 py-3;
  border-left-width: 4px;
}

/* info — accent blue */
.callout-card[data-kind='info'] {
  @apply border-accent-200 bg-accent-50/60;
  border-left-color: theme('colors.accent.500');
}
html.dark .callout-card[data-kind='info'] {
  background: theme('colors.accent.900' / 20%);
  border-color: theme('colors.accent.800');
  border-left-color: theme('colors.accent.400');
}

/* tip — emerald */
.callout-card[data-kind='tip'] {
  border-color: theme('colors.emerald.200');
  background: theme('colors.emerald.50' / 70%);
  border-left-color: theme('colors.emerald.500');
}
html.dark .callout-card[data-kind='tip'] {
  background: theme('colors.emerald.900' / 20%);
  border-color: theme('colors.emerald.800');
  border-left-color: theme('colors.emerald.400');
}

/* warn — amber */
.callout-card[data-kind='warn'] {
  border-color: theme('colors.amber.200');
  background: theme('colors.amber.50' / 70%);
  border-left-color: theme('colors.amber.500');
}
html.dark .callout-card[data-kind='warn'] {
  background: theme('colors.amber.900' / 20%);
  border-color: theme('colors.amber.800');
  border-left-color: theme('colors.amber.400');
}

/* quote — neutral ink */
.callout-card[data-kind='quote'] {
  border-color: theme('colors.ink.200');
  background: theme('colors.ink.50' / 70%);
  border-left-color: theme('colors.ink.400');
}
html.dark .callout-card[data-kind='quote'] {
  background: theme('colors.ink.800' / 30%);
  border-color: theme('colors.ink.700');
  border-left-color: theme('colors.ink.500');
}

.callout-header {
  @apply mb-2 flex items-center gap-2;
  user-select: none;
}
.callout-icon {
  @apply flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full font-mono text-sm font-bold;
  background: currentColor;
  color: white;
  opacity: 0.85;
}
.callout-card[data-kind='info'] .callout-icon { color: theme('colors.accent.600'); background: theme('colors.accent.500'); color: white; }
.callout-card[data-kind='tip'] .callout-icon { background: theme('colors.emerald.500'); color: white; }
.callout-card[data-kind='warn'] .callout-icon { background: theme('colors.amber.500'); color: white; }
.callout-card[data-kind='quote'] .callout-icon { background: theme('colors.ink.500'); color: white; }

.callout-title-wrap {
  @apply flex-1 min-w-0;
}
.callout-title,
.callout-title-input {
  @apply w-full truncate text-left font-serif text-base font-semibold;
}
.callout-title {
  @apply cursor-text bg-transparent border-0 px-0 py-0 text-ink-900;
}
html.dark .callout-title { color: theme('colors.ink.50'); }
.callout-title:hover { @apply underline decoration-dotted underline-offset-2; }
.callout-title-default {
  @apply text-ink-400 italic font-normal;
}
html.dark .callout-title-default { color: theme('colors.ink.500'); }
.callout-title-input {
  @apply rounded border border-accent-400 bg-white px-1.5 py-0.5 text-ink-900 outline-none;
}
html.dark .callout-title-input {
  background: theme('colors.ink.900');
  color: theme('colors.ink.50');
  border-color: theme('colors.accent.500');
}

.callout-kind-picker {
  @apply ml-auto flex items-center gap-0.5 opacity-0 transition-opacity;
}
.callout-nv:hover .callout-kind-picker,
.callout-card:focus-within .callout-kind-picker {
  opacity: 1;
}
.callout-kind-chip {
  @apply rounded px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wider text-ink-500 transition-colors;
}
.callout-kind-chip:hover { @apply bg-ink-100 text-ink-700; }
html.dark .callout-kind-chip:hover { background: theme('colors.ink.800'); color: theme('colors.ink.200'); }
.callout-kind-chip.is-active { @apply bg-ink-200 text-ink-900; }
html.dark .callout-kind-chip.is-active { background: theme('colors.ink.700'); color: theme('colors.ink.50'); }

.callout-body :deep(> *) {
  @apply my-2;
}
.callout-body :deep(> *:first-child) { @apply mt-0; }
.callout-body :deep(> *:last-child) { @apply mb-0; }
</style>
