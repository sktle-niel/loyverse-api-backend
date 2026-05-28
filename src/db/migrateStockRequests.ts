import type { RowDataPacket } from 'mysql2'
import { getPool } from './pool.js'

interface ColumnRow extends RowDataPacket {
  COLUMN_NAME: string
}

async function hasColumn(table: string, column: string): Promise<boolean> {
  const pool = getPool()
  const [rows] = await pool.query<ColumnRow[]>(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  )
  return rows.length > 0
}

/** Add branch + stock columns to stock_requests (safe to run on every startup). */
export async function migrateStockRequestsBranchColumns(): Promise<void> {
  const pool = getPool()

  if (!(await hasColumn('stock_requests', 'store_id'))) {
    await pool.query(
      `ALTER TABLE stock_requests
       ADD COLUMN store_id VARCHAR(80) NULL AFTER sku,
       ADD COLUMN store_name VARCHAR(255) NULL AFTER store_id,
       ADD COLUMN old_stock INT NULL AFTER store_name,
       ADD COLUMN new_stock INT NULL AFTER old_stock`,
    )
  }

  if (!(await hasColumn('stock_requests', 'old_stock_synced'))) {
    await pool.query(
      `ALTER TABLE stock_requests
       ADD COLUMN old_stock_synced TINYINT(1) NOT NULL DEFAULT 0 AFTER old_stock`,
    )
  }

  await pool.query(
    `UPDATE stock_requests
     SET
       store_id = COALESCE(
         store_id,
         JSON_UNQUOTE(JSON_EXTRACT(stock_lines, '$[0].storeId'))
       ),
       store_name = COALESCE(
         store_name,
         JSON_UNQUOTE(JSON_EXTRACT(stock_lines, '$[0].storeName'))
       ),
       old_stock = COALESCE(
         old_stock,
         CAST(JSON_EXTRACT(stock_lines, '$[0].oldStock') AS SIGNED)
       ),
       new_stock = COALESCE(
         new_stock,
         CAST(JSON_EXTRACT(stock_lines, '$[0].newStock') AS SIGNED)
       ),
       old_stock_synced = CASE
         WHEN old_stock IS NOT NULL THEN 1
         ELSE old_stock_synced
       END
     WHERE stock_lines IS NOT NULL
       AND JSON_LENGTH(stock_lines) > 0
       AND (
         store_id IS NULL OR store_name IS NULL OR old_stock IS NULL OR new_stock IS NULL OR old_stock_synced = 0
       )`,
  )

  try {
    await pool.query('CREATE INDEX idx_store_id ON stock_requests (store_id)')
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    if (code !== 'ER_DUP_KEYNAME') throw err
  }
}
