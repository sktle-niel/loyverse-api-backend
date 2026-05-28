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

/** Ensure branch columns are populated from stock_lines (safe to run on every startup). */
export async function migrateStockRequestsBranchColumns(): Promise<void> {
  const pool = getPool()

  // Ensure the basic columns exist (they should from schema.sql, but check anyway)
  if (!(await hasColumn('stock_requests', 'store_id'))) {
    await pool.query(
      `ALTER TABLE stock_requests
       ADD COLUMN store_id VARCHAR(80) NULL AFTER sku,
       ADD COLUMN store_name VARCHAR(255) NULL AFTER store_id`,
    )
  }

  if (!(await hasColumn('stock_requests', 'new_stock'))) {
    await pool.query(
      `ALTER TABLE stock_requests
       ADD COLUMN new_stock INT NULL AFTER store_name`,
    )
  }

  // Populate singleton columns from stock_lines if they are null
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
       new_stock = COALESCE(
         new_stock,
         CAST(JSON_EXTRACT(stock_lines, '$[0].newStock') AS SIGNED)
       )
     WHERE stock_lines IS NOT NULL
       AND JSON_LENGTH(stock_lines) > 0
       AND (
         store_id IS NULL OR store_name IS NULL OR new_stock IS NULL
       )`
  )
}
