<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { useLocale } from '~/composables/useLocale'

const { t } = useLocale()

/**
 * Mobile bottom sheet that carries the document header's meta + actions
 * (edited time, favorite, Ask / Share / Export / History / Delete). The
 * in-page `.doc-header` is hidden below md to reclaim vertical space; this
 * sheet surfaces the same controls from a topbar button.
 *
 * State (favorites, share/history dialogs, delete confirm, export) lives in
 * the doc page — this component is purely presentational and emits intent.
 */
const props = defineProps<{
  isOpen: boolean
  title: string
  editedLabel: string | null
  isFavorited: boolean
  hasActiveShares: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'toggle-favorite'): void
  (e: 'ask'): void
  (e: 'share'): void
  (e: 'history'): void
  (e: 'delete'): void
  (e: 'export', format: 'html' | 'pdf' | 'docx' | 'md'): void
}>()

// Each action closes the sheet first so the resulting dialog/drawer (share,
// history, chat) isn't stacked behind it. Dispatch is explicit per branch so
// the typed-emit overloads resolve.
function run(action: 'ask' | 'share' | 'history' | 'delete') {
  emit('close')
  if (action === 'ask') emit('ask')
  else if (action === 'share') emit('share')
  else if (action === 'history') emit('history')
  else emit('delete')
}
function runExport(format: 'html' | 'pdf' | 'docx' | 'md') {
  emit('close')
  emit('export', format)
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
    document.body.style.overflow = open ? 'hidden' : ''
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
        class="actions-sheet-backdrop"
        aria-hidden="true"
        @click="emit('close')"
      />
    </Transition>
    <Transition name="slide-up">
      <section
        v-if="isOpen"
        class="mobile-sheet actions-sheet"
        role="dialog"
        :aria-label="t('doc.actions.title')"
      >
        <div class="mobile-sheet-handle" aria-hidden="true" />
        <header class="mobile-sheet-header">
          <h2 class="sheet-title">{{ title || t('doc.actions.title') }}</h2>
          <button
            type="button"
            class="sheet-close"
            :aria-label="t('chat.close')"
            @click="emit('close')"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M4 4l8 8 M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </button>
        </header>

        <div class="mobile-sheet-body">
          <!-- Meta row: edited time + favorite toggle -->
          <div class="meta-row">
            <span v-if="editedLabel" class="edited">{{ editedLabel }}</span>
            <span v-else class="edited" />
            <button
              type="button"
              class="star"
              :class="{ 'star--on': isFavorited }"
              :aria-pressed="isFavorited"
              :title="isFavorited ? t('doc.meta.starOn') : t('doc.meta.starOff')"
              @click="emit('toggle-favorite')"
            >
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" :fill="isFavorited ? 'currentColor' : 'none'">
                <path
                  d="M8 1.8l1.85 3.96 4.35.55-3.2 2.99.83 4.3L8 11.6 4.17 13.6l.83-4.3-3.2-2.99 4.35-.55L8 1.8z"
                  stroke="currentColor"
                  stroke-width="1.25"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
          </div>

          <!-- Primary actions -->
          <nav class="action-list">
            <button type="button" class="action-row" @click="run('ask')">
              <svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true">
                <path d="M3 4h10v6H7l-3 3v-3H3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
              </svg>
              <span>{{ t('doc.meta.ask') }}</span>
            </button>
            <button type="button" class="action-row" @click="run('share')">
              <svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true">
                <circle cx="12" cy="3.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.3" />
                <circle cx="4" cy="8" r="1.8" fill="none" stroke="currentColor" stroke-width="1.3" />
                <circle cx="12" cy="12.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.3" />
                <path d="M5.6 7.1l4.8-2.7 M5.6 8.9l4.8 2.7" fill="none" stroke="currentColor" stroke-width="1.3" />
              </svg>
              <span>{{ t('doc.meta.share') }}</span>
              <span v-if="hasActiveShares" class="share-dot" aria-hidden="true" />
            </button>
            <button type="button" class="action-row" @click="run('history')">
              <svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true">
                <path d="M8 4v4l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                <path d="M2.5 8a5.5 5.5 0 1 0 1.7-3.97 M2.4 3v2.3h2.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span>{{ t('doc.meta.history') }}</span>
            </button>
            <button type="button" class="action-row action-row--danger" @click="run('delete')">
              <svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true">
                <path d="M3 4.5h10 M5.5 4.5V3h5v1.5 M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span>{{ t('doc.meta.delete') }}</span>
            </button>
          </nav>

          <!-- Export formats -->
          <div class="export-section">
            <span class="export-label">{{ t('doc.actions.exportSection') }}</span>
            <div class="export-grid">
              <button type="button" class="export-chip" @click="runExport('md')">Markdown</button>
              <button type="button" class="export-chip" @click="runExport('html')">HTML</button>
              <button type="button" class="export-chip" @click="runExport('pdf')">PDF</button>
              <button type="button" class="export-chip" @click="runExport('docx')">Word</button>
            </div>
          </div>
        </div>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.actions-sheet-backdrop {
  @apply fixed inset-0 bg-ink-950/40 backdrop-blur-[1px];
  z-index: 49;
}
/* The `.mobile-sheet` shell (handle / header / body, slide-up positioning) is
   defined globally in main.css. */
.sheet-title {
  @apply font-serif text-[15px] font-semibold text-ink-900 dark:text-ink-100 truncate;
}
.sheet-close {
  @apply inline-flex items-center justify-center h-9 w-9 shrink-0 rounded-md text-ink-500 dark:text-ink-400;
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

.meta-row {
  @apply flex items-center justify-between px-4 py-3 border-b border-ink-200/60;
}
html.dark .meta-row {
  border-bottom-color: theme('colors.ink.800' / 60%);
}
.edited {
  @apply font-sans uppercase text-[11px] font-semibold tracking-[0.08em] text-ink-500 dark:text-ink-400;
}
.star {
  @apply inline-flex items-center justify-center h-9 w-9 rounded-md text-ink-500 dark:text-ink-400;
  transition: background 120ms ease, color 120ms ease;
}
.star:hover {
  background: theme('colors.ink.100');
  color: theme('colors.accent.600');
}
html.dark .star:hover {
  background: theme('colors.ink.800');
  color: theme('colors.accent.300');
}
.star--on,
.star--on:hover {
  color: theme('colors.accent.500');
}
html.dark .star--on,
html.dark .star--on:hover {
  color: theme('colors.accent.400');
}

.action-list {
  @apply flex flex-col py-1;
}
.action-row {
  @apply flex items-center gap-3 w-full px-4 py-3 text-left text-[14px] text-ink-800 dark:text-ink-100;
  transition: background 120ms ease, color 120ms ease;
}
.action-row svg {
  @apply shrink-0 text-ink-500 dark:text-ink-400;
}
.action-row:hover {
  background: theme('colors.ink.100' / 70%);
}
html.dark .action-row:hover {
  background: theme('colors.ink.800' / 60%);
}
.action-row--danger {
  color: theme('colors.rose.600');
}
.action-row--danger svg {
  color: theme('colors.rose.500');
}
html.dark .action-row--danger {
  color: theme('colors.rose.400');
}
html.dark .action-row--danger svg {
  color: theme('colors.rose.400');
}
.share-dot {
  @apply inline-block h-1.5 w-1.5 rounded-full bg-accent-500;
}

.export-section {
  @apply px-4 py-4 border-t border-ink-200/60;
}
html.dark .export-section {
  border-top-color: theme('colors.ink.800' / 60%);
}
.export-label {
  @apply block font-sans uppercase text-[11px] font-semibold tracking-[0.08em] text-ink-500 dark:text-ink-400 mb-2.5;
}
.export-grid {
  @apply grid grid-cols-2 gap-2;
}
.export-chip {
  @apply inline-flex items-center justify-center px-3 py-2.5 rounded-md border text-[13px] font-medium text-ink-700 dark:text-ink-200;
  border-color: theme('colors.ink.200');
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
html.dark .export-chip {
  border-color: theme('colors.ink.700');
}
.export-chip:hover {
  background: theme('colors.ink.100');
  color: theme('colors.accent.700');
  border-color: theme('colors.ink.300');
}
html.dark .export-chip:hover {
  background: theme('colors.ink.800');
  color: theme('colors.accent.300');
  border-color: theme('colors.ink.600');
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 180ms ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
.slide-up-enter-active,
.slide-up-leave-active {
  transition: transform 240ms cubic-bezier(0.2, 0.7, 0.2, 1);
}
.slide-up-enter-from,
.slide-up-leave-to {
  transform: translateY(100%);
}
</style>
