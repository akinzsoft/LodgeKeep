'use strict';

/**
 * Self-service tenant signup — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md
 * §3.22: "self-service signup creates the tenant record, the first admin
 * user, and an empty property ready for setup (3.19). No engineer in the
 * loop."
 *
 * ── ONE TRANSACTION, START TO FINISH (ARCHITECTURE.md §4) ────────────────
 *
 * Every insert that provisions the tenant — the tenant row itself, its
 * property, its seven roles, their full permission grants, the signup-
 * registry row, the first admin user, and that user's property access —
 * happens inside one database transaction. A failure at ANY step rolls
 * back everything before it: no orphaned tenant if the admin user's insert
 * fails, no orphaned user if the property insert fails, no partially
 * granted role. This is possible only because `scopedDb.provisionTenant()`
 * (`src/modules/tenancy/scoped-db.js`) hands back a way to bind a
 * newly-tenant-scoped accessor to the SAME underlying connection the
 * tenant row itself was inserted through, rather than opening a second
 * transaction.
 *
 * Minting the admin's first session (`issueStaffSession`) is the one
 * exception — deliberately called AFTER this transaction commits, not
 * inside it. See that call site's own comment for the real cross-connection
 * deadlock this avoids, found by testing against genuine pooled
 * connections, not by inspection.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
 *
 * It does not seed room types, rooms, rate codes, or any operational data —
 * PRODUCT_REQUIREMENTS.md §3.19's own setup wizard is what walks a new
 * tenant through that, and `GET /setup/progress` (`src/modules/setup`)
 * already computes readiness live from what actually exists; auto-completing
 * any of it here would make that screen lie. It does not seed demo/sample
 * data. It does not create a `tenant_domains` row — a fresh tenant is
 * already reachable at `{slug}.APP_DOMAIN` (`src/auth/tenant-resolution.js`)
 * with no extra row required; a custom domain is claimed later, if ever,
 * through Setup.
 */

const { scopedDb } = require('../../db');
const { systemContext, contextFromSession, SYSTEM_ROLES, DEFAULT_ROLE_PERMISSIONS } = require('../tenancy');
const { hashPassword, validatePassword, issueStaffSession } = require('../../auth');
const { recordAuditEntry } = require('../../audit');
const { trialEndsAtFromNow } = require('../../shared/tenant-lifecycle');
const { withDuplicateMapping, ValidationError } = require('../../shared/errors');
const { SignupEmailAlreadyUsedError } = require('./errors');

const REQUIRED_FIELDS = [
  'companyName', 'slug', 'timezone', 'baseCurrency',
  'adminEmail', 'adminPassword', 'adminFirstName', 'adminLastName',
];

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,98}[a-z0-9])?$/;

function assertRequiredFields(input) {
  const missing = REQUIRED_FIELDS.filter((field) => !input[field] || !String(input[field]).trim());
  if (missing.length) {
    throw new ValidationError(
      'MISSING_FIELD',
      `Missing required field(s): ${missing.join(', ')}.`,
      missing.map((field) => ({ field, issue: 'missing' }))
    );
  }
}

function assertValidSlug(slug) {
  if (!SLUG_PATTERN.test(slug)) {
    throw new ValidationError(
      'INVALID_SLUG',
      'Slug must be lowercase letters, numbers, and hyphens only (2–100 characters), and cannot start or end with a hyphen.',
      [{ field: 'slug', issue: 'format' }]
    );
  }
}

/**
 * @param {object} params
 * @param {string} params.companyName
 * @param {string} params.slug              The tenant's subdomain — {slug}.APP_DOMAIN.
 * @param {string} params.timezone          IANA timezone for the new property.
 * @param {string} params.baseCurrency      ISO 4217 for the new property.
 * @param {string} [params.propertyName]    Defaults to `${companyName} — Main Property`.
 * @param {string} params.adminEmail
 * @param {string} params.adminPassword
 * @param {string} params.adminFirstName
 * @param {string} params.adminLastName
 * @param {string} [params.ip]
 * @param {string} [params.userAgent]
 * @param {string} [params.requestId]
 */
async function signupTenant(input) {
  assertRequiredFields(input);
  assertValidSlug(input.slug);

  const passwordIssue = validatePassword(input.adminPassword);
  if (passwordIssue) {
    throw new ValidationError('PASSWORD_TOO_SHORT', passwordIssue, [{ field: 'adminPassword', issue: 'too_short' }]);
  }

  const adminEmail = input.adminEmail.trim().toLowerCase();
  const propertyName = input.propertyName?.trim() || `${input.companyName.trim()} — Main Property`;
  const trialEndsAt = trialEndsAtFromNow();

  // Ordered deliberately so each of the three ARCHITECTURE.md §4 rollback
  // guarantees this module promises has one real, distinct, testable
  // failure point in the same order they're described:
  //   1. tenant creation (the slug's own UNIQUE constraint)
  //   2. admin user creation (after roles/permissions exist, before property)
  //   3. property creation (after the admin user exists)
  // A failure at (3) must roll back the tenant AND the admin user already
  // inserted at (2); a failure at (2) must roll back the tenant (and the
  // roles/permissions already inserted with it) — both real, not merely
  // asserted, per `tests/signup/atomicity.test.js`.
  const result = await scopedDb().for(systemContext()).transaction(async (sysDb) => {
      // Each of this transaction's two possible UNIQUE-constraint collisions
      // (tenant slug, signup email) is mapped individually, immediately
      // around the one insert that can raise it — never one broad catch
      // around the whole transaction, which would misreport an email
      // collision as a slug collision or vice versa.
      const { tenantId, withContext } = await withDuplicateMapping(
        'tenants',
        `A tenant with slug "${input.slug}" already exists.`,
        () => sysDb.provisionTenant({
          name: input.companyName.trim(),
          slug: input.slug,
          status: 'trial',
          trial_ends_at: trialEndsAt,
        })
      );

      // Real UNIQUE(email) constraint, not a check-then-write
      // (ARCHITECTURE.md §5) — see tenant_signups' own migration header.
      try {
        await sysDb.platform().table('tenant_signups').insert({ email: adminEmail, tenant_id: tenantId });
      } catch (error) {
        if (error?.code === 'ER_DUP_ENTRY') throw new SignupEmailAlreadyUsedError();
        throw error;
      }

      const tenantDb = withContext(contextFromSession({ tenantId }));

      const roleIdByCode = {};
      for (const code of SYSTEM_ROLES) {
        const [roleId] = await tenantDb.table('roles').insert({
          code,
          name: humanizeRoleCode(code),
          is_system: true,
        });
        roleIdByCode[code] = roleId;
      }

      const permissionRows = await tenantDb.reference().table('permissions').select('id', 'permission_key');
      const permissionIdByKey = new Map(permissionRows.map((row) => [row.permission_key, row.id]));

      const grants = [];
      for (const [code, keys] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
        for (const key of keys) {
          const permissionId = permissionIdByKey.get(key);
          // Fails loudly rather than silently under-granting: the global
          // catalogue and this file's own matrix must agree, or a role's
          // access is quietly wrong for every tenant this signup pattern
          // ever creates, not just one — a bug worth a hard stop, not a
          // skipped row.
          if (!permissionId) throw new Error(`default-rbac.js names permission "${key}", which is not in the seeded catalogue.`);
          grants.push({ role_id: roleIdByCode[code], permission_id: permissionId });
        }
      }
      await tenantDb.table('role_permissions').insert(grants);

      // Hashed here, inside the transaction, immediately before the one
      // insert that needs it — not before the transaction opens — so a
      // hashing failure is a real, mockable "failure during admin creation"
      // injection point with the tenant/roles/permissions already
      // genuinely inserted ahead of it (see the ordering note above).
      const passwordHash = await hashPassword(input.adminPassword);
      const [adminUserId] = await tenantDb.table('users').insert({
        email: adminEmail,
        password_hash: passwordHash,
        first_name: input.adminFirstName.trim(),
        last_name: input.adminLastName.trim(),
      });

      const [propertyId] = await tenantDb.table('properties').insert({
        name: propertyName,
        slug: 'main',
        timezone: input.timezone,
        base_currency: input.baseCurrency,
        // Deliberately left null — PRODUCT_REQUIREMENTS.md §3.19's own
        // setup wizard opens the property, and `properties.current_business_date`
        // is documented as "nullable until the property is initialised in
        // Phase 1... a property with no business date has not opened yet."
        // Auto-setting it here would auto-complete a wizard step signup
        // must not (this pass's own explicit instruction).
        current_business_date: null,
      });

      // PROPERTY_SCOPED tables (`user_property_access`) require an active
      // property in the context — `tenantDb` above deliberately has none
      // (the property didn't exist yet when it was built). A second
      // accessor, bound to the SAME connection via the same `withContext`
      // closure `provisionTenant` returned, carries the property now that
      // it does.
      const propertyDb = withContext(contextFromSession({ tenantId, propertyId }));

      await propertyDb.table('user_property_access').insert({
        property_id: propertyId,
        user_id: adminUserId,
        role: 'super_admin',
      });

      await recordAuditEntry(propertyDb, {
        entityType: 'tenants',
        entityId: tenantId,
        action: 'create',
        source: 'api',
        userId: adminUserId,
        propertyId,
        afterState: { name: input.companyName.trim(), slug: input.slug, status: 'trial', trial_ends_at: trialEndsAt },
        requestId: input.requestId,
        ipAddress: input.ip,
        userAgent: input.userAgent,
      });

      return { tenantId, propertyId, adminUserId, trialEndsAt };
  });

  // Deliberately OUTSIDE the transaction, once it has committed — not an
  // atomicity gap, a real deadlock avoided. `issueStaffSession` (via
  // `writeAuthEvent`) writes `auth_events` through its own, separate,
  // non-transactional connection (by design — `auth_events` is
  // PLATFORM_SCOPED and requires a SYSTEM/PLATFORM-audience accessor,
  // which the STAFF-audience `propertyDb` above cannot become). That
  // insert's `user_id` foreign key needs to verify the referenced `users`
  // row — while it was still uncommitted inside this function's own open
  // transaction, that FK check blocked on the exact row lock this
  // transaction held, which this transaction would only release once
  // `issueStaffSession` itself returned: a real cross-connection deadlock,
  // found by running this against genuine pooled connections
  // (`tests/signup/atomicity.test.js`), not by inspection. Every OTHER
  // caller of `issueStaffSession` (`staffLogin`, `verifyStaffMfa`) never
  // hits this, because their user row was committed in a previous request,
  // long before the FK check that references it ever runs. Session
  // issuance needs no atomicity with provisioning anyway: if provisioning
  // fails, this line is never reached; if it succeeds, minting a session
  // for a real, already-committed user is safe to do as its own step, and
  // even a failure here just means the new admin logs in normally instead.
  const session = await issueStaffSession({
    scoped: scopedDb().for(contextFromSession({ tenantId: result.tenantId, userId: result.adminUserId, propertyId: result.propertyId })),
    tenantId: result.tenantId,
    user: { id: result.adminUserId },
    access: [{ property_id: result.propertyId, role: 'super_admin' }],
    activePropertyId: result.propertyId,
    role: 'super_admin',
    ip: input.ip,
    userAgent: input.userAgent,
    requestId: input.requestId,
  });

  return {
    ...session,
    tenantId: String(result.tenantId),
    propertyId: String(result.propertyId),
    trialEndsAt: result.trialEndsAt,
  };
}

function humanizeRoleCode(code) {
  return code.split('_').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
}

module.exports = { signupTenant };
