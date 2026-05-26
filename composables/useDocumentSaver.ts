import { ref, type Ref } from 'vue'
import { useDebounceFn } from '@vueuse/core'
import type { Document } from '~/server/database/schema'

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export interface SavePayload {
  markdown?: string
  contentJson?: unknown
  title?: string
}

export interface UseDocumentSaverReturn {
  save: (payload: SavePayload) => void
  flush: (payload: SavePayload) => Promise<void>
  status: Ref<SaveStatus>
  lastSavedAt: Ref<Date | null>
  error: Ref<string | null>
}

/**
 * Debounced document saver. Buffers PATCH bodies for `delay` ms then sends
 * the merged payload to `/api/documents/:id`. Successive `save()` calls
 * within the debounce window are coalesced.
 *
 * Use `flush()` for force-save scenarios (e.g. before navigation away).
 */
export function useDocumentSaver(
  docId: number | Ref<number>,
  delay = 500,
): UseDocumentSaverReturn {
  const status = ref<SaveStatus>('idle')
  const lastSavedAt = ref<Date | null>(null)
  const error = ref<string | null>(null)

  // Pending payload that we accumulate across the debounce window so the
  // latest title/markdown/json all go in a single request.
  let pending: SavePayload = {}

  function resolveId(): number {
    return typeof docId === 'number' ? docId : docId.value
  }

  async function performSave(): Promise<void> {
    if (Object.keys(pending).length === 0) return
    const body = pending
    pending = {}

    status.value = 'saving'
    error.value = null

    try {
      const id = resolveId()
      // Server expects `contentJson` as a string (stored as TEXT).
      const serialized: SavePayload = { ...body }
      if (serialized.contentJson !== undefined && typeof serialized.contentJson !== 'string') {
        serialized.contentJson = JSON.stringify(serialized.contentJson)
      }
      await $fetch<Partial<Document>>(`/api/documents/${id}`, {
        method: 'PATCH',
        body: serialized,
      })
      status.value = 'saved'
      lastSavedAt.value = new Date()
    }
    catch (err) {
      status.value = 'error'
      error.value = err instanceof Error ? err.message : 'Save failed'
    }
  }

  const debouncedSave = useDebounceFn(performSave, delay)

  function save(payload: SavePayload): void {
    pending = { ...pending, ...payload }
    void debouncedSave()
  }

  async function flush(payload: SavePayload = {}): Promise<void> {
    pending = { ...pending, ...payload }
    await performSave()
  }

  return { save, flush, status, lastSavedAt, error }
}
