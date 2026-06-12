import type { FastifyPluginAsync } from 'fastify'
import { authenticate, requireRole } from '../plugins/auth.js'
import { LoyverseApiError } from '../services/loyverseClient.js'
import { getReceipts } from '../services/receiptsService.js'

const staffRoles = requireRole('admin', 'operator')

export const receiptsRoutes: FastifyPluginAsync = async (app) => {
  // Sales/refund receipts for a date range (+ optional store/employee filter)
  app.get<{ Querystring: { from?: string; to?: string; storeId?: string; employeeId?: string } }>(
    '/receipts',
    { preHandler: [authenticate, staffRoles] },
    async (req, reply) => {
      try {
        const result = await getReceipts({
          from: req.query.from,
          to: req.query.to,
          storeId: req.query.storeId,
          employeeId: req.query.employeeId,
        })
        return result
      } catch (err) {
        if (err instanceof LoyverseApiError) {
          return reply.status(err.status).send({ error: err.message })
        }
        throw err
      }
    },
  )
}
