import type { FastifyPluginAsync } from 'fastify'
import { MOCK_AUDIT_RECORDS } from '../data/mockAudit.js'

/** Audit trail — mock for now; replace with Loyverse API calls later */
export const auditRoutes: FastifyPluginAsync = async (app) => {
  app.get('/audit', async () => ({
    records: MOCK_AUDIT_RECORDS,
    total: MOCK_AUDIT_RECORDS.length,
  }))
}
