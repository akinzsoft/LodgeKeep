'use strict';

/**
 * Stock transfer requests (user-requested, after stock transfer shipped):
 * an outlet asks the store for stock, and the storekeeper issues it — or
 * part of it — or rejects the request. Confirmed with the user: several
 * items per request; raised by POS operators and managers; approved in ONE
 * step by whoever issues it (no separate manager approval); stock moves the
 * moment it is issued, exactly like a direct transfer (no receipt step, no
 * in-transit state).
 *
 * `stock_transfer_requests` — the request header. PROPERTY_SCOPED,
 * following `pos_outlets`/`stock_takes`.
 *   `from_outlet_id` — the outlet asked to supply (normally a store).
 *   `to_outlet_id`   — the outlet that asked.
 *   `status`: `pending` -> `issued` (the storekeeper issued at least one
 *   line; each issued line is a real transfer) | `rejected` (with a reason)
 *   | `cancelled` (withdrawn by a requester while still pending). Every
 *   state after `pending` is terminal: a request is issued once, never
 *   topped up — a shortfall is a new request, so the paper trail stays one
 *   decision per request.
 *   `decided_*` — who issued/rejected/cancelled it and when; `decision_note`
 *   is the reject reason (required) or an optional issue/cancel note.
 *   `business_date` — set only when issued, the date its transfers post on.
 *
 * `stock_transfer_request_lines` — one stock item per line,
 * `UNIQUE(request, stock_item)` (the same item twice on one request is a
 * mistake, not two needs). `quantity_issued` stays NULL unless the request
 * is issued; on issue it holds what was actually sent (0 for a line the
 * store could not supply) and `transfer_reference` names the pair of
 * `stock_movements` legs (`TRF-<ulid>`) that moved it. The ledger stays the
 * single source of truth for quantities on hand; these rows only record
 * what was asked for and what was sent against it.
 *
 * No CHECK that the two outlets differ — the service refuses it, as the
 * direct-transfer path already does; the schema matches `stock_movements`,
 * which carries no such constraint either.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

function timestamps(knex, table) {
  table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  table
    .datetime('updated_at')
    .notNullable()
    .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

function userForeign(table, column, name) {
  table
    .foreign(['tenant_id', column], name)
    .references(['tenant_id', 'id'])
    .inTable('users')
    .onDelete(RESTRICT.onDelete)
    .onUpdate(RESTRICT.onUpdate);
}

exports.up = async function up(knex) {
  await knex.schema.createTable('stock_transfer_requests', (table) => {
    table.comment('An outlet asking another (normally the store) for stock; issued, rejected or cancelled once. Scope: PROPERTY_SCOPED.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('from_outlet_id').unsigned().notNullable().comment('The outlet asked to supply the stock (normally a store).');
    table.bigInteger('to_outlet_id').unsigned().notNullable().comment('The outlet that asked for it.');

    table.enu('status', ['pending', 'issued', 'rejected', 'cancelled']).notNullable().defaultTo('pending');
    table.string('note', 255).nullable().comment('The requester\'s own note.');

    table.bigInteger('requested_by_user_id').unsigned().notNullable();
    table.datetime('requested_at').notNullable().defaultTo(knex.fn.now());

    table.bigInteger('decided_by_user_id').unsigned().nullable();
    table.datetime('decided_at').nullable();
    table.string('decision_note', 255).nullable().comment('Reject reason (required), or an optional issue/cancel note.');
    table.date('business_date').nullable().comment('Set only when issued — the business date its transfers post on.');

    timestamps(knex, table);

    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'stock_transfer_requests_tenant_property_id_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'stock_transfer_requests_property_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'from_outlet_id'], 'stock_transfer_requests_from_outlet_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_outlets')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'to_outlet_id'], 'stock_transfer_requests_to_outlet_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_outlets')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    userForeign(table, 'requested_by_user_id', 'stock_transfer_requests_requested_by_foreign');
    userForeign(table, 'decided_by_user_id', 'stock_transfer_requests_decided_by_foreign');

    table.index(['tenant_id', 'property_id', 'status'], 'stock_transfer_requests_status_index');
    table.index(['tenant_id', 'property_id', 'from_outlet_id', 'status'], 'stock_transfer_requests_from_status_index');
    table.index(['tenant_id', 'property_id', 'to_outlet_id', 'status'], 'stock_transfer_requests_to_status_index');
  });

  await knex.schema.createTable('stock_transfer_request_lines', (table) => {
    table.comment('One stock item asked for on a transfer request, and what was sent against it. Scope: PROPERTY_SCOPED.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('request_id').unsigned().notNullable();
    table.bigInteger('stock_item_id').unsigned().notNullable();

    table.decimal('quantity_requested', 14, 3).notNullable();
    table.decimal('quantity_issued', 14, 3).nullable().comment('NULL unless issued; what was actually sent (0 when none could be).');
    table.string('transfer_reference', 100).nullable().comment('The TRF-<ulid> pairing the two stock_movements legs that moved this line.');

    timestamps(knex, table);

    table.unique(['tenant_id', 'property_id', 'request_id', 'stock_item_id'], { indexName: 'stock_transfer_request_lines_item_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'stock_transfer_request_lines_property_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'request_id'], 'stock_transfer_request_lines_request_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('stock_transfer_requests')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'stock_item_id'], 'stock_transfer_request_lines_item_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('stock_items')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('stock_transfer_request_lines');
  await knex.schema.dropTableIfExists('stock_transfer_requests');
};
