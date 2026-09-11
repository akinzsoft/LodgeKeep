'use strict';

/**
 * `pos_room_charge_otps` — PLAN.md Phase 6's QR self-ordering gap closure.
 * The second factor confirmed with the user for a guest charging a QR
 * order to their room: a one-time code, emailed to the room's CURRENT
 * IN-HOUSE RESERVATION'S OWN registered email — never a guest-typed
 * contact — at the point of charge. Mirrors `mfa_login_codes` (Phase 5's
 * real emailed MFA code) shape-for-shape: a random 6-digit code, SHA-256
 * hashed (single-use and short-lived, same reasoning as that table — no
 * long-term re-display need the way a QR token has), a 10-minute expiry,
 * a 5-attempt cap.
 *
 * Scope: PROPERTY_SCOPED — unlike `mfa_login_codes` (TENANT_SCOPED, issued
 * before any active property is chosen), this OTP is always issued
 * against one specific property's own in-house reservation and POS order,
 * both already known at issuance time.
 *
 * `code_hash` deliberately carries NO unique constraint, matching
 * `mfa_login_codes`' own precedent exactly: a 6-digit code has only
 * 1,000,000 possible values, so two different guest orders coincidentally
 * being issued the same code is an ordinary coincidence, not a bug — a
 * global uniqueness constraint would turn that coincidence into a failed
 * INSERT. Lookups are scoped to `(tenant_id, property_id, pos_order_id)`
 * instead, always resolving to "the current outstanding code for this
 * order."
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

function timestamps(knex, table) {
  table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  table
    .datetime('updated_at')
    .notNullable()
    .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

exports.up = async function up(knex) {
  await knex.schema.createTable('pos_room_charge_otps', (table) => {
    table.comment(
      'A one-time code emailed to the in-house reservations own registered email, authorizing a guest QR order charge-to-room settlement. Scope: PROPERTY_SCOPED. Mirrors mfa_login_codes.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('reservation_id').unsigned().notNullable();
    table.bigInteger('pos_order_id').unsigned().notNullable();

    table.string('code_hash', 64).notNullable().comment('SHA-256 hex — no UNIQUE constraint, see migration header.');
    table.integer('attempts').unsigned().notNullable().defaultTo(0);
    table.datetime('expires_at').notNullable();
    table.datetime('used_at').nullable();

    timestamps(knex, table);

    table
      .foreign(['tenant_id', 'property_id'], 'pos_room_charge_otps_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'reservation_id'], 'pos_otps_tenant_id_property_id_reservation_id_fk')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('reservations')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'pos_order_id'], 'pos_otps_tenant_id_property_id_order_id_fk')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_orders')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'reservation_id'], 'pos_otps_tenant_id_property_id_reservation_id_idx');
    table.index(['tenant_id', 'property_id', 'pos_order_id'], 'pos_otps_tenant_id_property_id_order_id_idx');
    table.index(['expires_at'], 'pos_room_charge_otps_expires_at_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pos_room_charge_otps');
};
