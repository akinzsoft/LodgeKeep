'use strict';

/**
 * The Express application — API.md §1 (base path, envelope), §4 (three
 * identity populations, three route trees). ARCHITECTURE.md §2 lists this file
 * alongside `src/db`, `src/auth`, and `src/modules` as the top of the backend
 * tree.
 *
 * Each tree below is built as its own self-contained Router: a small explicit
 * public allow-list, then `authenticate(audience)` guarding everything after
 * it, then a trailing catch-all that answers with the API.md §5 bare-404 for
 * anything unmatched. Keeping each tree self-terminating is what stops an
 * authenticated guest request that matches no portal route from falling
 * through into the staff tree's gate and coming back as a confusing
 * wrong-audience error instead of a plain "not found" — see the tenancy
 * module's own notes on scope for the same "fail closed, fail legibly"
 * instinct applied to routing.
 *
 * `PLAN.md`'s Phase 0 line item is auth, RBAC, and the audit trail; the
 * business routers each tree's catch-all currently stands in for (reservations,
 * front-desk, cashiering, ...) arrive in later phases and are inserted before
 * that catch-all as they land.
 */

const express = require('express');
const { requestId } = require('./shared/request-id');
const { notFound } = require('./shared/response');
const { errorHandler } = require('./shared/error-handler');
const { scopedDb } = require('./db');
const { systemContext } = require('./modules/tenancy');
const { resolveTenant } = require('./auth/tenant-resolution');
const {
  staffAuthRouter,
  portalAuthRouter,
  platformAuthRouter,
  authenticate,
  rejectMutationDuringImpersonation,
  rejectMutationForTenantLifecycle,
} = require('./auth');
const { attachAudit } = require('./audit');
const { setupRouter } = require('./modules/setup');
const { usersRouter } = require('./modules/users');
const { reservationsRouter } = require('./modules/reservations');
const { housekeepingRouter } = require('./modules/housekeeping');
const { notificationsRouter } = require('./modules/notifications');
const { reportingRouter } = require('./modules/reporting');
const { cashieringRouter, paystackWebhookRouter } = require('./modules/cashiering');
const { nightAuditRouter } = require('./modules/night-audit');
const { profilesRouter } = require('./modules/profiles');
const { portalPublicRouter, portalAccountRouter } = require('./modules/portal');
const { posRouter } = require('./modules/pos');
const { arRouter } = require('./modules/ar');
const { groupBlocksRouter } = require('./modules/group-blocks');
const { platformConsoleRouter, staffImpersonationRouter } = require('./modules/platform');
const { signupRouter } = require('./modules/signup');
const { billingRouter, billingWebhookRouter } = require('./modules/billing');
const { offboardingRouter } = require('./modules/offboarding');
const { migrationRouter } = require('./modules/migration');
const { qrOrderPublicRouter, qrOrderStaffRouter } = require('./modules/qr-ordering');

function buildStaffRouter() {
  const router = express.Router();
  const tenantMiddleware = resolveTenant({ db: scopedDb(), systemContext });
  router.use('/auth', staffAuthRouter({ resolveTenant: tenantMiddleware }));
  // API.md §7: a webhook authenticates by signature, never a bearer token —
  // mounted here, before authenticate('staff'), same as /auth above.
  router.use(paystackWebhookRouter());
  router.use(billingWebhookRouter());
  router.use(authenticate('staff'));
  // PLAN.md Phase 5 (Platform Foundation) — mounted BEFORE the read-only
  // guard below: "end my own impersonation grant" is the one mutation an
  // impersonation-derived token IS allowed to perform (SECURITY.md §2's own
  // exit action), gated by the token's own identity, not a business
  // permission. See routes.js's own header for the full reasoning.
  router.use(staffImpersonationRouter());
  // The actual read-only boundary (SECURITY.md §2) — every other mutation
  // under an active impersonation grant is rejected here, structurally,
  // before any business router below ever sees the request.
  router.use(rejectMutationDuringImpersonation());
  // PLAN.md Phase 5 (tenant offboarding) — mounted here, AFTER the
  // impersonation guard but BEFORE the tenant-lifecycle one just below,
  // for two separate reasons: a platform admin impersonating a tenant
  // must never trigger a real offboarding request "as" that tenant (that
  // guard still applies), but a tenant already `offboarding` must still
  // be able to check status, retry a failed export, or download a
  // completed one — the entire reason this module exists. See
  // `offboarding/routes.js`'s own header for the full reasoning, the
  // identical placement logic `staffImpersonationRouter()` above already
  // established for its own "must survive the state it's about" route.
  router.use(offboardingRouter());
  // PLAN.md Phase 5 — the trial/suspended read-only boundary
  // (PRODUCT_REQUIREMENTS.md §3.22), the identical shape and placement as
  // the impersonation guard just above it, for a different read-only
  // reason. Ordered after `staffImpersonationRouter()` for the same
  // reason: ending an impersonation session must stay reachable regardless
  // of the underlying tenant's own lifecycle status.
  router.use(rejectMutationForTenantLifecycle());
  // req.audit(...) — PLAN.md Phase 0's audit trail (SECURITY.md §6). After
  // authenticate() specifically: it reads req.context for who/tenant/property.
  router.use(attachAudit());
  // Business routers mount here, ahead of the catch-all, as each module lands.
  router.use(setupRouter());
  router.use(usersRouter());
  router.use(reservationsRouter());
  router.use(profilesRouter());
  router.use(housekeepingRouter());
  router.use(notificationsRouter());
  router.use(reportingRouter());
  router.use(cashieringRouter());
  router.use(nightAuditRouter());
  router.use(posRouter());
  router.use(arRouter());
  router.use(groupBlocksRouter());
  router.use(billingRouter());
  // PLAN.md Phase 5's last unbuilt bullet — data migration
  // (PRODUCT_REQUIREMENTS.md §3.20). No special ordering need, unlike
  // offboarding/impersonation above — a migration run never has to survive
  // a read-only tenant-lifecycle state or an impersonation grant.
  router.use(migrationRouter());
  // PLAN.md Phase 6 — QR self-ordering's staff-facing half (token
  // management, the guest-order queue), gated the same as `posRouter()`
  // (`pos.operate`/`pos.manage` — see that module's own routes.js header).
  router.use(qrOrderStaffRouter());
  router.use((req, res) => notFound(res));
  return router;
}

function buildPortalRouter() {
  const router = express.Router();
  const tenantMiddleware = resolveTenant({ db: scopedDb(), systemContext });
  router.use('/auth', portalAuthRouter({ resolveTenant: tenantMiddleware }));
  // PLAN.md Phase 4: attachAudit() is mounted on THIS outer router, before
  // either sub-router below, not inside one of them — a nested router's own
  // route handler responds directly and never falls through to a
  // middleware registered after `router.use(thatSubRouter)`, so mounting it
  // any later would leave `req.audit` undefined for every request
  // portalPublicRouter()'s own routes actually handle. It only needs
  // `req.context` to exist once a handler calls `req.audit(...)`, not at
  // mount time — portalPublicRouter()'s own `resolvePortalProperty`
  // middleware sets an anonymous one; authenticate('guest') below replaces
  // it with a real, account-bound one for everything after it.
  router.use(attachAudit());
  // portalPublicRouter() applies `tenantMiddleware` itself, per-route (see
  // its own header) — never router-wide, since the authenticated tier
  // below needs no Host-header resolution at all.
  router.use(portalPublicRouter({ resolveTenant: tenantMiddleware }));
  router.use(authenticate('guest'));
  router.use(portalAccountRouter());
  router.use((req, res) => notFound(res));
  return router;
}

/**
 * PLAN.md Phase 6 — QR self-ordering's guest-facing half. Own top-level
 * tree, mirroring `buildPortalRouter()`'s public half exactly (its own
 * `tenantMiddleware`, `attachAudit()` mounted ahead of the property/token
 * resolution so `req.audit(...)` is defined for every route this tree
 * actually handles) — but with NO authenticated tier at all: every route
 * here is reachable with no bearer token, ever, by design (a guest
 * scanning a physical QR sticker has no account and no session).
 */
function buildQrOrderRouter() {
  const router = express.Router();
  const tenantMiddleware = resolveTenant({ db: scopedDb(), systemContext });
  router.use(attachAudit());
  router.use(qrOrderPublicRouter({ resolveTenant: tenantMiddleware }));
  router.use((req, res) => notFound(res));
  return router;
}

function buildPlatformRouter() {
  const router = express.Router();
  router.use('/auth', platformAuthRouter());
  router.use(authenticate('platform'));
  router.use(platformConsoleRouter());
  router.use((req, res) => notFound(res));
  return router;
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Trusts the immediate proxy's X-Forwarded-For — correct once this sits
  // behind a load balancer (ARCHITECTURE.md §15's "more than one backend
  // instance" future), and needed for the auth rate-limit/lockout tiers'
  // per-IP dimension to see the real client IP rather than the proxy's own.
  // `1` (not `true`): trust exactly one hop, not the whole forwarded chain a
  // client could otherwise forge.
  app.set('trust proxy', 1);
  app.use(requestId());
  // `verify` stashes the exact raw bytes onto `req.rawBody` — API.md §7's
  // webhook signature check (`src/modules/cashiering/paystack-adapter.js`)
  // must HMAC the raw body Paystack actually sent, not a re-serialized
  // object that could differ in whitespace/key order. Applied globally
  // (negligible cost) rather than only on the webhook route, since Express
  // has no per-route way to swap body-parser configuration once mounted.
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

  // PLAN.md Phase 5 — self-service signup. No tenant exists yet at this
  // point (that is the whole reason it's a separate mount, not nested
  // inside `buildStaffRouter()`): it needs neither Host-header tenant
  // resolution nor `authenticate('staff')`, both of which presuppose a
  // tenant already exists. See `modules/signup/routes.js`'s own header.
  app.use('/api/v1', signupRouter());
  app.use('/api/v1/portal', buildPortalRouter());
  // PLAN.md Phase 6 — QR self-ordering's guest-facing half. Mounted before
  // `buildStaffRouter()`'s own catch-all could ever see it, at its own
  // path prefix so a guest's raw token never collides with any staff
  // route shape.
  app.use('/api/v1/qr-order', buildQrOrderRouter());
  app.use('/api/v1/platform', buildPlatformRouter());
  app.use('/api/v1', buildStaffRouter());

  app.use((req, res) => notFound(res));
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
