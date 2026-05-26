import type { FastifyPluginAsync } from 'fastify'
import { authenticate, requireRole } from '../plugins/auth.js'
import { getAuditRecords } from '../services/auditService.js'

export const auditRoutes: FastifyPluginAsync = async (app) => {
  app.get('/audit', { preHandler: [authenticate, requireRole('admin')] }, async () => {
    const result = await getAuditRecords()
    return {
      records: result.records,
      total: result.total,
      source: result.source,
    }
  })
}
