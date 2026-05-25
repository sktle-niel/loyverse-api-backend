# Loyverse API Backend — Agent Context

**Business:** Two Wheels Zone — motor parts & lubricants (Loyverse POS).

**Goal:** Backend proxy to Loyverse — fetch products with **per-store stock**, allow **stock edits**, and expose an **audit trail** for the React frontend.

**Related repo:** React frontend (`loyverse-api`) — calls this API only; never holds `LOYVERSE_ACCESS_TOKEN`.

---

## End-to-end flow (current target)

```
[Loyverse POS / Back Office]
        │  items, stores, inventory_levels
        ▼
[Loyverse API v1.0]  ← Bearer token (LOYVERSE_ACCESS_TOKEN)
        │
        ▼
[This backend — Fastify]
   GET  /api/products        → items + stock per store
   PATCH /api/products/:id/stock → POST /inventory to Loyverse
   GET  /api/audit            → receipts + inventory history + API edits
        │
        ▼
[React frontend]
   Inventory page → GET/PATCH products
   Dashboard      → GET audit
```

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
- `PATCH /api/products/:itemId/stock` — body: `{ updates: [{ storeId, stock }], adminName? }`

Stock update calls Loyverse `POST /inventory` with `{ inventory_levels: [{ variant_id, store_id, in_stock }] }`.

Creates `AuditRecord` rows (with `branchId` = store id) and merges them into `GET /api/audit`.

### 2. Audit trail (Dashboard)

**Routes:** `GET /api/audit`

Sources (merged, newest first):

1. Runtime audit from `PATCH .../stock` (`src/data/runtimeAudit.ts`)
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
| `/api/products/:itemId/stock` | PATCH | Update stock per store |
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
    products.ts       # /api/products, /api/stores
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
    runtimeAudit.ts   # in-memory edits for audit merge
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

---

## Frontend integration

In frontend `.env`:

```
VITE_API_BASE_URL=http://localhost:3001
```

**Inventory page:**

1. `GET /api/products` → render table (map `stores` to column headers)
2. On save → `PATCH /api/products/:itemId/stock` with changed `{ storeId, stock }`
3. Optional: refresh audit via `GET /api/audit`

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
