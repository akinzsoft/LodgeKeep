'use strict';

/**
 * HTTP layer for the notifications module — parses the request, calls the
 * service, shapes the API.md §2 envelope. No business logic here; see
 * `service.js`.
 */

const { ok, notFound } = require('../../shared/response');
const { ValidationError } = require('../../shared/errors');
const service = require('./service');

function require_(body, field) {
  const value = body?.[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value;
}

// ---------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------

async function listTemplates(req, res, next) {
  try {
    res.status(200).json(ok(await service.listTemplates({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

async function upsertTemplate(req, res, next) {
  try {
    const templateKey = require_(req.body, 'template_key');
    const subject = require_(req.body, 'subject');
    const bodyHtml = require_(req.body, 'body_html');
    const template = await service.upsertTemplate({
      context: req.context,
      templateKey,
      locale: req.body?.locale,
      subject,
      bodyHtml,
    });
    await req.audit({ entityType: 'email_templates', entityId: template.id, action: 'upsert', afterState: template });
    res.status(200).json(ok(template));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Delivery log
// ---------------------------------------------------------------------

async function listNotificationLog(req, res, next) {
  try {
    const log = await service.listNotificationLog({
      context: req.context,
      recipientEmail: req.query?.recipient_email,
      templateKey: req.query?.template_key,
      status: req.query?.status,
    });
    res.status(200).json(ok(log));
  } catch (error) {
    next(error);
  }
}

async function resendNotification(req, res, next) {
  try {
    const { id } = req.params;
    const before = await service.getNotificationLogEntry({ context: req.context, id });
    if (!before) return notFound(res);
    const resent = await service.resendNotification({ context: req.context, id });
    await req.audit({ entityType: 'notification_log', entityId: resent.id, action: 'resend', beforeState: before, afterState: resent });
    res.status(201).json(ok(resent));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// In-app bell — no permission gate: every authenticated staff member reads
// only their own notifications, regardless of role.
// ---------------------------------------------------------------------

async function listInAppNotifications(req, res, next) {
  try {
    const notifications = await service.listInAppNotifications({
      context: req.context,
      userId: req.context.userId,
      unreadOnly: req.query?.unread === 'true',
    });
    res.status(200).json(ok(notifications));
  } catch (error) {
    next(error);
  }
}

async function markNotificationRead(req, res, next) {
  try {
    const { id } = req.params;
    const notification = await service.markNotificationRead({ context: req.context, id, userId: req.context.userId });
    if (!notification) return notFound(res);
    res.status(200).json(ok(notification));
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listTemplates,
  upsertTemplate,
  listNotificationLog,
  resendNotification,
  listInAppNotifications,
  markNotificationRead,
};
