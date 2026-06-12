import type { StoreInfo } from './products.js'

export interface ReceiptLineItem {
  itemName: string
  variantName: string | null
  quantity: number
  price: number
  total: number
}

export interface ReceiptPayment {
  name: string
  type: string
  amount: number
}

export interface ReceiptDto {
  receiptNumber: string
  type: 'SALE' | 'REFUND'
  /** Receipt date (ISO) */
  date: string
  storeId: string
  storeName: string
  employeeId: string
  employeeName: string
  customerName: string | null
  posDeviceName: string | null
  total: number
  cancelledAt: string | null
  lineItems: ReceiptLineItem[]
  payments: ReceiptPayment[]
}

export interface ReceiptsSummary {
  receipts: number
  sales: number
  refunds: number
  totalSales: number
}

export interface ReceiptEmployee {
  id: string
  name: string
}

export interface ReceiptsResult {
  receipts: ReceiptDto[]
  summary: ReceiptsSummary
  stores: StoreInfo[]
  employees: ReceiptEmployee[]
  source: 'loyverse' | 'mock'
}
