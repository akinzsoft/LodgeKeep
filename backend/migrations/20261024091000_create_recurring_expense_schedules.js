'use strict';

/**
 * `recurring_expense_schedules` — a template for a recurring operating
 * expense (rent, salaries, a subscription) that a daily job
 * (`src/jobs/expense-schedules.js`) auto-posts as a real `expenses` row
 * once it's due, fully automatically, with no manual approval gate —
 * mirroring `door-access-retention.js`'s own periodic-sweep shape.
 *
 * `frequency` + exactly one of `day_of_month`/`day_of_week` (enforced in
 * the service layer, not a CHECK constraint — money/config validation
 * lives in JS throughout this codebase) describes the cadence:
 * `weekly` needs `day_of_week` (0=Sunday..6=Saturday); `monthly`/
 * `quarterly`/`annually` need `day_of_month` (1-31, clamped to the target
 * month's real length — Feb 29 in a non-leap year, day 31 in a 30-day
 * month — the same clamping technique `billing/service.js`'s `addOneMonth`
 * already established for subscription renewal dates).
 *
 * `next_due_date` is the sweep's own comparison target, advanced by
 * `src/modules/expenses/recurrence.js`'s `postDueExpenseForSchedule` each
 * time it fires — always from the schedule's own prior `next_due_date`,
 * never from "today," so a schedule that missed several ticks (the
 * property was offline, the sweep failed) posts exactly once when next
 * examined and re-anchors to the correct future cadence, rather than
 * either skipping the missed period or bulk-catching-up several expenses
 * at once.
 *
 * No DELETE path — pause/resume only (`status`), the same void-never-delete
 * discipline applied to configuration: a hard delete would also immediately
 * hit the RESTRICT FK from `expenses.recurring_expense_schedule_id` the
 * first time this schedule ever fired.
 *
 * Scope: PROPERTY_SCOPED.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('recurring_expense_schedules', (table) => {
    table.comment('A recurring operating-expense template, auto-posted as a real expense by the daily expense-schedules sweep. Scope: PROPERTY_SCOPED. Pause/resume only, never deleted.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('expense_category_id').unsigned().notNullable();
    table.string('description', 255).notNullable();
    table.string('payee', 160).nullable();
    table.decimal('amount', 12, 2).notNullable();
    table.string('currency', 3).notNullable();
    table.enu('payment_method', ['cash', 'card', 'bank_transfer', 'cheque', 'other']).notNullable();
    table.enu('frequency', ['weekly', 'monthly', 'quarterly', 'annually']).notNullable();
    table.integer('day_of_month').unsigned().nullable().comment('1-31, required for monthly/quarterly/annually, null for weekly. Clamped to the target month\'s real length when posting.');
    table.integer('day_of_week').unsigned().nullable().comment('0 (Sunday) - 6 (Saturday), required for weekly, null otherwise.');
    table.date('next_due_date').notNullable().comment('Compared against each property\'s own current_business_date by the daily sweep (ARCHITECTURE.md §6 - never wall clock).');
    table.date('last_posted_date').nullable().comment('Observability only - never read by the sweep\'s own due-date logic.');
    table.enu('status', ['active', 'paused']).notNullable().defaultTo('active');
    table.bigInteger('created_by_user_id').unsigned().nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));

    // Parent key for expenses.recurring_expense_schedule_id.
    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'recurring_expense_schedules_tenant_id_property_id_id_unique' });
    table
      .foreign(['tenant_id', 'property_id'], 'recur_exp_sched_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'expense_category_id'], 'recur_exp_sched_expense_category_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('expense_categories')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'created_by_user_id'], 'recur_exp_sched_created_by_user_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table.index(['tenant_id', 'property_id', 'status', 'next_due_date'], 'recur_exp_sched_status_next_due_date_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTable('recurring_expense_schedules');
};
