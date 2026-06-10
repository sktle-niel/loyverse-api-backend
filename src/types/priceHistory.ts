/** One recorded price change for an item at a specific store. */
export interface PriceHistoryEntry {
  id: string
  itemId: string
  itemName: string
  storeId: string
  storeName: string
  /** Price before the change (null if the store had no fixed price set) */
  oldPrice: number | null
  newPrice: number
  changedBy: string
  createdAt: string // ISO
}
