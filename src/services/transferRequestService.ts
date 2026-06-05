import type { TransferRequest, SubmitTransferBody } from '../types/transferRequest.js'
import {
  insertTransferRequest,
  findTransferRequestById,
  listTransferRequestsFromDb,
  updateTransferRequestInDb,
} from '../repositories/transferRequestRepository.js'
import { findProduct, resolveOldStock } from './productsService.js'
import { LoyverseApiError, isLoyverseConfigured, loyversePost, fetchAllPages } from './loyverseClient.js'
import { getCachedVariantStock, updateCachedVariantStock } from './stockLevelsService.js'
import type { LoyverseInventoryLevel } from '../types/loyverse.js'
import { sendPushToAll } from './pushService.js'

function newId(): string {
  return `tr-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export async function submitTransferRequest(
  body: SubmitTransferBody,
): Promise<{ request: TransferRequest; message: string }> {
  const { itemId, fromStoreId, toStoreId, quantity, requestedBy = 'Operator' } = body

  if (!itemId || !fromStoreId || !toStoreId) {
    throw new LoyverseApiError('itemId, fromStoreId, and toStoreId are required', 400)
  }
  if (fromStoreId === toStoreId) {
    throw new LoyverseApiError('Source and destination stores must be different', 400)
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new LoyverseApiError('quantity must be a positive integer', 400)
  }

  const found = await findProduct(itemId)
  if (!found) throw new LoyverseApiError(`Product not found: ${itemId}`, 404)

  const storeIds = new Set(found.stores.map((s) => s.id))
  if (!storeIds.has(fromStoreId)) throw new LoyverseApiError(`Unknown store: ${fromStoreId}`, 400)
  if (!storeIds.has(toStoreId)) throw new LoyverseApiError(`Unknown store: ${toStoreId}`, 400)

  const storeNameById = new Map(found.stores.map((s) => [s.id, s.name]))

  const request: TransferRequest = {
    id: newId(),
    itemId: found.product.id,
    variantId: found.product.variantId,
    itemName: found.product.name,
    sku: found.product.sku,
    fromStoreId,
    fromStoreName: storeNameById.get(fromStoreId) ?? fromStoreId,
    toStoreId,
    toStoreName: storeNameById.get(toStoreId) ?? toStoreId,
    quantity,
    requestedBy,
    status: 'pending',
    createdAt: new Date().toISOString(),
  }

  await insertTransferRequest(request)

  void sendPushToAll({
    title: 'New transfer request',
    body: `${request.itemName}: ${quantity} units ${request.fromStoreName} → ${request.toStoreName}`,
    url: '/approvals',
  })

  return { request, message: 'Transfer request submitted for admin approval.' }
}

export async function getTransferRequests(
  status?: string,
): Promise<TransferRequest[]> {
  const requests = await listTransferRequestsFromDb(status as any)
  // Enrich pending requests with live stock from in-memory cache so admin always
  // sees current numbers, not the snapshot from when the request was submitted.
  return requests.map((req) => {
    if (req.status !== 'pending') return req
    return {
      ...req,
      fromStockCurrent: getCachedVariantStock(req.variantId, req.fromStoreId),
      toStockCurrent: getCachedVariantStock(req.variantId, req.toStoreId),
    }
  })
}

export async function getPendingTransferStocks(): Promise<
  Array<{ variantId: string; storeId: string; stock: number }>
> {
  const pending = await listTransferRequestsFromDb('pending')
  if (pending.length === 0) return []

  // Use updated_since (confirmed working filter, same as delta sync) to fetch
  // recently changed inventory levels from Loyverse. 2-hour window catches any
  // manual adjustment or sale the operator or admin may have just made.
  const updatedSince = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  const recentLevels = await fetchAllPages<LoyverseInventoryLevel>(
    '/inventory_levels',
    'inventory_levels',
    { updated_since: updatedSince },
    20, // max 5 000 records — plenty for recent changes
  )

  const recentMap = new Map<string, number>()
  for (const level of recentLevels) {
    recentMap.set(`${level.variant_id}:${level.store_id}`, level.in_stock)
  }

  // For each relevant pair: live value if changed recently, otherwise cache
  const seen = new Set<string>()
  const result: Array<{ variantId: string; storeId: string; stock: number }> = []

  for (const req of pending) {
    for (const [variantId, storeId] of [
      [req.variantId, req.fromStoreId],
      [req.variantId, req.toStoreId],
    ] as [string, string][]) {
      const key = `${variantId}:${storeId}`
      if (seen.has(key)) continue
      seen.add(key)
      const live = recentMap.get(key)
      const stock = live !== undefined ? live : getCachedVariantStock(variantId, storeId)
      if (stock !== null) result.push({ variantId, storeId, stock })
    }
  }

  return result
}

const inFlightApprovals = new Set<string>()

export async function approveTransferRequest(
  requestId: string,
  reviewedBy = 'Admin',
): Promise<TransferRequest> {
  if (inFlightApprovals.has(requestId)) {
    throw new LoyverseApiError(`Request ${requestId} is already being processed`, 409)
  }
  inFlightApprovals.add(requestId)
  try {
    return await _doApprove(requestId, reviewedBy)
  } finally {
    inFlightApprovals.delete(requestId)
  }
}

async function _doApprove(requestId: string, reviewedBy: string): Promise<TransferRequest> {
  const existing = await findTransferRequestById(requestId)
  if (!existing) throw new LoyverseApiError(`Request not found: ${requestId}`, 404)
  if (existing.status !== 'pending') throw new LoyverseApiError(`Request already ${existing.status}`, 409)

  if (!isLoyverseConfigured()) {
    throw new LoyverseApiError('Loyverse is not configured', 503)
  }

  // Get current stock from cache (variantId → storeId indexed during last sync)
  // This avoids paging through 49,000 records to find a single variant+store record
  let fromStock = getCachedVariantStock(existing.variantId, existing.fromStoreId)
  let toStock   = getCachedVariantStock(existing.variantId, existing.toStoreId)

  // Cache miss — fall back to direct Loyverse fetch
  if (fromStock === null || toStock === null) {
    const product = {
      id: existing.itemId, variantId: existing.variantId,
      name: existing.itemName, sku: existing.sku,
      stocks: [] as { storeId: string; stock: number }[],
    }
    console.log(`[Transfer] Cache miss for variant ${existing.variantId} — fetching from Loyverse…`)
    const results = await Promise.all([
      fromStock === null ? resolveOldStock(product, existing.fromStoreId, 'loyverse', { maxPages: 500, retries: 2 }) : Promise.resolve(fromStock),
      toStock   === null ? resolveOldStock(product, existing.toStoreId,   'loyverse', { maxPages: 500, retries: 2 }) : Promise.resolve(toStock),
    ])
    fromStock = results[0]
    toStock   = results[1]
  }

  if (fromStock < existing.quantity) {
    throw new LoyverseApiError(
      `Insufficient stock at ${existing.fromStoreName}: has ${fromStock}, requested ${existing.quantity}`,
      400,
    )
  }

  const newFromStock = fromStock - existing.quantity
  const newToStock   = toStock + existing.quantity

  console.log(
    `[Transfer] Approve "${existing.itemName}": ${existing.fromStoreName} ${fromStock}→${newFromStock}, ${existing.toStoreName} ${toStock}→${newToStock}`,
  )

  // POST both stock updates to Loyverse in a single call
  await loyversePost<{ inventory_levels?: LoyverseInventoryLevel[] }>('/inventory', {
    inventory_levels: [
      { variant_id: existing.variantId, store_id: existing.fromStoreId, stock_after: newFromStock },
      { variant_id: existing.variantId, store_id: existing.toStoreId,   stock_after: newToStock  },
    ],
  })

  // Update cache in-place so next approval/lookup has correct values immediately
  updateCachedVariantStock([
    { variantId: existing.variantId, storeId: existing.fromStoreId, stock: newFromStock },
    { variantId: existing.variantId, storeId: existing.toStoreId,   stock: newToStock  },
  ])
  console.log(`[Transfer] Cache updated in-place: ${existing.fromStoreName}=${newFromStock}, ${existing.toStoreName}=${newToStock}`)

  const updated = await updateTransferRequestInDb(requestId, {
    status: 'approved',
    reviewedAt: new Date().toISOString(),
    reviewedBy,
  }, true)

  if (!updated) throw new LoyverseApiError(`Request already processed: ${requestId}`, 409)
  return updated
}

export async function rejectTransferRequest(
  requestId: string,
  reviewedBy = 'Admin',
  rejectionReason?: string,
): Promise<TransferRequest> {
  const existing = await findTransferRequestById(requestId)
  if (!existing) throw new LoyverseApiError(`Request not found: ${requestId}`, 404)
  if (existing.status !== 'pending') throw new LoyverseApiError(`Request already ${existing.status}`, 409)

  const updated = await updateTransferRequestInDb(requestId, {
    status: 'rejected',
    reviewedAt: new Date().toISOString(),
    reviewedBy,
    rejectionReason: rejectionReason?.trim() || undefined,
  }, true)

  if (!updated) throw new LoyverseApiError(`Request already processed: ${requestId}`, 409)
  return updated
}

export async function cancelTransferRequest(
  requestId: string,
  cancelledBy: string,
  isAdmin: boolean,
): Promise<TransferRequest> {
  const existing = await findTransferRequestById(requestId)
  if (!existing) throw new LoyverseApiError(`Request not found: ${requestId}`, 404)
  if (existing.status !== 'pending') throw new LoyverseApiError(`Request already ${existing.status}`, 409)
  if (!isAdmin && existing.requestedBy !== cancelledBy) {
    throw new LoyverseApiError('You can only cancel your own requests', 403)
  }

  const updated = await updateTransferRequestInDb(requestId, {
    status: 'cancelled',
    reviewedAt: new Date().toISOString(),
    reviewedBy: cancelledBy,
  }, true)

  if (!updated) throw new LoyverseApiError(`Request already processed: ${requestId}`, 409)
  return updated
}
