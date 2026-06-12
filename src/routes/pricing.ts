import type { FastifyPluginAsync } from 'fastify'
import { authenticate, requireRole } from '../plugins/auth.js'
import { LoyverseApiError } from '../services/loyverseClient.js'
import { getItemPrices, updateItemStorePrice } from '../services/pricingService.js'
import { listPriceHistory } from '../repositories/priceHistoryRepository.js'

const staffRoles = requireRole('admin', 'operator')

export const pricingRoutes: FastifyPluginAsync = async (app) => {
  // All items with fixed cost + per-store selling price
  app.get<{ Querystring: { q?: string; refresh?: string } }>(
    '/item-prices',
    { preHandler: [authenticate, staffRoles] },
    async (req, reply) => {
      try {
        const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true'
        const { result, isLoading, progress } = await getItemPrices(forceRefresh)

        const q = req.query.q?.trim().toLowerCase()
        const items = q
          ? result.items.filter((it) => {
              const hay = `${it.name} ${it.sku}`.toLowerCase()
              return q.split(/\s+/).every((term) => hay.includes(term))
            })
          : result.items

        return {
          items,
          stores: result.stores,
          total: result.total,
          filtered: items.length,
          source: result.source,
          cachedAt: result.cachedAt,
          isLoading,
          progress,
        }
      } catch (err) {
        if (err instanceof LoyverseApiError) {
          return reply.status(err.status).send({ error: err.message })
        }
        throw err
      }
    },
  )

  // Update one item's selling price at one store → writes to Loyverse + records history
  app.patch<{
    Params: { itemId: string }
    Body: { storeId?: string; storeName?: string; variantId?: string; price?: number }
  }>(
    '/item-prices/:itemId/price',
    { preHandler: [authenticate, staffRoles] },
    async (req, reply) => {
      const { storeId, storeName, variantId, price } = req.body ?? {}
      if (!storeId || price == null) {
        return reply.status(400).send({ error: 'storeId and price are required' })
      }
      try {
        const { entry } = await updateItemStorePrice({
          itemId: req.params.itemId,
          variantId,
          storeId,
          storeName: storeName?.trim() || storeId,
          newPrice: Number(price),
          changedBy: req.user?.displayName ?? req.user?.username ?? 'Staff',
        })
        return { ok: true, entry, message: 'Price updated in Loyverse.' }
      } catch (err) {
        if (err instanceof LoyverseApiError) {
          return reply.status(err.status).send({ error: err.message })
        }
        throw err
      }
    },
  )

  // Price-change history for one item (most recent first)
  app.get<{ Params: { itemId: string } }>(
    '/item-prices/:itemId/history',
    { preHandler: [authenticate, staffRoles] },
    async (req, reply) => {
      try {
        const history = await listPriceHistory(req.params.itemId, 50)
        return { history, total: history.length }
      } catch (err) {
        if (err instanceof LoyverseApiError) {
          return reply.status(err.status).send({ error: err.message })
        }
        throw err
      }
    },
  )

  // All price changes across every item (most recent first) — for the Catalog History page
  app.get<{ Querystring: { limit?: string } }>(
    '/price-history',
    { preHandler: [authenticate, staffRoles] },
    async (req, reply) => {
      try {
        const limit = req.query.limit ? Number(req.query.limit) : 200
        const history = await listPriceHistory(undefined, limit)
        return { history, total: history.length }
      } catch (err) {
        if (err instanceof LoyverseApiError) {
          return reply.status(err.status).send({ error: err.message })
        }
        throw err
      }
    },
  )
}
