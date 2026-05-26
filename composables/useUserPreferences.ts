import { computed, ref } from 'vue'
import type { UserPreferences } from '~/server/database/schema'

/**
 * Per-user preferences (editor / AI / notifications). Loaded once on the
 * first call to `useUserPreferences().load()`, cached in module-level refs
 * so every consumer reads the same reactive copy.
 *
 * Saves are debounced *implicitly* — callers just `await save({ editor: …})`
 * and we PATCH with the sub-object; the server deep-merges so we don't have
 * to send the full preference blob each time.
 */

type EditorPrefs = NonNullable<UserPreferences['editor']>
type AiPrefs = NonNullable<UserPreferences['ai']>
type NotificationPrefs = NonNullable<UserPreferences['notifications']>

interface PatchBody {
  editor?: EditorPrefs
  ai?: AiPrefs
  notifications?: NotificationPrefs
}

const prefs = ref<UserPreferences | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
let loadPromise: Promise<UserPreferences | null> | null = null

const EDITOR_DEFAULTS: Required<Pick<EditorPrefs, 'columnWidth' | 'fontSize' | 'focusModeDefault'>> = {
  columnWidth: 'normal',
  fontSize: 'normal',
  focusModeDefault: false,
}

const AI_DEFAULTS: Required<Pick<AiPrefs, 'chatModel' | 'temperature' | 'disableRewriter' | 'disableReranker'>> = {
  chatModel: 'mistral-small-latest',
  temperature: 0.7,
  disableRewriter: false,
  disableReranker: false,
}

const NOTIFICATION_DEFAULTS: Required<Pick<NotificationPrefs, 'analysisDone' | 'mentionInDoc' | 'weeklyDigest'>> = {
  analysisDone: true,
  mentionInDoc: false,
  weeklyDigest: false,
}

export function useUserPreferences() {
  /** Load (and cache) the current user's preferences. Idempotent. */
  async function load(force = false): Promise<UserPreferences | null> {
    if (prefs.value && !force) return prefs.value
    if (loadPromise && !force) return loadPromise
    loading.value = true
    error.value = null
    loadPromise = (async () => {
      try {
        const res = await $fetch<{ preferences: UserPreferences }>('/api/preferences')
        prefs.value = res.preferences
        return prefs.value
      }
      catch (e) {
        error.value = (e as Error).message
        return null
      }
      finally {
        loading.value = false
        loadPromise = null
      }
    })()
    return loadPromise
  }

  /**
   * Patch one or more preference sections. Optimistically merges into the
   * local ref so consumers see the update immediately; on server error the
   * local copy is reverted to whatever the server returned.
   */
  async function save(body: PatchBody): Promise<void> {
    const before = prefs.value
    if (prefs.value) {
      // Optimistic local merge.
      prefs.value = {
        ...prefs.value,
        editor: body.editor
          ? { ...prefs.value.editor, ...body.editor }
          : prefs.value.editor,
        ai: body.ai ? { ...prefs.value.ai, ...body.ai } : prefs.value.ai,
        notifications: body.notifications
          ? { ...prefs.value.notifications, ...body.notifications }
          : prefs.value.notifications,
        updatedAt: new Date(),
      }
    }
    try {
      const res = await $fetch<{ preferences: UserPreferences }>('/api/preferences', {
        method: 'PATCH',
        body,
      })
      prefs.value = res.preferences
    }
    catch (e) {
      // Roll back.
      if (before) prefs.value = before
      throw e
    }
  }

  /** Resolved editor preferences (always non-null). */
  const editor = computed(() => ({
    ...EDITOR_DEFAULTS,
    ...(prefs.value?.editor ?? {}),
  }))

  /** Resolved AI preferences (always non-null). */
  const ai = computed(() => ({
    ...AI_DEFAULTS,
    ...(prefs.value?.ai ?? {}),
  }))

  /** Resolved notification preferences (always non-null). */
  const notifications = computed(() => ({
    ...NOTIFICATION_DEFAULTS,
    ...(prefs.value?.notifications ?? {}),
  }))

  /**
   * Editor column-width CSS class. Mirrors the editor's existing responsive
   * stack so the 'normal' option is a no-op. Consumers can `:class` this
   * onto their editor wrapper.
   */
  const editorColumnWidthClass = computed(() => {
    switch (editor.value.columnWidth) {
      case 'narrow': return 'max-w-2xl'
      case 'wide': return 'max-w-5xl'
      default: return 'max-w-3xl xl:max-w-4xl 2xl:max-w-6xl'
    }
  })

  const editorFontSizeClass = computed(() => {
    switch (editor.value.fontSize) {
      case 'small': return 'text-sm'
      case 'large': return 'text-lg'
      default: return 'text-base'
    }
  })

  return {
    prefs,
    loading,
    error,
    load,
    save,
    editor,
    ai,
    notifications,
    editorColumnWidthClass,
    editorFontSizeClass,
  }
}
