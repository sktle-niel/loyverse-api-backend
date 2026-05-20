export interface AuditRecord {
  id: string
  itemName: string
  adminName: string
  oldStock: number
  newStock: number
  changeAmount: number
  timestamp: string
}
