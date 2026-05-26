/**
 * Standalone migration runner for the Docker runtime image.
 *
 * Mirrors `server/database/migrate.ts` but written in plain ESM JS so we
 * don't need `tsx` in the final stage. It opens the SQLite file pointed at
 * by $DATABASE_URL (defaulting to /app/data/noteforge.db), then asks
 * drizzle-orm's better-sqlite3 migrator to apply every SQL file in
 * /app/server/database/migrations/.
 *
 * Failure is fatal: if migrations can't run we exit non-zero so the
 * container restarts loudly rather than serving against an out-of-date
 * schema.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

const dbPath = resolve(process.env.DATABASE_URL || '/app/data/noteforge.db')
const migrationsFolder = process.env.MIGRATIONS_DIR || '/app/server/database/migrations'

const dir = dirname(dbPath)
if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

const sqlite = new Database(dbPath)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')

// Load sqlite-vec so migration 0004 (CREATE VIRTUAL TABLE ... USING vec0)
// can run. The runtime DB connection in server/database/client.ts does the
// same; without it the migration aborts with "no such module: vec0".
try {
  sqliteVec.load(sqlite)
}
catch (err) {
  console.error('[noteforge] failed to load sqlite-vec extension:', err)
  sqlite.close()
  process.exit(1)
}

try {
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder })
  console.log('[noteforge] migrations applied')
}
catch (err) {
  console.error('[noteforge] migration failed:', err)
  process.exit(1)
}
finally {
  sqlite.close()
}
