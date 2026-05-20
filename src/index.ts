import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { healthRoutes } from './routes/health.js'
import { auditRoutes } from './routes/audit.js'
import { inventoryRoutes } from './routes/inventory.js'
import { loyverseRoutes } from './routes/loyverse.js'

const PORT = Number(process.env.PORT) || 3001
const HOST = process.env.HOST ?? '0.0.0.0'
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:5173'

const app = Fastify({ logger: true })

await app.register(cors, {
  origin: CORS_ORIGIN.split(',').map((o) => o.trim()),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
})

await app.register(healthRoutes)
await app.register(auditRoutes, { prefix: '/api' })
await app.register(inventoryRoutes, { prefix: '/api' })
await app.register(loyverseRoutes, { prefix: '/api' })

try {
  await app.listen({ port: PORT, host: HOST })
  app.log.info(`API ready at http://localhost:${PORT}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
