import fs from 'node:fs/promises'
import path from 'node:path'
import type { LoyverseInventoryLevel } from '../types/loyverse.js'
import type { StockLevelProduct, StockLevelsResult } from '../types/products.js'
import { fetchAllPages, loyverseFetch, isLoyverseConfigured } from './loyverseClient.js'
import type { PaginatedResponse } from '../types/loyverse.js'
import { ensureCatalogLoaded, invalidateCatalogCache, type CatalogSnapshot } from './productsCatalogCache.js'
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
  totalRecords?: number // total inventory records from last full sync — used to estimate progress
}

export interface SyncProgress {
  percent: number          // 0–99 (capped until sync is fully done)
  recordsFetched: number
  totalExpected: number
  etaSeconds: number | null
}

// State for cursor-based pause/resume
interface PausedSyncState {
  cursor: string | undefined
  variantStockMap: Record<string, Record<string, number>>
  totalFetched: number
  totalExpected: number
}

class SyncStoppedError extends Error {
  constructor() {
    super('Sync stopped by user')
    this.name = 'SyncStoppedError'
  }
}

let snapshot: StockSnapshot | null = null
let loadPromise: Promise<StockLevelsResult> | null = null
let isBackgroundLoading = false
let lastFailedAt = 0
let progressResult: StockLevelsResult | null = null // partial results while full sync is in progress
let syncProgress: SyncProgress | null = null        // live progress during full sync

// Stop/resume state
let syncStopRequested = false  // set by requestStopSync(); checked inside fetchFullSnapshot loop
let userStoppedSync = false    // blocks auto-restart of sync after a user-requested stop
let pausedSyncState: PausedSyncState | null = null  // cursor + partial map saved when stopped mid-sync

const FAILURE_COOLDOWN_MS = 60 * 1000 // wait 60s before retrying after a failed sync

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

const PROGRESS_EVERY_PAGES = 10 // emit partial results every 10 pages (~2,500 records)

async function fetchFullSnapshot(resumeFrom?: PausedSyncState): Promise<StockSnapshot> {
  // Always force-refresh the catalog on a full sync — stale product/variant mappings
  // would produce inaccurate results if items were added/removed from Loyverse.
  const catalog = await ensureCatalogLoaded(true)
  const variantToItemId = new Map(Object.entries(catalog.variantIdToItemId ?? {}))
  const knownStoreIds = new Set(catalog.stores.map((s) => s.id))

  const syncedAt = new Date().toISOString()

  // Estimate total records: use saved estimate (resume), last known count, or fallback
  const totalExpected = resumeFrom?.totalExpected
    ?? snapshot?.totalRecords
    ?? (Object.keys(catalog.variantIdToItemId ?? {}).length * catalog.stores.length || 50_000)

  // When resuming, start from saved partial state; otherwise start fresh
  const variantStockMap: Record<string, Record<string, number>> = resumeFrom
    ? { ...resumeFrom.variantStockMap }
    : {}
  let cursor: string | undefined = resumeFrom?.cursor
  let prevCursor: string | undefined
  let totalFetched = resumeFrom?.totalFetched ?? 0

  const action = resumeFrom ? 'Resuming' : 'Starting'
  console.log(`[StockLevels] ${action} full sync at ${totalFetched}/${totalExpected} records…`)

  const syncStartedAt = Date.now()
  // Show current progress immediately (0% for fresh start, or saved % for resume)
  syncProgress = {
    percent: totalFetched > 0 ? Math.min(Math.round((totalFetched / totalExpected) * 100), 99) : 0,
    recordsFetched: totalFetched,
    totalExpected,
    etaSeconds: null,
  }

  let matched = 0, skippedVariant = 0, skippedStore = 0

  for (let page = 0; page < 500; page++) {
    // Check stop request BEFORE fetching the next page — clean break point
    if (syncStopRequested) {
      syncStopRequested = false
      console.log(`[StockLevels] Sync stopped at ${totalFetched}/${totalExpected} records (cursor=${cursor ?? 'start'})`)
      pausedSyncState = {
        cursor,
        variantStockMap: { ...variantStockMap },
        totalFetched,
        totalExpected,
      }
      progressResult = null
      syncProgress = null
      throw new SyncStoppedError()
    }

    const res = await loyverseFetch<PaginatedResponse<LoyverseInventoryLevel>>('/inventory', {
      limit: 250,
      ...(cursor ? { cursor } : {}),
    })

    const batch = res['inventory_levels'] as LoyverseInventoryLevel[] | undefined
    if (!Array.isArray(batch) || batch.length === 0) break

    for (const level of batch) {
      const itemId = variantToItemId.get(level.variant_id)
      if (!itemId) { skippedVariant++; continue }
      if (!knownStoreIds.has(level.store_id)) { skippedStore++; continue }
      if (!variantStockMap[level.variant_id]) variantStockMap[level.variant_id] = {}
      variantStockMap[level.variant_id][level.store_id] = Math.round(Number(level.in_stock))
      matched++
    }

    totalFetched += batch.length

    // Update live progress after every page
    // Only compute ETA after page 3+ — early pages have noisy speed estimates
    const elapsedMs = Date.now() - syncStartedAt
    const recordsPerMs = elapsedMs > 0 ? totalFetched / elapsedMs : 0
    const remaining = Math.max(0, totalExpected - totalFetched)
    const etaSeconds = page >= 3 && recordsPerMs > 0
      ? Math.round(remaining / recordsPerMs / 1000)
      : null
    syncProgress = {
      percent: Math.min(Math.round((totalFetched / totalExpected) * 100), 99),
      recordsFetched: totalFetched,
      totalExpected,
      etaSeconds,
    }

    // Emit partial results every N pages so the frontend can show data as it arrives
    if ((page + 1) % PROGRESS_EVERY_PAGES === 0) {
      progressResult = buildResult({ ...variantStockMap }, catalog)
      console.log(
        `[StockLevels] Progress ${syncProgress.percent}% — ${totalFetched} records | ETA: ${etaSeconds ?? '?'}s | ${progressResult.products.length} transferable products`
      )
    }

    const nextCursor = typeof res.cursor === 'string' ? res.cursor : undefined
    if (!nextCursor || nextCursor === prevCursor) break
    prevCursor = nextCursor
    cursor = nextCursor
  }

  // Sync completed normally — clear paused state and progress indicators
  pausedSyncState = null
  progressResult = null
  syncProgress = null

  console.log(
    `[StockLevels] Full sync complete: ${totalFetched} records | matched: ${matched} | skipped variant: ${skippedVariant} | skipped store: ${skippedStore}`
  )

  const result = buildResult(variantStockMap, catalog)
  console.log(`[StockLevels] Full sync complete: ${result.products.length} transferable products`)

  return { result, loadedAt: Date.now(), lastSyncedAt: syncedAt, cacheVersion: CACHE_VERSION, variantStockMap, totalRecords: totalFetched }
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
  // If a paused sync exists and we're not forcing a full reset, resume from where we stopped
  const shouldResume = !forceFullSync && pausedSyncState !== null
  const canDelta = !forceFullSync && !shouldResume && snapshot?.variantStockMap != null && snapshot?.lastSyncedAt != null

  try {
    let newSnapshot: StockSnapshot
    if (shouldResume) {
      const saved = pausedSyncState!
      pausedSyncState = null // clear before resuming so a second stop saves fresh state
      newSnapshot = await fetchFullSnapshot(saved)
    } else if (canDelta) {
      newSnapshot = await fetchDeltaSnapshot(snapshot!)
    } else {
      // Full sync — set syncProgress immediately so the first poll response is non-null,
      // even while the catalog is still loading inside fetchFullSnapshot.
      if (!syncProgress) {
        syncProgress = {
          percent: 0,
          recordsFetched: 0,
          totalExpected: snapshot?.totalRecords ?? 50_000,
          etaSeconds: null,
        }
      }
      newSnapshot = await fetchFullSnapshot()
    }
    snapshot = newSnapshot
    loadPromise = null
    isBackgroundLoading = false
    await writeCache(newSnapshot)
    console.log(`[StockLevels] Cache ready: ${newSnapshot.result.products.length} products`)
    // Self-schedule the next refresh so the cache stays warm even with no user activity.
    // warmStockCache checks userStoppedSync / loadPromise / TTL so it's safe to call unconditionally.
    setTimeout(() => void warmStockCache(), STOCK_TTL_MS)
    return newSnapshot.result
  } catch (err) {
    loadPromise = null
    isBackgroundLoading = false
    if (err instanceof SyncStoppedError) {
      // Normal user-requested stop — keep existing snapshot, don't count as a failure
      console.log('[StockLevels] Sync stopped by user; partial state saved for resume')
      return snapshot?.result ?? EMPTY_RESULT
    }
    throw err
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function isStockCacheLoading(): boolean {
  return isBackgroundLoading
}

/**
 * Returns cached stock for a specific variant at a specific store.
 * Uses the variantStockMap built during the last full/delta sync.
 * Returns null if cache is not yet loaded.
 */
export function getCachedVariantStock(variantId: string, storeId: string): number | null {
  if (!snapshot?.variantStockMap) return null
  const stock = snapshot.variantStockMap[variantId]?.[storeId]
  return typeof stock === 'number' ? stock : null
}

/** Returns the ISO timestamp of the last successful Loyverse sync. */
export function getLastSyncedAt(): string | null {
  return snapshot?.lastSyncedAt ?? null
}

/**
 * Returns per-store stock for a set of product IDs using the in-memory cache.
 * Used by the item search endpoint to avoid paging through all inventory records.
 */
export function getCachedProductStocks(
  productIds: string[],
  variantIdToItemId: Record<string, string>,
): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>()
  if (!snapshot?.variantStockMap) return result

  const idSet = new Set(productIds)

  for (const [variantId, storeMap] of Object.entries(snapshot.variantStockMap)) {
    const itemId = variantIdToItemId[variantId]
    if (!itemId || !idSet.has(itemId)) continue

    if (!result.has(itemId)) result.set(itemId, new Map())
    for (const [storeId, stock] of Object.entries(storeMap)) {
      result.get(itemId)!.set(storeId, (result.get(itemId)!.get(storeId) ?? 0) + stock)
    }
  }

  return result
}

/**
 * Updates specific variant+store stock entries in the cache in-place.
 * Use after an approval to keep cache accurate without clearing it.
 */
export function updateCachedVariantStock(updates: Array<{ variantId: string; storeId: string; stock: number }>): void {
  if (!snapshot?.variantStockMap) return
  for (const { variantId, storeId, stock } of updates) {
    if (!snapshot.variantStockMap[variantId]) snapshot.variantStockMap[variantId] = {}
    snapshot.variantStockMap[variantId][storeId] = stock
  }
}

export function getSyncProgress(): SyncProgress | null {
  return syncProgress
}

/** Signals the running full sync to stop at the next page boundary. Prevents auto-restart. */
export function requestStopSync(): void {
  syncStopRequested = true
  userStoppedSync = true
  console.log('[StockLevels] Stop requested by user')
}

/**
 * Clears the user-stopped flag and triggers a resume sync if there is saved paused state,
 * or allows the normal stale-cache check to start a fresh sync.
 */
export function resumeStockSync(): void {
  userStoppedSync = false
  syncStopRequested = false // clear any pending stop that wasn't yet processed

  if (!loadPromise) {
    isBackgroundLoading = true
    loadPromise = loadSnapshot(false)
      .catch((err) => {
        loadPromise = null
        isBackgroundLoading = false
        lastFailedAt = Date.now()
        console.error('[StockLevels] Resume sync failed:', err.message)
        return snapshot?.result ?? EMPTY_RESULT
      })
  }
}

/** Returns true if there is saved pause state that can be resumed from cursor. */
export function hasPausedSync(): boolean {
  return pausedSyncState !== null
}

export function invalidateStockCache(): void {
  snapshot = null
  loadPromise = null
  syncStopRequested = false
  userStoppedSync = false
  pausedSyncState = null
  void deleteCache()
  invalidateCatalogCache()
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
  const inCooldown = Date.now() - lastFailedAt < FAILURE_COOLDOWN_MS
  if (isStale && !loadPromise && !inCooldown && !userStoppedSync) {
    console.log('[StockLevels] Warming stock cache in background…')
    isBackgroundLoading = true
    loadPromise = loadSnapshot(false)
      .catch((err) => {
        loadPromise = null
        isBackgroundLoading = false
        lastFailedAt = Date.now()
        console.warn('[StockLevels] Warm failed — retrying in 60s:', err.message)
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
    // Return partial results as they arrive during a full sync
    return { result: progressResult ?? snapshot?.result ?? EMPTY_RESULT, isLoadingInBackground: true }
  }

  // After a failure, serve stale cache quietly until cooldown expires
  const inCooldown = !forceRefresh && Date.now() - lastFailedAt < FAILURE_COOLDOWN_MS
  if (inCooldown) {
    return { result: snapshot?.result ?? EMPTY_RESULT, isLoadingInBackground: false }
  }

  // Don't auto-restart if the user explicitly stopped the sync
  if (userStoppedSync) {
    return { result: snapshot?.result ?? EMPTY_RESULT, isLoadingInBackground: false }
  }

  isBackgroundLoading = true
  loadPromise = loadSnapshot(forceRefresh)
    .catch((err) => {
      loadPromise = null
      isBackgroundLoading = false
      lastFailedAt = Date.now()
      console.error('[StockLevels] Fetch failed — retrying in 60s:', err.message)
      return snapshot?.result ?? EMPTY_RESULT
    })

  return { result: snapshot?.result ?? EMPTY_RESULT, isLoadingInBackground: true }
}
