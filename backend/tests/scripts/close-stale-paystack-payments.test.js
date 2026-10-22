'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { db } = require('../helpers/db');
const { seedRaceTenant } = require('../helpers/folio-race');
const { run, REASON } = require('../../scripts/close-stale-paystack-payments');

const SCRIPT = path.join(__dirname, '../../scripts/close-stale-paystack-payments.js');
const HOUR = 60 * 60 * 1000;
const BEFORE = new Date(Date.now() - 24 * HOUR);
const BEFORE_ARG = `--before=${BEFORE.toISOString()}`;

describe('scripts/close-stale-paystack-payments', () => {
  let seed;
  let folioId;
  let outletId;
  let terminalId;
  let userId;
  let counter = 0;
  const orderIds = [];
  const intentIds = [];

  beforeAll(async () => {
    seed = await seedRaceTenant({ label: 'stale' });
    ({ folioId } = await seed.addReservationWithFolio());
    const suffix = `${Date.now().toString(36)}`;
    [userId] = await db()('users').insert({ tenant_id: seed.tenantId, email: `stale-${suffix}@example.com`, password_hash: 'x', first_name: 'S', last_name: 'T' });
    [outletId] = await db()('pos_outlets').insert({ tenant_id: seed.tenantId, property_id: seed.propertyId, code: `ST-${suffix}`.slice(0, 20), name: 'Stale bar', type: 'bar' });
    [terminalId] = await db()('pos_terminals').insert({ tenant_id: seed.tenantId, property_id: seed.propertyId, outlet_id: outletId, device_ref: `STT-${suffix}` });
  });

  afterAll(async () => {
    const where = { tenant_id: seed.tenantId };
    await db()('supermarket_sale_intents').where(where).delete();
    await db()('payments').where(where).whereNotNull('parent_payment_id').delete();
    await db()('payments').where(where).delete();
    await db()('pos_orders').where(where).delete();
    await db()('pos_terminals').where(where).delete();
    await db()('pos_outlets').where(where).delete();
    await db()('pos_order_items').where(where).delete();
    await db()('users').where({ id: userId }).delete();
    await seed.cleanup();
  });

  async function payment(overrides = {}) {
    counter += 1;
    const [id] = await db()('payments').insert({
      tenant_id: seed.tenantId,
      property_id: seed.propertyId,
      folio_id: folioId,
      idempotency_key: `stale-${counter}-${Date.now()}`,
      provider: 'paystack',
      provider_reference: `stale-ref-${counter}-${Date.now()}`,
      amount: '100.00',
      currency: 'NGN',
      status: 'PENDING',
      created_at: new Date(BEFORE.getTime() - 60 * HOUR), // 84h old: mid-way through "3d", so second truncation or test duration cannot flip it
      ...overrides,
    });
    return id;
  }
  const row = (id) => db()('payments').where({ id }).first();
  const auditRows = (id) => db()('audit_log').where({ entity_type: 'payments', entity_id: String(id), action: 'gateway_payment_closed' });
  const lines = async (argv, opts = {}) => {
    const out = [];
    const code = await run({ db: db(), argv, out: (l) => out.push(l), ...opts });
    return { code, text: out.join('\n') };
  };

  async function posOrder() {
    const [id] = await db()('pos_orders').insert({ tenant_id: seed.tenantId, property_id: seed.propertyId, outlet_id: outletId, terminal_id: terminalId, opened_by_user_id: userId, table_label: `T${counter}` });
    orderIds.push(id);
    return id;
  }

  // Only this tenant's rows are ever asserted on, but the script scans the whole table, so other committed
  // stale rows in the shared test schema would be closed too; the tests below only look at their own rows.

  describe('guards', () => {
    it('refuses without --before and changes nothing', async () => {
      const id = await payment();
      const { code, text } = await lines(['--apply']);
      expect(code).toBe(2);
      expect(text).toMatch(/--before=<ISO timestamp> is required/);
      expect((await row(id)).status).toBe('PENDING');
    });

    it('refuses an invalid or future --before, and unknown options', async () => {
      expect((await lines(['--before=banana'])).code).toBe(2);
      expect((await lines([`--before=${new Date(Date.now() + HOUR).toISOString()}`])).code).toBe(2);
      expect((await lines([BEFORE_ARG, '--force'])).code).toBe(2);
    });
  });

  describe('dry run', () => {
    it('lists the candidates (id, tenant, target, status, amount, age, tab) and writes nothing', async () => {
      const orderId = await posOrder();
      const id = await payment({ settlement_target: 'pos_register', pos_order_id: orderId });
      const { code, text } = await lines([BEFORE_ARG]);
      expect(code).toBe(0);
      expect(text).toMatch(new RegExp(`payment ${id} tenant=${seed.tenantId} target=pos_register status=PENDING amount=100.00 age=3d pos_order=${orderId}`));
      expect(text).toMatch(/Dry run: nothing was changed/);
      expect((await row(id)).status).toBe('PENDING');
      expect(await auditRows(id)).toHaveLength(0);
    });
  });

  describe('--apply', () => {
    it('closes only matching rows, with one audit row each, and lists the tabs to void', async () => {
      const orderId = await posOrder();
      const stalePending = await payment({ settlement_target: 'pos_register', pos_order_id: orderId });
      const staleInitiated = await payment({ status: 'INITIATED' });
      const afterCutoff = await payment({ created_at: new Date(BEFORE.getTime() + HOUR) });
      const captured = await payment({ status: 'CAPTURED', captured_at: new Date() });
      const cash = await payment({ provider: 'cash' });
      const refund = await payment({ parent_payment_id: captured, status: 'PENDING' });

      const { code, text } = await lines([BEFORE_ARG, '--apply']);
      expect(code).toBe(0);

      for (const id of [stalePending, staleInitiated]) {
        const after = await row(id);
        expect(after.status).toBe('CANCELLED');
        expect(after.failure_reason).toBe(REASON);
        const audit = await auditRows(id);
        expect(audit).toHaveLength(1);
        expect(audit[0].before_state.status).toBe(id === stalePending ? 'PENDING' : 'INITIATED');
        expect(audit[0].after_state.status).toBe('CANCELLED');
      }
      expect((await row(afterCutoff)).status).toBe('PENDING');
      expect((await row(captured)).status).toBe('CAPTURED');
      expect((await row(cash)).status).toBe('PENDING');
      expect((await row(refund)).status).toBe('PENDING');
      for (const id of [afterCutoff, captured, cash, refund]) expect(await auditRows(id)).toHaveLength(0);
      expect(text).toMatch(new RegExp(`POS tabs with a closed payment.*\\b${orderId}\\b`));
    });

    it('is a no-op the second time', async () => {
      const id = await payment();
      await lines([BEFORE_ARG, '--apply']);
      await lines([BEFORE_ARG, '--apply']);
      expect(await auditRows(id)).toHaveLength(1);
    });

    it('does not overwrite a payment that is captured mid-run', async () => {
      const id = await payment();
      const { text } = await lines([BEFORE_ARG, '--apply'], {
        hooks: {
          beforeClose: async (p) => {
            if (String(p.id) === String(id)) await db()('payments').where({ id }).update({ status: 'CAPTURED', captured_at: new Date() });
          },
        },
      });
      expect((await row(id)).status).toBe('CAPTURED');
      expect(await auditRows(id)).toHaveLength(0);
      expect(text).toMatch(new RegExp(`payment ${id}: no longer INITIATED/PENDING`));
    });

    it('rolls the status change back when anything fails in the same transaction (status and audit are one unit)', async () => {
      const id = await payment();
      const { code, text } = await lines([BEFORE_ARG, '--apply'], {
        hooks: {
          afterUpdate: async (p) => {
            if (String(p.id) === String(id)) throw new Error('boom');
          },
        },
      });
      expect(code).toBe(1);
      expect(text).toMatch(new RegExp(`payment ${id}: FAILED, rolled back`));
      expect((await row(id)).status).toBe('PENDING');
      expect(await auditRows(id)).toHaveLength(0);
    });
  });

  describe('supermarket online sales', () => {
    async function intentFor(paymentId, expiresAt, status = 'pending') {
      const [id] = await db()('supermarket_sale_intents').insert({
        tenant_id: seed.tenantId,
        property_id: seed.propertyId,
        outlet_id: outletId,
        payment_id: paymentId,
        created_by_user_id: userId,
        tender: 'online',
        status,
        lines_json: '[]',
        expected_total: '100.00',
        currency: 'NGN',
        expires_at: expiresAt,
      });
      intentIds.push(id);
      return id;
    }

    it('leaves a payment whose intent is still inside its window alone', async () => {
      const id = await payment({ settlement_target: 'supermarket_sale', created_at: new Date(BEFORE.getTime() - HOUR) });
      const intentId = await intentFor(id, new Date(Date.now() + 10 * 60 * 1000));
      const { text } = await lines([BEFORE_ARG, '--apply']);
      expect(text).toMatch(new RegExp(`payment ${id} .*-> exclude`));
      expect((await row(id)).status).toBe('PENDING');
      expect((await db()('supermarket_sale_intents').where({ id: intentId }).first()).status).toBe('pending');
    });

    it('cancels an expired pending intent together with its payment, through cancelLocally', async () => {
      const id = await payment({ settlement_target: 'supermarket_sale' });
      const intentId = await intentFor(id, new Date(Date.now() - HOUR));
      await lines([BEFORE_ARG, '--apply']);
      expect((await row(id)).status).toBe('CANCELLED');
      const intent = await db()('supermarket_sale_intents').where({ id: intentId }).first();
      expect(intent.status).toBe('cancelled');
      expect(intent.cancel_reason).toBe(REASON);
    });
  });

  describe('portal bookings', () => {
    it('releases the tentative hold through abandonUnpaidBooking', async () => {
      const { reservationId, folioId: portalFolio } = await seed.addReservationWithFolio({ status: 'tentative' });
      const id = await payment({ folio_id: portalFolio });
      await lines([BEFORE_ARG, '--apply']);
      expect((await row(id)).status).toBe('CANCELLED');
      const reservation = await db()('reservations').where({ id: reservationId }).first();
      expect(reservation.status).toBe('cancelled');
      expect((await db()('folios').where({ id: portalFolio }).first()).status).toBe('closed');
    });
  });

  describe('as the container runs it', () => {
    function runLikeTheContainer(args) {
      return spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 30000 });
    }

    it('refuses without --before in a fresh process', () => {
      const result = runLikeTheContainer([]);
      expect(result.status).toBe(2);
      expect(result.stdout).toMatch(/--before/);
    });

    it('closes through the real entry point (fresh process, knex from src/db)', async () => {
      const id = await payment();
      const dry = runLikeTheContainer([BEFORE_ARG]);
      expect(dry.stderr).not.toMatch(/is not a function|Failed/);
      expect(dry.status).toBe(0);
      expect((await row(id)).status).toBe('PENDING');
      const applied = runLikeTheContainer([BEFORE_ARG, '--apply']);
      expect(applied.status).toBe(0);
      expect((await row(id)).status).toBe('CANCELLED');
      expect(await auditRows(id)).toHaveLength(1);
    });
  });
});
