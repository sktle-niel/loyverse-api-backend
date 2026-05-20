import type { AuditRecord } from '../types/audit.js'

export type { AuditRecord }

/** Temporary mock — used when Loyverse token is missing or API fails */
export const MOCK_AUDIT_RECORDS: AuditRecord[] = [
  {
    id: '1',
    itemName: 'Mobil 1 Engine Oil 1L',
    adminName: 'Maria Santos',
    oldStock: 50,
    newStock: 45,
    changeAmount: -5,
    timestamp: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
  },
  {
    id: '2',
    itemName: 'Spark Plugs (Set of 4)',
    adminName: 'Juan Dela Cruz',
    oldStock: 100,
    newStock: 108,
    changeAmount: 8,
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
  },
  {
    id: '3',
    itemName: 'Oil Filter',
    adminName: 'Maria Santos',
    oldStock: 200,
    newStock: 195,
    changeAmount: -5,
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
  },
]
