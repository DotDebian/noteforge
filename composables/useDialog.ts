import {
  useDialogStore,
  type AlertOptions,
  type ConfirmOptions,
  type PromptOptions,
} from '~/stores/dialog'

/**
 * Custom-modal replacements for `window.confirm` / `window.prompt` /
 * `window.alert`. Promise-based, themed, dark-mode aware.
 *
 * Safe to call from outside `setup()` (e.g. Tiptap extension callbacks) —
 * the underlying Pinia store is grabbed lazily.
 */
export function useDialog() {
  const store = useDialogStore()
  return {
    confirm: (opts: ConfirmOptions): Promise<boolean> => store.confirm(opts),
    prompt: (opts: PromptOptions): Promise<string | null> => store.prompt(opts),
    alert: (opts: AlertOptions): Promise<void> => store.alert(opts),
  }
}
