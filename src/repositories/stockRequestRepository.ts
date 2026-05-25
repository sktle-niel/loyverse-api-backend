import type { RowDataPacket } from 'mysql2'
import { getPool, isMysqlConfigured } from '../db/pool.js'
import type { StockChangeRequest, StockRequestLine, StockRequestStatus } from '../types/stockRequest.js'

interface StockRequestRow extends RowDataPacket {
  id: string
  item_id: string
  variant_id: string
  item_name: string
  sku: string
  requested_by: string
  status: StockRequestStatus
  stock_lines: string | StockRequestLine[]
  created_at: Date
  reviewed_at: Date | null
  reviewed_by: string | null
  rejection_reason: string | null
}

function rowToRequest(row: StockRequestRow): StockChangeRequest {
  const lines =
    typeof row.stock_lines === 'string'
      ? (JSON.parse(row.stock_lines) as StockRequestLine[])
      : row.stock_lines

  return {
    id: row.id,
    itemId: row.item_id,
    variantId: row.variant_id,
    itemName: row.item_name,
    sku: row.sku,
    requestedBy: row.requested_by,
    status: row.status,
    lines,
    createdAt: new Date(row.created_at).toISOString(),
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : undefined,
    reviewedBy: row.reviewed_by ?? undefined,
    rejectionReason: row.rejection_reason ?? undefined,
  }
}

export async function insertStockRequest(request: StockChangeRequest): Promise<void> {
  const pool = getPool()
  await pool.query(
    `INSERT INTO stock_requests (
      id, item_id, variant_id, item_name, sku, requested_by, status, stock_lines, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      request.id,
      request.itemId,
      request.variantId,
      request.itemName,
      request.sku,
      request.requestedBy,
      request.status,
      JSON.stringify(request.lines),
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
      'status' | 'reviewedAt' | 'reviewedBy' | 'rejectionReason'
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
