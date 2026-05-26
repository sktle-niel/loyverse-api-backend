import type { FastifyPluginAsync } from 'fastify'
import { authenticate } from '../plugins/auth.js'
import { LoyverseApiError } from '../services/loyverseClient.js'
import { login, registerUser } from '../services/authService.js'
import type { UserRole } from '../types/user.js'

const VALID_ROLES = new Set<UserRole>(['admin', 'operator'])

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post<{
    Body: { login?: string; username?: string; password?: string }
  }>('/auth/login', async (req, reply) => {
    const loginId = (req.body?.login ?? req.body?.username ?? '').trim()
    const password = req.body?.password ?? ''
    if (!loginId || !password) {
      return reply.status(400).send({ error: 'login (username or email) and password are required' })
    }

    try {
      return await login(loginId, password)
    } catch (err) {
      if (err instanceof LoyverseApiError) {
        return reply.status(err.status).send({ error: err.message })
      }
      throw err
    }
  })

  app.post<{
    Body: {
      username?: string
      email?: string
      password?: string
      displayName?: string
      role?: string
      bootstrapSecret?: string
    }
  }>('/auth/register', async (req, reply) => {
    const username = req.body?.username?.trim()
    const email = req.body?.email?.trim()
    const password = req.body?.password ?? ''
    const role = req.body?.role as UserRole | undefined
    const displayName = req.body?.displayName?.trim() ?? username ?? ''

    if (!username || !email || !password || !role || !VALID_ROLES.has(role)) {
      return reply.status(400).send({
        error: 'username, email, password, and role (admin|operator) are required',
      })
    }

    let createdByAdmin = false
    const authHeader = req.headers.authorization
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const { verifyAuthToken } = await import('../services/authService.js')
        const user = await verifyAuthToken(authHeader.slice(7).trim())
        if (user.role !== 'admin') {
          return reply.status(403).send({ error: 'Only admins can create accounts' })
        }
        createdByAdmin = true
      } catch {
        return reply.status(401).send({ error: 'Invalid admin token' })
      }
    }

    try {
      return await registerUser({
        username,
        email,
        password,
        displayName,
        role,
        bootstrapSecret: req.body?.bootstrapSecret,
        createdByAdmin,
      })
    } catch (err) {
      if (err instanceof LoyverseApiError) {
        return reply.status(err.status).send({ error: err.message })
      }
      throw err
    }
  })

  app.get('/auth/me', { preHandler: [authenticate] }, async (req) => {
    return { user: req.user! }
  })
}
