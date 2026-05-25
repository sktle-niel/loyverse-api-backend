# Loyverse API Backend — Agent Context

**Business:** Two Wheels Zone — motor parts & lubricants (Loyverse POS).

**Goal:** Backend proxy to Loyverse — fetch products with **per-store stock**, allow **stock edits**, and expose an **audit trail** for the React frontend.

**Related repo:** React frontend (`loyverse-api`) — calls this API only; never holds `LOYVERSE_ACCESS_TOKEN`.

---

## End-to-end flow (current target)

```
[Staff app — inventory UI]
   GET  /api/products              → read live stock from Loyverse
   PATCH /api/products/:id/stock   → submit change (pending only)
        │
        ▼
[This backend — approval queue]
   GET  /api/stock-requests?status=pending
   POST /api/stock-requests/:id/approve  → then POST /inventory to Loyverse
   POST /api/stock-requests/:id/reject   → no Loyverse write
        │
        ▼
[Admin website] (separate UI, same API)
        │
        ▼
[Loyverse] — updated only on approve
```

**Important:** `PATCH .../stock` does **not** write to Loyverse. It creates a `pending` request. Loyverse is updated only when an admin calls **approve**.

**Rule:** All Loyverse HTTP calls live in `src/services/` (`loyverseClient`, `productsService`, `auditService`, `inventoryService`).

---

## Features map

### 1. Products & stock per store (Inventory page)

**User story:** List all products; show stock for **each Loyverse store** (branch); edit and save.

| Field | Source |
|-------|--------|
| `id` | Loyverse `item.id` |
| `variantId` | Primary variant (default or first) — used for stock API |
| `name` | `item_name` |
| `sku` | variant `sku` |
| `stocks[].storeId` | Loyverse `store.id` |
| `stocks[].stock` | `inventory_levels.in_stock` for variant + store |

**Routes:**

- `GET /api/products?q=` — products + `stores[]` + `source`
- `GET /api/stores` — store list only
- `PATCH /api/products/:itemId/stock` — body: `{ updates: [{ storeId, stock }], requestedBy? }`

**Submit (staff):** `PATCH /api/products/:itemId/stock` → status `202`, body includes `request` with `status: "pending"`. Loyverse unchanged.

**Approve (admin):** `POST /api/stock-requests/:requestId/approve` → Loyverse `POST /inventory`, audit rows, `status: "approved"`.

**Reject (admin):** `POST /api/stock-requests/:requestId/reject` → optional `rejectionReason`, Loyverse unchanged.

Pending queue: **MySQL** when `MYSQL_*` is set (Hostinger phpMyAdmin). Table `stock_requests` — see `src/db/schema.sql` and `docs/HOSTINGER-MYSQL.md`. Without MySQL env, falls back to in-memory (dev only).

### 2. Audit trail (Dashboard)

**Routes:** `GET /api/audit`

Sources (merged, newest first):

1. Runtime audit from **approved** requests (`src/data/runtimeAudit.ts`)
2. Loyverse receipts (last 3 days) + inventory snapshot enrichment
3. Fallback: inventory level updates
4. Mock data if token missing or Loyverse errors

**Audit record shape** (align with frontend):

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

### 3. Legacy inventory alerts (optional / Reports)

**Routes:** `GET /api/inventory`, `GET /api/inventory/summary`

Aggregates stock **across all stores** per item name (tabs: out / low / in stock). Rules: `0` = out, `1–3` = low, `4+` = in stock.

---

## API routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/health` | GET | Health check |
| `/api/loyverse/status` | GET | Test token |
| `/api/products` | GET | Products + per-store stock |
| `/api/stores` | GET | Loyverse stores |
| `/api/products/:itemId/stock` | PATCH | Submit stock change (pending) |
| `/api/stock-requests` | GET | Approval queue (`?status=pending`) |
| `/api/stock-requests/:id/approve` | POST | Approve → Loyverse + audit |
| `/api/stock-requests/:id/reject` | POST | Reject |
| `/api/audit` | GET | Audit trail |
| `/api/inventory` | GET | Legacy status buckets (`?status=`) |
| `/api/inventory/summary` | GET | Legacy tab counts |

Without `LOYVERSE_ACCESS_TOKEN`, products/audit use **mock data** (`src/data/mockProducts.ts`, `mockAudit.ts`).

---

## Repository layout

```
src/
  index.ts
  routes/
    health.ts
    products.ts       # /api/products, submit stock change
    stockRequests.ts  # admin approve / reject
    audit.ts
    inventory.ts      # legacy alerts
    loyverse.ts
  services/
    loyverseClient.ts # GET + POST to Loyverse
    productsService.ts
    auditService.ts
    inventoryService.ts
  data/
    mockProducts.ts
    mockAudit.ts
    runtimeAudit.ts   # audit after approved edits
    stockRequests.ts  # pending / approved / rejected queue
  types/
    audit.ts
    products.ts
    loyverse.ts
```

---

## Environment

| Variable | Required | Notes |
|----------|----------|-------|
| `PORT` | No | Default `3001` |
| `CORS_ORIGIN` | No | Frontend origin(s), comma-separated |
| `LOYVERSE_ACCESS_TOKEN` | Yes (prod) | Back Office → Integrations → Access tokens |
| `LOYVERSE_API_BASE_URL` | No | Default `https://api.loyverse.com/v1.0` |
| `MYSQL_HOST` | Yes (prod) | Hostinger DB host |
| `MYSQL_USER` | Yes (prod) | Database user |
| `MYSQL_PASSWORD` | Yes (prod) | Database password |
| `MYSQL_DATABASE` | Yes (prod) | Database name |
| `MYSQL_PORT` | No | Default `3306` |

---

## Frontend integration

In frontend `.env`:

```
VITE_API_BASE_URL=http://localhost:3001
```

**Inventory page:**

1. `GET /api/products` → render table (map `stores` to column headers)
2. On save → `PATCH /api/products/:itemId/stock` (shows “pending approval”, stock in Loyverse unchanged)
3. Admin site → approve/reject via `/api/stock-requests/...`
4. After approve → `GET /api/audit` shows the change

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
- Document store-level stock (not summed) for the Inventory page

**Don't:**

- Expose `LOYVERSE_ACCESS_TOKEN` to the frontend
- Break `PATCH /api/products/:itemId/stock` without updating the frontend
- Assume one variant per item without checking `variants[]`

---

## Loyverse setup

- **Access token:** Back Office → Integrations → Access tokens
- **Stores:** `/stores` — each store = branch column in UI
- **Stock read:** `GET /inventory` → `inventory_levels`
- **Stock write:** `POST /inventory` with `inventory_levels` array
- **Advanced Inventory** may affect adjustment history on your plan
