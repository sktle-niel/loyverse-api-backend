import type { AuditRecord } from '../types/audit.js'
import type { LoyverseEmployee, LoyverseItem, LoyverseReceipt } from '../types/loyverse.js'
import { MOCK_AUDIT_RECORDS } from '../data/mockAudit.js'
import { fetchAllPages, isLoyverseConfigured } from './loyverseClient.js'

export interface AuditResult {
  records: AuditRecord[]
  total: number
  source: 'loyverse' | 'mock'
}

const AUDIT_DAYS = 30

export async function getAuditRecords(): Promise<AuditResult> {
  if (!isLoyverseConfigured()) {
    return { records: MOCK_AUDIT_RECORDS, total: MOCK_AUDIT_RECORDS.length, source: 'mock' }
  }

  try {
    const records = await buildAuditFromLoyverse()
    return { records, total: records.length, source: 'loyverse' }
  } catch {
    return { records: MOCK_AUDIT_RECORDS, total: MOCK_AUDIT_RECORDS.length, source: 'mock' }
  }
}

async function buildAuditFromLoyverse(): Promise<AuditRecord[]> {
  const createdAtMin = new Date(Date.now() - AUDIT_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const [receipts, employees] = await Promise.all([
    fetchAllPages<LoyverseReceipt>('/receipts', 'receipts', {
      created_at_min: createdAtMin,
      order: 'DESC',
    }, 10),
    fetchAllPages<LoyverseEmployee>('/employees', 'employees').catch(() => [] as LoyverseEmployee[]),
  ])

  const employeeNames = new Map(employees.map((e) => [e.id, e.name]))

  const records: AuditRecord[] = []

  for (const receipt of receipts) {
    const adminName =
      receipt.employee_name ??
      (receipt.employee_id ? employeeNames.get(receipt.employee_id) : undefined) ??
      'Unknown'
    const timestamp =
      receipt.created_at ?? receipt.receipt_date ?? receipt.updated_at ?? new Date().toISOString()

    for (const line of receipt.line_items ?? []) {
      const itemName = line.item_name ?? line.line_item_name
      if (!itemName || line.quantity === 0) continue

      const qty = Math.abs(line.quantity)
      const isRefund = line.quantity < 0
      const changeAmount = isRefund ? qty : -qty

      records.push({
        id: `${receipt.receipt_number}-${line.id ?? line.variant_id ?? itemName}`,
        itemName,
        adminName,
        oldStock: 0,
        newStock: 0,
        changeAmount,
        timestamp,
      })
    }
  }

  records.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

  if (records.length > 0) {
    return records
  }

  return buildAuditFromInventoryUpdates()
}

/** Fallback when no receipts: surface recent inventory level updates */
async function buildAuditFromInventoryUpdates(): Promise<AuditRecord[]> {
  const updatedAtMin = new Date(Date.now() - AUDIT_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const [levels, items] = await Promise.all([
    fetchAllPages<{ variant_id: string; in_stock: number; updated_at: string }>(
      '/inventory',
      'inventory_levels',
      { updated_at_min: updatedAtMin },
    ),
    fetchAllPages<LoyverseItem>('/items', 'items'),
  ])

  const variantToName = new Map<string, string>()
  for (const item of items) {
    for (const v of item.variants ?? []) {
      variantToName.set(v.variant_id, item.item_name)
    }
  }

  return levels
    .map((level) => ({
      id: `inv-${level.variant_id}-${level.updated_at}`,
      itemName: variantToName.get(level.variant_id) ?? level.variant_id,
      adminName: 'System',
      oldStock: 0,
      newStock: level.in_stock,
      changeAmount: 0,
      timestamp: level.updated_at,
    }))
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
}
