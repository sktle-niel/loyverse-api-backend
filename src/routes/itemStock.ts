import type { FastifyPluginAsync } from 'fastify'
import { authenticate, requireRole } from '../plugins/auth.js'
import { ensureCatalogLoaded, filterCatalogProducts } from '../services/productsCatalogCache.js'
import { getCachedProductStocks } from '../services/stockLevelsService.js'
import { fetchAllPages } from '../services/loyverseClient.js'
import type { LoyverseInventoryLevel } from '../types/loyverse.js'

const staffRoles = requireRole('admin', 'operator')

export const itemStockRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { q?: string } }>(
    '/item-stock',
    { preHandler: [authenticate, staffRoles] },
    async (req, _reply) => {
      const q = req.query.q?.trim() ?? ''
      if (q.length < 2) {
        return { products: [], stores: [], accurate: false }
      }

      const catalog = await ensureCatalogLoaded(false)
      const matching = filterCatalogProducts(catalog.products, q).slice(0, 20)

      if (matching.length === 0) {
        return { products: [], stores: catalog.stores, accurate: true }
      }

      const variantIdToItemId = catalog.variantIdToItemId ?? {}
      const storeIds = new Set(catalog.stores.map((s) => s.id))
      const storeNameById = new Map(catalog.stores.map((s) => [s.id, s.name]))
      const targetItemIds = new Set(matching.map((p) => p.id))

      // Step 1: cache as baseline (indexed, instant)
      const stockMap = getCachedProductStocks(matching.map((p) => p.id), variantIdToItemId)

      // Step 2: fetch delta using a 6-hour rolling window for accuracy
      // 6 hours covers any change made during the workday without fetching all 49,000 records.
      // Typical changes in 6 hours = 100-2,000 records (1-8 pages) — fast.
      const updatedSince = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
      try {
        const deltaLevels = await fetchAllPages<LoyverseInventoryLevel>(
          '/inventory',
          'inventory_levels',
          { updated_since: updatedSince },
          100, // 100 pages = 25,000 records — more than enough for 6 hours of changes
        )

        app.log.info(`[ItemStock] delta (last 6 hrs): ${deltaLevels.length} changed records`)

        for (const level of deltaLevels) {
          const itemId = variantIdToItemId[level.variant_id]
          if (!itemId || !targetItemIds.has(itemId) || !storeIds.has(level.store_id)) continue

          if (!stockMap.has(itemId)) stockMap.set(itemId, new Map())
          stockMap.get(itemId)!.set(level.store_id, Math.round(Number(level.in_stock)))
        }
      } catch (err) {
        app.log.warn({ err }, '[ItemStock] Delta fetch failed, returning cache baseline')
      }

      const products = matching.map((p) => ({
        id: p.id,
        variantId: p.variantId,
        name: p.name,
        sku: p.sku,
        stocks: catalog.stores.map((s) => ({
          storeId: s.id,
          storeName: storeNameById.get(s.id) ?? s.id,
          stock: stockMap.get(p.id)?.get(s.id) ?? 0,
        })),
      }))

      return { products, stores: catalog.stores, accurate: true }
    },
  )
}
