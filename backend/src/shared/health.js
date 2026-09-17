'use strict';

/**
 * A minimal liveness/readiness endpoint — nothing in this codebase exposed
 * one before this (no `/health`/`/healthz` route existed anywhere).
 * Production Docker deployment needs it three ways: `backend/Dockerfile`'s
 * own HEALTHCHECK, `docker-compose.prod.yml`'s `depends_on: condition:
 * service_healthy` graph, and Caddy's own continuous upstream health-check
 * of the backend (`docker/frontend/Caddyfile`).
 *
 * Mounted directly in `app.js`, ahead of every other router, tenant
 * resolution, and the audit trail — it must never depend on any of them. A
 * broken login flow (a bad `APP_DOMAIN`, an expired JWT secret, whatever)
 * must never be indistinguishable from a genuinely broken backend process.
 *
 * Checks real MySQL connectivity (`SELECT 1`), not just "the HTTP server is
 * listening" — a container that's up but can't reach its database is
 * exactly the failure this exists to catch at cold start, and is not
 * "healthy" for the purposes `docker-compose.prod.yml`'s own dependency
 * graph uses this for. This is a deliberate, narrow exception to "every
 * module reaches the database through the scoped accessor"
 * (SECURITY.md §2): a bare connectivity ping touches no table and carries
 * no tenant-isolation concern — nothing that rule exists to protect
 * against applies here.
 */

const express = require('express');
const { knex } = require('../db');

function healthRouter() {
  const router = express.Router();

  router.get('/healthz', async (req, res) => {
    try {
      await knex().raw('SELECT 1');
      res.status(200).json({ status: 'ok' });
    } catch (error) {
      res.status(503).json({ status: 'error' });
    }
  });

  return router;
}

module.exports = { healthRouter };
