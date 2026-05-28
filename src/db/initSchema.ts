import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPool, isMysqlConfigured } from './pool.js'
import { migrateStockRequestsBranchColumns } from './migrateStockRequests.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function initDatabaseSchema(): Promise<void> {
  if (!isMysqlConfigured()) return

  const sqlPath = join(__dirname, 'schema.sql')
  const sql = readFileSync(sqlPath, 'utf8')
  const pool = getPool()

  // schema.sql may contain comments; run CREATE TABLE statement(s)
  const statements = sql
    .split(';')
    .map((s) => s.replace(/--.*$/gm, '').trim())
    .filter((s) => s.length > 0)

  for (const statement of statements) {
    await pool.query(statement)
  }

  await migrateStockRequestsBranchColumns()
}
