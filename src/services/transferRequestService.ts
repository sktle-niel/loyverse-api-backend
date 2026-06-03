import type { TransferRequest, SubmitTransferBody } from '../types/transferRequest.js'
import {
  insertTransferRequest,
  findTransferRequestById,
  listTransferRequestsFromDb,
  updateTransferRequestInDb,
} from '../repositories/transferRequestRepository.js'
import { findProduct, resolveOldStock, applyApprovedStockChanges } from './productsService.js'
import { LoyverseApiError } from './loyverseClient.js'
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
    fromStockBefore: null,
    toStockBefore: null,
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
  return listTransferRequestsFromDb(status as any)
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

  const found = await findProduct(existing.itemId)
  if (!found) throw new LoyverseApiError(`Product not found: ${existing.itemId}`, 404)

  // Fetch live stock at both stores before making changes
  const [fromStock, toStock] = await Promise.all([
    resolveOldStock(found.product, existing.fromStoreId, found.source, { maxPages: 300 }),
    resolveOldStock(found.product, existing.toStoreId, found.source, { maxPages: 300 }),
  ])

  if (fromStock < existing.quantity) {
    throw new LoyverseApiError(
      `Insufficient stock at ${existing.fromStoreName}: has ${fromStock}, requested ${existing.quantity}`,
      400,
    )
  }

  const newFromStock = fromStock - existing.quantity
  const newToStock = toStock + existing.quantity

  console.log(
    `[Transfer] Approve "${existing.itemName}": ${existing.fromStoreName} ${fromStock}→${newFromStock}, ${existing.toStoreName} ${toStock}→${newToStock}`,
  )

  await applyApprovedStockChanges(
    found.product,
    [
      { storeId: existing.fromStoreId, stock: newFromStock },
      { storeId: existing.toStoreId, stock: newToStock },
    ],
    reviewedBy,
    new Map([
      [existing.fromStoreId, fromStock],
      [existing.toStoreId, toStock],
    ]),
  )

  const updated = await updateTransferRequestInDb(requestId, {
    status: 'approved',
    reviewedAt: new Date().toISOString(),
    reviewedBy,
    fromStockBefore: fromStock,
    toStockBefore: toStock,
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
