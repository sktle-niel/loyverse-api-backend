import type { FastifyPluginAsync } from 'fastify'
import { LoyverseApiError } from '../services/loyverseClient.js'
import { getProducts, getStores, updateProductStock } from '../services/productsService.js'

export const productsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { q?: string } }>('/products', async (req) => {
    const result = await getProducts(req.query.q)
    return {
      products: result.products,
      stores: result.stores,
      total: result.products.length,
      source: result.source,
    }
  })

  app.get('/stores', async () => {
    return getStores()
  })

  app.patch<{
    Params: { itemId: string }
    Body: { updates?: { storeId: string; stock: number }[]; adminName?: string }
  }>('/products/:itemId/stock', async (req, reply) => {
    const updates = req.body?.updates
    if (!Array.isArray(updates) || updates.length === 0) {
      return reply.status(400).send({ error: 'Body must include updates: [{ storeId, stock }]' })
    }

    try {
      const result = await updateProductStock(
        req.params.itemId,
        updates,
        req.body.adminName?.trim() || 'API Admin',
      )
      return result
    } catch (err) {
      if (err instanceof LoyverseApiError) {
        return reply.status(err.status).send({ error: err.message })
      }
      throw err
    }
  })
}
