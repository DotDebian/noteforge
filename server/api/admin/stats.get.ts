import { defineEventHandler } from 'h3'
import { getRawDb } from '~/server/database/client'
import { requireAdmin } from '~/server/utils/require-admin'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = getRawDb()

  const usersCount = (db.prepare('SELECT count(*) AS cnt FROM users').get() as { cnt: number }).cnt
  const wsCount = (db.prepare('SELECT count(*) AS cnt FROM workspaces').get() as { cnt: number }).cnt
  const docsCount = (db.prepare('SELECT count(*) AS cnt FROM documents WHERE deleted_at IS NULL').get() as { cnt: number }).cnt
  const foldersCount = (db.prepare('SELECT count(*) AS cnt FROM folders WHERE deleted_at IS NULL').get() as { cnt: number }).cnt
  const chunksCount = (db.prepare('SELECT count(*) AS cnt FROM doc_chunks').get() as { cnt: number }).cnt

  const signupsPerDay = db.prepare(
    `SELECT date(created_at, 'unixepoch') AS day, count(*) AS cnt
     FROM users
     WHERE created_at >= unixepoch('now', '-30 days')
     GROUP BY day ORDER BY day`,
  ).all() as Array<{ day: string, cnt: number }>

  return {
    totals: {
      users: usersCount,
      workspaces: wsCount,
      documents: docsCount,
      folders: foldersCount,
      chunks: chunksCount,
    },
    signupsPerDay: signupsPerDay.map(r => ({ day: r.day, count: r.cnt })),
  }
})
