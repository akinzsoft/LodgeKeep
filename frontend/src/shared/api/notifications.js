import { request } from './client.js';

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

/** @param {{unreadOnly?: boolean}} [filters] */
export function listBellNotifications(filters = {}) {
  const params = new URLSearchParams();
  if (filters.unreadOnly) params.set('unread', 'true');
  const query = params.toString();
  return request(`/notifications/bell${query ? `?${query}` : ''}`);
}

export function markNotificationRead(id) {
  return request(`/notifications/bell/${id}/read`, { method: 'POST', body: {} });
}
