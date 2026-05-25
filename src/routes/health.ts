import type { FastifyPluginAsync } from 'fastify'
import { isUsingDatabase } from '../data/stockRequests.js'
import { isMysqlConfigured } from '../db/pool.js'

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => ({
    ok: true,
    service: 'loyverse-api-backend',
    timestamp: new Date().toISOString(),
    stockRequestsStorage: isUsingDatabase() ? 'mysql' : 'memory',
    mysqlConfigured: isMysqlConfigured(),
  }))
}
