import type { FastifyPluginAsync } from 'fastify'
import { authenticate, requireRole } from '../plugins/auth.js'
import { LoyverseApiError } from '../services/loyverseClient.js'
import {
  getVapidPublicKey,
  isPushConfigured,
  isEndpointSubscribed,
  removeSubscription,
  saveSubscription,
} from '../services/pushService.js'

const adminOnly = requireRole('admin')

export const pushRoutes: FastifyPluginAsync = async (app) => {
  // Return the VAPID public key so the frontend can subscribe
  app.get('/push/key', { preHandler: [authenticate, adminOnly] }, async (_req, reply) => {
    const key = getVapidPublicKey()
    if (!key) {
      return reply.status(503).send({ error: 'Push notifications are not configured on the server.' })
    }
    return { publicKey: key }
  })

  // Save a push subscription
  app.post<{
    Body: {
      endpoint?: string
      keys?: { p256dh?: string; auth?: string }
    }
  }>('/push/subscribe', { preHandler: [authenticate, adminOnly] }, async (req, reply) => {
    if (!isPushConfigured()) {
      return reply.status(503).send({ error: 'Push notifications are not configured on the server.' })
    }

    const { endpoint, keys } = req.body ?? {}
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return reply.status(400).send({ error: 'endpoint, keys.p256dh, and keys.auth are required' })
    }

    try {
      await saveSubscription({
        userId: req.user!.id,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      })
      return { ok: true }
    } catch (err) {
      if (err instanceof LoyverseApiError) {
        return reply.status(err.status).send({ error: err.message })
      }
      throw err
    }
  })

  // Remove a push subscription
  app.delete<{ Body: { endpoint?: string } }>(
    '/push/subscribe',
    { preHandler: [authenticate, adminOnly] },
    async (req, reply) => {
      const { endpoint } = req.body ?? {}
      if (!endpoint) {
        return reply.status(400).send({ error: 'endpoint is required' })
      }
      try {
        await removeSubscription(endpoint)
        return { ok: true }
      } catch (err) {
        if (err instanceof LoyverseApiError) {
          return reply.status(err.status).send({ error: err.message })
        }
        throw err
      }
    },
  )

  // Check if the current endpoint is subscribed
  app.post<{ Body: { endpoint?: string } }>(
    '/push/status',
    { preHandler: [authenticate, adminOnly] },
    async (req) => {
      const { endpoint } = req.body ?? {}
      if (!endpoint) return { subscribed: false }
      try {
        const subscribed = await isEndpointSubscribed(endpoint)
        return { subscribed }
      } catch {
        return { subscribed: false }
      }
    },
  )
}
