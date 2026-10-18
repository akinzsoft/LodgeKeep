'use strict';

/**
 * Committed (not rolled back) folio fixtures for the real-connection concurrency suites
 * (`folio-balance-concurrency`, `refund-concurrency`). The shared-transaction harness cannot prove a lock, because two
 * "concurrent" requests there are two savepoints on one MySQL session. Each call seeds its own tenant, so suites never
 * touch each other's rows; `cleanup()` removes everything it created.
 */

const { db } = require('./db');
const { workerContext } = require('../../src/modules/tenancy');

let counter = 0;

async function seedRaceTenant({ label = 'race' } = {}) {
  counter += 1;
  const suffix = `${Date.now().toString(36)}${counter}${Math.floor(Math.random() * 100)}`;
  const [tenantId] = await db()('tenants').insert({ name: `Folio ${label}`, slug: `folio-${label}-${suffix}`.slice(0, 60), status: 'active' });
  const [propertyId] = await db()('properties').insert({
    tenant_id: tenantId,
    slug: `folio-${label}-p-${suffix}`.slice(0, 60),
    name: `Folio ${label} property`,
    timezone: 'Africa/Lagos',
    base_currency: 'NGN',
    current_business_date: '2027-06-01',
  });
  const [guestId] = await db()('guests').insert({ tenant_id: tenantId, first_name: 'Race', last_name: 'Guest', email: `race-${suffix}@example.com` });
  const [roomTypeId] = await db()('room_types').insert({ tenant_id: tenantId, property_id: propertyId, code: 'RC', name: 'Race', default_occupancy: 2, base_rate: '100.00' });
  const [rateCodeId] = await db()('rate_codes').insert({ tenant_id: tenantId, property_id: propertyId, code: 'BAR', base_rate: '100.00', currency: 'NGN', valid_from: '2026-01-01' });
  const [roomId] = await db()('rooms').insert({ tenant_id: tenantId, property_id: propertyId, room_number: '1', floor: '1', room_type_id: roomTypeId });
  const context = workerContext({ tenantId: String(tenantId), propertyId: String(propertyId) });

  let folioCount = 0;
  /** A reservation (checked in, with its room assigned) and an open folio on it. */
  async function addReservationWithFolio({ status = 'checked_in', balance = '0.00' } = {}) {
    folioCount += 1;
    const [reservationId] = await db()('reservations').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      guest_id: guestId,
      room_type_id: roomTypeId,
      rate_code_id: rateCodeId,
      arrival_date: '2027-06-01',
      departure_date: '2027-06-03',
      adults: 1,
      children: 0,
      status,
      confirmation_number: `RC${suffix}${folioCount}`.toUpperCase().slice(0, 26),
    });
    if (status === 'checked_in') {
      await db()('reservation_rooms').insert({ tenant_id: tenantId, property_id: propertyId, reservation_id: reservationId, room_id: roomId, effective_from: new Date(), effective_to: null });
    }
    const folioId = await addFolio({ reservationId, balance });
    return { reservationId, folioId };
  }
  async function addFolio({ reservationId, balance = '0.00' }) {
    folioCount += 1;
    const [folioId] = await db()('folios').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      reservation_id: reservationId,
      folio_number: `RF${suffix}${folioCount}`.toUpperCase().slice(0, 26),
      status: 'open',
      balance,
      currency: 'NGN',
    });
    return folioId;
  }

  /** A company with an AR account at the property (block mode, generous limit). */
  async function addArAccount() {
    const [companyId] = await db()('company_profiles').insert({ tenant_id: tenantId, name: `Co ${suffix}`, type: 'company', billing_email: `ar-${suffix}@example.com`, payment_terms_days: 30 });
    const [accountId] = await db()('ar_accounts').insert({ tenant_id: tenantId, property_id: propertyId, company_profile_id: companyId, credit_limit: '100000.00', currency: 'NGN', enforcement_mode: 'block' });
    return { companyId, accountId };
  }

  async function cleanup() {
    const where = { tenant_id: tenantId };
    await db()('audit_log').where(where).delete();
    await db()('outbox_events').where(where).delete();
    await db()('in_app_notifications').where(where).delete();
    await db()('idempotency_keys').where(where).delete();
    await db()('ar_payment_applications').where(where).delete();
    await db()('ar_payments').where(where).delete();
    await db()('ar_invoice_lines').where(where).delete();
    await db()('ar_invoices').where(where).delete();
    await db()('ar_invoice_sequences').where(where).delete();
    await db()('payment_terminal_details').whereIn('payment_id', db()('payments').where(where).select('id')).delete();
    await db()('folio_line_items').where(where).delete();
    await db()('payments').where(where).whereNotNull('parent_payment_id').delete();
    await db()('payments').where(where).delete();
    await db()('folios').where(where).delete();
    await db()('ar_accounts').where(where).delete();
    await db()('company_profiles').where(where).delete();
    await db()('reservation_rooms').where(where).delete();
    await db()('reservation_daily_rates').where(where).delete();
    await db()('reservations').where(where).delete();
    await db()('rooms').where(where).delete();
    await db()('rate_codes').where(where).delete();
    await db()('room_types').where(where).delete();
    await db()('guests').where(where).delete();
    await db()('properties').where(where).delete();
    await db()('tenants').where({ id: tenantId }).delete();
  }

  return { tenantId, propertyId, guestId, roomId, context, addReservationWithFolio, addFolio, addArAccount, cleanup };
}

/** What `folios.balance` must equal: the exact sum of the folio's non-voided lines. */
async function ledgerBalance(folioId) {
  const { sumMoney } = require('../../src/shared/money');
  const lines = await db()('folio_line_items').where({ folio_id: folioId }).whereNull('voided_at');
  return sumMoney(lines.map((line) => line.amount));
}

async function storedBalance(folioId) {
  return (await db()('folios').where({ id: folioId }).first()).balance;
}

/** A deferred promise, to hold one transaction open at an exact point while another runs to completion. */
function gate() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

module.exports = { seedRaceTenant, ledgerBalance, storedBalance, gate };
