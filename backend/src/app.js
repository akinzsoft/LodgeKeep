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
const { staffAuthRouter, portalAuthRouter, platformAuthRouter, authenticate } = require('./auth');
const { attachAudit } = require('./audit');
const { setupRouter } = require('./modules/setup');
const { reservationsRouter } = require('./modules/reservations');

function buildStaffRouter() {
  const router = express.Router();
  const tenantMiddleware = resolveTenant({ db: scopedDb(), systemContext });
  router.use('/auth', staffAuthRouter({ resolveTenant: tenantMiddleware }));
  router.use(authenticate('staff'));
  // req.audit(...) — PLAN.md Phase 0's audit trail (SECURITY.md §6). After
  // authenticate() specifically: it reads req.context for who/tenant/property.
  router.use(attachAudit());
  // Business routers (cashiering, ...) mount here, ahead of the catch-all,
  // as each module lands (PLAN.md Phase 1+).
  router.use(setupRouter());
  router.use(reservationsRouter());
  router.use((req, res) => notFound(res));
  return router;
}

function buildPortalRouter() {
  const router = express.Router();
  const tenantMiddleware = resolveTenant({ db: scopedDb(), systemContext });
  router.use('/auth', portalAuthRouter({ resolveTenant: tenantMiddleware }));
  router.use(authenticate('guest'));
  router.use((req, res) => notFound(res));
  return router;
}

function buildPlatformRouter() {
  const router = express.Router();
  router.use('/auth', platformAuthRouter());
  router.use(authenticate('platform'));
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
  app.use(express.json());

  app.use('/api/v1/portal', buildPortalRouter());
  app.use('/api/v1/platform', buildPlatformRouter());
  app.use('/api/v1', buildStaffRouter());

  app.use((req, res) => notFound(res));
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
