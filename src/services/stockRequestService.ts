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
import { isLoyverseConfigured, LoyverseApiError } from './loyverseClient.js'
import {
  applyApprovedStockChanges,
  findProduct,
  resolveOldStock,
  validateStockUpdates,
} from './productsService.js'

function newRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

async function backfillRequestOldStock(
  requestId: string,
  itemId: string,
  storeId: string,
): Promise<void> {
  try {
    const found = await findProduct(itemId)
    if (!found) return

    const oldStock = await resolveOldStock(found.product, storeId, found.source, {
      retries: 1,
      logRetries: false,
      maxPages: 20,
    })
    await updateStockRequest(requestId, { oldStock, oldStockSynced: true }, false)
  } catch (err) {
    // Non-blocking enrichment: request is already saved.
    console.warn('[Stock Requests] Failed to backfill old_stock for request:', requestId, err)
  }
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

  // Efficiency goal: on submit, do NOT call Loyverse inventory history.
  // We store branch + new stock immediately, then fill `oldStock` at admin-approve time.
  const lineUpdate = updates[0]
  const storeNameById = new Map(found.stores.map((s) => [s.id, s.name]))
  const storeName = storeNameById.get(lineUpdate.storeId) ?? lineUpdate.storeId
  const lines = [
    {
      storeId: lineUpdate.storeId,
      storeName,
      oldStock: 0,
      newStock: lineUpdate.stock,
    },
  ]

  const request: StockChangeRequest = {
    id: newRequestId(),
    itemId: found.product.id,
    variantId: found.product.variantId,
    itemName: found.product.name,
    sku: found.product.sku,
    storeId: lines[0].storeId,
    storeName: lines[0].storeName,
    oldStock: lines[0].oldStock,
    oldStockSynced: false,
    newStock: lines[0].newStock,
    requestedBy,
    status: 'pending',
    lines,
    createdAt: new Date().toISOString(),
  }

  await addStockRequest(request)
  // Keep submit fast: respond immediately, then enrich old stock asynchronously from Loyverse.
  void backfillRequestOldStock(request.id, request.itemId, request.storeId)

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

  const actualOldStock = await resolveOldStock(found.product, existing.storeId, found.source)

  // newStock stored on the request is the change amount entered by the operator (additive).
  // Compute the absolute stock level to write to Loyverse.
  const newAbsoluteStock = Math.round(Number(actualOldStock) + Number(existing.newStock))

  console.log(
    `[Approve] ${existing.itemName} @ ${existing.storeName}: old=${actualOldStock} + change=${existing.newStock} → new=${newAbsoluteStock}`,
  )

  const updates: StockUpdateInput[] = [
    {
      storeId: existing.storeId,
      stock: newAbsoluteStock,
    },
  ]

  const oldStockMap = new Map([[existing.storeId, actualOldStock]])
  const applied = await applyApprovedStockChanges(found.product, updates, reviewedBy, oldStockMap)

  const request = await updateStockRequest(
    requestId,
    {
      status: 'approved',
      reviewedAt: new Date().toISOString(),
      reviewedBy,
      oldStock: actualOldStock,
      oldStockSynced: true,
      newStock: newAbsoluteStock,
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
    _debug: {
      actualOldStock,
      existingNewStock: existing.newStock,
      newAbsoluteStock,
      catalogSource: found.source,
      loyverseConfigured: isLoyverseConfigured(),
      variantId: found.product.variantId,
      storeId: existing.storeId,
    },
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
