<script setup lang="ts">
/**
 * Legacy in-note whiteboard — READ ONLY.
 *
 * Drawings are standalone documents now (`type: 'excalidraw'`, see
 * `ExcalidrawEditor.vue`); a whiteboard can no longer be inserted into a note.
 * This node view only exists so that notes written before that change still
 * render: it paints the PNG the old Konva editor stored in `data-preview` and
 * nothing else. Konva is no longer a dependency, so the underlying
 * `data-scene` — a Konva layer graph — cannot be brought back to life.
 *
 * The block is still deletable (select it in the editor and press Backspace),
 * and the "extract" action lifts the preview out into a plain markdown image so
 * the note stops carrying a dead custom node at all.
 */
import { computed } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { useDialog } from '~/composables/useDialog'
import { useLocale } from '~/composables/useLocale'

const props = defineProps(nodeViewProps)
const { locale } = useLocale()
const dialog = useDialog()

const L = computed(() => locale.value === 'fr'
  ? {
      title: 'Ancien tableau blanc',
      hint: 'Les tableaux sont désormais des documents à part entière (menu + › Nouvel Excalidraw). Cet ancien tableau est conservé en lecture seule.',
      noPreview: 'Aucun aperçu n’avait été enregistré pour cet ancien tableau.',
      extract: 'Convertir en image',
      extractTitle: 'Convertir en image ?',
      extractMsg: 'Le bloc sera remplacé par son aperçu sous forme d’image markdown ordinaire. Les données de dessin d’origine, déjà non modifiables, seront supprimées.',
      extractConfirm: 'Convertir',
    }
  : {
      title: 'Legacy whiteboard',
      hint: 'Drawings are standalone documents now (+ menu › New Excalidraw). This older board is kept read-only.',
      noPreview: 'No preview was stored for this legacy board.',
      extract: 'Convert to image',
      extractTitle: 'Convert to an image?',
      extractMsg: 'The block will be replaced by its preview as an ordinary markdown image. The original drawing data — already not editable — will be dropped.',
      extractConfirm: 'Convert',
    })

const preview = computed<string>(() => String((props.node.attrs as { preview?: string }).preview ?? ''))

async function onExtract(): Promise<void> {
  const src = preview.value
  if (!src) return
  const ok = await dialog.confirm({
    title: L.value.extractTitle,
    message: L.value.extractMsg,
    confirmLabel: L.value.extractConfirm,
  })
  if (!ok) return
  const pos = props.getPos()
  if (typeof pos !== 'number') return
  props.editor
    .chain()
    .focus()
    .deleteRange({ from: pos, to: pos + props.node.nodeSize })
    .insertContentAt(pos, { type: 'image', attrs: { src, alt: L.value.title } })
    .run()
}
</script>

<template>
  <NodeViewWrapper
    as="div"
    class="whiteboard-nv"
    :class="{ 'is-selected': props.selected }"
    contenteditable="false"
  >
    <header class="whiteboard-toolbar">
      <span class="whiteboard-title">{{ L.title }}</span>
      <span class="whiteboard-spacer" />
      <button
        v-if="preview"
        type="button"
        class="wb-text-btn"
        @click="onExtract"
      >
        {{ L.extract }}
      </button>
    </header>

    <div class="whiteboard-body">
      <img
        v-if="preview"
        :src="preview"
        :alt="L.title"
        class="whiteboard-img"
        draggable="false"
      >
      <p v-else class="whiteboard-empty">
        {{ L.noPreview }}
      </p>
      <p class="whiteboard-hint">
        {{ L.hint }}
      </p>
    </div>
  </NodeViewWrapper>
</template>

<style scoped>
.whiteboard-nv {
  @apply my-6 overflow-hidden rounded-lg border border-ink-200 bg-white;
}
html.dark .whiteboard-nv {
  background: theme('colors.ink.900');
  border-color: theme('colors.ink.800');
}
.whiteboard-nv.is-selected {
  @apply outline outline-2 outline-accent-500;
}

.whiteboard-toolbar {
  @apply flex flex-wrap items-center gap-2 border-b border-ink-200 bg-ink-50 px-3 py-2;
}
html.dark .whiteboard-toolbar {
  background: theme('colors.ink.950');
  border-bottom-color: theme('colors.ink.800');
}
.whiteboard-title {
  @apply text-[11px] font-medium uppercase tracking-wider text-ink-500;
}
html.dark .whiteboard-title { color: theme('colors.ink.400'); }
.whiteboard-spacer { @apply flex-1; }

.wb-text-btn {
  @apply rounded border border-ink-200 bg-white px-2 py-1 text-xs text-ink-700 transition-colors hover:bg-ink-100;
}
html.dark .wb-text-btn {
  background: theme('colors.ink.900');
  border-color: theme('colors.ink.800');
  color: theme('colors.ink.200');
}
html.dark .wb-text-btn:hover { background: theme('colors.ink.800'); }

.whiteboard-body {
  @apply flex flex-col items-center gap-2 p-4;
}
.whiteboard-img {
  @apply max-w-full rounded border border-ink-100;
  -webkit-user-drag: none;
}
html.dark .whiteboard-img { border-color: theme('colors.ink.800'); }
.whiteboard-empty {
  @apply py-8 text-sm text-ink-400;
}
.whiteboard-hint {
  @apply text-center text-xs text-ink-400;
}
</style>
