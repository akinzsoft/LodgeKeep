'use strict';

/**
 * `pos_outlets` — PLAN.md Phase 6's QR self-ordering gap closure. Per-outlet
 * configuration, not a global default — two outlets at the same property
 * (a bar and a restaurant) may reasonably want different accept-timeouts
 * or per-token order-rate limits.
 *
 * `guest_ordering_enabled` defaults `false` — no EXISTING outlet's
 * behaviour changes the moment this migration runs; an outlet must be
 * deliberately opted in before any of its tokens accept an order (checked
 * in `qr-ordering/service.js`).
 *
 * `guest_order_accept_timeout_minutes` is the boundary the lazy
 * auto-reject check (`resolveEffectiveGuestOrderStatus`) compares a
 * `received`-but-never-`accepted_at` order's age against.
 *
 * `guest_order_rate_limit_max` is the per-token cap
 * `qr-ordering/rate-limit.js` enforces via Redis — a DB-configured value
 * read at request time, which is exactly why the per-token limiter is a
 * small dedicated Redis counter rather than a single fixed
 * `express-rate-limit` instance (that library's own limit is fixed at
 * construction time, not re-readable per request).
 *
 * `guest_order_max_unpaid_value` is nullable with no cap by default — a
 * property may choose not to bound how much a single QR order can total
 * before requiring payment (payment is always required regardless; this
 * caps the AMOUNT one order/session may accrue against the token before
 * it must settle, guarding against a runaway or abusive session).
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('pos_outlets', (table) => {
    table.boolean('guest_ordering_enabled').notNullable().defaultTo(false);
    table.integer('guest_order_accept_timeout_minutes').unsigned().notNullable().defaultTo(10);
    table.integer('guest_order_rate_limit_max').unsigned().notNullable().defaultTo(5);
    table.decimal('guest_order_max_unpaid_value', 12, 2).nullable().comment('No cap when null.');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('pos_outlets', (table) => {
    table.dropColumn('guest_ordering_enabled');
    table.dropColumn('guest_order_accept_timeout_minutes');
    table.dropColumn('guest_order_rate_limit_max');
    table.dropColumn('guest_order_max_unpaid_value');
  });
};
