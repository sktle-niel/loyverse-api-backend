import type { CategoryDto, CreateItemInput } from '../types/items.js'
import type { StockLevelProduct, StoreInfo } from '../types/products.js'
import {
  fetchAllPages,
  isLoyverseConfigured,
  loyverseDelete,
  loyversePost,
  LoyverseApiError,
} from './loyverseClient.js'
import { ensureCatalogLoaded, invalidateCatalogCache } from './productsCatalogCache.js'
import { invalidatePricingCache } from './pricingService.js'
import { getStockLevels } from './stockLevelsService.js'
import { insertCreatedItem, listCreatedItems } from '../repositories/createdItemRepository.js'
import type { CreatedItemRecord } from '../types/createdItem.js'
import { insertDeletedItem, listDeletedItems } from '../repositories/deletedItemRepository.js'
import type { DeletedItemRecord } from '../types/deletedItem.js'

interface LoyverseCategory {
  id: string
  name: string
  deleted_at?: string | null
}

const VALID_COLORS = new Set([
  'GREY', 'RED', 'PINK', 'ORANGE', 'YELLOW', 'GREEN', 'BLUE', 'PURPLE',
])
const VALID_FORMS = new Set(['SQUARE', 'CIRCLE', 'SCALLOPED', 'HEXAGON'])

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Loyverse categories for the "Category" dropdown. */
export async function getCategories(): Promise<CategoryDto[]> {
  if (!isLoyverseConfigured()) return []
  const cats = await fetchAllPages<LoyverseCategory>('/categories', 'categories', {}, 10)
  return cats
    .filter((c) => !c.deleted_at && c.id)
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Creates a new product in Loyverse (POST /items) mirroring the Back Office "Create item" form.
 * This is a create (no id), so it never overwrites existing data — a bad payload is rejected.
 */
export async function createItem(
  input: CreateItemInput,
  createdBy = 'Operator',
): Promise<{ id?: string; itemName: string; sku?: string }> {
  if (!isLoyverseConfigured()) throw new LoyverseApiError('Loyverse is not configured', 503)

  const name = input.name?.trim()
  if (!name) throw new LoyverseApiError('Item name is required', 400)

  const cost = toNum(input.cost) ?? 0
  if (cost < 0) throw new LoyverseApiError('Cost must be ≥ 0', 400)

  const defaultPrice = toNum(input.defaultPrice)

  // Build per-store pricing/availability lines.
  // FIXED only when there's an actual price; otherwise VARIABLE (price entered upon sale).
  const stores = (input.stores ?? []).map((s) => {
    const finalPrice = toNum(s.price) ?? defaultPrice
    return {
      store_id: s.storeId,
      pricing_type: finalPrice != null ? ('FIXED' as const) : ('VARIABLE' as const),
      price: finalPrice,
      available_for_sale: !!s.available,
    }
  })

  const variant: Record<string, unknown> = {
    cost,
    default_price: defaultPrice,
    default_pricing_type: defaultPrice != null ? 'FIXED' : 'VARIABLE',
    stores,
  }
  if (input.sku?.trim()) variant.sku = input.sku.trim()
  if (input.barcode?.trim()) variant.barcode = input.barcode.trim()

  const payload: Record<string, unknown> = {
    item_name: name,
    sold_by_weight: !!input.soldByWeight,
    track_stock: !!input.trackStock,
    is_composite: false,
    variants: [variant],
  }
  if (input.categoryId) payload.category_id = input.categoryId
  if (input.description?.trim()) payload.description = input.description.trim()
  if (input.color && VALID_COLORS.has(input.color)) payload.color = input.color
  if (input.form && VALID_FORMS.has(input.form)) payload.form = input.form

  console.log(`[Items] Creating item "${name}" (${stores.length} stores)`)
  const created = await loyversePost<{
    id?: string
    item_name?: string
    variants?: Array<{ sku?: string; default?: boolean }>
  }>('/items', payload)

  // New item → refresh caches so it shows up in the catalog / price list.
  invalidateCatalogCache()
  invalidatePricingCache()

  // Loyverse echoes back the created item with the SKU it auto-assigned (or the one we sent).
  const assignedSku = (created?.variants?.find((v) => v.default) ?? created?.variants?.[0])?.sku

  // Log to MySQL for record-keeping (non-fatal — the Loyverse item already exists).
  const record: CreatedItemRecord = {
    id: `ci-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    itemId: created?.id ?? '',
    itemName: created?.item_name ?? name,
    sku: assignedSku ?? (input.sku?.trim() || ''),
    categoryId: input.categoryId ?? null,
    cost,
    defaultPrice,
    trackStock: !!input.trackStock,
    soldByWeight: !!input.soldByWeight,
    stores: (input.stores ?? []).map((s) => ({
      storeId: s.storeId,
      available: !!s.available,
      price: toNum(s.price),
    })),
    createdBy,
    createdAt: new Date().toISOString(),
  }
  try {
    await insertCreatedItem(record)
  } catch (err) {
    console.warn('[Items] Item created in Loyverse but failed to log to DB:', (err as Error).message)
  }

  return { id: created?.id, itemName: created?.item_name ?? name, sku: assignedSku }
}

/** Recent items created via the Add Item form (newest first). */
export async function getCreatedItems(limit = 100): Promise<CreatedItemRecord[]> {
  return listCreatedItems(limit)
}

/**
 * Items that are safe to delete: stock is exactly 0 in EVERY branch.
 * Uses the in-memory stock cache (same data shown on the Stock Levels page).
 */
export async function getDeletableItems(): Promise<{
  items: StockLevelProduct[]
  stores: StoreInfo[]
  total: number
}> {
  const { result } = await getStockLevels(false)
  const items = result.products.filter(
    (p) => p.stocks.length > 0 && p.stocks.every((s) => s.stock === 0),
  )
  return { items, stores: result.stores, total: items.length }
}

/**
 * Deletes an item from Loyverse — but only if it has 0 stock in every branch.
 * Re-verifies stock at delete time (cache may have changed since the list was loaded),
 * so an item that gained stock after listing is never deleted.
 */
export async function deleteItem(
  itemId: string,
  deletedBy = 'Operator',
): Promise<{ itemId: string; itemName: string }> {
  if (!isLoyverseConfigured()) throw new LoyverseApiError('Loyverse is not configured', 503)
  if (!itemId) throw new LoyverseApiError('itemId is required', 400)

  const { result } = await getStockLevels(false)
  const product = result.products.find((p) => p.id === itemId)
  if (!product) {
    throw new LoyverseApiError('Item not found or not yet synced. Refresh and try again.', 404)
  }

  const nonZero = product.stocks.filter((s) => s.stock !== 0)
  if (nonZero.length > 0) {
    const where = nonZero.map((s) => `${s.storeName}: ${s.stock}`).join(', ')
    throw new LoyverseApiError(
      `Cannot delete "${product.name}" — stock is not zero in all branches (${where}). Only items with 0 stock everywhere can be deleted.`,
      409,
    )
  }

  await loyverseDelete(`/items/${itemId}`)

  // Drop catalog/pricing caches so the deleted item disappears from lists on next load.
  invalidateCatalogCache()
  invalidatePricingCache()

  // Log to MySQL for record-keeping (non-fatal — the Loyverse delete already happened).
  const record: DeletedItemRecord = {
    id: `di-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    itemId,
    itemName: product.name,
    sku: product.sku,
    deletedBy,
    createdAt: new Date().toISOString(),
  }
  try {
    await insertDeletedItem(record)
  } catch (err) {
    console.warn('[Items] Item deleted in Loyverse but failed to log to DB:', (err as Error).message)
  }

  console.log(`[Items] Deleted item "${product.name}" (${itemId}) by ${deletedBy}`)
  return { itemId, itemName: product.name }
}

/** Recent items deleted via the Delete Item page (newest first). */
export async function getDeletedItems(limit = 100): Promise<DeletedItemRecord[]> {
  return listDeletedItems(limit)
}

/**
 * Predicts the SKU Loyverse will auto-assign to the next new item (highest numeric SKU + 1).
 * Display-only preview for the Add Item form — the real SKU is still generated by Loyverse on
 * create (sent blank), so this never causes a duplicate. Falls back to 10000 (Loyverse's start).
 */
export async function getNextSku(): Promise<string> {
  const catalog = await ensureCatalogLoaded(false)
  let max = 0
  for (const p of catalog.products) {
    const raw = (p.sku ?? '').trim()
    if (!/^\d+$/.test(raw)) continue
    const n = Number(raw)
    if (Number.isFinite(n) && n > max) max = n
  }
  return String(max > 0 ? max + 1 : 10000)
}
