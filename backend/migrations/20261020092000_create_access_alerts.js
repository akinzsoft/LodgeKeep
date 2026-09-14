'use strict';

/**
 * Door-access fraud alerts — PRODUCT_REQUIREMENTS.md §3.23 "Alerting &
 * notification". One row is one INCIDENT, not one door-open: consecutive
 * guest-card opens of the same room by the same card under the same rule
 * group into a single alert (confirmed decision), with every contributing
 * event linked through `access_alert_events`.
 *
 * Incident key: (room_id, card_id, rule, last_closed_assignment_id).
 * `last_closed_assignment_id` is the `reservation_rooms` row that most
 * recently ended before the event (NULL = the room had no assignment
 * history at all). Any check-in into the room in between produces a
 * different last-closed assignment once it ends, so two separate episodes
 * can never merge. Deliberately NOT a foreign key: it is a grouping key
 * captured at detection time, and the evidence snapshot carries the
 * details — a FK would add a RESTRICT dependency from evidence onto live
 * operational rows for no read it serves.
 *
 * No UNIQUE constraint on the incident key: MySQL has no partial/filtered
 * unique index, and a resolved incident followed by a recurrence is a
 * legitimate second row (confirmed: new evidence after resolution becomes a
 * fresh alert; resolved history is never mutated). "At most one
 * open/acknowledged incident per key" is enforced by serialisation — every
 * import commit holds the property's `lock_system_config` row lock — the
 * same "business rule, not schema constraint" shape
 * `housekeeping_discrepancies` and `pos_shifts` already use.
 *
 * Lifecycle: open → acknowledged → resolved (mandatory reason, audited).
 * Never deleted. `evidence` is a PMS-state snapshot frozen at detection
 * time (§3.23: "snapshot the evidence at detection time rather than
 * recomputing it later, because PMS state changes after the fact").
 *
 * `business_date` is the calendar date of the first event in the
 * property's timezone — no historical business-date ledger exists to look
 * a past day's true business date up, so this is a documented
 * approximation, exact on every day Night Audit ran on schedule.
 *
 * Scope: PROPERTY_SCOPED.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('access_alerts', (table) => {
    table.comment('Door-access fraud incidents with an open/acknowledged/resolved lifecycle. Never deleted. Scope: PROPERTY_SCOPED.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('room_id').unsigned().notNullable();
    table.string('card_id', 100).notNullable();

    table.string('rule', 40).notNullable().comment('unsold_occupancy / post_checkout_access.');
    table.string('severity', 20).notNullable().comment('info / warning / critical — both rules built so far are critical.');
    table.bigInteger('reservation_id').unsigned().nullable().comment('The checked-out stay, for post_checkout_access.');
    table.bigInteger('last_closed_assignment_id').unsigned().nullable().comment('Incident grouping key — see migration header. Not a FK.');

    table.string('status', 20).notNullable().defaultTo('open').comment('open / acknowledged / resolved.');
    table.json('evidence').notNullable();
    table.date('business_date').notNullable();
    table.datetime('first_event_at').notNullable();
    table.datetime('last_event_at').notNullable();
    table.integer('event_count').unsigned().notNullable().defaultTo(0);
    table.boolean('is_retrospective').notNullable().defaultTo(true);

    table.datetime('acknowledged_at').nullable();
    table.bigInteger('acknowledged_by_user_id').unsigned().nullable();
    table.datetime('resolved_at').nullable();
    table.bigInteger('resolved_by_user_id').unsigned().nullable();
    table.text('resolution_reason').nullable();

    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));

    table
      .foreign(['tenant_id', 'property_id'], 'access_alerts_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'room_id'], 'access_alerts_tenant_property_room_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('rooms')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'property_id', 'reservation_id'], 'access_alerts_tenant_property_reservation_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('reservations')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'acknowledged_by_user_id'], 'access_alerts_tenant_acknowledged_by_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'resolved_by_user_id'], 'access_alerts_tenant_resolved_by_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'access_alerts_tenant_property_id_unique' });
    table.index(['tenant_id', 'property_id', 'status', 'severity'], 'access_alerts_inbox_index');
    table.index(['tenant_id', 'property_id', 'room_id', 'card_id', 'rule'], 'access_alerts_incident_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('access_alerts');
};
