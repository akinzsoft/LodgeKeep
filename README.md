# LodgeKeep

[![CI](https://github.com/akinzsoft/LodgeKeep/actions/workflows/ci.yml/badge.svg)](https://github.com/akinzsoft/LodgeKeep/actions)

A multi-tenant SaaS Hotel Property Management System — a lighter, faster, cloud-native alternative to Oracle OPERA PMS, sold as a subscription to independent hotels and small chains. There's no single reference customer: any hotel name in these docs is illustrative only, and the architecture is region-neutral by design. ([`PRODUCT_REQUIREMENTS.md`](./PRODUCT_REQUIREMENTS.md) §1)

## Status

| Phase | What it covers | Status |
|---|---|---|
| 0 — Foundations | Multi-tenant auth, RBAC, audit trail, app shell | ✅ Complete |
| 1 — Property setup | Room types, rooms, rate codes & calendar, taxes | ✅ Built |
| 2 — Core operational loop | Reservations, Front Desk, overbooking, availability | ✅ Built |
| 2.5 — Cashiering, Payments, Night Audit | Real folio ledger, cash/Paystack payments, night audit | ✅ Built |
| 3 — Daily-use hardening | Housekeeping, Notifications, Reporting | ✅ Built |
| 4+ | Guest Profiles, Accounts Receivable, POS, guest portal | Not started |

A user can today: log in, configure a property, search availability, book/modify/cancel a reservation, run a waitlist, check guests in and out (with room moves and early/late fees), assign housekeeping and track discrepancies, pull live and audited occupancy/revenue reports, post real folio charges and taxes, take a cash or Paystack payment, void or split a folio line, and run night audit to close a business date. Guest Profiles is still a minimal stub, and Accounts Receivable, POS, and the guest booking portal don't exist yet.

Status is derived from [`PLAN.md`](./PLAN.md)'s phase sequencing; the honest, as-built detail for every pass — what shipped, what was deliberately stubbed, and every bug found along the way — lives in [`CLAUDE.md`](./CLAUDE.md).

## Tech stack

([`ARCHITECTURE.md`](./ARCHITECTURE.md) §1)

- **Backend** — Node.js + Express, MySQL via Knex (query builder, not an ORM), Redis + BullMQ for background jobs, JWT/session auth with per-property RBAC.
- **Frontend** — React, responsive and mobile/tablet-first for front-desk and housekeeping screens.
- **Payments** — pluggable gateway layer, wired to Cashiering for cash and Paystack (sandbox integration, no live credentials in this environment); Flutterwave not yet wired.
- **Infra** — Docker Compose locally (MySQL, Redis, Adminer, phpMyAdmin); one modular monolith, not microservices, deliberately.

## Getting started

Requires Docker, Node.js 20+ (backend) / 22.22+ (frontend), and npm.

```bash
# 1. Start infra — from the repo root
docker compose up -d --wait

# 2. Backend
cd backend
cp .env.example .env        # edit to match your local ports if needed
npm install
npm run migrate                      # dev schema
npx knex migrate:latest --env test   # test schema
npm run seed                # two dev tenants, one property + staff user each
npm run dev

# 3. Frontend, in a separate shell
cd frontend
cp .env.example .env
npm install
npm run dev
```

Host ports are non-default (MySQL `3310`, Redis `6379`, Adminer `8084`, phpMyAdmin `8085`) — `backend/.env` must match `docker-compose.yml`. If the databases are missing, `docker compose down -v` and bring the stack back up (init scripts only run against a fresh volume).

Seeded logins (dev only): `manager@alpha-hotels.example.com` / `manager@beta-resorts.example.com`, password `LodgeKeepDev123!`, at `http://alpha-hotels.localhost:5173` / `http://beta-resorts.localhost:5173` (tenant is resolved from the subdomain).

## Running tests

```bash
cd backend && npm test    # jest --runInBand, against a real MySQL schema — no mocks
cd frontend && npm test   # vitest run
```

Tenant isolation is this project's core guarantee, so it has its own dedicated suite: `cd backend && npm run test:isolation` runs the cross-tenant `ISO-*` tests — every tenant-owned table is checked table-by-table for a query path that could leak another tenant's rows. It's table-driven off `tests/helpers/entities.js`, so a new table is covered automatically the moment it's registered there.

## Documentation

[`AGENT.md`](./AGENT.md) is the entry point and reading order for everything below:

| File | Covers |
|---|---|
| [`PLAN.md`](./PLAN.md) | What phase the project is in, and what's deliberately out of scope right now |
| [`PRODUCT_REQUIREMENTS.md`](./PRODUCT_REQUIREMENTS.md) | Full product scope — 23 modules, what each does, and its UI screens |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Tech stack, tenant/property scoping, transactions, concurrency, night audit, payment state |
| [`DATABASE.md`](./DATABASE.md) | Reference schema, module by module, plus constraints and record lifecycles |
| [`API.md`](./API.md) | The REST contract — envelope, error codes, resource conventions, pagination |
| [`SECURITY.md`](./SECURITY.md) | Tenant isolation, authentication, the role/permission matrix |
| [`DESIGN_SYSTEM.md`](./DESIGN_SYSTEM.md) | Design tokens and the six required UI states |
| [`TESTING.md`](./TESTING.md) | Testing philosophy, definition of done, all enumerated test cases |

## License

No license file is currently checked into this repository — that's an open question, not a default. Until one is added, treat this code as all-rights-reserved.
