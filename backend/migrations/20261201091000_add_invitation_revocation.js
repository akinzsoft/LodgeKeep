'use strict';

/**
 * Pending invitations can now be revoked (Setup → Users → Pending invitations →
 * Delete). A revoked invitation keeps its row so the history survives; the
 * status stays derived like the others (pending | accepted | expired | revoked).
 * `revoked_by_user_id` carries no foreign key on purpose: like the rest of this
 * table it is a credential record, and the durable trail is audit_log.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('user_invitations', (table) => {
    table.datetime('revoked_at').nullable().comment('Set when an admin deletes (revokes) a pending invitation. The token is also replaced, so the old link is dead.');
    table.bigInteger('revoked_by_user_id').unsigned().nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('user_invitations', (table) => {
    table.dropColumn('revoked_by_user_id');
    table.dropColumn('revoked_at');
  });
};
