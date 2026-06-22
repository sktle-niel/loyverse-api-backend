# Loyverse API Backend — Agent Context

**Business:** Two Wheels Zone — motor parts & lubricants (Loyverse POS).

**Goal:** Backend proxy to Loyverse — fetch products with **per-store stock**, run an **approval workflow for stock edits**, do **direct branch-to-branch transfers**, and expose an **audit trail** for the React frontend.

**Related repo:** React frontend (`loyverse-api`) — calls this API only; never holds `LOYVERSE_ACCESS_TOKEN`.

**Stack:** Fastify 5 · TypeScript · MySQL 8 (Hostinger) · JWT (jose) · bcrypt · web-push

> ⚠️ **Docs were last reconciled with the code on 2026-06-10.** Active dev branch is `test-api`. If you touch routes/services, update this file in the same change.

---

## Two write paths to Loyverse (read this first)

There are **two different stock flows** and they behave differently:

```
1. STOCK CHANGE (single store, add/correct quantity)  →  REQUIRES APPROVAL
   Operator: PATCH /api/products/:id/stock        → 202 pending (Loyverse NOT touched)
   Admin:    POST /api/stock-requests/:id/approve → POST /inventory to Loyverse + audit

2. TRANSFER (move stock between two stores)          →  NO APPROVAL (direct mode)
   Operator: POST /api/transfer-requests          → executes immediately in Loyverse,
                                                     status saved as "approved"
```

**Why the difference:** Transfers were switched to **direct mode** (commit `aeb5fe0 approval disabled`).
In `submitTransferRequest`, when Loyverse is configured the transfer is applied to Loyverse on the spot
(decrement source store, increment destination store) and recorded as `approved`. The pending/approval
branch only runs when **Loyverse is not configured** (i.e. local/mock dev).

**To re-enable transfer approval:** remove the "Direct mode" block in `transferRequestService.ts`
(`submitTransferRequest`) and let the pending block run. The admin approve/reject/cancel endpoints
already exist and still work — they're only reachable today when transfers are pending.

**Rule:** All Loyverse HTTP calls live in `src/services/loyverseClient.ts`. No route file may call Loyverse directly.

---

## Authentication

- **Roles:** `admin` (full access) · `operator` (view + submit stock changes + submit transfers)
- **JWT:** Bearer token in `Authorization` header; default TTL `7d`
- **Refresh token:** `POST /api/auth/refresh` issues a new access token from a refresh token (frontend
  auto-refreshes on `401`, deduped to one refresh at a time)
- **Bootstrap:** First admin created via `POST /api/auth/register` with `ADMIN_BOOTSTRAP_SECRET`
- **Login is rate-limited:** 10 attempts / 15 min per client
- Public (no auth): `/health`, `/api/loyverse/status`, `/api/auth/login`, `/api/auth/register`,
  `/api/auth/refresh`, `/api/inventory*`. Everything else requires a Bearer token.

### Stock-request state machine (flow 1 — still active)

```
SUBMIT → pending  (saved to MySQL / in-memory; oldStock backfilled async)
              ↓
         admin approves  →  approved  (resolves real oldStock from Loyverse, POST /inventory, audit)
         admin rejects   →  rejected  (rejectionReason stored, no Loyverse change)
         cancel          →  cancelled (operator can cancel own; admin can cancel any)
```

> Note: `newStock` on a stock request is the **additive change amount** entered by the operator.
> On approve, the absolute level written to Loyverse = real `oldStock` (fetched at approve time) + change.

---

## Stock-levels sync engine (`stockLevelsService.ts`)

The newest and most stateful subsystem. Powers the Transfer page, which needs near-real-time
per-store stock without paging ~49k inventory records on every request.

- **In-memory snapshot** (`variantStockMap`: variantId → storeId → stock), no disk cache.
- **TTL 15s.** After that the next read triggers a background **delta sync** (`/inventory?updated_since=`).
- **Full sync** pages through all `/inventory` records (cursor-based, limit 250, up to 500 pages),
  with live **progress %, ETA, partial results every 10 pages**, and cursor-based **pause/resume/stop**.
- **Self-scheduling:** re-warms ~20s after the last load; `index.ts` also fires a 30-min `setInterval`.
- **`syncGeneration` guard:** `invalidateStockCache()` bumps a counter; a running full sync checks it
  every page and bails (`SyncSupersededError`) so a reset never gets clobbered by an in-flight sync.
- **No stock filter:** `/api/stocks` returns **all** catalog products, including 0–2 stock, so operators can
  transfer low-stock items too. (A previous `stock > 2` filter was removed 2026-06-10.)
- Falls back to mock data when Loyverse is not configured.

Public helpers used elsewhere: `getCachedVariantStock`, `getCachedProductStocks`,
`updateCachedVariantStock` (used by transfer/approve to patch the cache in place after a write).

---

## Catalog cache (`productsCatalogCache.ts`)

Product/variant/store catalog (names, SKUs, variant→item map). In-memory + disk
(`.catalog_cache.json`), stale-while-revalidate, TTL 5 min (`CATALOG_CACHE_TTL_MS`). Separate from the
stock-levels snapshot above — catalog = identity, stock-levels = quantities.

---

## API routes

### Health & status
| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/health` | GET | — | Health check (MySQL status, storage type) |
| `/api/loyverse/status` | GET | — | Test Loyverse token, return sample items |

### Auth & users
| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/auth/login` | POST | — | JWT login (rate-limited 10/15min) |
| `/api/auth/register` | POST | Bootstrap / admin Bearer | Create user |
| `/api/auth/me` | GET | Bearer | Current user |
| `/api/auth/refresh` | POST | — (refresh token in body) | New access token |
| `/api/users/operators` | GET | admin | List operators |
| `/api/users/operators` | POST | admin | Create operator |

### Products & catalog
| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/products` | GET | staff | Catalog + per-store stock; `?q=` search, `?refresh=1` force reload |
| `/api/products/refresh` | POST | staff | Invalidate catalog cache and reload |
| `/api/stores` | GET | staff | Loyverse store list |
| `/api/products/:itemId/stock` | PATCH | staff | Submit stock change → `202 pending` |
| `/api/item-stock` | GET | staff | Search items + accurate stock (cache + 6h delta); `?q=` (min 2 chars) |

### Stock-change approval (flow 1)
| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/stock-requests` | GET | admin | Approval queue (`?status=`) |
| `/api/stock-requests/mine` | GET | Bearer | Caller's own requests |
| `/api/stock-requests/:id/approve` | POST | admin | Approve → Loyverse + audit |
| `/api/stock-requests/:id/reject` | POST | admin | Reject (reason optional) |
| `/api/stock-requests/:id/cancel` | POST | Bearer | Cancel (own, or any if admin) |

### Stock-levels sync (Transfer page data)
| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/stocks` | GET | staff | Transferable products + sync progress; `?q=`, `?refresh=1` |
| `/api/stocks/stop` | POST | staff | Stop the running background sync |
| `/api/stocks/resume` | POST | staff | Resume a paused sync (or start fresh) |

### Item pricing (Price List page)
| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/item-prices` | GET | staff | All items with fixed cost + per-store price; progressive load (`isLoading`, `progress`); `?q=`, `?refresh=1` |
| `/api/item-prices/:itemId/price` | PATCH | staff | Set one store's price → **writes to Loyverse + records history**. Body `{ storeId, storeName, variantId?, price }` |
| `/api/item-prices/:itemId/history` | GET | staff | Price-change history for an item |

> **Price write is GET → mutate → POST `/items`** (full item posted back so other variants/stores/modifiers/taxes are preserved). Each change is logged to the `price_history` table (`priceHistoryRepository`, in-memory fallback). Cost is read-only here. Loyverse has no dedicated price endpoint — items are updated via `POST /items`.

### Item creation (Add Item page)
| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/categories` | GET | staff | Loyverse categories for the form dropdown |
| `/api/items` | POST | staff | Create a product in Loyverse (`itemsService.createItem`) → `201` |

> Create payload mirrors the Back Office "Create item" form: `item_name`, `category_id?`, `description?`, `sold_by_weight`, `track_stock`, `variants:[{ sku?, barcode?, cost, default_price, stores:[{ store_id, pricing_type, price, available_for_sale }] }]`, plus optional `color`/`form` (whitelisted enums). Per-store `pricing_type` is `FIXED` only when a price is set, else `VARIABLE`. After create, the catalog + pricing caches are invalidated so the item appears. Being a create (no `id`), it can't overwrite existing data.

### Transfers (flow 2 — direct, no approval in prod)
| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/transfer-requests` | POST | staff | Submit transfer → **executes in Loyverse immediately** |
| `/api/transfer-requests` | GET | staff | List (admin: all; operator: own) |
| `/api/transfer-requests/pending-stocks` | GET | admin | Live Loyverse stock for pending pairs |
| `/api/transfer-requests/:id/approve` | PATCH | admin | Approve (only if pending — see note above) |
| `/api/transfer-requests/:id/reject` | PATCH | admin | Reject |
| `/api/transfer-requests/:id/cancel` | PATCH | staff | Cancel (own, or any if admin) |

### Push notifications (web-push)
| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/push/key` | GET | admin | VAPID public key |
| `/api/push/subscribe` | POST | admin | Save subscription |
| `/api/push/subscribe` | DELETE | admin | Remove subscription |
| `/api/push/status` | POST | admin | Is this endpoint subscribed? |

### Audit & legacy
| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/audit` | GET | admin | Inventory change history |
| `/api/inventory` | GET | — | Legacy aggregated alerts (`?status=`) |
| `/api/inventory/summary` | GET | — | Legacy counts per status |

### Diagnostics (off by default)
| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/stocks/debug` | GET | admin | Diagnose 0-stock items. **Only registered when `ENABLE_DEBUG_ROUTES=true`.** Hits Loyverse heavily — keep off in prod. |

*"staff" = `requireRole('admin','operator')`.*

---

## Audit trail (Dashboard)

`GET /api/audit` (admin). Sources merged, newest first:
1. Runtime in-memory audit from approved requests (`src/data/runtimeAudit.ts`, max 500)
2. Loyverse receipts (last 3 days) + inventory snapshot enrichment
3. Fallback: inventory level updates
4. Mock data if token missing or Loyverse errors

```ts
AuditRecord = {
  id: string; itemName: string; adminName: string
  branchId?: string; oldStock: number; newStock: number
  changeAmount: number; timestamp: string // ISO
}
```

---

## Repository layout

```
src/
  index.ts                       # Fastify setup, CORS, route registration, DB init, catalog + stock warm-load, 30-min refresh
  plugins/
    auth.ts                      # authenticate() + requireRole() decorators
  routes/
    health.ts  loyverse.ts
    auth.ts  users.ts
    products.ts                  # /products, /stores, PATCH stock (202)
    itemStock.ts                 # /item-stock search (cache + 6h delta)
    stockRequests.ts             # approval queue: list/mine/approve/reject/cancel
    stocks.ts                    # /stocks (+stop/resume) — stock-levels sync engine
    transferRequests.ts          # transfers (direct mode + pending fallback)
    push.ts                      # web-push subscribe/key/status
    audit.ts  inventory.ts
    stocksDebug.ts               # diagnostic only — gated by ENABLE_DEBUG_ROUTES
  services/
    loyverseClient.ts            # ALL Loyverse HTTP (GET/POST, retry, timeout, pagination)
    authService.ts               # JWT sign/verify, bcrypt, refresh, user lookup
    productsService.ts           # catalog logic, stock reads, applyApprovedStockChanges
    productsCatalogCache.ts      # catalog stale-while-revalidate, disk cache
    stockLevelsService.ts        # in-memory stock snapshot, full/delta sync, pause/resume
    stockRequestService.ts       # stock-change submit/approve/reject/cancel
    transferRequestService.ts    # transfer submit (direct) / approve / reject / cancel
    auditService.ts              # merge audit sources
    inventoryService.ts          # legacy aggregation
    pushService.ts               # VAPID init, sendPushToAll, subscriptions
  repositories/
    userRepository.ts
    stockRequestRepository.ts
    transferRequestRepository.ts
    pushSubscriptionRepository.ts
  data/
    stockRequests.ts             # routes to MySQL repo or in-memory fallback
    runtimeAudit.ts              # in-memory FIFO audit (max 500)
    mockProducts.ts  mockAudit.ts  mockInventory.ts
  db/
    pool.ts                      # MySQL pool (lazy init)
    schema.sql  initSchema.ts    # DDL + startup init
    migrateStockRequests.ts
    migrations/                  # 001_add_user_email.sql, 002_add_cancelled_status.sql
  types/
    user.ts audit.ts products.ts loyverse.ts stockRequest.ts transferRequest.ts
docs/
  AUTH.md  HOSTINGER-MYSQL.md
.catalog_cache.json              # disk cache (auto-generated, do not commit)
```

---

## Environment

| Variable | Required | Notes |
|----------|----------|-------|
| `PORT` / `HOST` | No | Default `3001` / `0.0.0.0` |
| `CORS_ORIGIN` | No | Frontend origin(s), comma-separated; localhost 5173/5174 always allowed |
| `LOYVERSE_ACCESS_TOKEN` | Yes (prod) | Back Office → Integrations → Access tokens |
| `LOYVERSE_API_BASE_URL` | No | Default `https://api.loyverse.com/v1.0` |
| `LOYVERSE_FULL_MAX_PAGES` | No | Catalog load page cap (default `80`) |
| `LOYVERSE_STOCK_LOOKUP_MAX_PAGES` | No | Per-variant stock lookup page cap (default `50`) |
| `CATALOG_CACHE_TTL_MS` | No | Catalog cache TTL (default `300000` = 5 min) |
| `MYSQL_HOST/USER/PASSWORD/DATABASE` | Yes (prod) | Hostinger DB; omit → in-memory (dev only) |
| `MYSQL_PORT` | No | Default `3306` |
| `JWT_SECRET` | Yes (prod) | Min 16 chars |
| `JWT_EXPIRES_IN` | No | Default `7d` |
| `ADMIN_BOOTSTRAP_SECRET` | Yes (first setup) | Create first admin |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | No | Enable web-push; unset → push disabled |
| `ENABLE_DEBUG_ROUTES` | No | `true` exposes `/api/stocks/debug` (admin). Keep off in prod. |

---

## Commands

```bash
npm install
npm run dev        # http://localhost:3001
npm run typecheck
npm run build && npm start
```

---

## Do / Don't for agents

**Do:**
- Keep secrets in `.env` only
- Keep all Loyverse HTTP in `src/services/loyverseClient.ts`
- Return `202` for submitted stock changes (flow 1); transfers (flow 2) return `201`
- Patch the stock-levels cache (`updateCachedVariantStock`) after any Loyverse write so reads stay accurate
- Update this file when routes/services change

**Don't:**
- Expose `LOYVERSE_ACCESS_TOKEN` to the frontend
- Call Loyverse directly from a route file
- Re-enable transfer approval without also updating the frontend Transfer page + AdminApprovals "Transfers" tab
- Leave `ENABLE_DEBUG_ROUTES=true` in production

---

## Loyverse notes

- **Stores:** `GET /stores` — each = a branch column in UI. All non-deleted stores are returned (incl. `MOBILE STORE`); only `deleted_at` stores are filtered in `productsService.fetchStores`.
- **Stock read:** `GET /inventory` → `inventory_levels` (cursor pagination, `updated_since` for deltas)
- **Stock write:** `POST /inventory` with `inventory_levels` array (`stock_after` = absolute level)
- **Catalog:** `GET /items` (cursor-based)
- **Receipts/Employees:** `GET /receipts` (3-day audit window), `GET /employees` (audit author names)
