import type { FastifyPluginAsync } from 'fastify'
import { LoyverseApiError, isLoyverseConfigured } from '../services/loyverseClient.js'

/** Test Loyverse connection and token */
export const loyverseRoutes: FastifyPluginAsync = async (app) => {
  app.get('/loyverse/status', async (_req, reply) => {
    if (!isLoyverseConfigured()) {
      return reply.status(503).send({
        ok: false,
        configured: false,
        message: 'Set LOYVERSE_ACCESS_TOKEN in .env',
      })
    }

    try {
      const { loyverseFetch } = await import('../services/loyverseClient.js')
      const data = await loyverseFetch<{ items: Array<{ id: string; item_name: string }> }>(
        '/items',
        { limit: 5 },
      )
      const items = data.items ?? []

      return {
        ok: true,
        configured: true,
        message: 'Connected to Loyverse API',
        sampleItemCount: items.length,
      }
    } catch (err) {
      const status = err instanceof LoyverseApiError ? err.status : 502
      return reply.status(status).send({
        ok: false,
        configured: true,
        message: err instanceof Error ? err.message : 'Loyverse API request failed',
      })
    }
  })
}
