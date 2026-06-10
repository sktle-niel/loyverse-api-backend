import type { CategoryDto, CreateItemInput } from '../types/items.js'
import { fetchAllPages, isLoyverseConfigured, loyversePost, LoyverseApiError } from './loyverseClient.js'
import { invalidateCatalogCache } from './productsCatalogCache.js'
import { invalidatePricingCache } from './pricingService.js'

interface LoyverseCategory {
  id: string
  name: string
  deleted_at?: string | null
}

const VALID_COLORS = new Set([
  'GREY', 'RED', 'PINK', 'ORANGE', 'YELLOW', 'GREEN', 'BLUE', 'PURPLE',
])
const VALID_FORMS = new Set(['SQUARE', 'CIRCLE', 'SCALLOPED', 'HEXAGON'])

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Loyverse categories for the "Category" dropdown. */
export async function getCategories(): Promise<CategoryDto[]> {
  if (!isLoyverseConfigured()) return []
  const cats = await fetchAllPages<LoyverseCategory>('/categories', 'categories', {}, 10)
  return cats
    .filter((c) => !c.deleted_at && c.id)
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Creates a new product in Loyverse (POST /items) mirroring the Back Office "Create item" form.
 * This is a create (no id), so it never overwrites existing data — a bad payload is rejected.
 */
export async function createItem(input: CreateItemInput): Promise<{ id?: string; itemName: string }> {
  if (!isLoyverseConfigured()) throw new LoyverseApiError('Loyverse is not configured', 503)

  const name = input.name?.trim()
  if (!name) throw new LoyverseApiError('Item name is required', 400)

  const cost = toNum(input.cost) ?? 0
  if (cost < 0) throw new LoyverseApiError('Cost must be ≥ 0', 400)

  const defaultPrice = toNum(input.defaultPrice)

  // Build per-store pricing/availability lines.
  // FIXED only when there's an actual price; otherwise VARIABLE (price entered upon sale).
  const stores = (input.stores ?? []).map((s) => {
    const finalPrice = toNum(s.price) ?? defaultPrice
    return {
      store_id: s.storeId,
      pricing_type: finalPrice != null ? ('FIXED' as const) : ('VARIABLE' as const),
      price: finalPrice,
      available_for_sale: !!s.available,
    }
  })

  const variant: Record<string, unknown> = {
    cost,
    default_price: defaultPrice,
    default_pricing_type: defaultPrice != null ? 'FIXED' : 'VARIABLE',
    stores,
  }
  if (input.sku?.trim()) variant.sku = input.sku.trim()
  if (input.barcode?.trim()) variant.barcode = input.barcode.trim()

  const payload: Record<string, unknown> = {
    item_name: name,
    sold_by_weight: !!input.soldByWeight,
    track_stock: !!input.trackStock,
    is_composite: false,
    variants: [variant],
  }
  if (input.categoryId) payload.category_id = input.categoryId
  if (input.description?.trim()) payload.description = input.description.trim()
  if (input.color && VALID_COLORS.has(input.color)) payload.color = input.color
  if (input.form && VALID_FORMS.has(input.form)) payload.form = input.form

  console.log(`[Items] Creating item "${name}" (${stores.length} stores)`)
  const created = await loyversePost<{ id?: string; item_name?: string }>('/items', payload)

  // New item → refresh caches so it shows up in the catalog / price list.
  invalidateCatalogCache()
  invalidatePricingCache()

  return { id: created?.id, itemName: created?.item_name ?? name }
}
