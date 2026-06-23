import type { CategoryDto, CreateItemInput, ExportItemRow, ExportItemsResult } from '../types/items.js'
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

  // Advance the cached next-SKU preview so the next "Add another" shows the right number instantly,
  // with no extra Loyverse round-trip. Loyverse never reuses a SKU, so next = assigned + 1.
  bumpNextSkuCache(assignedSku)

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

interface LoyverseExportVariant {
  variant_id?: string
  sku?: string
  cost?: number | null
  default?: boolean
}
interface LoyverseExportItem {
  id: string
  item_name: string
  handle?: string
  category_id?: string | null
  deleted_at?: string | null
  variants?: LoyverseExportVariant[]
}

function exportMaxPages(): number {
  const n = Number(process.env.LOYVERSE_FULL_MAX_PAGES)
  if (Number.isFinite(n) && n >= 1 && n <= 200) return Math.floor(n)
  return 80
}

/**
 * Builds the Inventory export dataset: in-stock items only (stock > 0 in at least one branch),
 * each with handle, sku, name, category, cost, and per-store in-stock quantity.
 */
export async function getExportItems(): Promise<ExportItemsResult> {
  const { result } = await getStockLevels(false)
  const stores = result.stores

  if (!isLoyverseConfigured()) {
    return { stores, items: [] }
  }

  const [rawItems, categories] = await Promise.all([
    fetchAllPages<LoyverseExportItem>('/items', 'items', {}, exportMaxPages()),
    getCategories(),
  ])

  const categoryName = new Map(categories.map((c) => [c.id, c.name]))

  // Per-item per-store stock from the in-memory stock cache (summed across variants).
  const stockByItem = new Map<string, Map<string, number>>()
  for (const p of result.products) {
    stockByItem.set(p.id, new Map(p.stocks.map((s) => [s.storeId, s.stock])))
  }

  const rows: ExportItemRow[] = []
  for (const item of rawItems) {
    if (item.deleted_at) continue
    const variants = (item.variants ?? []).filter((v) => v.variant_id)
    const variant = variants.find((v) => v.default) ?? variants[0]

    const storeStock = stockByItem.get(item.id)
    const total = storeStock ? [...storeStock.values()].reduce((a, b) => a + b, 0) : 0
    if (total <= 0) continue // in-stock items only

    const cost = variant?.cost
    rows.push({
      handle: item.handle ?? '',
      sku: variant?.sku ?? '',
      name: item.item_name,
      category: item.category_id ? categoryName.get(item.category_id) ?? '' : '',
      cost: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
      stocks: stores.map((s) => ({
        storeId: s.id,
        storeName: s.name,
        inStock: storeStock?.get(s.id) ?? 0,
      })),
    })
  }

  rows.sort((a, b) => a.name.localeCompare(b.name))
  return { stores, items: rows }
}

// ---- Next-SKU preview (Add Item form) ----
// Loyverse has no "next SKU" endpoint, so we predict it the way the Back Office does: highest
// numeric SKU + 1. We scan EVERY variant of EVERY item — including non-default variants and deleted
// items, since Loyverse's auto-SKU counter never reuses a deleted number — so the preview matches
// what Loyverse actually assigns. Still display-only: the field is sent blank on create, so Loyverse
// stays the source of truth and duplicates are impossible.

interface SkuScanItem {
  variants?: Array<{ sku?: string | null }>
}

const NEXT_SKU_TTL_MS = 60_000
let nextSkuCache: { value: number; computedAt: number } | null = null

function maxNumericSku(items: SkuScanItem[]): number {
  let max = 0
  for (const item of items) {
    for (const v of item.variants ?? []) {
      const raw = (v?.sku ?? '').trim()
      if (!/^\d+$/.test(raw)) continue
      const n = Number(raw)
      if (Number.isFinite(n) && n > max) max = n
    }
  }
  return max
}

/** After a create, advance the cached preview to assignedSku + 1 — no refetch needed. */
function bumpNextSkuCache(assignedSku: string | undefined | null): void {
  const raw = (assignedSku ?? '').trim()
  if (!/^\d+$/.test(raw)) {
    nextSkuCache = null // unknown/custom SKU → recompute from Loyverse next time
    return
  }
  const candidate = Number(raw) + 1
  if (!nextSkuCache || candidate > nextSkuCache.value) {
    nextSkuCache = { value: candidate, computedAt: Date.now() }
  }
}

async function computeMaxLoyverseSku(): Promise<number> {
  // Straight from Loyverse (not the catalog cache) so we see all variants + deleted items.
  try {
    const items = await fetchAllPages<SkuScanItem>('/items', 'items', { show_deleted: 'true' }, exportMaxPages())
    return maxNumericSku(items)
  } catch (err) {
    console.warn('[Items] next-SKU: show_deleted fetch failed, retrying without it:', (err as Error).message)
  }
  try {
    const items = await fetchAllPages<SkuScanItem>('/items', 'items', {}, exportMaxPages())
    return maxNumericSku(items)
  } catch (err) {
    console.warn('[Items] next-SKU: live fetch failed, falling back to catalog cache:', (err as Error).message)
  }
  // Last resort: catalog cache (default-variant SKUs only).
  const catalog = await ensureCatalogLoaded(false)
  return maxNumericSku(catalog.products.map((p) => ({ variants: [{ sku: p.sku }] })))
}

/**
 * Predicts the SKU Loyverse will auto-assign to the next new item, matching Loyverse's own
 * numbering as closely as the API allows. Display-only preview for the Add Item form — the real SKU
 * is still assigned by Loyverse on create (field sent blank), so this never causes a duplicate.
 * Floors at 10000 (Loyverse's auto-SKU start). Cached briefly to avoid hammering Loyverse.
 */
export async function getNextSku(): Promise<string> {
  if (!isLoyverseConfigured()) return '10000'

  if (nextSkuCache && Date.now() - nextSkuCache.computedAt < NEXT_SKU_TTL_MS) {
    return String(nextSkuCache.value).padStart(5, '0')
  }

  const max = await computeMaxLoyverseSku()
  const next = max >= 10000 ? max + 1 : 10000
  nextSkuCache = { value: next, computedAt: Date.now() }
  return String(next).padStart(5, '0')
}
