import crypto from 'node:crypto'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { syncStockNow } from '../services/stockLevelsService.js'

/** Timing-safe compare of two hex signature strings. Returns false on any length/format mismatch. */
function signaturesMatch(provided: string, expected: string): boolean {
  try {
    const a = Buffer.from(provided, 'hex')
    const b = Buffer.from(expected, 'hex')
    if (a.length === 0 || a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * Loyverse webhook receiver. Loyverse POSTs here the instant inventory changes (e.g. a POS
 * sale), so stock stays accurate in near real-time instead of waiting for the ~20s poll.
 *
 * Design: we do NOT depend on the exact webhook payload shape. On any delivery we simply
 * trigger an immediate delta sync (GET /inventory?updated_since=…), which pulls the precise
 * changed records — correct regardless of what fields Loyverse sends. The existing periodic
 * delta sync stays on as a fallback for any missed webhook.
 *
 * Register the URL (once the backend has a public HTTPS URL) either at
 * https://r.loyverse.com/dashboard/#/webhooks or via the Loyverse /webhooks endpoint,
 * subscribing to the inventory-levels event.
 */
export const webhookRoutes: FastifyPluginAsync = async (app) => {
  app.post('/webhooks/loyverse', async (req: FastifyRequest & { rawBody?: string }, reply) => {
    const signingKey = process.env.LOYVERSE_WEBHOOK_SIGNING_KEY?.trim()

    if (signingKey) {
      const header = req.headers['x-loyverse-webhook-signature']
      const provided = Array.isArray(header) ? header[0] : header
      const expected = crypto
        .createHmac('sha256', signingKey)
        .update(req.rawBody ?? '')
        .digest('hex')

      if (!provided || !signaturesMatch(provided, expected)) {
        app.log.warn('[Webhook] Rejected Loyverse delivery — invalid or missing signature')
        return reply.status(401).send({ error: 'invalid signature' })
      }
    } else {
      // No key configured yet: accept but warn. After the first real delivery, confirm the
      // exact signature format from the logs, set LOYVERSE_WEBHOOK_SIGNING_KEY, and this
      // branch turns into enforced verification.
      app.log.warn(
        '[Webhook] LOYVERSE_WEBHOOK_SIGNING_KEY not set — accepting unverified webhook. Set it to enforce signature checks.',
      )
    }

    const eventType = (req.body as { type?: string } | undefined)?.type
    app.log.info({ event: eventType ?? 'unknown' }, '[Webhook] Loyverse event received — refreshing stock')

    // Acknowledge immediately; refresh runs in the background so Loyverse never times out/retries.
    syncStockNow()
    return reply.status(200).send({ ok: true })
  })
}
