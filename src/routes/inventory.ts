import type { FastifyPluginAsync } from 'fastify'
import { getInventory, type StockStatus } from '../services/inventoryService.js'

const VALID_STATUS = new Set<StockStatus>(['in-stock', 'low-stock', 'out-of-stock'])

export const inventoryRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { status?: string } }>('/inventory', async (req) => {
    const statusParam = req.query.status
    const statusFilter =
      statusParam && VALID_STATUS.has(statusParam as StockStatus)
        ? (statusParam as StockStatus)
        : undefined

    const result = await getInventory(statusFilter)

    return {
      items: result.items.map((i) => ({ itemName: i.itemName, stock: i.stock, status: i.status })),
      summary: result.summary,
      total: result.items.length,
      source: result.source,
    }
  })

  app.get('/inventory/summary', async () => {
    const result = await getInventory()
    return { summary: result.summary, source: result.source }
  })
}
