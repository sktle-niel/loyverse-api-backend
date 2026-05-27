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

function isExcludedStoreName(name: string): boolean {
  return EXCLUDED_STORE_NAMES.has(name.trim().toLowerCase())
}

function levelKey(variantId: string, storeId: string): string {
  return `${variantId}::${storeId}`
}

function pickPrimaryVariant(item: LoyverseItem) {
  const variants = (item.variants ?? []).filter((v) => v.variant_id)
  if (variants.length === 0) return null
  return variants.find((v) => v.default) ?? variants[0]
}

function mergeInventoryBatch(
  latestByKey: Map<string, LoyverseInventoryLevel>,
  batch: LoyverseInventoryLevel[],
): void {
  for (const level of batch) {
    const variantId = String(level.variant_id ?? '')
    const storeId = String(level.store_id ?? '')
    if (!variantId || !storeId) continue

    const key = levelKey(variantId, storeId)
    const prev = latestByKey.get(key)
    const prevTime = prev ? new Date(prev.updated_at).getTime() : -1
    const nextTime = new Date(level.updated_at).getTime()

    if (!prev || (Number.isFinite(nextTime) && nextTime >= prevTime)) {
      latestByKey.set(key, level)
    }
  }
}

function latestLevelsToStockMap(latestByKey: Map<string, LoyverseInventoryLevel>): Map<string, number> {
  const map = new Map<string, number>()
  for (const [key, level] of latestByKey) {
    const inStock = Number(level.in_stock)
    map.set(key, Number.isFinite(inStock) ? inStock : 0)
  }
  return map
}

/** Per-store inventory pagination; dedupe history rows as each page arrives. */
async function buildStockLevelMapForStores(
  stores: StoreInfo[],
  maxPagesPerStore: number,
): Promise<Map<string, number>> {
  const latestByKey = new Map<string, LoyverseInventoryLevel>()

  for (const store of stores) {
    let cursor: string | undefined
    let previousCursor: string | undefined

    for (let page = 0; page < maxPagesPerStore; page++) {
      const response = await loyverseFetch<PaginatedResponse<LoyverseInventoryLevel>>('/inventory', {
        store_id: store.id,
        limit: 250,
        cursor,
      })

      const batch = response.inventory_levels
      if (Array.isArray(batch) && batch.length > 0) {
        mergeInventoryBatch(latestByKey, batch)
      } else {
        break
      }

      const nextCursor = typeof response.cursor === 'string' ? response.cursor : undefined
      if (!nextCursor || nextCursor === previousCursor) break
      previousCursor = nextCursor
      cursor = nextCursor
    }
  }

  return latestLevelsToStockMap(latestByKey)
}

function buildProductDto(
  item: LoyverseItem,
  variantId: string,
  sku: string,
  stores: StoreInfo[],
  levelMap: Map<string, number>,
): ProductDto {
  return {
    id: item.id,
    variantId,
    name: item.item_name,
    sku,
    stocks: stores.map((store) => ({
      storeId: store.id,
      stock: levelMap.get(levelKey(variantId, store.id)) ?? 0,
    })),
  }
}

function buildProductsFromItems(
  items: LoyverseItem[],
  stores: StoreInfo[],
  levelMap: Map<string, number>,
): ProductDto[] {
  const products: ProductDto[] = []

  for (const item of items) {
    if (item.deleted_at) continue
    const variant = pickPrimaryVariant(item)
    if (!variant) continue

    products.push(
      buildProductDto(item, variant.variant_id, variant.sku ?? '', stores, levelMap),
    )
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

async function loadFullCatalogFromLoyverse(): Promise<CatalogSnapshot> {
  const maxPages = getFullCatalogMaxPages()
  const stores = await fetchStores()

  console.log('[Products] Fetching items from Loyverse…')
  const items = await fetchAllPages<LoyverseItem>('/items', 'items', {}, maxPages)

  const inventoryPages = Math.min(maxPages, Math.max(5, Math.ceil(items.length / 250) + 2))
  console.log(
    `[Products] Fetching inventory for ${stores.length} stores (${inventoryPages} pages/store max)…`,
  )

  const levelMap = await buildStockLevelMapForStores(stores, inventoryPages)
  const products = buildProductsFromItems(items, stores, levelMap)

  const withStock = products.filter((p) => p.stocks.some((s) => s.stock > 0)).length
  console.log(
    `[Products] Catalog built: ${products.length} products, ${levelMap.size} stock cells, ${withStock} products with stock > 0`,
  )

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
        : `${catalog.products.length} items loaded from Loyverse (cached ${loadedLabel}). Search filters instantly.`,
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

function buildAuditRecords(
  product: ProductDto,
  previous: ProductDto,
  adminName: string,
): AuditRecord[] {
  const records: AuditRecord[] = []
  const now = new Date().toISOString()

  for (const next of product.stocks) {
    const prev = previous.stocks.find((s) => s.storeId === next.storeId)
    const oldStock = prev?.stock ?? 0
    if (oldStock === next.stock) continue

    records.push({
      id: `${product.id}-${next.storeId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      itemName: product.name,
      adminName,
      branchId: next.storeId,
      oldStock,
      newStock: next.stock,
      changeAmount: next.stock - oldStock,
      timestamp: now,
    })
  }

  return records
}

export function validateStockUpdates(
  updates: StockUpdateInput[],
  storeIds: Set<string>,
): void {
  for (const u of updates) {
    if (!storeIds.has(u.storeId)) {
      throw new LoyverseApiError(`Unknown store: ${u.storeId}`, 400)
    }
    if (!Number.isInteger(u.stock) || u.stock < 0) {
      throw new LoyverseApiError(`Invalid stock for store ${u.storeId}`, 400)
    }
  }
}

/** Called only when admin approves — writes to Loyverse (or mock) and creates audit rows. */
export async function applyApprovedStockChanges(
  product: ProductDto,
  updates: StockUpdateInput[],
  adminName: string,
): Promise<{ product: ProductDto; auditRecords: AuditRecord[]; source: 'loyverse' | 'mock' }> {
  if (!isLoyverseConfigured()) {
    return applyMockStockChanges(product, updates, adminName)
  }

  const previous = { ...product, stocks: product.stocks.map((s) => ({ ...s })) }
  const levelUpdates: { variant_id: string; store_id: string; in_stock: number }[] = []
  const nextStocks = previous.stocks.map((cell) => ({ ...cell }))

  for (const u of updates) {
    const cell = nextStocks.find((s) => s.storeId === u.storeId)
    if (!cell || cell.stock === u.stock) continue
    cell.stock = u.stock
    levelUpdates.push({
      variant_id: product.variantId,
      store_id: u.storeId,
      in_stock: u.stock,
    })
  }

  if (levelUpdates.length === 0) {
    return { product: previous, auditRecords: [], source: 'loyverse' }
  }

  await loyversePost<{ inventory_levels?: LoyverseInventoryLevel[] }>('/inventory', {
    inventory_levels: levelUpdates,
  })

  const updated: ProductDto = { ...product, stocks: nextStocks }
  const auditRecords = buildAuditRecords(updated, previous, adminName)
  appendRuntimeAudit(auditRecords)

  return { product: updated, auditRecords, source: 'loyverse' }
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
  const auditRecords = buildAuditRecords(updated, previous, adminName)
  appendRuntimeAudit(auditRecords)
  return { product: updated, auditRecords, source: 'mock' }
}

export async function getStores(): Promise<{ stores: StoreInfo[]; source: 'loyverse' | 'mock' }> {
  const catalog = await ensureCatalogLoaded(false)
  return { stores: catalog.stores, source: catalog.source }
}
