import type { StockChangeRequest, StockRequestStatus } from '../types/stockRequest.js'
import {
  findStockRequestById as findInDb,
  insertStockRequest,
  listStockRequestsFromDb,
  updateStockRequestInDb,
  useMysqlForStockRequests,
} from '../repositories/stockRequestRepository.js'

/** In-memory fallback when MYSQL_* env vars are not set (local dev only). */
const memoryRequests: StockChangeRequest[] = []

export function isUsingDatabase(): boolean {
  return useMysqlForStockRequests()
}

export async function addStockRequest(request: StockChangeRequest): Promise<void> {
  if (useMysqlForStockRequests()) {
    await insertStockRequest(request)
    return
  }

  memoryRequests.unshift(request)
  if (memoryRequests.length > 1000) memoryRequests.length = 1000
}

export async function getStockRequestById(id: string): Promise<StockChangeRequest | undefined> {
  if (useMysqlForStockRequests()) {
    const row = await findInDb(id)
    return row ?? undefined
  }
  return memoryRequests.find((r) => r.id === id)
}

export async function updateStockRequest(
  id: string,
  patch: Partial<StockChangeRequest>,
  onlyIfPending = false,
): Promise<StockChangeRequest | undefined> {
  if (useMysqlForStockRequests()) {
    const updated = await updateStockRequestInDb(
      id,
      {
        status: patch.status,
        reviewedAt: patch.reviewedAt,
        reviewedBy: patch.reviewedBy,
        rejectionReason: patch.rejectionReason,
        oldStock: patch.oldStock,
        oldStockSynced: patch.oldStockSynced,
        newStock: patch.newStock,
      },
      onlyIfPending,
    )
    return updated ?? undefined
  }

  const idx = memoryRequests.findIndex((r) => r.id === id)
  if (idx === -1) return undefined
  if (onlyIfPending && memoryRequests[idx].status !== 'pending') return undefined

  memoryRequests[idx] = { ...memoryRequests[idx], ...patch }
  return memoryRequests[idx]
}

export async function listStockRequests(
  status?: StockRequestStatus,
): Promise<StockChangeRequest[]> {
  if (useMysqlForStockRequests()) {
    return listStockRequestsFromDb(status)
  }

  if (!status) return [...memoryRequests]
  return memoryRequests.filter((r) => r.status === status)
}
