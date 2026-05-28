import type { RowDataPacket } from 'mysql2'
import { getPool, isMysqlConfigured } from '../db/pool.js'
import type { StockChangeRequest, StockRequestLine, StockRequestStatus } from '../types/stockRequest.js'

interface StockRequestRow extends RowDataPacket {
  id: string
  item_id: string
  variant_id: string
  item_name: string
  sku: string
  store_id: string | null
  store_name: string | null
  old_stock: number | null
  old_stock_synced: number | null
  new_stock: number | null
  requested_by: string
  status: StockRequestStatus
  stock_lines: string | StockRequestLine[]
  created_at: Date
  reviewed_at: Date | null
  reviewed_by: string | null
  rejection_reason: string | null
}

function parseStockLines(raw: string | StockRequestLine[]): StockRequestLine[] {
  if (Array.isArray(raw)) return raw
  try {
    const parsed = JSON.parse(raw) as StockRequestLine[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function lineFromRow(row: StockRequestRow): StockRequestLine {
  if (row.store_id) {
    return {
      storeId: row.store_id,
      storeName: row.store_name ?? '',
      oldStock: row.old_stock ?? 0,
      newStock: row.new_stock ?? 0,
    }
  }
  const fromJson = parseStockLines(row.stock_lines)
  return (
    fromJson[0] ?? {
      storeId: '',
      storeName: '',
      oldStock: 0,
      newStock: 0,
    }
  )
}

function rowToRequest(row: StockRequestRow): StockChangeRequest {
  const line = lineFromRow(row)

  return {
    id: row.id,
    itemId: row.item_id,
    variantId: row.variant_id,
    itemName: row.item_name,
    sku: row.sku,
    storeId: line.storeId,
    storeName: line.storeName,
    oldStock: line.oldStock,
    oldStockSynced: row.old_stock_synced === 1,
    newStock: line.newStock,
    requestedBy: row.requested_by,
    status: row.status,
    lines: [line],
    createdAt: new Date(row.created_at).toISOString(),
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : undefined,
    reviewedBy: row.reviewed_by ?? undefined,
    rejectionReason: row.rejection_reason ?? undefined,
  }
}

export async function insertStockRequest(request: StockChangeRequest): Promise<void> {
  const line = request.lines[0]
  const pool = getPool()
  await pool.query(
    `INSERT INTO stock_requests (
      id, item_id, variant_id, item_name, sku,
      store_id, store_name, old_stock, old_stock_synced, new_stock,
      requested_by, status, stock_lines, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      request.id,
      request.itemId,
      request.variantId,
      request.itemName,
      request.sku,
      request.storeId,
      request.storeName,
      request.oldStock,
      request.oldStockSynced ? 1 : 0,
      request.newStock,
      request.requestedBy,
      request.status,
      JSON.stringify(request.lines.length > 0 ? request.lines : [line]),
      new Date(request.createdAt),
    ],
  )
}

export async function findStockRequestById(id: string): Promise<StockChangeRequest | null> {
  const pool = getPool()
  const [rows] = await pool.query<StockRequestRow[]>(
    'SELECT * FROM stock_requests WHERE id = ? LIMIT 1',
    [id],
  )
  if (rows.length === 0) return null
  return rowToRequest(rows[0])
}

export async function listStockRequestsFromDb(
  status?: StockRequestStatus,
): Promise<StockChangeRequest[]> {
  const pool = getPool()
  const [rows] = status
    ? await pool.query<StockRequestRow[]>(
        'SELECT * FROM stock_requests WHERE status = ? ORDER BY created_at DESC',
        [status],
      )
    : await pool.query<StockRequestRow[]>(
        'SELECT * FROM stock_requests ORDER BY created_at DESC',
      )

  return rows.map(rowToRequest)
}

export async function updateStockRequestInDb(
  id: string,
  patch: Partial<
    Pick<
      StockChangeRequest,
      | 'status'
      | 'reviewedAt'
      | 'reviewedBy'
      | 'rejectionReason'
      | 'oldStock'
      | 'oldStockSynced'
      | 'newStock'
    >
  >,
  onlyIfPending = false,
): Promise<StockChangeRequest | null> {
  const pool = getPool()
  const sets: string[] = []
  const values: unknown[] = []

  if (patch.status) {
    sets.push('status = ?')
    values.push(patch.status)
  }
  if (patch.reviewedAt !== undefined) {
    sets.push('reviewed_at = ?')
    values.push(patch.reviewedAt ? new Date(patch.reviewedAt) : null)
  }
  if (patch.reviewedBy !== undefined) {
    sets.push('reviewed_by = ?')
    values.push(patch.reviewedBy)
  }
  if (patch.rejectionReason !== undefined) {
    sets.push('rejection_reason = ?')
    values.push(patch.rejectionReason)
  }
  if (patch.oldStock !== undefined) {
    sets.push('old_stock = ?')
    values.push(patch.oldStock)
  }
  if (patch.oldStockSynced !== undefined) {
    sets.push('old_stock_synced = ?')
    values.push(patch.oldStockSynced ? 1 : 0)
  }
  if (patch.newStock !== undefined) {
    sets.push('new_stock = ?')
    values.push(patch.newStock)
  }

  if (sets.length === 0) return findStockRequestById(id)

  values.push(id)
  const pendingClause = onlyIfPending ? " AND status = 'pending'" : ''
  const [result] = await pool.query(
    `UPDATE stock_requests SET ${sets.join(', ')} WHERE id = ?${pendingClause}`,
    values,
  )

  const affected = (result as { affectedRows?: number }).affectedRows ?? 0
  if (onlyIfPending && affected === 0) return null

  return findStockRequestById(id)
}

export function useMysqlForStockRequests(): boolean {
  return isMysqlConfigured()
}
