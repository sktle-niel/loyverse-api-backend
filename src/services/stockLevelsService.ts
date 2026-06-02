import fs from 'node:fs/promises'
import path from 'node:path'
import type { LoyverseInventoryLevel } from '../types/loyverse.js'
import type { StockLevelProduct, StockLevelsResult } from '../types/products.js'
import { fetchAllPages, isLoyverseConfigured } from './loyverseClient.js'
import { ensureCatalogLoaded } from './productsCatalogCache.js'
import { getMockProducts, MOCK_STORES } from '../data/mockProducts.js'

const CACHE_FILE = path.join(process.cwd(), '.stock_cache.json')
const STOCK_TTL_MS = 5 * 60 * 1000
const CACHE_VERSION = 3 // bumped — now uses all-variants mapping

interface StockSnapshot {
  result: StockLevelsResult
  loadedAt: number
  cacheVersion: number
}

let snapshot: StockSnapshot | null = null
let loadPromise: Promise<StockLevelsResult> | null = null
let isBackgroundLoading = false

// ── Disk cache ────────────────────────────────────────────────────────────────

async function readCache(): Promise<StockSnapshot | null> {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf8')
    const parsed = JSON.parse(raw) as StockSnapshot
    if (parsed?.result?.products && parsed?.loadedAt && parsed?.cacheVersion === CACHE_VERSION) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

async function writeCache(s: StockSnapshot): Promise<void> {
  try {
    await fs.writeFile(CACHE_FILE, JSON.stringify(s), 'utf8')
  } catch (err) {
    console.error('[StockLevels] Failed to write disk cache:', err)
  }
}

async function deleteCache(): Promise<void> {
  try { await fs.unlink(CACHE_FILE) } catch { /* ok */ }
}

// ── Core fetch ────────────────────────────────────────────────────────────────

async function fetchFromLoyverse(): Promise<StockLevelsResult> {
  const catalog = await ensureCatalogLoaded(false)
  const storeNameById = new Map(catalog.stores.map((s) => [s.id, s.name]))
  const knownStoreIds = new Set(catalog.stores.map((s) => s.id))

  // Use the variant_id → item_id map built during catalog load (no extra Loyverse fetch needed).
  const variantToItemId = new Map(Object.entries(catalog.variantIdToItemId ?? {}))
  const itemIdToProduct = new Map(catalog.products.map((p) => [p.id, p]))

  console.log(`[StockLevels] Variant map: ${variantToItemId.size} variant_ids → ${itemIdToProduct.size} products`)

  // Fetch ALL inventory levels — single bulk pass.
  // Loyverse ignores store_id/variant_id query params so we must fetch everything.
  // maxPages=500 covers up to 125,000 records (safe for stores with thousands of products).
  console.log('[StockLevels] Fetching inventory levels…')
  const levels = await fetchAllPages<LoyverseInventoryLevel>(
    '/inventory',
    'inventory_levels',
    {},
    500,
  )

  console.log(`[StockLevels] Total inventory records fetched: ${levels.length}`)

  // Debug: log a few sample records + variant map hits
  if (levels.length > 0) {
    const sample = levels.slice(0, 5)
    console.log('[StockLevels] Sample inventory records:',
      sample.map(l => ({
        variant_id: l.variant_id,
        store_id: l.store_id,
        in_stock: l.in_stock,
        item_id: variantToItemId.get(l.variant_id) ?? 'NOT FOUND',
      }))
    )
  }

  // Group: itemId → storeId → stock
  const stockMap = new Map<string, Map<string, number>>()
  let matched = 0
  let skippedVariant = 0
  let skippedStore = 0

  for (const level of levels) {
    const itemId = variantToItemId.get(level.variant_id)
    if (!itemId) { skippedVariant++; continue }

    const product = itemIdToProduct.get(itemId)
    if (!product) { skippedVariant++; continue }

    if (!knownStoreIds.has(level.store_id)) { skippedStore++; continue }

    if (!stockMap.has(product.id)) stockMap.set(product.id, new Map())
    // If multiple variants exist, sum their stock for the same store
    const existing = stockMap.get(product.id)!.get(level.store_id) ?? 0
    stockMap.get(product.id)!.set(level.store_id, existing + Math.round(Number(level.in_stock)))
    matched++
  }

  console.log(
    `[StockLevels] Matched: ${matched} | Skipped (unknown variant): ${skippedVariant} | Skipped (excluded store): ${skippedStore}`
  )
  console.log(`[StockLevels] Products with stock data: ${stockMap.size}`)

  const allProducts: StockLevelProduct[] = catalog.products.map((p) => ({
    id: p.id,
    variantId: p.variantId,
    name: p.name,
    sku: p.sku,
    stocks: catalog.stores.map((s) => ({
      storeId: s.id,
      storeName: storeNameById.get(s.id) ?? s.id,
      stock: stockMap.get(p.id)?.get(s.id) ?? 0,
    })),
  }))

  // Only keep items where at least one store has MORE than 2 units.
  // Items with 0 or <= 2 across all stores have nothing worth transferring.
  const MIN_STOCK_FOR_TRANSFER = 2
  const products = allProducts.filter(p => p.stocks.some(s => s.stock > MIN_STOCK_FOR_TRANSFER))

  console.log(
    `[StockLevels] Transferable items (any store > ${MIN_STOCK_FOR_TRANSFER}): ${products.length} of ${allProducts.length}`
  )

  // Log a sample for verification
  const sample = products[0]
  if (sample) {
    console.log('[StockLevels] Sample transferable product:', {
      name: sample.name,
      stocks: sample.stocks,
    })
  } else {
    console.warn('[StockLevels] WARNING: No transferable products found! Check variant_id mapping or stock levels.')
  }

  return {
    products,
    stores: catalog.stores,
    total: products.length,
    source: 'loyverse',
    cachedAt: new Date().toISOString(),
  }
}

function buildMockResult(): StockLevelsResult {
  const mockProducts = getMockProducts()
  const all = mockProducts.map((p) => ({
    id: p.id,
    variantId: p.variantId,
    name: p.name,
    sku: p.sku,
    stocks: MOCK_STORES.map((s, i) => ({
      storeId: s.id,
      storeName: s.name,
      stock: p.stocks[i]?.stock ?? Math.floor(Math.random() * 50),
    })),
  }))
  const products = all.filter(p => p.stocks.some(s => s.stock > 2))
  return {
    products,
    stores: MOCK_STORES,
    total: products.length,
    source: 'mock',
    cachedAt: new Date().toISOString(),
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function isStockCacheLoading(): boolean {
  return isBackgroundLoading
}

export function invalidateStockCache(): void {
  snapshot = null
  loadPromise = null
  void deleteCache()
}

export async function warmStockCache(): Promise<void> {
  if (!isLoyverseConfigured()) return

  if (!snapshot) {
    const disk = await readCache()
    if (disk) {
      snapshot = disk
      console.log(`[StockLevels] Disk cache loaded: ${disk.result.products.length} products (${disk.result.cachedAt})`)
    }
  }

  const isStale = !snapshot || Date.now() - snapshot.loadedAt > STOCK_TTL_MS
  if (isStale && !loadPromise) {
    console.log('[StockLevels] Warming stock cache in background…')
    isBackgroundLoading = true
    loadPromise = fetchFromLoyverse()
      .then(async (result) => {
        const s: StockSnapshot = { result, loadedAt: Date.now(), cacheVersion: CACHE_VERSION }
        snapshot = s
        loadPromise = null
        isBackgroundLoading = false
        await writeCache(s)
        console.log(`[StockLevels] Cache ready: ${result.products.length} products`)
        return result
      })
      .catch((err) => {
        loadPromise = null
        isBackgroundLoading = false
        console.warn('[StockLevels] Warm failed:', err)
        return snapshot?.result ?? buildMockResult()
      })
  }
}

const EMPTY_RESULT: StockLevelsResult = {
  products: [],
  stores: [],
  total: 0,
  source: 'loyverse',
  cachedAt: '',
}

export async function getStockLevels(forceRefresh = false): Promise<{
  result: StockLevelsResult
  isLoadingInBackground: boolean
}> {
  if (!isLoyverseConfigured()) {
    return { result: buildMockResult(), isLoadingInBackground: false }
  }

  if (forceRefresh) invalidateStockCache()

  if (!snapshot && !loadPromise) {
    const disk = await readCache()
    if (disk) snapshot = disk
  }

  if (snapshot && !forceRefresh && Date.now() - snapshot.loadedAt < STOCK_TTL_MS) {
    return { result: snapshot.result, isLoadingInBackground: false }
  }

  if (loadPromise) {
    return { result: snapshot?.result ?? EMPTY_RESULT, isLoadingInBackground: true }
  }

  isBackgroundLoading = true
  loadPromise = fetchFromLoyverse()
    .then(async (result) => {
      const s: StockSnapshot = { result, loadedAt: Date.now(), cacheVersion: CACHE_VERSION }
      snapshot = s
      loadPromise = null
      isBackgroundLoading = false
      await writeCache(s)
      return result
    })
    .catch((err) => {
      loadPromise = null
      isBackgroundLoading = false
      console.error('[StockLevels] Fetch failed:', err)
      return snapshot?.result ?? EMPTY_RESULT
    })

  return { result: snapshot?.result ?? EMPTY_RESULT, isLoadingInBackground: true }
}
