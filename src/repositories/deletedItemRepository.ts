import type { RowDataPacket } from 'mysql2'
import { getPool, isMysqlConfigured } from '../db/pool.js'
import type { DeletedItemRecord } from '../types/deletedItem.js'

interface DeletedItemRow extends RowDataPacket {
  id: string
  item_id: string
  item_name: string
  sku: string
  deleted_by: string
  created_at: Date
}

function rowToRecord(row: DeletedItemRow): DeletedItemRecord {
  return {
    id: row.id,
    itemId: row.item_id,
    itemName: row.item_name,
    sku: row.sku,
    deletedBy: row.deleted_by,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

// In-memory fallback when MySQL is not configured (dev only)
let memStore: DeletedItemRecord[] = []

export async function insertDeletedItem(rec: DeletedItemRecord): Promise<void> {
  if (!isMysqlConfigured()) {
    memStore.unshift(rec)
    if (memStore.length > 1000) memStore = memStore.slice(0, 1000)
    return
  }
  const pool = getPool()
  await pool.query(
    `INSERT INTO deleted_items
      (id, item_id, item_name, sku, deleted_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [rec.id, rec.itemId, rec.itemName, rec.sku, rec.deletedBy, new Date(rec.createdAt)],
  )
}

export async function listDeletedItems(limit = 100): Promise<DeletedItemRecord[]> {
  // Sanitize to a plain integer and inline it — avoids mysql2's LIMIT-placeholder quirk.
  const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)))
  if (!isMysqlConfigured()) {
    return memStore.slice(0, safeLimit)
  }
  const pool = getPool()
  const [rows] = await pool.query<DeletedItemRow[]>(
    `SELECT * FROM deleted_items ORDER BY created_at DESC LIMIT ${safeLimit}`,
  )
  return (rows as DeletedItemRow[]).map(rowToRecord)
}
