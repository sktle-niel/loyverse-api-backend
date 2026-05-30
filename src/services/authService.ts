import bcrypt from 'bcryptjs'
import * as jose from 'jose'
import { LoyverseApiError } from './loyverseClient.js'
import {
  countUsers,
  createUser,
  findUserByEmail,
  findUserById,
  findUserByLogin,
  findUserByUsername,
  listUsersByRole,
} from '../repositories/userRepository.js'
import type { AuthUser, LoginResponse, PublicUser, UserRecord, UserRole } from '../types/user.js'

const BCRYPT_ROUNDS = 12
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET?.trim()
  if (!secret || secret.length < 16) {
    throw new LoyverseApiError(
      'JWT_SECRET is not set or too short (min 16 characters)',
      503,
    )
  }
  return new TextEncoder().encode(secret)
}

function toAuthUser(user: UserRecord): AuthUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
  }
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt,
  }
}

function validateEmail(email: string): string {
  const normalized = email.trim().toLowerCase()
  if (!EMAIL_RE.test(normalized)) {
    throw new LoyverseApiError('Invalid email address', 400)
  }
  return normalized
}

function validateUsername(username: string): string {
  const normalized = username.trim().toLowerCase()
  if (normalized.length < 3) {
    throw new LoyverseApiError('Username must be at least 3 characters', 400)
  }
  if (!/^[a-z0-9._-]+$/.test(normalized)) {
    throw new LoyverseApiError(
      'Username may only contain letters, numbers, dots, hyphens, and underscores',
      400,
    )
  }
  return normalized
}

function validatePassword(password: string): void {
  if (password.length < 8) {
    throw new LoyverseApiError('Password must be at least 8 characters', 400)
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

export async function signAuthToken(user: AuthUser): Promise<string> {
  // JWT_ACCESS_EXPIRES_IN preferred; fall back to JWT_EXPIRES_IN for backward compat
  const expiresIn =
    process.env.JWT_ACCESS_EXPIRES_IN?.trim() ||
    process.env.JWT_EXPIRES_IN?.trim() ||
    '1h'
  return new jose.SignJWT({
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(getJwtSecret())
}

export async function signRefreshToken(userId: string): Promise<string> {
  const expiresIn = process.env.JWT_REFRESH_EXPIRES_IN?.trim() || '30d'
  return new jose.SignJWT({ type: 'refresh' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(getJwtSecret())
}

export async function verifyRefreshToken(token: string): Promise<string> {
  let payload: jose.JWTPayload
  try {
    const result = await jose.jwtVerify(token, getJwtSecret())
    payload = result.payload
  } catch {
    throw new LoyverseApiError('Invalid or expired refresh token', 401)
  }
  if ((payload as Record<string, unknown>).type !== 'refresh') {
    throw new LoyverseApiError('Invalid token type', 401)
  }
  const id = payload.sub
  if (!id || typeof id !== 'string') {
    throw new LoyverseApiError('Invalid token', 401)
  }
  return id
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<{ token: string; user: AuthUser }> {
  const userId = await verifyRefreshToken(refreshToken)
  const user = await findUserById(userId)
  if (!user || !user.isActive) {
    throw new LoyverseApiError('User not found or inactive', 401)
  }
  const authUser = toAuthUser(user)
  const token = await signAuthToken(authUser)
  return { token, user: authUser }
}

export async function verifyAuthToken(token: string): Promise<AuthUser> {
  const { payload } = await jose.jwtVerify(token, getJwtSecret())

  // Reject refresh tokens being used as access tokens
  if ((payload as Record<string, unknown>).type === 'refresh') {
    throw new LoyverseApiError('Invalid token', 401)
  }

  const id = payload.sub
  if (!id || typeof id !== 'string') {
    throw new LoyverseApiError('Invalid token', 401)
  }

  const user = await findUserById(id)
  if (!user || !user.isActive) {
    throw new LoyverseApiError('User not found or inactive', 401)
  }

  return toAuthUser(user)
}

export async function login(login: string, password: string): Promise<LoginResponse> {
  const user = await findUserByLogin(login)
  if (!user || !user.isActive) {
    throw new LoyverseApiError('Invalid username, email, or password', 401)
  }

  const ok = await verifyPassword(password, user.passwordHash)
  if (!ok) {
    throw new LoyverseApiError('Invalid username, email, or password', 401)
  }

  const authUser = toAuthUser(user)
  const token = await signAuthToken(authUser)
  const refreshToken = await signRefreshToken(authUser.id)
  return { token, refreshToken, user: authUser }
}

export async function registerUser(input: {
  username: string
  email: string
  password: string
  displayName: string
  role: UserRole
  bootstrapSecret?: string
  createdByAdmin?: boolean
}): Promise<LoginResponse> {
  const username = validateUsername(input.username)
  const email = validateEmail(input.email)
  validatePassword(input.password)

  const total = await countUsers()
  const bootstrap = process.env.ADMIN_BOOTSTRAP_SECRET?.trim()
  const canBootstrap =
    total === 0 &&
    bootstrap &&
    input.bootstrapSecret &&
    input.bootstrapSecret === bootstrap

  if (!canBootstrap && !input.createdByAdmin) {
    throw new LoyverseApiError(
      'Registration requires admin access or a valid bootstrap secret (first user only)',
      403,
    )
  }

  if (total === 0 && input.role !== 'admin') {
    throw new LoyverseApiError('First account must be an admin', 400)
  }

  if (await findUserByUsername(username)) {
    throw new LoyverseApiError('Username already exists', 409)
  }
  if (await findUserByEmail(email)) {
    throw new LoyverseApiError('Email already exists', 409)
  }

  const passwordHash = await hashPassword(input.password)
  const user = await createUser({
    id: crypto.randomUUID(),
    username,
    email,
    displayName: input.displayName.trim() || username,
    passwordHash,
    role: input.role,
  })

  const authUser = toAuthUser(user)
  const token = await signAuthToken(authUser)
  const refreshToken = await signRefreshToken(authUser.id)
  return { token, refreshToken, user: authUser }
}

export async function createOperatorAccount(input: {
  username: string
  email: string
  password: string
  displayName?: string
}): Promise<PublicUser> {
  const username = validateUsername(input.username)
  const email = validateEmail(input.email)
  validatePassword(input.password)

  if (await findUserByUsername(username)) {
    throw new LoyverseApiError('Username already exists', 409)
  }
  if (await findUserByEmail(email)) {
    throw new LoyverseApiError('Email already exists', 409)
  }

  const passwordHash = await hashPassword(input.password)
  const user = await createUser({
    id: crypto.randomUUID(),
    username,
    email,
    displayName: input.displayName?.trim() || username,
    passwordHash,
    role: 'operator',
  })

  return toPublicUser(user)
}

export async function listOperators(): Promise<PublicUser[]> {
  const users = await listUsersByRole('operator')
  return users.map(toPublicUser)
}

export async function getMe(userId: string): Promise<AuthUser> {
  const user = await findUserById(userId)
  if (!user || !user.isActive) {
    throw new LoyverseApiError('User not found', 404)
  }
  return toAuthUser(user)
}
