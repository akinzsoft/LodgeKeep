# AGENT.md

Master instruction file for Lodgekeep — a multi-tenant SaaS Hotel Property Management System, built as a cloud-native alternative to Oracle OPERA PMS. This file tells you what to read and when. It does not repeat what those files say.

## Reading order

1. **This file** — orientation and working conventions. Read first, every session.
2. **`PLAN.md`** — what phase the project is in, and what is and isn't in scope right now. **Read this before writing a line of product code.** `PRODUCT_REQUIREMENTS.md` describes everything the product will eventually do; almost none of it is meant to be built yet. Building from the full feature list instead of the current phase is the single most likely way to waste effort on this project.
3. **`PRODUCT_REQUIREMENTS.md`** — full product scope: 23 modules, what each does, and the UI screens each needs. Read the relevant module section before implementing it, once `PLAN.md` says its phase has arrived.
4. **`ARCHITECTURE.md`** — tech stack, repo layout, entity scoping (tenant vs property vs platform), transaction boundaries, concurrency/locking rules, the night audit sequence, and the payment state machine. Read before writing any code that touches money, availability, or the business date — which is most of this product.
5. **`DATABASE.md`** — the reference schema, module by module, plus unique constraints and record lifecycle rules. Read before any schema change.
6. **`API.md`** — the REST contract every endpoint follows: response envelope, error codes, resource conventions, pagination, webhooks. Read before creating or modifying any endpoint. This file is the wire format for the behaviour `ARCHITECTURE.md` defines — read both together for anything touching money or availability.
7. **`SECURITY.md`** — tenant isolation (the highest-severity concern in the system), authentication and identity design, the role/permission model, and the authorization matrix. Read before any auth, RBAC, or data-access change.
8. **`DESIGN_SYSTEM.md`** — design tokens and the six required UI states. Read before any frontend work.
9. **`TESTING.md`** — the complete testing reference: stack, coverage philosophy, the definition-of-done checklist, and all 134 enumerated test cases with IDs, in one file. Read before marking any work complete.

Each companion file is self-contained for its domain; cross-references between them use `File.md §N` so you can follow a thread without re-reading everything.

## What this product is, in one paragraph

A multi-tenant SaaS PMS sold as a subscription to independent hotels and small chains, initially in Nigeria and West Africa, architected to be region-neutral. There is no single reference customer — any hotel name that appears anywhere in these docs is illustrative only. Full detail: `PRODUCT_REQUIREMENTS.md` §1.

## The single most important rule

**Tenant isolation is enforced by architecture, not by developer discipline.** Every tenant-owned table is reached through a scoped data-access layer that injects the right scope automatically (`ARCHITECTURE.md` §3, `SECURITY.md` §2). A developer forgetting a `WHERE tenant_id = ?` on one query must not be able to leak data — that failure mode is exactly what the architecture exists to prevent. Cross-tenant isolation tests are the highest-priority tests in the project (`TESTING.md` §1 of Part 2) and the first thing built in Phase 0 (`PLAN.md`).

## Working conventions for agents

- **Check `PLAN.md`'s current phase before starting any task.** If a request seems to call for something outside the current phase, say so and ask, rather than quietly building ahead of schedule.
- **Never hardcode anything customer-specific.** Branding, tax rules, rate structures, currency, room types, templates, enabled features, and lock-vendor adapter choice are all configuration rows, never code branches. An `if (tenant === '...')` is a design failure (`PRODUCT_REQUIREMENTS.md` §1.1).
- **Every new tenant-owned table gets its scope classified** (`ARCHITECTURE.md` §3), **goes through the scoped accessor**, and **gets a cross-tenant isolation test before it ships** (`SECURITY.md` §2, `TESTING.md`).
- **Financial and state-changing operations run in a transaction** per `ARCHITECTURE.md` §4 — not as a style preference, as a correctness requirement.
- **Concurrency-sensitive operations use the locking mechanism specified in `ARCHITECTURE.md` §5**, not a read-then-write check that assumes nothing else is happening.
- **Every financial mutation carries an idempotency key** — not just payments, but refunds, voids, POS room-charge postings, and checkout too (`ARCHITECTURE.md` §7). Every webhook is verified, persisted, deduplicated, and audited.
- **Financial records are immutable.** A correction is a new offsetting transaction, never an edit to a historical row (`ARCHITECTURE.md` §8). `UPDATE`ing a posted charge's amount is a defect regardless of what else the change touches.
- **Side effects that leave the database — email, notifications, exports, webhooks — go through the outbox, never inline inside a financial transaction** (`ARCHITECTURE.md` §13).
- **Follow the contract in `API.md`** for every new endpoint — response envelope, error codes, pagination, filtering. Cross-tenant record access returns 404, never 403 (`API.md` §5, `SECURITY.md` §2).
- **Check entitlements before building UI for a gated feature** (`PRODUCT_REQUIREMENTS.md` §3.22) — gating retrofitted late tends to leak capability through unguarded endpoints.
- **Migrations run against every tenant at once.** Backwards-compatible, reversible; never drop a column in the same release that stops writing to it (`DATABASE.md`).
- **Before building any screen**, read `DESIGN_SYSTEM.md` and reuse the existing components rather than styling one-off elements. No hardcoded colour, spacing, radius, or font size in a component file — everything comes from tokens, or tenant theming silently breaks.
- **Build all six UI states** (loading, empty, success, error, confirm, offline) alongside the happy path, not afterwards (`DESIGN_SYSTEM.md` §2).
- **UI-level RBAC (a filtered sidebar, a role landing page) is a convenience layer only.** The API authorization check against the matrix in `SECURITY.md` §5 is the real one.
- **Tests are a definition of done, not a follow-up task.** A module without its required tests (`TESTING.md`) is unfinished, not shipped-and-pending. A failing test blocks a merge rather than being skipped. Any production bug gets a failing test reproducing it *before* the fix.
- **When a request is ambiguous about scope, phase, or which companion file governs it, say which file you checked and what it said**, rather than guessing silently — these documents exist so decisions are traceable, and that only works if they're actually consulted.
