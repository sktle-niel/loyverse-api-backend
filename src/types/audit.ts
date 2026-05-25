export interface AuditRecord {
  id: string
  itemName: string
  adminName: string
  /** Loyverse store id where stock changed */
  branchId?: string
  oldStock: number
  newStock: number
  changeAmount: number
  timestamp: string
}
