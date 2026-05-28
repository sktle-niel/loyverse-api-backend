import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProductDto, StoreInfo } from '../types/products.js'

/** Bump when catalog build logic changes (invalidates old disk cache files). */
export const CATALOG_SCHEMA_VERSION = 4

export interface CatalogSnapshot {
  products: ProductDto[]
  stores: StoreInfo[]
  source: 'loyverse' | 'mock'
  loadedAt: string
  catalogSchemaVersion?: number
}

const CACHE_FILE = path.join(process.cwd(), '.catalog_cache.json')
const CACHE_TTL_MS = Number(process.env.CATALOG_CACHE_TTL_MS) || 5 * 60 * 1000 // 5 minutes default

let snapshot: CatalogSnapshot | null = null
let loadPromise: Promise<CatalogSnapshot> | null = null
let loader: ((force: boolean) => Promise<CatalogSnapshot>) | null = null

async function readCacheFile(): Promise<CatalogSnapshot | null> {
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf8')
    const parsed = JSON.parse(data) as CatalogSnapshot
    if (
      parsed &&
      parsed.catalogSchemaVersion === CATALOG_SCHEMA_VERSION &&
      Array.isArray(parsed.products) &&
      Array.isArray(parsed.stores) &&
      parsed.loadedAt
    ) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

async function writeCacheFile(data: CatalogSnapshot): Promise<void> {
  try {
    // Compact JSON — full catalog is large; pretty-print slows writes and bloats disk.
    await fs.writeFile(CACHE_FILE, JSON.stringify(data), 'utf8')
  } catch (err) {
    console.error('[Catalog Cache] Failed to write catalog cache to disk:', err)
  }
}

async function deleteCacheFile(): Promise<void> {
  try {
    await fs.unlink(CACHE_FILE)
  } catch {
    /* file may not exist */
  }
}

export function registerCatalogLoader(fn: (force: boolean) => Promise<CatalogSnapshot>): void {
  loader = fn
}

export function getCatalogSnapshot(): CatalogSnapshot | null {
  return snapshot
}

export function invalidateCatalogCache(): void {
  snapshot = null
  loadPromise = null
  void deleteCacheFile()
}

export async function ensureCatalogLoaded(force = false): Promise<CatalogSnapshot> {
  if (!loader) {
    throw new Error('Catalog loader is not registered')
  }

  // 1. If snapshot is not in memory, try to load it from disk
  if (!snapshot && !loadPromise) {
    try {
      const diskCache = await readCacheFile()
      if (diskCache) {
        snapshot = diskCache
        console.log(`[Catalog Cache] Loaded ${snapshot.products.length} products from disk cache (loaded at ${snapshot.loadedAt})`)
      }
    } catch (err) {
      console.error('[Catalog Cache] Error reading disk cache:', err)
    }
  }

  // 2. If force is true, we perform a blocking fresh load
  if (force) {
    snapshot = null
    loadPromise = loader(true)
      .then(async (data) => {
        snapshot = data
        loadPromise = null
        await writeCacheFile(data)
        return data
      })
      .catch((err) => {
        loadPromise = null
        throw err
      })
    return loadPromise
  }

  // 3. If force is false and we have a snapshot (either in memory or loaded from disk)
  if (snapshot) {
    const loadedTime = new Date(snapshot.loadedAt).getTime()
    const isStale = Date.now() - loadedTime > CACHE_TTL_MS

    if (isStale && !loadPromise) {
      console.log(`[Catalog Cache] Cache is stale (${((Date.now() - loadedTime) / 1000).toFixed(0)}s old). Triggering background refresh...`)
      // Trigger background load
      loadPromise = loader(false)
        .then(async (data) => {
          snapshot = data
          loadPromise = null
          await writeCacheFile(data)
          console.log('[Catalog Cache] Background refresh completed successfully.')
          return data
        })
        .catch((err) => {
          loadPromise = null
          console.error('[Catalog Cache] Background refresh failed. Stale cache retained.', err)
          return snapshot!
        })
    }
    
    // Return the cached snapshot immediately (stale-while-revalidate)
    return snapshot
  }

  // 4. If force is false and we have no snapshot but a load is already in progress, reuse it
  if (loadPromise) {
    return loadPromise
  }

  // 5. If force is false and we have no snapshot and no load in progress (first load, disk cache was empty)
  loadPromise = loader(false)
    .then(async (data) => {
      snapshot = data
      loadPromise = null
      await writeCacheFile(data)
      return data
    })
    .catch((err) => {
      loadPromise = null
      throw err
    })

  return loadPromise
}

export function filterCatalogProducts(products: ProductDto[], query: string): ProductDto[] {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)

  if (terms.length === 0) return products

  return products.filter((p) => {
    const hay = `${p.name} ${p.sku}`.toLowerCase()
    return terms.every((term) => hay.includes(term))
  })
}
