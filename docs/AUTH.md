# Users & roles (MySQL + JWT)

## Roles

| Role | Can do |
|------|--------|
| **operator** | Login, view products/stores, submit stock changes (pending) |
| **admin** | Everything operator can do + approval queue, approve/reject, audit trail |

## Database

Run `src/db/schema.sql` in phpMyAdmin (includes `users` + `stock_requests`).

## Environment

```env
JWT_SECRET=at-least-16-random-characters
JWT_EXPIRES_IN=7d
ADMIN_BOOTSTRAP_SECRET=choose-a-strong-secret
```

Add the same values on Render.

## Create first admin (empty database)

```http
POST /api/auth/register
Content-Type: application/json

{
  "username": "admin",
  "password": "your-secure-password",
  "displayName": "Main Admin",
  "role": "admin",
  "bootstrapSecret": "same-as-ADMIN_BOOTSTRAP_SECRET"
}
```

Works only when **no users exist yet**. Response includes `token` — save it.

## Login

```http
POST /api/auth/login
{ "username": "admin", "password": "..." }
```

Use header on all protected routes:

```
Authorization: Bearer <token>
```

## Create operator (admin only)

```http
POST /api/auth/register
Authorization: Bearer <admin-token>

{
  "username": "juan",
  "password": "operator-password",
  "displayName": "Juan",
  "role": "operator"
}
```

## Public routes

- `GET /health`
- `POST /api/auth/login`
- `POST /api/auth/register` (bootstrap or admin token)

All other `/api/*` business routes require a valid JWT.
