import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null
let _sqlite: Database.Database | null = null
let _vecAvailable = false

function resolveDbPath(): string {
  const url = process.env.DATABASE_URL ?? 'data/noteforge.db'
  return resolve(process.cwd(), url)
}

export function getRawDb(): Database.Database {
  if (_sqlite) return _sqlite
  const path = resolveDbPath()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  try {
    sqliteVec.load(sqlite)
    _vecAvailable = true
  }
  catch (err) {
    _vecAvailable = false
    console.warn('[db] sqlite-vec extension failed to load — vector search disabled:', err)
  }

  _sqlite = sqlite
  return sqlite
}

export function useDb() {
  if (_db) return _db
  _db = drizzle(getRawDb(), { schema })
  return _db
}

/**
 * True if the `sqlite-vec` extension loaded successfully on this connection.
 * Code paths that issue vec0 `MATCH` queries must check this flag and fall
 * back to in-JS cosine similarity (`server/utils/vector.ts`) when the
 * extension is unavailable (some sandboxed/locked-down environments).
 *
 * Lazy: triggers a DB connection on first call so the flag reflects the
 * actual extension state.
 */
export function isVecAvailable(): boolean {
  // Force the connection so the loader has run at least once.
  getRawDb()
  return _vecAvailable
}
