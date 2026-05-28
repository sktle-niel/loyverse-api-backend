import type { FastifyPluginAsync } from 'fastify'
import { authenticate, requireRole } from '../plugins/auth.js'
import { LoyverseApiError } from '../services/loyverseClient.js'
import { getProducts, getStores, refreshProductsCatalog } from '../services/productsService.js'
import { submitStockChangeRequest } from '../services/stockRequestService.js'

const staffRoles = requireRole('admin', 'operator')

export const productsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { q?: string; refresh?: string } }>(
    '/products',
    { preHandler: [authenticate, staffRoles] },
    async (req, reply) => {
      try {
        const refresh = req.query.refresh === '1' || req.query.refresh === 'true'
        const result = await getProducts(req.query.q, { refresh })
        return {
          products: result.products,
          stores: result.stores,
          total: result.products.length,
          source: result.source,
          catalogNote: result.catalogNote,
          catalogTotal: result.catalogTotal,
          cachedAt: result.cachedAt,
        }
      } catch (err) {
        if (err instanceof LoyverseApiError) {
          return reply.status(err.status).send({ error: err.message })
        }
        throw err
      }
    },
  )

  app.post('/products/refresh', { preHandler: [authenticate, staffRoles] }, async (_req, reply) => {
    try {
      const catalog = await refreshProductsCatalog()
      return {
        ok: true,
        total: catalog.products.length,
        cachedAt: catalog.loadedAt,
        source: catalog.source,
      }
    } catch (err) {
      if (err instanceof LoyverseApiError) {
        return reply.status(err.status).send({ error: err.message })
      }
      throw err
    }
  })

  app.get('/stores', { preHandler: [authenticate, staffRoles] }, async () => {
    return getStores()
  })

  app.patch<{
    Params: { itemId: string }
    Body: {
      storeId?: string
      stock?: number
      updates?: { storeId: string; stock: number }[]
      requestedBy?: string
    }
  }>(
    '/products/:itemId/stock',
    { preHandler: [authenticate, staffRoles] },
    async (req, reply) => {
      const body = req.body ?? {}
      let updates: { storeId: string; stock: number }[]

      if (body.storeId != null && body.stock != null) {
        updates = [{ storeId: String(body.storeId).trim(), stock: Number(body.stock) }]
      } else if (Array.isArray(body.updates) && body.updates.length > 0) {
        updates = body.updates
      } else {
        return reply.status(400).send({
          error: 'Body must include storeId and stock, or updates: [{ storeId, stock }]',
        })
      }

      try {
        const result = await submitStockChangeRequest(
          req.params.itemId,
          updates,
          req.user?.displayName ?? body.requestedBy?.trim() ?? 'Staff',
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
