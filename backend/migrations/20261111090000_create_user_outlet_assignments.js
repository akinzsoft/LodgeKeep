'use strict';

/**
 * `user_outlet_assignments` — the outlets a staff member works at, per
 * property (user-requested: "tie staff to outlets", after stock requests
 * shipped with every POS operator able to ask for any outlet and every POS
 * operator hearing about every request).
 *
 * Confirmed with the user:
 *   - It controls stock requests and their alerts only. The Register,
 *     Tickets, Sales and Shifts keep offering every outlet.
 *   - It is enforced by the server, not a screen default: a limited staff
 *     member cannot raise, see or withdraw a request for an outlet that is
 *     not theirs (an out-of-scope request is a 404, as any other record).
 *   - A staff member with NO rows at a property covers every outlet there —
 *     today's behaviour, so nothing changes until an admin assigns someone.
 *   - Manager, admin and super_admin are never limited, assigned or not.
 *
 * PROPERTY_SCOPED (an outlet belongs to one property). A row is a plain
 * link — delete-and-insert on save, no history — the same shape as
 * `pos_outlet_categories`; who changed it is in `audit_log`.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('user_outlet_assignments', (table) => {
    table.comment('The outlets a staff member works at, per property. None means every outlet. Scope: PROPERTY_SCOPED.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('user_id').unsigned().notNullable();
    table.bigInteger('outlet_id').unsigned().notNullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['tenant_id', 'property_id', 'user_id', 'outlet_id'], { indexName: 'user_outlet_assignments_unique' });
    table.index(['tenant_id', 'property_id', 'outlet_id'], 'user_outlet_assignments_by_outlet_index');

    table
      .foreign(['tenant_id', 'property_id'], 'user_outlet_assignments_property_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'user_id'], 'user_outlet_assignments_user_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'outlet_id'], 'user_outlet_assignments_outlet_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_outlets')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('user_outlet_assignments');
};
