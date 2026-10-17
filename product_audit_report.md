# LodgeKeep Product and Security Audit

Date: 2026-10-16. Branch `invitation-resend-revoke` (HEAD 8fa8ceb). Read-only audit; nothing was changed or committed.
Method: five parallel code reviews (auth/RBAC, input/output, money, infrastructure, feature inventory). Items marked **[verified]** I re-read in the code myself; the rest are reviewer findings backed by file:line but not re-checked. No tests, servers or dumps were run. No secret values are included.

## 0. Status of the earlier security_audit_report.md

| Earlier finding | Now |
|---|---|
| 1. HTTP payment callbacks | Fixed (https-only in production). |
| 2. Backups unauthenticated (CBC) | Fixed (AES-256-GCM v2). |
| 3. Door-access import memory DoS | **Still open** [verified: no `sheetRows` cap, no concurrency limit, `memoryStorage`]. See F-12. |
| 4. Dev compose defaults | Still true but low: ports are bound to 127.0.0.1 [verified]; mutable tags and `change-me` creds remain. See F-24. |

Also verified as fixed or sound: MFA toggle, tab ownership, server-side service charge, SMTP SSRF guard (private hosts are refused; the dev bypass is hard-off in production [verified]), approval PIN tokens, webhook HMAC (timing-safe, raw body), money arithmetic (BigInt cents), CSV formula injection (shared `csvCell`), no `dangerouslySetInnerHTML`, no SQL string concatenation, and `npm audit --omit=dev` shows 0 vulnerabilities in backend and frontend.

## 1. Executive summary

### Top 10 issues (ranked)

1. **F-01 (High) An `admin` can make themselves `super_admin`, or deactivate a `super_admin`.** `PATCH /users/:id/role` and `/deactivate` have no rank, self or last-owner check [verified]. Gives access to the MFA toggle, tax rates and every super_admin-only control.
2. **F-02 (High) A negative POS tip acts as a discount or cash skim.** `tip_amount` is client-supplied and unvalidated [verified]. The sale total and the cash-up both shrink, and no manager approval is involved.
3. **F-03 (High) Front desk can post negative or arbitrary charges with a back-dated `business_date`.** `postCharge` checks only that `amount` is present [verified]. This bypasses the `void_line` gate and can post into audited days.
4. **F-04 (High) Refund over-refund race.** `refundPayment` reads the refunded total outside a transaction and takes no row lock, so two parallel refunds can each pass. Cash can be paid out twice.
5. **F-05 (High) Folio balance lost update.** `recomputeFolioBalance` uses a plain snapshot read and the folio row is never locked, so a concurrent charge and payment can leave `folios.balance` wrong. A wrong zero lets checkout through.
6. **F-06 (Medium) No graceful shutdown** [verified: no SIGTERM handler]. Every deploy cuts in-flight payments and jobs.
7. **F-07 (Medium) MFA and reset codes sit in plaintext in `outbox_events` (and the emailed backup), never pruned.**
8. **F-08 (Medium) Refresh tokens: no reuse detection and a racy rotate.** A stolen, rotated token does not kill the session family.
9. **F-09 (Medium) No timeouts on most outbound Paystack calls, and no monitoring or alerting.** A hung gateway pins workers, and failures are silent.
10. **F-10 (Medium) Unauthenticated webhook endpoints store unsigned bodies without limit or rate limit.** Storage and DB write load can be inflated by anyone.

### Top 10 missing features (ranked)

1. POS offline mode (power and network cuts are routine in Nigeria).
2. Thermal and kitchen printing (ESC/POS, kitchen tickets).
3. Discounts, comps, vouchers and promotions with approval and reporting.
4. Suppliers, purchase orders, goods-received matching and supplier credit.
5. WhatsApp and SMS guest communication.
6. Guest ID capture and guest register (legal requirement in Nigeria).
7. Rate restrictions (min stay, closed dates) and packages (B&B).
8. Channel manager or at least iCal sync.
9. Tax: VAT return report, FIRS e-invoicing readiness, UK MTD VAT.
10. Accounting export (QuickBooks, Xero, Sage) plus an audit-log screen.

## 2. Findings

Severity is my judgement. "V" = re-verified by me; "R" = reviewer finding with file:line, not re-read. Effort S under a day, M a few days, L weeks.

| ID | Sev | Area | Evidence | How it fails or is exploited | Fix | Effort |
|---|---|---|---|---|---|---|
| F-01 V | High | RBAC | `modules/users/service.js:304` `changeUserRole`, `:277` `deactivateUser`, `setUserOutlets`; route gate `setup.manage` only (`routes.js:31`) | Admin sends `PATCH /users/<self>/role {"role":"super_admin"}`; or deactivates the owner. Invite/resend/revoke already use `roleOutranksOrEquals`; these three do not. | Require actor outranks target's current role and the new role; refuse self-change, self-deactivate and removing the last active super_admin. | S |
| F-02 V | High | Money / POS | `pos/service.js:1405` `tipAmount = settlement.tipAmount ?? '0.00'`; `pos/controller.js:799`; flows into total at `:1546`, room-charge at `:1472`, shift cash | Operator sends `tip_amount:"-3000"` on a 10,000 cash sale. Customer pays 7,000, cash-up balances, revenue looks like an unapproved discount. `"abc"` gives a 500. | Validate tip: `^\d+(\.\d{1,2})?$`, cap, non-negative. | S |
| F-03 V | High | Money / cashiering | `cashiering/controller.js:139-170`, `service.js:296` `postCharge`: amount only checked present; `business_date` from body | `front_desk` (holds `post_charge`) posts `-5000` room_charge as a hidden discount; or posts into an already-audited date so the snapshot and live report diverge. Also affects the cash payment path `business_date`. | Positive-only amount plus decimals and max cap on this route; ignore client `business_date` unless a manager permission, else clamp to current business date. | S |
| F-04 R | High | Money / concurrency | `cashiering/service.js:1435-1470` `refundPayment` (reads outside a transaction, no `FOR UPDATE`; Paystack counts only CAPTURED refunds, not PENDING) | Two refund requests with different idempotency keys (double click after refresh, two cashiers) both see `alreadyRefunded=0`; total refunded is 2x. Folio goes +2x; drawer may pay twice. | Lock the payment row in one transaction, recompute under lock counting CAPTURED and PENDING; insert a PENDING intent before calling the gateway (as `issueRefund` does). | M |
| F-05 R | High | Money / concurrency | `cashiering/service.js:99-104` `recomputeFolioBalance`; folio never `forUpdate` (`~296`, `~553`, checkout) | Concurrent charge and payment, or two payments, overwrite each other's balance. Drift can show zero owing while a charge is unpaid, which allows checkout. AR path already locks; folios do not. | `SELECT ... FOR UPDATE` on the folio at the start of every folio mutation and checkout; locking sum. | M |
| F-06 V | Medium | Availability | `backend/src/server.js` (no SIGTERM; no `server.close`, worker close, `knex.destroy`) | `docker compose up -d --build` kills the process mid-request and mid-job. | SIGTERM handler closing HTTP, BullMQ workers, pool; `stop_grace_period`. | S |
| F-07 R | Medium | Secrets / data | `auth/service.js:274-280`, `:917-923` put `payload.code` in `outbox_events`; no prune job found | Clear-text MFA and reset codes persist forever and are in DB backups and the emailed dump. `notification_log` may hold rendered bodies too (unverified). | Redact `payload.code` after dispatch; add outbox/notification_log retention sweep. | S-M |
| F-08 R | Medium | Auth | `auth/service.js:485-560` (revoke at `:518-522` unguarded) | Two concurrent refreshes with one cookie both succeed; a stolen already-rotated token just errors, the family is not revoked. | Conditional UPDATE requiring 1 affected row; on reuse revoke all user sessions and log an auth event. | S-M |
| F-09 R | Medium | Availability | `paystack-adapter.js:138-144` only Verify has a timeout; Initialize, refund, bank-resolve, billing `chargeAuthorization` have none. No error reporter, no alerting in `server.js`/`app.js`; `/healthz` checks MySQL only | Hung gateway pins request handlers and workers; outbox, sweep or night-audit failures noticed only by users; Redis outage leaves backend "healthy". | Default `AbortSignal.timeout` on all fetches; uptime check; failed-job alerting; Redis in `/healthz`. | S-M |
| F-10 R | Medium | Public endpoints | `cashiering/routes.js:61`, `billing/routes.js:38`; `cashiering/service.js:1181-1210` | Unsigned requests are persisted (random ULID key when no event id, so no dedup) with an unscoped payments lookup each; storage and DB load can be inflated. | Per-IP Redis limiter and body cap; do not persist unsigned events (or prune). | S |
| F-11 R | Medium | Money / stock | `stock/controller.js:208-216`, `service.js:986-996` `recordWastage`; goods received `controller.js:495` | `negateQuantity('-5')` becomes +5, so "wastage" adds stock (floor role `pos.stock_view`). Goods received accepts negative or zero `unit_cost`, overwriting the item's last cost. | Reuse `requirePositiveQuantity` and a cost regex. | S |
| F-12 V | Medium | Availability | `access-monitoring/routes.js:18,27-29`, `spreadsheet.js:83` (`XLSX.read` of whole workbook before the 50k row check; `memoryStorage`, 20 MiB, no concurrency limit) | A `door_access.manage` holder uploads crafted .xlsx in parallel; event loop blocked, possible OOM of the single process serving every tenant. | `sheetRows` option, disk storage, per-tenant concurrency cap, optional worker thread. | S-M |
| F-13 R | Medium | Platform | `offboarding/routes.js:35`, `downloadExport`; `assertPermission` returns early for impersonation | Impersonating platform admin can download the full tenant export (all guest PII); GET also writes `downloaded_at`. | Refuse impersonation contexts on offboarding routes; allowlist impersonation reads. | S |
| F-14 R | Medium | Auth | `auth/service.js:432`, `:1027` `attempts: pending.attempts + 1` stale read-modify-write | Concurrent guesses all see attempts=0; only the Redis limiter (keyed on the token string, which can be rotated) caps guesses. Not a practical break; the cap is broken. | Atomic `attempts = attempts + 1 WHERE attempts < 5` or `FOR UPDATE`. | S |
| F-15 R | Medium | DB privileges | compose passes one app user with ALL on the schema; migrations run as same user | SQLi or RCE can DROP tables. | Separate migration user and DML-only runtime user. | M |
| F-16 R | Medium | Secrets | `shared/encryption.js` single key, no key id; also `.env.production` is in the off-site backup | No key rotation path; restic password is the single root of trust for ciphertext and key. | Version-prefix ciphertext, re-encrypt script; document the root of trust. | M |
| F-17 R | Medium | Docker | `docker-compose.prod.yml:53` healthcheck `mysqladmin ... -p${MYSQL_ROOT_PASSWORD}` | Root DB password visible via `docker inspect` and process args. | Use MYSQL_PWD via `$$` or a defaults file. | S |
| F-18 R | Low-Med | Tenancy | `signup/service.js:55,95` no reserved-slug list | Tenant can claim `www`, `api`, `admin`, `billing`, `mail`... as `{slug}.APP_DOMAIN` for phishing. | Reserved-slug denylist. | S |
| F-19 R | Low-Med | Data | `platform/backup.js:198`, `db/dump.js` | Emailed dump includes all PII, password hashes, session/token hashes, PIN hashes, auth events and outbox codes; mailbox retention risk. | Exclude sessions, tokens, outbox payloads; or retire in favour of restic. | M |
| F-20 R | Low-Med | Compliance | no guest-level erasure/anonymisation writer found; failed-login `auth_events` with NULL tenant unpurgeable | NDPA/GDPR erasure and retention gaps. | Per-guest anonymise action and retention policy. | M-L |
| F-21 R | Low | Auth | `auth/service.js:126-170` | Unknown user skips bcrypt (timing enumeration); lockout reveals account exists and can be used to lock a known admin for 15 min. | Dummy bcrypt compare; bucket failures by IP+account. | S |
| F-22 R | Low | Auth | `users/service.js` `invitationUrl` uses `http://` | Single-use invite token travels in clear before Caddy's redirect. | `https` in production. | S |
| F-23 R | Low | Auth | `auth/middleware.js liveContextFor` | Staff access JWT valid up to 15 min after logout or password reset (no session id claim). | Add session id or password-changed claim. | M |
| F-24 V | Low | Dev infra | `docker-compose.yml` mutable tags, `change-me` creds, Redis no password; ports on 127.0.0.1 | Local-only exposure. | Digests, `.env`, profiles for adminer/phpMyAdmin. | S |
| F-25 V | Low | Runtime | `backend/Dockerfile:24,35` `node:20` (EOL Apr 2026); no `read_only`, `cap_drop`, `no-new-privileges`, memory limits in prod compose | Unpatched runtime; weaker container containment. | Node 22/24; hardening flags and limits. | S |
| F-26 R | Low | CI | `ci.yml` no `permissions:` block; `checkout@v4`/`setup-node@v4` unpinned | Wider default token scope; tag drift. | `permissions: contents: read`; pin SHAs. | S |
| F-27 R | Low | Ingress | Caddyfile: no `request_body max_size`; ask-tls limiter keyed on Caddy's IP (effectively global 120/min); CSP `style-src 'unsafe-inline'`, `img-src https:` | Unbounded multipart at the proxy; fake-hostname flood could slow new-tenant certs. | Set max_size; key on asked hostname. | S |
| F-28 R | Low | Auth | Platform MFA enrolment is trust-on-first-use; enrolment JWT carries the TOTP secret (signed, not encrypted) | First login on a passworded platform account enrols their own authenticator. | Out-of-band bootstrap code. | M |
| F-29 R | Low | Auth | `migration/controller.js:54`, `service.js:109-121` | Admin at property A imports into property B of same tenant. | Require grant at target property. | S |
| F-30 R | Low | Money | `cashiering/service.js:457` `postAdjustment` uncapped; any sign | Typo or large adjustment by `void_line` holders; non-numeric gives 500. | Reuse amount validation plus cap. | S |
| F-31 R | Low | Logging | `shared/error-handler.js:~32` `console.error(error)` | MySQL errors include SQL text and bindings (guest data) in logs. | Log code, message, request id only. | S |
| F-32 R | Info | Public limits | `/auth/refresh`, `/auth/logout`, branding, portal and QR GET endpoints, media have no rate limit | Scraping or load; confirmation numbers are ULIDs so guessing is impractical. | Generous per-IP limits. | S |

Suspicions (not confirmed): `/auth/switch-property`, `PATCH /auth/me`, `/auth/me/password` accept impersonation tokens and sit before the read-only guard (probably a 500, not an action); `voidLineItem` on payment-linked tax lines and `moveLineItem` across a closed reservation were not examined; the idempotency payload hash is key-order sensitive (false 409 on retry); `payments.idempotency_key` is shared across operation types.

## 3. Missing and partial features

Evidence from CLAUDE.md history plus greps. I confirmed no suppliers/purchase-order tables, no min-stay/closed-to-arrival columns, no nationality/passport/ID columns, and no service worker or manifest (`frontend/public` has only a favicon and apple-touch icon). The `revenue-management` module directory is empty. "Order" is my suggested build order.

| Feature | Why it matters (NG / UK) | Current state | Effort | Order |
|---|---|---|---|---|
| Discounts, comps, vouchers, promotions, gift cards | Daily bar, restaurant and staff-discount practice; needs approval and reporting | Missing (noted as never built); negative tips and charges are currently the loophole | M-L | 1 (with F-02/F-03) |
| POS offline queue | Power and network outages are routine | Missing; actions disabled offline | L | 2 |
| Thermal, kitchen printing, KDS | Standard in restaurants and bars | Partial: browser `window.print`, on-screen Tickets queue | M-L | 3 |
| Suppliers, POs, supplier invoices, supplier credit | Stores buy on credit; "who do I owe" | Missing (only goods received, stock requests) | L | 4 |
| Guest ID capture, guest register | Legal requirement for Nigerian hotels | Missing | M | 5 |
| WhatsApp and SMS comms | WhatsApp dominates in Nigeria; SMS OTP | Missing; email only (outbox, templates, log, resend exist) | M | 6 |
| Rate restrictions, packages | Weekend minimums, breakfast-included rates | Partial: rate codes and calendar only | M | 7 |
| Audit-log screen | "Who voided this?" | Partial: table and writes exist, no UI | S-M | 8 |
| Accounting export, VAT return | Accountants; FIRS filing | Missing / partial (tax engine only) | M | 9 |
| Channel manager / iCal | OTA bookings; double-booking risk | Missing | L (iCal S-M) | 10 |
| Maintenance work orders | Generators, AC, plumbing | Missing (only out-of-order periods) | M | 11 |
| Custom roles and permission editor | Staffing varies by hotel | Missing: seven fixed roles | M | 12 |
| Multi-currency / FX | Foreign guests; UK later | Partial: currency per row, one per property, no rates | L | 13 |
| FIRS e-invoicing, UK MTD VAT | Compliance, UK launch | Missing | L | 14 |
| Stock valuation, expiry/batch | Owners and food/drink safety | Partial: last cost only | S-M / M | 15 |
| Pre-arrival and post-stay review emails | Reputation and upsell | Partial: lifecycle emails only | S-M | 16 |
| PWA (manifest, service worker) | Phones and tablets are the main devices | Partial: responsive, not installable | S | 17 |
| Staff rosters, commissions, payroll hooks | Waiter commissions; shifts | Missing (shifts exist for cash-up only) | M-L | 18 |
| Supermarket credit/loyalty accounts, partial returns | Customer credit common in minimarts | Missing / partial (void and full online refund only) | M | 19 |
| Public API keys, outbound webhooks | Integrations | Missing (inbound Paystack only) | L | 20 |
| Tenant-staff TOTP and MFA recovery | Safer than emailed codes; no recovery path today | Partial: TOTP for platform staff only | S-M | 21 |
| Restaurant table booking, floor plan; label printing; multi-language; SSO; support ticketing | Lower priority | Missing or partial | M-L | later |

Exists and solid: reservations (hold, waitlist, extend, move, tape chart), guest portal and online booking with Paystack, housekeeping board and discrepancies, 13-step night audit with overstay billing, group blocks, AR and corporate billing, reporting (occupancy, revenue, Business Summary, department P&L, reconciliation), expenses, POS (tabs, split, tips, service charge, shifts, external terminals, QR ordering), stock with recipes, transfers, requests and takes, supermarket till with barcode camera scan and CSV import, manager PIN approvals, data export and offboarding, platform console and SaaS billing, data-migration CSV import, offsite encrypted backups.

## 4. Roadmap

**Next 2 weeks (all S, mostly validation and locks)**
- F-01 role rank and last-owner rule; F-02 tip validation; F-03 charge validation and `business_date` clamp; F-11 wastage and receive validation; F-30 adjustment cap.
- F-04 and F-05 (M): lock the payment and folio rows; add concurrency tests in the style of the existing real-connection suites.
- F-06 SIGTERM handling; F-17 healthcheck password; F-25 Node 22; F-26 CI permissions; F-22 https invite links; F-18 reserved slugs; F-10 webhook limits.
- Tests first for every fix (a failing test reproducing each issue).

**Next 2 months**
- F-07 outbox redaction and retention; F-08 refresh-token reuse detection; F-09 timeouts, uptime and failed-job alerts, Redis in `/healthz`; F-12 xlsx cap; F-13 impersonation export block; F-14 atomic attempt counters; F-15 separate DB users; F-16 key versioning.
- Features: discounts and vouchers with approvals, audit-log screen, guest ID capture, rate restrictions and packages, accounting and VAT exports, thermal printing, WhatsApp/SMS via a provider adapter, PWA.
- Run a real restore drill against B2 and a fresh pre-deploy dump (still unproven).

**Later**
- POS offline queue, suppliers and purchase orders, channel manager (iCal first), FX, FIRS e-invoicing and UK MTD, custom roles, public API and webhooks, guest erasure and retention (F-20), maintenance module, tenant-staff TOTP with recovery, DB-user separation if not done.

## 5. Could not verify

- Anything needing a live server: whether F-04 and F-05 reproduce under real concurrency (read from code only), rate-limiter behaviour when Redis is down (fail-open or fail-closed, including the ask-tls limiter), actual response timing for user enumeration.
- Real Paystack: gateway-side idempotency on duplicate refunds, transfer and NQR under- or over-payment behaviour, subaccount verification, webhook delivery from the real network.
- Real mail: spam placement, SPF/DKIM/DMARC state, whether `notification_log` stores rendered bodies with codes.
- A browser: CSP effects on every screen (the final `script-src`/`style-src` and landing-page policies were only partly read), PWA install behaviour, camera scanning on iPhone, print output.
- VPS and ops: host hardening (SSH, firewall, updates), restic restore drill on real B2, whether the production DB user's grants match the compose defaults, backup of `.env.production` handling by the operator.
- Not audited in depth: supermarket online-sale code, billing dunning, QR order totals, outlet-scope IDOR across POS and stock routes, `voidLineItem`/`moveLineItem` edge cases, i18n and accessibility.
