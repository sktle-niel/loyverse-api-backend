import type { RowDataPacket } from 'mysql2'
import { getPool, isMysqlConfigured } from '../db/pool.js'
import type { PriceHistoryEntry } from '../types/priceHistory.js'

interface PriceHistoryRow extends RowDataPacket {
  id: string
  item_id: string
  item_name: string
  store_id: string
  store_name: string
  old_price: string | number | null
  new_price: string | number
  changed_by: string
  created_at: Date
}

function toNum(v: string | number | null): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function rowToEntry(row: PriceHistoryRow): PriceHistoryEntry {
  return {
    id: row.id,
    itemId: row.item_id,
    itemName: row.item_name,
    storeId: row.store_id,
    storeName: row.store_name,
    oldPrice: toNum(row.old_price),
    newPrice: toNum(row.new_price) ?? 0,
    changedBy: row.changed_by,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

// In-memory fallback when MySQL is not configured (dev only)
let memStore: PriceHistoryEntry[] = []

export async function insertPriceHistory(entry: PriceHistoryEntry): Promise<void> {
  if (!isMysqlConfigured()) {
    memStore.unshift(entry)
    if (memStore.length > 1000) memStore = memStore.slice(0, 1000)
    return
  }
  const pool = getPool()
  await pool.query(
    `INSERT INTO price_history
      (id, item_id, item_name, store_id, store_name, old_price, new_price, changed_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id, entry.itemId, entry.itemName, entry.storeId, entry.storeName,
      entry.oldPrice, entry.newPrice, entry.changedBy, new Date(entry.createdAt),
    ],
  )
}

export async function listPriceHistory(itemId?: string, limit = 50): Promise<PriceHistoryEntry[]> {
  // Sanitize to a plain integer and inline it — avoids mysql2's LIMIT-placeholder quirk.
  const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)))
  if (!isMysqlConfigured()) {
    const all = itemId ? memStore.filter((e) => e.itemId === itemId) : memStore
    return all.slice(0, safeLimit)
  }
  const pool = getPool()
  const [rows] = itemId
    ? await pool.query<PriceHistoryRow[]>(
        `SELECT * FROM price_history WHERE item_id = ? ORDER BY created_at DESC LIMIT ${safeLimit}`,
        [itemId],
      )
    : await pool.query<PriceHistoryRow[]>(
        `SELECT * FROM price_history ORDER BY created_at DESC LIMIT ${safeLimit}`,
      )
  return (rows as PriceHistoryRow[]).map(rowToEntry)
}
