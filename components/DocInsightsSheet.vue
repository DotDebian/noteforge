<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import type { Editor } from '@tiptap/vue-3'
import { useLocale } from '~/composables/useLocale'

const { t } = useLocale()

/**
 * Sprint 5 / F10 — mobile bottom sheet that wraps the rail content
 * (Outline + Insights + Backlinks) for viewports < lg.
 *
 * Renders nothing when closed. The desktop `.doc-rail` is unaffected; this
 * is an additive layer that re-uses the same panel components.
 */
const props = defineProps<{
  isOpen: boolean
  docId: number
  liveMarkdown: string
  editor: Editor | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'open-doc', docId: number): void
}>()

function onBackdrop() {
  emit('close')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.isOpen) emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

// Lock body scroll while the sheet is open so the page underneath doesn't
// rubber-band on iOS.
watch(
  () => props.isOpen,
  (open) => {
    if (typeof document === 'undefined') return
    if (open) document.body.style.overflow = 'hidden'
    else document.body.style.overflow = ''
  },
)
onBeforeUnmount(() => {
  if (typeof document !== 'undefined') document.body.style.overflow = ''
})
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="isOpen"
        class="insights-sheet-backdrop"
        aria-hidden="true"
        @click="onBackdrop"
      />
    </Transition>
    <Transition name="slide-right">
      <section
        v-if="isOpen"
        class="insights-sheet"
        role="dialog"
        aria-label="Document insights"
      >
        <header class="insights-sheet-header">
          <h2 class="sheet-title">{{ t('insights.title') }}</h2>
          <button
            type="button"
            class="sheet-close"
            :aria-label="t('chat.close')"
            @click="emit('close')"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path
                d="M4 4l8 8 M12 4l-8 8"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </header>
        <div class="insights-sheet-body">
          <DocumentOutline :editor="editor" />
          <DocumentInsightsPanel
            :doc-id="docId"
            :live-markdown="liveMarkdown"
            @open-doc="(id) => emit('open-doc', id)"
          />
          <DocumentBacklinks :doc-id="docId" />
        </div>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.insights-sheet-backdrop {
  @apply fixed inset-0 bg-ink-950/40 backdrop-blur-[1px];
  z-index: 49;
}
/* Full-screen side drawer on mobile (matches the chat drawer pattern). Slides
   in from the right and fills the viewport so the user reads insights with the
   same footprint as the editor. */
.insights-sheet {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  width: 100vw;
  background: theme('colors.ink.50');
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.18);
  padding-top: env(safe-area-inset-top, 0);
  padding-bottom: env(safe-area-inset-bottom, 0);
}
html.dark .insights-sheet {
  background: theme('colors.ink.900');
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.45);
}
.insights-sheet-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  flex-shrink: 0;
  border-bottom: 1px solid theme('colors.ink.200' / 60%);
}
html.dark .insights-sheet-header {
  border-bottom-color: theme('colors.ink.800' / 60%);
}
.insights-sheet-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.sheet-title {
  @apply font-serif text-[15px] font-semibold text-ink-900 dark:text-ink-100;
}
.sheet-close {
  @apply inline-flex items-center justify-center h-9 w-9 rounded-md text-ink-500 dark:text-ink-400;
  transition: background 120ms ease, color 120ms ease;
}
.sheet-close:hover {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
}
html.dark .sheet-close:hover {
  background: theme('colors.ink.800');
  color: theme('colors.ink.50');
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 180ms ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
.slide-right-enter-active,
.slide-right-leave-active {
  transition: transform 240ms cubic-bezier(0.2, 0.7, 0.2, 1);
}
.slide-right-enter-from,
.slide-right-leave-to {
  transform: translateX(100%);
}
</style>
