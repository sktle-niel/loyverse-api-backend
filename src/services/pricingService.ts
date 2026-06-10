import type { ItemPrice, ItemPricesResult, ItemStorePrice } from '../types/pricing.js'
import type { StoreInfo } from '../types/products.js'
import { fetchAllPages, isLoyverseConfigured } from './loyverseClient.js'
import { getStores } from './productsService.js'
import { getMockProducts, MOCK_STORES } from '../data/mockProducts.js'

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

function getFullCatalogMaxPages(): number {
  const n = Number(process.env.LOYVERSE_FULL_MAX_PAGES)
  if (Number.isFinite(n) && n >= 1 && n <= 200) return Math.floor(n)
  return 80
}

const PRICING_TTL_MS = Number(process.env.PRICING_CACHE_TTL_MS) || 10 * 60 * 1000 // 10 min default

interface PricingSnapshot {
  result: ItemPricesResult
  loadedAt: number
}

let snapshot: PricingSnapshot | null = null
let loadPromise: Promise<ItemPricesResult> | null = null

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

    // Map store_id → price from the variant's stores array
    const priceByStore = new Map<string, number | null>()
    for (const s of variant.stores ?? []) {
      priceByStore.set(s.store_id, toNumberOrNull(s.price))
    }

    // Build a price cell for every known (non-excluded) branch.
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
      // Vary price per store so the UI clearly shows per-branch differences
      prices: stores.map((store, si) => ({
        storeId: store.id,
        storeName: store.name,
        price: Math.round(cost * (1.3 + si * 0.05)),
      })),
    }
  })
  items.sort((a, b) => a.name.localeCompare(b.name))
  return {
    items,
    stores,
    total: items.length,
    source: 'mock',
    cachedAt: new Date().toISOString(),
  }
}

async function loadFromLoyverse(): Promise<ItemPricesResult> {
  const maxPages = getFullCatalogMaxPages()
  const [{ stores }, items] = await Promise.all([
    getStores(),
    fetchAllPages<LoyversePricingItem>('/items', 'items', {}, maxPages),
  ])

  const itemPrices = buildItemPrices(items, stores)
  console.log(`[Pricing] Built price list: ${itemPrices.length} items across ${stores.length} branches`)

  return {
    items: itemPrices,
    stores,
    total: itemPrices.length,
    source: 'loyverse',
    cachedAt: new Date().toISOString(),
  }
}

/**
 * Returns all catalog items with fixed cost + per-store selling price.
 * Cached in memory for PRICING_TTL_MS; `forceRefresh` bypasses the cache.
 */
export async function getItemPrices(forceRefresh = false): Promise<ItemPricesResult> {
  if (!isLoyverseConfigured()) {
    return buildMockResult()
  }

  const isFresh = snapshot && Date.now() - snapshot.loadedAt < PRICING_TTL_MS
  if (isFresh && !forceRefresh) {
    return snapshot!.result
  }

  // Coalesce concurrent loads into a single Loyverse fetch
  if (!loadPromise) {
    loadPromise = loadFromLoyverse()
      .then((result) => {
        snapshot = { result, loadedAt: Date.now() }
        return result
      })
      .finally(() => {
        loadPromise = null
      })
  }

  try {
    return await loadPromise
  } catch (err) {
    // On failure, serve stale cache if we have it; otherwise rethrow
    if (snapshot) {
      console.warn('[Pricing] Refresh failed — serving stale cache:', (err as Error).message)
      return snapshot.result
    }
    throw err
  }
}
