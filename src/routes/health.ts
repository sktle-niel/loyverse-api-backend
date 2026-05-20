import type { FastifyPluginAsync } from 'fastify'

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => ({
    ok: true,
    service: 'loyverse-api-backend',
    timestamp: new Date().toISOString(),
  }))
}
