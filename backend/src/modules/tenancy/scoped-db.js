'use strict';

/**
 * The scoped data-access layer — SECURITY.md §2, ARCHITECTURE.md §3.
 *
 *   "Scope at the data-access layer, not per query. Every tenant-owned table is
 *    reached through a scoped accessor that injects `tenant_id` automatically.
 *    A developer forgetting a `WHERE tenant_id = ?` on one query must not be
 *    able to leak data — the architecture, not developer discipline, is the
 *    control."
 *
 * Everything else in Phase 0 — auth, the RBAC middleware, the audit trail — is
 * built on top of this file, so its job is narrow and absolute: given a context
 * and a table name, produce a query that cannot execute without the right
 * `WHERE` clause attached.
 *
 * ── THE THREE LAYERS OF THE GUARANTEE ────────────────────────────────────
 *
 * 1. SCOPE INJECTION. `table()` looks the table up in `table-scopes.js` and
 *    applies the predicates its scope requires. An undeclared table throws
 *    rather than falling back to unscoped — ARCHITECTURE.md §3 leaves no
 *    "unscoped" path to fall back to.
 *
 * 2. A GUARDED SURFACE. The object returned is not a knex query builder. It
 *    exposes a curated set of methods, and top-level `orWhere` is not among
 *    them. This matters more than it looks: knex applies a top-level
 *    `.orWhere()` at the same level as the scope predicate, so
 *    `.where({tenant_id: 1}).orWhere({id: 5})` compiles to
 *    `WHERE tenant_id = 1 OR id = 5` — a query that reads every tenant's rows
 *    while looking perfectly scoped at the call site. Disjunctions are still
 *    available, but only through a callback that is wrapped in its own
 *    parenthesised group, so they can never escape the AND the scope lives in.
 *
 * 3. A TRIPWIRE. Immediately before execution the compiled SQL is checked for
 *    the scope predicate and its binding. Layers 1 and 2 are the control; this
 *    one exists because they are code and code has bugs. It is the only check
 *    that still fires if the facade itself has a hole. See `assertScopeSurvives`
 *    for an honest account of what it can and cannot catch.
 *
 * ── WHAT THIS FILE DOES NOT DO ───────────────────────────────────────────
 *
 * It does not authorize. Whether the user may act at the active property is
 * `user_property_access`'s question, answered by the auth layer before a context
 * is built (SECURITY.md §3). This file assumes the context is already true and
 * makes sure every query honours it.
 *
 * It also cannot stop a module importing `knex` directly and bypassing all of
 * the above. Nothing at runtime can. That is a lint rule and a review rule —
 * CLAUDE.md: "raw table access in a module is a review-blocking defect."
 */

const { SCOPES, scopeOf } = require('../../shared/table-scopes');

/**
 * The bootstrap read allow-list — SECURITY.md §2's one deliberate, narrow
 * exception to "every tenant-owned table is reached through a scoped accessor
 * that injects tenant_id".
 *
 * Five reads structurally cannot go through `table()`, because the whole point
 * of each one is to discover a tenant_id (or a user_id) that no context yet
 * carries: resolving the Host header to a tenant before login runs a single
 * query, and looking up a presented refresh/reset/invitation token before its
 * owner is known. `table()`'s guarantee — inject the scope the caller already
 * has — has nothing to inject yet at this point in a request.
 *
 * What keeps this from being a hole in the guarantee rather than a documented
 * exception to it:
 *
 *   - Every column here carries a real, migration-declared UNIQUE constraint
 *     (`tenants.slug`, `tenant_domains.domain`, `sessions.refresh_token_hash`,
 *     `password_resets.token_hash`, `user_invitations.token_hash`). A caller
 *     can resolve the one row a value they already possess maps to; they
 *     cannot browse, list, or guess, because an exact-match lookup on a unique
 *     column returns at most one row no matter who asks.
 *   - Only a SYSTEM context can call it — see `context.js` — and SYSTEM is
 *     never built from a request. It is wired directly into `src/auth`'s own
 *     service code.
 *   - It is a single named function, not a general escape hatch: adding a
 *     table here is a reviewable, one-line diff naming a real unique column,
 *     not an open door another module could route arbitrary reads through.
 */
const BOOTSTRAP_TABLES = Object.freeze({
  // `tenants` gets two: `slug` resolves the default subdomain, `id` is the
  // second hop after a custom-domain lookup already found `tenant_domains`'s
  // `tenant_id` and needs the tenant's own row (status, in particular) —
  // `id` is safe to add here on exactly the same reasoning as every other
  // entry: it is a primary key, so a lookup by it names one row by
  // construction, the same guarantee a UNIQUE column gives.
  tenants: ['slug', 'id'],
  tenant_domains: ['domain'],
  sessions: ['refresh_token_hash'],
  password_resets: ['token_hash'],
  user_invitations: ['token_hash'],
});
const { AUDIENCES } = require('./context');
const {
  ScopeContextError,
  ScopeDeclarationError,
  ScopeViolationError,
} = require('../../shared/errors');

/**
 * Which columns a table's scope requires on every query against it, and the
 * values this context supplies for them.
 *
 * The two `scopeRoot` tables are the interesting cases, because their own
 * primary key *is* the scope column rather than something they carry:
 *
 *   tenants     `id = :tenantId`. A tenant can only ever see its own row.
 *
 *   properties  `tenant_id = :tenantId`, and deliberately NOT `id = :propertyId`.
 *               Constraining a property query to the active property would make
 *               the property switcher impossible to build: "which properties may
 *               I work at" is the query that runs *before* an active property
 *               exists (SECURITY.md §3). Its own id is the property dimension,
 *               so pinning it is the caller's choice, not the accessor's.
 */
function scopeRequirements(table, context, { acrossProperties }) {
  const declared = scopeOf(table); // throws for an undeclared table
  const { scope, scopeRoot } = declared;

  if (scope === SCOPES.PLATFORM || scope === SCOPES.GLOBAL) {
    // Reached only through the named entry points below, which have already
    // checked the audience. Nothing to inject.
    return [];
  }

  if (!context.tenantId) {
    throw new ScopeContextError(
      `Table "${table}" is ${scope} and this context carries no tenant. ` +
        'Platform staff reach tenant data only through an audited impersonation grant (SECURITY.md §2).',
      { table, scope, audience: context.audience }
    );
  }

  const required = [
    { column: scopeRoot === 'tenant' ? 'id' : 'tenant_id', value: context.tenantId },
  ];

  if (scope === SCOPES.PROPERTY && scopeRoot !== 'property' && !acrossProperties) {
    if (!context.propertyId) {
      // TESTING.md ISO-6 at the data layer: no active property means no
      // property-scoped data, rather than all of the tenant's property-scoped
      // data.
      throw new ScopeContextError(
        `Table "${table}" is PROPERTY_SCOPED and this context has no active property. ` +
          'Select one with withActiveProperty(), or use acrossProperties() if the query ' +
          'is deliberately tenant-wide.',
        { table }
      );
    }
    required.push({ column: 'property_id', value: context.propertyId });
  }

  return required;
}

/**
 * The tripwire (layer 3).
 *
 * Checks the compiled statement mentions each required column and binds its
 * value. Deliberately a coarse check, and worth being honest about its limits:
 * it proves a scope predicate and its value reached the SQL, not that they were
 * combined with AND, nor that an alias resolves to the table we think. A
 * determined bypass would defeat it.
 *
 * That is fine, because it is not the control — layers 1 and 2 are. This exists
 * to turn "the accessor had a bug and silently returned another tenant's rows"
 * into a loud failure, and it catches the whole class of bug where the predicate
 * is simply absent, which is what an accessor regression actually looks like.
 */
function assertScopeSurvives({ sql, bindings }, required, table) {
  for (const { column, value } of required) {
    if (!sql.includes(`\`${column}\``)) {
      throw new ScopeViolationError(
        `Query against "${table}" compiled without a ${column} predicate. ` +
          'The scoped accessor produced an unscoped statement — this is a bug in the accessor, not in the caller.',
        { table, column, sql }
      );
    }

    const bound = bindings.some((binding) => String(binding) === String(value));
    if (!bound) {
      throw new ScopeViolationError(
        `Query against "${table}" compiled without binding ${column} = ${value}. ` +
          'The scope column is named in the statement but carries a different value.',
        { table, column, expected: value, sql }
      );
    }
  }
}

/**
 * The restricted builder handed to a `where(callback)` group.
 *
 * Inside a group, `orWhere` is safe — the group is parenthesised and sits within
 * the AND that carries the scope — so this is where disjunctions are allowed to
 * live. Nested callbacks are wrapped again, so the property holds at any depth.
 */
function groupBuilder(qb) {
  const wrap = (method) => (arg, ...rest) => {
    if (typeof arg === 'function') {
      qb[method](function nested() {
        arg(groupBuilder(this));
      });
    } else {
      qb[method](arg, ...rest);
    }
    return groupBuilder(qb);
  };

  return {
    where: wrap('where'),
    orWhere: wrap('orWhere'),
    whereNot: wrap('whereNot'),
    orWhereNot: wrap('orWhereNot'),
    whereIn: (column, values) => (qb.whereIn(column, values), groupBuilder(qb)),
    orWhereIn: (column, values) => (qb.orWhereIn(column, values), groupBuilder(qb)),
    whereNotIn: (column, values) => (qb.whereNotIn(column, values), groupBuilder(qb)),
    whereNull: (column) => (qb.whereNull(column), groupBuilder(qb)),
    orWhereNull: (column) => (qb.orWhereNull(column), groupBuilder(qb)),
    whereNotNull: (column) => (qb.whereNotNull(column), groupBuilder(qb)),
    whereBetween: (column, range) => (qb.whereBetween(column, range), groupBuilder(qb)),
    whereLike: (column, pattern) => (qb.whereLike(column, pattern), groupBuilder(qb)),
  };
}

/**
 * A guarded query over one table.
 *
 * Returned by `table()`. Thenable, so it is awaited like a knex builder, but it
 * is not one — the scope predicates are applied at construction and the terminal
 * `then` runs the tripwire before anything reaches the database.
 */
function guardedQuery({ connection, table, required, context, scope }) {
  const qb = connection(table);
  required.forEach(({ column, value }) => qb.where(`${table}.${column}`, value));

  // Set once a condition has been added, so `insert` can refuse to run against
  // a builder that carries a WHERE — which would silently be ignored and is
  // always a mistake at the call site rather than a harmless no-op.
  let conditioned = false;

  const api = {};

  const condition = (method) => (arg, ...rest) => {
    conditioned = true;
    if (typeof arg === 'function') {
      // The disjunction escape hatch of layer 2: the caller's conditions go
      // inside their own group, so an orWhere within them cannot reach up to
      // the level the scope predicate sits at.
      qb[method](function group() {
        arg(groupBuilder(this));
      });
    } else {
      qb[method](arg, ...rest);
    }
    return api;
  };

  const passthrough = (method) => (...args) => {
    qb[method](...args);
    return api;
  };

  Object.assign(api, {
    // Conditions. Note the absence of `orWhere` — see layer 2 in the file header.
    where: condition('where'),
    whereNot: condition('whereNot'),
    whereIn: passthrough('whereIn'),
    whereNotIn: passthrough('whereNotIn'),
    whereNull: passthrough('whereNull'),
    whereNotNull: passthrough('whereNotNull'),
    whereBetween: passthrough('whereBetween'),
    whereLike: passthrough('whereLike'),

    // Shaping.
    select: passthrough('select'),
    distinct: passthrough('distinct'),
    orderBy: passthrough('orderBy'),
    groupBy: passthrough('groupBy'),
    limit: passthrough('limit'),
    offset: passthrough('offset'),

    /**
     * Row locks — ARCHITECTURE.md §5. The last-room race, double settlement and
     * room assignment all require `SELECT ... FOR UPDATE` rather than a
     * check-then-write, so the accessor has to expose it or those modules will
     * reach around it for raw knex.
     */
    forUpdate: passthrough('forUpdate'),
    forShare: passthrough('forShare'),

    /**
     * Joins another scoped table, applying that table's own scope to the ON
     * clause.
     *
     * In the ON rather than the WHERE deliberately: for a left join, a scope
     * predicate in the WHERE clause discards the unmatched rows and quietly
     * turns it into an inner join. In the ON it is correct for both.
     */
    joinScoped(otherTable, onCallback, { type = 'inner' } = {}) {
      const otherRequired = scopeRequirements(otherTable, context, {
        acrossProperties: false,
      });
      const method = type === 'left' ? 'leftJoin' : 'innerJoin';

      qb[method](otherTable, function on() {
        // Called with the join clause as both `this` and the first argument, so
        // either knex idiom works at the call site — `function () { this.on(…) }`
        // and `(join) => join.on(…)` are equally common and neither should be a
        // trap.
        onCallback.call(this, this);
        otherRequired.forEach(({ column, value }) => {
          this.on(`${otherTable}.${column}`, '=', connection.raw('?', [value]));
        });
      });

      // The joined table's predicates must survive to execution too.
      otherRequired.forEach((r) => required.push(r));
      return api;
    },

    /**
     * Writes. `tenant_id` and `property_id` are injected rather than accepted:
     * a caller supplying them is at best redundant and at worst the exact
     * attack SECURITY.md §2 describes, so a conflicting value is a violation
     * rather than an override.
     */
    async insert(rows) {
      if (conditioned) {
        throw new ScopeViolationError(
          `insert() was called on a query against "${table}" that already carries WHERE conditions. ` +
            'Those conditions would be silently ignored.',
          { table }
        );
      }

      const list = Array.isArray(rows) ? rows : [rows];
      const prepared = list.map((row) => {
        const next = { ...row };
        for (const { column, value } of required) {
          // `tenants.id` is a scope root: the accessor must not invent a
          // primary key, so only genuine scope columns are injected.
          if (column === 'id') continue;
          if (next[column] !== undefined && String(next[column]) !== String(value)) {
            throw new ScopeViolationError(
              `Insert into "${table}" supplied ${column}=${next[column]} while the context is ${value}. ` +
                'Scope columns come from the session, never from the payload (SECURITY.md §2).',
              { table, column, supplied: next[column], expected: value }
            );
          }
          next[column] = value;
        }
        return next;
      });

      return connection(table).insert(prepared);
    },

    async update(changes) {
      for (const { column, value } of required) {
        if (changes[column] !== undefined && String(changes[column]) !== String(value)) {
          throw new ScopeViolationError(
            `Update on "${table}" tried to set ${column}=${changes[column]}, moving the row out of its scope.`,
            { table, column, supplied: changes[column], expected: value }
          );
        }
      }
      assertScopeSurvives(qb.clone().update(changes).toSQL(), required, table);
      return qb.update(changes);
    },

    async delete() {
      assertScopeSurvives(qb.clone().delete().toSQL(), required, table);
      return qb.delete();
    },

    // Terminals.
    first(...columns) {
      qb.first(...(columns.length ? columns : ['*']));
      return api;
    },

    async count(column = '*') {
      const counted = qb.clone().count({ n: column });
      assertScopeSurvives(counted.toSQL(), required, table);
      const [row] = await counted;
      return Number(row.n);
    },

    /** The compiled statement, for tests and for debugging. Never executes. */
    toSQL: () => qb.toSQL(),

    /** The scope actually applied, so a test can assert it rather than infer it. */
    appliedScope: () => ({ scope, required: required.map((r) => ({ ...r })) }),

    then(onFulfilled, onRejected) {
      // The tripwire fires here, on the way to the database, for every read that
      // is awaited — which is every read, since the builder is inert until then.
      let promise;
      try {
        assertScopeSurvives(qb.toSQL(), required, table);
        promise = Promise.resolve(qb);
      } catch (error) {
        promise = Promise.reject(error);
      }
      return promise.then(onFulfilled, onRejected);
    },

    catch(onRejected) {
      return api.then(undefined, onRejected);
    },
  });

  return api;
}

/**
 * Binds a context to a connection (the knex instance, or a transaction).
 */
function accessorFor(connection, context) {
  const build = ({ acrossProperties }) => (table) =>
    guardedQuery({
      connection,
      table,
      required: scopeRequirements(table, context, { acrossProperties }),
      context,
      scope: scopeOf(table).scope,
    });

  const accessor = {
    context,

    /** The default path: full scope for the table's declared scope. */
    table: build({ acrossProperties: false }),

    /**
     * The bootstrap read — see BOOTSTRAP_TABLES above. Only a SYSTEM context
     * can reach this; every other audience throws.
     *
     * `.bootstrap(table, value)` uses the table's default (first-declared)
     * column; `.bootstrap(table, column, value)` names one explicitly, needed
     * only where a table declares more than one (currently just `tenants`).
     */
    bootstrap: (table, columnOrValue, maybeValue) => {
      const explicit = maybeValue !== undefined;
      const column = explicit ? columnOrValue : (BOOTSTRAP_TABLES[table] || [])[0];
      const value = explicit ? maybeValue : columnOrValue;
      return bootstrapLookup(connection, context, table, column, value);
    },

    /**
     * A deliberately verbose escape for tenant-wide reads of PROPERTY_SCOPED
     * tables.
     *
     * `tenant_id` is still applied — this never widens beyond the tenant, and
     * there is no form of this accessor that does. What it drops is the
     * `property_id` predicate, which two legitimate cases need:
     *
     *   - Login. "Which properties may this user work at" reads
     *     `user_property_access` across the tenant, before an active property
     *     exists to filter by (SECURITY.md §3).
     *   - The multi-property module (PRODUCT_REQUIREMENTS.md §3.13), whose whole
     *     purpose is consolidated views across a tenant's properties.
     *
     * It reads as loudly as it does at the call site because it should be
     * visible in review: `db.for(ctx).acrossProperties().table('reservations')`
     * is a claim that the query is meant to span properties.
     */
    acrossProperties: () => ({ table: build({ acrossProperties: true }) }),

    /**
     * PLATFORM_SCOPED tables — `platform_users`, and later `plans` and
     * `impersonation_sessions`. Requires a platform context, so a staff token
     * cannot reach the platform console's tables even if it names them.
     */
    platform: () => {
      // PLATFORM and SYSTEM are both admitted here, deliberately. PLATFORM is
      // an authenticated platform_users row (SECURITY.md §2's audited console
      // access); SYSTEM is context.js's `systemContext()` — internal
      // bookkeeping with no actor at all, used by the auth module to write
      // `auth_events` for a login that has not resolved to anyone. Neither a
      // staff nor a guest context ever satisfies this check, so a wrong-audience
      // token still cannot reach a PLATFORM_SCOPED table (API.md §4).
      if (context.audience !== AUDIENCES.PLATFORM && context.audience !== AUDIENCES.SYSTEM) {
        throw new ScopeContextError(
          'PLATFORM_SCOPED tables require a platform or system context (API.md §4 — a wrong-audience token is rejected).',
          { audience: context.audience }
        );
      }
      return {
        table: (table) => {
          const { scope } = scopeOf(table);
          if (scope !== SCOPES.PLATFORM) {
            throw new ScopeContextError(
              `Table "${table}" is ${scope}, not PLATFORM_SCOPED. A platform context reaches tenant data ` +
                'only through an audited impersonation grant (SECURITY.md §2).',
              { table, scope }
            );
          }
          return guardedQuery({ connection, table, required: [], context, scope });
        },
      };
    },

    /**
     * GLOBAL_REFERENCE tables — the seeded, tenant-independent catalogues.
     * Read-only: ARCHITECTURE.md §3 reserves this scope for data "never editable
     * by a tenant", so the accessor offers no write path to it at all. Seeding
     * is a migration or a seed file, which run outside this layer.
     */
    reference: () => ({
      table: (table) => {
        const { scope } = scopeOf(table);
        if (scope !== SCOPES.GLOBAL) {
          throw new ScopeContextError(
            `Table "${table}" is ${scope}, not GLOBAL_REFERENCE.`,
            { table, scope }
          );
        }
        const query = guardedQuery({ connection, table, required: [], context, scope });
        const refuse = (verb) => () => {
          throw new ScopeContextError(
            `GLOBAL_REFERENCE table "${table}" is read-only through the accessor; ` +
              `${verb} it in a migration or seed instead (ARCHITECTURE.md §3).`,
            { table }
          );
        };
        return Object.assign(Object.create(query), {
          insert: refuse('insert into'),
          update: refuse('update'),
          delete: refuse('delete from'),
        });
      },
    }),

    /**
     * Runs `callback` inside a database transaction, handing it an accessor
     * bound to the same context and that transaction.
     *
     * ARCHITECTURE.md §4 requires a transaction for every financial and
     * state-changing operation, and the point of binding the context through is
     * that work inside a transaction is scoped identically to work outside one —
     * there is no second, laxer path that appears once you open a transaction.
     */
    transaction(callback) {
      if (connection.isTransaction) {
        // Already inside one. knex would open a savepoint; the callers this
        // layer serves want one transaction per operation (§4), and a nested
        // savepoint that silently succeeds while its parent rolls back is a
        // confusing way to find that out.
        return callback(accessor);
      }
      return connection.transaction((trx) => callback(accessorFor(trx, context)));
    },
  };

  return accessor;
}

/**
 * The module's entry point: wrap a knex instance once at startup, then call
 * `.for(context)` per request.
 */
/**
 * The bootstrap read itself. See `BOOTSTRAP_TABLES` above for what this is and
 * is not licensed to do.
 *
 * Returns the raw row (or undefined) with NO scope predicate applied beyond
 * the exact-match on the declared unique column — there is no tenant_id to
 * filter by yet, which is the reason this function exists. The caller's very
 * next step is almost always to take `tenant_id` off the returned row and
 * build a real context (`contextFromSession`, or a fresh `table()` call) for
 * everything that follows; nothing downstream of this call is exempt from the
 * ordinary guarantee.
 */
function bootstrapLookup(connection, context, table, column, value) {
  if (context.audience !== AUDIENCES.SYSTEM) {
    throw new ScopeContextError(
      'Bootstrap lookups require a system context (src/modules/tenancy/context.js) — ' +
        'they exist to resolve identity before one is known, not as a general escape hatch.',
      { audience: context.audience, table }
    );
  }

  const allowedColumns = BOOTSTRAP_TABLES[table];
  if (!allowedColumns) {
    throw new ScopeContextError(
      `"${table}" is not a declared bootstrap table. Add it to BOOTSTRAP_TABLES in ` +
        'scoped-db.js only if it is looked up by a genuinely unique column before a ' +
        'tenant context exists — this is not a general-purpose unscoped read path.',
      { table }
    );
  }
  if (!allowedColumns.includes(column)) {
    throw new ScopeContextError(
      `"${table}.${column}" is not a declared bootstrap column. Add it to BOOTSTRAP_TABLES in ` +
        'scoped-db.js only if it is a genuinely unique column (a UNIQUE constraint or the primary ' +
        "key) that needs to be looked up before a tenant context exists — this is not a " +
        'general-purpose unscoped read path.',
      { table, column }
    );
  }

  const query = connection(table).where(column, value).first();
  return {
    async then(onFulfilled, onRejected) {
      let promise;
      try {
        assertScopeSurvives(query.toSQL(), [{ column, value }], table);
        promise = query;
      } catch (error) {
        promise = Promise.reject(error);
      }
      return promise.then(onFulfilled, onRejected);
    },
    catch(onRejected) {
      return this.then(undefined, onRejected);
    },
  };
}

function createScopedDb(knex) {
  if (!knex) throw new Error('createScopedDb requires a knex instance.');

  return {
    for(context) {
      if (!context || !context.audience) {
        throw new ScopeContextError(
          'The scoped accessor requires a context built by src/modules/tenancy/context.js. ' +
            'tenant_id comes from the session, never from the request (SECURITY.md §2).'
        );
      }
      return accessorFor(knex, context);
    },
  };
}

module.exports = {
  createScopedDb,
  // Exported for the isolation suite, which asserts the rules directly rather
  // than only through their effects.
  scopeRequirements,
  assertScopeSurvives,
  ScopeDeclarationError,
  BOOTSTRAP_TABLES,
};
