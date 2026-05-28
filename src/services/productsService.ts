import type { AuditRecord } from '../types/audit.js'
import type {
  LoyverseInventoryLevel,
  LoyverseItem,
  LoyverseStore,
} from '../types/loyverse.js'
import type { ProductDto, ProductsResult, StockUpdateInput, StoreInfo } from '../types/products.js'
import { appendRuntimeAudit } from '../data/runtimeAudit.js'
import { getMockProducts, MOCK_STORES, updateMockProduct } from '../data/mockProducts.js'
import type { PaginatedResponse } from '../types/loyverse.js'
import {
  fetchAllPages,
  isLoyverseConfigured,
  loyverseFetch,
  loyversePost,
  LoyverseApiError,
} from './loyverseClient.js'
import {
  CATALOG_SCHEMA_VERSION,
  ensureCatalogLoaded,
  filterCatalogProducts,
  invalidateCatalogCache,
  registerCatalogLoader,
  type CatalogSnapshot,
} from './productsCatalogCache.js'

/** Loyverse store names excluded from inventory UI and stock edits */
const EXCLUDED_STORE_NAMES = new Set(['mobile store'])

function getFullCatalogMaxPages(): number {
  const n = Number(process.env.LOYVERSE_FULL_MAX_PAGES)
  if (Number.isFinite(n) && n >= 1 && n <= 200) return Math.floor(n)
  return 80
}

function getStockLookupMaxPages(): number {
  const n = Number(process.env.LOYVERSE_STOCK_LOOKUP_MAX_PAGES)
  if (Number.isFinite(n) && n >= 1) return Math.min(Math.floor(n), 200)
  return 50
}

function isExcludedStoreName(name: string): boolean {
  return EXCLUDED_STORE_NAMES.has(name.trim().toLowerCase())
}

function pickPrimaryVariant(item: LoyverseItem) {
  const variants = (item.variants ?? []).filter((v) => v.variant_id)
  if (variants.length === 0) return null
  return variants.find((v) => v.default) ?? variants[0]
}

function buildProductDto(item: LoyverseItem, variantId: string, sku: string): ProductDto {
  return {
    id: item.id,
    variantId,
    name: item.item_name,
    sku,
    stocks: [],
  }
}

function buildProductsFromItems(items: LoyverseItem[]): ProductDto[] {
  const products: ProductDto[] = []

  for (const item of items) {
    if (item.deleted_at) continue
    const variant = pickPrimaryVariant(item)
    if (!variant) continue

    products.push(buildProductDto(item, variant.variant_id, variant.sku ?? ''))
  }

  products.sort((a, b) => a.name.localeCompare(b.name))
  return products
}

async function fetchStores(): Promise<StoreInfo[]> {
  const stores = await fetchAllPages<LoyverseStore>('/stores', 'stores', {}, 5)
  return stores
    .filter((s) => !s.deleted_at && !isExcludedStoreName(s.name))
    .map((s) => ({ id: s.id, name: s.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Current stock for one variant at one branch (used on submit/approve, not during catalog load).
 * Loyverse returns inventory history; we keep the row with the latest `updated_at`.
 */
export async function fetchCurrentStockForVariant(
  variantId: string,
  storeId: string,
  options?: { retries?: number; logRetries?: boolean; maxPages?: number },
): Promise<number> {
  let latest: LoyverseInventoryLevel | null = null
  let cursor: string | undefined
  let previousCursor: string | undefined
  const maxPages = options?.maxPages ?? getStockLookupMaxPages()

  for (let page = 0; page < maxPages; page++) {
    const response = await loyverseFetch<PaginatedResponse<LoyverseInventoryLevel>>(
      '/inventory',
      {
        variant_id: variantId,
        store_id: storeId,
        limit: 250,
        cursor,
      },
      { retries: options?.retries, logRetries: options?.logRetries },
    )

    const batch = response.inventory_levels
    if (!Array.isArray(batch) || batch.length === 0) {
      break
    }

    for (const level of batch) {
      const prevTime = latest ? new Date(latest.updated_at).getTime() : -1
      const nextTime = new Date(level.updated_at).getTime()
      if (!latest || (Number.isFinite(nextTime) && nextTime >= prevTime)) {
        latest = level
      }
    }

    const nextCursor = typeof response.cursor === 'string' ? response.cursor : undefined
    if (!nextCursor || nextCursor === previousCursor) {
      break
    }
    previousCursor = nextCursor
    cursor = nextCursor
  }

  const inStock = latest ? Number(latest.in_stock) : 0
  return Number.isFinite(inStock) ? inStock : 0
}

async function loadFullCatalogFromLoyverse(): Promise<CatalogSnapshot> {
  const maxPages = getFullCatalogMaxPages()
  const stores = await fetchStores()

  console.log('[Products] Fetching items from Loyverse (catalog does not include per-branch stock)…')
  const items = await fetchAllPages<LoyverseItem>('/items', 'items', {}, maxPages)
  const products = buildProductsFromItems(items)

  console.log(`[Products] Catalog built: ${products.length} products, ${stores.length} branches`)

  return {
    products,
    stores,
    source: 'loyverse',
    loadedAt: new Date().toISOString(),
    catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
  }
}

function loadMockCatalog(): CatalogSnapshot {
  return {
    products: getMockProducts(),
    stores: MOCK_STORES,
    source: 'mock',
    loadedAt: new Date().toISOString(),
    catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
  }
}

async function loadCatalog(force: boolean): Promise<CatalogSnapshot> {
  if (force) {
    invalidateCatalogCache()
  }

  if (!isLoyverseConfigured()) {
    return loadMockCatalog()
  }

  return loadFullCatalogFromLoyverse()
}

registerCatalogLoader(loadCatalog)

export async function refreshProductsCatalog(): Promise<CatalogSnapshot> {
  return ensureCatalogLoaded(true)
}

export async function getProducts(
  search?: string,
  options?: { refresh?: boolean },
): Promise<ProductsResult> {
  const catalog = await ensureCatalogLoaded(options?.refresh ?? false)
  const q = search?.trim() ?? ''
  const products = q ? filterCatalogProducts(catalog.products, q) : catalog.products

  const loadedLabel = new Date(catalog.loadedAt).toLocaleString()

  return {
    products,
    stores: catalog.stores,
    source: catalog.source,
    catalogTotal: catalog.products.length,
    cachedAt: catalog.loadedAt,
    catalogNote:
      q.length > 0
        ? `Showing ${products.length} of ${catalog.products.length} loaded items (cached ${loadedLabel}).`
        : `${catalog.products.length} items from Loyverse (cached ${loadedLabel}). Select a branch and enter stock when submitting a change.`,
  }
}

export async function findProduct(itemId: string): Promise<{
  product: ProductDto
  stores: StoreInfo[]
  source: 'loyverse' | 'mock'
} | null> {
  const catalog = await ensureCatalogLoaded(false)
  const product = catalog.products.find((p) => p.id === itemId)
  if (!product) return null
  return { product, stores: catalog.stores, source: catalog.source }
}

export async function resolveOldStock(
  product: ProductDto,
  storeId: string,
  source: 'loyverse' | 'mock',
  options?: { retries?: number; logRetries?: boolean; maxPages?: number },
): Promise<number> {
  if (source === 'loyverse' && isLoyverseConfigured()) {
    return fetchCurrentStockForVariant(product.variantId, storeId, options)
  }
  return product.stocks.find((s) => s.storeId === storeId)?.stock ?? 0
}

export function validateStockUpdates(
  updates: StockUpdateInput[],
  storeIds: Set<string>,
): void {
  if (updates.length !== 1) {
    throw new LoyverseApiError('Submit one branch at a time: { storeId, stock }', 400)
  }

  for (const u of updates) {
    if (!u.storeId?.trim()) {
      throw new LoyverseApiError('storeId is required', 400)
    }
    if (!storeIds.has(u.storeId)) {
      throw new LoyverseApiError(`Unknown store: ${u.storeId}`, 400)
    }
    if (!Number.isInteger(u.stock) || u.stock < 0) {
      throw new LoyverseApiError('stock must be a whole number ≥ 0', 400)
    }
  }
}

/** Called only when admin approves — writes to Loyverse (or mock) and creates audit rows. */
export async function applyApprovedStockChanges(
  product: ProductDto,
  updates: StockUpdateInput[],
  adminName: string,
  oldStockForBranch: Map<string, number>,
): Promise<{ product: ProductDto; auditRecords: AuditRecord[]; source: 'loyverse' | 'mock' }> {
  if (!isLoyverseConfigured()) {
    return applyMockStockChanges(product, updates, adminName)
  }

  const levelUpdates: { variant_id: string; store_id: string; in_stock: number }[] = []
  const auditRecords: AuditRecord[] = []
  const now = new Date().toISOString()

  for (const u of updates) {
    const oldStock = oldStockForBranch.get(u.storeId) ?? 0
    const newStock = u.stock
    if (newStock === oldStock) continue

    levelUpdates.push({
      variant_id: product.variantId,
      store_id: u.storeId,
      in_stock: newStock,
    })

    auditRecords.push({
      id: `${product.id}-${u.storeId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      itemName: product.name,
      adminName,
      branchId: u.storeId,
      oldStock,
      newStock,
      changeAmount: newStock - oldStock,
      timestamp: now,
    })
  }

  if (levelUpdates.length === 0) {
    return { product, auditRecords: [], source: 'loyverse' }
  }

  await loyversePost<{ inventory_levels?: LoyverseInventoryLevel[] }>('/inventory', {
    inventory_levels: levelUpdates,
  })

  appendRuntimeAudit(auditRecords)

  return { product, auditRecords, source: 'loyverse' }
}

function applyMockStockChanges(
  product: ProductDto,
  updates: StockUpdateInput[],
  adminName: string,
): { product: ProductDto; auditRecords: AuditRecord[]; source: 'mock' } {
  const previous = getMockProducts().find((p) => p.id === product.id) ?? product
  const updated = updateMockProduct(product.id, updates)
  if (!updated) {
    throw new LoyverseApiError(`Product not found: ${product.id}`, 404)
  }

  const auditRecords: AuditRecord[] = []
  const now = new Date().toISOString()

  for (const u of updates) {
    const oldStock = previous.stocks.find((s) => s.storeId === u.storeId)?.stock ?? 0
    if (oldStock === u.stock) continue

    auditRecords.push({
      id: `${product.id}-${u.storeId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      itemName: product.name,
      adminName,
      branchId: u.storeId,
      oldStock,
      newStock: u.stock,
      changeAmount: u.stock - oldStock,
      timestamp: now,
    })
  }

  appendRuntimeAudit(auditRecords)
  return { product: updated, auditRecords, source: 'mock' }
}

export async function getStores(): Promise<{ stores: StoreInfo[]; source: 'loyverse' | 'mock' }> {
  const catalog = await ensureCatalogLoaded(false)
  return { stores: catalog.stores, source: catalog.source }
}
