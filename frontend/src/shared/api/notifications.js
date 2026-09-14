import { request, requestWithMeta } from './client.js';

/**
 * PLAN.md Phase 3's notifications module — templates, delivery log/resend,
 * and the in-app bell. Same shape as `reservations.js`: plain exported
 * functions, each a thin wrapper over `request()`.
 */

export function listTemplates() {
  return request('/notifications/templates');
}

/** @param {{templateKey: string, locale?: string, subject: string, bodyHtml: string}} params */
export function upsertTemplate({ templateKey, locale, subject, bodyHtml }) {
  return request('/notifications/templates', {
    method: 'PUT',
    body: { template_key: templateKey, locale, subject, body_html: bodyHtml },
  });
}

/** @param {{recipientEmail?: string, templateKey?: string, status?: string}} [filters] */
export function listNotificationLog(filters = {}) {
  const params = new URLSearchParams();
  if (filters.recipientEmail) params.set('recipient_email', filters.recipientEmail);
  if (filters.templateKey) params.set('template_key', filters.templateKey);
  if (filters.status) params.set('status', filters.status);
  const query = params.toString();
  return request(`/notifications/log${query ? `?${query}` : ''}`);
}

export function resendNotification(id) {
  return request(`/notifications/log/${id}/resend`, { method: 'POST', body: {} });
}

/**
 * The signed-in user's most recent bell notifications plus their true unread
 * count (`meta.unreadCount` — the list itself is capped server-side, so the
 * badge can't be derived from it).
 *
 * @param {{unreadOnly?: boolean}} [filters]
 * @returns {Promise<{notifications: Array<object>, unreadCount: number}>}
 */
export async function listBellNotifications(filters = {}) {
  const params = new URLSearchParams();
  if (filters.unreadOnly) params.set('unread', 'true');
  const query = params.toString();
  const { data, meta } = await requestWithMeta(`/notifications/bell${query ? `?${query}` : ''}`);
  return { notifications: data ?? [], unreadCount: Number(meta?.unreadCount ?? 0) };
}

export function markAllNotificationsRead() {
  return request('/notifications/bell/read-all', { method: 'POST', body: {} });
}

/** Every staff notification type with its label, group, description, and default recipient roles. */
export function getNotificationCatalogue() {
  return request('/notifications/catalogue');
}

/** This property's saved role overrides: `[{eventType, role, enabled}]`. */
export function getNotificationRoleRules() {
  return request('/notifications/role-rules');
}

/** @param {Array<{eventType: string, role: string, enabled: boolean}>} rules */
export function saveNotificationRoleRules(rules) {
  return request('/notifications/role-rules', { method: 'PUT', body: { rules } });
}

export function markNotificationRead(id) {
  return request(`/notifications/bell/${id}/read`, { method: 'POST', body: {} });
}
