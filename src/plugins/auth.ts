import type { FastifyReply, FastifyRequest } from 'fastify'
import { LoyverseApiError } from '../services/loyverseClient.js'
import { verifyAuthToken } from '../services/authService.js'
import type { AuthUser, UserRole } from '../types/user.js'

import type { AuthUser } from '../types/user.js'

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser
  }
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    reply.status(401).send({ error: 'Missing or invalid Authorization header' })
    return
  }

  try {
    request.user = await verifyAuthToken(header.slice(7).trim())
  } catch (err) {
    const status = err instanceof LoyverseApiError ? err.status : 401
    const message = err instanceof Error ? err.message : 'Unauthorized'
    return reply.status(status).send({ error: message })
  }
}

export function requireRole(...roles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      reply.status(401).send({ error: 'Unauthorized' })
      return
    }
    if (!roles.includes(request.user.role)) {
      return reply.status(403).send({ error: 'Forbidden — insufficient role' })
    }
  }
}
