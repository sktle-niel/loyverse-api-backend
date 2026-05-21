import type { AuditRecord } from '../types/audit.js'
import type { LoyverseEmployee, LoyverseItem, LoyverseReceipt } from '../types/loyverse.js'
import { MOCK_AUDIT_RECORDS } from '../data/mockAudit.js'
import { fetchAllPages, isLoyverseConfigured } from './loyverseClient.js'

export interface AuditResult {
  records: AuditRecord[]
  total: number
  source: 'loyverse' | 'mock'
}

const AUDIT_DAYS = 3


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
  const now = Date.now()
  const fromMs = now - AUDIT_DAYS * 24 * 60 * 60 * 1000

  // We fetch a little more than AUDIT_DAYS to compute old/new stock from consecutive snapshots.
  // (Old stock = the latest snapshot before this record.)
  const extendedMin = new Date(fromMs - 24 * 60 * 60 * 1000).toISOString()

  const [levels, items] = await Promise.all([
    fetchAllPages<{ variant_id: string; in_stock: number; updated_at: string; store_id: string }>(
      '/inventory',
      'inventory_levels',
      { updated_at_min: extendedMin },
    ),
    fetchAllPages<LoyverseItem>('/items', 'items'),
  ])


  const variantToName = new Map<string, string>()
  for (const item of items) {
    for (const v of item.variants ?? []) {
      variantToName.set(v.variant_id, item.item_name)
    }
  }

  // Sort snapshots ascending so we can track previous TOTAL in-stock per variant (across branches/stores).
  const sorted = [...levels].sort(
    (a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime(),
  )

  // Track last known in_stock per (variant_id, store_id)
  const lastByVariantStore = new Map<string, number>()

  // Track last emitted total per variant
  const prevTotalByVariant = new Map<string, { total: number; updated_at: string }>()

  // Helper: stable key for variant/store
  const vsKey = (variant_id: string, store_id: string) => `${variant_id}::${store_id}`

  const records: AuditRecord[] = []

  for (const level of sorted) {
    const levelTs = new Date(level.updated_at).getTime()

    // Update our rolling store-level snapshot even if outside the window,
    // so totals become correct when we enter the time range.
    lastByVariantStore.set(vsKey(level.variant_id, level.store_id), level.in_stock)

    if (levelTs < fromMs) continue

    // Compute total across all stores for this variant.
    let total = 0
    for (const [key, in_stock] of lastByVariantStore.entries()) {
      if (!key.startsWith(`${level.variant_id}::`)) continue
      total += in_stock
    }

    const prev = prevTotalByVariant.get(level.variant_id)
    const oldStock = prev?.total ?? 0
    const newStock = total

    // Change format: +N if stock increased, -N if stock decreased.
    // (So UI can directly show added/removed amounts.)
    const delta = newStock - oldStock

    if (delta === 0) {
      prevTotalByVariant.set(level.variant_id, { total: newStock, updated_at: level.updated_at })
      continue
    }

    const changeAmount = delta


    const itemName = variantToName.get(level.variant_id) ?? level.variant_id

    records.push({
      id: `inv-${level.variant_id}-${level.updated_at}`,
      itemName,
      adminName: 'System',
      oldStock,
      newStock,
      changeAmount,
      timestamp: level.updated_at,
    })

    prevTotalByVariant.set(level.variant_id, { total: newStock, updated_at: level.updated_at })
  }


  records.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  return records
}

