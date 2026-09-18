'use strict';

/**
 * Self-service "My Profile" screen (user-requested) — `users` had no
 * `phone` column at all; every existing name field (`first_name`/
 * `last_name`) was write-once (set at seed or invitation-acceptance,
 * `acceptInvitation`) and never updatable. Mirrors `guests.phone` exactly
 * (`VARCHAR(30)`, nullable, no format validation anywhere in this codebase
 * for a phone number — `20260906091000_create_guests.js`'s own precedent).
 * Additive only; every existing row is unaffected.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('users', (table) => {
    table.string('phone', 30).nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('phone');
  });
};
