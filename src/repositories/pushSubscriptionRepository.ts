import type { RowDataPacket, ResultSetHeader } from 'mysql2'
import { getPool, isMysqlConfigured } from '../db/pool.js'

export interface PushSubscriptionRecord {
  id: string
  userId: string
  endpoint: string
  p256dh: string
  auth: string
  createdAt: string
}

interface PushSubRow extends RowDataPacket {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
  created_at: Date
}

// In-memory fallback for dev
const memSubs: PushSubscriptionRecord[] = []

function rowToRecord(row: PushSubRow): PushSubscriptionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

export async function upsertPushSubscription(
  record: PushSubscriptionRecord,
): Promise<void> {
  if (isMysqlConfigured()) {
    const pool = getPool()
    await pool.query(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE p256dh = VALUES(p256dh), auth = VALUES(auth), created_at = VALUES(created_at)`,
      [record.id, record.userId, record.endpoint, record.p256dh, record.auth, new Date(record.createdAt)],
    )
    return
  }
  const idx = memSubs.findIndex((s) => s.endpoint === record.endpoint)
  if (idx >= 0) {
    memSubs[idx] = record
  } else {
    memSubs.push(record)
  }
}

export async function deletePushSubscriptionByEndpoint(endpoint: string): Promise<void> {
  if (isMysqlConfigured()) {
    const pool = getPool()
    await pool.query<ResultSetHeader>('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint])
    return
  }
  const idx = memSubs.findIndex((s) => s.endpoint === endpoint)
  if (idx >= 0) memSubs.splice(idx, 1)
}

export async function deletePushSubscriptionsByUserId(userId: string): Promise<void> {
  if (isMysqlConfigured()) {
    const pool = getPool()
    await pool.query<ResultSetHeader>('DELETE FROM push_subscriptions WHERE user_id = ?', [userId])
    return
  }
  for (let i = memSubs.length - 1; i >= 0; i--) {
    if (memSubs[i].userId === userId) memSubs.splice(i, 1)
  }
}

export async function getAllPushSubscriptions(): Promise<PushSubscriptionRecord[]> {
  if (isMysqlConfigured()) {
    const pool = getPool()
    const [rows] = await pool.query<PushSubRow[]>('SELECT * FROM push_subscriptions')
    return rows.map(rowToRecord)
  }
  return [...memSubs]
}

export async function getPushSubscriptionByEndpoint(
  endpoint: string,
): Promise<PushSubscriptionRecord | null> {
  if (isMysqlConfigured()) {
    const pool = getPool()
    const [rows] = await pool.query<PushSubRow[]>(
      'SELECT * FROM push_subscriptions WHERE endpoint = ? LIMIT 1',
      [endpoint],
    )
    return rows[0] ? rowToRecord(rows[0]) : null
  }
  return memSubs.find((s) => s.endpoint === endpoint) ?? null
}
