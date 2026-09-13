'use strict';

/**
 * Which door events are the evidence for which alert.
 *
 * A join table rather than an ever-growing id array inside
 * `access_alerts.evidence`: the evidence list stays relational and
 * queryable, and `UNIQUE(door_access_event_id)` makes "one door-open is
 * evidence for at most one incident" a database guarantee rather than an
 * application convention — a double-evaluation bug surfaces as a
 * constraint violation, never as the same event silently counted twice.
 *
 * Append-only, like the events it points at.
 *
 * Scope: PROPERTY_SCOPED.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('access_alert_events', (table) => {
    table.comment('Links each door-access event to the single alert it is evidence for. Scope: PROPERTY_SCOPED.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('access_alert_id').unsigned().notNullable();
    table.bigInteger('door_access_event_id').unsigned().notNullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());

    table
      .foreign(['tenant_id', 'property_id'], 'access_alert_events_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'access_alert_id'], 'access_alert_events_tenant_property_alert_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('access_alerts')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'door_access_event_id'], 'access_alert_events_tenant_property_event_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('door_access_events')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.unique(['tenant_id', 'property_id', 'door_access_event_id'], { indexName: 'access_alert_events_event_unique' });
    table.index(['tenant_id', 'property_id', 'access_alert_id'], 'access_alert_events_alert_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('access_alert_events');
};
