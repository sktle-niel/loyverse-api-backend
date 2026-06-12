import type { RowDataPacket } from 'mysql2'
import { getPool, isMysqlConfigured } from '../db/pool.js'
import type { CreatedItemRecord } from '../types/createdItem.js'

interface CreatedItemRow extends RowDataPacket {
  id: string
  item_id: string
  item_name: string
  sku: string
  category_id: string | null
  cost: string | number | null
  default_price: string | number | null
  track_stock: number
  sold_by_weight: number
  stores_json: string | null
  created_by: string
  created_at: Date
}

function toNum(v: string | number | null): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function rowToRecord(row: CreatedItemRow): CreatedItemRecord {
  let stores: CreatedItemRecord['stores'] = []
  try {
    stores = row.stores_json ? (JSON.parse(row.stores_json) as CreatedItemRecord['stores']) : []
  } catch {
    stores = []
  }
  return {
    id: row.id,
    itemId: row.item_id,
    itemName: row.item_name,
    sku: row.sku,
    categoryId: row.category_id,
    cost: toNum(row.cost),
    defaultPrice: toNum(row.default_price),
    trackStock: !!row.track_stock,
    soldByWeight: !!row.sold_by_weight,
    stores,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

// In-memory fallback when MySQL is not configured (dev only)
let memStore: CreatedItemRecord[] = []

export async function insertCreatedItem(rec: CreatedItemRecord): Promise<void> {
  if (!isMysqlConfigured()) {
    memStore.unshift(rec)
    if (memStore.length > 1000) memStore = memStore.slice(0, 1000)
    return
  }
  const pool = getPool()
  await pool.query(
    `INSERT INTO created_items
      (id, item_id, item_name, sku, category_id, cost, default_price, track_stock, sold_by_weight, stores_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      rec.id, rec.itemId, rec.itemName, rec.sku, rec.categoryId,
      rec.cost, rec.defaultPrice, rec.trackStock ? 1 : 0, rec.soldByWeight ? 1 : 0,
      JSON.stringify(rec.stores ?? []), rec.createdBy, new Date(rec.createdAt),
    ],
  )
}

export async function listCreatedItems(limit = 100): Promise<CreatedItemRecord[]> {
  // Sanitize to a plain integer and inline it — avoids mysql2's LIMIT-placeholder quirk.
  const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)))
  if (!isMysqlConfigured()) {
    return memStore.slice(0, safeLimit)
  }
  const pool = getPool()
  const [rows] = await pool.query<CreatedItemRow[]>(
    `SELECT * FROM created_items ORDER BY created_at DESC LIMIT ${safeLimit}`,
  )
  return (rows as CreatedItemRow[]).map(rowToRecord)
}
