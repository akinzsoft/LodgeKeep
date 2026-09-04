'use strict';

/**
 * Isolation suite — scope declarations and the constraints they rest on.
 *
 * Table-driven over `tests/helpers/entities.js` (TESTING.md Part 1), so a table
 * added to `src/shared/table-scopes.js` inherits every check here the moment it
 * is registered — and fails the suite if it is registered without fixtures.
 *
 * These are the database-level guarantees underneath ISO-1..ISO-8. The HTTP
 * assertions in those cases (404 for another tenant's record, 403 for a
 * property the user has no access to) land when routes and the scoped accessor
 * exist; this file asserts the schema those routes will sit on, because a route
 * cannot leak what the schema refuses to store.
 */

const { db, useRolledBackTransaction } = require('../helpers/db');
const { seedTwoTenants, seedPlatformUser } = require('../helpers/fixtures');
const { ENTITIES, ER } = require('../helpers/entities');
const { TABLE_SCOPES, SCOPES, scopeOf } = require('../../src/shared/table-scopes');

const TABLES = ENTITIES.map((e) => e.table);

describe('entity scoping (ARCHITECTURE.md §3)', () => {
  const tx = useRolledBackTransaction();
  let ctx;
  let columns;
  let indexes;
  let foreignKeys;
  let fkColumns;
  let schema;

  beforeAll(async () => {
    schema = db().client.config.connection.database;
    ctx = await seedTwoTenants(tx.trx);
    ctx.platform = await seedPlatformUser(tx.trx);

    columns = await tx
      .trx('information_schema.columns')
      .select(
        'table_name as table',
        'column_name as column',
        'column_type as type',
        'is_nullable as nullable'
      )
      .where('table_schema', schema)
      .whereIn('table_name', TABLES);

    indexes = await tx
      .trx('information_schema.statistics')
      .select(
        'table_name as table',
        'index_name as index',
        'column_name as column',
        'seq_in_index as seq',
        'non_unique as nonUnique'
      )
      .where('table_schema', schema)
      .whereIn('table_name', TABLES);

    const [rows] = await tx.trx.raw(
      `SELECT rc.TABLE_NAME AS 'table', rc.CONSTRAINT_NAME AS name,
              rc.REFERENCED_TABLE_NAME AS parent, rc.DELETE_RULE AS onDelete,
              rc.UPDATE_RULE AS onUpdate
         FROM information_schema.REFERENTIAL_CONSTRAINTS rc
        WHERE rc.CONSTRAINT_SCHEMA = ?`,
      [schema]
    );
    foreignKeys = rows.filter((f) => TABLES.includes(f.table));

    // Every column that participates in a foreign key, across all of these
    // tables, in one query — feeds the BIGINT UNSIGNED check below without an
    // N+1 over `fkColumnsOf`.
    const fkColumnRows = await tx
      .trx('information_schema.key_column_usage')
      .select('table_name as table', 'column_name as column')
      .where({ table_schema: schema })
      .whereIn('table_name', TABLES)
      .whereNotNull('referenced_table_name');
    fkColumns = new Set(fkColumnRows.map((r) => `${r.table}.${r.column}`));
  });

  const columnsOf = (table) => columns.filter((c) => c.table === table).map((c) => c.column);
  const has = (table, column) => columnsOf(table).includes(column);

  const uniqueKeysOf = (table) => {
    const grouped = {};
    indexes
      .filter((r) => r.table === table && Number(r.nonUnique) === 0)
      .sort((x, y) => x.seq - y.seq)
      .forEach((r) => {
        (grouped[r.index] = grouped[r.index] || []).push(r.column);
      });
    return Object.values(grouped);
  };

  const fkColumnsOf = async (table, name) => {
    const rows = await tx
      .trx('information_schema.key_column_usage')
      .select('column_name as column', 'ordinal_position as pos')
      .where({ table_schema: schema, table_name: table, constraint_name: name })
      .orderBy('pos');
    return rows.map((r) => r.column);
  };

  // ------------------------------------------------------------------
  // The registry itself
  // ------------------------------------------------------------------
  describe('the registry covers every declared table', () => {
    it('every table with a scope declaration has isolation fixtures', () => {
      const declared = Object.keys(TABLE_SCOPES);
      const missing = declared.filter((t) => !TABLES.includes(t));
      expect(missing).toEqual([]);
    });

    it('every registered entity declares a scope — there is no unscoped query path', () => {
      TABLES.forEach((t) => expect(() => scopeOf(t)).not.toThrow());
    });
  });

  // ------------------------------------------------------------------
  // Declared scope vs. actual columns
  // ------------------------------------------------------------------
  describe.each(ENTITIES.map((e) => [e.table, e]))('%s', (table, entity) => {
    const declared = () => TABLE_SCOPES[table];

    it('carries exactly the columns its scope requires', () => {
      const { scope, scopeRoot, attributionColumns = [] } = declared();
      const needsTenant = scope === SCOPES.TENANT || scope === SCOPES.PROPERTY;
      const needsProperty = scope === SCOPES.PROPERTY;

      // A scope root defines the column rather than carrying it: tenants.id IS
      // the tenant_id, properties.id IS the property_id.
      //
      // `attributionColumns` is the one declared way a table may carry a scope
      // column its scope does not require — `auth_events` records who an event
      // was about, including events with no tenant to resolve. The next test
      // is what keeps that from being a loophole.
      const permitted = (column, byScope) => byScope || attributionColumns.includes(column);

      expect(has(table, 'tenant_id')).toBe(
        permitted('tenant_id', needsTenant && scopeRoot !== 'tenant')
      );
      expect(has(table, 'property_id')).toBe(
        permitted('property_id', needsProperty && scopeRoot !== 'property')
      );
    });

    it('declares any attribution column as nullable, so it cannot act as scope', () => {
      const { attributionColumns = [] } = declared();
      if (attributionColumns.length === 0) return;

      // The point of the distinction. A NOT NULL `tenant_id` on a table that
      // declares PLATFORM_SCOPED would be a tenant-owned table with no scope
      // enforcement — the exact shape SECURITY.md §2 exists to prevent. Nullable
      // is what makes it attribution: the column may be absent, so nothing can
      // depend on it to isolate anything.
      attributionColumns.forEach((column) => {
        const found = columns.find((c) => c.table === table && c.column === column);
        expect(`${column}: ${found && found.nullable}`).toBe(`${column}: YES`);
      });
    });

    it('uses BIGINT UNSIGNED for its primary key and every foreign key (ARCHITECTURE.md §10)', () => {
      // Driven by what actually participates in a foreign key (plus `id`
      // itself), not a `/_id$/` name match — a name match is both too broad
      // (auth_events.request_id correlates to a request, per API.md §2's
      // "req_9f2c1a", and is a VARCHAR by design, not a row reference) and too
      // narrow (a scope-root table's `id` IS the tenant_id/property_id other
      // tables reference, without itself being named tenant_id).
      //
      // One deliberate exception: `(tenant_id, role)` on user_property_access
      // and user_invitations references `roles(tenant_id, code)` — a natural
      // key, not the surrogate `roles.id` — because `role` is meant to read as
      // the machine code (SECURITY.md §5's 'front_desk', 'manager', ...)
      // wherever it is stored, not as an opaque id a query has to join to
      // interpret. ARCHITECTURE.md §10's BIGINT UNSIGNED rule is about
      // surrogate primary keys; this FK was never one.
      const NATURAL_KEY_FKS = new Set(['user_property_access.role', 'user_invitations.role']);

      const idColumns = columns.filter(
        (c) =>
          c.table === table &&
          (c.column === 'id' || fkColumns.has(`${table}.${c.column}`)) &&
          !NATURAL_KEY_FKS.has(`${table}.${c.column}`)
      );
      expect(idColumns.length).toBeGreaterThan(0);
      idColumns.forEach((c) => expect(`${c.column}: ${c.type}`).toBe(`${c.column}: bigint unsigned`));
    });

    it('declares the unique constraints DATABASE.md §2 requires', () => {
      const actual = uniqueKeysOf(table).map((cols) => cols.join(','));
      entity.uniqueKeys.forEach((expected) => expect(actual).toContain(expected.join(',')));
    });

    if (ENTITIES.find((e) => e.table === table)) {
      it('indexes lead with tenant_id where the table carries one', () => {
        if (!has(table, 'tenant_id')) return;
        const leading = indexes
          .filter((r) => r.table === table && r.seq === 1 && r.index !== 'PRIMARY')
          .map((r) => r.column);
        expect(leading).toContain('tenant_id');
      });
    }

    it('uses RESTRICT on every foreign key — never CASCADE (ARCHITECTURE.md §3, §8)', () => {
      foreignKeys
        .filter((f) => f.table === table)
        .forEach((f) => {
          expect(`${f.name}: ${f.onDelete}/${f.onUpdate}`).toBe(`${f.name}: RESTRICT/RESTRICT`);
        });
    });

    it('references its parents by scope, not by bare id', async () => {
      const { scopeRoot } = declared();

      // Column-driven rather than scope-driven, to match the users rule below:
      // any table carrying a property_id inherits this the moment it is added,
      // including `auth_events`, whose property_id is attribution rather than
      // scope but must still name a property belonging to the tenant it claims.
      if (!has(table, 'property_id') || scopeRoot === 'property') return;

      // A PROPERTY_SCOPED table reaches `properties` through (tenant_id,
      // property_id). Referencing property_id alone would let a row pair one
      // tenant's id with another tenant's property, leaving the tenant check to
      // application code — the thing SECURITY.md §2 says must not be the
      // control.
      const toProperties = foreignKeys.filter((f) => f.table === table && f.parent === 'properties');
      expect(toProperties.length).toBeGreaterThan(0);

      for (const fk of toProperties) {
        expect(await fkColumnsOf(table, fk.name)).toEqual(['tenant_id', 'property_id']);
      }
    });

    it('reaches users through (tenant_id, user_id), never a bare user_id', async () => {
      // The same rule as the properties check above, applied to the other
      // parent a tenant-owned row commonly hangs off. A bare `user_id`
      // reference is the subtle version of the cross-tenant bug: the row still
      // names a real user, and the FK still passes, but nothing stops that user
      // belonging to a different tenant than the row claims — leaving the check
      // to application code, which SECURITY.md §2 says must not be the control.
      //
      // Stated generically rather than per-table so a table added later cannot
      // reintroduce it: the moment a new table carries a user_id, it inherits
      // this assertion.
      if (!has(table, 'user_id')) return;

      const toUsers = foreignKeys.filter((f) => f.table === table && f.parent === 'users');
      expect(toUsers.length).toBeGreaterThan(0);

      for (const fk of toUsers) {
        expect(await fkColumnsOf(table, fk.name)).toEqual(['tenant_id', 'user_id']);
      }
    });
  });

  // ------------------------------------------------------------------
  // The constraints, exercised rather than merely present
  // ------------------------------------------------------------------
  describe.each(ENTITIES.map((e) => [e.table, e]))('%s constraints hold at runtime', (table, entity) => {
    it('accepts a valid new row', async () => {
      await expect(tx.trx(table).insert(entity.newRow(ctx, ctx.a))).resolves.toBeDefined();
    });

    it('declares a duplicateRow case for every unique key it claims', () => {
      // An append-only log has no natural unique key and legitimately declares
      // none (`auth_events`). This assertion is what stops that being a way to
      // drop the collision case from a table that does have one.
      if (entity.uniqueKeys.length > 0) expect(typeof entity.duplicateRow).toBe('function');
    });

    if (entity.duplicateRow) {
      it('rejects a row that collides on its unique key', async () => {
        await expect(tx.trx(table).insert(entity.duplicateRow(ctx, ctx.a))).rejects.toMatchObject({
          code: ER.DUPLICATE,
        });
      });
    }

    if (entity.restrictDelete) {
      it(`refuses to delete ${entity.restrictDelete.name}`, async () => {
        await expect(
          tx.trx(table).where({ id: entity.restrictDelete.id(ctx, ctx.a) }).del()
        ).rejects.toMatchObject({ code: ER.STILL_REFERENCED });
      });
    }
  });
});
