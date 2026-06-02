import fs from 'node:fs/promises'
import path from 'node:path'
import type { LoyverseInventoryLevel } from '../types/loyverse.js'
import type { StockLevelProduct, StockLevelsResult } from '../types/products.js'
import { fetchAllPages, isLoyverseConfigured } from './loyverseClient.js'
import { ensureCatalogLoaded, type CatalogSnapshot } from './productsCatalogCache.js'
import { getMockProducts, MOCK_STORES } from '../data/mockProducts.js'

const CACHE_FILE = path.join(process.cwd(), '.stock_cache.json')
const STOCK_TTL_MS = 2 * 60 * 1000 // 2 minutes — delta sync makes frequent checks cheap
const MIN_STOCK_FOR_TRANSFER = 2
const CACHE_VERSION = 4 // bumped — delta sync with variantStockMap

interface StockSnapshot {
  result: StockLevelsResult
  loadedAt: number
  lastSyncedAt: string  // ISO datetime used as updated_since in delta fetches
  cacheVersion: number
  variantStockMap: Record<string, Record<string, number>> // variantId → storeId → stock
}

let snapshot: StockSnapshot | null = null
let loadPromise: Promise<StockLevelsResult> | null = null
let isBackgroundLoading = false

// ── Disk cache ────────────────────────────────────────────────────────────────

async function readCache(): Promise<StockSnapshot | null> {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf8')
    const parsed = JSON.parse(raw) as StockSnapshot
    if (
      parsed?.result?.products &&
      parsed?.loadedAt &&
      parsed?.cacheVersion === CACHE_VERSION &&
      parsed?.variantStockMap &&
      parsed?.lastSyncedAt
    ) {
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

// ── Shared result builder ─────────────────────────────────────────────────────

function buildResult(
  variantStockMap: Record<string, Record<string, number>>,
  catalog: CatalogSnapshot,
): StockLevelsResult {
  const storeNameById = new Map(catalog.stores.map((s) => [s.id, s.name]))
  const variantToItemId = new Map(Object.entries(catalog.variantIdToItemId ?? {}))
  const knownStoreIds = new Set(catalog.stores.map((s) => s.id))

  // Sum stock across all variants per (itemId, storeId)
  const stockMap = new Map<string, Map<string, number>>()
  for (const [variantId, storeMap] of Object.entries(variantStockMap)) {
    const itemId = variantToItemId.get(variantId)
    if (!itemId) continue
    if (!stockMap.has(itemId)) stockMap.set(itemId, new Map())
    for (const [storeId, stock] of Object.entries(storeMap)) {
      if (!knownStoreIds.has(storeId)) continue
      stockMap.get(itemId)!.set(storeId, (stockMap.get(itemId)!.get(storeId) ?? 0) + stock)
    }
  }

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

  const products = allProducts.filter(p => p.stocks.some(s => s.stock > MIN_STOCK_FOR_TRANSFER))

  return {
    products,
    stores: catalog.stores,
    total: products.length,
    source: 'loyverse',
    cachedAt: new Date().toISOString(),
  }
}

// ── Full sync ─────────────────────────────────────────────────────────────────

async function fetchFullSnapshot(): Promise<StockSnapshot> {
  const catalog = await ensureCatalogLoaded(false)
  const variantToItemId = new Map(Object.entries(catalog.variantIdToItemId ?? {}))
  const knownStoreIds = new Set(catalog.stores.map((s) => s.id))

  const syncedAt = new Date().toISOString()
  console.log('[StockLevels] Full sync: fetching all inventory levels…')
  const levels = await fetchAllPages<LoyverseInventoryLevel>(
    '/inventory',
    'inventory_levels',
    {},
    500,
  )
  console.log(`[StockLevels] Full sync: ${levels.length} records fetched`)

  const variantStockMap: Record<string, Record<string, number>> = {}
  let matched = 0, skippedVariant = 0, skippedStore = 0

  for (const level of levels) {
    const itemId = variantToItemId.get(level.variant_id)
    if (!itemId) { skippedVariant++; continue }
    if (!knownStoreIds.has(level.store_id)) { skippedStore++; continue }

    if (!variantStockMap[level.variant_id]) variantStockMap[level.variant_id] = {}
    variantStockMap[level.variant_id][level.store_id] = Math.round(Number(level.in_stock))
    matched++
  }

  console.log(
    `[StockLevels] Matched: ${matched} | Skipped variant: ${skippedVariant} | Skipped store: ${skippedStore}`
  )

  const result = buildResult(variantStockMap, catalog)
  console.log(`[StockLevels] Full sync complete: ${result.products.length} transferable products`)

  return { result, loadedAt: Date.now(), lastSyncedAt: syncedAt, cacheVersion: CACHE_VERSION, variantStockMap }
}

// ── Delta sync ────────────────────────────────────────────────────────────────

async function fetchDeltaSnapshot(current: StockSnapshot): Promise<StockSnapshot> {
  const syncedAt = new Date().toISOString()
  console.log(`[StockLevels] Delta sync: fetching changes since ${current.lastSyncedAt}…`)

  const levels = await fetchAllPages<LoyverseInventoryLevel>(
    '/inventory',
    'inventory_levels',
    { updated_since: current.lastSyncedAt },
    50,
  )
  console.log(`[StockLevels] Delta sync: ${levels.length} changed records`)

  // No changes — just bump the timestamps
  if (levels.length === 0) {
    return { ...current, loadedAt: Date.now(), lastSyncedAt: syncedAt }
  }

  const catalog = await ensureCatalogLoaded(false)
  const variantToItemId = new Map(Object.entries(catalog.variantIdToItemId ?? {}))
  const knownStoreIds = new Set(catalog.stores.map((s) => s.id))

  // Copy existing map and apply only the changed entries
  const variantStockMap: Record<string, Record<string, number>> = {}
  for (const [vId, storeMap] of Object.entries(current.variantStockMap)) {
    variantStockMap[vId] = { ...storeMap }
  }

  let updated = 0
  for (const level of levels) {
    const itemId = variantToItemId.get(level.variant_id)
    if (!itemId || !knownStoreIds.has(level.store_id)) continue
    if (!variantStockMap[level.variant_id]) variantStockMap[level.variant_id] = {}
    variantStockMap[level.variant_id][level.store_id] = Math.round(Number(level.in_stock))
    updated++
  }
  console.log(`[StockLevels] Delta applied: ${updated} variant-store entries updated`)

  const result = buildResult(variantStockMap, catalog)
  console.log(`[StockLevels] Delta sync complete: ${result.products.length} transferable products`)

  return { result, loadedAt: Date.now(), lastSyncedAt: syncedAt, cacheVersion: CACHE_VERSION, variantStockMap }
}

// ── Mock ──────────────────────────────────────────────────────────────────────

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

// ── Internal loader ───────────────────────────────────────────────────────────

async function loadSnapshot(forceFullSync: boolean): Promise<StockLevelsResult> {
  const canDelta = !forceFullSync && snapshot?.variantStockMap != null && snapshot?.lastSyncedAt != null
  const newSnapshot = await (canDelta ? fetchDeltaSnapshot(snapshot!) : fetchFullSnapshot())
  snapshot = newSnapshot
  loadPromise = null
  isBackgroundLoading = false
  await writeCache(newSnapshot)
  console.log(`[StockLevels] Cache ready: ${newSnapshot.result.products.length} products`)
  return newSnapshot.result
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
    loadPromise = loadSnapshot(false)
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
  loadPromise = loadSnapshot(forceRefresh)
    .catch((err) => {
      loadPromise = null
      isBackgroundLoading = false
      console.error('[StockLevels] Fetch failed:', err)
      return snapshot?.result ?? EMPTY_RESULT
    })

  return { result: snapshot?.result ?? EMPTY_RESULT, isLoadingInBackground: true }
}
