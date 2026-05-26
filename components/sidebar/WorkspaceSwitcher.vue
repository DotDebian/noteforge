<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue'
import type { Workspace } from '~/server/database/schema'
import { useLocale } from '~/composables/useLocale'

const { t } = useLocale()

const props = defineProps<{
  workspaces: Workspace[]
  current: Workspace | null
}>()

const emit = defineEmits<{
  (e: 'select', id: number): void
  (e: 'create'): void
  (e: 'rename', id: number): void
  (e: 'delete', id: number): void
}>()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)

function toggle() {
  open.value = !open.value
}
function close() {
  open.value = false
}

function onSelect(id: number) {
  close()
  emit('select', id)
}

function onCreate() {
  close()
  emit('create')
}

function onRename(e: Event, id: number) {
  e.stopPropagation()
  close()
  emit('rename', id)
}

function onDelete(e: Event, id: number) {
  e.stopPropagation()
  close()
  emit('delete', id)
}

function onExportCurrent() {
  if (!props.current) return
  close()
  window.location.href = `/api/workspaces/${props.current.id}/export`
}

function onDocumentClick(e: MouseEvent) {
  if (!open.value || !rootEl.value) return
  if (!rootEl.value.contains(e.target as Node)) close()
}

if (typeof window !== 'undefined') {
  document.addEventListener('click', onDocumentClick, true)
  onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick, true))
}
</script>

<template>
  <div ref="rootEl" class="switcher">
    <button
      type="button"
      class="switcher-trigger"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="emoji" v-if="current?.emoji">{{ current.emoji }}</span>
      <span v-else class="emoji-fallback" aria-hidden="true">§</span>
      <span class="name">{{ current?.name ?? t('workspace.menu.noSelection') }}</span>
      <svg viewBox="0 0 16 16" width="11" height="11" class="caret" aria-hidden="true">
        <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <Transition name="pop">
      <div v-if="open" class="menu" role="menu">
        <div class="menu-label">{{ t('workspace.menu.workspaces') }}</div>
        <div
          v-for="ws in props.workspaces"
          :key="ws.id"
          class="menu-row"
          :class="{ 'menu-row--active': ws.id === current?.id }"
        >
          <button
            type="button"
            role="menuitem"
            class="menu-item"
            @click="onSelect(ws.id)"
          >
            <span class="emoji" v-if="ws.emoji">{{ ws.emoji }}</span>
            <span v-else class="emoji-fallback" aria-hidden="true">§</span>
            <span class="name">{{ ws.name }}</span>
          </button>
          <div class="row-actions">
            <button
              type="button"
              class="row-action"
              :title="t('workspace.menu.rename')"
              @click="onRename($event, ws.id)"
            >
              <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                <path d="M11 2l3 3-8 8H3v-3z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              class="row-action row-action--danger"
              :title="t('workspace.menu.delete')"
              @click="onDelete($event, ws.id)"
            >
              <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                <path d="M4 4l8 8 M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
              </svg>
            </button>
          </div>
        </div>

        <div v-if="props.workspaces.length === 0" class="menu-empty">{{ t('workspace.menu.none') }}</div>

        <div class="menu-sep" />
        <button
          v-if="current"
          type="button"
          role="menuitem"
          class="menu-item"
          @click="onExportCurrent"
        >
          <span class="plus" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
              <path d="M8 2v8 M5 7l3 3 3-3 M3 13h10" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
          <span class="name">{{ t('workspace.menu.export') }}</span>
        </button>
        <button type="button" role="menuitem" class="menu-item menu-item--accent" @click="onCreate">
          <span class="plus" aria-hidden="true">+</span>
          <span class="name">{{ t('workspace.menu.new') }}</span>
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.switcher {
  @apply relative;
}

.switcher-trigger {
  @apply w-full flex items-center gap-2 px-2 h-9 rounded text-[13px] text-ink-800 dark:text-ink-200;
  border: 1px solid theme('colors.ink.200' / 70%);
  background: theme('colors.ink.50');
  transition: border-color 120ms ease, background 120ms ease;
}
html.dark .switcher-trigger {
  background: theme('colors.ink.900');
  border-color: theme('colors.ink.800' / 70%);
}
.switcher-trigger:hover {
  border-color: theme('colors.ink.300');
}
html.dark .switcher-trigger:hover {
  border-color: theme('colors.ink.700');
}
.emoji {
  @apply inline-block w-4 text-center text-[13px] leading-none;
}
.emoji-fallback {
  @apply inline-block w-4 text-center font-sans text-[14px] text-ink-400 dark:text-ink-500;
}
.name {
  @apply flex-1 min-w-0 truncate text-left;
}
.caret {
  @apply text-ink-400 dark:text-ink-500;
}

.menu {
  @apply absolute left-0 right-0 z-30 mt-1 py-1 rounded;
  background: theme('colors.ink.50');
  border: 1px solid theme('colors.ink.200');
  box-shadow: 0 2px 12px -8px theme('colors.ink.900' / 18%);
}
html.dark .menu {
  background: theme('colors.ink.900');
  border-color: theme('colors.ink.800');
  box-shadow: 0 8px 24px -8px theme('colors.ink.950' / 60%);
}
.menu-label {
  @apply label-mono px-3 pt-1 pb-1.5;
}
.menu-row {
  @apply relative flex items-center;
  transition: background 100ms ease;
}
.menu-row:hover {
  background: theme('colors.ink.100' / 70%);
}
html.dark .menu-row:hover {
  background: theme('colors.ink.800' / 60%);
}
.menu-row--active {
  background: theme('colors.ink.100' / 60%);
}
html.dark .menu-row--active {
  background: theme('colors.ink.800' / 60%);
}
.menu-row--active .menu-item { color: theme('colors.ink.900'); }
html.dark .menu-row--active .menu-item { color: theme('colors.ink.100'); }

.menu-item {
  @apply flex-1 min-w-0 flex items-center gap-2 px-3 h-8 text-[13px] text-ink-800 dark:text-ink-200 text-left;
}
.menu-item--accent {
  @apply w-full;
  color: theme('colors.accent.700');
  transition: background 100ms ease;
}
.menu-item--accent:hover {
  background: theme('colors.ink.100' / 70%);
}
html.dark .menu-item--accent {
  color: theme('colors.accent.300');
}
html.dark .menu-item--accent:hover {
  background: theme('colors.ink.800' / 60%);
}

.row-actions {
  @apply flex items-center gap-0.5 pr-2 opacity-0;
  transition: opacity 100ms ease;
}
.menu-row:hover .row-actions { @apply opacity-100; }
.row-action {
  @apply inline-flex items-center justify-center h-5 w-5 rounded text-ink-500 dark:text-ink-400;
  transition: background 100ms ease, color 100ms ease;
}
.row-action:hover {
  background: theme('colors.ink.200' / 70%);
  color: theme('colors.ink.900');
}
html.dark .row-action:hover {
  background: theme('colors.ink.700' / 70%);
  color: theme('colors.ink.50');
}
.row-action--danger:hover {
  color: theme('colors.accent.700');
}
html.dark .row-action--danger:hover {
  color: theme('colors.accent.300');
}
.menu-empty {
  @apply px-3 py-2 text-[12px] text-ink-400 dark:text-ink-500;
}
.menu-sep {
  @apply my-1 border-t border-ink-200/70 dark:border-ink-800/70;
}
.plus {
  @apply inline-block w-4 text-center font-sans text-[16px] leading-none text-accent-500;
}

.pop-enter-from { opacity: 0; transform: translateY(-2px); }
.pop-enter-to { opacity: 1; transform: translateY(0); }
.pop-enter-active { transition: opacity 100ms ease, transform 100ms ease; }
.pop-leave-from { opacity: 1; }
.pop-leave-to { opacity: 0; }
.pop-leave-active { transition: opacity 80ms ease; }
</style>
