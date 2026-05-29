import type { FastifyPluginAsync } from 'fastify'
import { authenticate, requireRole } from '../plugins/auth.js'
import { LoyverseApiError } from '../services/loyverseClient.js'
import type { StockRequestStatus } from '../types/stockRequest.js'
import { isUsingDatabase } from '../data/stockRequests.js'
import {
  approveStockRequest,
  cancelStockRequest,
  getStockRequests,
  rejectStockRequest,
} from '../services/stockRequestService.js'

function useStorageLabel(): 'mysql' | 'memory' {
  return isUsingDatabase() ? 'mysql' : 'memory'
}

const VALID_STATUS = new Set<StockRequestStatus>(['pending', 'approved', 'rejected', 'cancelled'])
const adminOnly = requireRole('admin')

export const stockRequestRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { status?: string } }>(
    '/stock-requests',
    { preHandler: [authenticate, adminOnly] },
    async (req) => {
    const statusParam = req.query.status
    const status =
      statusParam && VALID_STATUS.has(statusParam as StockRequestStatus)
        ? (statusParam as StockRequestStatus)
        : undefined

    const requests = await getStockRequests(status)
    return { requests, total: requests.length, storage: useStorageLabel() }
  },
  )

  app.get<{ Querystring: { status?: string } }>(
    '/stock-requests/mine',
    { preHandler: [authenticate] },
    async (req) => {
      const statusParam = req.query.status
      const status =
        statusParam && VALID_STATUS.has(statusParam as StockRequestStatus)
          ? (statusParam as StockRequestStatus)
          : undefined
      const requestedBy = req.user?.displayName ?? req.user?.username ?? ''
      const all = await getStockRequests(status)
      const mine = all.filter((r) => r.requestedBy === requestedBy)
      return { requests: mine, total: mine.length, storage: useStorageLabel() }
    },
  )

  app.post<{
    Params: { requestId: string }
    Body: { reviewedBy?: string }
  }>(
    '/stock-requests/:requestId/approve',
    { preHandler: [authenticate, adminOnly] },
    async (req, reply) => {
    try {
      const result = await approveStockRequest(
        req.params.requestId,
        req.user?.displayName ?? req.body?.reviewedBy?.trim() ?? 'Admin',
      )
      return {
        ...result,
        message: 'Approved. Stock updated in Loyverse.',
      }
    } catch (err) {
      if (err instanceof LoyverseApiError) {
        return reply.status(err.status).send({ error: err.message })
      }
      throw err
    }
  },
  )

  app.post<{
    Params: { requestId: string }
    Body: { reviewedBy?: string; rejectionReason?: string }
  }>(
    '/stock-requests/:requestId/reject',
    { preHandler: [authenticate, adminOnly] },
    async (req, reply) => {
    try {
      const request = await rejectStockRequest(
        req.params.requestId,
        req.user?.displayName ?? req.body?.reviewedBy?.trim() ?? 'Admin',
        req.body?.rejectionReason,
      )
      return {
        request,
        message: 'Rejected. Loyverse stock unchanged.',
      }
    } catch (err) {
      if (err instanceof LoyverseApiError) {
        return reply.status(err.status).send({ error: err.message })
      }
      throw err
    }
  },
  )

  app.post<{
    Params: { requestId: string }
  }>(
    '/stock-requests/:requestId/cancel',
    { preHandler: [authenticate] },
    async (req, reply) => {
      try {
        const cancelledBy = req.user?.displayName ?? req.user?.username ?? ''
        const isAdmin = req.user?.role === 'admin'
        const request = await cancelStockRequest(req.params.requestId, cancelledBy, isAdmin)
        return { request, message: 'Request cancelled.' }
      } catch (err) {
        if (err instanceof LoyverseApiError) {
          return reply.status(err.status).send({ error: err.message })
        }
        throw err
      }
    },
  )
}
