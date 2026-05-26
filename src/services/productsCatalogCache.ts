import type { ProductDto, StoreInfo } from '../types/products.js'

export interface CatalogSnapshot {
  products: ProductDto[]
  stores: StoreInfo[]
  source: 'loyverse' | 'mock'
  loadedAt: string
}

let snapshot: CatalogSnapshot | null = null
let loadPromise: Promise<CatalogSnapshot> | null = null
let loader: ((force: boolean) => Promise<CatalogSnapshot>) | null = null

export function registerCatalogLoader(fn: (force: boolean) => Promise<CatalogSnapshot>): void {
  loader = fn
}

export function getCatalogSnapshot(): CatalogSnapshot | null {
  return snapshot
}

export function invalidateCatalogCache(): void {
  snapshot = null
  loadPromise = null
}

export async function ensureCatalogLoaded(force = false): Promise<CatalogSnapshot> {
  if (!loader) {
    throw new Error('Catalog loader is not registered')
  }

  if (!force && snapshot) {
    return snapshot
  }

  if (!force && loadPromise) {
    return loadPromise
  }

  if (force) {
    snapshot = null
    loadPromise = null
  }

  loadPromise = loader(force)
    .then((data) => {
      snapshot = data
      loadPromise = null
      return data
    })
    .catch((err) => {
      loadPromise = null
      throw err
    })

  return loadPromise
}

export function filterCatalogProducts(products: ProductDto[], query: string): ProductDto[] {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)

  if (terms.length === 0) return products

  return products.filter((p) => {
    const hay = `${p.name} ${p.sku}`.toLowerCase()
    return terms.every((term) => hay.includes(term))
  })
}
