/**
 * Lightweight job-tracking table. Callers use `createJob` to register a
 * long-running task (embed, reindex, retention purge, …), then call
 * `complete()` / `fail()` on the returned handle when done.
 *
 * Unlike the fire-and-forget log helpers, `createJob` returns a real handle
 * the caller may await — the row must exist before the work starts so the
 * admin panel can show "running" status. `complete` / `fail` updates are
 * best-effort: errors are swallowed so a logging failure never breaks the
 * underlying job.
 */
import { eq } from 'drizzle-orm'
import { useDb } from '~/server/database/client'
import { jobs } from '~/server/database/schema'

export interface JobHandle {
  id: number
  complete(durationMs?: number): Promise<void>
  fail(error: Error | string): Promise<void>
}

export async function createJob(opts: {
  type: string
  payload?: Record<string, unknown>
  userId?: number
}): Promise<JobHandle> {
  const startedAt = new Date()
  const db = useDb()
  const [row] = await db
    .insert(jobs)
    .values({
      type: opts.type,
      status: 'running',
      payload: opts.payload ?? null,
      userId: opts.userId ?? null,
      startedAt,
    })
    .returning({ id: jobs.id })

  if (!row) throw new Error('jobs.create: insert returned no row')
  const id = row.id
  const startedMs = startedAt.getTime()

  return {
    id,
    async complete(durationMs?: number): Promise<void> {
      try {
        const finishedAt = new Date()
        const computedMs = durationMs ?? finishedAt.getTime() - startedMs
        await useDb()
          .update(jobs)
          .set({
            status: 'completed',
            completedAt: finishedAt,
            durationMs: computedMs,
          })
          .where(eq(jobs.id, id))
      }
      catch { /* swallow */ }
    },
    async fail(error: Error | string): Promise<void> {
      try {
        const finishedAt = new Date()
        const computedMs = finishedAt.getTime() - startedMs
        const message = typeof error === 'string' ? error : (error.message ?? 'unknown error')
        await useDb()
          .update(jobs)
          .set({
            status: 'failed',
            completedAt: finishedAt,
            durationMs: computedMs,
            errorMessage: message.slice(0, 4000),
          })
          .where(eq(jobs.id, id))
      }
      catch { /* swallow */ }
    },
  }
}
