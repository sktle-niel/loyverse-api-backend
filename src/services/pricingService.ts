import type { ItemPrice, ItemPricesResult, ItemStorePrice } from '../types/pricing.js'
import type { StoreInfo } from '../types/products.js'
import type { PaginatedResponse } from '../types/loyverse.js'
import type { PriceHistoryEntry } from '../types/priceHistory.js'
import { isLoyverseConfigured, loyverseFetch, loyversePost, LoyverseApiError } from './loyverseClient.js'
import { getStores } from './productsService.js'
import { ensureCatalogLoaded } from './productsCatalogCache.js'
import { getMockProducts, MOCK_STORES } from '../data/mockProducts.js'
import { insertPriceHistory } from '../repositories/priceHistoryRepository.js'

// ── Loyverse item shape (richer than the catalog's LoyverseItem — includes price/cost) ──
// The catalog fetch ignores these fields, so we re-fetch /items here with a fuller type.
interface LoyversePricingVariantStore {
  store_id: string
  pricing_type?: string
  price?: number | null
  available_for_sale?: boolean
}

interface LoyversePricingVariant {
  variant_id: string
  item_id: string
  sku?: string
  default?: boolean
  cost?: number | null
  default_price?: number | null
  stores?: LoyversePricingVariantStore[]
}

interface LoyversePricingItem {
  id: string
  item_name: string
  deleted_at?: string | null
  variants: LoyversePricingVariant[]
}

export interface PricingProgress {
  percent: number          // 0–99 while loading, set to null when done
  itemsFetched: number
  totalExpected: number
}

function getFullCatalogMaxPages(): number {
  const n = Number(process.env.LOYVERSE_FULL_MAX_PAGES)
  if (Number.isFinite(n) && n >= 1 && n <= 200) return Math.floor(n)
  return 80
}

// Pricing changes rarely → cache for a long time. The frontend also caches for 1h, so a
// once-an-hour client refresh usually lands on a still-warm server cache (instant).
const PRICING_TTL_MS = Number(process.env.PRICING_CACHE_TTL_MS) || 60 * 60 * 1000 // 60 min
const FAILURE_COOLDOWN_MS = 60 * 1000
const PROGRESS_EVERY_PAGES = 4 // rebuild partial results every N pages (~1,000 items)

interface PricingSnapshot {
  result: ItemPricesResult
  loadedAt: number
}

let snapshot: PricingSnapshot | null = null
let loadPromise: Promise<ItemPricesResult> | null = null
let progress: PricingProgress | null = null
let partial: ItemPricesResult | null = null
let lastFailedAt = 0

const EMPTY_RESULT: ItemPricesResult = {
  items: [],
  stores: [],
  total: 0,
  source: 'loyverse',
  cachedAt: '',
}

function pickPrimaryVariant(item: LoyversePricingItem): LoyversePricingVariant | null {
  const variants = (item.variants ?? []).filter((v) => v.variant_id)
  if (variants.length === 0) return null
  return variants.find((v) => v.default) ?? variants[0]
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function buildItemPrices(items: LoyversePricingItem[], stores: StoreInfo[]): ItemPrice[] {
  const result: ItemPrice[] = []

  for (const item of items) {
    if (item.deleted_at) continue
    const variant = pickPrimaryVariant(item)
    if (!variant) continue

    const cost = toNumberOrNull(variant.cost)
    const defaultPrice = toNumberOrNull(variant.default_price)

    const priceByStore = new Map<string, number | null>()
    for (const s of variant.stores ?? []) {
      priceByStore.set(s.store_id, toNumberOrNull(s.price))
    }

    // Fall back to the variant's default price when a store has no fixed price.
    const prices: ItemStorePrice[] = stores.map((store) => ({
      storeId: store.id,
      storeName: store.name,
      price: priceByStore.get(store.id) ?? defaultPrice,
    }))

    result.push({
      id: item.id,
      variantId: variant.variant_id,
      name: item.item_name,
      sku: variant.sku ?? '',
      cost,
      prices,
    })
  }

  result.sort((a, b) => a.name.localeCompare(b.name))
  return result
}

function buildResult(items: LoyversePricingItem[], stores: StoreInfo[]): ItemPricesResult {
  const itemPrices = buildItemPrices(items, stores)
  return {
    items: itemPrices,
    stores,
    total: itemPrices.length,
    source: 'loyverse',
    cachedAt: new Date().toISOString(),
  }
}

function buildMockResult(): ItemPricesResult {
  const stores = MOCK_STORES
  const items: ItemPrice[] = getMockProducts().map((p, i) => {
    const cost = 80 + ((i * 17) % 220) // deterministic-ish fixed cost
    return {
      id: p.id,
      variantId: p.variantId,
      name: p.name,
      sku: p.sku,
      cost,
      prices: stores.map((store, si) => ({
        storeId: store.id,
        storeName: store.name,
        price: Math.round(cost * (1.3 + si * 0.05)),
      })),
    }
  })
  items.sort((a, b) => a.name.localeCompare(b.name))
  return { items, stores, total: items.length, source: 'mock', cachedAt: new Date().toISOString() }
}

/** Pages through Loyverse /items, updating `progress` + `partial` as it goes. */
async function fetchAllPricing(): Promise<ItemPricesResult> {
  const maxPages = getFullCatalogMaxPages()
  // Catalog is already warmed at startup → gives us an item count for an accurate %.
  const [{ stores }, catalog] = await Promise.all([getStores(), ensureCatalogLoaded(false)])
  const totalExpected = Math.max(1, catalog.products.length || snapshot?.result.total || 1)

  const collected: LoyversePricingItem[] = []
  let cursor: string | undefined
  let prevCursor: string | undefined
  let fetched = 0

  progress = { percent: 0, itemsFetched: 0, totalExpected }
  console.log(`[Pricing] Starting price-list load (~${totalExpected} items expected)…`)

  for (let page = 0; page < maxPages; page++) {
    const res = await loyverseFetch<PaginatedResponse<LoyversePricingItem>>('/items', {
      limit: 250,
      ...(cursor ? { cursor } : {}),
    })

    const batch = res.items as LoyversePricingItem[] | undefined
    if (!Array.isArray(batch) || batch.length === 0) break

    collected.push(...batch)
    fetched += batch.length
    progress = {
      percent: Math.min(99, Math.round((fetched / totalExpected) * 100)),
      itemsFetched: fetched,
      totalExpected,
    }

    if ((page + 1) % PROGRESS_EVERY_PAGES === 0) {
      partial = buildResult(collected, stores)
    }

    const next = typeof res.cursor === 'string' ? res.cursor : undefined
    if (!next || next === prevCursor) break
    prevCursor = next
    cursor = next
  }

  const result = buildResult(collected, stores)
  progress = null
  partial = null
  console.log(`[Pricing] Price list ready: ${result.total} items`)
  return result
}

/**
 * Returns all catalog items with fixed cost + per-store price.
 * Loads progressively: the first call kicks off a background fetch and returns
 * `{ isLoading: true, progress }`; poll again to watch progress and receive partial
 * results, then the full result once `isLoading` is false. Cached for PRICING_TTL_MS.
 */
export async function getItemPrices(forceRefresh = false): Promise<{
  result: ItemPricesResult
  isLoading: boolean
  progress: PricingProgress | null
}> {
  if (!isLoyverseConfigured()) {
    return { result: buildMockResult(), isLoading: false, progress: null }
  }

  if (forceRefresh) snapshot = null

  const isFresh = snapshot && Date.now() - snapshot.loadedAt < PRICING_TTL_MS
  if (isFresh && !forceRefresh) {
    return { result: snapshot!.result, isLoading: false, progress: null }
  }

  // A load is already running — serve partial/stale and report progress
  if (loadPromise) {
    return { result: partial ?? snapshot?.result ?? EMPTY_RESULT, isLoading: true, progress }
  }

  // After a failure, serve stale quietly until cooldown expires
  const inCooldown = !forceRefresh && Date.now() - lastFailedAt < FAILURE_COOLDOWN_MS
  if (inCooldown) {
    return { result: snapshot?.result ?? EMPTY_RESULT, isLoading: false, progress: null }
  }

  // Start a background load
  progress = { percent: 0, itemsFetched: 0, totalExpected: snapshot?.result.total || 1 }
  loadPromise = fetchAllPricing()
    .then((result) => {
      snapshot = { result, loadedAt: Date.now() }
      return result
    })
    .catch((err) => {
      lastFailedAt = Date.now()
      progress = null
      partial = null
      console.warn('[Pricing] Load failed:', (err as Error).message)
      return snapshot?.result ?? EMPTY_RESULT
    })
    .finally(() => {
      loadPromise = null
    })

  return { result: partial ?? snapshot?.result ?? EMPTY_RESULT, isLoading: true, progress }
}

/** Warm the price-list cache in the background (called on startup). Idempotent. */
export async function warmPricingCache(): Promise<void> {
  if (!isLoyverseConfigured()) return
  const isStale = !snapshot || Date.now() - snapshot.loadedAt > PRICING_TTL_MS
  if (isStale && !loadPromise) {
    await getItemPrices(false).catch(() => {})
  }
}

/** Drop the cached price list (e.g. after a new item is created) so the next load is fresh. */
export function invalidatePricingCache(): void {
  snapshot = null
}

/** Patch one item's per-store price in the in-memory cache so the UI updates without a reload. */
export function updateCachedItemPrice(itemId: string, storeId: string, price: number): void {
  if (!snapshot) return
  const item = snapshot.result.items.find((it) => it.id === itemId)
  if (!item) return
  const cell = item.prices.find((p) => p.storeId === storeId)
  if (cell) cell.price = price
}

// ── Price editing (writes to Loyverse + records history) ───────────────────────

// Loyverse item is fetched in full, mutated in place, and posted back so we never
// drop other variants/stores/modifiers/taxes (POST /items replaces what you send).
interface LoyverseFullVariantStore {
  store_id: string
  pricing_type?: string
  price?: number | null
  available_for_sale?: boolean
  [key: string]: unknown
}
interface LoyverseFullVariant {
  variant_id: string
  default?: boolean
  stores?: LoyverseFullVariantStore[]
  [key: string]: unknown
}
interface LoyverseFullItem {
  id: string
  item_name: string
  variants: LoyverseFullVariant[]
  [key: string]: unknown
}

function newHistoryId(): string {
  return `ph-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/**
 * Sets the selling price for one item at one store in Loyverse, then records the change.
 * Uses GET → mutate → POST so every other field on the item is preserved.
 */
export async function updateItemStorePrice(params: {
  itemId: string
  variantId?: string
  storeId: string
  storeName: string
  newPrice: number
  changedBy: string
}): Promise<{ entry: PriceHistoryEntry }> {
  const { itemId, variantId, storeId, storeName, changedBy } = params
  const newPrice = Math.round(Number(params.newPrice) * 100) / 100

  if (!isLoyverseConfigured()) throw new LoyverseApiError('Loyverse is not configured', 503)
  if (!itemId || !storeId) throw new LoyverseApiError('itemId and storeId are required', 400)
  if (!Number.isFinite(newPrice) || newPrice < 0) {
    throw new LoyverseApiError('price must be a number ≥ 0', 400)
  }

  // 1. Fetch the full item so we can post it back intact.
  const item = await loyverseFetch<LoyverseFullItem>(`/items/${itemId}`)
  if (!item?.id) throw new LoyverseApiError(`Item not found: ${itemId}`, 404)

  const variants = item.variants ?? []
  const variant =
    (variantId && variants.find((v) => v.variant_id === variantId)) ||
    variants.find((v) => v.default) ||
    variants[0]
  if (!variant) throw new LoyverseApiError(`Item "${item.item_name}" has no variants`, 422)

  // 2. Mutate only the target store's price (FIXED pricing).
  if (!Array.isArray(variant.stores)) variant.stores = []
  let storeEntry = variant.stores.find((s) => s.store_id === storeId)
  const oldPrice =
    storeEntry && typeof storeEntry.price === 'number' ? storeEntry.price : null

  if (!storeEntry) {
    storeEntry = { store_id: storeId, pricing_type: 'FIXED', price: newPrice, available_for_sale: true }
    variant.stores.push(storeEntry)
  } else {
    storeEntry.pricing_type = 'FIXED'
    storeEntry.price = newPrice
  }

  // 3. Write back to Loyverse.
  console.log(`[Pricing] Updating "${item.item_name}" @ ${storeName}: ${oldPrice ?? '—'} → ${newPrice}`)
  await loyversePost('/items', item)

  // 4. Keep the in-memory price list accurate without a full reload.
  updateCachedItemPrice(itemId, storeId, newPrice)

  // 5. Record history (non-fatal — the Loyverse change already succeeded).
  const entry: PriceHistoryEntry = {
    id: newHistoryId(),
    itemId,
    itemName: item.item_name,
    storeId,
    storeName,
    oldPrice,
    newPrice,
    changedBy,
    createdAt: new Date().toISOString(),
  }
  try {
    await insertPriceHistory(entry)
  } catch (err) {
    console.warn('[Pricing] Price updated in Loyverse but failed to record history:', (err as Error).message)
  }

  return { entry }
}
