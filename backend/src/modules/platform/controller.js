'use strict';

/**
 * HTTP layer for the platform console — parses the request, calls the
 * service, shapes the API.md §2 envelope. No business logic here; see
 * `service.js`.
 */

const { ok, notFound } = require('../../shared/response');
const { ValidationError } = require('../../shared/errors');
const service = require('./service');

function require_(body, field) {
  const value = body?.[field];
  if (value === undefined || value === null || value === '') {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value;
}

function requestMeta(req) {
  return { ip: req.ip, userAgent: req.get('User-Agent'), requestId: req.requestId };
}

// ---------------------------------------------------------------------
// Tenant roster — GET /platform/tenants[...]
// ---------------------------------------------------------------------

async function listTenants(req, res, next) {
  try {
    res.status(200).json(ok(await service.listTenants({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

async function getTenant(req, res, next) {
  try {
    const tenant = await service.getTenantWithProperties({ context: req.context, tenantId: req.params.id });
    if (!tenant) return notFound(res);
    res.status(200).json(ok(tenant));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Impersonation
// ---------------------------------------------------------------------

async function startImpersonation(req, res, next) {
  try {
    const propertyId = require_(req.body, 'property_id');
    const reason = require_(req.body, 'reason');
    const result = await service.startImpersonation({
      context: req.context,
      tenantId: req.params.id,
      propertyId,
      reason,
      ...requestMeta(req),
    });
    res.status(201).json(ok(result));
  } catch (error) {
    next(error);
  }
}

async function listImpersonationSessionsForPlatform(req, res, next) {
  try {
    res.status(200).json(ok(await service.listImpersonationSessionsForPlatform({ context: req.context, tenantId: req.params.id })));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Tenant lifecycle — PLAN.md Phase 5, admin-tier only (requirePlatformRole
// at the route)
// ---------------------------------------------------------------------

async function suspendTenant(req, res, next) {
  try {
    const reason = require_(req.body, 'reason');
    const result = await service.suspendTenant({ context: req.context, tenantId: req.params.id, reason, ...requestMeta(req) });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

async function reactivateTenant(req, res, next) {
  try {
    const result = await service.reactivateTenant({
      context: req.context,
      tenantId: req.params.id,
      reason: req.body?.reason,
      ...requestMeta(req),
    });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

async function offboardTenant(req, res, next) {
  try {
    const result = await service.offboardTenant({
      context: req.context,
      tenantId: req.params.id,
      reason: req.body?.reason,
      ...requestMeta(req),
    });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

/** POST /impersonation/end — mounted on the STAFF tree, ahead of the read-only guard; the caller's own token IS the authorization to end its own grant. A no-op (never an error) for an ordinary staff token, which has no grant to end. */
async function endImpersonation(req, res, next) {
  try {
    if (!req.context.isImpersonation) {
      return res.status(200).json(ok({ ended: false }));
    }
    const result = await service.endImpersonation({ context: req.context, ...requestMeta(req) });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

/** GET /impersonation-sessions — mounted on the STAFF tree, tenant-side "who saw my account" visibility (SECURITY.md §2). */
async function listImpersonationSessionsForTenant(req, res, next) {
  try {
    res.status(200).json(ok(await service.listImpersonationSessionsForTenant({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listTenants,
  getTenant,
  startImpersonation,
  listImpersonationSessionsForPlatform,
  endImpersonation,
  listImpersonationSessionsForTenant,
  suspendTenant,
  reactivateTenant,
  offboardTenant,
};
