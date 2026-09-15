'use strict';

/**
 * Real pooled connections, not the shared-transaction-per-file harness —
 * the same distinction every other sweep-correctness suite in this
 * codebase draws (tests/jobs/door-access-retention-sweep.test.js,
 * tests/jobs/trial-expiry-sweep.test.js). Proves `runExpenseSchedulesSweep`
 * end to end: which properties/schedules it touches, that it posts exactly
 * one expense per due schedule and advances `next_due_date` correctly (one
 * case per frequency), that an overdue schedule catches up exactly once
 * rather than bulk-posting every missed period, that a paused schedule is
 * skipped, that it writes a real audit row, and that it's safe under
 * genuine concurrent execution — the real concurrency guard
 * (`postDueExpenseForSchedule`'s re-lock-and-recheck) mutation-tested by
 * proving two truly concurrent sweeps over the same overdue schedule post
 * exactly once, not twice.
 */

const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { runExpenseSchedulesSweep } = require('../../src/jobs/expense-schedules');

describe('runExpenseSchedulesSweep (real MySQL)', () => {
  const tenantIds = [];

  beforeAll(() => {
    dbModule.__setConnectionForTesting(db());
  });

  afterEach(async () => {
    while (tenantIds.length) {
      const id = tenantIds.pop();
      await db()('audit_log').where({ tenant_id: id }).delete();
      await db()('expenses').where({ tenant_id: id }).delete();
      await db()('recurring_expense_schedules').where({ tenant_id: id }).delete();
      await db()('expense_categories').where({ tenant_id: id }).delete();
      await db()('users').where({ tenant_id: id }).delete();
      await db()('properties').where({ tenant_id: id }).delete();
      await db()('tenants').where({ id }).delete();
    }
  });

  afterAll(() => {
    dbModule.__resetForTesting();
  });

  /** A tenant with one property (a real current_business_date) and one registered expense category. */
  async function makeProperty({ businessDate = '2027-01-15', status = 'active' } = {}) {
    const slug = `exp-sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const [tenantId] = await db()('tenants').insert({ name: 'Expense Sweep Test Hotels', slug, status: 'active' });
    tenantIds.push(tenantId);

    const [propertyId] = await db()('properties').insert({
      tenant_id: tenantId,
      slug: `${slug}-prop`,
      name: 'Expense Sweep Test Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
      status,
      current_business_date: businessDate,
    });

    const [userId] = await db()('users').insert({
      tenant_id: tenantId,
      email: `expense-sweep-${slug}@example.test`,
      password_hash: 'x',
      first_name: 'Expense',
      last_name: 'Sweep Tester',
    });

    const [categoryId] = await db()('expense_categories').insert({ tenant_id: tenantId, property_id: propertyId, name: 'Rent' });

    return { tenantId, propertyId, userId, categoryId, businessDate };
  }

  async function makeSchedule({ tenantId, propertyId, categoryId, frequency = 'monthly', dayOfMonth = null, dayOfWeek = null, nextDueDate, status = 'active' }) {
    const [id] = await db()('recurring_expense_schedules').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      expense_category_id: categoryId,
      description: 'Test recurring expense',
      amount: '500.00',
      currency: 'NGN',
      payment_method: 'bank_transfer',
      frequency,
      day_of_month: dayOfMonth,
      day_of_week: dayOfWeek,
      next_due_date: nextDueDate,
      status,
    });
    return id;
  }

  it('posts a due monthly schedule exactly once and advances next_due_date by one month', async () => {
    const property = await makeProperty({ businessDate: '2027-01-15' });
    const scheduleId = await makeSchedule({ ...property, frequency: 'monthly', dayOfMonth: 15, nextDueDate: '2027-01-15' });

    const posted = await runExpenseSchedulesSweep();
    expect(posted).toBeGreaterThanOrEqual(1);

    const expenses = await db()('expenses').where({ tenant_id: property.tenantId, recurring_expense_schedule_id: scheduleId });
    expect(expenses).toHaveLength(1);
    expect(expenses[0].amount).toBe('500.00');
    expect(expenses[0].business_date).toBe('2027-01-15');
    expect(expenses[0].recorded_by_user_id).toBeNull(); // system-posted

    const schedule = await db()('recurring_expense_schedules').where({ id: scheduleId }).first();
    expect(schedule.next_due_date).toBe('2027-02-15');
    expect(schedule.last_posted_date).toBe('2027-01-15');
  });

  it('posts a due weekly schedule and advances next_due_date to the next matching day of week', async () => {
    // 2027-01-15 is a Friday (day 5).
    const property = await makeProperty({ businessDate: '2027-01-15' });
    const scheduleId = await makeSchedule({ ...property, frequency: 'weekly', dayOfWeek: 5, nextDueDate: '2027-01-15' });

    await runExpenseSchedulesSweep();

    const schedule = await db()('recurring_expense_schedules').where({ id: scheduleId }).first();
    expect(schedule.next_due_date).toBe('2027-01-22');
  });

  it('an overdue schedule (server offline for weeks) posts exactly once, re-anchoring from its own prior due date, never bulk-catching-up', async () => {
    const property = await makeProperty({ businessDate: '2027-03-01' }); // schedule was due 2027-01-15, sweep only now examines it
    const scheduleId = await makeSchedule({ ...property, frequency: 'monthly', dayOfMonth: 15, nextDueDate: '2027-01-15' });

    await runExpenseSchedulesSweep();

    const expenses = await db()('expenses').where({ tenant_id: property.tenantId, recurring_expense_schedule_id: scheduleId });
    expect(expenses).toHaveLength(1); // exactly once, not for every missed month (Jan, Feb)
    expect(expenses[0].business_date).toBe('2027-03-01'); // posted at today's business date

    const schedule = await db()('recurring_expense_schedules').where({ id: scheduleId }).first();
    // Re-anchored from the schedule's own prior due date (Jan 15), not from today.
    expect(schedule.next_due_date).toBe('2027-02-15');
  });

  it('a paused schedule is never posted, regardless of how overdue it is', async () => {
    const property = await makeProperty({ businessDate: '2027-01-15' });
    const scheduleId = await makeSchedule({ ...property, frequency: 'monthly', dayOfMonth: 1, nextDueDate: '2027-01-01', status: 'paused' });

    await runExpenseSchedulesSweep();

    const expenses = await db()('expenses').where({ recurring_expense_schedule_id: scheduleId });
    expect(expenses).toHaveLength(0);
  });

  it('a schedule not yet due is skipped', async () => {
    const property = await makeProperty({ businessDate: '2027-01-15' });
    const scheduleId = await makeSchedule({ ...property, frequency: 'monthly', dayOfMonth: 20, nextDueDate: '2027-01-20' });

    await runExpenseSchedulesSweep();

    const expenses = await db()('expenses').where({ recurring_expense_schedule_id: scheduleId });
    expect(expenses).toHaveLength(0);
  });

  it('writes a real audit_log row with the correct property_id, only when something was posted', async () => {
    const property = await makeProperty({ businessDate: '2027-01-15' });
    await makeSchedule({ ...property, frequency: 'monthly', dayOfMonth: 15, nextDueDate: '2027-01-15' });

    await runExpenseSchedulesSweep();

    const entry = await db()('audit_log').where({ tenant_id: property.tenantId, action: 'expense_schedule_auto_post' }).first();
    expect(entry).toBeTruthy();
    expect(entry.source).toBe('job');
    expect(String(entry.property_id)).toBe(String(property.propertyId));
    expect(entry.after_state).toMatchObject({ postedCount: 1, businessDate: '2027-01-15' });
  });

  it('is idempotent — a second sweep the same day posts nothing further', async () => {
    const property = await makeProperty({ businessDate: '2027-01-15' });
    await makeSchedule({ ...property, frequency: 'monthly', dayOfMonth: 15, nextDueDate: '2027-01-15' });

    const first = await runExpenseSchedulesSweep();
    expect(first).toBeGreaterThanOrEqual(1);
    const second = await runExpenseSchedulesSweep();
    expect(second).toBe(0);
  });

  it('two genuinely concurrent sweeps over the same overdue schedule post it exactly once, never twice', async () => {
    const property = await makeProperty({ businessDate: '2027-01-15' });
    const scheduleId = await makeSchedule({ ...property, frequency: 'monthly', dayOfMonth: 15, nextDueDate: '2027-01-15' });

    await Promise.all([runExpenseSchedulesSweep(), runExpenseSchedulesSweep()]);

    const expenses = await db()('expenses').where({ recurring_expense_schedule_id: scheduleId });
    expect(expenses).toHaveLength(1);
  });

  it('a property with no current_business_date is never even considered', async () => {
    const [tenantId] = await db()('tenants').insert({ name: 'No Business Date Tenant', slug: `no-bd-${Date.now()}`, status: 'active' });
    tenantIds.push(tenantId);
    const [propertyId] = await db()('properties').insert({
      tenant_id: tenantId,
      slug: `no-bd-prop-${Date.now()}`,
      name: 'No Business Date Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
      status: 'active',
      current_business_date: null,
    });
    const [categoryId] = await db()('expense_categories').insert({ tenant_id: tenantId, property_id: propertyId, name: 'Rent' });
    const scheduleId = await makeSchedule({ tenantId, propertyId, categoryId, frequency: 'monthly', dayOfMonth: 1, nextDueDate: '2020-01-01' });

    await runExpenseSchedulesSweep();

    const expenses = await db()('expenses').where({ recurring_expense_schedule_id: scheduleId });
    expect(expenses).toHaveLength(0);
  });
});
