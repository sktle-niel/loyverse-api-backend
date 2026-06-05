export type TransferRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

export interface TransferRequest {
  id: string
  itemId: string
  variantId: string
  itemName: string
  sku: string
  fromStoreId: string
  fromStoreName: string
  toStoreId: string
  toStoreName: string
  quantity: number
  fromStockBefore: number | null
  toStockBefore: number | null
  fromStockCurrent?: number | null
  toStockCurrent?: number | null
  requestedBy: string
  status: TransferRequestStatus
  createdAt: string
  reviewedAt?: string
  reviewedBy?: string
  rejectionReason?: string
}

export interface SubmitTransferBody {
  itemId: string
  fromStoreId: string
  toStoreId: string
  quantity: number
  requestedBy?: string
}
