import webpush from 'web-push'
import {
  deletePushSubscriptionByEndpoint,
  getAllPushSubscriptions,
  getPushSubscriptionByEndpoint,
  upsertPushSubscription,
} from '../repositories/pushSubscriptionRepository.js'

export interface PushPayload {
  title: string
  body: string
  url?: string
}

export function isPushConfigured(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY?.trim() && process.env.VAPID_PRIVATE_KEY?.trim())
}

export function getVapidPublicKey(): string | undefined {
  return process.env.VAPID_PUBLIC_KEY?.trim()
}

export function initVapid(): void {
  const pub = process.env.VAPID_PUBLIC_KEY?.trim()
  const priv = process.env.VAPID_PRIVATE_KEY?.trim()
  if (!pub || !priv) return
  const email = process.env.VAPID_EMAIL?.trim() || 'mailto:admin@example.com'
  webpush.setVapidDetails(email, pub, priv)
}

export async function saveSubscription(input: {
  userId: string
  endpoint: string
  p256dh: string
  auth: string
}): Promise<void> {
  await upsertPushSubscription({
    id: crypto.randomUUID(),
    userId: input.userId,
    endpoint: input.endpoint,
    p256dh: input.p256dh,
    auth: input.auth,
    createdAt: new Date().toISOString(),
  })
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await deletePushSubscriptionByEndpoint(endpoint)
}

export async function isEndpointSubscribed(endpoint: string): Promise<boolean> {
  const sub = await getPushSubscriptionByEndpoint(endpoint)
  return sub !== null
}

export async function sendPushToAll(payload: PushPayload): Promise<void> {
  if (!isPushConfigured()) return

  const subscriptions = await getAllPushSubscriptions()
  if (subscriptions.length === 0) return

  const body = JSON.stringify(payload)

  const results = await Promise.allSettled(
    subscriptions.map((sub) =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
        { TTL: 60 * 60 * 24 }, // 24 hour TTL — deliver when device comes online
      ),
    ),
  )

  // Clean up gone/expired subscriptions
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    if (result.status === 'rejected') {
      const err = result.reason as { statusCode?: number }
      if (err.statusCode === 410 || err.statusCode === 404) {
        await deletePushSubscriptionByEndpoint(subscriptions[i].endpoint).catch(() => null)
      }
    }
  }
}
