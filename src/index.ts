import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { healthRoutes } from './routes/health.js'
import { auditRoutes } from './routes/audit.js'
import { inventoryRoutes } from './routes/inventory.js'
import { loyverseRoutes } from './routes/loyverse.js'
import { productsRoutes } from './routes/products.js'
import { stockRequestRoutes } from './routes/stockRequests.js'
import { authRoutes } from './routes/auth.js'
import { usersRoutes } from './routes/users.js'
import { pushRoutes } from './routes/push.js'
import { stocksRoutes } from './routes/stocks.js'
import { transferRequestRoutes } from './routes/transferRequests.js'
import { itemStockRoutes } from './routes/itemStock.js'
import { pricingRoutes } from './routes/pricing.js'
import { stocksDebugRoutes } from './routes/stocksDebug.js'
import { initVapid } from './services/pushService.js'
import { warmStockCache } from './services/stockLevelsService.js'
import { initDatabaseSchema } from './db/initSchema.js'
import { isMysqlConfigured, testMysqlConnection } from './db/pool.js'
import { isUsingDatabase } from './data/stockRequests.js'
import { isLoyverseConfigured } from './services/loyverseClient.js'
import { ensureCatalogLoaded } from './services/productsCatalogCache.js'

const PORT = Number(process.env.PORT) || 3001
const HOST = process.env.HOST ?? '0.0.0.0'
// Support both local testing and deployed frontend.
// Set CORS_ORIGIN in Render as your deployed frontend origin (NO trailing slash), e.g. https://my-frontend.onrender.com
// Optionally pass multiple origins as a comma-separated list.
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? ''

const LOCAL_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
]

const app = Fastify({ logger: true })

const allowedOrigins = Array.from(
  new Set(
    CORS_ORIGIN.split(',')
      .map((o) => o.trim())
      .filter(Boolean)
      .concat(LOCAL_DEV_ORIGINS),
  ),
)

await app.register(rateLimit, { global: false })

await app.register(cors, {
  origin: (origin, callback) => {
    // Non-browser clients (curl, health checks) may omit Origin
    if (!origin) {
      callback(null, true)
      return
    }
    if (allowedOrigins.includes(origin)) {
      callback(null, true)
      return
    }
    callback(new Error(`CORS: origin not allowed: ${origin}`), false)
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
})

await app.register(healthRoutes)

await app.register(authRoutes, { prefix: '/api' })
await app.register(usersRoutes, { prefix: '/api' })
await app.register(auditRoutes, { prefix: '/api' })
await app.register(inventoryRoutes, { prefix: '/api' })
await app.register(loyverseRoutes, { prefix: '/api' })
await app.register(productsRoutes, { prefix: '/api' })
await app.register(stockRequestRoutes, { prefix: '/api' })
await app.register(pushRoutes, { prefix: '/api' })
await app.register(stocksRoutes, { prefix: '/api' })
await app.register(transferRequestRoutes, { prefix: '/api' })
await app.register(itemStockRoutes, { prefix: '/api' })
await app.register(pricingRoutes, { prefix: '/api' })

// Diagnostic-only route (GET /api/stocks/debug). Hits Loyverse heavily, so keep it off
// in production. Set ENABLE_DEBUG_ROUTES=true in .env to expose it (admin-gated either way).
if (process.env.ENABLE_DEBUG_ROUTES === 'true') {
  await app.register(stocksDebugRoutes, { prefix: '/api' })
  app.log.warn('Debug routes ENABLED (ENABLE_DEBUG_ROUTES=true) — /api/stocks/debug is live')
}

if (isMysqlConfigured()) {
  try {
    await initDatabaseSchema()
    await testMysqlConnection()
    app.log.info('MySQL connected — schema ready (users, stock_requests)')
  } catch (err) {
    app.log.error({ err }, 'MySQL connection failed — check MYSQL_* in .env')
    process.exit(1)
  }
} else {
  app.log.warn(
    'MYSQL_* not set — login and stock requests will fail until MySQL is configured. Set MYSQL_* on Render (see docs/HOSTINGER-MYSQL.md).',
  )
}

initVapid()

// Start catalog warm-load before accepting connections so loadPromise is always set
// when the first /api/products request arrives. Fire-and-forget — server starts immediately.
if (isLoyverseConfigured()) {
  void ensureCatalogLoaded(false)
    .then(async (catalog) => {
      app.log.info(`Loyverse catalog ready: ${catalog.products.length} products`)
      // Warm stock cache immediately on startup
      void warmStockCache()
    })
    .catch((err) => {
      app.log.warn({ err }, 'Loyverse catalog warm-up failed — will retry on first /api/products request')
    })

  // Keep cache fresh every 30 minutes even with no active users.
  // warmStockCache is idempotent — skips if a sync is already running or data is still fresh.
  const CACHE_REFRESH_INTERVAL = 30 * 60 * 1000
  setInterval(() => {
    app.log.info('[StockLevels] Scheduled 30-min cache refresh')
    void warmStockCache()
  }, CACHE_REFRESH_INTERVAL)
}

try {
  await app.listen({ port: PORT, host: HOST })
  app.log.info(
    `API ready at http://localhost:${PORT} (stock requests: ${isUsingDatabase() ? 'mysql' : 'memory'})`,
  )
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
