/** One product created via the Add Item form, logged to the database for record-keeping. */
export interface CreatedItemRecord {
  id: string
  /** Loyverse item id (empty if Loyverse didn't echo one back) */
  itemId: string
  itemName: string
  /** SKU Loyverse assigned (or the custom one entered) */
  sku: string
  categoryId: string | null
  cost: number | null
  defaultPrice: number | null
  trackStock: boolean
  soldByWeight: boolean
  /** Per-store availability + price captured at creation time */
  stores: Array<{ storeId: string; available: boolean; price: number | null }>
  /** Operator/admin who created the item */
  createdBy: string
  createdAt: string // ISO
}
