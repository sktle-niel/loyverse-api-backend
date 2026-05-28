# Loyverse API Backend

Node.js + TypeScript + Fastify API for **Two Wheels Zone** (pairs with the React frontend).

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Copy env template
cp .env.example .env
# On Windows PowerShell: Copy-Item .env.example .env

# 3. Run dev server (auto-reload)
npm run dev
```

Open: http://localhost:3001/health

---

## API endpoints

### Health & status

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | — | Service health, MySQL status, storage type |
| GET | `/api/loyverse/status` | — | Test Loyverse token |

### Authentication

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/login` | — | Login → returns JWT + user |
| POST | `/api/auth/register` | Bootstrap or Bearer (admin) | Create user (first admin or operator) |
| GET | `/api/auth/me` | Bearer | Current user from token |

### User management

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/users/operators` | Bearer (admin) | List operators |
| POST | `/api/users/operators` | Bearer (admin) | Create operator |

### Products & inventory

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/products` | Bearer | Products with stock per Loyverse store |
| GET | `/api/products?q=mobil` | Bearer | Search by name or SKU |
| GET | `/api/products?refresh=1` | Bearer | Force reload from Loyverse |
| POST | `/api/products/refresh` | Bearer | Invalidate cache and reload |
| GET | `/api/stores` | Bearer | Loyverse store list |
| PATCH | `/api/products/:itemId/stock` | Bearer | Submit stock change → `202 pending` |

### Stock request approval

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/stock-requests` | Bearer (admin) | List queue |
| GET | `/api/stock-requests?status=pending` | Bearer (admin) | Filter by status |
| POST | `/api/stock-requests/:id/approve` | Bearer (admin) | Approve → updates Loyverse |
| POST | `/api/stock-requests/:id/reject` | Bearer (admin) | Reject with optional reason |

### Audit trail

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/audit` | Bearer (admin) | Inventory change history |

### Legacy inventory alerts

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/inventory` | — | Aggregated stock status |
| GET | `/api/inventory?status=low-stock` | — | Filter: `out-of-stock` · `low-stock` · `in-stock` |
| GET | `/api/inventory/summary` | — | Counts per status |

---

## How stock changes work

```
Operator: PATCH /api/products/:id/stock
  → status 202, request saved as "pending"
  → Loyverse is NOT touched

Admin: POST /api/stock-requests/:id/approve
  → fetches current stock from Loyverse (oldStock)
  → POST /inventory to Loyverse with new level
  → audit record written
  → status → "approved"

Admin: POST /api/stock-requests/:id/reject
  → status → "rejected", reason stored
  → Loyverse is NOT touched
```

---

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Dev server with hot reload (`tsx watch`) |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run production build |
| `npm run typecheck` | TypeScript check only |

---

## Environment

Copy `.env.example` to `.env`. Key variables:

| Variable | Notes |
|----------|-------|
| `LOYVERSE_ACCESS_TOKEN` | Loyverse Back Office → Integrations → Access tokens |
| `JWT_SECRET` | Min 16 chars — signs all auth tokens |
| `ADMIN_BOOTSTRAP_SECRET` | One-time secret to create the first admin |
| `MYSQL_HOST / USER / PASSWORD / DATABASE` | Hostinger DB; omit to use in-memory (dev only) |
| `CORS_ORIGIN` | Frontend origin(s), comma-separated |

See `AGENTS.md` for the full environment variable table and `docs/AUTH.md` for user setup.

---

## First-time setup

1. Set `ADMIN_BOOTSTRAP_SECRET` in `.env`
2. `POST /api/auth/register` with `{ username, email, password, role: "admin", bootstrapSecret: "..." }`
3. Use the returned JWT token for admin endpoints
4. Create operators via `POST /api/users/operators` with your admin Bearer token

---

## Frontend repo

Keep the React app in a **separate folder/repo** (e.g. `loyverse-api`). This repo is API only.

Set in frontend `.env`:

```
VITE_API_BASE_URL=http://localhost:3001
```

All API calls must include `Authorization: Bearer <token>`.
