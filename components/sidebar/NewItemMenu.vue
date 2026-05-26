<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue'
import { useLocale } from '~/composables/useLocale'

const { t } = useLocale()

const emit = defineEmits<{
  (e: 'new-document'): void
  (e: 'new-folder'): void
  (e: 'import-files', files: File[]): void
}>()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

function toggle() { open.value = !open.value }
function close() { open.value = false }

function onDocumentClick(e: MouseEvent) {
  if (!open.value || !rootEl.value) return
  if (!rootEl.value.contains(e.target as Node)) close()
}

if (typeof window !== 'undefined') {
  document.addEventListener('click', onDocumentClick, true)
  onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick, true))
}

function onDoc() { close(); emit('new-document') }
function onFolder() { close(); emit('new-folder') }

function onImport() {
  close()
  fileInput.value?.click()
}

function onFilesPicked(e: Event) {
  const input = e.target as HTMLInputElement
  const files = input.files ? Array.from(input.files) : []
  // Reset so the same file can be picked again right after.
  input.value = ''
  if (files.length > 0) emit('import-files', files)
}
</script>

<template>
  <div ref="rootEl" class="newmenu">
    <button type="button" class="trigger" :title="t('sidebar.new')" :aria-expanded="open" @click.stop="toggle">
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <path d="M8 3v10 M3 8h10" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
      </svg>
    </button>

    <Transition name="pop">
      <div v-if="open" class="popover" role="menu">
        <button type="button" class="item" role="menuitem" @click="onDoc">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M3.5 2h6L13 5.5V14H3.5z M9 2v4h4" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
          </svg>
          <span>{{ t('sidebar.newDocument') }}</span>
        </button>
        <button type="button" class="item" role="menuitem" @click="onFolder">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M2 4.5h4l1.5 1.5H14V13H2z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
          </svg>
          <span>{{ t('sidebar.newFolder') }}</span>
        </button>
        <div class="sep" />
        <button type="button" class="item" role="menuitem" @click="onImport">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
              d="M8 2v8 M5 7l3 3 3-3 M3 13h10"
              fill="none"
              stroke="currentColor"
              stroke-width="1.1"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span>{{ t('sidebar.import') }}</span>
        </button>
      </div>
    </Transition>

    <input
      ref="fileInput"
      type="file"
      multiple
      accept=".md,.markdown,.txt,.pdf,.png,.jpg,.jpeg,.webp,.avif,.gif,application/pdf,image/png,image/jpeg,image/webp,image/avif,image/gif,text/markdown,text/plain"
      class="sr-only"
      @change="onFilesPicked"
    >
  </div>
</template>

<style scoped>
.newmenu { @apply relative; }
.trigger {
  @apply inline-flex items-center justify-center h-6 w-6 rounded text-ink-500 dark:text-ink-400;
  transition: background 120ms ease, color 120ms ease;
}
.trigger:hover {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
}
html.dark .trigger:hover {
  background: theme('colors.ink.800');
  color: theme('colors.ink.50');
}
.popover {
  @apply absolute right-0 z-30 mt-1 min-w-[190px] py-1 rounded;
  background: theme('colors.ink.50');
  border: 1px solid theme('colors.ink.200');
  box-shadow: 0 2px 12px -8px theme('colors.ink.900' / 18%);
}
html.dark .popover {
  background: theme('colors.ink.900');
  border-color: theme('colors.ink.800');
  box-shadow: 0 8px 24px -8px theme('colors.ink.950' / 60%);
}
.item {
  @apply w-full flex items-center gap-2 px-3 h-8 text-[12.5px] text-ink-800 dark:text-ink-200 text-left;
  transition: background 100ms ease;
}
.item:hover {
  background: theme('colors.ink.100' / 70%);
}
html.dark .item:hover {
  background: theme('colors.ink.800' / 60%);
}
.item svg { @apply text-ink-500 dark:text-ink-400; }
.sep { @apply my-1 border-t border-ink-200/70 dark:border-ink-800/70; }

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.pop-enter-from { opacity: 0; transform: translateY(-2px); }
.pop-enter-to { opacity: 1; transform: translateY(0); }
.pop-enter-active { transition: opacity 100ms ease, transform 100ms ease; }
.pop-leave-from { opacity: 1; }
.pop-leave-to { opacity: 0; }
.pop-leave-active { transition: opacity 80ms ease; }
</style>
