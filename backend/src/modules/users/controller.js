'use strict';

/**
 * HTTP layer for user management — parses the request, calls the service,
 * shapes the API.md §2 envelope. No business logic here; see `service.js`.
 */

const { ok, notFound } = require('../../shared/response');
const service = require('./service');
const { ValidationError } = require('../../shared/errors');

function require_(body, field) {
  const value = body?.[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value;
}

async function listUsers(req, res, next) {
  try {
    res.status(200).json(ok(await service.listUsers({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

async function listPendingInvitations(req, res, next) {
  try {
    res.status(200).json(ok(await service.listPendingInvitations({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

async function inviteUser(req, res, next) {
  try {
    const email = require_(req.body, 'email');
    const role = require_(req.body, 'role');
    const { invitation, devOnlyToken } = await service.inviteUser({
      context: req.context,
      email,
      role,
      invitedByUserId: req.context.userId,
    });
    await req.audit({ entityType: 'user_invitations', entityId: invitation.id, action: 'create', afterState: invitation });
    // dev_only_token: never present outside development/test — the exact
    // shape `POST /auth/password/forgot`'s response already established.
    res.status(201).json(ok({ ...invitation, dev_only_token: devOnlyToken }));
  } catch (error) {
    next(error);
  }
}

async function deactivateUser(req, res, next) {
  try {
    const { id } = req.params;
    const before = await service.getUserAtActiveProperty({ context: req.context, id });
    if (!before) return notFound(res);
    const user = await service.deactivateUser({ context: req.context, id });
    await req.audit({ entityType: 'users', entityId: id, action: 'deactivate', beforeState: before, afterState: user });
    res.status(200).json(ok(user));
  } catch (error) {
    next(error);
  }
}

async function changeUserRole(req, res, next) {
  try {
    const { id } = req.params;
    const role = require_(req.body, 'role');
    const before = await service.getUserAtActiveProperty({ context: req.context, id });
    if (!before) return notFound(res);
    const user = await service.changeUserRole({ context: req.context, id, role });
    await req.audit({ entityType: 'user_property_access', entityId: id, action: 'change_role', beforeState: before, afterState: user });
    res.status(200).json(ok(user));
  } catch (error) {
    next(error);
  }
}

module.exports = { listUsers, listPendingInvitations, inviteUser, deactivateUser, changeUserRole };
