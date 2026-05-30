export type UserRole = 'admin' | 'operator'

export interface UserRecord {
  id: string
  username: string
  email: string
  displayName: string
  passwordHash: string
  role: UserRole
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface AuthUser {
  id: string
  username: string
  email: string
  displayName: string
  role: UserRole
}

export interface PublicUser {
  id: string
  username: string
  email: string
  displayName: string
  role: UserRole
  createdAt: string
}

export interface LoginResponse {
  token: string
  refreshToken: string
  user: AuthUser
}
