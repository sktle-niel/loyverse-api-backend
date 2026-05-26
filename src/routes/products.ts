import type { FastifyPluginAsync } from 'fastify'
import { authenticate, requireRole } from '../plugins/auth.js'
import { LoyverseApiError } from '../services/loyverseClient.js'
import { getProducts, getStores } from '../services/productsService.js'
import { submitStockChangeRequest } from '../services/stockRequestService.js'

const staffRoles = requireRole('admin', 'operator')

export const productsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { q?: string } }>(
    '/products',
    { preHandler: [authenticate, staffRoles] },
    async (req) => {
      const result = await getProducts(req.query.q)
      return {
        products: result.products,
        stores: result.stores,
        total: result.products.length,
        source: result.source,
      }
    },
  )

  app.get('/stores', { preHandler: [authenticate, staffRoles] }, async () => {
    return getStores()
  })

  app.patch<{
    Params: { itemId: string }
    Body: { updates?: { storeId: string; stock: number }[]; requestedBy?: string }
  }>(
    '/products/:itemId/stock',
    { preHandler: [authenticate, staffRoles] },
    async (req, reply) => {
      const updates = req.body?.updates
      if (!Array.isArray(updates) || updates.length === 0) {
        return reply.status(400).send({ error: 'Body must include updates: [{ storeId, stock }]' })
      }

      try {
        const result = await submitStockChangeRequest(
          req.params.itemId,
          updates,
          req.user?.displayName ?? req.body.requestedBy?.trim() ?? 'Staff',
        )
        return reply.status(202).send(result)
      } catch (err) {
        if (err instanceof LoyverseApiError) {
          return reply.status(err.status).send({ error: err.message })
        }
        throw err
      }
    },
  )
}
