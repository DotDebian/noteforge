import { acceptHMRUpdate, defineStore } from 'pinia'

export type DialogKind = 'confirm' | 'prompt' | 'alert'

export interface PromptOptions {
  title: string
  message?: string
  defaultValue?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
  multiline?: boolean
}

export interface ConfirmOptions {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

export interface AlertOptions {
  title: string
  message?: string
  confirmLabel?: string
}

export interface DialogState {
  open: boolean
  kind: DialogKind
  title: string
  message: string
  defaultValue: string
  placeholder: string
  confirmLabel: string
  cancelLabel: string
  destructive: boolean
  multiline: boolean
}

type Resolver = (value: unknown) => void

const initialState: DialogState = {
  open: false,
  kind: 'confirm',
  title: '',
  message: '',
  defaultValue: '',
  placeholder: '',
  confirmLabel: 'Confirm',
  cancelLabel: 'Cancel',
  destructive: false,
  multiline: false,
}

export const useDialogStore = defineStore('dialog', {
  state: (): DialogState & { _resolver: Resolver | null } => ({
    ...initialState,
    _resolver: null,
  }),

  actions: {
    /** Resolve `true` on confirm, `false` on cancel. */
    confirm(opts: ConfirmOptions): Promise<boolean> {
      this._cancelPrevious(false)
      return new Promise<boolean>((resolve) => {
        Object.assign(this, {
          ...initialState,
          open: true,
          kind: 'confirm' as DialogKind,
          title: opts.title,
          message: opts.message ?? '',
          confirmLabel: opts.confirmLabel ?? 'Confirm',
          cancelLabel: opts.cancelLabel ?? 'Cancel',
          destructive: opts.destructive ?? false,
        })
        this._resolver = resolve as Resolver
      })
    },

    /** Resolve the trimmed string on confirm (may be empty), or `null` on cancel. */
    prompt(opts: PromptOptions): Promise<string | null> {
      this._cancelPrevious(null)
      return new Promise<string | null>((resolve) => {
        Object.assign(this, {
          ...initialState,
          open: true,
          kind: 'prompt' as DialogKind,
          title: opts.title,
          message: opts.message ?? '',
          defaultValue: opts.defaultValue ?? '',
          placeholder: opts.placeholder ?? '',
          confirmLabel: opts.confirmLabel ?? 'OK',
          cancelLabel: opts.cancelLabel ?? 'Cancel',
          multiline: opts.multiline ?? false,
        })
        this._resolver = resolve as Resolver
      })
    },

    /** Resolves `void` once acknowledged. */
    alert(opts: AlertOptions): Promise<void> {
      this._cancelPrevious(undefined)
      return new Promise<void>((resolve) => {
        Object.assign(this, {
          ...initialState,
          open: true,
          kind: 'alert' as DialogKind,
          title: opts.title,
          message: opts.message ?? '',
          confirmLabel: opts.confirmLabel ?? 'OK',
        })
        this._resolver = (() => resolve()) as Resolver
      })
    },

    /** Called by `DialogHost` when the user clicks the confirm button. */
    resolve(value: unknown) {
      const r = this._resolver
      this._resolver = null
      this.open = false
      if (r) r(value)
    },

    /** Called by `DialogHost` when the user cancels (X / Esc / backdrop). */
    cancel() {
      // For confirm → false, for prompt → null, for alert → undefined.
      const cancelValue =
        this.kind === 'confirm' ? false : this.kind === 'prompt' ? null : undefined
      this.resolve(cancelValue)
    },

    _cancelPrevious(cancelValue: unknown) {
      if (this._resolver) {
        const r = this._resolver
        this._resolver = null
        r(cancelValue)
      }
    },
  },
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useDialogStore, import.meta.hot))
}
