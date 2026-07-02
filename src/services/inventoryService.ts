import { isLoyverseConfigured } from './loyverseClient.js'
import { getStockLevels } from './stockLevelsService.js'

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

export async function getInventory(statusFilter?: StockStatus): Promise<InventoryResult> {
  if (!isLoyverseConfigured()) {
    return getMockInventory(statusFilter)
  }

  // Reuse the shared, warm stock-levels cache instead of making our own uncached full
  // fetch to Loyverse. This lets the inventory page load instantly from cache and stops
  // it from competing for Loyverse's rate limit during a stock-levels reset/full sync.
  const { result } = await getStockLevels(false)

  // Each StockLevelProduct already sums its variants per store; total per item = sum
  // across stores. Group by item name to match the previous name-based aggregation.
  const totals = new Map<string, number>()
  for (const product of result.products) {
    const total = product.stocks.reduce((sum, s) => sum + s.stock, 0)
    totals.set(product.name, (totals.get(product.name) ?? 0) + total)
  }

  const inventoryItems: InventoryItem[] = []
  for (const [itemName, stock] of totals) {
    inventoryItems.push({ itemName, stock, status: classifyStock(stock) })
  }

  inventoryItems.sort((a, b) => a.stock - b.stock)

  const filtered = statusFilter
    ? inventoryItems.filter((i) => i.status === statusFilter)
    : inventoryItems

  return {
    items: filtered,
    summary: summarize(inventoryItems),
    source: result.source,
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
