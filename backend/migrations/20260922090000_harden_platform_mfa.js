'use strict';

// Additive: existing enrolled secrets are preserved. Old pending JWTs have no
// matching hash and must restart login. The account row serializes issuance,
// token consumption and TOTP replay checks across all backend instances.
exports.up = async function up(knex) {
  await knex.schema.alterTable('platform_users', (table) => {
    table.string('mfa_pending_token_hash', 64).nullable();
    table.bigInteger('mfa_last_used_step').unsigned().nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('platform_users', (table) => {
    table.dropColumn('mfa_pending_token_hash');
    table.dropColumn('mfa_last_used_step');
  });
};
