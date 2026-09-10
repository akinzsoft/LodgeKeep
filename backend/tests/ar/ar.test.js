'use strict';

/**
 * HTTP-level tests for Accounts Receivable — PLAN.md Phase 4,
 * PRODUCT_REQUIREMENTS.md §3.9, TESTING.md AR-1/AR-2/AR-3.
 *
 * Covers: company profile CRUD + RBAC, AR account create/duplicate,
 * credit-limit enforcement in both `block`/`flag_only` modes, a manager's
 * override of a block-mode rejection (and a non-manager's rejected attempt
 * to do the same), the multi-folio checkout behaviour an AR-billed folio
 * enables, the direct-payment-against-an-AR-folio rejection, invoice
 * generation (AR-1) and its double-invoicing guard, invoice void, the
 * cannot-void-an-invoiced-line guard, manual payment recording/application/
 * void, the ageing report (AR-2) via the real HTTP endpoint, the full RBAC
 * matrix, and cross-tenant 404s.
 *
 * ── AMBIENT TAX (the same discipline `tests/cashiering/cashiering.test.js`
 * documents) ─────────────────────────────────────────────────────────────
 *
 * `tests/helpers/fixtures.js` seeds a real 7.5% VAT tax on `ctx.a`'s own
 * property, applying to every `room_charge`. Tests that specifically prove
 * a `room_charge` posted through `POST .../charges` is checked against the
 * credit limit TAX-INCLUSIVE use that real endpoint. Every other test that
 * only needs a folio balance of a KNOWN, exact amount uses `POST
 * .../adjustments` instead (no tax recomputation — `cashiering/service.js`'s
 * own `postAdjustment` header), so its expected numbers do not depend on
 * ambient tax configuration, the same "seed via adjustment, not a real
 * charge" discipline `cashiering.test.js`'s own `seedAdjustment` helper
 * already established.
 *
 * `ctx.a.arAccounts[0]`/`ctx.a.companyProfiles[0]` are the fixture's own
 * seeded account (credit_limit '1000.00', currency NGN, enforcement_mode
 * 'block', at `properties[0]`) — not reused here since most tests need
 * their own fresh account with a specific credit limit/enforcement mode.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Accounts Receivable (PLAN.md Phase 4)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2027-02-01' });
  });

  function tokenFor({ tenant = ctx.a, userId, propertyId } = {}) {
    return signAccessToken({
      aud: 'staff',
      sub: String(userId ?? tenant.users[0].id),
      tenant_id: String(tenant.id),
      property_id: String(propertyId ?? tenant.properties[0].id),
    });
  }

  async function grantRoleToUser({ tenant, userIndex, propertyIndex = 0, role }) {
    const propertyId = tenant.properties[propertyIndex].id;
    const userId = tenant.users[userIndex].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) {
      await t.trx('user_property_access').where({ id: existing.id }).update({ role });
      return userId;
    }
    await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: propertyId, user_id: userId, role });
    return userId;
  }

  let idemCounter = 0;
  function idemKey() {
    idemCounter += 1;
    return `ar-test-key-${idemCounter}`;
  }

  let reservationCounter = 0;
  async function createReservation(tenant = ctx.a) {
    reservationCounter += 1;
    const [id] = await t.trx('reservations').insert({
      tenant_id: tenant.id,
      property_id: tenant.properties[0].id,
      guest_id: tenant.guests[0].id,
      room_type_id: tenant.roomTypes[0].id,
      rate_code_id: tenant.rateCodes[0].id,
      arrival_date: '2027-02-01',
      departure_date: '2027-02-03',
      adults: 1,
      children: 0,
      status: 'confirmed',
      confirmation_number: `AR-TEST-${reservationCounter}-${tenant.slug}`.toUpperCase().slice(0, 26),
    });
    // `checkIn` -> `ensurePrimaryFolio` (cashiering/service.js) reads the
    // reservation's own `reservation_daily_rates` row for its currency —
    // real bookings get this from `createReservation`'s own snapshot; a
    // raw fixture insert like this one needs to seed it directly.
    await t.trx('reservation_daily_rates').insert({
      tenant_id: tenant.id,
      property_id: tenant.properties[0].id,
      reservation_id: id,
      stay_date: '2027-02-01',
      rate: '100.00',
      currency: 'NGN',
    });
    return id;
  }

  let folioCounter = 0;
  async function openFolio(tenant = ctx.a, { reservationId, companyProfileId } = {}) {
    folioCounter += 1;
    const resolvedReservationId = reservationId ?? (await createReservation(tenant));
    const [id] = await t.trx('folios').insert({
      tenant_id: tenant.id,
      property_id: tenant.properties[0].id,
      reservation_id: resolvedReservationId,
      folio_number: `ARF${String(folioCounter).padStart(6, '0')}`,
      status: 'open',
      balance: '0.00',
      currency: 'NGN',
      billed_to: companyProfileId ? 'Company (test)' : 'Guest',
      company_profile_id: companyProfileId ?? null,
    });
    return t.trx('folios').where({ id }).first();
  }

  /** Tax-free — see file header. Every test that only needs an exact folio balance uses this, never `/charges`. */
  function postAdjustment(folioId, amount, { reason = 'Test fixture charge', overrideCreditLimit, overrideReason } = {}) {
    return t.request
      .post(`/api/v1/cashiering/folios/${folioId}/adjustments`)
      .set('Authorization', `Bearer ${tokenFor()}`)
      .set('Idempotency-Key', idemKey())
      .send({ description: 'Test charge', amount, reason, override_credit_limit: overrideCreditLimit, override_reason: overrideReason });
  }

  async function createCompany({ tenant = ctx.a, name = `Test Co ${Date.now()}-${Math.random()}` } = {}) {
    const res = await t.request
      .post('/api/v1/companies')
      .set('Authorization', `Bearer ${tokenFor({ tenant })}`)
      .send({ name, billing_email: 'billing@testco.example.com' });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  async function createAccount({ tenant = ctx.a, companyProfileId, creditLimit = '100.00', enforcementMode = 'block' } = {}) {
    const res = await t.request
      .post('/api/v1/ar/accounts')
      .set('Authorization', `Bearer ${tokenFor({ tenant })}`)
      .set('Idempotency-Key', idemKey())
      .send({ company_profile_id: companyProfileId, currency: 'NGN', credit_limit: creditLimit, enforcement_mode: enforcementMode });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  async function generateInvoiceFor(accountId) {
    return t.request
      .post(`/api/v1/ar/accounts/${accountId}/invoices`)
      .set('Authorization', `Bearer ${tokenFor()}`)
      .set('Idempotency-Key', idemKey())
      .send({});
  }

  function recordPayment(accountId, body) {
    return t.request
      .post(`/api/v1/ar/accounts/${accountId}/payments`)
      .set('Authorization', `Bearer ${tokenFor()}`)
      .set('Idempotency-Key', idemKey())
      .send(body);
  }

  // ====================================================================
  // Company profiles — CRUD + RBAC
  // ====================================================================

  describe('company profiles', () => {
    it('a manager creates, lists, gets, updates and archives a company profile', async () => {
      const created = await createCompany({ name: 'CRUD Co' });
      expect(created.name).toBe('CRUD Co');
      expect(created.status).toBe('active');

      const listRes = await t.request.get('/api/v1/companies').set('Authorization', `Bearer ${tokenFor()}`);
      expect(listRes.status).toBe(200);
      expect(listRes.body.data.some((c) => String(c.id) === String(created.id))).toBe(true);

      const getRes = await t.request.get(`/api/v1/companies/${created.id}`).set('Authorization', `Bearer ${tokenFor()}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.name).toBe('CRUD Co');

      const updateRes = await t.request
        .patch(`/api/v1/companies/${created.id}`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ name: 'CRUD Co Renamed', payment_terms_days: 45 });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.name).toBe('CRUD Co Renamed');
      expect(updateRes.body.data.payment_terms_days).toBe(45);

      const archiveRes = await t.request.post(`/api/v1/companies/${created.id}/archive`).set('Authorization', `Bearer ${tokenFor()}`);
      expect(archiveRes.status).toBe(200);
      expect(archiveRes.body.data.status).toBe('archived');
    });

    it('the update allowlist ignores an unlisted field (tenant_id) in the request body', async () => {
      const created = await createCompany({ name: 'Allowlist Co' });
      const res = await t.request
        .patch(`/api/v1/companies/${created.id}`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ name: 'Allowlist Co Updated', tenant_id: ctx.b.id, id: '999999' });
      expect(res.status).toBe(200);
      expect(String(res.body.data.tenant_id)).toBe(String(ctx.a.id));
      expect(String(res.body.data.id)).toBe(String(created.id));
    });

    it('a front_desk user (ar.view only) can read but not create a company profile', async () => {
      const userId = await grantRoleToUser({ tenant: ctx.a, userIndex: 0, propertyIndex: 0, role: 'front_desk' });
      const res = await t.request.post('/api/v1/companies').set('Authorization', `Bearer ${tokenFor({ userId })}`).send({ name: 'Should not be created' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION');

      const readRes = await t.request.get('/api/v1/companies').set('Authorization', `Bearer ${tokenFor({ userId })}`);
      expect(readRes.status).toBe(200);

      await grantRoleToUser({ tenant: ctx.a, userIndex: 0, propertyIndex: 0, role: 'manager' });
    });
  });

  // ====================================================================
  // AR accounts — create/duplicate/RBAC
  // ====================================================================

  describe('AR accounts', () => {
    it('creates an account and rejects a duplicate (same company, same property)', async () => {
      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id });
      expect(account.currency).toBe('NGN');
      expect(account.current_balance).toBe('0.00');

      const dupeRes = await t.request
        .post('/api/v1/ar/accounts')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ company_profile_id: company.id, currency: 'NGN', credit_limit: '50.00' });
      expect(dupeRes.status).toBe(409);
      expect(dupeRes.body.error.code).toBe('CONFLICT_DUPLICATE_ENTRY');
    });

    it('a manager updates an account (credit limit, enforcement mode) via the allowlist', async () => {
      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id, creditLimit: '100.00' });
      const res = await t.request
        .patch(`/api/v1/ar/accounts/${account.id}`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ credit_limit: '250.00', enforcement_mode: 'flag_only', company_profile_id: '999999' });
      expect(res.status).toBe(200);
      expect(res.body.data.credit_limit).toBe('250.00');
      expect(res.body.data.enforcement_mode).toBe('flag_only');
      expect(String(res.body.data.company_profile_id)).toBe(String(company.id));
    });

    it('a cashier (ar.view only) can read accounts but not create one', async () => {
      const userId = await grantRoleToUser({ tenant: ctx.a, userIndex: 1, propertyIndex: 0, role: 'cashier' });
      const readRes = await t.request.get('/api/v1/ar/accounts').set('Authorization', `Bearer ${tokenFor({ userId })}`);
      expect(readRes.status).toBe(200);

      const createRes = await t.request
        .post('/api/v1/ar/accounts')
        .set('Authorization', `Bearer ${tokenFor({ userId })}`)
        .set('Idempotency-Key', idemKey())
        .send({ company_profile_id: ctx.a.companyProfiles[0].id, currency: 'NGN' });
      expect(createRes.status).toBe(403);
      expect(createRes.body.error.code).toBe('FORBIDDEN_PERMISSION');
    });
  });

  // ====================================================================
  // Credit-limit enforcement — TESTING.md AR-3
  // ====================================================================

  describe('credit-limit enforcement (TESTING.md AR-3)', () => {
    it('a real, tax-bearing room charge under the limit succeeds and updates the account balance tax-inclusively', async () => {
      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id, creditLimit: '200.00', enforcementMode: 'block' });
      const folio = await openFolio(ctx.a, { companyProfileId: company.id });

      const res = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/charges`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ type: 'room_charge', description: 'Under limit', amount: '80.00' });
      expect(res.status).toBe(201);

      const postedLines = await t.trx('folio_line_items').where({ folio_id: folio.id }).whereNull('voided_at');
      const expectedBalance = postedLines.reduce((sum, line) => (Number(sum) + Number(line.amount)).toFixed(2), '0.00');
      expect(Number(expectedBalance)).toBeGreaterThan(80); // the ambient VAT genuinely added a tax line

      const updatedAccount = await t.trx('ar_accounts').where({ id: account.id }).first();
      expect(updatedAccount.current_balance).toBe(expectedBalance);
      expect(Boolean(updatedAccount.is_over_limit)).toBe(false);
    });

    it('a real room charge that would exceed the limit tax-inclusively is rejected with 422 BUSINESS_RULE_CREDIT_LIMIT_EXCEEDED, and nothing is posted', async () => {
      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id, creditLimit: '50.00', enforcementMode: 'block' });
      const folio = await openFolio(ctx.a, { companyProfileId: company.id });

      // 75.00 alone is already over the 50.00 limit — true regardless of
      // whatever tax adds on top, so this proves rejection without needing
      // to know the exact tax-inclusive total.
      const res = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/charges`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ type: 'room_charge', description: 'Over limit', amount: '75.00' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_CREDIT_LIMIT_EXCEEDED');

      const updatedAccount = await t.trx('ar_accounts').where({ id: account.id }).first();
      expect(updatedAccount.current_balance).toBe('0.00');

      const lines = await t.trx('folio_line_items').where({ folio_id: folio.id });
      expect(lines.length).toBe(0);
    });

    it('an adjustment under the limit succeeds', async () => {
      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id, creditLimit: '200.00', enforcementMode: 'block' });
      const folio = await openFolio(ctx.a, { companyProfileId: company.id });

      const res = await postAdjustment(folio.id, '80.00');
      expect(res.status).toBe(201);

      const updatedAccount = await t.trx('ar_accounts').where({ id: account.id }).first();
      expect(updatedAccount.current_balance).toBe('80.00');
      expect(Boolean(updatedAccount.is_over_limit)).toBe(false);
    });

    it('the identical over-limit scenario in flag_only mode succeeds and sets is_over_limit', async () => {
      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id, creditLimit: '50.00', enforcementMode: 'flag_only' });
      const folio = await openFolio(ctx.a, { companyProfileId: company.id });

      const res = await postAdjustment(folio.id, '75.00');
      expect(res.status).toBe(201);

      const updatedAccount = await t.trx('ar_accounts').where({ id: account.id }).first();
      expect(updatedAccount.current_balance).toBe('75.00');
      expect(Boolean(updatedAccount.is_over_limit)).toBe(true);
    });

    it('a manager override succeeds despite block mode, requires a reason, and is recorded in audit_log', async () => {
      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id, creditLimit: '50.00', enforcementMode: 'block' });
      const folio = await openFolio(ctx.a, { companyProfileId: company.id });

      const noReasonRes = await postAdjustment(folio.id, '75.00', { overrideCreditLimit: true });
      expect(noReasonRes.status).toBe(400);
      expect(noReasonRes.body.error.code).toBe('VALIDATION_MISSING_FIELD');

      const res = await postAdjustment(folio.id, '75.00', { overrideCreditLimit: true, overrideReason: 'VIP guest, manager approved.' });
      expect(res.status).toBe(201);

      const updatedAccount = await t.trx('ar_accounts').where({ id: account.id }).first();
      expect(updatedAccount.current_balance).toBe('75.00');

      const auditRow = await t.trx('audit_log').where({ entity_type: 'folio_line_items', action: 'post_adjustment' }).orderBy('id', 'desc').first();
      expect(auditRow).toBeDefined();
    });

    it('a non-manager (cashiering.void_line only, no ar.manage) attempting an override is rejected — a permission error, not a business-rule error', async () => {
      const company = await createCompany();
      await createAccount({ companyProfileId: company.id, creditLimit: '50.00', enforcementMode: 'block' });
      const folio = await openFolio(ctx.a, { companyProfileId: company.id });

      const userId = await grantRoleToUser({ tenant: ctx.a, userIndex: 1, propertyIndex: 0, role: 'cashier' });
      const res = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/adjustments`)
        .set('Authorization', `Bearer ${tokenFor({ userId })}`)
        .set('Idempotency-Key', idemKey())
        .send({ description: 'Unauthorized override attempt', amount: '75.00', reason: 'Trying to bypass.', override_credit_limit: true, override_reason: 'Trying.' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION');
      expect(res.body.error.details.permission).toBe('ar.manage');
    });
  });

  // ====================================================================
  // Billing a folio to a company
  // ====================================================================

  describe('billing a folio to a company account', () => {
    it('requires ar.manage, not cashiering.void_line/.post_charge', async () => {
      const company = await createCompany();
      await createAccount({ companyProfileId: company.id });
      const folio = await openFolio(ctx.a);

      const userId = await grantRoleToUser({ tenant: ctx.a, userIndex: 1, propertyIndex: 0, role: 'cashier' });
      const res = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/bill-to-account`)
        .set('Authorization', `Bearer ${tokenFor({ userId })}`)
        .set('Idempotency-Key', idemKey())
        .send({ company_profile_id: company.id });
      expect(res.status).toBe(403);
    });

    it('rejects billing to a company with no active AR account', async () => {
      const company = await createCompany();
      const folio = await openFolio(ctx.a);

      const res = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/bill-to-account`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ company_profile_id: company.id });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_AR_ACCOUNT_NOT_FOUND');
    });

    it('a manager bills a folio to an existing account, and billed_to reflects the company name', async () => {
      const company = await createCompany({ name: 'Billing Reflects Co' });
      await createAccount({ companyProfileId: company.id });
      const folio = await openFolio(ctx.a);

      const res = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/bill-to-account`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ company_profile_id: company.id });
      expect(res.status).toBe(200);
      expect(String(res.body.data.company_profile_id)).toBe(String(company.id));
      expect(res.body.data.billed_to).toBe('Billing Reflects Co');
    });

    it('un-billing is rejected once a charge on the folio has been invoiced', async () => {
      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id, creditLimit: '500.00' });
      const folio = await openFolio(ctx.a, { companyProfileId: company.id });
      await postAdjustment(folio.id, '40.00');
      await generateInvoiceFor(account.id);

      const res = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/bill-to-account`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ company_profile_id: null });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_CANNOT_UNBILL_INVOICED_FOLIO');
    });
  });

  // ====================================================================
  // Direct payment against an AR-billed folio — rejected
  // ====================================================================

  describe('direct payment against an AR-billed folio', () => {
    it('rejects a direct cash payment', async () => {
      const company = await createCompany();
      await createAccount({ companyProfileId: company.id, creditLimit: '500.00' });
      const folio = await openFolio(ctx.a, { companyProfileId: company.id });

      const res = await t.request
        .post(`/api/v1/cashiering/folios/${folio.id}/payments/cash`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ amount: '10.00', currency: 'NGN' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_CANNOT_PAY_AR_BILLED_FOLIO_DIRECTLY');
    });
  });

  // ====================================================================
  // Cannot void an invoiced line
  // ====================================================================

  describe('cannot void an already-invoiced line', () => {
    it('rejects voiding a line that has been invoiced', async () => {
      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id, creditLimit: '500.00' });
      const folio = await openFolio(ctx.a, { companyProfileId: company.id });
      const chargeRes = await postAdjustment(folio.id, '30.00');
      await generateInvoiceFor(account.id);

      const res = await t.request
        .post(`/api/v1/cashiering/line-items/${chargeRes.body.data.id}/void`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'Trying to void an invoiced line' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_CANNOT_VOID_INVOICED_LINE');
    });
  });

  // ====================================================================
  // Invoice generation — TESTING.md AR-1
  // ====================================================================

  describe('invoice generation (TESTING.md AR-1)', () => {
    it('generates an invoice whose total matches the source folio lines exactly', async () => {
      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id, creditLimit: '500.00' });
      const folio = await openFolio(ctx.a, { companyProfileId: company.id });
      await postAdjustment(folio.id, '30.00');
      await postAdjustment(folio.id, '15.00');

      const eligibleLines = await t.trx('folio_line_items').where({ folio_id: folio.id }).whereNull('voided_at');
      const expectedTotal = eligibleLines.reduce((sum, line) => (Number(sum) + Number(line.amount)).toFixed(2), '0.00');

      const res = await generateInvoiceFor(account.id);
      expect(res.status).toBe(201);
      expect(res.body.data.total_amount).toBe(expectedTotal);
      expect(res.body.data.status).toBe('issued');
      expect(res.body.data.invoice_number).toMatch(/^INV-/);

      const lines = await t.trx('ar_invoice_lines').where({ ar_invoice_id: res.body.data.id });
      expect(lines.length).toBe(2);
    });

    it('does not double-invoice — a second immediate call has nothing left to invoice', async () => {
      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id, creditLimit: '500.00' });
      const folio = await openFolio(ctx.a, { companyProfileId: company.id });
      await postAdjustment(folio.id, '20.00');

      const first = await generateInvoiceFor(account.id);
      expect(first.status).toBe(201);

      const second = await generateInvoiceFor(account.id);
      expect(second.status).toBe(422);
      expect(second.body.error.code).toBe('VALIDATION_NO_CHARGES_TO_INVOICE');

      const invoiceLineRows = await t.trx('ar_invoice_lines').where({ ar_invoice_id: first.body.data.id });
      expect(invoiceLineRows.length).toBe(1);
    });

    it('rejects generating an invoice with no charges at all', async () => {
      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id });
      const res = await generateInvoiceFor(account.id);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_NO_CHARGES_TO_INVOICE');
    });
  });

  // ====================================================================
  // Invoice void
  // ====================================================================

  describe('invoice void', () => {
    it('voids an invoice, reverses its payment applications, and refuses to void twice', async () => {
      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id, creditLimit: '500.00' });
      const folio = await openFolio(ctx.a, { companyProfileId: company.id });
      await postAdjustment(folio.id, '50.00');
      const invoiceRes = await generateInvoiceFor(account.id);
      const invoiceId = invoiceRes.body.data.id;

      const paymentRes = await recordPayment(account.id, {
        amount: '50.00',
        currency: 'NGN',
        method_label: 'wire',
        received_at: '2027-02-01',
        applications: [{ invoice_id: invoiceId, amount: '50.00' }],
      });
      expect(paymentRes.status).toBe(201);
      const afterPayInvoice = await t.trx('ar_invoices').where({ id: invoiceId }).first();
      expect(afterPayInvoice.status).toBe('paid');

      const voidRes = await t.request
        .post(`/api/v1/ar/invoices/${invoiceId}/void`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'Billed in error' });
      expect(voidRes.status).toBe(200);
      expect(voidRes.body.data.status).toBe('void');

      const applications = await t.trx('ar_payment_applications').where({ ar_invoice_id: invoiceId });
      expect(applications.every((a) => a.voided_at !== null)).toBe(true);

      const secondVoid = await t.request
        .post(`/api/v1/ar/invoices/${invoiceId}/void`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'Second attempt' });
      expect(secondVoid.status).toBe(409);
      expect(secondVoid.body.error.code).toBe('CONFLICT_INVOICE_ALREADY_VOID');
    });

    it('voiding an invoice does not release its lines back to un-invoiced', async () => {
      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id, creditLimit: '500.00' });
      const folio = await openFolio(ctx.a, { companyProfileId: company.id });
      await postAdjustment(folio.id, '20.00');
      const invoiceRes = await generateInvoiceFor(account.id);
      await t.request
        .post(`/api/v1/ar/invoices/${invoiceRes.body.data.id}/void`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'Voiding to test re-invoicing guard' });

      const secondInvoice = await generateInvoiceFor(account.id);
      expect(secondInvoice.status).toBe(422);
      expect(secondInvoice.body.error.code).toBe('VALIDATION_NO_CHARGES_TO_INVOICE');
    });
  });

  // ====================================================================
  // Payments — manual recording, application, void
  // ====================================================================

  describe('payment recording and application', () => {
    it('recording a payment reduces the account balance immediately, before any application', async () => {
      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id, creditLimit: '500.00' });
      const folio = await openFolio(ctx.a, { companyProfileId: company.id });
      await postAdjustment(folio.id, '100.00');

      const paymentRes = await recordPayment(account.id, { amount: '40.00', currency: 'NGN', method_label: 'cheque', received_at: '2027-02-01' });
      expect(paymentRes.status).toBe(201);

      const updatedAccount = await t.trx('ar_accounts').where({ id: account.id }).first();
      expect(updatedAccount.current_balance).toBe('60.00');
    });

    it('applying a payment moves an invoice through partially_paid to paid', async () => {
      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id, creditLimit: '500.00' });
      const folio = await openFolio(ctx.a, { companyProfileId: company.id });
      await postAdjustment(folio.id, '100.00');
      const invoiceRes = await generateInvoiceFor(account.id);
      const invoiceId = invoiceRes.body.data.id;

      const paymentRes = await recordPayment(account.id, {
        amount: '40.00',
        currency: 'NGN',
        method_label: 'wire',
        received_at: '2027-02-01',
        applications: [{ invoice_id: invoiceId, amount: '40.00' }],
      });
      expect(paymentRes.status).toBe(201);
      let invoice = await t.trx('ar_invoices').where({ id: invoiceId }).first();
      expect(invoice.status).toBe('partially_paid');

      const secondPaymentRes = await recordPayment(account.id, { amount: '60.00', currency: 'NGN', method_label: 'wire', received_at: '2027-02-02' });
      const applyRes = await t.request
        .post(`/api/v1/ar/payments/${secondPaymentRes.body.data.id}/apply`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ applications: [{ invoice_id: invoiceId, amount: '60.00' }] });
      expect(applyRes.status).toBe(200);
      invoice = await t.trx('ar_invoices').where({ id: invoiceId }).first();
      expect(invoice.status).toBe('paid');
    });

    it('applies the same payment to the same invoice twice, in separate calls (a payment need not be fully applied at once)', async () => {
      // Regression test: ar_payment_applications used to carry a
      // UNIQUE(tenant_id, property_id, ar_payment_id, ar_invoice_id)
      // constraint that made this normal, expected sequence throw a raw
      // ER_DUP_ENTRY (surfacing as a 500) instead of succeeding — fixed by
      // removing that constraint (see the migration's own header for why
      // applying the same pair more than once is legitimate, not a duplicate).
      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id, creditLimit: '500.00' });
      const folio = await openFolio(ctx.a, { companyProfileId: company.id });
      await postAdjustment(folio.id, '100.00');
      const invoiceRes = await generateInvoiceFor(account.id);
      const invoiceId = invoiceRes.body.data.id;

      const paymentRes = await recordPayment(account.id, {
        amount: '100.00',
        currency: 'NGN',
        method_label: 'wire',
        received_at: '2027-02-01',
        applications: [{ invoice_id: invoiceId, amount: '30.00' }],
      });
      expect(paymentRes.status).toBe(201);

      const secondApplyRes = await t.request
        .post(`/api/v1/ar/payments/${paymentRes.body.data.id}/apply`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ applications: [{ invoice_id: invoiceId, amount: '70.00' }] });
      expect(secondApplyRes.status).toBe(200);

      const invoice = await t.trx('ar_invoices').where({ id: invoiceId }).first();
      expect(invoice.status).toBe('paid');
      const applications = await t.trx('ar_payment_applications').where({ ar_payment_id: paymentRes.body.data.id, ar_invoice_id: invoiceId });
      expect(applications).toHaveLength(2);
    });

    it('re-applies a payment to an invoice after an earlier application to the same pair was voided', async () => {
      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id, creditLimit: '500.00' });
      const folio = await openFolio(ctx.a, { companyProfileId: company.id });
      await postAdjustment(folio.id, '50.00');
      const invoiceRes = await generateInvoiceFor(account.id);
      const invoiceId = invoiceRes.body.data.id;

      const paymentRes = await recordPayment(account.id, {
        amount: '50.00',
        currency: 'NGN',
        method_label: 'wire',
        received_at: '2027-02-01',
        applications: [{ invoice_id: invoiceId, amount: '50.00' }],
      });
      const paymentId = paymentRes.body.data.id;

      const voidRes = await t.request
        .post(`/api/v1/ar/payments/${paymentId}/void`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'misallocated — wrong invoice, correcting' });
      expect(voidRes.status).toBe(200);

      const secondPaymentRes = await recordPayment(account.id, {
        amount: '50.00',
        currency: 'NGN',
        method_label: 'wire',
        received_at: '2027-02-02',
        applications: [{ invoice_id: invoiceId, amount: '50.00' }],
      });
      expect(secondPaymentRes.status).toBe(201);
      const invoice = await t.trx('ar_invoices').where({ id: invoiceId }).first();
      expect(invoice.status).toBe('paid');
    });

    it('rejects applying more than an invoice has remaining', async () => {
      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id, creditLimit: '500.00' });
      const folio = await openFolio(ctx.a, { companyProfileId: company.id });
      await postAdjustment(folio.id, '20.00');
      const invoiceRes = await generateInvoiceFor(account.id);

      const res = await recordPayment(account.id, {
        amount: '100.00',
        currency: 'NGN',
        method_label: 'wire',
        received_at: '2027-02-01',
        applications: [{ invoice_id: invoiceRes.body.data.id, amount: '100.00' }],
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_PAYMENT_APPLICATION_EXCEEDS_INVOICE');
    });

    it('rejects over-applying beyond the payment amount itself', async () => {
      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id, creditLimit: '500.00' });
      const folio = await openFolio(ctx.a, { companyProfileId: company.id });
      await postAdjustment(folio.id, '200.00');
      const invoiceRes = await generateInvoiceFor(account.id);

      const res = await recordPayment(account.id, {
        amount: '50.00',
        currency: 'NGN',
        method_label: 'wire',
        received_at: '2027-02-01',
        applications: [{ invoice_id: invoiceRes.body.data.id, amount: '60.00' }],
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_PAYMENT_APPLICATION_EXCEEDS_PAYMENT');
    });

    it('voiding a payment reverses its applications and restores the account balance', async () => {
      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id, creditLimit: '500.00' });
      const folio = await openFolio(ctx.a, { companyProfileId: company.id });
      await postAdjustment(folio.id, '90.00');
      const invoiceRes = await generateInvoiceFor(account.id);
      const paymentRes = await recordPayment(account.id, {
        amount: '90.00',
        currency: 'NGN',
        method_label: 'wire',
        received_at: '2027-02-01',
        applications: [{ invoice_id: invoiceRes.body.data.id, amount: '90.00' }],
      });

      let updatedAccount = await t.trx('ar_accounts').where({ id: account.id }).first();
      expect(updatedAccount.current_balance).toBe('0.00');

      const voidRes = await t.request
        .post(`/api/v1/ar/payments/${paymentRes.body.data.id}/void`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'Payment reversed by bank' });
      expect(voidRes.status).toBe(200);

      updatedAccount = await t.trx('ar_accounts').where({ id: account.id }).first();
      expect(updatedAccount.current_balance).toBe('90.00');

      const invoice = await t.trx('ar_invoices').where({ id: invoiceRes.body.data.id }).first();
      expect(invoice.status).toBe('issued');

      const secondVoid = await t.request
        .post(`/api/v1/ar/payments/${paymentRes.body.data.id}/void`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'Second attempt' });
      expect(secondVoid.status).toBe(409);
      expect(secondVoid.body.error.code).toBe('CONFLICT_PAYMENT_ALREADY_VOID');
    });
  });

  // ====================================================================
  // Checkout — multi-folio, AR-aware
  // ====================================================================

  describe('checkout with an AR-billed folio', () => {
    async function checkInReservation(tenant, reservationId) {
      const [roomId] = await t.trx('rooms').insert({
        tenant_id: tenant.id,
        property_id: tenant.properties[0].id,
        room_type_id: tenant.roomTypes[0].id,
        room_number: `AR-CO-${reservationId}`,
        front_desk_status: 'vacant',
        housekeeping_reported_status: 'clean',
      });
      const res = await t.request
        .post(`/api/v1/reservations/${reservationId}/check-in`)
        .set('Authorization', `Bearer ${tokenFor({ tenant })}`)
        .set('Idempotency-Key', idemKey())
        .send({ room_id: String(roomId) });
      expect(res.status).toBe(200);
    }

    it('an AR-billed split folio may carry a nonzero balance at checkout, while the guest folio must still be zero', async () => {
      const reservationId = await createReservation(ctx.a);
      await checkInReservation(ctx.a, reservationId);
      const primaryFolio = await t.trx('folios').where({ reservation_id: reservationId }).first();
      await t.trx('folios').where({ id: primaryFolio.id }).update({ balance: '0.00' });

      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id, creditLimit: '500.00' });
      const splitFolio = await openFolio(ctx.a, { reservationId, companyProfileId: company.id });
      await postAdjustment(splitFolio.id, '65.00');

      const checkoutRes = await t.request
        .post(`/api/v1/reservations/${reservationId}/check-out`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({});
      expect(checkoutRes.status).toBe(200);
      expect(checkoutRes.body.data.status).toBe('checked_out');
      expect(checkoutRes.body.meta.arAccountOverLimit).toBe(false);

      const closedSplitFolio = await t.trx('folios').where({ id: splitFolio.id }).first();
      expect(closedSplitFolio.status).toBe('closed');
      expect(closedSplitFolio.balance).toBe('65.00');

      const finalAccount = await t.trx('ar_accounts').where({ id: account.id }).first();
      expect(finalAccount.current_balance).toBe('65.00');
    });

    it('still blocks checkout when a non-AR folio has a nonzero balance, even with a settled AR-billed split folio present', async () => {
      const reservationId = await createReservation(ctx.a);
      await checkInReservation(ctx.a, reservationId);
      const primaryFolio = await t.trx('folios').where({ reservation_id: reservationId }).first();
      await t.trx('folios').where({ id: primaryFolio.id }).update({ balance: '25.00' });

      const company = await createCompany();
      await createAccount({ companyProfileId: company.id, creditLimit: '500.00' });
      await openFolio(ctx.a, { reservationId, companyProfileId: company.id });

      const res = await t.request
        .post(`/api/v1/reservations/${reservationId}/check-out`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({});
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_FOLIO_BALANCE_OWING');
      expect(String(res.body.error.details.folioId)).toBe(String(primaryFolio.id));

      await t.trx('folios').where({ id: primaryFolio.id }).update({ balance: '0.00' });
    });

    it('flags an over-limit AR account in the checkout response meta, without blocking checkout', async () => {
      const reservationId = await createReservation(ctx.a);
      await checkInReservation(ctx.a, reservationId);
      const primaryFolio = await t.trx('folios').where({ reservation_id: reservationId }).first();
      await t.trx('folios').where({ id: primaryFolio.id }).update({ balance: '0.00' });

      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id, creditLimit: '10.00', enforcementMode: 'flag_only' });
      const splitFolio = await openFolio(ctx.a, { reservationId, companyProfileId: company.id });
      await postAdjustment(splitFolio.id, '50.00');
      const overLimitAccount = await t.trx('ar_accounts').where({ id: account.id }).first();
      expect(Boolean(overLimitAccount.is_over_limit)).toBe(true);

      const checkoutRes = await t.request
        .post(`/api/v1/reservations/${reservationId}/check-out`)
        .set('Authorization', `Bearer ${tokenFor()}`)
        .set('Idempotency-Key', idemKey())
        .send({});
      expect(checkoutRes.status).toBe(200);
      expect(checkoutRes.body.meta.arAccountOverLimit).toBe(true);
    });
  });

  // ====================================================================
  // Ageing report — TESTING.md AR-2
  // ====================================================================

  describe('ageing report (TESTING.md AR-2)', () => {
    it('buckets a real invoice correctly relative to the property business date', async () => {
      const company = await createCompany({ name: 'Ageing Co' });
      const account = await createAccount({ companyProfileId: company.id, creditLimit: '500.00' });
      const folio = await openFolio(ctx.a, { companyProfileId: company.id });
      await postAdjustment(folio.id, '35.00');
      const invoiceRes = await generateInvoiceFor(account.id);

      // Business date is 2027-02-01 (set in beforeAll); push the invoice's
      // due_at back 40 days so it lands in the 31-60 day bucket.
      await t.trx('ar_invoices').where({ id: invoiceRes.body.data.id }).update({ due_at: '2026-12-23' });

      const res = await t.request.get('/api/v1/ar/ageing').set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(200);
      const row = res.body.data.find((r) => String(r.arAccountId) === String(account.id));
      expect(row).toBeDefined();
      expect(row.bucket_31_60).toBe('35.00');
      expect(row.current).toBe('0.00');
    });

    it('exports the ageing report as CSV', async () => {
      const res = await t.request.get('/api/v1/ar/ageing?format=csv').set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
    });
  });

  // ====================================================================
  // RBAC matrix
  // ====================================================================

  describe('RBAC matrix', () => {
    it('housekeeping holds neither ar.view nor ar.manage', async () => {
      const userId = await grantRoleToUser({ tenant: ctx.a, userIndex: 1, propertyIndex: 0, role: 'housekeeping' });
      const res = await t.request.get('/api/v1/ar/accounts').set('Authorization', `Bearer ${tokenFor({ userId })}`);
      expect(res.status).toBe(403);
    });

    it('a front_desk user (ar.view) can see the ageing report but not generate an invoice', async () => {
      const company = await createCompany();
      const account = await createAccount({ companyProfileId: company.id, creditLimit: '500.00' });
      const folio = await openFolio(ctx.a, { companyProfileId: company.id });
      await postAdjustment(folio.id, '10.00');

      const userId = await grantRoleToUser({ tenant: ctx.a, userIndex: 1, propertyIndex: 0, role: 'front_desk' });
      const viewRes = await t.request.get('/api/v1/ar/ageing').set('Authorization', `Bearer ${tokenFor({ userId })}`);
      expect(viewRes.status).toBe(200);

      const generateRes = await t.request
        .post(`/api/v1/ar/accounts/${account.id}/invoices`)
        .set('Authorization', `Bearer ${tokenFor({ userId })}`)
        .set('Idempotency-Key', idemKey())
        .send({});
      expect(generateRes.status).toBe(403);
    });
  });

  // ====================================================================
  // Cross-tenant 404s
  // ====================================================================

  describe('cross-tenant isolation', () => {
    it('an AR account belonging to another tenant is a 404, not a 403', async () => {
      const res = await t.request.get(`/api/v1/ar/accounts/${ctx.b.arAccounts[0].id}`).set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(404);
    });

    it('an invoice belonging to another tenant is a 404', async () => {
      const res = await t.request.get(`/api/v1/ar/invoices/${ctx.b.arInvoices[0].id}`).set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(404);
    });

    it('a company profile belonging to another tenant is a 404', async () => {
      const res = await t.request.get(`/api/v1/companies/${ctx.b.companyProfiles[0].id}`).set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(404);
    });
  });
});
