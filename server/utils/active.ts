import { isNull, type SQL } from 'drizzle-orm'
import { documents, folders } from '~/server/database/schema'

/**
 * Drizzle condition matching documents that have not been soft-deleted.
 * Use in every list endpoint that should hide trashed items.
 *
 * Lookup-by-id endpoints intentionally do NOT use this — they must still
 * return trashed rows so the trash / restore flow works.
 */
export function activeDocsWhere(): SQL {
  return isNull(documents.deletedAt)
}

/**
 * Drizzle condition matching folders that have not been soft-deleted.
 */
export function activeFoldersWhere(): SQL {
  return isNull(folders.deletedAt)
}
