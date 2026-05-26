<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Editor } from '@tiptap/vue-3'
import { useDialog } from '~/composables/useDialog'
import { useLocale } from '~/composables/useLocale'
import { useRealtimeTranscription } from '~/composables/useRealtimeTranscription'

const dialog = useDialog()
const { t, locale } = useLocale()

const L = computed(() => locale.value === 'fr'
  ? {
      table: 'Tableau',
      insertTable: 'Insérer un tableau',
      addRowBefore: 'Ligne au-dessus',
      addRowAfter: 'Ligne en-dessous',
      addColBefore: 'Colonne avant',
      addColAfter: 'Colonne après',
      deleteRow: 'Supprimer ligne',
      deleteCol: 'Supprimer colonne',
      deleteTable: 'Supprimer tableau',
      toggleHeader: 'Basculer en-tête',
      mergeCells: 'Fusionner cellules',
      splitCell: 'Scinder cellule',
      alignLeft: 'Aligner à gauche',
      alignCenter: 'Centrer',
      alignRight: 'Aligner à droite',
    }
  : {
      table: 'Table',
      insertTable: 'Insert table',
      addRowBefore: 'Row above',
      addRowAfter: 'Row below',
      addColBefore: 'Column before',
      addColAfter: 'Column after',
      deleteRow: 'Delete row',
      deleteCol: 'Delete column',
      deleteTable: 'Delete table',
      toggleHeader: 'Toggle header row',
      mergeCells: 'Merge cells',
      splitCell: 'Split cell',
      alignLeft: 'Align left',
      alignCenter: 'Align center',
      alignRight: 'Align right',
    })

const inTable = computed<boolean>(() => props.editor?.isActive('table') ?? false)

function runTable(name: string, attrs?: Record<string, unknown>): void {
  const ed = props.editor
  if (!ed) return
  // Tiptap's Table extension registers many commands (insertTable,
  // addRowBefore, addRowAfter, addColumnBefore, addColumnAfter, deleteRow,
  // deleteColumn, deleteTable, toggleHeaderRow, mergeCells, splitCell). We
  // call them via the chain's index signature.
  const chain = ed.chain().focus() as unknown as Record<string, (a?: unknown) => { run: () => void }>
  const fn = chain[name]
  if (typeof fn === 'function') {
    const r = attrs !== undefined ? fn.call(chain, attrs) : fn.call(chain)
    if (r && typeof r.run === 'function') r.run()
  }
}

function setCellAlign(textAlign: 'left' | 'center' | 'right'): void {
  const ed = props.editor
  if (!ed) return
  // Tiptap's `updateAttributes` command can target a node by name; both
  // `tableCell` and `tableHeader` accept a `textAlign` attribute (added in
  // ./extensions/table.ts). Try header first, then cell.
  ed.chain().focus().updateAttributes('tableHeader', { textAlign }).run()
  ed.chain().focus().updateAttributes('tableCell', { textAlign }).run()
}

function insertTable(): void {
  runTable('insertTable', { rows: 3, cols: 3, withHeaderRow: true })
}

interface Props {
  editor: Editor | null | undefined
}
const props = defineProps<Props>()

const headingMenuOpen = ref(false)

/* -------------------------------------------------------------------- */
/*  Voice-to-text (Mistral voxtral-mini-transcribe-realtime-latest)     */
/* -------------------------------------------------------------------- */

const voice = useRealtimeTranscription()
// Insertion point: captured when recording starts so the final transcript
// lands where the user clicked the mic, not at wherever the cursor drifted
// to while recording.
let voiceInsertPos: number | null = null
// Track how much of the live transcript we've already inserted so each
// delta only adds the new text — keeps the user's cursor and selection
// outside the worklet's growing range.
let voiceInsertedLen = 0

function clearVoiceInsertion() {
  voiceInsertPos = null
  voiceInsertedLen = 0
}

watch(() => voice.transcript.value, (next) => {
  const editor = props.editor
  if (!editor || voiceInsertPos === null) return
  if (next.length <= voiceInsertedLen) return
  const delta = next.slice(voiceInsertedLen)
  if (!delta) return
  // Insert without focusing — the worklet pushes deltas every ~1s and
  // re-focusing on each one steals from the title input / blocks scrolling.
  editor
    .chain()
    .insertContentAt(voiceInsertPos + voiceInsertedLen, delta)
    .run()
  voiceInsertedLen = next.length
})

async function onVoiceToggle() {
  if (!props.editor) return
  if (voice.isRecording.value) {
    // Stop and keep whatever is already inserted.
    await voice.stop()
    clearVoiceInsertion()
    return
  }
  // Idle → start. Anchor the insertion point at the current selection.
  voiceInsertPos = props.editor.state.selection.from
  voiceInsertedLen = 0
  await voice.start()
  if (voice.status.value === 'error') {
    clearVoiceInsertion()
    await dialog.alert({
      title: t('editor.voice.errorMic'),
      message: voice.error.value ?? '',
    })
  }
}

function onVoiceCancel() {
  const editor = props.editor
  if (editor && voiceInsertPos !== null && voiceInsertedLen > 0) {
    // Roll back the text we streamed in while recording.
    editor
      .chain()
      .focus()
      .deleteRange({ from: voiceInsertPos, to: voiceInsertPos + voiceInsertedLen })
      .run()
  }
  voice.cancel()
  clearVoiceInsertion()
}

const activeHeading = computed(() => {
  const editor = props.editor
  if (!editor) return null
  for (const level of [1, 2, 3] as const) {
    if (editor.isActive('heading', { level })) return level
  }
  return null
})

function run(fn: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) {
  if (!props.editor) return
  fn(props.editor.chain().focus()).run()
}

function isActive(name: string, attrs?: Record<string, unknown>): boolean {
  return props.editor?.isActive(name, attrs ?? {}) ?? false
}

function toggleHeading(level: 1 | 2 | 3) {
  headingMenuOpen.value = false
  run((c) => c.toggleHeading({ level }))
}

function setParagraph() {
  headingMenuOpen.value = false
  run((c) => c.setParagraph())
}

async function promptLink() {
  if (!props.editor) return
  const prev = (props.editor.getAttributes('link').href as string | undefined) ?? ''
  const url = await dialog.prompt({
    title: prev ? t('editor.link.editTitle') : t('editor.link.addTitle'),
    message: t('editor.link.message'),
    defaultValue: prev,
    placeholder: t('editor.link.placeholder'),
    confirmLabel: prev ? t('editor.link.update') : t('editor.link.add'),
  })
  if (url === null) return
  if (url === '') {
    props.editor.chain().focus().extendMarkRange('link').unsetLink().run()
    return
  }
  props.editor
    .chain()
    .focus()
    .extendMarkRange('link')
    .setLink({ href: url })
    .run()
}
</script>

<template>
  <div
    v-if="editor"
    class="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 border-b border-ink-200 bg-ink-50/95 px-3 py-2 backdrop-blur dark:border-ink-800/60 dark:bg-ink-950/90"
  >
    <!-- Undo / redo -->
    <button
      type="button"
      class="tb-btn"
      :disabled="!editor.can().undo()"
      :aria-label="t('editor.tb.undo')"
      @click="run((c) => c.undo())"
    >
      ↶
    </button>
    <button
      type="button"
      class="tb-btn"
      :disabled="!editor.can().redo()"
      :aria-label="t('editor.tb.redo')"
      @click="run((c) => c.redo())"
    >
      ↷
    </button>

    <span class="tb-sep" aria-hidden="true" />

    <!-- Heading dropdown -->
    <div class="relative">
      <button
        type="button"
        class="tb-btn min-w-[3.5rem] font-serif"
        :class="{ 'tb-btn-active': activeHeading !== null }"
        aria-haspopup="menu"
        :aria-expanded="headingMenuOpen"
        @click="headingMenuOpen = !headingMenuOpen"
        @blur="headingMenuOpen = false"
      >
        {{ activeHeading ? `H${activeHeading}` : t('editor.tb.heading') }}
        <span class="ml-1 text-[0.6rem] text-ink-400 dark:text-ink-500">▾</span>
      </button>
      <div
        v-if="headingMenuOpen"
        class="absolute left-0 top-full z-20 mt-1 w-36 rounded-md border border-ink-200 bg-white py-1 shadow-lg dark:border-ink-800 dark:bg-ink-900"
        role="menu"
      >
        <button
          type="button"
          class="tb-menu-item"
          role="menuitem"
          @mousedown.prevent="setParagraph"
        >
          {{ t('editor.tb.paragraph') }}
        </button>
        <button
          type="button"
          class="tb-menu-item font-serif text-2xl"
          role="menuitem"
          :class="{ 'tb-btn-active': isActive('heading', { level: 1 }) }"
          @mousedown.prevent="toggleHeading(1)"
        >
          {{ t('editor.tb.h1') }}
        </button>
        <button
          type="button"
          class="tb-menu-item font-serif text-xl"
          role="menuitem"
          :class="{ 'tb-btn-active': isActive('heading', { level: 2 }) }"
          @mousedown.prevent="toggleHeading(2)"
        >
          {{ t('editor.tb.h2') }}
        </button>
        <button
          type="button"
          class="tb-menu-item font-serif text-lg"
          role="menuitem"
          :class="{ 'tb-btn-active': isActive('heading', { level: 3 }) }"
          @mousedown.prevent="toggleHeading(3)"
        >
          {{ t('editor.tb.h3') }}
        </button>
      </div>
    </div>

    <span class="tb-sep" aria-hidden="true" />

    <!-- Inline marks -->
    <button
      type="button"
      class="tb-btn font-bold"
      :class="{ 'tb-btn-active': isActive('bold') }"
      :aria-label="t('editor.tb.bold')"
      @click="run((c) => c.toggleBold())"
    >
      B
    </button>
    <button
      type="button"
      class="tb-btn italic"
      :class="{ 'tb-btn-active': isActive('italic') }"
      :aria-label="t('editor.tb.italic')"
      @click="run((c) => c.toggleItalic())"
    >
      I
    </button>
    <button
      type="button"
      class="tb-btn line-through"
      :class="{ 'tb-btn-active': isActive('strike') }"
      :aria-label="t('editor.tb.strike')"
      @click="run((c) => c.toggleStrike())"
    >
      S
    </button>
    <button
      type="button"
      class="tb-btn font-mono"
      :class="{ 'tb-btn-active': isActive('code') }"
      :aria-label="t('editor.tb.code')"
      @click="run((c) => c.toggleCode())"
    >
      &lt;/&gt;
    </button>
    <button
      type="button"
      class="tb-btn"
      :class="{ 'tb-btn-active': isActive('link') }"
      :aria-label="t('editor.tb.link')"
      @click="promptLink"
    >
      🔗
    </button>

    <span class="tb-sep" aria-hidden="true" />

    <!-- Lists -->
    <button
      type="button"
      class="tb-btn"
      :class="{ 'tb-btn-active': isActive('bulletList') }"
      :aria-label="t('editor.tb.bulletList')"
      @click="run((c) => c.toggleBulletList())"
    >
      •
    </button>
    <button
      type="button"
      class="tb-btn"
      :class="{ 'tb-btn-active': isActive('orderedList') }"
      :aria-label="t('editor.tb.numberedList')"
      @click="run((c) => c.toggleOrderedList())"
    >
      1.
    </button>
    <button
      type="button"
      class="tb-btn"
      :class="{ 'tb-btn-active': isActive('taskList') }"
      :aria-label="t('editor.tb.taskList')"
      @click="run((c) => c.toggleTaskList())"
    >
      ☐
    </button>

    <span class="tb-sep" aria-hidden="true" />

    <!-- Block elements -->
    <button
      type="button"
      class="tb-btn"
      :class="{ 'tb-btn-active': isActive('blockquote') }"
      :aria-label="t('editor.tb.blockquote')"
      @click="run((c) => c.toggleBlockquote())"
    >
      &ldquo;
    </button>
    <button
      type="button"
      class="tb-btn font-mono"
      :class="{ 'tb-btn-active': isActive('codeBlock') }"
      :aria-label="t('editor.tb.codeBlock')"
      @click="run((c) => c.toggleCodeBlock())"
    >
      { }
    </button>
    <button
      type="button"
      class="tb-btn"
      :aria-label="t('editor.tb.hr')"
      @click="run((c) => c.setHorizontalRule())"
    >
      —
    </button>
    <button
      type="button"
      class="tb-btn"
      :aria-label="L.insertTable"
      :title="L.insertTable"
      @click="insertTable"
    >
      ⊞
    </button>

    <!-- Table contextual controls (only visible while the cursor is in a table) -->
    <template v-if="inTable">
      <span class="tb-sep" aria-hidden="true" />
      <button type="button" class="tb-btn" :title="L.addRowBefore" @click="runTable('addRowBefore')">
        ⇧+
      </button>
      <button type="button" class="tb-btn" :title="L.addRowAfter" @click="runTable('addRowAfter')">
        ⇩+
      </button>
      <button type="button" class="tb-btn" :title="L.addColBefore" @click="runTable('addColumnBefore')">
        ⇦+
      </button>
      <button type="button" class="tb-btn" :title="L.addColAfter" @click="runTable('addColumnAfter')">
        ⇨+
      </button>
      <button type="button" class="tb-btn" :title="L.deleteRow" @click="runTable('deleteRow')">
        −R
      </button>
      <button type="button" class="tb-btn" :title="L.deleteCol" @click="runTable('deleteColumn')">
        −C
      </button>
      <button type="button" class="tb-btn" :title="L.toggleHeader" @click="runTable('toggleHeaderRow')">
        H¶
      </button>
      <button type="button" class="tb-btn" :title="L.mergeCells" @click="runTable('mergeCells')">
        ⊓
      </button>
      <button type="button" class="tb-btn" :title="L.splitCell" @click="runTable('splitCell')">
        ⊔
      </button>
      <button type="button" class="tb-btn" :title="L.alignLeft" @click="setCellAlign('left')">
        ⫷
      </button>
      <button type="button" class="tb-btn" :title="L.alignCenter" @click="setCellAlign('center')">
        ≡
      </button>
      <button type="button" class="tb-btn" :title="L.alignRight" @click="setCellAlign('right')">
        ⫸
      </button>
      <button type="button" class="tb-btn" :title="L.deleteTable" @click="runTable('deleteTable')">
        ✕
      </button>
    </template>

    <span class="tb-sep" aria-hidden="true" />

    <!-- Voice note (realtime transcription) -->
    <button
      type="button"
      class="tb-rec"
      :class="{ 'tb-rec-active': voice.isRecording.value }"
      :aria-label="voice.isRecording.value ? t('editor.tb.voiceRecording') : t('editor.tb.voice')"
      :aria-pressed="voice.isRecording.value"
      :disabled="voice.status.value === 'connecting' || voice.status.value === 'requesting-permission' || voice.status.value === 'stopping'"
      @click="onVoiceToggle"
    >
      <span class="tb-rec-dot" />
    </button>
    <button
      v-if="voice.isRecording.value || voice.status.value === 'connecting' || voice.status.value === 'requesting-permission'"
      type="button"
      class="tb-rec-cancel"
      @click="onVoiceCancel"
    >
      {{ t('editor.voice.cancel') }}
    </button>
  </div>
</template>

<style scoped>
.tb-btn {
  @apply inline-flex h-8 min-w-[2rem] items-center justify-center rounded px-2 text-sm text-ink-700 transition-colors hover:bg-ink-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:text-ink-200 dark:hover:bg-ink-800;
}
/* Mobile (F10): bump toolbar tap targets to 36px and widen the hit area. */
@media (max-width: 767px) {
  .tb-btn {
    @apply h-9 min-w-[2.25rem];
  }
}
.tb-btn-active {
  @apply bg-ink-900 text-ink-50 hover:bg-ink-800 dark:bg-ink-100 dark:text-ink-900 dark:hover:bg-ink-200;
}
.tb-sep {
  @apply mx-1 h-5 w-px bg-ink-200 dark:bg-ink-800;
}
.tb-menu-item {
  @apply block w-full px-3 py-1.5 text-left text-sm text-ink-700 transition-colors hover:bg-ink-50 dark:text-ink-200 dark:hover:bg-ink-800;
}

/* -------------------------------------------------------------------- */
/*  Voice recorder button                                               */
/* -------------------------------------------------------------------- */
.tb-rec {
  @apply inline-flex h-8 w-8 items-center justify-center rounded-full border border-ink-300 bg-transparent transition-all hover:border-ink-400 hover:bg-ink-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-ink-700 dark:hover:border-ink-600 dark:hover:bg-ink-800;
}
.tb-rec-dot {
  @apply block h-3 w-3 rounded-full bg-ink-400 transition-colors;
}
html.dark .tb-rec-dot {
  background: theme('colors.ink.500');
}
.tb-rec-active {
  @apply border-red-500 bg-red-50 hover:border-red-600 hover:bg-red-100 dark:border-red-500 dark:bg-red-950/40 dark:hover:border-red-400 dark:hover:bg-red-950/60;
  animation: tb-rec-glow 1.6s ease-in-out infinite;
}
.tb-rec-active .tb-rec-dot {
  @apply bg-red-500 dark:bg-red-400;
}
@keyframes tb-rec-glow {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.55);
  }
  50% {
    box-shadow: 0 0 0 6px rgba(239, 68, 68, 0);
  }
}
@media (max-width: 767px) {
  .tb-rec {
    @apply h-9 w-9;
  }
}

.tb-rec-cancel {
  @apply ml-2 inline-flex h-8 items-center px-2 text-xs uppercase tracking-wider text-ink-500 transition-colors hover:text-red-600 dark:text-ink-400 dark:hover:text-red-400;
}
</style>
