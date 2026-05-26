import { useStorage } from '@vueuse/core'

/**
 * Focus mode (Sprint 5 / I10): hides the sidebar, document rail and chat FAB
 * so the writer can concentrate on the editor canvas. Toggled with Ctrl+. /
 * Cmd+. (wired in `layouts/default.vue`) and persisted in localStorage under
 * `noteforge-focus-mode` so the preference survives reloads.
 */
export function useFocusMode() {
  const isFocus = useStorage<boolean>('noteforge-focus-mode', false)

  function toggle(): void {
    isFocus.value = !isFocus.value
  }
  function enable(): void {
    isFocus.value = true
  }
  function disable(): void {
    isFocus.value = false
  }

  return { isFocus, toggle, enable, disable }
}
