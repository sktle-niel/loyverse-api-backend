export interface LoyverseStore {
  id: string
  name: string
  deleted_at?: string | null
}

export interface LoyverseItemVariant {
  variant_id: string
  item_id: string
  sku?: string
  default?: boolean
}

export interface LoyverseItem {
  id: string
  item_name: string
  track_stock?: boolean
  variants: LoyverseItemVariant[]
  deleted_at?: string | null
}

export interface LoyverseInventoryLevel {
  variant_id: string
  store_id: string
  in_stock: number
  updated_at: string
}

export interface LoyverseEmployee {
  id: string
  name: string
}

export interface LoyverseReceiptLineItem {
  id?: string
  item_id?: string
  variant_id?: string
  item_name?: string
  line_item_name?: string
  quantity: number
}

export interface LoyverseReceipt {
  receipt_number: string
  receipt_date?: string
  created_at?: string
  updated_at?: string
  employee_id?: string
  employee_name?: string
  line_items?: LoyverseReceiptLineItem[]
}

export interface PaginatedResponse<T> {
  cursor?: string
  [key: string]: T[] | string | undefined
}
