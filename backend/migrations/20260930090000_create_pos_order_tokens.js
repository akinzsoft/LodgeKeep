'use strict';

/**
 * `pos_order_tokens` — PLAN.md Phase 6's QR self-ordering gap closure
 * (PRODUCT_REQUIREMENTS.md §3.4's QR-ordering section, deferred from the
 * already-shipped POS core pass). One row per printed QR sticker (a table,
 * or a room for in-room ordering) — the token IN the sticker's QR code
 * resolves back to this row, which resolves to an outlet.
 *
 * Scope: PROPERTY_SCOPED, following `pos_outlets` (the family root).
 *
 * ── REVERSIBLE ENCRYPTION, NOT HASH-ONLY — THE ONE POINT THIS SESSION
 * CHANGED FROM THE INITIAL DRAFT ─────────────────────────────────────────
 *
 * Every other single-use credential in this codebase (`password_resets`,
 * `mfa_login_codes`, `user_invitations`) is short-lived and hash-only —
 * once spent or expired, nobody ever needs the plaintext back. A table's
 * QR sticker is the opposite: a semi-permanent PHYSICAL fixture. Staff
 * need to re-view or re-print it later, and "disable this table" should be
 * reversible (re-enable with the SAME code, no new sticker) rather than
 * forcing a brand-new physical print run every time a table is
 * temporarily taken offline for cleaning or a private event.
 *
 * So the raw token is stored TWICE, in two different forms, for two
 * different jobs: `token_encrypted` (AES-256-GCM via `src/shared/
 * encryption.js`, the same mechanism `email_settings.smtp_password_encrypted`
 * already established) is decryptable on demand, for re-display/re-print;
 * `token_hash` (SHA-256) is what an incoming guest request is actually
 * looked up by — an indexed, O(1) exact match a random-IV ciphertext could
 * never support directly. Both are derived from the identical raw token at
 * generation time (`src/modules/qr-ordering/tokens.js`).
 *
 * `active`/`rotated_at` are real, reversible state: deactivating a token
 * sets `active: false` (a real "reactivate" action exists alongside it —
 * unlike a typical revoke, there is a legitimate reason to want the exact
 * same code working again). Regenerating a token inserts a NEW row (a new
 * hash, a new ciphertext) and sets the OLD row's `active: false` with
 * `rotated_at` stamped — the old QR image genuinely stops working, but its
 * history is not deleted (ARCHITECTURE.md §8's "void, never delete"
 * instinct, applied here to a credential rather than a financial line).
 *
 * `type`/`table_label`/`room_id` mirror `pos_orders.table_label`'s own
 * free-string-vs-room distinction: a `table` token carries a label (a
 * physical table number, or null for general/bar seating); a `room` token
 * resolves to a real `rooms` row so a guest scanning it can request a
 * charge-to-room settlement against whichever reservation currently
 * occupies that physical room (resolved live at settlement time, never
 * stored here — a token is a fixture, an in-house reservation is not).
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
  await knex.schema.createTable('pos_order_tokens', (table) => {
    table.comment(
      'One QR-code token per table or room, resolving to an outlet for guest self-ordering. Scope: PROPERTY_SCOPED. Reversible: deactivate/reactivate toggle active; regenerate rotates to a new row.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('outlet_id').unsigned().notNullable();

    table.enu('type', ['table', 'room']).notNullable();
    table.string('table_label', 60).nullable().comment('Set only when type = table. A physical table number, or null for general/bar seating.');
    table.bigInteger('room_id').unsigned().nullable().comment('Set only when type = room. The physical room this token requests charge-to-room against — resolved to a live in-house reservation at settlement time, never stored here.');

    table.string('token_hash', 64).notNullable().comment('SHA-256 hex of the raw token — the O(1) lookup key for an incoming guest request. See migration header for why this coexists with token_encrypted.');
    table.text('token_encrypted').notNullable().comment('AES-256-GCM ciphertext of the same raw token (src/shared/encryption.js) — decryptable on demand so staff can re-view/re-print a QR sticker.');

    table.boolean('active').notNullable().defaultTo(true);
    table.datetime('rotated_at').nullable().comment('Set when this row was superseded by a regenerated token — the row itself is kept, never deleted.');

    timestamps(knex, table);

    table.unique(['token_hash'], { indexName: 'pos_order_tokens_token_hash_unique' });
    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'pos_order_tokens_tenant_id_property_id_id_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'pos_order_tokens_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'outlet_id'], 'pos_order_tokens_tenant_id_property_id_outlet_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_outlets')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'room_id'], 'pos_order_tokens_tenant_id_property_id_room_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('rooms')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'outlet_id'], 'pos_order_tokens_tenant_id_property_id_outlet_id_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pos_order_tokens');
};
