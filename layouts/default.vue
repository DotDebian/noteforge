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
import { useDocInsightsSheet } from '~/composables/useDocInsightsSheet'
import { useDocActionsSheet } from '~/composables/useDocActionsSheet'
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
const insightsSheet = useDocInsightsSheet()
const actionsSheet = useDocActionsSheet()
const { t } = useLocale()

// Show the doc-rail (Insights) topbar button only on a document route. The
// sheet itself is rendered by the doc page, gated on `doc` being loaded, so
// the button just flips the shared ref — the doc page handles the rest.
const isDocRoute = computed(() => route.params.docId != null)

/**
 * Impersonation banner: when an admin uses `POST /api/admin/users/:id/impersonate`
 * the server stamps `originalAdminId` + `impersonating` onto the session. We
 * surface that here as a banner with an exit button. The DEK is intentionally
 * absent in this mode so encrypted content (notes, chunks, chats) renders as
 * ciphertext — the banner explains the limitation implicitly via its presence.
 */
const session = useUserSession()
const impersonationActive = computed(() => Boolean(session.session.value?.originalAdminId))
const impersonationLabel = computed(() => session.user.value?.email ?? '')
const exitingImpersonation = ref(false)
async function exitImpersonation() {
  if (exitingImpersonation.value) return
  exitingImpersonation.value = true
  try {
    const currentId = session.user.value?.id
    const target = currentId ?? 0
    await $fetch(`/api/admin/users/${target}/stop-impersonate`, { method: 'POST' })
    window.location.href = '/admin/users'
  }
  catch {
    exitingImpersonation.value = false
    window.location.reload()
  }
}

// Auto-close the mobile drawer on route change so navigating from a doc
// in the sidebar dismisses the overlay. Same for the insights sheet — its
// open state is module-scoped and would otherwise leak between docs.
watch(() => route.fullPath, () => {
  mobileSidebar.close()
  insightsSheet.close()
  actionsSheet.close()
})

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
    :class="{ 'focus-mode': isFocus, 'mobile-sidebar-open': mobileSidebarOpen, 'impersonating': impersonationActive }"
  >
    <!-- Impersonation banner — pinned to the top of the viewport when the
         admin is currently acting as another user. The DEK isn't available
         in this mode so encrypted content (notes, chunks, chats) renders as
         ciphertext; the banner signals the limitation and offers an exit. -->
    <div v-if="impersonationActive" class="impersonation-banner" role="status" aria-live="polite">
      <span class="impersonation-label">
        Connecté en tant que <strong>{{ impersonationLabel }}</strong> — le contenu chiffré est inaccessible.
      </span>
      <button
        type="button"
        class="impersonation-exit"
        :disabled="exitingImpersonation"
        @click="exitImpersonation"
      >
        {{ exitingImpersonation ? 'Sortie…' : 'Quitter l’impersonation' }}
      </button>
    </div>

    <!-- Mobile top bar: hamburger + title + actions (chat / insights). Visible
         only below md. Hidden in focus mode to keep the writer's view clean —
         the command palette (Ctrl/Cmd+K) is the keyboard escape hatch.
         Chat + insights buttons live here (rather than only as the floating
         FAB / the in-page meta chip) so they stay reachable regardless of
         scroll position or whether the doc has finished loading. -->
    <header v-if="!isFocus" class="mobile-topbar md:hidden">
      <button
        type="button"
        class="mobile-icon-btn"
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
      <!-- Doc actions (favorite / Ask / Share / Export / History / Delete).
           Doc-route only; balances the bar at 2 icons left + 2 right. The
           in-page .doc-header is hidden below md, so this is the entry point. -->
      <button
        v-if="isDocRoute"
        type="button"
        class="mobile-icon-btn"
        :aria-label="t('doc.actions.open')"
        @click="actionsSheet.open()"
      >
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
          <circle cx="3" cy="8" r="1.3" fill="currentColor" />
          <circle cx="8" cy="8" r="1.3" fill="currentColor" />
          <circle cx="13" cy="8" r="1.3" fill="currentColor" />
        </svg>
      </button>
      <div class="mobile-topbar-title">{{ topbarTitle }}</div>
      <button
        v-if="isDocRoute"
        type="button"
        class="mobile-icon-btn"
        :aria-label="t('doc.meta.insightsTitle')"
        @click="insightsSheet.open()"
      >
        <!-- Right sidebar / panel glyph. -->
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
          <rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4" />
          <path d="M10 3v10" fill="none" stroke="currentColor" stroke-width="1.4" />
        </svg>
      </button>
      <button
        v-if="workspaces.current"
        type="button"
        class="mobile-icon-btn"
        :aria-label="t('chat.openTitle')"
        @click="chat.openWithQuestion()"
      >
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
          <path
            d="M3 4h10v6H7l-3 3v-3H3z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
          />
        </svg>
      </button>
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
    <!-- Floating expand button shown when the desktop sidebar is collapsed, so
         the collapsed rail takes zero horizontal space. Desktop only; hidden
         in focus mode (the command palette handles re-entry there). -->
    <Transition name="fade">
      <button
        v-if="collapsed && !isFocus"
        type="button"
        class="sidebar-expand-fab hidden md:inline-flex"
        :title="t('sidebar.expand')"
        :aria-label="t('sidebar.expand')"
        @click="collapsed = false"
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path
            d="M6 4l4 4-4 4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </Transition>
    <!-- Main column is a flex column: the routed content scrolls in the top
         region, and the chat dock (when open) sits at the bottom and pushes
         the content up, VSCode-terminal-style. -->
    <main class="app-main">
      <div class="app-main-content">
        <slot />
      </div>
      <ChatDrawer @open-doc="onOpenDoc" />
    </main>
    <Transition name="focus-pill">
      <div v-if="isFocus" class="focus-pill" role="status" aria-live="polite">
        {{ t('focus.pill') }}
      </div>
    </Transition>
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
    <PwaInstallPrompt />
  </div>
</template>

<style scoped>
.app-shell {
  @apply h-full w-full flex bg-ink-50 dark:bg-ink-950;
}
/* Installed PWA only. On iOS standalone the `height: 100%` chain
   (html→body→#__nuxt→app-shell) resolves to the SMALL viewport (e.g. 873px on
   a Dynamic-Island iPhone) while <body> reports the full screen (932px) — so
   the shell ends ~one safe-inset short and a band of <body> shows at the
   bottom. `100vh` in standalone = the full screen (no browser toolbar to
   over-extend under). Scoped to display-mode:standalone so the in-browser
   behaviour (where 100vh WOULD over-extend) is left untouched. Confirmed on
   device: 100vh removes the band; 100% / 100dvh do not. */
@media (display-mode: standalone) {
  .app-shell { height: 100vh; }
}

/* Impersonation banner — fixed at the top of the viewport so it stays
   visible across the sidebar + main column. The shell stays flex-row; the
   banner overlays. Adds a top padding to `.app-main` via the
   `.impersonating` shell class so content isn't hidden beneath it. */
.impersonation-banner {
  @apply fixed top-0 inset-x-0 z-[60] flex items-center justify-center gap-4 px-4 py-2 text-sm;
  background: theme('colors.accent.600');
  color: theme('colors.ink.50');
  box-shadow: 0 1px 0 theme('colors.accent.700');
}
.impersonation-label { @apply font-sans text-[13px]; }
.impersonation-label strong { @apply font-semibold; }
.impersonation-exit {
  @apply font-sans text-[11px] uppercase tracking-[0.08em] font-semibold px-3 py-1 rounded border;
  background: theme('colors.ink.50' / 10%);
  border-color: theme('colors.ink.50' / 30%);
  color: theme('colors.ink.50');
  transition: background 100ms;
}
.impersonation-exit:hover:not(:disabled) {
  background: theme('colors.ink.50' / 25%);
}
.impersonation-exit:disabled { @apply opacity-60 cursor-not-allowed; }
.app-shell.impersonating { padding-top: 40px; }

.app-main {
  @apply flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden;
}
/* Scroll region for the routed page. Lives above the docked chat panel so the
   panel stays pinned to the bottom of the main column while content scrolls. */
.app-main-content {
  @apply flex-1 min-w-0 min-h-0 overflow-auto;
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
.mobile-icon-btn {
  @apply inline-flex items-center justify-center h-9 w-9 shrink-0 rounded-md text-ink-700 dark:text-ink-200;
  transition: background 120ms ease, color 120ms ease;
}
.mobile-icon-btn:hover {
  background: theme('colors.ink.100');
}
html.dark .mobile-icon-btn:hover {
  background: theme('colors.ink.800');
}
.mobile-topbar-title {
  @apply flex-1 min-w-0 truncate text-center font-serif text-[15px] font-semibold text-ink-900 dark:text-ink-100;
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
/* Below md the topbar exposes the same action, so duplicating it as a FAB
   just clutters the writing area. Placed AFTER the base `.chat-fab` rule so
   `display: none` wins on source order (both have the same specificity). */
@media (max-width: 767px) {
  .chat-fab { display: none; }
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

/* Floating "expand sidebar" button — appears top-left when the desktop
   sidebar is fully collapsed. Square, matching the app's icon-button chrome. */
.sidebar-expand-fab {
  @apply fixed top-3 left-3 inline-flex items-center justify-center h-9 w-9 rounded-md text-ink-600 dark:text-ink-300 bg-ink-50 dark:bg-ink-800;
  border: 1px solid theme('colors.ink.200');
  box-shadow: 0 2px 8px theme('colors.ink.900' / 8%);
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  z-index: 35;
}
html.dark .sidebar-expand-fab {
  border-color: theme('colors.ink.700');
  box-shadow: 0 2px 8px theme('colors.ink.950' / 40%);
}
.sidebar-expand-fab:hover {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
}
html.dark .sidebar-expand-fab:hover {
  background: theme('colors.ink.700');
  color: theme('colors.ink.50');
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 160ms ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
