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

function rowToRequest(row: StockRequestRow): StockChangeRequest {
  const lines = parseStockLines(row.stock_lines)
  // We expect at least one line; if not, we create a default line from the singleton columns
  const line: StockRequestLine = lines.length > 0
    ? lines[0]
    : {
        storeId: row.store_id ?? '',
        storeName: row.store_name ?? '',
        oldStock: 0,
        newStock: row.new_stock ?? 0,
        synced: false,
      }

  return {
    id: row.id,
    itemId: row.item_id,
    variantId: row.variant_id,
    itemName: row.item_name,
    sku: row.sku,
    storeId: line.storeId,
    storeName: line.storeName,
    oldStock: line.oldStock,
    oldStockSynced: line.synced ?? false,
    newStock: line.newStock,
    requestedBy: row.requested_by,
    status: row.status,
    lines: [line], // We always return an array with one line for backward compatibility
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
      store_id, store_name, new_stock,
      requested_by, status, stock_lines, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      request.id,
      request.itemId,
      request.variantId,
      request.itemName,
      request.sku,
      request.storeId,
      request.storeName,
      request.newStock, // singleton new_stock column
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
  // Start by updating the simple fields that don't affect the lines
  const simpleSets: string[] = []
  const simpleValues: unknown[] = []

  if (patch.status) {
    simpleSets.push('status = ?')
    simpleValues.push(patch.status)
  }
  if (patch.reviewedAt !== undefined) {
    simpleSets.push('reviewed_at = ?')
    simpleValues.push(patch.reviewedAt ? new Date(patch.reviewedAt) : null)
  }
  if (patch.reviewedBy !== undefined) {
    simpleSets.push('reviewed_by = ?')
    simpleValues.push(patch.reviewedBy)
  }
  if (patch.rejectionReason !== undefined) {
    simpleSets.push('rejection_reason = ?')
    simpleValues.push(patch.rejectionReason)
  }

  // We'll update the simple fields first
  if (simpleSets.length > 0) {
    simpleValues.push(id)
    const pendingClause = onlyIfPending ? " AND status = 'pending'" : ''
    await pool.query(
      `UPDATE stock_requests SET ${simpleSets.join(', ')} WHERE id = ?${pendingClause}`,
      simpleValues,
    )
  }

  // Now handle the fields that affect the lines: oldStock, oldStockSynced, newStock
  const lineRelatedPatch = {
    oldStock: patch.oldStock,
    oldStockSynced: patch.oldStockSynced,
    newStock: patch.newStock,
  }
  const hasLineRelatedPatch = Object.values(lineRelatedPatch).some(v => v !== undefined)

  if (hasLineRelatedPatch) {
    // Fetch the current request to get the current lines
    const current = await findStockRequestById(id)
    if (!current) {
      // If the request doesn't exist, we cannot update the lines
      return null
    }
    if (onlyIfPending && current.status !== 'pending') {
      return null
    }

    // Clone the lines array (we assume only one line)
    const newLines = [...current.lines]
    if (newLines.length === 0) {
      // If there are no lines, we create a default line
      newLines.push({
        storeId: current.storeId,
        storeName: current.storeName,
        oldStock: 0,
        newStock: 0,
        synced: false,
      })
    }
    const line = newLines[0]

    // Update the line with the patch values if provided
    if (lineRelatedPatch.oldStock !== undefined) {
      line.oldStock = lineRelatedPatch.oldStock
    }
    if (lineRelatedPatch.newStock !== undefined) {
      line.newStock = lineRelatedPatch.newStock
    }
    if (lineRelatedPatch.oldStockSynced !== undefined) {
      line.synced = lineRelatedPatch.oldStockSynced
    }

    // Update the stock_lines column and the singleton new_stock column
    await pool.query(
      `UPDATE stock_requests SET stock_lines = ?, new_stock = ? WHERE id = ?`,
      [JSON.stringify(newLines), line.newStock, id],
    )
  }

  // Fetch and return the updated request
  return findStockRequestById(id)
}

export function useMysqlForStockRequests(): boolean {
  return isMysqlConfigured()
}