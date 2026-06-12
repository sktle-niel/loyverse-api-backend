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

export interface ExportItemStock {
  storeId: string
  storeName: string
  inStock: number
}

/** One in-stock item row for the Inventory CSV export. */
export interface ExportItemRow {
  handle: string
  sku: string
  name: string
  category: string
  cost: number | null
  stocks: ExportItemStock[]
}

export interface ExportItemsResult {
  stores: { id: string; name: string }[]
  items: ExportItemRow[]
}
