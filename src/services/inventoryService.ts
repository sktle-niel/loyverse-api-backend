import type { LoyverseInventoryLevel, LoyverseItem } from '../types/loyverse.js'
import { fetchAllPages, isLoyverseConfigured } from './loyverseClient.js'

export type StockStatus = 'in-stock' | 'low-stock' | 'out-of-stock'

export interface InventoryItem {
  itemName: string
  stock: number
  status: StockStatus
}

export interface InventoryResult {
  items: InventoryItem[]
  summary: Record<StockStatus, number>
  source: 'loyverse' | 'mock'
}

export function classifyStock(stock: number): StockStatus {
  if (stock === 0) return 'out-of-stock'
  if (stock < 4) return 'low-stock'
  return 'in-stock'
}

function buildVariantNameMap(items: LoyverseItem[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const item of items) {
    if (item.deleted_at) continue
    for (const variant of item.variants ?? []) {
      map.set(variant.variant_id, item.item_name)
    }
  }
  return map
}

function aggregateStockByItemName(
  levels: LoyverseInventoryLevel[],
  variantToName: Map<string, string>,
): Map<string, number> {
  const totals = new Map<string, number>()

  for (const level of levels) {
    const name = variantToName.get(level.variant_id)
    if (!name) continue
    totals.set(name, (totals.get(name) ?? 0) + level.in_stock)
  }

  return totals
}

export async function getInventory(statusFilter?: StockStatus): Promise<InventoryResult> {
  if (!isLoyverseConfigured()) {
    return getMockInventory(statusFilter)
  }

  const [items, levels] = await Promise.all([
    fetchAllPages<LoyverseItem>('/items', 'items', {}, 15),
    fetchAllPages<LoyverseInventoryLevel>('/inventory', 'inventory_levels', {}, 15),
  ])

  const variantToName = buildVariantNameMap(items)
  const stockByItem = aggregateStockByItemName(levels, variantToName)

  const inventoryItems: InventoryItem[] = []
  for (const [itemName, stock] of stockByItem) {
    const status = classifyStock(stock)
    inventoryItems.push({ itemName, stock, status })
  }

  inventoryItems.sort((a, b) => a.stock - b.stock)

  const filtered = statusFilter
    ? inventoryItems.filter((i) => i.status === statusFilter)
    : inventoryItems

  return {
    items: filtered,
    summary: summarize(inventoryItems),
    source: 'loyverse',
  }
}

function summarize(items: InventoryItem[]): Record<StockStatus, number> {
  return {
    'out-of-stock': items.filter((i) => i.status === 'out-of-stock').length,
    'low-stock': items.filter((i) => i.status === 'low-stock').length,
    'in-stock': items.filter((i) => i.status === 'in-stock').length,
  }
}

async function getMockInventory(statusFilter?: StockStatus): Promise<InventoryResult> {
  const { getMockStockByItem } = await import('../data/mockInventory.js')
  const stockByItem = getMockStockByItem()

  const inventoryItems: InventoryItem[] = [...stockByItem.entries()].map(
    ([itemName, stock]) => ({
      itemName,
      stock,
      status: classifyStock(stock),
    }),
  )

  inventoryItems.sort((a, b) => a.stock - b.stock)

  const filtered = statusFilter
    ? inventoryItems.filter((i) => i.status === statusFilter)
    : inventoryItems

  return {
    items: filtered,
    summary: summarize(inventoryItems),
    source: 'mock',
  }
}
