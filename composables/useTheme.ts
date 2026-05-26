import { useDark, useToggle } from '@vueuse/core'

/**
 * Persists the user's theme preference in localStorage under `noteforge-theme`
 * and applies the `dark` class to <html>. Reactive `isDark` and a toggle.
 */
export function useTheme() {
  const isDark = useDark({
    storageKey: 'noteforge-theme',
    valueDark: 'dark',
    valueLight: '',
    selector: 'html',
    attribute: 'class',
  })
  const toggle = useToggle(isDark)
  return { isDark, toggle }
}
