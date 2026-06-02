import type { FastifyPluginAsync } from 'fastify'
import { authenticate, requireRole } from '../plugins/auth.js'
import { ensureCatalogLoaded } from '../services/productsCatalogCache.js'
import { fetchCurrentStockForVariant } from '../services/productsService.js'
import { fetchAllPages } from '../services/loyverseClient.js'
import type { LoyverseInventoryLevel } from '../types/loyverse.js'

const adminOnly = requireRole('admin')

/**
 * Temporary debug route — helps diagnose why specific items show 0 stock.
 * GET /api/stocks/debug?item=052+TYS
 */
export const stocksDebugRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { item?: string } }>(
    '/stocks/debug',
    { preHandler: [authenticate, adminOnly] },
    async (req) => {
      const query = (req.query.item ?? '').trim().toLowerCase()
      const catalog = await ensureCatalogLoaded(false)

      // 1. Find the item in catalog
      const found = query
        ? catalog.products.filter(p => p.name.toLowerCase().includes(query))
        : catalog.products.slice(0, 5)

      if (found.length === 0) {
        return { message: `No catalog product found matching "${query}"`, catalogTotal: catalog.products.length }
      }

      const product = found[0]

      // 2. Check if variantId is in catalog's variantIdToItemId map
      const variantMap = catalog.variantIdToItemId ?? {}
      const inVariantMap = Object.prototype.hasOwnProperty.call(variantMap, product.variantId)

      // 3. Try fetching stock directly per store (this is the method used in approvals — known to work)
      const directStocks: Record<string, number> = {}
      for (const store of catalog.stores) {
        try {
          const stock = await fetchCurrentStockForVariant(product.variantId, store.id, {
            retries: 1,
            logRetries: false,
            maxPages: 5,
          })
          directStocks[store.name] = stock
        } catch {
          directStocks[store.name] = -1 // error
        }
      }

      // 4. Check first 2 pages of bulk /inventory for this variant_id
      const bulkSample = await fetchAllPages<LoyverseInventoryLevel>(
        '/inventory', 'inventory_levels', {}, 2
      )
      const matchingBulkRecords = bulkSample.filter(l => l.variant_id === product.variantId)

      return {
        catalogProduct: {
          name: product.name,
          sku: product.sku,
          id: product.id,
          variantId: product.variantId,
        },
        variantIdInCatalogMap: inVariantMap,
        directStockPerStore: directStocks,
        bulkInventorySampleSize: bulkSample.length,
        matchingRecordsInFirstTwoPages: matchingBulkRecords,
        diagnosis: matchingBulkRecords.length === 0
          ? 'variant_id NOT found in first 500 bulk inventory records — item may be beyond page limit OR variant_id mismatch in bulk fetch'
          : 'variant_id FOUND in bulk — mapping should work',
      }
    },
  )
}
