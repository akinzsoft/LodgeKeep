'use strict';

/**
 * Manager approval PINs — the credential behind the shared manager-approval
 * mechanism (`src/modules/approvals`). A security fix (release-blocking):
 * settlement voids, refunds and stock overrides were gated only by the
 * logged-in `pos.manage`/`supermarket.manage` permission, so a shared or
 * unattended manager session made them too easy to approve.
 *
 * One row per user who has set a PIN: a separate 6-digit code a manager types
 * at the till to approve one action. It is never a login credential, so a
 * PIN read over a shoulder cannot sign anyone in.
 *
 * Its own table, not columns on `users`: the bcrypt hash stays out of every
 * user listing query, and the failed-attempt counter needs a row to lock
 * (`SELECT ... FOR UPDATE`) so simultaneous wrong guesses cannot slip past the
 * 5-in-15-minutes lock. TENANT_SCOPED like `mfa_login_codes`: a person has one
 * PIN wherever they work; whether they may approve is checked per property at
 * the moment of approval.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('approval_pins', (table) => {
    // No apostrophes in a TABLE comment: knex interpolates it raw into the DDL.
    table.comment('Manager approval PINs (bcrypt). Approvals only, never login. TENANT_SCOPED, one row per user. See src/modules/approvals.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('user_id').unsigned().notNullable();
    table.string('pin_hash', 100).notNullable().comment('bcrypt hash of the 6-digit PIN. The PIN itself is never stored.');
    table.datetime('set_at', { precision: 3 }).notNullable();
    table.integer('failed_count').unsigned().notNullable().defaultTo(0).comment('Wrong PINs in the current window.');
    table.datetime('failure_window_started_at', { precision: 3 }).nullable().comment('Start of the 15-minute window failed_count counts within.');
    table.datetime('locked_until', { precision: 3 }).nullable().comment('Set after 5 wrong PINs in the window; approvals by this user are refused until then.');
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));

    table.unique(['tenant_id', 'user_id'], { indexName: 'approval_pins_tenant_user_unique' });
    table
      .foreign(['tenant_id', 'user_id'], 'approval_pins_user_fk')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('approval_pins');
};
