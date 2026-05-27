/**
 * DELETE /api/admin/trash — hard-purge every soft-deleted document and folder
 * across all workspaces. Audit-logged. Wrapped in a single sqlite transaction
 * so the FK cascade (doc_chunks, doc_analyses, etc.) and both DELETEs commit
 * atomically.
 */
import { defineEventHandler } from 'h3'
import { getRawDb } from '~/server/database/client'
import { requireAdmin } from '~/server/utils/require-admin'
import { logAdminAction } from '~/server/utils/audit'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const db = getRawDb()

  const docCountStmt = db.prepare('SELECT count(*) AS cnt FROM documents WHERE deleted_at IS NOT NULL')
  const folderCountStmt = db.prepare('SELECT count(*) AS cnt FROM folders WHERE deleted_at IS NOT NULL')
  const deleteDocsStmt = db.prepare('DELETE FROM documents WHERE deleted_at IS NOT NULL')
  const deleteFoldersStmt = db.prepare('DELETE FROM folders WHERE deleted_at IS NOT NULL')

  const purge = db.transaction(() => {
    const docsBefore = (docCountStmt.get() as { cnt: number }).cnt
    const foldersBefore = (folderCountStmt.get() as { cnt: number }).cnt
    deleteDocsStmt.run()
    deleteFoldersStmt.run()
    return { docsDeleted: docsBefore, foldersDeleted: foldersBefore }
  })

  const result = purge()

  logAdminAction({
    adminId: admin.id,
    action: 'trash.purge_all',
    payload: { docsDeleted: result.docsDeleted, foldersDeleted: result.foldersDeleted },
  })

  return result
})
