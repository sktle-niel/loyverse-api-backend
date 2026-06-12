/** One product deleted via the Delete Item page, logged to the database for record-keeping. */
export interface DeletedItemRecord {
  id: string
  /** Loyverse item id that was deleted */
  itemId: string
  itemName: string
  sku: string
  /** Operator/admin who deleted the item */
  deletedBy: string
  /** When the item was deleted (ISO) */
  createdAt: string
}
