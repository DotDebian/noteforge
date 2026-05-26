<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useChatStore } from '~/stores/chat'
import { useWorkspacesStore } from '~/stores/workspaces'
import { useTreeStore } from '~/stores/tree'
import { useDialogStore } from '~/stores/dialog'
import { usePaletteStore } from '~/stores/palette'
import { useIsMac, hasPrimaryModifier } from '~/composables/usePlatform'
import { useFocusMode } from '~/composables/useFocusMode'
import { useMobileSidebar } from '~/composables/useMobileSidebar'
import { useLocale } from '~/composables/useLocale'

const collapsed = ref(false)
const chat = useChatStore()
const workspaces = useWorkspacesStore()
const treeStore = useTreeStore()
const dialogStore = useDialogStore()
const palette = usePaletteStore()
const router = useRouter()
const route = useRoute()
const isMac = useIsMac()
const { creating } = storeToRefs(workspaces)
const { isFocus, toggle: toggleFocus, disable: disableFocus } = useFocusMode()
const mobileSidebar = useMobileSidebar()
const { isOpen: mobileSidebarOpen } = mobileSidebar
const { t } = useLocale()

// Auto-close the mobile drawer on route change so navigating from a doc
// in the sidebar dismisses the overlay.
watch(() => route.fullPath, () => mobileSidebar.close())

// Mobile topbar title — workspace name when no doc is open, otherwise the
// current doc title held in the tree store / palette recents.
const topbarTitle = computed(() => {
  const docIdParam = route.params.docId
  if (docIdParam != null) {
    const id = Number(docIdParam)
    const found = treeStore.documents.find(d => d.id === id)
    return found?.title || t('doc.untitled')
  }
  return workspaces.current?.name || 'NoteForge'
})

function onOpenDoc(docId: number) {
  const wsId = workspaces.current?.id
  if (wsId) router.push(`/w/${wsId}/d/${docId}`)
}

/**
 * New-document shortcut. macOS uses ⌘+N (browsers let preventDefault win).
 * Windows/Linux use Ctrl+Alt+N — Ctrl+N alone is hard-reserved by Chromium
 * for "new window" and can't be intercepted from a page.
 */
let creatingDoc = false
async function onGlobalKeydown(e: KeyboardEvent) {
  // Ctrl/Cmd+K opens the command palette (and Esc inside it closes — that
  // logic lives in CommandPalette.vue's own keydown handler).
  if ((e.key === 'k' || e.key === 'K') && hasPrimaryModifier(e) && !e.altKey && !e.shiftKey) {
    if (dialogStore.open) return
    e.preventDefault()
    palette.toggle()
    return
  }

  // Sprint 5 / I10 — Ctrl+. / Cmd+. toggles focus mode. Esc exits focus mode
  // ONLY when no other modal/drawer/palette is open and nothing earlier in
  // the bubbling chain consumed the event (defaultPrevented). This keeps Esc
  // closing palettes/dialogs/etc. with higher priority.
  if (e.key === '.' && hasPrimaryModifier(e) && !e.altKey && !e.shiftKey) {
    e.preventDefault()
    toggleFocus()
    return
  }
  if (e.key === 'Escape' && isFocus.value) {
    if (e.defaultPrevented) return
    if (dialogStore.open || palette.isOpen || chat.open || creating.value) return
    e.preventDefault()
    disableFocus()
    return
  }

  if (e.key !== 'n' && e.key !== 'N') return
  const match = isMac.value
    ? e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
    : e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey
  if (!match) return

  const ws = workspaces.current
  if (!ws) return
  if (creating.value || dialogStore.open || palette.isOpen || creatingDoc) return

  e.preventDefault()
  creatingDoc = true
  try {
    const doc = await treeStore.createDocument({ folderId: null })
    await router.push(`/w/${ws.id}/d/${doc.id}`)
  } finally {
    creatingDoc = false
  }
}

onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown))
</script>

<template>
  <div
    class="app-shell"
    :class="{ 'focus-mode': isFocus, 'mobile-sidebar-open': mobileSidebarOpen }"
  >
    <!-- Mobile top bar: hamburger + title. Visible only below md. Hidden in
         focus mode to keep the writer's view clean — the command palette
         (Ctrl/Cmd+K) is the keyboard escape hatch. -->
    <header v-if="!isFocus" class="mobile-topbar md:hidden">
      <button
        type="button"
        class="mobile-hamburger"
        :aria-label="t('sidebar.openNavigation')"
        @click="mobileSidebar.toggle()"
      >
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
          <path
            d="M2 4h12 M2 8h12 M2 12h12"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
      </button>
      <div class="mobile-topbar-title">{{ topbarTitle }}</div>
      <span class="mobile-topbar-spacer" aria-hidden="true" />
    </header>

    <!-- Backdrop behind the mobile sidebar. Click to dismiss. -->
    <Transition name="fade">
      <div
        v-if="mobileSidebarOpen"
        class="mobile-sidebar-backdrop md:hidden"
        aria-hidden="true"
        @click="mobileSidebar.close()"
      />
    </Transition>

    <AppSidebar :collapsed="collapsed" @toggle="collapsed = !collapsed" @close-mobile="mobileSidebar.close()" />
    <main class="app-main">
      <slot />
    </main>
    <Transition name="focus-pill">
      <div v-if="isFocus" class="focus-pill" role="status" aria-live="polite">
        {{ t('focus.pill') }}
      </div>
    </Transition>
    <ChatDrawer @open-doc="onOpenDoc" />
    <button
      v-if="workspaces.current && !chat.open"
      type="button"
      class="chat-fab"
      :title="t('chat.openTitle')"
      @click="chat.openWithQuestion()"
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path
          d="M3 4h10v6H7l-3 3v-3H3z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linejoin="round"
        />
      </svg>
      <span class="chat-fab-label">{{ t('chat.fab') }}</span>
    </button>
    <NewWorkspaceModal :open="creating" @close="workspaces.closeCreate()" />
    <CommandPalette />
    <DialogHost />
  </div>
</template>

<style scoped>
.app-shell {
  @apply h-full w-full flex bg-ink-50 dark:bg-ink-950;
}

.app-main {
  @apply flex-1 min-w-0 overflow-auto;
}

/* --------------------------------------------------------------------------
   Mobile topbar (Sprint 5 / F10).

   Visible only below md. Sits as the first row above the main column.
   Below md the shell becomes a column-flex (see global rule in main.css).
   The hamburger min tap target is 36px. The title is centered with a
   matching-width spacer on the right to balance the row.
   -------------------------------------------------------------------------- */
.mobile-topbar {
  @apply flex items-center gap-2 px-3 shrink-0 bg-ink-50 dark:bg-ink-950 border-b border-ink-200/60;
  /* h-12 + safe-area inset, in box-sizing: border-box; min-height keeps the
     row tall enough on notched devices without compressing the icons. */
  min-height: calc(3rem + env(safe-area-inset-top, 0));
  padding-top: env(safe-area-inset-top, 0);
  z-index: 25;
}
/* `md:hidden` in the template is shadowed by `@apply flex` above because
   scoped <style> is injected after Tailwind's utilities layer. Enforce the
   hide above the md breakpoint in scoped CSS itself. */
@media (min-width: 768px) {
  .mobile-topbar { display: none; }
}
html.dark .mobile-topbar {
  border-bottom-color: theme('colors.ink.800' / 60%);
}
.mobile-hamburger {
  @apply inline-flex items-center justify-center h-9 w-9 rounded-md text-ink-700 dark:text-ink-200;
  transition: background 120ms ease, color 120ms ease;
}
.mobile-hamburger:hover {
  background: theme('colors.ink.100');
}
html.dark .mobile-hamburger:hover {
  background: theme('colors.ink.800');
}
.mobile-topbar-title {
  @apply flex-1 min-w-0 truncate text-center font-serif text-[15px] font-semibold text-ink-900 dark:text-ink-100;
}
.mobile-topbar-spacer {
  @apply inline-block h-9 w-9 shrink-0;
}

.mobile-sidebar-backdrop {
  @apply fixed inset-0 bg-ink-950/40 backdrop-blur-[1px];
  z-index: 45;
}

.chat-fab {
  @apply fixed bottom-5 right-5 inline-flex items-center gap-2 px-3.5 py-2 rounded-full;
  @apply font-sans uppercase text-[11px] font-semibold tracking-[0.08em] text-ink-700 dark:text-ink-200 bg-ink-50 dark:bg-ink-800;
  border: 1px solid theme('colors.ink.200');
  box-shadow: 0 2px 8px theme('colors.ink.900' / 8%);
  transition: background 120ms ease, color 120ms ease, transform 120ms ease, border-color 120ms ease;
  z-index: 30;
  /* Lift above the iOS home indicator on devices with safe-area insets. */
  bottom: calc(1.25rem + env(safe-area-inset-bottom, 0));
}
html.dark .chat-fab {
  border-color: theme('colors.ink.800');
  box-shadow: 0 2px 8px theme('colors.ink.950' / 40%);
}
.chat-fab:hover {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
  transform: translateY(-1px);
}
html.dark .chat-fab:hover {
  background: theme('colors.accent.600');
  color: theme('colors.ink.50');
  border-color: theme('colors.accent.600');
}
.chat-fab-label {
  @apply leading-none;
}

/* Focus-mode pill (I10) — small confirmation chip near the bottom-right.
   Visibility is driven by the v-if; the Transition handles fade. The chip
   itself stays visible while focus mode is on so the user always sees how
   to exit. Sits in the same corner the FAB normally would (the FAB is
   hidden in focus mode by the global .focus-mode rule). */
.focus-pill {
  @apply fixed bottom-5 right-5 inline-flex items-center px-3.5 py-2 rounded-full font-sans uppercase text-[11px] font-semibold tracking-[0.08em] text-ink-700 dark:text-ink-200 bg-ink-50 dark:bg-ink-800;
  border: 1px solid theme('colors.ink.200');
  box-shadow: 0 2px 8px theme('colors.ink.900' / 8%);
  z-index: 40;
  pointer-events: none;
  bottom: calc(1.25rem + env(safe-area-inset-bottom, 0));
}
html.dark .focus-pill {
  border-color: theme('colors.ink.800');
  box-shadow: 0 2px 8px theme('colors.ink.950' / 40%);
}
.focus-pill-enter-active,
.focus-pill-leave-active {
  transition: opacity 200ms ease, transform 200ms ease;
}
.focus-pill-enter-from,
.focus-pill-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
