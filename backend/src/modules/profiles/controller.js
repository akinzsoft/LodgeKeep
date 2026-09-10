'use strict';

/**
 * HTTP layer for Profiles (Guest CRM) — parses the request, calls the
 * service, shapes the API.md §2 envelope. No business logic here; see
 * `service.js`.
 */

const { ok, notFound } = require('../../shared/response');
const service = require('./service');
const { ValidationError } = require('../../shared/errors');

function requireQuery(query, field) {
  const value = query?.[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value.trim();
}

function require_(body, field) {
  const value = body?.[field];
  if (value === undefined || value === null || value === '') {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value;
}

async function getGuestActivitySummary(req, res, next) {
  try {
    res.status(200).json(ok(await service.getGuestActivitySummary({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

async function searchGuests(req, res, next) {
  try {
    const query = requireQuery(req.query, 'q');
    res.status(200).json(ok(await service.searchGuests({ context: req.context, query })));
  } catch (error) {
    next(error);
  }
}

async function getGuest(req, res, next) {
  try {
    const guest = await service.getGuest({ context: req.context, id: req.params.id });
    if (!guest) return notFound(res);
    res.status(200).json(ok(guest));
  } catch (error) {
    next(error);
  }
}

async function getGuestStayHistory(req, res, next) {
  try {
    const guest = await service.getGuest({ context: req.context, id: req.params.id });
    if (!guest) return notFound(res);
    res.status(200).json(ok(await service.getGuestStayHistory({ context: req.context, id: req.params.id })));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Company profiles — PLAN.md Phase 4 (Accounts Receivable)
// ---------------------------------------------------------------------

/** The allowlist pattern (CLAUDE.md's own repeatedly-flagged lesson) — extracts only the known-safe fields, mirroring `pickRoomTypeChanges`/`pickPropertyChanges` (setup/controller.js). */
function pickCompanyProfileChanges(body) {
  const changes = {};
  if (body?.name !== undefined) changes.name = body.name;
  if (body?.type !== undefined) changes.type = body.type;
  if (body?.billing_email !== undefined) changes.billing_email = body.billing_email;
  if (body?.billing_phone !== undefined) changes.billing_phone = body.billing_phone;
  if (body?.billing_address !== undefined) changes.billing_address = body.billing_address;
  if (body?.payment_terms_days !== undefined) changes.payment_terms_days = Number(body.payment_terms_days);
  return changes;
}

async function createCompanyProfile(req, res, next) {
  try {
    const name = require_(req.body, 'name');
    const company = await service.createCompanyProfile({
      context: req.context,
      name,
      type: req.body?.type,
      billingEmail: req.body?.billing_email,
      billingPhone: req.body?.billing_phone,
      billingAddress: req.body?.billing_address,
      paymentTermsDays: req.body?.payment_terms_days,
    });
    await req.audit({ entityType: 'company_profiles', entityId: company.id, action: 'create', afterState: company });
    res.status(201).json(ok(company));
  } catch (error) {
    next(error);
  }
}

async function updateCompanyProfile(req, res, next) {
  try {
    const { id } = req.params;
    const before = await service.getCompanyProfile({ context: req.context, id });
    if (!before) return notFound(res);
    const company = await service.updateCompanyProfile({ context: req.context, id, changes: pickCompanyProfileChanges(req.body) });
    await req.audit({ entityType: 'company_profiles', entityId: id, action: 'update', beforeState: before, afterState: company });
    res.status(200).json(ok(company));
  } catch (error) {
    next(error);
  }
}

async function archiveCompanyProfile(req, res, next) {
  try {
    const { id } = req.params;
    const before = await service.getCompanyProfile({ context: req.context, id });
    if (!before) return notFound(res);
    const company = await service.archiveCompanyProfile({ context: req.context, id });
    await req.audit({ entityType: 'company_profiles', entityId: id, action: 'archive', beforeState: before, afterState: company });
    res.status(200).json(ok(company));
  } catch (error) {
    next(error);
  }
}

async function getCompanyProfile(req, res, next) {
  try {
    const company = await service.getCompanyProfile({ context: req.context, id: req.params.id });
    if (!company) return notFound(res);
    res.status(200).json(ok(company));
  } catch (error) {
    next(error);
  }
}

async function listCompanyProfiles(req, res, next) {
  try {
    const query = typeof req.query?.q === 'string' && req.query.q.trim().length > 0 ? req.query.q.trim() : null;
    const companies = query ? await service.searchCompanyProfiles({ context: req.context, query }) : await service.listCompanyProfiles({ context: req.context });
    res.status(200).json(ok(companies));
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getGuestActivitySummary,
  searchGuests,
  getGuest,
  getGuestStayHistory,
  createCompanyProfile,
  updateCompanyProfile,
  archiveCompanyProfile,
  getCompanyProfile,
  listCompanyProfiles,
};
