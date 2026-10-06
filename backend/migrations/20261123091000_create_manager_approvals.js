'use strict';

/**
 * Manager approvals — one row per approval a manager gave with their PIN
 * (`src/modules/approvals`). The row IS the single-use approval token: the
 * till holds a random 32-byte value, only its SHA-256 lands here, and the
 * gated action claims it with one conditional UPDATE (`used_at IS NULL`,
 * `expires_at` in the future, and the same action, requesting user and
 * target) inside the action's own transaction — so a rolled-back action
 * leaves it claimable again within its short life, and two requests carrying
 * the same token can never both succeed.
 *
 * It is also the durable record of who approved what: the approver, the
 * person at the till, the action, the record it was for, and the reason.
 * The gated action's own audit row is deliberately left untouched (the hotel
 * payment golden suite snapshots those rows byte for byte); a separate
 * audit_log row (entity_type `manager_approvals`) marks the moment of use.
 *
 * PROPERTY_SCOPED: an approval is given at one property, for an action there.
 * `target_id` is nullable for an action whose record does not exist yet (a
 * supermarket sale confirmed past recorded stock).
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('manager_approvals', (table) => {
    table.comment('Single-use manager approvals (PIN), bound to action, requesting user and target. PROPERTY_SCOPED. See src/modules/approvals.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.string('token_hash', 64).notNullable().comment('SHA-256 hex of the opaque approval token. The token itself is never stored.');
    table.string('action', 64).notNullable().comment('Registry key, e.g. pos.void_settlement (src/modules/approvals/registry.js).');
    table.string('target_type', 64).nullable();
    table.bigInteger('target_id').unsigned().nullable().comment('The record approved for. NULL only for actions whose record does not exist yet.');
    table.bigInteger('requested_by_user_id').unsigned().notNullable().comment('The person at the till who may use this approval.');
    table.bigInteger('approver_user_id').unsigned().notNullable().comment('The manager who entered their PIN.');
    table.string('reason', 500).notNullable();
    table.datetime('expires_at', { precision: 3 }).notNullable();
    table.datetime('used_at', { precision: 3 }).nullable().comment('Set by the conditional UPDATE that consumes the approval. NULL means unused.');
    table.datetime('created_at', { precision: 3 }).notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));

    table.unique(['token_hash'], { indexName: 'manager_approvals_token_hash_unique' });
    table.index(['tenant_id', 'property_id', 'approver_user_id', 'created_at'], 'manager_approvals_approver_index');
    table
      .foreign(['tenant_id', 'property_id'], 'manager_approvals_property_fk')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'requested_by_user_id'], 'manager_approvals_requester_fk')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'approver_user_id'], 'manager_approvals_approver_fk')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('manager_approvals');
};
