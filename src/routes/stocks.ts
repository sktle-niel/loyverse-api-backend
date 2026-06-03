import type { FastifyPluginAsync } from 'fastify'
import { authenticate, requireRole } from '../plugins/auth.js'
import { LoyverseApiError } from '../services/loyverseClient.js'
import { getStockLevels, getSyncProgress, requestStopSync, resumeStockSync, hasPausedSync } from '../services/stockLevelsService.js'

const staffRoles = requireRole('admin', 'operator')

export const stocksRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { q?: string; refresh?: string } }>(
    '/stocks',
    { preHandler: [authenticate, staffRoles] },
    async (req, reply) => {
      try {
        const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true'
        const { result, isLoadingInBackground } = await getStockLevels(forceRefresh)

        const q = req.query.q?.trim().toLowerCase()
        const products = q
          ? result.products.filter((p) => {
              const hay = `${p.name} ${p.sku}`.toLowerCase()
              return q.split(/\s+/).every((term) => hay.includes(term))
            })
          : result.products

        return {
          products,
          stores: result.stores,
          total: result.total,
          filtered: products.length,
          source: result.source,
          cachedAt: result.cachedAt,
          isLoadingInBackground,
          syncProgress: isLoadingInBackground ? getSyncProgress() : null,
        }
      } catch (err) {
        if (err instanceof LoyverseApiError) {
          return reply.status(err.status).send({ error: err.message })
        }
        throw err
      }
    },
  )

  // Stop the running background sync; does nothing if no sync is active
  app.post(
    '/stocks/stop',
    { preHandler: [authenticate, staffRoles] },
    async (_req, _reply) => {
      requestStopSync()
      return { ok: true }
    },
  )

  // Resume a previously stopped sync (or trigger a fresh one if nothing was paused)
  app.post(
    '/stocks/resume',
    { preHandler: [authenticate, staffRoles] },
    async (_req, _reply) => {
      resumeStockSync()
      return { ok: true, hasPausedState: hasPausedSync() }
    },
  )
}
