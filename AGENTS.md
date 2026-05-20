# Loyverse API Backend — Agent Context

**Business:** Two Wheels Zone — motor parts & lubricants (Loyverse POS).

**Goal:** When stock is edited in Loyverse (add, remove, adjustment), the web app should show:
1. **Audit trail** — who changed what, old/new stock, when
2. **Inventory status** — in stock, low stock, out of stock (alerts/reporting)

**Related repo:** React frontend (`loyverse-api`) — separate folder; calls this API only.

---

## End-to-end flow (target)

```
[Loyverse POS / Back Office]
        │  stock changes (sales, adjustments, receiving, recount, etc.)
        ▼
[Loyverse API]  ← Access Token (LOYVERSE_ACCESS_TOKEN in .env)
        │
        ▼
[This backend — Fastify]  ← normalize data, hide secrets, optional cache
        │
        ▼
[React frontend]  Dashboard = audit | Reports = inventory tabs
```

**Rule:** The frontend never holds the Loyverse token. All Loyverse HTTP calls happen in `src/services/` (to be added).

---

## Features map

### 1. Audit trail (Dashboard)

**User story:** An admin decreases or increases stock in Loyverse → the change appears in the audit table.

| Field | Source (planned) |
|-------|------------------|
| Item name | Loyverse items / inventory events |
| Admin / employee | Loyverse employee on adjustment or receipt |
| Old stock → New stock | Inventory history / adjustment line |
| Change (+/−) | Computed |
| Timestamp | Event `created_at` |

**Frontend:** `GET /api/audit` with filters (search, item, date range), pagination 15/page.

**Backend today:** `GET /api/audit` returns `src/data/mockAudit.ts` — replace with Loyverse client.

### 2. Inventory alerts (Reports)

**User story:** Quickly see what is out of stock, low stock, or healthy.

**Stock rules (must match frontend):**

| Status | Condition |
|--------|-----------|
| Out of stock | `stock === 0` |
| Low stock | `stock >= 1 && stock < 4` |
| In stock | `stock >= 4` |

Use **latest quantity per item** across stores (define in the service layer; default: sum or primary store — document the choice when implementing).

**Frontend:** Tabs + search + table, pagination 15/page.

**Backend today:** Not implemented — add `GET /api/inventory` (or `/api/inventory?status=out-of-stock`).

### 3. Future (optional)

- Webhooks from Loyverse for near-real-time updates (if available on plan)
- Low-stock push/email (backend job)
- Settings: thresholds per category

---

## API routes

| Route | Status | Purpose |
|-------|--------|---------|
| `GET /health` | Live | Health check |
| `GET /api/loyverse/status` | Live | Test Loyverse token |
| `GET /api/audit` | Live | Audit from receipts/inventory; falls back to mock |
| `GET /api/inventory` | Live | Items with stock status; `?status=` filter |
| `GET /api/inventory/summary` | Live | Counts for tab badges |

Keep response shapes stable so the frontend does not break when switching mock → Loyverse.

**Audit record type** (align with frontend `AuditRecord`):

```ts
{
  id: string
  itemName: string
  adminName: string
  oldStock: number
  newStock: number
  changeAmount: number
  timestamp: string // ISO
}
```

---

## Repository layout

```
src/
  index.ts              # Fastify app, CORS, route registration
  routes/
    health.ts
    audit.ts            # /api/audit
    inventory.ts        # (planned) /api/inventory
  data/
    mockAudit.ts        # Remove when Loyverse is wired
  services/
    loyverseClient.ts   # (planned) fetch + auth header
    auditService.ts     # (planned) map Loyverse → AuditRecord
    inventoryService.ts # (planned) map items → status buckets
```

---

## Environment

Copy `.env.example` → `.env` (never commit `.env`).

| Variable | Required | Notes |
|----------|----------|-------|
| `PORT` | No | Default `3001` |
| `CORS_ORIGIN` | No | Frontend URL, e.g. `http://localhost:5173` |
| `LOYVERSE_ACCESS_TOKEN` | Yes (prod) | Back Office → Integrations → Access tokens |
| `LOYVERSE_API_BASE_URL` | No | Default `https://api.loyverse.com/v1.0` |

Loyverse auth header: `Authorization: Bearer <LOYVERSE_ACCESS_TOKEN>`.

---

## Implementation phases

1. **Done:** Fastify + TS + CORS + health + `loyverseClient` + audit + inventory routes
2. **Next:** Connect React frontend (`VITE_API_BASE_URL`)
3. **Improve audit:** Stock adjustments / inventory history when Advanced Inventory API is available
4. **Harden:** Caching, better old/new stock on audit rows, rate-limit handling

---

## Loyverse setup (human steps)

- **Access token:** Back Office → **Integrations** → **Access tokens** (not Developer OAuth unless building a multi-merchant app)
- **Developer Create app:** Only for OAuth; redirect URL must be `https://` (use ngrok for local dev)
- **Advanced Inventory** may be required for adjustments/history — confirm on your Loyverse plan

---

## Commands

```bash
npm install
npm run dev      # http://localhost:3001
npm run build
npm start
```

---

## Do / Don't for agents

**Do:**
- Keep secrets in `.env` only
- Match stock rules and `AuditRecord` shape to the frontend
- Add new routes under `src/routes/` + logic in `src/services/`
- Prefer small PR-sized changes: client → audit → inventory

**Don't:**
- Put `LOYVERSE_ACCESS_TOKEN` in the frontend or commit `.env`
- Change CORS to `*` in production without consideration
- Break the existing `/api/audit` response contract without updating the frontend
- Keep business rules only in the frontend — backend is the source of truth for inventory status

---

## GitHub

Repo: `loyverse-api-backend` — push source + `.env.example` + this file; never push `.env` or `node_modules/`.

When this file changes, update `.cursor/rules/loyverse-backend.mdc` if the summary there is outdated.
