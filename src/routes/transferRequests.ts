import type { FastifyPluginAsync } from 'fastify'
import { authenticate, requireRole } from '../plugins/auth.js'
import { LoyverseApiError } from '../services/loyverseClient.js'
import {
  submitTransferRequest,
  getTransferRequests,
  approveTransferRequest,
  rejectTransferRequest,
  cancelTransferRequest,
} from '../services/transferRequestService.js'

const adminOnly = requireRole('admin')
const staffRoles = requireRole('admin', 'operator')

export const transferRequestRoutes: FastifyPluginAsync = async (app) => {
  // Submit a transfer request (operator)
  app.post<{ Body: { itemId: string; fromStoreId: string; toStoreId: string; quantity: number; requestedBy?: string } }>(
    '/transfer-requests',
    { preHandler: [authenticate, staffRoles] },
    async (req, reply) => {
      try {
        const result = await submitTransferRequest(req.body)
        return reply.status(201).send(result)
      } catch (err) {
        if (err instanceof LoyverseApiError) return reply.status(err.status).send({ error: err.message })
        throw err
      }
    },
  )

  // List transfer requests — admin sees all, operator sees their own
  app.get<{ Querystring: { status?: string } }>(
    '/transfer-requests',
    { preHandler: [authenticate, staffRoles] },
    async (req, reply) => {
      try {
        const requests = await getTransferRequests(req.query.status)
        return { requests, total: requests.length }
      } catch (err) {
        if (err instanceof LoyverseApiError) return reply.status(err.status).send({ error: err.message })
        throw err
      }
    },
  )

  // Approve (admin only)
  app.patch<{ Params: { id: string }; Body: { reviewedBy?: string } }>(
    '/transfer-requests/:id/approve',
    { preHandler: [authenticate, adminOnly] },
    async (req, reply) => {
      try {
        const request = await approveTransferRequest(req.params.id, req.body?.reviewedBy ?? 'Admin')
        return { request, message: 'Transfer approved. Loyverse stock updated.' }
      } catch (err) {
        if (err instanceof LoyverseApiError) return reply.status(err.status).send({ error: err.message })
        throw err
      }
    },
  )

  // Reject (admin only)
  app.patch<{ Params: { id: string }; Body: { reviewedBy?: string; reason?: string } }>(
    '/transfer-requests/:id/reject',
    { preHandler: [authenticate, adminOnly] },
    async (req, reply) => {
      try {
        const request = await rejectTransferRequest(req.params.id, req.body?.reviewedBy ?? 'Admin', req.body?.reason)
        return { request, message: 'Transfer rejected.' }
      } catch (err) {
        if (err instanceof LoyverseApiError) return reply.status(err.status).send({ error: err.message })
        throw err
      }
    },
  )

  // Cancel (operator — own only; admin — any)
  app.patch<{ Params: { id: string }; Body: { cancelledBy?: string; isAdmin?: boolean } }>(
    '/transfer-requests/:id/cancel',
    { preHandler: [authenticate, staffRoles] },
    async (req, reply) => {
      try {
        const request = await cancelTransferRequest(
          req.params.id,
          req.body?.cancelledBy ?? 'Operator',
          req.body?.isAdmin ?? false,
        )
        return { request, message: 'Transfer cancelled.' }
      } catch (err) {
        if (err instanceof LoyverseApiError) return reply.status(err.status).send({ error: err.message })
        throw err
      }
    },
  )
}
