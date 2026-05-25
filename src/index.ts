import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { healthRoutes } from './routes/health.js'
import { auditRoutes } from './routes/audit.js'
import { inventoryRoutes } from './routes/inventory.js'
import { loyverseRoutes } from './routes/loyverse.js'
import { productsRoutes } from './routes/products.js'

const PORT = Number(process.env.PORT) || 3001
const HOST = process.env.HOST ?? '0.0.0.0'
// Support both local testing and deployed frontend.
// Set CORS_ORIGIN in Render as your deployed frontend origin (NO trailing slash), e.g. https://my-frontend.onrender.com
// Optionally pass multiple origins as a comma-separated list.
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:5174'

const app = Fastify({ logger: true })

const allowedOrigins = Array.from(
  new Set(
    CORS_ORIGIN.split(',')
      .map((o) => o.trim())
      .filter(Boolean)
      // Always allow local dev as well (React dev server on Vite uses :5174 here).
      .concat('http://localhost:5174'),
  ),
)

await app.register(cors, {
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  // If your frontend does NOT use cookies/auth via credentials, keep default (false).
})

await app.register(healthRoutes)


await app.register(auditRoutes, { prefix: '/api' })
await app.register(inventoryRoutes, { prefix: '/api' })
await app.register(loyverseRoutes, { prefix: '/api' })
await app.register(productsRoutes, { prefix: '/api' })

try {
  await app.listen({ port: PORT, host: HOST })
  app.log.info(`API ready at http://localhost:${PORT}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
