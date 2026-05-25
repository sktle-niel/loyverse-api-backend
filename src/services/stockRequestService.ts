import {
  addStockRequest,
  getStockRequestById,
  listStockRequests,
  updateStockRequest,
} from '../data/stockRequests.js'
import type { StockUpdateInput } from '../types/products.js'
import type {
  StockChangeRequest,
  StockRequestStatus,
  SubmitStockRequestResult,
} from '../types/stockRequest.js'
import { LoyverseApiError } from './loyverseClient.js'
import {
  applyApprovedStockChanges,
  findProduct,
  validateStockUpdates,
} from './productsService.js'

function newRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export async function submitStockChangeRequest(
  itemId: string,
  updates: StockUpdateInput[],
  requestedBy = 'Staff',
): Promise<SubmitStockRequestResult> {
  const found = await findProduct(itemId)
  if (!found) {
    throw new LoyverseApiError(`Product not found: ${itemId}`, 404)
  }

  const storeIds = new Set(found.stores.map((s) => s.id))
  validateStockUpdates(updates, storeIds)

  const storeNameById = new Map(found.stores.map((s) => [s.id, s.name]))
  const lines = updates
    .map((u) => {
      const current = found.product.stocks.find((s) => s.storeId === u.storeId)
      const oldStock = current?.stock ?? 0
      return {
        storeId: u.storeId,
        storeName: storeNameById.get(u.storeId) ?? u.storeId,
        oldStock,
        newStock: u.stock,
      }
    })
    .filter((line) => line.oldStock !== line.newStock)

  if (lines.length === 0) {
    throw new LoyverseApiError('No stock changes to submit', 400)
  }

  const request: StockChangeRequest = {
    id: newRequestId(),
    itemId: found.product.id,
    variantId: found.product.variantId,
    itemName: found.product.name,
    sku: found.product.sku,
    requestedBy,
    status: 'pending',
    lines,
    createdAt: new Date().toISOString(),
  }

  await addStockRequest(request)

  return {
    request,
    message: 'Stock change submitted for admin approval. Loyverse is not updated yet.',
  }
}

export async function getStockRequests(
  status?: StockRequestStatus,
): Promise<StockChangeRequest[]> {
  return listStockRequests(status)
}

export async function approveStockRequest(
  requestId: string,
  reviewedBy = 'Admin',
): Promise<{
  request: StockChangeRequest
  product: import('../types/products.js').ProductDto
  auditRecords: import('../types/audit.js').AuditRecord[]
  source: 'loyverse' | 'mock'
}> {
  const existing = await getStockRequestById(requestId)
  if (!existing) {
    throw new LoyverseApiError(`Request not found: ${requestId}`, 404)
  }
  if (existing.status !== 'pending') {
    throw new LoyverseApiError(`Request already ${existing.status}`, 409)
  }

  const found = await findProduct(existing.itemId)
  if (!found) {
    throw new LoyverseApiError(`Product not found: ${existing.itemId}`, 404)
  }

  const updates: StockUpdateInput[] = existing.lines.map((line) => ({
    storeId: line.storeId,
    stock: line.newStock,
  }))

  const applied = await applyApprovedStockChanges(found.product, updates, reviewedBy)

  const request = await updateStockRequest(
    requestId,
    {
      status: 'approved',
      reviewedAt: new Date().toISOString(),
      reviewedBy,
    },
    true,
  )

  if (!request) {
    throw new LoyverseApiError(`Request already processed: ${requestId}`, 409)
  }

  return {
    request,
    product: applied.product,
    auditRecords: applied.auditRecords,
    source: applied.source,
  }
}

export async function rejectStockRequest(
  requestId: string,
  reviewedBy = 'Admin',
  rejectionReason?: string,
): Promise<StockChangeRequest> {
  const existing = await getStockRequestById(requestId)
  if (!existing) {
    throw new LoyverseApiError(`Request not found: ${requestId}`, 404)
  }
  if (existing.status !== 'pending') {
    throw new LoyverseApiError(`Request already ${existing.status}`, 409)
  }

  const request = await updateStockRequest(
    requestId,
    {
      status: 'rejected',
      reviewedAt: new Date().toISOString(),
      reviewedBy,
      rejectionReason: rejectionReason?.trim() || undefined,
    },
    true,
  )

  if (!request) {
    throw new LoyverseApiError(`Request already processed: ${requestId}`, 409)
  }

  return request
}
