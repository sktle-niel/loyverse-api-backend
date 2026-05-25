export type StockRequestStatus = 'pending' | 'approved' | 'rejected'

export interface StockRequestLine {
  storeId: string
  storeName: string
  oldStock: number
  newStock: number
}

export interface StockChangeRequest {
  id: string
  itemId: string
  variantId: string
  itemName: string
  sku: string
  requestedBy: string
  status: StockRequestStatus
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
