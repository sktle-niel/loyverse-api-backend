import type { RowDataPacket } from 'mysql2'
import { getPool, isMysqlConfigured } from '../db/pool.js'
import { LoyverseApiError } from '../services/loyverseClient.js'
import type { UserRecord, UserRole } from '../types/user.js'

interface UserRow extends RowDataPacket {
  id: string
  username: string
  email: string
  display_name: string
  password_hash: string
  role: UserRole
  is_active: number
  created_at: Date
  updated_at: Date
}

function rowToUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    role: row.role,
    isActive: row.is_active === 1,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

export function usersRequireDatabase(): void {
  if (!isMysqlConfigured()) {
    throw new LoyverseApiError(
      'User accounts require MySQL — set MYSQL_HOST, MYSQL_USER, MYSQL_DATABASE (and MYSQL_PASSWORD) on the server',
      503,
    )
  }
}

export async function countUsers(): Promise<number> {
  usersRequireDatabase()
  const pool = getPool()
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS count FROM users',
  )
  return Number(rows[0]?.count ?? 0)
}

export async function findUserByUsername(username: string): Promise<UserRecord | null> {
  usersRequireDatabase()
  const pool = getPool()
  const [rows] = await pool.query<UserRow[]>(
    'SELECT * FROM users WHERE username = ? LIMIT 1',
    [username.trim().toLowerCase()],
  )
  if (rows.length === 0) return null
  return rowToUser(rows[0])
}

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  usersRequireDatabase()
  const pool = getPool()
  const [rows] = await pool.query<UserRow[]>(
    'SELECT * FROM users WHERE email = ? LIMIT 1',
    [email.trim().toLowerCase()],
  )
  if (rows.length === 0) return null
  return rowToUser(rows[0])
}

export async function findUserByLogin(login: string): Promise<UserRecord | null> {
  const value = login.trim().toLowerCase()
  if (!value) return null

  if (value.includes('@')) {
    return findUserByEmail(value)
  }
  return findUserByUsername(value)
}

export async function findUserById(id: string): Promise<UserRecord | null> {
  usersRequireDatabase()
  const pool = getPool()
  const [rows] = await pool.query<UserRow[]>(
    'SELECT * FROM users WHERE id = ? LIMIT 1',
    [id],
  )
  if (rows.length === 0) return null
  return rowToUser(rows[0])
}

export async function listUsersByRole(role: UserRole): Promise<UserRecord[]> {
  usersRequireDatabase()
  const pool = getPool()
  const [rows] = await pool.query<UserRow[]>(
    'SELECT * FROM users WHERE role = ? ORDER BY created_at DESC',
    [role],
  )
  return rows.map(rowToUser)
}

export async function createUser(input: {
  id: string
  username: string
  email: string
  displayName: string
  passwordHash: string
  role: UserRole
}): Promise<UserRecord> {
  usersRequireDatabase()
  const pool = getPool()
  const now = new Date()
  await pool.query(
    `INSERT INTO users (id, username, email, display_name, password_hash, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      input.id,
      input.username.trim().toLowerCase(),
      input.email.trim().toLowerCase(),
      input.displayName.trim(),
      input.passwordHash,
      input.role,
      now,
      now,
    ],
  )

  const created = await findUserById(input.id)
  if (!created) throw new Error('Failed to create user')
  return created
}

export async function updateUserProfile(
  id: string,
  input: { displayName?: string; username?: string },
): Promise<UserRecord> {
  usersRequireDatabase()
  const sets: string[] = []
  const params: unknown[] = []
  if (input.username !== undefined) {
    sets.push('username = ?')
    params.push(input.username.trim().toLowerCase())
  }
  if (input.displayName !== undefined) {
    sets.push('display_name = ?')
    params.push(input.displayName.trim())
  }
  sets.push('updated_at = ?')
  params.push(new Date())
  params.push(id)

  const pool = getPool()
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params)

  const updated = await findUserById(id)
  if (!updated) throw new Error('Failed to update user')
  return updated
}

export async function updateUserPassword(id: string, passwordHash: string): Promise<void> {
  usersRequireDatabase()
  const pool = getPool()
  await pool.query('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
    passwordHash,
    new Date(),
    id,
  ])
}
