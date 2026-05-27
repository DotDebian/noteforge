/**
 * Decryption-failure log. Surfaces tampered ciphertext / wrong-key bugs
 * to the admin observability surface without blocking the read path.
 *
 * Fire-and-forget.
 */
import { useDb } from '~/server/database/client'
import { decryptionFailures } from '~/server/database/schema'

export function logDecryptionFailure(opts: {
  userId?: number
  entityType: string
  entityId?: number
  field: string
  errorMessage?: string
}): void {
  void Promise.resolve().then(async () => {
    try {
      await useDb().insert(decryptionFailures).values({
        userId: opts.userId ?? null,
        entityType: opts.entityType,
        entityId: opts.entityId ?? null,
        field: opts.field,
        errorMessage: opts.errorMessage ?? null,
      })
    }
    catch { /* swallow */ }
  })
}
