import type { RowDataPacket, ResultSetHeader } from 'mysql2'
import { getPool, isMysqlConfigured } from '../db/pool.js'
import type { TransferRequest, TransferRequestStatus } from '../types/transferRequest.js'

interface TransferRequestRow extends RowDataPacket {
  id: string
  item_id: string
  variant_id: string
  item_name: string
  sku: string
  from_store_id: string
  from_store_name: string
  to_store_id: string
  to_store_name: string
  quantity: number
  requested_by: string
  status: TransferRequestStatus
  created_at: Date
  reviewed_at: Date | null
  reviewed_by: string | null
  rejection_reason: string | null
}

function rowToRequest(row: TransferRequestRow): TransferRequest {
  return {
    id: row.id,
    itemId: row.item_id,
    variantId: row.variant_id,
    itemName: row.item_name,
    sku: row.sku ?? '',
    fromStoreId: row.from_store_id,
    fromStoreName: row.from_store_name,
    toStoreId: row.to_store_id,
    toStoreName: row.to_store_name,
    quantity: Number(row.quantity),
    requestedBy: row.requested_by,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : undefined,
    reviewedBy: row.reviewed_by ?? undefined,
    rejectionReason: row.rejection_reason ?? undefined,
  }
}

// In-memory fallback when MySQL is not configured
let memStore: TransferRequest[] = []

export async function insertTransferRequest(req: TransferRequest): Promise<void> {
  if (!isMysqlConfigured()) {
    memStore.push(req)
    return
  }
  const pool = getPool()
  await pool.query(
    `INSERT INTO transfer_requests
      (id, item_id, variant_id, item_name, sku,
       from_store_id, from_store_name, to_store_id, to_store_name,
       quantity, requested_by, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.id, req.itemId, req.variantId, req.itemName, req.sku,
      req.fromStoreId, req.fromStoreName, req.toStoreId, req.toStoreName,
      req.quantity, req.requestedBy, req.status, new Date(req.createdAt),
    ],
  )
}

export async function findTransferRequestById(id: string): Promise<TransferRequest | null> {
  if (!isMysqlConfigured()) {
    return memStore.find(r => r.id === id) ?? null
  }
  const pool = getPool()
  const [rows] = await pool.query<TransferRequestRow[]>(
    'SELECT * FROM transfer_requests WHERE id = ? LIMIT 1',
    [id],
  )
  return rows.length > 0 ? rowToRequest(rows[0]) : null
}

export async function listTransferRequestsFromDb(
  status?: TransferRequestStatus,
): Promise<TransferRequest[]> {
  if (!isMysqlConfigured()) {
    const all = [...memStore].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    return status ? all.filter(r => r.status === status) : all
  }
  const pool = getPool()
  const [rows] = status
    ? await pool.query<TransferRequestRow[]>(
        'SELECT * FROM transfer_requests WHERE status = ? ORDER BY created_at DESC',
        [status],
      )
    : await pool.query<TransferRequestRow[]>(
        'SELECT * FROM transfer_requests ORDER BY created_at DESC',
      )
  return (rows as TransferRequestRow[]).map(rowToRequest)
}

export async function updateTransferRequestInDb(
  id: string,
  patch: Partial<Pick<TransferRequest, 'status' | 'reviewedAt' | 'reviewedBy' | 'rejectionReason'>>,
  onlyIfPending = false,
): Promise<TransferRequest | null> {
  if (!isMysqlConfigured()) {
    const idx = memStore.findIndex(r => r.id === id)
    if (idx === -1) return null
    if (onlyIfPending && memStore[idx].status !== 'pending') return null
    memStore[idx] = { ...memStore[idx], ...patch }
    return memStore[idx]
  }

  const sets: string[] = []
  const vals: unknown[] = []

  if (patch.status !== undefined) { sets.push('status = ?'); vals.push(patch.status) }
  if (patch.reviewedAt !== undefined) { sets.push('reviewed_at = ?'); vals.push(patch.reviewedAt ? new Date(patch.reviewedAt) : null) }
  if (patch.reviewedBy !== undefined) { sets.push('reviewed_by = ?'); vals.push(patch.reviewedBy) }
  if (patch.rejectionReason !== undefined) { sets.push('rejection_reason = ?'); vals.push(patch.rejectionReason) }
  if (sets.length === 0) return findTransferRequestById(id)

  const pendingClause = onlyIfPending ? " AND status = 'pending'" : ''
  vals.push(id)

  const pool = getPool()
  const [result] = await pool.query<ResultSetHeader>(
    `UPDATE transfer_requests SET ${sets.join(', ')} WHERE id = ?${pendingClause}`,
    vals,
  )
  if (onlyIfPending && result.affectedRows === 0) return null

  return findTransferRequestById(id)
}
