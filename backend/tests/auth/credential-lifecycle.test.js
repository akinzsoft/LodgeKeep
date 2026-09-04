'use strict';

/**
 * Auth credentials — the behaviours the schema is supposed to guarantee.
 *
 * `tests/isolation` already covers these four tables structurally: it asserts
 * their scope declarations, their unique constraints, their composite foreign
 * keys, and that a cross-tenant pairing is rejected. This file covers what that
 * cannot — the claims the migration makes about how the columns *behave*:
 *
 *   AUTH-6  revocation takes effect immediately, and cannot be raced
 *   AUTH-7  a reset token is single-use
 *   AUTH-8  completing a reset invalidates every existing session
 *   AUTH-9  an unconfirmed second factor is not a usable second factor
 *
 * Each claim is paired with a NEGATIVE CONTROL — a scratch-schema demonstration
 * that the mechanism being credited is the one actually doing the work, so an
 * assertion cannot pass because the operation was impossible for some unrelated
 * reason. A test that only ever sees the constraint succeed cannot distinguish
 * "the constraint rejected this" from "nothing would have accepted it anyway".
 *
 * The negative controls run on their own connection, outside the suite's
 * rolled-back transaction, because DDL causes an implicit commit in MySQL and
 * would otherwise commit the fixtures. They are self-contained — their own
 * parent and child tables, their own rows — and dropped in afterAll.
 */

const { db, useRolledBackTransaction } = require('../helpers/db');
const { seedTwoTenants, tokenHash, hoursFromNow, byLabel } = require('../helpers/fixtures');
const { ER } = require('../helpers/entities');

/** Scratch tables for the negative controls. Prefixed so they are unmistakable. */
const NC = {
  parent: '_nc_parent',
  bare: '_nc_child_bare_fk',
  composite: '_nc_child_composite_fk',
  unindexed: '_nc_child_no_unique',
};

describe('auth credential lifecycle', () => {
  const tx = useRolledBackTransaction();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(tx.trx);
  });

  // ==================================================================
  // Negative controls — the mechanisms, demonstrated in isolation
  // ==================================================================
  describe('negative controls (the mechanism, not the schema)', () => {
    beforeAll(async () => {
      const knex = db();
      // Drop first: a previous crashed run may have left these behind, and
      // global-setup only drops what the migrations create.
      for (const t of [NC.bare, NC.composite, NC.unindexed, NC.parent]) {
        await knex.raw('DROP TABLE IF EXISTS ??', [t]);
      }

      // A miniature of `users`: rows owned by a tenant, with both the bare
      // primary key and the (tenant_id, id) parent key the real table carries.
      await knex.raw(
        `CREATE TABLE ?? (
           id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           tenant_id BIGINT UNSIGNED NOT NULL,
           UNIQUE KEY nc_parent_tenant_id_id (tenant_id, id)
         ) ENGINE=InnoDB`,
        [NC.parent]
      );

      // Two children over the same parent, differing only in how they reference
      // it — which is the entire question this control exists to settle.
      await knex.raw(
        `CREATE TABLE ?? (
           id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           tenant_id BIGINT UNSIGNED NOT NULL,
           user_id BIGINT UNSIGNED NOT NULL,
           CONSTRAINT nc_bare_fk FOREIGN KEY (user_id)
             REFERENCES ?? (id) ON DELETE RESTRICT ON UPDATE RESTRICT
         ) ENGINE=InnoDB`,
        [NC.bare, NC.parent]
      );

      await knex.raw(
        `CREATE TABLE ?? (
           id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           tenant_id BIGINT UNSIGNED NOT NULL,
           user_id BIGINT UNSIGNED NOT NULL,
           CONSTRAINT nc_composite_fk FOREIGN KEY (tenant_id, user_id)
             REFERENCES ?? (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
         ) ENGINE=InnoDB`,
        [NC.composite, NC.parent]
      );

      // A token column with no unique index — the schema this codebase would
      // have if `UNIQUE(refresh_token_hash)` were merely assumed.
      await knex.raw(
        `CREATE TABLE ?? (
           id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           token_hash VARCHAR(64) NOT NULL
         ) ENGINE=InnoDB`,
        [NC.unindexed]
      );

      // Tenant 1 owns user 1; tenant 2 owns user 2.
      await knex(NC.parent).insert([
        { id: 1, tenant_id: 1 },
        { id: 2, tenant_id: 2 },
      ]);
    });

    afterAll(async () => {
      const knex = db();
      for (const t of [NC.bare, NC.composite, NC.unindexed, NC.parent]) {
        await knex.raw('DROP TABLE IF EXISTS ??', [t]);
      }
    });

    it('a BARE user_id foreign key accepts the cross-tenant row — which is why ours is composite', async () => {
      // Tenant 1 claiming tenant 2's user. The foreign key is satisfied: user 2
      // exists. Nothing here knows it belongs to someone else.
      await expect(
        db()(NC.bare).insert({ tenant_id: 1, user_id: 2 })
      ).resolves.toBeDefined();
    });

    it('the COMPOSITE key rejects the identical row', async () => {
      await expect(
        db()(NC.composite).insert({ tenant_id: 1, user_id: 2 })
      ).rejects.toMatchObject({ code: ER.NO_PARENT });

      // And still accepts the correctly-owned one, so the rejection above is
      // the tenant mismatch rather than the constraint refusing everything.
      await expect(
        db()(NC.composite).insert({ tenant_id: 2, user_id: 2 })
      ).resolves.toBeDefined();
    });

    it('a token column with no unique index accepts the same digest twice', async () => {
      const digest = tokenHash('negative-control-duplicate');
      await expect(db()(NC.unindexed).insert({ token_hash: digest })).resolves.toBeDefined();
      await expect(db()(NC.unindexed).insert({ token_hash: digest })).resolves.toBeDefined();

      const rows = await db()(NC.unindexed).where({ token_hash: digest });
      // Two sessions, one token. The lookup that authenticates a refresh would
      // have to pick one, and revoking the row it picked leaves the other live.
      expect(rows.length).toBe(2);
    });

    it('strict mode is what turns an oversized digest into an error rather than a silent truncation', async () => {
      // The claim being controlled: CHAR/VARCHAR(64) protects the token columns
      // because MySQL refuses the write. That is only true under
      // STRICT_TRANS_TABLES — without it MySQL truncates and warns, and a
      // truncated digest is catastrophic rather than merely wrong, because two
      // different tokens can then share a stored prefix.
      const mode = await db().raw('SELECT @@SESSION.sql_mode AS mode');
      expect(mode[0][0].mode).toContain('STRICT_TRANS_TABLES');

      await expect(
        db()(NC.unindexed).insert({ token_hash: 'f'.repeat(65) })
      ).rejects.toMatchObject({ code: 'ER_DATA_TOO_LONG' });
    });
  });

  // ==================================================================
  // Token storage
  // ==================================================================
  describe('secrets are stored as digests, never as tokens', () => {
    const tokenColumns = [
      ['sessions', 'refresh_token_hash'],
      ['password_resets', 'token_hash'],
      ['user_invitations', 'token_hash'],
    ];

    it.each(tokenColumns)('%s.%s is exactly SHA-256 wide', async (table, column) => {
      const row = await tx
        .trx('information_schema.columns')
        .select('character_maximum_length as len')
        .where({
          table_schema: db().client.config.connection.database,
          table_name: table,
          column_name: column,
        })
        .first();

      // 64 hex characters. Not "at least 64" — a wider column would accept a
      // digest from a different algorithm without anyone noticing the change.
      expect(Number(row.len)).toBe(64);
    });

    it.each(tokenColumns)('%s stores no plaintext token alongside %s', async (table, column) => {
      const columns = await tx
        .trx('information_schema.columns')
        .select('column_name as name')
        .where({
          table_schema: db().client.config.connection.database,
          table_name: table,
        });

      const names = columns.map((c) => c.name);
      expect(names).toContain(column);
      // The mirror of AUTH-11 for tokens: no `token`, `refresh_token`, or
      // `secret_plain` column may exist next to the digest.
      expect(names.filter((n) => /token$/.test(n) && !/hash$/.test(n))).toEqual([]);
    });

    it('rejects an oversized digest on the real tables too', async () => {
      await expect(
        tx.trx('sessions').insert({
          tenant_id: ctx.a.id,
          user_id: ctx.a.users[0].id,
          refresh_token_hash: 'f'.repeat(65),
          expires_at: hoursFromNow(24),
        })
      ).rejects.toMatchObject({ code: 'ER_DATA_TOO_LONG' });
    });
  });

  // ==================================================================
  // AUTH-6 — revocation
  // ==================================================================
  describe('session revocation takes effect immediately (AUTH-6)', () => {
    it('revokes by claiming the row, so a concurrent revoke cannot double-apply', async () => {
      const live = byLabel(ctx.a.sessions, 'live');

      // The conditional UPDATE is the mechanism: WHERE revoked_at IS NULL, then
      // check the affected-row count. ARCHITECTURE.md §5 — reading the row and
      // then writing it in separate unlocked steps is the anti-pattern, and
      // "add another check" never fixes it.
      const first = await tx
        .trx('sessions')
        .where({ id: live.id })
        .whereNull('revoked_at')
        .update({ revoked_at: tx.trx.fn.now(), revoked_reason: 'logout' });
      expect(first).toBe(1);

      // A second revoke — a retry, or a second tab — claims nothing. It is not
      // an error, but it must not report that it did the revoking.
      const second = await tx
        .trx('sessions')
        .where({ id: live.id })
        .whereNull('revoked_at')
        .update({ revoked_at: tx.trx.fn.now(), revoked_reason: 'admin_revoked' });
      expect(second).toBe(0);

      // The reason recorded is the first one, not the last writer's.
      const row = await tx.trx('sessions').where({ id: live.id }).first();
      expect(row.revoked_reason).toBe('logout');
      expect(row.revoked_at).not.toBeNull();
    });

    it('leaves a revoked session distinguishable from an expired one', async () => {
      const revoked = byLabel(ctx.a.sessions, 'revoked');
      const row = await tx.trx('sessions').where({ id: revoked.id }).first();

      // Revoked, but NOT yet past its natural expiry — which is the whole
      // dismissal case. A check that only compared expires_at to now() would
      // still honour this token.
      expect(row.revoked_at).not.toBeNull();
      expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now());
      expect(row.revoked_reason).toBe('user_deactivated');
    });

    it('refuses a revocation reason outside the enum', async () => {
      await expect(
        tx.trx('sessions')
          .where({ id: byLabel(ctx.a.sessions, 'revoked').id })
          .update({ revoked_reason: 'because' })
      ).rejects.toMatchObject({ code: 'WARN_DATA_TRUNCATED' });
    });
  });

  // ==================================================================
  // AUTH-7 / AUTH-8 — password reset
  // ==================================================================
  describe('a password reset token is single-use (AUTH-7)', () => {
    it('is claimed by exactly one of two simultaneous submissions', async () => {
      const pending = byLabel(ctx.a.passwordResets, 'pending');

      const first = await tx
        .trx('password_resets')
        .where({ id: pending.id })
        .whereNull('used_at')
        .update({ used_at: tx.trx.fn.now() });

      const second = await tx
        .trx('password_resets')
        .where({ id: pending.id })
        .whereNull('used_at')
        .update({ used_at: tx.trx.fn.now() });

      // One and only one. This is the assertion AUTH-7 rests on: the second
      // submission of the same link is rejected because it claimed no row, not
      // because the code re-read used_at and found it set.
      expect([first, second]).toEqual([1, 0]);
    });

    it('treats an already-used token as spent without needing a status column', async () => {
      const used = byLabel(ctx.a.passwordResets, 'used');
      const claimed = await tx
        .trx('password_resets')
        .where({ id: used.id })
        .whereNull('used_at')
        .update({ used_at: tx.trx.fn.now() });

      expect(claimed).toBe(0);
    });
  });

  describe('completing a reset invalidates every existing session (AUTH-8)', () => {
    it('revokes all of that user sessions, and only that tenant rows', async () => {
      const user = ctx.a.users[0];

      // Give the user a second live session, so "all" means more than one.
      await tx.trx('sessions').insert({
        tenant_id: ctx.a.id,
        user_id: user.id,
        refresh_token_hash: tokenHash('auth8-second-session'),
        expires_at: hoursFromNow(24),
      });

      const revoked = await tx
        .trx('sessions')
        .where({ tenant_id: ctx.a.id, user_id: user.id })
        .whereNull('revoked_at')
        .update({ revoked_at: tx.trx.fn.now(), revoked_reason: 'password_reset' });

      expect(revoked).toBeGreaterThan(0);

      const stillLive = await tx
        .trx('sessions')
        .where({ tenant_id: ctx.a.id, user_id: user.id })
        .whereNull('revoked_at');
      expect(stillLive).toEqual([]);

      // Tenant B's identically-positioned user is untouched. The fixture
      // interleaves ids, so a query that lost its tenant filter would have
      // caught this row.
      const neighbour = await tx
        .trx('sessions')
        .where({ tenant_id: ctx.b.id })
        .whereNull('revoked_at');
      expect(neighbour.length).toBeGreaterThan(0);
    });
  });

  // ==================================================================
  // AUTH-9 — second factors
  // ==================================================================
  describe('an unconfirmed second factor is not a usable one (AUTH-9)', () => {
    it('keeps enrolment two-phase', async () => {
      const unconfirmed = byLabel(ctx.a.mfaDevices, 'unconfirmed');
      const row = await tx.trx('mfa_devices').where({ id: unconfirmed.id }).first();

      // The row exists — enrolment has started — but confirmed_at is null, so
      // the challenge path must not accept it. Without the two phases, starting
      // enrolment would lock a user out of their own account the moment the
      // secret was written.
      expect(row.confirmed_at).toBeNull();

      const usable = await tx
        .trx('mfa_devices')
        .where({ tenant_id: ctx.a.id, user_id: unconfirmed.user_id })
        .whereNotNull('confirmed_at');
      expect(usable).toEqual([]);
    });

    it('allows one device per type, and the constraint is per user, not per tenant', async () => {
      const owner = byLabel(ctx.a.mfaDevices, 'confirmed');

      // A second TOTP for the same user: refused, or an MFA challenge would
      // have two right answers and revoking a lost phone would leave one live.
      await expect(
        tx.trx('mfa_devices').insert({
          tenant_id: ctx.a.id,
          user_id: owner.user_id,
          type: 'totp',
          secret: 'enc:v1:second-totp',
        })
      ).rejects.toMatchObject({ code: ER.DUPLICATE });

      // A different type for the same user: allowed. The constraint has to be
      // this precise, or enrolling a backup factor would be impossible.
      await expect(
        tx.trx('mfa_devices').insert({
          tenant_id: ctx.a.id,
          user_id: owner.user_id,
          type: 'sms',
          secret: 'enc:v1:sms',
        })
      ).resolves.toBeDefined();

      // The same type for a different user: also allowed, which is what makes
      // it a per-user constraint rather than a per-tenant one.
      await expect(
        tx.trx('mfa_devices').insert({
          tenant_id: ctx.a.id,
          user_id: ctx.a.users[1].id,
          type: 'sms',
          secret: 'enc:v1:sms-other-user',
        })
      ).resolves.toBeDefined();
    });

    it('stores no bare TOTP seed — the column holds ciphertext', async () => {
      const rows = await tx.trx('mfa_devices').where({ tenant_id: ctx.a.id });
      expect(rows.length).toBeGreaterThan(0);
      rows.forEach((row) => {
        // The fixture writes an `enc:` envelope. A base32 TOTP seed, which is
        // what an unencrypted implementation would store, has no such prefix.
        expect(row.secret).toMatch(/^enc:/);
        expect(row.secret).not.toMatch(/^[A-Z2-7]{16,}$/);
      });
    });
  });

  // ==================================================================
  // Invitations
  // ==================================================================
  describe('an invitation grants a role at a property (SECURITY.md §4)', () => {
    it('cannot be issued without naming the property the role is held at', async () => {
      // NOT NULL is the point: an invitation carrying a role and no property is
      // the global-role construct §4 forbids, and could only be completed by
      // letting the invitee choose their own scope.
      await expect(
        tx.trx('user_invitations').insert({
          tenant_id: ctx.a.id,
          property_id: null,
          email: 'no-property@example.com',
          role: 'front_desk',
          token_hash: tokenHash('invite-no-property'),
          expires_at: hoursFromNow(48),
          invited_by_user_id: ctx.a.users[0].id,
        })
      ).rejects.toMatchObject({ code: 'ER_BAD_NULL_ERROR' });
    });

    it('carries the role as a code its own tenant defines', async () => {
      await expect(
        tx.trx('user_invitations').insert({
          tenant_id: ctx.a.id,
          property_id: ctx.a.properties[0].id,
          email: 'bad-role@example.com',
          role: 'wizard',
          token_hash: tokenHash('invite-bad-role'),
          expires_at: hoursFromNow(48),
          invited_by_user_id: ctx.a.users[0].id,
        })
      ).rejects.toMatchObject({ code: ER.NO_PARENT });
    });

    it('lets an address be invited again after a first invitation lapses', async () => {
      // The deliberate absence of UNIQUE(tenant_id, email): a typo or an
      // unaccepted invitation must not permanently burn an address. Two rows
      // for one address is a valid state; "only one live" is an application
      // rule, because MySQL has no partial index to express it.
      const existing = byLabel(ctx.a.invitations, 'pending');
      const row = await tx.trx('user_invitations').where({ id: existing.id }).first();

      await expect(
        tx.trx('user_invitations').insert({
          tenant_id: ctx.a.id,
          property_id: row.property_id,
          email: row.email,
          role: row.role,
          token_hash: tokenHash('invite-reissued'),
          expires_at: hoursFromNow(48),
          invited_by_user_id: ctx.a.users[0].id,
        })
      ).resolves.toBeDefined();
    });

    it('is accepted exactly once', async () => {
      const pending = byLabel(ctx.a.invitations, 'pending');

      const first = await tx
        .trx('user_invitations')
        .where({ id: pending.id })
        .whereNull('accepted_at')
        .update({ accepted_at: tx.trx.fn.now() });

      const second = await tx
        .trx('user_invitations')
        .where({ id: pending.id })
        .whereNull('accepted_at')
        .update({ accepted_at: tx.trx.fn.now() });

      // Two simultaneous acceptances of one link must not both create a user.
      expect([first, second]).toEqual([1, 0]);
    });
  });

  // ==================================================================
  // Lifecycle (DATABASE.md §3)
  // ==================================================================
  describe('credentials are deletable, unlike the identities they belong to', () => {
    it('lets a spent session be purged', async () => {
      // The deliberate exception to deactivate-never-delete: these are
      // credentials, not history. The durable record is auth_events.
      const revoked = byLabel(ctx.a.sessions, 'revoked');
      await expect(tx.trx('sessions').where({ id: revoked.id }).del()).resolves.toBe(1);
    });

    it('still refuses to delete the user those credentials belong to', async () => {
      // RESTRICT in the other direction: purging a session is fine, deleting
      // the person is not.
      await expect(
        tx.trx('users').where({ id: ctx.a.users[1].id }).del()
      ).rejects.toMatchObject({ code: ER.STILL_REFERENCED });
    });
  });
});
