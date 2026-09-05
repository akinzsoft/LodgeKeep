import { request, requestBlob } from './client.js';

/**
 * PLAN.md Phase 3's reporting module. Same shape as `reservations.js`:
 * plain exported functions, each a thin wrapper over `request()`.
 *
 * The `?format=csv` variants call `request` directly with a raw response
 * expectation — `request()` unwraps the `{data,meta,error}` JSON envelope,
 * which a CSV body does not have, so CSV downloads use `fetch` through the
 * same base URL construction rather than `request()`. Kept in this file
 * (not `client.js`) since it is a reporting-specific need, not a generic
 * client capability every module needs.
 */

export function getOccupancyReport({ dateFrom, dateTo }) {
  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
  return request(`/reports/occupancy?${params}`);
}

export function getRevenueReport({ dateFrom, dateTo }) {
  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
  return request(`/reports/revenue?${params}`);
}

export function getHousekeepingSummary(businessDate) {
  const params = new URLSearchParams({ business_date: businessDate });
  return request(`/reports/housekeeping?${params}`);
}

export function getOversoldRoomTypes(businessDate) {
  const params = new URLSearchParams({ business_date: businessDate });
  return request(`/reports/oversold?${params}`);
}

/** Fetches the occupancy report as a CSV blob, with the exact same filters as the on-screen query (PRODUCT_REQUIREMENTS.md §3.11: exports must reflect the applied filters, never an unfiltered dump). */
export function getOccupancyReportCsv({ dateFrom, dateTo }) {
  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, format: 'csv' });
  return requestBlob(`/reports/occupancy?${params}`);
}

export function getRevenueReportCsv({ dateFrom, dateTo }) {
  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, format: 'csv' });
  return requestBlob(`/reports/revenue?${params}`);
}
