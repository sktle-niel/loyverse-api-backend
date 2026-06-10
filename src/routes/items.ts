import type { FastifyPluginAsync } from 'fastify'
import { authenticate, requireRole } from '../plugins/auth.js'
import { LoyverseApiError } from '../services/loyverseClient.js'
import { createItem, getCategories } from '../services/itemsService.js'
import type { CreateItemInput } from '../types/items.js'

const staffRoles = requireRole('admin', 'operator')

export const itemsRoutes: FastifyPluginAsync = async (app) => {
  // Categories for the Add Item form's dropdown
  app.get('/categories', { preHandler: [authenticate, staffRoles] }, async (_req, reply) => {
    try {
      const categories = await getCategories()
      return { categories }
    } catch (err) {
      if (err instanceof LoyverseApiError) {
        return reply.status(err.status).send({ error: err.message })
      }
      throw err
    }
  })

  // Create a new product in Loyverse
  app.post<{ Body: CreateItemInput }>(
    '/items',
    { preHandler: [authenticate, staffRoles] },
    async (req, reply) => {
      try {
        const result = await createItem(req.body ?? ({} as CreateItemInput))
        return reply.status(201).send({ ok: true, ...result, message: 'Item created in Loyverse.' })
      } catch (err) {
        if (err instanceof LoyverseApiError) {
          return reply.status(err.status).send({ error: err.message })
        }
        throw err
      }
    },
  )
}
