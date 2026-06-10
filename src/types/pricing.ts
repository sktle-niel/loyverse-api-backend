import type { StoreInfo } from './products.js'

/** Price of one item at one store. `price` is null when the store has no fixed price set. */
export interface ItemStorePrice {
  storeId: string
  storeName: string
  price: number | null
}

/** One catalog item with its fixed cost and per-store selling prices. */
export interface ItemPrice {
  /** Loyverse item id */
  id: string
  /** Primary variant id */
  variantId: string
  name: string
  sku: string
  /** Cost is fixed across stores (variant.cost in Loyverse) */
  cost: number | null
  /** Selling price per store (varies per branch) */
  prices: ItemStorePrice[]
}

export interface ItemPricesResult {
  items: ItemPrice[]
  stores: StoreInfo[]
  total: number
  source: 'loyverse' | 'mock'
  cachedAt: string
}
