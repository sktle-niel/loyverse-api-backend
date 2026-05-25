import type { AuditRecord } from '../types/audit.js'
import type {
  LoyverseInventoryLevel,
  LoyverseItem,
  LoyverseStore,
} from '../types/loyverse.js'
import type { ProductDto, ProductsResult, StockUpdateInput, StoreInfo } from '../types/products.js'
import { appendRuntimeAudit } from '../data/runtimeAudit.js'
import { getMockProducts, MOCK_STORES, updateMockProduct } from '../data/mockProducts.js'
import {
  fetchAllPages,
  isLoyverseConfigured,
  loyversePost,
  LoyverseApiError,
} from './loyverseClient.js'

function levelKey(variantId: string, storeId: string): string {
  return `${variantId}::${storeId}`
}

function pickPrimaryVariant(item: LoyverseItem) {
  const variants = (item.variants ?? []).filter((v) => v.variant_id)
  if (variants.length === 0) return null
  return variants.find((v) => v.default) ?? variants[0]
}

function buildLevelMap(levels: LoyverseInventoryLevel[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const level of levels) {
    map.set(levelKey(level.variant_id, level.store_id), level.in_stock)
  }
  return map
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

async function fetchStores(): Promise<StoreInfo[]> {
  const stores = await fetchAllPages<LoyverseStore>('/stores', 'stores', {}, 5)
  return stores
    .filter((s) => !s.deleted_at)
    .map((s) => ({ id: s.id, name: s.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function getProducts(search?: string): Promise<ProductsResult> {
  if (!isLoyverseConfigured()) {
    return getMockProductsResult(search)
  }

  const [stores, items, levels] = await Promise.all([
    fetchStores(),
    fetchAllPages<LoyverseItem>('/items', 'items', {}, 20),
    fetchAllPages<LoyverseInventoryLevel>('/inventory', 'inventory_levels', {}, 20),
  ])

  const levelMap = buildLevelMap(levels)
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

  const q = search?.trim().toLowerCase()
  const filtered = q
    ? products.filter(
        (p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q),
      )
    : products

  return { products: filtered, stores, source: 'loyverse' }
}

function getMockProductsResult(search?: string): ProductsResult {
  const q = search?.trim().toLowerCase()
  let products = getMockProducts()
  if (q) {
    products = products.filter(
      (p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q),
    )
  }
  return { products, stores: MOCK_STORES, source: 'mock' }
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

export async function findProduct(itemId: string): Promise<{
  product: ProductDto
  stores: StoreInfo[]
  source: 'loyverse' | 'mock'
} | null> {
  const result = await getProducts()
  const product = result.products.find((p) => p.id === itemId)
  if (!product) return null
  return { product, stores: result.stores, source: result.source }
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
  if (!isLoyverseConfigured()) {
    return { stores: MOCK_STORES, source: 'mock' }
  }
  const stores = await fetchStores()
  return { stores, source: 'loyverse' }
}
