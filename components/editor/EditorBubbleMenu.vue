<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { BubbleMenu, type Editor } from '@tiptap/vue-3'
import { useDialog } from '~/composables/useDialog'
import { useLocale } from '~/composables/useLocale'
import { useChatStore } from '~/stores/chat'
import { useAiTransform, type AiAction } from '~/composables/useAiTransform'
import { useRoute } from 'vue-router'

interface Props {
  editor: Editor | null | undefined
}
const props = defineProps<Props>()
const dialog = useDialog()
const { t } = useLocale()
const chat = useChatStore()
const ai = useAiTransform()
const route = useRoute()

const aiMenuOpen = ref(false)
const aiBusy = ref(false)
let aiAbort: AbortController | null = null

function run(fn: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) {
  if (!props.editor) return
  fn(props.editor.chain().focus()).run()
}

function isActive(name: string, attrs?: Record<string, unknown>): boolean {
  return props.editor?.isActive(name, attrs ?? {}) ?? false
}

/* -------------------------------------------------------------------- */
/*  Selection helpers                                                    */
/* -------------------------------------------------------------------- */

function getSelectedText(): { text: string, from: number, to: number } | null {
  const ed = props.editor
  if (!ed) return null
  const { from, to, empty } = ed.state.selection
  if (empty) return null
  const text = ed.state.doc.textBetween(from, to, '\n', '\n')
  if (!text.trim()) return null
  return { text, from, to }
}

/* -------------------------------------------------------------------- */
/*  AI submenu — selection rewrite via /api/ai/transform                */
/* -------------------------------------------------------------------- */

const aiActions: { id: AiAction, key: string, needsOption?: 'lang' | 'tone' }[] = [
  { id: 'improve',   key: 'editor.ai.improve' },
  { id: 'summarize', key: 'editor.ai.summarize' },
  { id: 'translate', key: 'editor.ai.translate', needsOption: 'lang' },
  { id: 'continue',  key: 'editor.ai.continue' },
  { id: 'explain',   key: 'editor.ai.explain' },
  { id: 'tone',      key: 'editor.ai.tone', needsOption: 'tone' },
]

async function runAiAction(action: AiAction, needsOption?: 'lang' | 'tone'): Promise<void> {
  const ed = props.editor
  if (!ed || aiBusy.value) return
  const sel = getSelectedText()
  if (!sel) return

  let option: string | undefined
  if (needsOption === 'lang') {
    const lang = await dialog.prompt({
      title: t('editor.ai.translateTitle'),
      message: t('editor.ai.translateMessage'),
      defaultValue: t('editor.ai.translateDefault'),
      confirmLabel: t('editor.ai.translate'),
    })
    if (lang === null) return
    option = lang.trim() || t('editor.ai.translateDefault')
  }
  else if (needsOption === 'tone') {
    const tone = await dialog.prompt({
      title: t('editor.ai.toneTitle'),
      message: t('editor.ai.toneMessage'),
      defaultValue: t('editor.ai.toneDefault'),
      confirmLabel: t('editor.ai.tone'),
    })
    if (tone === null) return
    option = tone.trim() || t('editor.ai.toneDefault')
  }

  aiMenuOpen.value = false
  aiBusy.value = true
  aiAbort = new AbortController()

  // "Continue" appends to the selection rather than replacing it; everything
  // else replaces the selection range.
  const isContinue = action === 'continue'
  let insertedLen = 0
  // For non-continue, wipe the original selection first so streaming
  // characters fill in cleanly.
  if (!isContinue) {
    ed.chain().focus().deleteRange({ from: sel.from, to: sel.to }).run()
  }
  // Insert position: start of original selection for replace, end for continue.
  const anchor = isContinue ? sel.to : sel.from

  try {
    for await (const delta of ai.stream(action, sel.text, { option, signal: aiAbort.signal })) {
      const cursor = anchor + insertedLen
      ed.chain().insertContentAt(cursor, delta, { updateSelection: false }).run()
      insertedLen += delta.length
    }
  }
  catch (err) {
    if ((err as Error).name !== 'AbortError') {
      await dialog.alert({
        title: t('editor.ai.errorTitle'),
        message: (err as Error).message ?? t('editor.ai.errorGeneric'),
      })
      // Roll back partial insertion on hard error.
      if (insertedLen > 0) {
        ed.chain()
          .focus()
          .deleteRange({ from: anchor, to: anchor + insertedLen })
          .run()
      }
    }
  }
  finally {
    aiBusy.value = false
    aiAbort = null
  }
}

function cancelAi(): void {
  aiAbort?.abort()
}

onBeforeUnmount(() => cancelAi())

/* -------------------------------------------------------------------- */
/*  Cite paragraph in chat                                               */
/* -------------------------------------------------------------------- */

const docIdFromRoute = computed<number | null>(() => {
  const raw = route.params.docId
  const n = Number(Array.isArray(raw) ? raw[0] : raw)
  return Number.isInteger(n) && n > 0 ? n : null
})

const workspaceIdFromRoute = computed<number | null>(() => {
  const raw = route.params.workspaceId
  const n = Number(Array.isArray(raw) ? raw[0] : raw)
  return Number.isInteger(n) && n > 0 ? n : null
})

function citeInChat(): void {
  const sel = getSelectedText()
  if (!sel) return
  const wsId = workspaceIdFromRoute.value
  const docId = docIdFromRoute.value
  if (wsId == null) return
  // Prepend the snippet as a markdown blockquote so the user just sees it
  // queued in the composer (the chat composer is what pendingQuestion
  // populates). Use the dialect the chat already speaks.
  const quoted = sel.text
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n')
  chat.openWithScope({
    workspaceId: wsId,
    docId: docId ?? null,
    message: `${quoted}\n\n`,
  })
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

function toggleHeading(level: 1 | 2 | 3) {
  run((c) => c.toggleHeading({ level }))
}
</script>

<template>
  <BubbleMenu
    v-if="editor"
    :editor="editor"
    :tippy-options="{ duration: 100, placement: 'top' }"
    class="bubble-menu flex items-center gap-0.5 rounded-md border border-ink-200 bg-white p-1 shadow-lg dark:border-ink-800 dark:bg-ink-900"
  >
    <button
      type="button"
      class="bb-btn font-serif"
      :class="{ 'bb-btn-active': isActive('heading', { level: 1 }) }"
      :aria-label="t('editor.tb.h1')"
      @click="toggleHeading(1)"
    >
      H1
    </button>
    <button
      type="button"
      class="bb-btn font-serif"
      :class="{ 'bb-btn-active': isActive('heading', { level: 2 }) }"
      :aria-label="t('editor.tb.h2')"
      @click="toggleHeading(2)"
    >
      H2
    </button>
    <button
      type="button"
      class="bb-btn font-serif"
      :class="{ 'bb-btn-active': isActive('heading', { level: 3 }) }"
      :aria-label="t('editor.tb.h3')"
      @click="toggleHeading(3)"
    >
      H3
    </button>

    <span class="mx-1 h-4 w-px bg-ink-200 dark:bg-ink-800" aria-hidden="true" />

    <button
      type="button"
      class="bb-btn font-bold"
      :class="{ 'bb-btn-active': isActive('bold') }"
      :aria-label="t('editor.tb.bold')"
      @click="run((c) => c.toggleBold())"
    >
      B
    </button>
    <button
      type="button"
      class="bb-btn italic"
      :class="{ 'bb-btn-active': isActive('italic') }"
      :aria-label="t('editor.tb.italic')"
      @click="run((c) => c.toggleItalic())"
    >
      I
    </button>
    <button
      type="button"
      class="bb-btn font-mono"
      :class="{ 'bb-btn-active': isActive('code') }"
      :aria-label="t('editor.tb.code')"
      @click="run((c) => c.toggleCode())"
    >
      &lt;/&gt;
    </button>
    <button
      type="button"
      class="bb-btn"
      :class="{ 'bb-btn-active': isActive('link') }"
      :aria-label="t('editor.tb.link')"
      @click="promptLink"
    >
      🔗
    </button>

    <span class="mx-1 h-4 w-px bg-ink-200 dark:bg-ink-800" aria-hidden="true" />

    <!-- AI submenu — selection rewrite via /api/ai/transform -->
    <div class="relative">
      <button
        type="button"
        class="bb-btn bb-ai"
        :class="{ 'bb-btn-active': aiMenuOpen, 'bb-ai--busy': aiBusy }"
        :aria-label="t('editor.ai.menu')"
        :aria-expanded="aiMenuOpen"
        :disabled="aiBusy"
        @click="aiMenuOpen = !aiMenuOpen"
      >
        <span class="bb-ai-sparkle" aria-hidden="true">✦</span>
        <span class="bb-ai-label">{{ t('editor.ai.menu') }}</span>
      </button>
      <div
        v-if="aiMenuOpen"
        class="bb-ai-menu"
        role="menu"
        @mouseleave="aiMenuOpen = false"
      >
        <button
          v-for="a in aiActions"
          :key="a.id"
          type="button"
          class="bb-ai-item"
          role="menuitem"
          @click="runAiAction(a.id, a.needsOption)"
        >
          {{ t(a.key) }}
        </button>
      </div>
    </div>

    <button
      v-if="aiBusy"
      type="button"
      class="bb-btn bb-cancel"
      :title="t('editor.ai.cancel')"
      @click="cancelAi"
    >
      ⏹
    </button>

    <!-- Cite paragraph in chat -->
    <button
      type="button"
      class="bb-btn"
      :title="t('editor.cite.tooltip')"
      :aria-label="t('editor.cite.tooltip')"
      @click="citeInChat"
    >
      💬
    </button>
  </BubbleMenu>
</template>

<style scoped>
.bb-btn {
  @apply inline-flex h-7 min-w-[1.75rem] items-center justify-center rounded px-1.5 text-sm text-ink-700 transition-colors hover:bg-ink-100 dark:text-ink-200 dark:hover:bg-ink-800;
}
.bb-btn-active {
  @apply bg-ink-900 text-ink-50 hover:bg-ink-800 dark:bg-ink-100 dark:text-ink-900 dark:hover:bg-ink-200;
}

/* AI menu — sparkle button + popover. */
.bb-ai {
  @apply gap-1 px-2;
}
.bb-ai-sparkle {
  @apply text-[10px] text-accent-500;
}
.bb-ai-label {
  @apply text-[11px] font-semibold uppercase tracking-wider;
}
.bb-ai--busy {
  @apply opacity-60 cursor-wait;
}
.bb-ai-menu {
  @apply absolute left-0 top-full z-40 mt-1 w-44 rounded-md border border-ink-200 bg-white py-1 shadow-lg dark:border-ink-800 dark:bg-ink-900;
}
.bb-ai-item {
  @apply block w-full px-3 py-1.5 text-left text-[12.5px] text-ink-800 transition-colors hover:bg-ink-100 dark:text-ink-200 dark:hover:bg-ink-800;
}
.bb-cancel {
  @apply text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/50;
}
</style>
