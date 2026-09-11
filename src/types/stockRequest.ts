export type StockRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

export interface StockRequestLine {
  storeId: string
  storeName: string
  oldStock: number
  newStock: number
  /** Indicates whether the oldStock has been synced from Loyverse */
  synced?: boolean
}

export interface StockChangeRequest {
  id: string
  itemId: string
  variantId: string
  itemName: string
  sku: string
  /** Loyverse store id for the branch selected on submit */
  storeId: string
  storeName: string
  oldStock: number
  oldStockSynced: boolean
  /**
   * While pending/rejected/cancelled: the additive amount the operator entered.
   * Once approved: rewritten to the ABSOLUTE level written to Loyverse (old + change),
   * which is what the audit trail reads. Do not display this as "qty" — use `changeAmount`.
   */
  newStock: number
  /** Units the operator asked to add. Stable for the whole lifecycle — the value to show as "qty". */
  changeAmount: number
  requestedBy: string
  status: StockRequestStatus
  /** Mirror of branch fields for API consumers; always one line per request */
  lines: StockRequestLine[]
  createdAt: string
  reviewedAt?: string
  reviewedBy?: string
  rejectionReason?: string
}

export interface SubmitStockRequestResult {
  request: StockChangeRequest
  message: string
}
