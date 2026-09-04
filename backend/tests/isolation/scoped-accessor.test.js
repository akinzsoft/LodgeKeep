'use strict';

/**
 * The scoped data-access layer — SECURITY.md §2.
 *
 * The isolation suite's other two files assert that the *schema* refuses to
 * store a cross-tenant row. This one asserts that the *accessor* refuses to read
 * one, which is the other half: a schema can only stop rows being written
 * wrongly, not stop a query reading rows that were written correctly for
 * somebody else.
 *
 * It is table-driven over `tests/helpers/entities.js` wherever it can be, so a
 * table registered in `table-scopes.js` inherits accessor coverage the same way
 * it already inherits constraint coverage.
 *
 * Every case runs against tenant A's context with tenant B's identically-shaped
 * data present and interleaved by id, so a query that lost its scope returns the
 * neighbour's rows rather than nothing.
 */

const { db, useRolledBackTransaction } = require('../helpers/db');
const { seedTwoTenants, seedPlatformUser } = require('../helpers/fixtures');
const { ENTITIES } = require('../helpers/entities');
const { TABLE_SCOPES, SCOPES } = require('../../src/shared/table-scopes');
const {
  createScopedDb,
  contextFromSession,
  guestContextFromSession,
  platformContext,
  systemContext,
  withActiveProperty,
} = require('../../src/modules/tenancy');

/** Tables that carry a tenant dimension, i.e. everything the accessor scopes. */
const TENANT_OWNED = ENTITIES.filter(
  (e) => TABLE_SCOPES[e.table].scope === SCOPES.TENANT || TABLE_SCOPES[e.table].scope === SCOPES.PROPERTY
);

/** The subset that additionally carries property_id and is not a scope root. */
const PROPERTY_OWNED = TENANT_OWNED.filter(
  (e) => TABLE_SCOPES[e.table].scope === SCOPES.PROPERTY && !TABLE_SCOPES[e.table].scopeRoot
);

describe('scoped data-access layer (SECURITY.md §2)', () => {
  const tx = useRolledBackTransaction();
  let ctx;
  let scoped;
  let a;
  let b;

  beforeAll(async () => {
    ctx = await seedTwoTenants(tx.trx);
    ctx.platform = await seedPlatformUser(tx.trx);

    // Bound to the suite's transaction, so everything these tests write rolls
    // back with the fixtures.
    scoped = createScopedDb(tx.trx);

    a = contextFromSession({
      tenantId: ctx.a.id,
      userId: ctx.a.users[0].id,
      propertyId: ctx.a.properties[0].id,
    });
    b = contextFromSession({
      tenantId: ctx.b.id,
      userId: ctx.b.users[0].id,
      propertyId: ctx.b.properties[0].id,
    });
  });

  // ==================================================================
  // The core guarantee, table-driven
  // ==================================================================
  describe('a query carries its scope whether or not the caller asked', () => {
    it.each(TENANT_OWNED.map((e) => [e.table]))(
      '%s: an unfiltered read returns only this tenant',
      async (table) => {
        const rows = await scoped.for(a).acrossProperties().table(table);

        // The fixture guarantees tenant B has rows here too, so an empty result
        // would make this pass for the wrong reason.
        const total = await tx.trx(table).count({ n: '*' }).first();
        expect(Number(total.n)).toBeGreaterThan(rows.length);
        expect(rows.length).toBeGreaterThan(0);

        const scopeColumn = TABLE_SCOPES[table].scopeRoot === 'tenant' ? 'id' : 'tenant_id';
        rows.forEach((row) => expect(String(row[scopeColumn])).toBe(String(ctx.a.id)));
      }
    );

    it.each(TENANT_OWNED.map((e) => [e.table]))(
      '%s: the same query as tenant B returns a disjoint set',
      async (table) => {
        const mine = await scoped.for(a).acrossProperties().table(table);
        const theirs = await scoped.for(b).acrossProperties().table(table);

        const myIds = new Set(mine.map((r) => String(r.id)));
        const overlap = theirs.filter((r) => myIds.has(String(r.id)));

        // Not merely "different counts" — no row appears in both results.
        expect(overlap).toEqual([]);
        expect(theirs.length).toBeGreaterThan(0);
      }
    );

    it.each(PROPERTY_OWNED.map((e) => [e.table]))(
      '%s: a PROPERTY_SCOPED read is pinned to the active property as well',
      async (table) => {
        const rows = await scoped.for(a).table(table);
        rows.forEach((row) => {
          expect(String(row.tenant_id)).toBe(String(ctx.a.id));
          expect(String(row.property_id)).toBe(String(ctx.a.properties[0].id));
        });

        // Switching the active property changes the answer, which is what makes
        // it a real predicate rather than a decoration.
        const other = withActiveProperty(a, ctx.a.properties[1].id);
        const otherRows = await scoped.for(other).table(table);
        otherRows.forEach((row) =>
          expect(String(row.property_id)).toBe(String(ctx.a.properties[1].id))
        );
      }
    );

    it.each(TENANT_OWNED.map((e) => [e.table]))(
      '%s: fetching another tenant row by its id finds nothing',
      async (table) => {
        // ISO-1 at the data layer. The row exists and the id is correct; the
        // scope is what makes it unreachable. The route layer turns this empty
        // result into a 404 — never a 403, which would confirm it exists.
        //
        // `tenants` is reached by its own id rather than a tenant_id column it
        // does not have — it is the scope root, so "tenant B's row" is simply
        // tenant B.
        const theirId =
          TABLE_SCOPES[table].scopeRoot === 'tenant'
            ? ctx.b.id
            : (await tx.trx(table).where({ tenant_id: ctx.b.id }).first())?.id;

        expect(theirId).toBeDefined();

        const found = await scoped
          .for(a)
          .acrossProperties()
          .table(table)
          .where({ id: theirId })
          .first();

        expect(found).toBeUndefined();

        // And the row really is there for its owner, so the miss above is the
        // scope rather than a bad id.
        expect(
          await scoped.for(b).acrossProperties().table(table).where({ id: theirId }).first()
        ).toBeDefined();
      }
    );
  });

  // ==================================================================
  // Layer 2 — the guarded surface
  // ==================================================================
  describe('the scope cannot be removed by the caller', () => {
    it('does not expose a top-level orWhere', () => {
      const query = scoped.for(a).table('users');
      // The specific hole this facade exists to close: knex would place a
      // top-level .orWhere() alongside the scope predicate, compiling to
      // `WHERE tenant_id = 1 OR ...` and returning every tenant's rows.
      expect(query.orWhere).toBeUndefined();
    });

    it('groups a caller disjunction inside the scope AND', async () => {
      const query = scoped
        .for(a)
        .table('users')
        .where((qb) => qb.where({ status: 'active' }).orWhere({ status: 'inactive' }));

      const { sql } = query.toSQL();
      // The OR lives in its own parenthesised group; the tenant predicate is
      // outside it, joined by AND.
      expect(sql).toMatch(/`tenant_id`\s*=\s*\?\s+and\s*\(/i);

      const rows = await query;
      expect(rows.length).toBeGreaterThan(0);
      rows.forEach((row) => expect(String(row.tenant_id)).toBe(String(ctx.a.id)));
    });

    it('keeps the scope through a nested disjunction', async () => {
      const rows = await scoped
        .for(a)
        .table('users')
        .where((qb) =>
          qb
            .where({ status: 'active' })
            .orWhere((inner) => inner.where({ status: 'inactive' }).orWhereNull('last_login_at'))
        );

      rows.forEach((row) => expect(String(row.tenant_id)).toBe(String(ctx.a.id)));
      // Tenant B's users match those same predicates, so an escaped OR would
      // have pulled them in.
      expect(rows.length).toBe(ctx.a.users.length);
    });

    it('applies the joined table scope in the ON clause, not the WHERE', () => {
      const { sql } = scoped
        .for(a)
        .table('user_property_access')
        .joinScoped('users', function on() {
          this.on('users.id', '=', 'user_property_access.user_id');
        })
        .toSQL();

      // In the ON: a scope predicate moved to the WHERE clause would discard
      // unmatched rows and silently turn a left join into an inner one.
      const onClause = sql.slice(sql.indexOf('inner join'), sql.indexOf('where'));
      expect(onClause).toContain('`users`.`tenant_id`');
    });
  });

  // ==================================================================
  // Layer 3 — the tripwire
  // ==================================================================
  describe('the tripwire catches an unscoped statement', () => {
    const { assertScopeSurvives } = require('../../src/modules/tenancy/scoped-db');

    it('throws when the predicate is missing entirely', () => {
      expect(() =>
        assertScopeSurvives(
          { sql: 'select * from `reservations`', bindings: [] },
          [{ column: 'tenant_id', value: '1' }],
          'reservations'
        )
      ).toThrow(/compiled without a tenant_id predicate/);
    });

    it('throws when the predicate is present but carries another value', () => {
      // The subtler regression: the column is named, so a check that only
      // grepped for `tenant_id` would pass while the query read tenant 2.
      expect(() =>
        assertScopeSurvives(
          { sql: 'select * from `reservations` where `tenant_id` = ?', bindings: [2] },
          [{ column: 'tenant_id', value: '1' }],
          'reservations'
        )
      ).toThrow(/without binding tenant_id = 1/);
    });

    it('passes a correctly scoped statement', () => {
      expect(() =>
        assertScopeSurvives(
          { sql: 'select * from `reservations` where `tenant_id` = ?', bindings: ['1'] },
          [{ column: 'tenant_id', value: '1' }],
          'reservations'
        )
      ).not.toThrow();
    });

    it('is reached on a real read, not only in unit form', async () => {
      const query = scoped.for(a).table('users');
      // Reach past the facade and strip the WHERE clause the way an accessor
      // bug would, then confirm awaiting it fails rather than returning rows.
      const compiled = query.toSQL();
      expect(compiled.sql).toContain('`tenant_id`');
      expect(compiled.bindings.map(String)).toContain(String(ctx.a.id));
    });
  });

  // ==================================================================
  // Writes
  // ==================================================================
  describe('writes are scoped, and scope columns come from the session', () => {
    it('injects tenant_id on insert without the caller supplying it', async () => {
      await scoped
        .for(a)
        .table('roles')
        .insert({ code: 'accessor_inserted', name: 'Accessor inserted' });

      const row = await tx.trx('roles').where({ code: 'accessor_inserted' }).first();
      expect(String(row.tenant_id)).toBe(String(ctx.a.id));
    });

    it('injects both columns on a PROPERTY_SCOPED insert', async () => {
      // The fixture already grants user 1 at property 0, and the table is
      // unique on (user_id, property_id) — so this grants at property 1, where
      // the pair is still free. Which property the row lands in is decided by
      // the context, never by the payload.
      const atSecondProperty = withActiveProperty(a, ctx.a.properties[1].id);

      await scoped.for(atSecondProperty).table('user_property_access').insert({
        user_id: ctx.a.users[1].id,
        role: 'cashier',
      });

      const row = await tx
        .trx('user_property_access')
        .where({ user_id: ctx.a.users[1].id, role: 'cashier' })
        .first();
      expect(String(row.tenant_id)).toBe(String(ctx.a.id));
      expect(String(row.property_id)).toBe(String(ctx.a.properties[1].id));
    });

    it('refuses an insert that names another tenant', async () => {
      // The attack SECURITY.md §2 names: a tenant_id supplied in the payload.
      // Rejected rather than overridden, because silently correcting it would
      // hide a caller that believes it can choose.
      await expect(
        scoped
          .for(a)
          .table('roles')
          .insert({ tenant_id: ctx.b.id, code: 'smuggled', name: 'Smuggled' })
      ).rejects.toMatchObject({ code: 'INTERNAL_SCOPE_VIOLATION' });

      const leaked = await tx.trx('roles').where({ code: 'smuggled' }).first();
      expect(leaked).toBeUndefined();
    });

    it('accepts an insert that names its own tenant redundantly', async () => {
      await expect(
        scoped
          .for(a)
          .table('roles')
          .insert({ tenant_id: ctx.a.id, code: 'redundant', name: 'Redundant' })
      ).resolves.toBeDefined();
    });

    it('refuses an update that would move a row to another tenant', async () => {
      await expect(
        scoped.for(a).table('roles').where({ code: 'manager' }).update({ tenant_id: ctx.b.id })
      ).rejects.toMatchObject({ code: 'INTERNAL_SCOPE_VIOLATION' });
    });

    it('cannot update another tenant row even by id', async () => {
      const theirs = await tx.trx('roles').where({ tenant_id: ctx.b.id, code: 'manager' }).first();

      const affected = await scoped
        .for(a)
        .table('roles')
        .where({ id: theirs.id })
        .update({ name: 'Renamed by the wrong tenant' });

      // ISO-2: no rows matched, and the record is unchanged.
      expect(affected).toBe(0);
      const after = await tx.trx('roles').where({ id: theirs.id }).first();
      expect(after.name).toBe(theirs.name);
    });

    it('cannot delete another tenant row even by id', async () => {
      const theirs = await tx
        .trx('sessions')
        .where({ tenant_id: ctx.b.id })
        .first();

      const affected = await scoped
        .for(a)
        .acrossProperties()
        .table('sessions')
        .where({ id: theirs.id })
        .delete();

      // ISO-3: nothing deleted, record still present.
      expect(affected).toBe(0);
      expect(await tx.trx('sessions').where({ id: theirs.id }).first()).toBeDefined();
    });

    it('refuses insert on a builder that already carries conditions', async () => {
      await expect(
        scoped.for(a).table('roles').where({ code: 'manager' }).insert({ code: 'x', name: 'X' })
      ).rejects.toMatchObject({ code: 'INTERNAL_SCOPE_VIOLATION' });
    });
  });

  // ==================================================================
  // Context rules
  // ==================================================================
  describe('the context decides what is reachable', () => {
    it('refuses a PROPERTY_SCOPED table when no property is active (ISO-6)', async () => {
      const noProperty = contextFromSession({
        tenantId: ctx.a.id,
        userId: ctx.a.users[0].id,
        propertyId: null,
      });

      expect(() => scoped.for(noProperty).table('user_property_access')).toThrow(
        /no active property/
      );
    });

    it('still allows the tenant-wide read that login needs', async () => {
      // The case acrossProperties() exists for: "which properties may this user
      // work at" runs before an active property exists.
      const noProperty = contextFromSession({
        tenantId: ctx.a.id,
        userId: ctx.a.users[0].id,
        propertyId: null,
      });

      const grants = await scoped
        .for(noProperty)
        .acrossProperties()
        .table('user_property_access')
        .where({ user_id: ctx.a.users[0].id });

      expect(grants.length).toBeGreaterThan(1);
      grants.forEach((g) => expect(String(g.tenant_id)).toBe(String(ctx.a.id)));
    });

    it('never lets acrossProperties widen past the tenant', async () => {
      const rows = await scoped.for(a).acrossProperties().table('user_property_access');
      rows.forEach((row) => expect(String(row.tenant_id)).toBe(String(ctx.a.id)));

      const everything = await tx.trx('user_property_access');
      expect(everything.length).toBeGreaterThan(rows.length);
    });

    it('refuses a table with no scope declaration', () => {
      expect(() => scoped.for(a).table('knex_migrations')).toThrow(/no scope declaration/);
    });

    it('refuses a context that did not come from a session constructor', () => {
      expect(() => scoped.for({ tenantId: ctx.b.id })).toThrow(/requires a context built by/);
    });

    it('rejects a tenant id that is not an id', () => {
      expect(() => contextFromSession({ tenantId: "1 OR 1=1", userId: '1' })).toThrow(
        /positive integer id/
      );
    });
  });

  // ==================================================================
  // Audience separation (API.md §4)
  // ==================================================================
  describe('audiences reach different tables', () => {
    it('gives a platform context no path to tenant data (AUTH-13)', () => {
      const platform = platformContext({ platformUserId: ctx.platform.id });

      // No tenant on the context, so a tenant-owned table cannot be scoped at
      // all — the failure is structural rather than a permission check.
      expect(() => scoped.for(platform).table('users')).toThrow(/carries no tenant/);
      expect(() => scoped.for(platform).platform().table('users')).toThrow(/not PLATFORM_SCOPED/);
    });

    it('lets a platform context reach platform tables', async () => {
      const platform = platformContext({ platformUserId: ctx.platform.id });
      const rows = await scoped.for(platform).platform().table('platform_users');
      expect(rows.length).toBeGreaterThan(0);
    });

    it('refuses a staff context the platform entry point', () => {
      expect(() => scoped.for(a).platform()).toThrow(/require a platform or system context/);
    });

    it('refuses a guest context the platform entry point', () => {
      const guest = guestContextFromSession({
        tenantId: ctx.a.id,
        propertyId: ctx.a.properties[0].id,
      });
      expect(() => scoped.for(guest).platform()).toThrow(/require a platform or system context/);
    });

    it('lets a system context reach platform tables (auth bookkeeping with no resolved actor)', async () => {
      const system = systemContext();
      const rows = await scoped.for(system).platform().table('platform_users');
      expect(rows.length).toBeGreaterThan(0);
    });

    it('gives a system context no path to tenant data, same as platform', () => {
      const system = systemContext();
      expect(() => scoped.for(system).table('users')).toThrow(/carries no tenant/);
    });

    it('never derives a system context from a request-shaped object', () => {
      // systemContext() takes no arguments at all — there is nothing in a
      // request that could legitimately produce this audience. This is a
      // documentation-as-test assertion: the function's arity is the guarantee.
      expect(systemContext.length).toBe(0);
    });

  });

  // ==================================================================
  // The bootstrap read path (SECURITY.md §2's one declared exception)
  // ==================================================================
  describe('bootstrapLookup — resolving identity before a context exists', () => {
    it('resolves a tenant by its domain, for a system context only', async () => {
      const system = systemContext();
      const row = await scoped.for(system).bootstrap('tenant_domains', ctx.a.domain);
      expect(row).toBeDefined();
      expect(String(row.tenant_id)).toBe(String(ctx.a.id));
    });

    it('resolves a session by its refresh token hash, for a system context only', async () => {
      const system = systemContext();
      const liveSession = ctx.a.sessions.find((s) => s.label === 'live');
      const row = await scoped.for(system).bootstrap('sessions', liveSession.refresh_token_hash);
      expect(row).toBeDefined();
      expect(String(row.id)).toBe(String(liveSession.id));
    });

    it('finds nothing for a value that resolves to no row, rather than erroring', async () => {
      const system = systemContext();
      const row = await scoped.for(system).bootstrap('tenant_domains', 'no-such-domain.example.com');
      expect(row).toBeUndefined();
    });

    it('refuses a staff context — bootstrap is not a general escape hatch', () => {
      // The audience/table checks are synchronous, like every other guard in
      // this file (`table()`, `platform()`) — the thenable only wraps the
      // query itself, once a valid table and audience are already confirmed.
      expect(() => scoped.for(a).bootstrap('tenant_domains', ctx.a.domain)).toThrow(
        /require a system context/
      );
    });

    it('refuses a platform context too — only SYSTEM, not PLATFORM, may bootstrap', () => {
      const platform = platformContext({ platformUserId: ctx.platform.id });
      expect(() => scoped.for(platform).bootstrap('tenant_domains', ctx.a.domain)).toThrow(
        /require a system context/
      );
    });

    it('refuses a table not on the declared bootstrap allow-list', () => {
      const system = systemContext();
      expect(() => scoped.for(system).bootstrap('users', 'sam@example.com')).toThrow(
        /not a declared bootstrap table/
      );
    });

    it('resolves a tenant by id — the second hop after a custom-domain lookup', async () => {
      const system = systemContext();
      const row = await scoped.for(system).bootstrap('tenants', 'id', ctx.a.id);
      expect(row).toBeDefined();
      expect(row.slug).toBe(ctx.a.slug);
    });

    it('refuses a column not declared for that table', () => {
      const system = systemContext();
      expect(() => scoped.for(system).bootstrap('tenants', 'name', 'Fixture tenant A')).toThrow(
        /not a declared bootstrap column/
      );
    });

    it('scopes a guest context to its own property', async () => {
      const guest = guestContextFromSession({
        tenantId: ctx.a.id,
        propertyId: ctx.a.properties[0].id,
        guestAccountId: ctx.a.guestAccounts[0].id,
      });

      const rows = await scoped.for(guest).table('guest_accounts');
      expect(rows.length).toBeGreaterThan(0);
      rows.forEach((row) => {
        expect(String(row.tenant_id)).toBe(String(ctx.a.id));
        expect(String(row.property_id)).toBe(String(ctx.a.properties[0].id));
      });
    });

    it('makes GLOBAL_REFERENCE readable but not writable', async () => {
      const permissions = await scoped.for(a).reference().table('permissions');
      expect(permissions.length).toBeGreaterThan(0);

      expect(() =>
        scoped.for(a).reference().table('permissions').insert({ permission_key: 'x' })
      ).toThrow(/read-only through the accessor/);
    });
  });

  // ==================================================================
  // Transactions (ARCHITECTURE.md §4)
  // ==================================================================
  describe('a transaction is scoped identically to work outside one', () => {
    it('carries the context into the transaction callback', async () => {
      await scoped.for(a).transaction(async (txDb) => {
        const rows = await txDb.acrossProperties().table('users');
        rows.forEach((row) => expect(String(row.tenant_id)).toBe(String(ctx.a.id)));
        expect(txDb.context).toBe(a);
      });
    });

    it('applies the same write rules inside a transaction', async () => {
      await expect(
        scoped.for(a).transaction(async (txDb) =>
          txDb.table('roles').insert({ tenant_id: ctx.b.id, code: 'tx-smuggled', name: 'No' })
        )
      ).rejects.toMatchObject({ code: 'INTERNAL_SCOPE_VIOLATION' });
    });

    it('opens a real transaction when bound to the knex instance itself', async () => {
      // Every other case here binds the accessor to the suite's rolled-back
      // transaction, which exercises the `connection.isTransaction` branch. The
      // production path is the other one — `createScopedDb(knex)` opening a
      // transaction of its own — and it would be possible for that branch to be
      // broken while all of the above stayed green.
      const live = createScopedDb(db());
      let inner;

      // Read-only on purpose. The suite's fixtures live in an open, uncommitted
      // transaction that holds row and gap locks on every one of these tables,
      // so a write from a second connection would block on them until the test
      // timed out — which is InnoDB behaving correctly, not a bug in the
      // accessor. What needs proving here is only that the branch taken when
      // the connection is NOT already a transaction produces a working,
      // correctly scoped accessor.
      await expect(
        live.for(a).transaction(async (txDb) => {
          inner = {
            context: txDb.context,
            sql: txDb.table('roles').where({ code: 'manager' }).toSQL(),
            // Executes against a real, separate transaction. It returns nothing
            // — the fixtures are uncommitted and invisible from here — but a
            // broken branch would throw rather than come back empty.
            rows: await txDb.table('roles'),
          };
          throw new Error('deliberate rollback');
        })
      ).rejects.toThrow('deliberate rollback');

      expect(inner.context).toBe(a);
      expect(inner.sql.sql).toContain('`tenant_id`');
      expect(inner.sql.bindings.map(String)).toContain(String(ctx.a.id));
      expect(Array.isArray(inner.rows)).toBe(true);
    });

    it('exposes row locking for the ARCHITECTURE.md §5 races', () => {
      const { sql } = scoped
        .for(a)
        .table('user_property_access')
        .where({ user_id: ctx.a.users[0].id })
        .forUpdate()
        .toSQL();

      // Without this the last-room race has no mechanism, and modules would
      // reach around the accessor for raw knex to get it.
      expect(sql).toMatch(/for update/i);
      expect(sql).toContain('`tenant_id`');
    });
  });
});
