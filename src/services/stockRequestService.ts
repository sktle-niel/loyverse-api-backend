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
  resolveOldStock,
  validateStockUpdates,
} from './productsService.js'
import { getCachedVariantStock, updateCachedVariantStock } from './stockLevelsService.js'
import { sendPushToAll } from './pushService.js'

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
      maxPages: 300,
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
  // Keep submit fast: respond immediately, then enrich old stock and notify admins asynchronously.
  void backfillRequestOldStock(request.id, request.itemId, request.storeId)
  void sendPushToAll({
    title: 'New stock request',
    body: `${request.itemName} — ${request.storeName}: +${request.newStock} units`,
    url: '/approvals',
  })

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

// Prevents two concurrent approve calls for the same request from both writing to Loyverse.
const inFlightApprovals = new Set<string>()

// Per item+store mutex. Two DIFFERENT pending requests for the same item+store must not run their
// read-oldStock → write-Loyverse → patch-cache sequence at the same time, or one operator's change
// silently overwrites the other's (a lost update). Approvals for different items still run in
// parallel. Keyed by `${itemId}:${storeId}`.
const itemStockLocks = new Map<string, Promise<void>>()

async function withItemStockLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = itemStockLocks.get(key) ?? Promise.resolve()

  let release!: () => void
  const done = new Promise<void>((resolve) => { release = resolve })
  const tail = prev.then(() => done)
  itemStockLocks.set(key, tail)

  await prev.catch(() => {}) // wait our turn; a prior holder's failure is surfaced to its own caller
  try {
    return await fn()
  } finally {
    release()
    // If nobody queued behind us, drop the entry so the map can't grow without bound.
    if (itemStockLocks.get(key) === tail) {
      itemStockLocks.delete(key)
    }
  }
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

async function _doApprove(
  requestId: string,
  reviewedBy: string,
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

  // Serialize the read-modify-write of THIS item+store's stock level. While we wait our turn, a
  // queued approval for the same item may have just changed it — so re-read the request and the
  // stock INSIDE the lock and build on the freshest values.
  const lockKey = `${existing.itemId}:${existing.storeId}`
  return withItemStockLock(lockKey, async () => {
    const current = await getStockRequestById(requestId)
    if (!current) {
      throw new LoyverseApiError(`Request not found: ${requestId}`, 404)
    }
    if (current.status !== 'pending') {
      throw new LoyverseApiError(`Request already ${current.status}`, 409)
    }

    // Resolve the current stock that the operator's change is added onto. Prefer the in-memory
    // stock snapshot (the same source the transfer flow trusts) — it's instant and kept fresh
    // within ~15-20s. The old path paged Loyverse /inventory up to 300 times to find one record,
    // which is what made a single approval take 2-3 minutes. Fall back to that slow lookup only on
    // a genuine cache miss (e.g. a cold backend whose snapshot hasn't warmed up yet).
    const cachedOldStock =
      found.source === 'loyverse'
        ? getCachedVariantStock(found.product.variantId, current.storeId)
        : null
    const actualOldStock =
      cachedOldStock ??
      (await resolveOldStock(found.product, current.storeId, found.source, { maxPages: 300 }))

    // newStock stored on the request is the change amount entered by the operator (additive).
    // Compute the absolute stock level to write to Loyverse.
    const newAbsoluteStock = Math.round(Number(actualOldStock) + Number(current.newStock))

    console.log(
      `[Approve] ${current.itemName} @ ${current.storeName}: old=${actualOldStock} + change=${current.newStock} → new=${newAbsoluteStock}`,
    )

    const updates: StockUpdateInput[] = [
      {
        storeId: current.storeId,
        stock: newAbsoluteStock,
      },
    ]

    const oldStockMap = new Map([[current.storeId, actualOldStock]])
    const applied = await applyApprovedStockChanges(found.product, updates, reviewedBy, oldStockMap)

    // Patch the snapshot in place so the next approval/transfer reads the new level without
    // re-paging Loyverse (mirrors the transfer flow; see AGENTS.md "Do" list).
    if (found.source === 'loyverse') {
      updateCachedVariantStock([
        { variantId: found.product.variantId, storeId: current.storeId, stock: newAbsoluteStock },
      ])
    }

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
    }
  })
}

export async function cancelStockRequest(
  requestId: string,
  cancelledBy: string,
  isAdmin: boolean,
): Promise<StockChangeRequest> {
  const existing = await getStockRequestById(requestId)
  if (!existing) {
    throw new LoyverseApiError(`Request not found: ${requestId}`, 404)
  }
  if (existing.status !== 'pending') {
    throw new LoyverseApiError(`Request is already ${existing.status}`, 409)
  }
  if (!isAdmin && existing.requestedBy !== cancelledBy) {
    throw new LoyverseApiError('You can only cancel your own requests', 403)
  }

  const request = await updateStockRequest(
    requestId,
    {
      status: 'cancelled',
      reviewedAt: new Date().toISOString(),
      reviewedBy: cancelledBy,
    },
    true,
  )

  if (!request) {
    throw new LoyverseApiError(`Request already processed: ${requestId}`, 409)
  }

  return request
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
