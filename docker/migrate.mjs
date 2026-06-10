/**
 * Standalone migration runner for the Docker runtime image.
 *
 * Why this is NOT `drizzle-orm`'s built-in migrator: that migrator decides what
 * to apply by comparing each journal entry's `when` timestamp against the
 * latest `created_at` already in `__drizzle_migrations`. Our journal has a few
 * hand-edited / future-dated `when` values (e.g. 0022/0023 sit in the future),
 * so a freshly generated migration whose real timestamp is SMALLER than that
 * max gets silently skipped on an existing DB — which is exactly how a deploy
 * ended up serving against a `chat_messages` table missing the `followups`
 * column even though the entrypoint logged "migrations applied".
 *
 * This runner instead applies migrations by **content hash, in journal order**:
 * for each `.sql` file we compute the same `sha256(fileContents)` that drizzle
 * stores, and run it only if that hash isn't already recorded. Timestamps are
 * irrelevant, so a non-monotonic journal can never make us skip a pending
 * migration. It stays bookkeeping-compatible with drizzle's own migrator
 * (same `__drizzle_migrations` table, same hash scheme), so a DB previously
 * migrated by drizzle is recognised correctly and only the truly-pending files
 * run.
 *
 * It opens the SQLite file pointed at by $DATABASE_URL (defaulting to
 * /app/data/noteforge.db) and reads the SQL files from $MIGRATIONS_DIR.
 *
 * Failure is fatal: if migrations can't run we exit non-zero so the container
 * restarts loudly rather than serving against an out-of-date schema.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'

const dbPath = resolve(process.env.DATABASE_URL || '/app/data/noteforge.db')
const migrationsFolder = process.env.MIGRATIONS_DIR || '/app/server/database/migrations'

const dir = dirname(dbPath)
if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

const sqlite = new Database(dbPath)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')

// Load sqlite-vec so migration 0004 (CREATE VIRTUAL TABLE ... USING vec0) can
// run on a fresh DB. The runtime connection in server/database/client.ts does
// the same; without it that migration aborts with "no such module: vec0".
try {
  sqliteVec.load(sqlite)
}
catch (err) {
  console.error('[noteforge] failed to load sqlite-vec extension:', err)
  sqlite.close()
  process.exit(1)
}

try {
  // Read the journal so we apply migrations in authored order (by idx), not by
  // the (potentially non-monotonic) `when` timestamp.
  const journalPath = join(migrationsFolder, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
  const entries = [...(journal.entries ?? [])].sort((a, b) => a.idx - b.idx)

  // Drizzle-compatible bookkeeping table: same name, columns and hash scheme
  // (sha256 of the raw .sql file). A DB previously migrated by drizzle already
  // has this table populated, so its rows are recognised here.
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS __drizzle_migrations ('
    + 'id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)',
  )
  const appliedHashes = new Set(
    sqlite.prepare('SELECT hash FROM __drizzle_migrations').all().map(r => r.hash),
  )
  const insert = sqlite.prepare(
    'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
  )

  let appliedCount = 0
  for (const entry of entries) {
    const file = join(migrationsFolder, `${entry.tag}.sql`)
    const raw = readFileSync(file, 'utf8')
    const hash = createHash('sha256').update(raw).digest('hex')
    if (appliedHashes.has(hash)) continue

    // drizzle separates statements with this marker; mirror that split.
    const statements = raw
      .split('--> statement-breakpoint')
      .map(s => s.trim())
      .filter(s => s.length > 0)

    const apply = sqlite.transaction(() => {
      for (const stmt of statements) sqlite.exec(stmt)
      // Store `when` as created_at to stay byte-compatible with drizzle's own
      // migrator bookkeeping (value is cosmetic for this hash-based runner).
      insert.run(hash, typeof entry.when === 'number' ? entry.when : Date.now())
    })
    apply()
    appliedCount++
    console.log(`[noteforge] applied ${entry.tag}`)
  }

  console.log(`[noteforge] migrations up to date (${appliedCount} applied this run, ${entries.length} in journal)`)
}
catch (err) {
  console.error('[noteforge] migration failed:', err)
  sqlite.close()
  process.exit(1)
}
finally {
  sqlite.close()
}
