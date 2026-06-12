import type { ReceiptDto, ReceiptEmployee, ReceiptsResult, ReceiptsSummary } from '../types/receipt.js'
import { fetchAllPages, isLoyverseConfigured } from './loyverseClient.js'
import { getStores } from './productsService.js'

// ── Loyverse raw shapes (only the fields we use) ───────────────────────────────
interface LoyverseReceiptLineItem {
  item_name?: string
  variant_name?: string | null
  quantity?: number
  price?: number
  total_money?: number
  gross_total_money?: number
}
interface LoyverseReceiptPayment {
  name?: string
  type?: string
  money_amount?: number
}
interface LoyverseReceipt {
  receipt_number: string
  receipt_type?: string
  created_at?: string
  receipt_date?: string
  cancelled_at?: string | null
  total_money?: number
  store_id?: string
  employee_id?: string
  customer_id?: string | null
  pos_device_id?: string
  line_items?: LoyverseReceiptLineItem[]
  payments?: LoyverseReceiptPayment[]
}

// ── Cached name lookups (employees + POS devices rarely change) ────────────────
interface NameCache {
  byId: Map<string, string>
  loadedAt: number
}
const NAME_TTL_MS = 10 * 60 * 1000
let employeeCache: NameCache | null = null
let posDeviceCache: NameCache | null = null

async function loadNames(
  cache: NameCache | null,
  path: string,
  listKey: string,
): Promise<{ cache: NameCache; byId: Map<string, string> }> {
  if (cache && Date.now() - cache.loadedAt < NAME_TTL_MS) return { cache, byId: cache.byId }
  const list = await fetchAllPages<{ id: string; name?: string }>(path, listKey, {}, 10)
  const byId = new Map(list.filter((x) => x.id).map((x) => [x.id, x.name ?? '']))
  const fresh: NameCache = { byId, loadedAt: Date.now() }
  return { cache: fresh, byId }
}

function toNum(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Fetches receipts (sales/refunds) for a date range, mapped to friendly names. */
export async function getReceipts(params: {
  from?: string // ISO datetime (created_at lower bound)
  to?: string // ISO datetime (created_at upper bound)
  storeId?: string
  employeeId?: string
}): Promise<ReceiptsResult> {
  const { stores } = await getStores()

  const emptySummary: ReceiptsSummary = { receipts: 0, sales: 0, refunds: 0, totalSales: 0 }
  if (!isLoyverseConfigured()) {
    return { receipts: [], summary: emptySummary, stores, employees: [], source: 'mock' }
  }

  // Default range = today (server local) if not provided; the frontend normally sends both.
  const createdAtMin = params.from || new Date(`${new Date().toLocaleDateString('en-CA')}T00:00:00`).toISOString()
  const createdAtMax = params.to || new Date().toISOString()

  const [emp, pos] = await Promise.all([
    loadNames(employeeCache, '/employees', 'employees'),
    loadNames(posDeviceCache, '/pos_devices', 'pos_devices'),
  ])
  employeeCache = emp.cache
  posDeviceCache = pos.cache
  const employeesById = emp.byId
  const posDevicesById = pos.byId

  const raw = await fetchAllPages<LoyverseReceipt>(
    '/receipts',
    'receipts',
    {
      created_at_min: createdAtMin,
      created_at_max: createdAtMax,
      ...(params.storeId ? { store_id: params.storeId } : {}),
      limit: 250,
    },
    40,
  )

  // Safety net: also bound client-side in case the API ignores the date params.
  const minT = new Date(createdAtMin).getTime()
  const maxT = new Date(createdAtMax).getTime()
  const inRange = raw.filter((r) => {
    const t = new Date(r.created_at ?? r.receipt_date ?? '').getTime()
    return !Number.isFinite(t) || (t >= minT && t <= maxT)
  })

  const storeNameById = new Map(stores.map((s) => [s.id, s.name]))

  let receipts: ReceiptDto[] = inRange.map((r) => {
    const type: 'SALE' | 'REFUND' = r.receipt_type === 'REFUND' ? 'REFUND' : 'SALE'
    return {
      receiptNumber: r.receipt_number,
      type,
      date: r.receipt_date || r.created_at || '',
      storeId: r.store_id ?? '',
      storeName: storeNameById.get(r.store_id ?? '') ?? (r.store_id ?? '—'),
      employeeId: r.employee_id ?? '',
      employeeName: employeesById.get(r.employee_id ?? '') || '—',
      customerName: null, // walk-in by default — customer names not resolved
      posDeviceName: posDevicesById.get(r.pos_device_id ?? '') || null,
      total: toNum(r.total_money),
      cancelledAt: r.cancelled_at ?? null,
      lineItems: (r.line_items ?? []).map((li) => ({
        itemName: li.item_name ?? 'Item',
        variantName: li.variant_name ?? null,
        quantity: toNum(li.quantity),
        price: toNum(li.price),
        total: toNum(li.total_money ?? li.gross_total_money),
      })),
      payments: (r.payments ?? []).map((p) => ({
        name: p.name || p.type || 'Payment',
        type: p.type ?? '',
        amount: toNum(p.money_amount),
      })),
    }
  })

  if (params.employeeId) {
    receipts = receipts.filter((r) => r.employeeId === params.employeeId)
  }

  // Newest first
  receipts.sort((a, b) => b.date.localeCompare(a.date))

  const summary: ReceiptsSummary = {
    receipts: receipts.length,
    sales: receipts.filter((r) => r.type === 'SALE').length,
    refunds: receipts.filter((r) => r.type === 'REFUND').length,
    totalSales: receipts.filter((r) => r.type === 'SALE').reduce((sum, r) => sum + r.total, 0),
  }

  const employees: ReceiptEmployee[] = [...employeesById.entries()]
    .map(([id, name]) => ({ id, name: name || id }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return { receipts, summary, stores, employees, source: 'loyverse' }
}
