export interface CreateItemStorePrice {
  storeId: string
  available: boolean
  /** Per-store price; null = use the item's default price (or "price upon sale") */
  price: number | null
}

export interface CreateItemInput {
  name: string
  categoryId?: string | null
  description?: string
  /** false = sold by Each, true = sold by Weight/Volume */
  soldByWeight?: boolean
  trackStock?: boolean
  cost?: number | null
  sku?: string
  barcode?: string
  /** Default selling price; null/blank = price entered upon sale */
  defaultPrice?: number | null
  /** POS representation */
  color?: string
  form?: string
  stores: CreateItemStorePrice[]
}

export interface CategoryDto {
  id: string
  name: string
}
