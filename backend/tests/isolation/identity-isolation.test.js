'use strict';

/**
 * Isolation suite — the three identity populations and per-property roles.
 *
 * SECURITY.md §2–4, API.md §4. Two things are being asserted:
 *
 *  1. A tenant cannot be paired with another tenant's user, property or role,
 *     because the composite foreign keys make the row unstorable — not because
 *     a service function remembered to check. SECURITY.md §2: "the
 *     architecture, not developer discipline, is the control."
 *
 *  2. A role is only ever answerable for a (user, property) pair. SECURITY.md
 *     §4: `manager` at property A and `front_desk` at property B is the normal
 *     case, so there is no global role to read and `user.role === 'manager'` is
 *     not expressible against this schema.
 *
 * Precursors, in the sense that ISO-1/ISO-6 and AUTH-12/AUTH-13/PRT-1 also have
 * an HTTP half (404, 403, 401) that arrives with the routes.
 */

const { useRolledBackTransaction } = require('../helpers/db');
const {
  seedTwoTenants,
  seedPlatformUser,
  expectInterleavedIds,
  PASSWORD_HASH,
} = require('../helpers/fixtures');
const { ENTITIES, ER } = require('../helpers/entities');

const CROSS_TENANT_ENTITIES = ENTITIES.filter((e) => e.crossTenant);

describe('identity isolation', () => {
  const tx = useRolledBackTransaction();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(tx.trx);
    ctx.platform = await seedPlatformUser(tx.trx);
  });

  // ------------------------------------------------------------------
  // The fixture's own precondition
  // ------------------------------------------------------------------
  describe('the two-tenant fixture is actually adversarial (TESTING.md ground rules)', () => {
    it.each([['users'], ['properties'], ['roles'], ['user_property_access'], ['guest_accounts']])(
      '%s: tenant B rows sit between tenant A rows in id order',
      async (table) => {
        const rows = await tx.trx(table).select('id', 'tenant_id').orderBy('id');
        const { interleaved } = expectInterleavedIds(
          rows.filter((r) => String(r.tenant_id) === String(ctx.a.id)).map((r) => r.id),
          rows.filter((r) => String(r.tenant_id) === String(ctx.b.id)).map((r) => r.id)
        );
        // Ids are one global AUTO_INCREMENT sequence per table, so two tenants
        // cannot literally share id 1. Interleaving is the reproducible form of
        // the same hazard: a query that loses its tenant filter returns the
        // neighbouring tenant's row rather than nothing.
        expect(interleaved).toBe(true);
      }
    );

    it('both tenants use the same staff and guest email addresses', async () => {
      const staff = await tx.trx('users').where({ email: 'sam@example.com' }).select('tenant_id');
      expect(staff.map((r) => String(r.tenant_id)).sort()).toEqual(
        [String(ctx.a.id), String(ctx.b.id)].sort()
      );
    });
  });

  // ------------------------------------------------------------------
  // ISO-6's precondition: roles are per property
  // ------------------------------------------------------------------
  describe('a role is per property, never global (SECURITY.md §4)', () => {
    it('has no global role column to read', async () => {
      const columns = await tx
        .trx('information_schema.columns')
        .select('column_name as column')
        .where({ table_schema: tx.trx.client.config.connection.database, table_name: 'users' });
      // If this column existed, `if (user.role === 'manager')` would compile,
      // and it is wrong by construction.
      expect(columns.map((c) => c.column)).not.toContain('role');
    });

    it('lets one user hold different roles at two properties at once', async () => {
      const held = await tx
        .trx('user_property_access')
        .select('property_id', 'role')
        .where({ user_id: ctx.a.users[0].id })
        .orderBy('property_id');

      expect(held).toHaveLength(2);
      expect(held.map((r) => r.role)).toEqual(['manager', 'front_desk']);
    });

    it('answers "manager?" differently for the same user at different properties', async () => {
      const roleAt = async (propertyId) =>
        (
          await tx
            .trx('user_property_access')
            .where({ user_id: ctx.a.users[0].id, property_id: propertyId })
            .first()
        )?.role;

      expect(await roleAt(ctx.a.properties[0].id)).toBe('manager');
      expect(await roleAt(ctx.a.properties[1].id)).toBe('front_desk');
      expect(await roleAt(ctx.a.properties[1].id)).not.toBe('manager');
    });

    it('gives a user no row at all for a property they were never granted (ISO-6)', async () => {
      // The housekeeper works at property 1 only. The denial path is an absent
      // row, which is what the server re-checks on every property-scoped
      // request rather than trusting a client-supplied property header.
      const row = await tx
        .trx('user_property_access')
        .where({ user_id: ctx.a.users[1].id, property_id: ctx.a.properties[1].id })
        .first();
      expect(row).toBeUndefined();
    });

    it('refuses a second role for the same user at the same property', async () => {
      // One role per (user, property), enforced by UNIQUE(user_id, property_id)
      // — so an authorization check can never find two answers and take the
      // more permissive one.
      await expect(
        tx.trx('user_property_access').insert({
          tenant_id: ctx.a.id,
          property_id: ctx.a.properties[0].id,
          user_id: ctx.a.users[0].id,
          role: 'admin',
        })
      ).rejects.toMatchObject({ code: ER.DUPLICATE });
    });

    it('scopes the role vocabulary to the tenant that defined it', async () => {
      // Tenant B defines `group_coordinator`; tenant A does not.
      await expect(
        tx.trx('user_property_access').insert({
          tenant_id: ctx.a.id,
          property_id: ctx.a.properties[1].id,
          user_id: ctx.a.users[1].id,
          role: ctx.b.exclusiveRoleCode,
        })
      ).rejects.toMatchObject({ code: ER.NO_PARENT });

      // ...while its owner may use it.
      await expect(
        tx.trx('user_property_access').insert({
          tenant_id: ctx.b.id,
          property_id: ctx.b.properties[1].id,
          user_id: ctx.b.users[1].id,
          role: ctx.b.exclusiveRoleCode,
        })
      ).resolves.toBeDefined();
    });
  });

  // ------------------------------------------------------------------
  // Cross-tenant pairings, table-driven
  // ------------------------------------------------------------------
  describe('a tenant cannot be paired with another tenant\'s rows (SECURITY.md §2)', () => {
    const cases = CROSS_TENANT_ENTITIES.flatMap((entity) =>
      entity.crossTenant.map((variant) => [entity.table, variant.name, entity, variant])
    );

    it.each(cases)('%s: rejects a row that %s', async (table, _name, _entity, variant) => {
      await expect(tx.trx(table).insert(variant.row(ctx, ctx.a, ctx.b))).rejects.toMatchObject({
        code: ER.NO_PARENT,
      });
    });

    it('rejects the mirror image too — neither tenant is the privileged one', async () => {
      await expect(
        tx.trx('user_property_access').insert({
          tenant_id: ctx.b.id,
          property_id: ctx.a.properties[0].id,
          user_id: ctx.b.users[1].id,
          role: 'manager',
        })
      ).rejects.toMatchObject({ code: ER.NO_PARENT });
    });
  });

  // ------------------------------------------------------------------
  // Three populations (API.md §4, AUTH-12/13, PRT-1/2)
  // ------------------------------------------------------------------
  describe('three identity populations, three tables (SECURITY.md §3)', () => {
    it('keeps staff, platform and guest credentials in separate tables', async () => {
      const tables = await tx
        .trx('information_schema.tables')
        .select('table_name as name')
        .where('table_schema', tx.trx.client.config.connection.database)
        .whereIn('table_name', ['users', 'platform_users', 'guest_accounts']);
      expect(tables.map((t) => t.name).sort()).toEqual(['guest_accounts', 'platform_users', 'users']);
    });

    it('gives platform staff no tenant to belong to (AUTH-13 precondition)', async () => {
      const columns = await tx
        .trx('information_schema.columns')
        .select('column_name as column')
        .where({
          table_schema: tx.trx.client.config.connection.database,
          table_name: 'platform_users',
        });
      const names = columns.map((c) => c.column);
      // No tenant_id means there is no column a platform token could be scoped
      // by — tenant data is reachable only through an audited impersonation
      // grant, never a silent super-admin flag.
      expect(names).not.toContain('tenant_id');
      expect(names).not.toContain('property_id');
    });

    it('gives a guest account no role, at any property (PRT-1 precondition)', async () => {
      const columns = await tx
        .trx('information_schema.columns')
        .select('column_name as column')
        .where({
          table_schema: tx.trx.client.config.connection.database,
          table_name: 'guest_accounts',
        });
      // No role column, and no join table reaching one: a guest holds no role
      // anywhere, so there is nothing for an authorization check to find.
      expect(columns.map((c) => c.column)).not.toContain('role');

      const [fks] = await tx.trx.raw(
        `SELECT REFERENCED_TABLE_NAME AS parent
           FROM information_schema.REFERENTIAL_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'user_property_access'`,
        [tx.trx.client.config.connection.database]
      );
      expect(fks.map((f) => f.parent)).not.toContain('guest_accounts');
    });

    it('gives a guest id that collides with a staff id — which is why the table, not the number, decides', async () => {
      // Each table has its own AUTO_INCREMENT sequence, so a guest_accounts id
      // and a users id can coincide while naming unrelated people. The two
      // sequences are not required to align on their own — a heavier test run
      // elsewhere in the suite can advance one further than the other, since
      // InnoDB does not roll AUTO_INCREMENT back with the transaction — so this
      // test engineers the collision explicitly rather than hoping for one,
      // by inserting a staff row at the guest's own id.
      const guest = await tx.trx('guest_accounts').where({ id: ctx.a.guestAccounts[0].id }).first();

      // Whether this id already coincides with a seeded staff row depends on
      // how far each sequence has drifted from the others by the time this
      // file runs — inserted, not assumed, so the test holds either way.
      const alreadyColliding = await tx.trx('users').where({ id: guest.id }).first();
      if (!alreadyColliding) {
        await tx.trx('users').insert({
          id: guest.id,
          tenant_id: ctx.a.id,
          email: `colliding-${guest.id}@example.com`,
          password_hash: PASSWORD_HASH,
          first_name: 'Colliding',
          last_name: 'Staff',
          status: 'active',
        });
        await tx.trx('user_property_access').insert({
          tenant_id: ctx.a.id,
          property_id: ctx.a.properties[0].id,
          user_id: guest.id,
          role: 'front_desk',
        });
      }

      const collidingStaff = await tx.trx('users').where({ id: guest.id }).first();
      expect(collidingStaff).toBeDefined();

      const grantsUnderThatNumber = await tx
        .trx('user_property_access')
        .where({ user_id: guest.id });
      expect(grantsUnderThatNumber.length).toBeGreaterThan(0);

      // So the separation cannot rest on ids failing to resolve. It rests on
      // the populations living in different tables reached by different route
      // trees (API.md §4): a guest token addresses guest_accounts and can never
      // be looked up in `users`, which is what makes AUTH-12 a 401 rather than
      // a lookup that happens to come back empty.
      expect(collidingStaff.id).toBe(guest.id);
      expect(collidingStaff.password_hash).toBeDefined();
      expect(collidingStaff).not.toMatchObject({ property_id: guest.property_id });
    });

    it('lets the same address exist as staff, guest and platform login without collision', async () => {
      const email = 'sam@example.com';
      await expect(
        tx.trx('guest_accounts').insert({
          tenant_id: ctx.a.id,
          property_id: ctx.a.properties[1].id,
          email,
          password_hash: PASSWORD_HASH,
        })
      ).resolves.toBeDefined();

      await expect(
        tx.trx('platform_users').insert({
          email,
          password_hash: PASSWORD_HASH,
          first_name: 'Sam',
          last_name: 'Ops',
        })
      ).resolves.toBeDefined();

      // Three rows, three tables, three populations — and no shared identity
      // between them, which is what makes AUTH-12 a 401 rather than a lookup
      // that happens to miss.
      const counts = await Promise.all([
        tx.trx('users').where({ email }).count({ n: '*' }),
        tx.trx('guest_accounts').where({ email }).count({ n: '*' }),
        tx.trx('platform_users').where({ email }).count({ n: '*' }),
      ]);
      expect(counts.map((c) => Number(c[0].n))).toEqual([2, 1, 1]);
    });

    it('treats a differently-cased address as the same login, in all three tables', async () => {
      // The uniqueness constraints are only as case-insensitive as the column
      // collation underneath them, and nothing else in the suite would notice a
      // future migration — or a changed server default — creating these columns
      // as utf8mb4_0900_as_cs or utf8mb4_bin. That change is silent and
      // security-relevant in both directions: `SAM@example.com` would become a
      // second staff account nobody expects, and a login lookup by the address
      // the user typed would stop finding the row it should.
      await expect(
        tx.trx('users').insert({
          tenant_id: ctx.a.id,
          email: ctx.a.users[0].email.toUpperCase(),
          password_hash: PASSWORD_HASH,
          first_name: 'Sam',
          last_name: 'Impostor',
        })
      ).rejects.toMatchObject({ code: ER.DUPLICATE });

      await expect(
        tx.trx('guest_accounts').insert({
          tenant_id: ctx.a.id,
          property_id: ctx.a.guestAccounts[0].property_id,
          email: ctx.a.guestAccounts[0].email.toUpperCase(),
          password_hash: PASSWORD_HASH,
        })
      ).rejects.toMatchObject({ code: ER.DUPLICATE });

      await expect(
        tx.trx('platform_users').insert({
          email: ctx.platform.email.toUpperCase(),
          password_hash: PASSWORD_HASH,
          first_name: 'Ops',
          last_name: 'Impostor',
        })
      ).rejects.toMatchObject({ code: ER.DUPLICATE });
    });

    it('defaults platform staff to MFA enabled (SECURITY.md §1.1)', async () => {
      const row = await tx.trx('platform_users').where({ id: ctx.platform.id }).first();
      expect(Boolean(row.mfa_enabled)).toBe(true);
    });

    it('stores only hashes, never a plaintext password (AUTH-11)', async () => {
      const rows = await Promise.all([
        tx.trx('users').where({ id: ctx.a.users[0].id }).first(),
        tx.trx('guest_accounts').where({ id: ctx.a.guestAccounts[0].id }).first(),
        tx.trx('platform_users').where({ id: ctx.platform.id }).first(),
      ]);
      rows.forEach((row) => {
        expect(row.password_hash).toMatch(/^\$2[aby]\$|^\$argon2/);
        expect(row).not.toHaveProperty('password');
      });
    });
  });

  // ------------------------------------------------------------------
  // Lifecycle (DATABASE.md §3)
  // ------------------------------------------------------------------
  describe('identities deactivate, never delete (DATABASE.md §3)', () => {
    it('refuses to delete a user who holds property access', async () => {
      await expect(
        tx.trx('users').where({ id: ctx.a.users[0].id }).del()
      ).rejects.toMatchObject({ code: ER.STILL_REFERENCED });
    });

    it('deactivates instead, leaving the row and its grants intact (SET-7)', async () => {
      await tx.trx('users').where({ id: ctx.a.users[0].id }).update({ status: 'inactive' });

      const user = await tx.trx('users').where({ id: ctx.a.users[0].id }).first();
      expect(user.status).toBe('inactive');

      // The grants survive too: an audit row naming this user at this property
      // must still resolve months later.
      const grants = await tx.trx('user_property_access').where({ user_id: user.id });
      expect(grants.length).toBeGreaterThan(0);
    });
  });
});
