import type { FastifyPluginAsync } from 'fastify'
import { authenticate, requireRole } from '../plugins/auth.js'
import { LoyverseApiError } from '../services/loyverseClient.js'
import { getItemPrices } from '../services/pricingService.js'

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
}
