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

### API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/api/loyverse/status` | Test Loyverse token |
| GET | `/api/audit` | Audit trail (`source`: `loyverse` or `mock`) |
| GET | `/api/inventory` | All items with stock status |
| GET | `/api/inventory?status=low-stock` | Filter: `out-of-stock`, `low-stock`, `in-stock` |
| GET | `/api/inventory/summary` | Counts per status |

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Dev server with hot reload (`tsx watch`) |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run production build |
| `npm run typecheck` | TypeScript check only |

## Environment

See `.env.example`. Put **Loyverse secrets** in `.env` only — never in the frontend `VITE_*` vars.

## Next steps

1. Connect frontend: `VITE_API_BASE_URL=http://localhost:3001` in frontend `.env`
2. Replace `src/data/mockAudit.ts` with Loyverse API client in `src/services/`
3. Add `/api/inventory` for Reports page

## Frontend repo

Keep the React app in a **separate folder/repo** (e.g. `loyverse-api`). This repo is API only.
