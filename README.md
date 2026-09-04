# LodgeKeep

LodgeKeep is a multi-tenant SaaS hotel Property Management System (PMS). It covers the full operational lifecycle of running a property — reservations, front desk, cashiering, guest profiles, night audit, housekeeping, rates and inventory, reporting, and a guest-facing booking portal — built for one or many independently-configured hotel tenants on shared infrastructure.

The full eventual scope is described in [`PRODUCT_REQUIREMENTS.md`](./PRODUCT_REQUIREMENTS.md) (23 modules). The current build is intentionally a subset of that — see **Status** below and [`PLAN.md`](./PLAN.md) for the phased build order.

## Status

**Phase 2 (Reservations & Front Desk) in progress.** Phase 0 (foundations: multi-tenant auth, RBAC, audit trail, app shell) and Phase 1 (property setup: room types, rooms, rate codes, taxes) are complete. Reservations and Front Desk are built; Cashiering, Guest Profiles, Night Audit, and payment integration are not yet built. See [`CLAUDE.md`](./CLAUDE.md) for the detailed, honest status of each pass, including what was deliberately deferred and why.

A user can today: log in, configure a property (room types, physical rooms, rate codes/calendar, effective-dated taxes), search availability, book/modify/cancel a reservation, manage a waitlist, and check a guest in and out through the front desk (with room assignment, room moves, and an early/late checkout fee posted to a stub folio).

## Tech stack

- **Backend** — Node.js + Express 5, MySQL 8 via Knex (query builder, not an ORM), Redis 7 + BullMQ for background jobs (installed, not yet wired up beyond infra), Jest + Supertest against a real MySQL test schema.
- **Frontend** — React 19 + Vite, no router yet (single status-driven shell), Vitest + React Testing Library, Stylelint-enforced design tokens.
- **Infra** — Docker Compose (MySQL, Redis, Adminer, phpMyAdmin), migrations checked into the repo.

## Architecture at a glance

- **Tenant isolation is architectural, not disciplinary.** Every table declares a scope (platform/tenant/property/global-reference) and is reachable only through a scoped data-access layer that injects the right `WHERE` clause — there is no unscoped query path. Cross-tenant access returns 404, never 403.
- **Roles are per-property, not global** — the same user can be a manager at one property and front desk at another.
- **Money is exact** — `DECIMAL` end to end, never floating point, every value carries its currency.
- **Financial records are immutable** — corrections are offsetting entries, never edits; void, never delete.
- **Every financial mutation is idempotent** via a required `Idempotency-Key` header, backed by `src/shared/idempotency.js`.
- **Business date ≠ wall clock** — each property runs on its own accounting date, advanced only by night audit.
- **Concurrency uses real database locks** — e.g. the last-room-availability race is closed with `SELECT ... FOR UPDATE` inside a transaction, proven with a genuine two-connection concurrency test, not `Promise.all` against a shared transaction.

The full set of invariants (and the reasoning behind each) lives in [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`SECURITY.md`](./SECURITY.md).

## Documentation map

Read in this order before making changes — [`AGENT.md`](./AGENT.md) is the canonical router:

| File | Read before |
|---|---|
| [`PLAN.md`](./PLAN.md) | writing any product code — current phase and what's deliberately out of scope |
| [`PRODUCT_REQUIREMENTS.md`](./PRODUCT_REQUIREMENTS.md) | implementing a module |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | anything touching money, availability, or the business date |
| [`DATABASE.md`](./DATABASE.md) | any schema change |
| [`API.md`](./API.md) | creating or modifying any endpoint |
| [`SECURITY.md`](./SECURITY.md) | any auth, RBAC, or data-access change |
| [`DESIGN_SYSTEM.md`](./DESIGN_SYSTEM.md) | any frontend work |
| [`TESTING.md`](./TESTING.md) | marking any work complete |

[`CLAUDE.md`](./CLAUDE.md) tracks the real, as-built status of each phase — what shipped, what was stubbed, and every bug found along the way.

## Getting started

Requires Docker, Node.js 20+ (backend) / 22.22+ (frontend), and npm.

```bash
# 1. Start infra (MySQL, Redis, Adminer, phpMyAdmin) — from the repo root
docker compose up -d --wait

# 2. Backend
cd backend
cp .env.example .env        # then edit to match your local ports if needed
npm install
npm run migrate             # dev schema
npx knex migrate:latest --env test   # test schema
npm run seed                # seeds two dev tenants with a property and staff user each
npm run dev                 # starts the API

# 3. Frontend, in a separate shell
cd frontend
cp .env.example .env
npm install
npm run dev
```

Host ports are non-default in this repo's `docker-compose.yml` (MySQL `3310`, Redis `6379`, Adminer `8084`, phpMyAdmin `8085`) — `backend/.env` must match. `docker/mysql/init/` creates the `lodgekeep_dev` and `lodgekeep_test` databases, but only against a fresh volume; if they're missing, `docker compose down -v` and bring the stack back up.

Seeded logins (dev only): `manager@alpha-hotels.example.com` / `manager@beta-resorts.example.com`, password `LodgeKeepDev123!`, reached through `http://alpha-hotels.localhost:5173` / `http://beta-resorts.localhost:5173` (tenant is resolved from the subdomain).

## Commands

```bash
# Backend (from /backend)
npm test                    # jest --runInBand — real MySQL test schema, no mocks
npm run migrate:rollback    # migration reversibility is a release gate
npm run lint

# Frontend (from /frontend)
npm test                    # vitest run
npm run build
npm run lint                # eslint + stylelint (design-token enforcement)
```

## Project layout

```
backend/
  src/modules/<module>/     # routes, controller, service, model — self-contained per module
  src/modules/tenancy/      # the scoped data-access layer — the only DB query path
  src/auth/                 # staff/guest/platform auth, RBAC, sessions
  src/audit/                # audit trail write path
  migrations/, seeds/
  tests/                    # jest + supertest, incl. cross-tenant isolation and concurrency suites
frontend/
  src/app/                  # screens, mirrors backend module names
  src/shared/api/           # the one place that calls fetch
  src/shared/components/    # design-token-driven shared UI kit
  src/styles/tokens.css     # the only source of design tokens
```

Cross-module calls always go through service functions, never direct model access, on the backend; the guest booking portal ships from the same frontend app under a separate `/portal` route tree so admin styling can't leak into guest-facing pages.
