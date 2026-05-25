export interface StoreInfo {
  id: string
  name: string
}

export interface ProductStockCell {
  storeId: string
  stock: number
}

export interface ProductDto {
  /** Loyverse item id */
  id: string
  /** Primary variant used for per-store stock */
  variantId: string
  name: string
  sku: string
  stocks: ProductStockCell[]
}

export interface ProductsResult {
  products: ProductDto[]
  stores: StoreInfo[]
  source: 'loyverse' | 'mock'
}

export interface StockUpdateInput {
  storeId: string
  stock: number
}

/** @deprecated Use SubmitStockRequestResult — stock saves require admin approval first */
export interface UpdateProductStockResult {
  product: ProductDto
  auditRecords: import('./audit.js').AuditRecord[]
  source: 'loyverse' | 'mock'
}
