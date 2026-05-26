import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { useDb } from './client'

const db = useDb()
migrate(db, { migrationsFolder: './server/database/migrations' })
console.log('[db] migrations applied')
process.exit(0)
