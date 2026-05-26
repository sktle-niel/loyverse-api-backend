import type { FastifyPluginAsync } from 'fastify'
import { authenticate, requireRole } from '../plugins/auth.js'
import { LoyverseApiError } from '../services/loyverseClient.js'
import { createOperatorAccount, listOperators } from '../services/authService.js'

const adminOnly = requireRole('admin')

export const usersRoutes: FastifyPluginAsync = async (app) => {
  app.get('/users/operators', { preHandler: [authenticate, adminOnly] }, async () => {
    const operators = await listOperators()
    return { operators, total: operators.length }
  })

  app.post<{
    Body: {
      username?: string
      email?: string
      password?: string
      displayName?: string
    }
  }>(
    '/users/operators',
    { preHandler: [authenticate, adminOnly] },
    async (req, reply) => {
      const username = req.body?.username?.trim()
      const email = req.body?.email?.trim()
      const password = req.body?.password ?? ''

      if (!username || !email || !password) {
        return reply.status(400).send({
          error: 'username, email, and password are required',
        })
      }

      try {
        const operator = await createOperatorAccount({
          username,
          email,
          password,
          displayName: req.body?.displayName,
        })
        return reply.status(201).send({
          operator,
          message: 'Operator account created',
        })
      } catch (err) {
        if (err instanceof LoyverseApiError) {
          return reply.status(err.status).send({ error: err.message })
        }
        throw err
      }
    },
  )
}
