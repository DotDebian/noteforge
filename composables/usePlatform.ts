/**
 * Detect whether the client runs on macOS, so callers can pick the right
 * modifier (⌘ vs Ctrl) for keyboard hints and shortcut handlers.
 *
 * SSR-safe: returns `false` on the server; the real value resolves on mount.
 */
export function useIsMac() {
  const isMac = ref(false)

  onMounted(() => {
    if (typeof navigator === 'undefined') return
    const ua = navigator.userAgent
    const platform =
      // @ts-expect-error — userAgentData is not yet in lib.dom
      (navigator.userAgentData?.platform as string | undefined) ?? navigator.platform ?? ''
    isMac.value = /Mac|iPhone|iPad|iPod/.test(platform) || /Macintosh/.test(ua)
  })

  return isMac
}

/** Modifier-key label for keyboard hints. */
export function useModKeyLabel() {
  const isMac = useIsMac()
  return computed(() => (isMac.value ? '⌘' : 'Ctrl'))
}

/**
 * Sequence of kbd labels for the "new document" shortcut on the current
 * platform: `['⌘', 'N']` on macOS, `['Ctrl', 'Alt', 'N']` on Win/Linux.
 */
export function useNewDocShortcut() {
  const isMac = useIsMac()
  return computed(() => (isMac.value ? ['⌘', 'N'] : ['Ctrl', 'Alt', 'N']))
}

/** True when the active keyboard event uses the platform's primary modifier. */
export function hasPrimaryModifier(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey
}
