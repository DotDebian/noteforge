import { ref } from 'vue'

/**
 * Sprint 5 / F10 — mobile sidebar drawer state.
 *
 * Module-scoped ref so the layout, sidebar and any future trigger share the
 * same instance. No persistence: the drawer always starts closed on page
 * load (matches expected mobile-app behavior — closed by default after a
 * fresh open / refresh).
 */
const isOpen = ref(false)

export function useMobileSidebar() {
  function open(): void {
    isOpen.value = true
  }
  function close(): void {
    isOpen.value = false
  }
  function toggle(): void {
    isOpen.value = !isOpen.value
  }
  return { isOpen, open, close, toggle }
}
