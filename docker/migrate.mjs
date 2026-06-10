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
 * **Self-healing on edited/renumbered migrations.** The hash scheme is fragile
 * to one thing: editing (or regenerating/renumbering) a migration file that a
 * DB has ALREADY applied. The recorded hash then no longer matches the file, so
 * this runner sees the migration as "pending" and re-runs it — which explodes on
 * `duplicate column name` / `table already exists`. To stay robust we adopt the
 * hash when a re-run is a *complete DDL no-op*: if every CREATE/ALTER/DROP in the
 * file collides with an object that already exists (and idempotent DML like the
 * `UPDATE` in 0019 simply re-runs harmlessly), the migration was already fully
 * applied, so we record its current hash and move on. A genuinely PARTIAL state
 * — some DDL applies while other DDL collides — is ambiguous and unsafe to
 * paper over, so it aborts loudly: that only happens when statements were ADDED
 * to an already-deployed migration (which should have been a new migration).
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

  // A re-run statement "collides" when its object already exists — i.e. the
  // migration was already applied under a different (pre-edit) hash. SQLite's
  // messages for these are stable across versions.
  const isAlreadyApplied = err =>
    err?.code === 'SQLITE_ERROR'
    && /duplicate column name|already exists/i.test(String(err.message))

  // Does a statement create/alter schema (so its success means real new DDL ran)
  // vs. idempotent DML (UPDATE/INSERT/DELETE) that always "succeeds" on re-run
  // and must NOT count toward the applied/collided tally?
  const isDdl = (stmt) => {
    const head = stmt
      .replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '')
      .slice(0, 12)
      .toUpperCase()
    return head.startsWith('CREATE') || head.startsWith('ALTER') || head.startsWith('DROP')
  }

  let appliedCount = 0
  let adoptedCount = 0
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

    // Tracks the DDL outcome of this (re-)run so we can tell a genuinely pending
    // migration (all DDL applies) from an already-applied one (all DDL collides)
    // from an unsafe partial state (a mix of both).
    let ddlApplied = 0
    let ddlCollided = 0

    const apply = sqlite.transaction(() => {
      ddlApplied = 0
      ddlCollided = 0
      for (const stmt of statements) {
        try {
          sqlite.exec(stmt)
          if (isDdl(stmt)) ddlApplied++
        }
        catch (err) {
          if (isAlreadyApplied(err)) {
            ddlCollided++
            continue
          }
          throw err
        }
      }
      // A partial state — some DDL newly applied while other DDL already existed
      // — means statements were added to a migration this DB had already run.
      // Re-running can't reconstruct the intended order safely, so bail out (the
      // transaction rolls back any DDL that did apply) and let an operator look.
      if (ddlApplied > 0 && ddlCollided > 0) {
        throw new Error(
          `${entry.tag} is partially applied (${ddlApplied} new DDL stmt(s), `
          + `${ddlCollided} already present). Refusing to guess — this migration `
          + `was likely edited after deployment; split the new statements into a `
          + `fresh migration.`,
        )
      }
      // Store `when` as created_at to stay byte-compatible with drizzle's own
      // migrator bookkeeping (value is cosmetic for this hash-based runner).
      insert.run(hash, typeof entry.when === 'number' ? entry.when : Date.now())
    })
    apply()

    if (ddlApplied === 0 && ddlCollided > 0) {
      adoptedCount++
      console.log(`[noteforge] adopted ${entry.tag} (already applied; recorded current hash)`)
    }
    else {
      appliedCount++
      console.log(`[noteforge] applied ${entry.tag}`)
    }
  }

  console.log(
    `[noteforge] migrations up to date (${appliedCount} applied, ${adoptedCount} adopted this run, `
    + `${entries.length} in journal)`,
  )
}
catch (err) {
  console.error('[noteforge] migration failed:', err)
  sqlite.close()
  process.exit(1)
}
finally {
  sqlite.close()
}
