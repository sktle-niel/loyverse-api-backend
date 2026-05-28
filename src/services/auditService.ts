import type { AuditRecord } from '../types/audit.js'
import type { LoyverseEmployee, LoyverseItem, LoyverseReceipt } from '../types/loyverse.js'
import { MOCK_AUDIT_RECORDS } from '../data/mockAudit.js'
import { getRuntimeAudit } from '../data/runtimeAudit.js'
import { listStockRequestsFromDb, useMysqlForStockRequests } from '../repositories/stockRequestRepository.js'
import { fetchAllPages, isLoyverseConfigured } from './loyverseClient.js'

export interface AuditResult {
  records: AuditRecord[]
  total: number
  source: 'loyverse' | 'mock' | 'mysql'
}

const AUDIT_DAYS = 3


function mergeAuditRecords(primary: AuditRecord[], runtime: AuditRecord[]): AuditRecord[] {
  const seen = new Set(primary.map((r) => r.id))
  const merged = [...runtime.filter((r) => !seen.has(r.id)), ...primary]
  merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  return merged
}

export async function getAuditRecords(): Promise<AuditResult> {
  if (useMysqlForStockRequests()) {
    const approved = await listStockRequestsFromDb('approved')

    const records: AuditRecord[] = approved.flatMap((req) => {
      const ts = req.reviewedAt ?? req.createdAt
      const adminName = req.reviewedBy ?? 'Admin'

      const changeAmount = req.newStock - req.oldStock
      return [
        {
          id: `${req.id}-${req.storeId}`,
          itemName: req.itemName,
          adminName,
          branchId: req.storeId,
          oldStock: req.oldStock,
          newStock: req.newStock,
          changeAmount,
          timestamp: ts,
        },
      ]
    })

    records.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    return { records, total: records.length, source: 'mysql' }
  }

  const runtime = getRuntimeAudit()

  if (!isLoyverseConfigured()) {
    const records = mergeAuditRecords(MOCK_AUDIT_RECORDS, runtime)
    return { records, total: records.length, source: 'mock' }
  }

  try {
    const records = mergeAuditRecords(await buildAuditFromLoyverse(), runtime)
    return { records, total: records.length, source: 'loyverse' }
  } catch {
    const records = mergeAuditRecords(MOCK_AUDIT_RECORDS, runtime)
    return { records, total: records.length, source: 'mock' }
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

      // qty sign semantics: positive means add, negative means remove.
      // (We keep magnitude only in changeAmount sign.)
      const qty = Math.abs(line.quantity)
      const isRefund = line.quantity < 0
      const changeAmount = isRefund ? -qty : qty

      // old/new will be computed from inventory snapshots around the receipt timestamp.
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

  if (records.length > 0) {
    // Enrich each receipt-derived record with oldStock/newStock totals across all stores.
    const enriched = await enrichReceiptStockTotals(records)
    enriched.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    return enriched
  }

  return buildAuditFromInventoryUpdates()
}

async function enrichReceiptStockTotals(records: AuditRecord[]): Promise<AuditRecord[]> {
  // We only need to compute totals for the variants present in `records`.
  // Since AuditRecord currently stores only itemName, we compute totals by itemName.
  // This is consistent with how inventory aggregation is done in the existing inventory fallback.

  const itemNames = Array.from(new Set(records.map((r) => r.itemName)))
  if (itemNames.length === 0) return records

  const now = Date.now()
  const fromMs = now - AUDIT_DAYS * 24 * 60 * 60 * 1000

  // Fetch inventory snapshots for a slightly extended window.
  // (OldStock/newStock are taken as the closest snapshots before/after each receipt timestamp.)
  const extendedMin = new Date(fromMs - 24 * 60 * 60 * 1000).toISOString()

  const [levels, items] = await Promise.all([
    fetchAllPages<{ variant_id: string; in_stock: number; updated_at: string; store_id: string }>(
      '/inventory',
      'inventory_levels',
      { updated_at_min: extendedMin },
    ),
    fetchAllPages<LoyverseItem>('/items', 'items'),
  ])

  const variantToItemName = new Map<string, string>()
  for (const item of items) {
    for (const v of item.variants ?? []) {
      if (item.deleted_at) continue
      variantToItemName.set(v.variant_id, item.item_name)
    }
  }

  // Pre-index snapshots: updated_at -> totals by itemName (sum across variants+stores)
  const snapshotTotals = new Map<string, Map<string, number>>()

  // Sort snapshots by time
  const sortedLevels = [...levels].sort(
    (a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime(),
  )

  for (const level of sortedLevels) {
    const itemName = variantToItemName.get(level.variant_id)
    if (!itemName) continue
    if (!itemNames.includes(itemName)) continue

    const ts = level.updated_at
    let totalsByItem = snapshotTotals.get(ts)
    if (!totalsByItem) {
      totalsByItem = new Map<string, number>()
      snapshotTotals.set(ts, totalsByItem)
    }

    totalsByItem.set(itemName, (totalsByItem.get(itemName) ?? 0) + level.in_stock)
  }

  const snapshotTimes = Array.from(snapshotTotals.keys()).sort(
    (a, b) => new Date(a).getTime() - new Date(b).getTime(),
  )

  const findClosest = (targetMs: number, direction: 'before' | 'after') => {
    // Simple linear search is OK for small snapshots; if too large, we can binary search.

    if (direction === 'before') {
      let best: string | undefined
      for (const t of snapshotTimes) {
        if (new Date(t).getTime() <= targetMs) best = t
        else break
      }
      return best
    }

    // after
    for (const t of snapshotTimes) {
      if (new Date(t).getTime() >= targetMs) return t
    }
    return undefined
  }

  const enriched = records.map((r) => {
    const tsMs = new Date(r.timestamp).getTime()
    const before = findClosest(tsMs, 'before')
    const after = findClosest(tsMs, 'after')

    const oldStock = before ? snapshotTotals.get(before)?.get(r.itemName) ?? 0 : 0
    const newStock = after ? snapshotTotals.get(after)?.get(r.itemName) ?? 0 : oldStock + r.changeAmount

    // Ensure changeAmount matches computed totals.
    const changeAmount = newStock - oldStock

    return { ...r, oldStock, newStock, changeAmount }
  })

  return enriched
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

