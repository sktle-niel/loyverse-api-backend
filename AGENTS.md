# Loyverse API Backend — Agent Context

**Business:** Two Wheels Zone — motor parts & lubricants (Loyverse POS).

**Goal:** Backend proxy to Loyverse — fetch products with **per-store stock**, allow **stock edits via approval workflow**, and expose an **audit trail** for the React frontend.

**Related repo:** React frontend (`loyverse-api`) — calls this API only; never holds `LOYVERSE_ACCESS_TOKEN`.

**Stack:** Fastify 5 · TypeScript · MySQL 8 (Hostinger) · JWT (jose) · bcrypt

---

## End-to-end flow

```
[Staff app — inventory UI]
   GET  /api/products              → read catalog (cached, per-store stock)
   PATCH /api/products/:id/stock   → submit change (pending only, 202)
        │
        ▼
[This backend — approval queue]
   GET  /api/stock-requests?status=pending
   POST /api/stock-requests/:id/approve  → POST /inventory to Loyverse
   POST /api/stock-requests/:id/reject   → no Loyverse write
        │
        ▼
[Admin website] (separate UI, same API)
        │
        ▼
[Loyverse] — updated only on approve
```

**Important:** `PATCH .../stock` does **not** write to Loyverse. It creates a `pending` request. Loyverse is updated only when an admin calls **approve**.

**Rule:** All Loyverse HTTP calls live in `src/services/loyverseClient.ts`. No route file may call Loyverse directly.

---

## Authentication

- **Roles:** `admin` (full access) · `operator` (view + submit stock changes)
- **JWT:** Bearer token in `Authorization` header; 7-day default TTL
- **Bootstrap:** First admin created via `POST /api/auth/register` with `ADMIN_BOOTSTRAP_SECRET`
- All `/api/*` routes are protected except `/api/loyverse/status`, `/api/inventory*`, and `/health`
- See `docs/AUTH.md` for the full user setup guide

### Stock request state machine

```
SUBMIT → pending  (saved to MySQL / in-memory; oldStock backfilled async)
              ↓
         admin approves  →  approved  (Loyverse POST /inventory, audit written)
         admin rejects   →  rejected  (rejectionReason stored, no Loyverse change)
```

---

## Features map

### 1. Products & stock per store (Inventory page)

**User story:** List all products; show stock for each Loyverse store (branch); edit and save.

| Field | Source |
|-------|--------|
| `id` | Loyverse `item.id` |
| `variantId` | Primary variant (default or first) — used for stock API |
| `name` | `item_name` |
| `sku` | variant `sku` |
| `stocks` | Empty on catalog load — fetched from Loyverse only on submit/approve |

**Catalog caching:** Products are cached in-memory + disk (`.catalog_cache.json`). TTL 5 min (configurable). Stale-while-revalidate — returns cached data immediately, refreshes in background. Cache schema version `v4` — auto-invalidates on logic changes.

**Routes:**

- `GET /api/products?q=&refresh=1` — products + `stores[]` + `source`; `refresh=1` force-reloads from Loyverse
- `POST /api/products/refresh` — invalidate cache and reload (admin/operator)
- `GET /api/stores` — store list only
- `PATCH /api/products/:itemId/stock` — body: `{ storeId, stock }` or legacy `updates: [{ storeId, stock }]`

**Submit (operator/admin):** Returns `202` with `{ request, message }`. Loyverse unchanged. `oldStock` is backfilled asynchronously.

**Approve (admin):** Fetches `oldStock` from Loyverse at approval time, posts new level, writes audit records, sets `status: "approved"`.

**Reject (admin):** Sets `status: "rejected"` with optional `rejectionReason`. No Loyverse change.

Pending queue: **MySQL** when `MYSQL_*` env vars are set (Hostinger phpMyAdmin). Falls back to in-memory (dev only). Schema: `src/db/schema.sql`. Setup: `docs/HOSTINGER-MYSQL.md`.

### 2. Audit trail (Dashboard)

**Route:** `GET /api/audit` (admin only)

Sources merged, newest first:

1. Runtime in-memory audit from approved requests (`src/data/runtimeAudit.ts`, max 500 entries)
2. Loyverse receipts (last 3 days) + inventory snapshot enrichment
3. Fallback: inventory level updates
4. Mock data if token missing or Loyverse errors

**Audit record shape:**

```ts
{
  id: string
  itemName: string
  adminName: string
  branchId?: string   // Loyverse store id
  oldStock: number
  newStock: number
  changeAmount: number
  timestamp: string   // ISO
}
```

### 3. User management

- `POST /api/auth/login` — returns JWT + `AuthUser`
- `POST /api/auth/register` — bootstrap (first user) or admin-only
- `GET /api/auth/me` — current user from token
- `GET /api/users/operators` — list operators (admin)
- `POST /api/users/operators` — create operator (admin)

### 4. Legacy inventory alerts (Reports)

**Routes:** `GET /api/inventory?status=low-stock`, `GET /api/inventory/summary`

Aggregates stock across all stores per item name. Rules: `0` = out-of-stock · `1–3` = low-stock · `4+` = in-stock. No auth required (legacy).

---

## API routes

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/health` | GET | — | Health check (returns MySQL status, storage type) |
| `/api/loyverse/status` | GET | — | Test Loyverse token, return 5 sample items |
| `/api/auth/login` | POST | — | JWT login |
| `/api/auth/register` | POST | Bootstrap / admin Bearer | Create user |
| `/api/auth/me` | GET | Bearer | Current user |
| `/api/users/operators` | GET | Bearer + admin | List operators |
| `/api/users/operators` | POST | Bearer + admin | Create operator |
| `/api/products` | GET | Bearer (operator, admin) | Products + per-store stock |
| `/api/products/refresh` | POST | Bearer (operator, admin) | Force catalog reload |
| `/api/stores` | GET | Bearer (operator, admin) | Loyverse store list |
| `/api/products/:itemId/stock` | PATCH | Bearer (operator, admin) | Submit stock change (pending) |
| `/api/stock-requests` | GET | Bearer + admin | Approval queue |
| `/api/stock-requests/:id/approve` | POST | Bearer + admin | Approve → Loyverse |
| `/api/stock-requests/:id/reject` | POST | Bearer + admin | Reject |
| `/api/audit` | GET | Bearer + admin | Audit trail |
| `/api/inventory` | GET | — | Legacy (unprotected) |
| `/api/inventory/summary` | GET | — | Legacy |

---

## Repository layout

```
src/
  index.ts                    # App entry: Fastify setup, CORS, route registration, DB init, catalog warm-load
  plugins/
    auth.ts                   # authenticate() + requireRole() Fastify decorators
  routes/
    health.ts
    auth.ts                   # login, register, me
    users.ts                  # operator management
    products.ts               # /api/products, /stores, PATCH stock, approve, reject
    stockRequests.ts          # GET /api/stock-requests
    audit.ts
    inventory.ts              # legacy alerts
    loyverse.ts               # status check
  services/
    loyverseClient.ts         # GET + POST to Loyverse, retry + timeout logic
    authService.ts            # JWT sign/verify, bcrypt, user lookup
    productsService.ts        # catalog logic, Loyverse fetches, stock reads
    productsCatalogCache.ts   # stale-while-revalidate, disk cache
    stockRequestService.ts    # submit / approve / reject workflow
    auditService.ts           # merge audit sources
    inventoryService.ts       # legacy stock aggregation
  data/
    stockRequests.ts          # routes to MySQL repo or in-memory fallback
    runtimeAudit.ts           # in-memory FIFO audit (max 500)
    mockProducts.ts
    mockAudit.ts
    mockInventory.ts
  types/
    user.ts
    audit.ts
    products.ts
    loyverse.ts
    stockRequest.ts
  db/
    pool.ts                   # MySQL connection pool (lazy init)
    schema.sql                # DDL for users + stock_requests tables
    initSchema.ts             # Runs schema.sql on startup
    migrateStockRequests.ts   # Column migrations (store_id, old_stock, etc.)
    userRepository.ts         # CRUD for users table
    stockRequestRepository.ts # CRUD for stock_requests table
docs/
  AUTH.md
  HOSTINGER-MYSQL.md
.catalog_cache.json           # Disk cache (auto-generated, do not commit)
```

---

## Environment

| Variable | Required | Notes |
|----------|----------|-------|
| `PORT` | No | Default `3001` |
| `HOST` | No | Default `0.0.0.0` |
| `CORS_ORIGIN` | No | Frontend origin(s), comma-separated |
| `LOYVERSE_ACCESS_TOKEN` | Yes (prod) | Back Office → Integrations → Access tokens |
| `LOYVERSE_API_BASE_URL` | No | Default `https://api.loyverse.com/v1.0` |
| `LOYVERSE_FULL_MAX_PAGES` | No | Max pages for catalog load (default `80`, ~20k items) |
| `LOYVERSE_STOCK_LOOKUP_MAX_PAGES` | No | Max pages for per-variant stock lookup (default `50`) |
| `CATALOG_CACHE_TTL_MS` | No | Catalog cache TTL in ms (default `300000` = 5 min) |
| `MYSQL_HOST` | Yes (prod) | Hostinger DB host |
| `MYSQL_USER` | Yes (prod) | Database user |
| `MYSQL_PASSWORD` | Yes (prod) | Database password |
| `MYSQL_DATABASE` | Yes (prod) | Database name |
| `MYSQL_PORT` | No | Default `3306` |
| `JWT_SECRET` | Yes (prod) | Min 16 chars — signs all tokens |
| `JWT_EXPIRES_IN` | No | Default `7d` |
| `ADMIN_BOOTSTRAP_SECRET` | Yes (first setup) | Used to create the first admin user |

---

## Frontend integration

In frontend `.env`:

```
VITE_API_BASE_URL=http://localhost:3001
```

**Inventory page:**

1. `GET /api/products` → render table (map `stores` to column headers)
2. On save → `PATCH /api/products/:itemId/stock` (shows "pending approval", Loyverse unchanged)
3. Admin site → approve/reject via `/api/stock-requests/...`
4. After approve → `GET /api/audit` shows the change

**Auth:** All API calls must include `Authorization: Bearer <token>` from login response.

---

## Commands

```bash
npm install
npm run dev      # http://localhost:3001
npm run typecheck
npm run build && npm start
```

---

## Do / Don't for agents

**Do:**

- Keep secrets in `.env` only
- Match `AuditRecord` and product DTOs to the frontend
- Add routes under `src/routes/` + logic in `src/services/`
- Keep all Loyverse HTTP calls in `src/services/loyverseClient.ts`
- Document store-level stock (not summed) for the Inventory page
- Return `202` for submitted stock changes (not `200`)

**Don't:**

- Expose `LOYVERSE_ACCESS_TOKEN` to the frontend
- Break `PATCH /api/products/:itemId/stock` without updating the frontend
- Assume one variant per item without checking `variants[]`
- Write directly to Loyverse from a route file
- Mix admin and operator access on the same endpoint without `requireRole`

---

## Loyverse setup

- **Access token:** Back Office → Integrations → Access tokens
- **Stores:** `GET /stores` — each store = branch column in UI (`MOBILE STORE` excluded in `productsService`)
- **Stock read:** `GET /inventory` → `inventory_levels`
- **Stock write:** `POST /inventory` with `inventory_levels` array
- **Catalog:** `GET /items` (cursor-based pagination)
- **Receipts:** `GET /receipts` (used for audit trail, 3-day window)
- **Employees:** `GET /employees` (used for audit author names)
- **Advanced Inventory** may affect adjustment history on your plan
