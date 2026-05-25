import type { ProductDto, StoreInfo } from '../types/products.js'

export const MOCK_STORES: StoreInfo[] = [
  { id: 'branch-001', name: 'Main Branch' },
  { id: 'branch-002', name: 'North Branch' },
  { id: 'branch-003', name: 'South Branch' },
]

const mockProductState: ProductDto[] = [
  {
    id: 'p-001',
    variantId: 'v-001',
    name: 'Mobil 1 Engine Oil 1L',
    sku: 'MOB-1L-001',
    stocks: [
      { storeId: 'branch-001', stock: 14 },
      { storeId: 'branch-002', stock: 7 },
      { storeId: 'branch-003', stock: 3 },
    ],
  },
  {
    id: 'p-002',
    variantId: 'v-002',
    name: 'Castrol GTX 5W-30',
    sku: 'CAS-5W30-002',
    stocks: [
      { storeId: 'branch-001', stock: 22 },
      { storeId: 'branch-002', stock: 10 },
      { storeId: 'branch-003', stock: 8 },
    ],
  },
  {
    id: 'p-003',
    variantId: 'v-003',
    name: 'Oil Filter',
    sku: 'OIL-FLT-010',
    stocks: [
      { storeId: 'branch-001', stock: 9 },
      { storeId: 'branch-002', stock: 5 },
      { storeId: 'branch-003', stock: 2 },
    ],
  },
]

export function getMockProducts(): ProductDto[] {
  return mockProductState.map((p) => ({
    ...p,
    stocks: p.stocks.map((s) => ({ ...s })),
  }))
}

export function updateMockProduct(
  itemId: string,
  updates: { storeId: string; stock: number }[],
): ProductDto | null {
  const product = mockProductState.find((p) => p.id === itemId)
  if (!product) return null

  for (const u of updates) {
    const cell = product.stocks.find((s) => s.storeId === u.storeId)
    if (cell) cell.stock = u.stock
  }

  return getMockProducts().find((p) => p.id === itemId) ?? null
}
