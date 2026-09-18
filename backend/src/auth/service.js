'use strict';

/**
 * Auth service — the business logic behind every `src/auth` endpoint.
 * TESTING.md AUTH-1..AUTH-15 is the test contract; each function below notes
 * which cases it is responsible for.
 *
 * Every database access goes through `scopedDb()` (`src/db`) — never a raw
 * `knex()` call — so login, refresh, and password reset get the same
 * tenant-isolation guarantee as every other module, not a hand-rolled
 * exception to it.
 */

const crypto = require('crypto');
const { scopedDb } = require('../db');
const {
  contextFromSession,
  guestContextFromSession,
  systemContext,
  withActiveProperty,
  resolvePropertyBySlug,
} = require('../modules/tenancy');
const { signAccessToken, issueRefreshToken, hashRefreshToken, REFRESH_TTL_HOURS, PLATFORM_ACCESS_TTL } = require('./tokens');
const { hashPassword, verifyPassword, validatePassword } = require('./password');
const { writeAuthEvent } = require('./events');
const { writeOutboxEvent } = require('../shared/outbox');
const { enqueueOutboxDispatch } = require('../jobs/outbox-dispatcher');
const { checkStaffLockout, checkPlatformLockout } = require('./lockout');
const { listPropertyAccess, roleAtProperty, roleRequiresMfa } = require('./roles');
const { isEmailDeliveryReal } = require('../modules/notifications/service');
const { encrypt, decrypt } = require('../shared/encryption');
const {
  signMfaChallengeToken,
  verifyMfaChallengeToken,
  signPlatformMfaChallengeToken,
  verifyPlatformMfaChallengeToken,
  signPlatformMfaEnrollmentToken,
  verifyPlatformMfaEnrollmentToken,
  generateMfaCode,
  hashMfaCode,
  MFA_CODE_TTL_MINUTES,
  MFA_CODE_MAX_ATTEMPTS,
} = require('./mfa');
const { generateTotpSecret, buildOtpAuthUrl, generateQrCodeDataUrl, verifiedTotpStep } = require('./totp');
const {
  InvalidCredentialsError,
  AccountLockedError,
  TokenInvalidError,
  ValidationError,
  MfaNotImplementedError,
  MfaCodeInvalidError,
  DuplicateEntryError,
} = require('./errors');
// Self-service "My Profile" screen (user-requested) — no cycle: `src/audit`
// never requires `src/auth` (confirmed directly against its own require
// list). The same direct-call precedent `src/modules/signup/service.js`
// already established for a service function outside the normal
// `attachAudit()` request pipeline (this file's own `/auth/*` routes never
// reach that middleware — see `updateMyProfile`'s own header for why).
const { recordAuditEntry } = require('../audit');

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 3600 * 1000);
}

function minutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000);
}

/** The single property a user holds access to, or null if they hold zero or several (SECURITY.md §3: chosen, never guessed). */
function defaultActiveProperty(access) {
  return access.length === 1 ? access[0].property_id : null;
}

/**
 * TESTING.md AUTH-1, AUTH-2, AUTH-3, AUTH-9, AUTH-11, AUTH-14.
 *
 * `tenantId` comes from `resolveTenant` middleware (the request's Host
 * header), never from the request body.
 */
async function staffLogin({ tenantId, email, password, ip, userAgent, requestId }) {
  const db = scopedDb();
  // No userId yet — see the nullable-userId note in context.js. tenant_id is
  // already a proven fact about this request; which user is what we're here
  // to find.
  const bootstrapCtx = contextFromSession({ tenantId });

  const user = await db.for(bootstrapCtx).table('users').where({ email }).first();

  const lockedDimension = await checkStaffLockout({ userId: user?.id ?? null, ip });
  if (lockedDimension) {
    await writeAuthEvent({
      audience: 'staff',
      eventType: 'lockout',
      tenantId,
      userId: user?.id ?? null,
      emailAttempted: email,
      ip,
      userAgent,
      requestId,
    });
    throw new AccountLockedError(lockedDimension);
  }

  if (!user || user.status !== 'active') {
    await writeAuthEvent({
      audience: 'staff',
      eventType: 'login_failure',
      failureReason: !user ? 'unknown_email' : 'user_inactive',
      tenantId,
      userId: user?.id ?? null,
      emailAttempted: email,
      ip,
      userAgent,
      requestId,
    });
    // AUTH-2: identical for "no such account" and "wrong password" — see below.
    throw new InvalidCredentialsError();
  }

  const passwordOk = await verifyPassword(password, user.password_hash);
  if (!passwordOk) {
    await writeAuthEvent({
      audience: 'staff',
      eventType: 'login_failure',
      failureReason: 'invalid_password',
      tenantId,
      userId: user.id,
      emailAttempted: email,
      ip,
      userAgent,
      requestId,
    });
    throw new InvalidCredentialsError();
  }

  // Authenticated. Everything from here runs under a real staff context.
  const context = contextFromSession({ tenantId, userId: user.id });
  const scoped = db.for(context);

  const access = await listPropertyAccess(scoped, context, user.id);
  const activePropertyId = defaultActiveProperty(access);
  const role = activePropertyId ? await roleAtProperty(scoped, context, user.id, activePropertyId) : null;

  // Gap closure: "enable or disable mfa verification code on the setup" —
  // user-confirmed decision (AskUserQuestion, "per-property toggle:
  // require MFA for admin/super_admin or not"). `roleRequiresMfa` itself
  // stays the unconditional Phase 0 default (PRODUCT_REQUIREMENTS.md
  // §3.16) — this is a per-property OVERRIDE checked alongside it, not a
  // replacement. Fetched per grant's own property (not just the resolved
  // active one) since a multi-property user can hold admin at one property
  // with MFA required and another where it has been turned off — each
  // grant's contribution to `mfaRequired` is judged against its OWN
  // property's setting. A property with no row (impossible after this
  // migration — the column is NOT NULL DEFAULT true) or a lookup miss
  // fails safe to `true`, the same "assume the stricter default" instinct
  // `resolveEmailAdapter`'s own console fallback uses in the other
  // direction (never assume a real send silently exists).
  const propertyIds = [...new Set(access.map((grant) => grant.property_id))];
  const mfaOverrides = propertyIds.length
    ? await scoped.table('properties').whereIn('id', propertyIds).select('id', 'mfa_required_for_admin_roles')
    : [];
  // MySQL/mysql2 returns a BOOLEAN column as a plain 0/1 number, not a real
  // JS boolean — `Boolean(...)` normalizes it; a strict `!== false` here
  // would silently always be true (0 !== false in JS), the exact toggle
  // this test exists to catch.
  const mfaRequiredAt = new Map(mfaOverrides.map((row) => [row.id, Boolean(row.mfa_required_for_admin_roles)]));

  // TESTING.md AUTH-9: a role that mandates MFA (PRODUCT_REQUIREMENTS.md
  // §3.16 — admin/super_admin, unless the property has turned it off) or a
  // user who has opted in gets a challenge, not tokens. `challengeToken` is
  // what `verifyStaffMfa` below resumes this specific login with, once the
  // real, emailed code (or, outside production, the same `devOnlyCode`
  // disclosure this codebase's other credential flows already use) is
  // submitted for it.
  const mfaRequired =
    user.mfa_enabled || access.some((grant) => roleRequiresMfa(grant.role) && (mfaRequiredAt.get(grant.property_id) ?? true));
  if (mfaRequired) {
    // Gap closure (user-reported, live-tested): "the verification code
    // shld be send to the account email to login not a static code." A
    // real 6-digit code, hashed and stored with a 10-minute expiry
    // (`mfa_login_codes`) and delivered through the real outbox — the
    // exact "both a real send AND a dev-only disclosure" precedent
    // `inviteUser`/`requestPasswordReset`/`requestGuestPasswordReset` all
    // already establish, not a hardcoded bypass string any more.
    let devOnlyCode = null;
    // The outbox/notifications pipeline is PROPERTY_SCOPED end to end
    // (`email_templates`/`notification_log`) — but a staff login challenge
    // is fundamentally tenant-level, and `activePropertyId` is genuinely
    // null for a user holding more than one property. Falling back to the
    // first property this user holds access to is purely a "which
    // property's template config to render against" choice for this one
    // generic, non-branded security email — it implies nothing about which
    // property they are signing into. Hoisted above the transaction since
    // the reactive dispatch trigger below needs it too, after commit.
    const notifyPropertyId = activePropertyId ?? access[0]?.property_id ?? null;
    // Computed ahead of the transaction — a plain read with no need for
    // transactional consistency with the code insert below. Needs a
    // property-BOUND accessor (`email_settings` is PROPERTY_SCOPED); `scoped`
    // itself carries no active property yet at this point in login.
    const emailDeliveryReal = notifyPropertyId
      ? await isEmailDeliveryReal({ db: db.for(withActiveProperty(context, notifyPropertyId)), propertyId: notifyPropertyId })
      : await isEmailDeliveryReal({});
    await scoped.transaction(async (trx) => {
      // Supersede any still-outstanding code for this user — a repeat
      // login attempt while already mid-challenge should invalidate the
      // earlier code rather than leave two simultaneously "valid" ones,
      // the same "delete the outstanding one before issuing a new one"
      // rule `inviteUser` already applies to invitations.
      await trx.table('mfa_login_codes').where({ user_id: user.id }).whereNull('used_at').delete();

      const { code, hash } = generateMfaCode();
      await trx.table('mfa_login_codes').insert({
        user_id: user.id,
        code_hash: hash,
        expires_at: minutesFromNow(MFA_CODE_TTL_MINUTES),
      });

      // Gap closure (user-reported, live-tested): "the verification code
      // shld be send to account email not to show on the screen." A
      // dev-only disclosure existed purely to cover "no real inbox exists
      // to check" — once a real adapter (SMTP or otherwise) is actually
      // configured, disclosing the code anywhere but the real email it was
      // just sent to would defeat the point of sending it. Non-production
      // still gates this outright; a real adapter narrows it further.
      if (process.env.NODE_ENV !== 'production' && !emailDeliveryReal) devOnlyCode = code;

      if (notifyPropertyId) {
        await writeOutboxEvent({
          trx,
          eventType: 'staff.mfa_code_requested',
          aggregateType: 'mfa_login_codes',
          aggregateId: user.id,
          propertyId: notifyPropertyId,
          payload: { guestEmail: user.email, code, expiresInMinutes: MFA_CODE_TTL_MINUTES },
        });
      }
    });

    // Gap closure (user-reported, live-tested): "the mails do delayed."
    // This branch previously relied purely on the periodic sweep
    // (`inviteUser`'s own "no req.context to fire the reactive trigger
    // from" precedent) — true for a genuinely pre-auth endpoint, but an
    // MFA code is a real-time login step someone is actively waiting on,
    // unlike an invitation or a password-reset link a person checks their
    // email for later. `tenantId`/`notifyPropertyId` are both already known
    // here without needing `req.context`, so there is no real reason to
    // wait up to 60s for the sweep — fired the same best-effort,
    // never-fails-the-request way `runIdempotentMutation` already does; a
    // Redis outage still falls back to the periodic sweep, unchanged.
    if (notifyPropertyId) {
      enqueueOutboxDispatch({ tenantId, propertyId: notifyPropertyId }).catch((error) => {
        console.error('Failed to enqueue outbox dispatch for MFA code (will be caught by the periodic sweep):', error);
      });
    }

    await writeAuthEvent({
      audience: 'staff',
      eventType: 'mfa_challenge_issued',
      tenantId,
      userId: user.id,
      ip,
      userAgent,
      requestId,
    });
    return {
      status: 'mfa_challenge_required',
      challengeToken: signMfaChallengeToken({ userId: user.id, tenantId }),
      devOnlyCode,
    };
  }

  return issueStaffSession({ scoped, tenantId, user, access, activePropertyId, role, ip, userAgent, requestId });
}

/**
 * The "authenticated, MFA satisfied (or not required), issue real tokens"
 * tail shared by `staffLogin` (the no-MFA-required path) and
 * `verifyStaffMfa` (the MFA-challenge-resumed path) — extracted so the two
 * routes into a real staff session share one implementation rather than two
 * copies of the same token/session-row/audit-event logic drifting apart.
 */
async function issueStaffSession({ scoped, tenantId, user, access, activePropertyId, role, ip, userAgent, requestId }) {
  const accessToken = signAccessToken({
    aud: 'staff',
    sub: String(user.id),
    tenant_id: String(tenantId),
    property_id: activePropertyId ? String(activePropertyId) : null,
  });
  const { token: refreshToken, hash: refreshTokenHash } = issueRefreshToken();

  await scoped.table('sessions').insert({
    user_id: user.id,
    refresh_token_hash: refreshTokenHash,
    expires_at: hoursFromNow(REFRESH_TTL_HOURS),
    device_label: null,
    ip: ip ?? null,
  });

  await scoped.table('users').where({ id: user.id }).update({ last_login_at: new Date() });

  await writeAuthEvent({
    audience: 'staff',
    eventType: 'login_success',
    tenantId,
    userId: user.id,
    propertyId: activePropertyId,
    ip,
    userAgent,
    requestId,
  });

  return {
    status: 'ok',
    accessToken,
    refreshToken,
    tenantId: String(tenantId),
    userId: String(user.id),
    // The Home dashboard's greeting needs the signed-in person's real name —
    // until now nothing returned it, so the app fell back to their email.
    firstName: user.first_name,
    lastName: user.last_name,
    activePropertyId: activePropertyId ? String(activePropertyId) : null,
    role,
    properties: access.map((grant) => ({ propertyId: String(grant.property_id), role: grant.role })),
  };
}

/**
 * Completes a challenge `staffLogin` issued above.
 *
 * Gap closure (user-reported, live-tested): real verification now, against
 * the emailed code (`mfa_login_codes`) — not a fixed dev-only bypass
 * string. An invalid/expired/wrong-audience CHALLENGE TOKEN still throws
 * `MfaNotImplementedError` unchanged — this is also the only path a
 * platform MFA-verify attempt ever reaches (it never holds a real challenge
 * token to decode), so preserving this exact behaviour keeps platform's
 * documented "always 501" fallthrough intact. A valid challenge token
 * paired with a wrong/expired/already-used/attempts-exhausted CODE now
 * gets the real, new `MfaCodeInvalidError` (401) instead — the STAFF path
 * genuinely works now, in every environment, not just outside production.
 */
async function verifyStaffMfa({ challengeToken, code, ip, userAgent, requestId }) {
  let payload;
  try {
    payload = verifyMfaChallengeToken(challengeToken);
  } catch {
    throw new MfaNotImplementedError();
  }

  const tenantId = Number(payload.tenant_id);
  const userId = Number(payload.sub);

  const db = scopedDb();
  const context = contextFromSession({ tenantId, userId });
  const scoped = db.for(context);

  const fail = async () => {
    await writeAuthEvent({ audience: 'staff', eventType: 'mfa_failed', tenantId, userId, ip, userAgent, requestId });
    throw new MfaCodeInvalidError();
  };

  // The outstanding code for this user — `staffLogin` deletes any prior
  // one before issuing a fresh one, so there is at most one row here.
  const pending = await scoped
    .table('mfa_login_codes')
    .where({ user_id: userId })
    .whereNull('used_at')
    .orderBy('id', 'desc')
    .first();

  if (!pending) return fail();
  if (new Date(pending.expires_at) <= new Date()) return fail();
  if (pending.attempts >= MFA_CODE_MAX_ATTEMPTS) return fail();

  if (hashMfaCode(String(code)) !== pending.code_hash) {
    // Plain read-then-write, not a raw SQL increment — the scoped
    // accessor deliberately exposes no raw-knex passthrough (CLAUDE.md:
    // "raw table access in a module is a review-blocking defect"). A rare
    // concurrent-guess race under-counting this by one only affects how
    // soon the lockout below trips — the real security boundaries
    // (`expires_at`, the single-use `used_at` claim) are unaffected.
    await scoped
      .table('mfa_login_codes')
      .where({ id: pending.id })
      .whereNull('used_at')
      .update({ attempts: pending.attempts + 1 });
    return fail();
  }

  // The single-use claim itself (ARCHITECTURE.md §5) — a conditional
  // UPDATE with an affected-row check, not read-then-write, the same
  // shape `completePasswordReset`/`acceptInvitation` both already use.
  // Guards the case two concurrent submissions of the same correct code
  // both pass the hash comparison above.
  const claimed = await scoped
    .table('mfa_login_codes')
    .where({ id: pending.id })
    .whereNull('used_at')
    .update({ used_at: new Date() });
  if (claimed === 0) return fail();

  const user = await scoped.table('users').where({ id: userId }).first();
  if (!user || user.status !== 'active') throw new MfaNotImplementedError();

  const access = await listPropertyAccess(scoped, context, userId);
  const activePropertyId = defaultActiveProperty(access);
  const role = activePropertyId ? await roleAtProperty(scoped, context, userId, activePropertyId) : null;

  await writeAuthEvent({
    audience: 'staff',
    eventType: 'mfa_verified',
    tenantId,
    userId,
    propertyId: activePropertyId,
    ip,
    userAgent,
    requestId,
  });

  return issueStaffSession({ scoped, tenantId, user, access, activePropertyId, role, ip, userAgent, requestId });
}

/**
 * TESTING.md AUTH-6, AUTH-10 (checked again on every refresh, not just login).
 * `tenantId` again comes from `resolveTenant` — see tokens.js's header for why
 * this endpoint needs no token decoding to find its tenant.
 *
 * `propertyId` is optional and comes from the CALLER, not from `sessions` —
 * that table deliberately carries no property_id (see its migration's
 * header: "the property a request concerns is carried per-request... nothing
 * durable is needed"). A refresh with no active property to restore is the
 * normal case for a user who never selected one; a refresh that omits a
 * property the caller actually had active would otherwise silently drop it
 * on every token rotation (~every 15 minutes by default), forcing a
 * re-switch the caller never asked for. Re-verified via `roleAtProperty`
 * exactly like `switchProperty`, never trusted outright (SECURITY.md §3) —
 * a caller cannot use this to grant itself a property it does not hold.
 */
async function staffRefresh({ tenantId, refreshToken, propertyId, ip, userAgent, requestId }) {
  const db = scopedDb();
  const context = contextFromSession({ tenantId });
  const scoped = db.for(context);

  const hash = hashRefreshToken(refreshToken);
  const session = await scoped.table('sessions').where({ refresh_token_hash: hash }).first();

  const reject = async (failureReason) => {
    await writeAuthEvent({
      audience: 'staff',
      eventType: 'token_refresh_rejected',
      failureReason,
      tenantId,
      userId: session?.user_id ?? null,
      ip,
      userAgent,
      requestId,
    });
    throw new TokenInvalidError();
  };

  if (!session) return reject('token_unknown');
  if (session.revoked_at) return reject('token_revoked');
  if (new Date(session.expires_at) <= new Date()) return reject('token_expired');

  const authedContext = contextFromSession({ tenantId, userId: session.user_id });
  const authedScoped = db.for(authedContext);
  const user = await authedScoped.table('users').where({ id: session.user_id }).first();
  if (!user || user.status !== 'active') return reject('user_inactive');

  // Rotate: the old refresh token stops working the instant a new one is
  // issued, so a stolen-but-unused token can be replayed at most once before
  // it 404s on its own successor (`revoked_reason: 'superseded'`).
  await authedScoped
    .table('sessions')
    .where({ id: session.id })
    .update({ revoked_at: new Date(), revoked_reason: 'superseded' });

  // Gap closure: a page reload now bootstraps its session through THIS
  // endpoint (the HttpOnly refresh cookie survives a reload; nothing else
  // in memory does — see `refresh-cookie.js`'s header) rather than only
  // ever following a real login, so the response needs the same
  // tenantId/userId/role/properties shape `issueStaffSession` returns, not
  // just a bare access token — a frontend restoring a session this way has
  // nothing else to read them from. Fetched once and reused for both the
  // active-property re-verification below and the returned `properties`
  // list, rather than a second `roleAtProperty` round trip for the same
  // table `listPropertyAccess` already reads.
  const access = await listPropertyAccess(authedScoped, authedContext, session.user_id);

  // Re-verify the active property survived (SECURITY.md §3) rather than
  // trusting the caller's claim outright. When the caller supplies none at
  // all — the very first refresh after a page reload, `AuthContext.jsx`'s
  // bootstrap, has nothing in memory to send — fall back to the same
  // "exactly one property, so it's unambiguous" default `staffLogin` itself
  // uses, rather than always coming back with no active property for the
  // common single-property tenant. A genuinely ambiguous (multi-property)
  // user still gets `null` here, same as login, and must choose explicitly.
  let activePropertyId = null;
  let role = null;
  if (propertyId) {
    const grant = access.find((g) => String(g.property_id) === String(propertyId));
    if (grant) {
      activePropertyId = propertyId;
      role = grant.role;
    }
  } else {
    const defaulted = defaultActiveProperty(access);
    if (defaulted) {
      activePropertyId = defaulted;
      role = access.find((g) => String(g.property_id) === String(defaulted))?.role ?? null;
    }
  }

  const accessToken = signAccessToken({
    aud: 'staff',
    sub: String(session.user_id),
    tenant_id: String(tenantId),
    property_id: activePropertyId ? String(activePropertyId) : null,
  });
  const { token: newRefreshToken, hash: newHash } = issueRefreshToken();

  await authedScoped.table('sessions').insert({
    user_id: session.user_id,
    refresh_token_hash: newHash,
    expires_at: hoursFromNow(REFRESH_TTL_HOURS),
    device_label: session.device_label,
    ip: ip ?? null,
  });

  await writeAuthEvent({
    audience: 'staff',
    eventType: 'token_refreshed',
    tenantId,
    userId: session.user_id,
    ip,
    userAgent,
    requestId,
  });

  return {
    accessToken,
    refreshToken: newRefreshToken,
    tenantId: String(tenantId),
    userId: String(session.user_id),
    firstName: user.first_name,
    lastName: user.last_name,
    activePropertyId: activePropertyId ? String(activePropertyId) : null,
    role,
    properties: access.map((grant) => ({ propertyId: String(grant.property_id), role: grant.role })),
  };
}

/**
 * Revokes the session behind one refresh token — the client's own "log
 * out".
 *
 * Gap closure (user-reported, live-tested): "i click the signout it
 * logout if i refresh the page it take me back to the dashboard." Root
 * cause, confirmed by reproducing it directly: this endpoint used to sit
 * behind `authenticate('staff')`, so a still-valid refresh cookie's own
 * session could only ever be revoked while the caller ALSO happened to
 * hold a fresh access token — and `shared/api/client.js`'s auto-retry
 * only covers `AUTH_TOKEN_EXPIRED`, never `AUTH_TOKEN_INVALID`/
 * `AUTH_UNAUTHENTICATED` (confirmed live: a malformed/absent token
 * returns `AUTH_TOKEN_INVALID`, not `_EXPIRED`). `AuthContext.jsx`'s
 * `logout()` also deliberately swallows the resulting error (so a
 * genuine network failure doesn't trap someone visibly "still logged
 * in") — so the UI showed the login screen regardless, while the real
 * session, never actually revoked, stayed live server-side for up to its
 * full 30-day expiry. A page reload then bootstrapped right back into it.
 *
 * Fixed the same way `staffRefresh` already works: resolved entirely
 * from the refresh token itself (`tenantId` from the Host header via
 * `resolveTenant`, everything else — including WHICH user — from the
 * session row the hash finds), needing no access token, valid or
 * otherwise, at all. This is not a new attack surface: `/auth/refresh`
 * has always been public and cookie-gated, and is a strictly MORE
 * powerful operation (it mints a fresh access token) than merely
 * revoking a session — logout matching that shape is a reduction in
 * fragility, not an increase in exposure.
 */
async function staffLogout({ tenantId, refreshToken, ip, userAgent, requestId }) {
  const scoped = scopedDb().for(contextFromSession({ tenantId }));
  const hash = hashRefreshToken(refreshToken);
  const session = await scoped.table('sessions').where({ refresh_token_hash: hash }).whereNull('revoked_at').first();

  let updated = 0;
  if (session) {
    updated = await scoped
      .table('sessions')
      .where({ id: session.id })
      .whereNull('revoked_at')
      .update({ revoked_at: new Date(), revoked_reason: 'logout' });
  }

  await writeAuthEvent({
    audience: 'staff',
    eventType: 'logout',
    tenantId,
    userId: session?.user_id ?? null,
    ip,
    userAgent,
    requestId,
  });

  return { revoked: updated > 0 };
}

/**
 * API.md §5's documented endpoint. Re-verifies against `user_property_access`
 * before honouring the switch — never trusts the id the client sent
 * (SECURITY.md §3).
 */
async function switchProperty({ context, propertyId }) {
  const scoped = scopedDb().for(context);
  const role = await roleAtProperty(scoped, context, context.userId, propertyId);
  if (!role) {
    throw new ValidationError('PROPERTY_NOT_ACCESSIBLE', 'You do not have access to that property.');
  }

  const nextContext = withActiveProperty(context, propertyId);
  const accessToken = signAccessToken({
    aud: 'staff',
    sub: String(context.userId),
    tenant_id: String(context.tenantId),
    property_id: String(propertyId),
  });

  return { accessToken, activePropertyId: String(propertyId), role, context: nextContext };
}

const MY_PROFILE_MAX_NAME_LENGTH = 100; // matches users.first_name/last_name VARCHAR(100)
const MY_PROFILE_MAX_PHONE_LENGTH = 30; // matches users.phone VARCHAR(30), 20261026090000_add_phone_to_users.js

function serializeMyProfile(row) {
  return {
    userId: String(row.id),
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
  };
}

/**
 * Self-service "My Profile" screen (user-requested) — every field a staff
 * member may view/edit about their OWN account. Deliberately lives in
 * `src/auth`, not `src/modules/users`: that module is "an admin acting on
 * SOMEONE ELSE" (every route takes an `:id`, gated `setup.view`/
 * `setup.manage`); this is "the caller acting on themselves," the exact
 * shape `GET /auth/me/permissions` already established — `authenticate('staff')`
 * only, no permission gate, the row touched is always
 * `WHERE tenant_id = context.tenantId AND id = context.userId`, both from
 * the verified token. There is no `:id` anywhere in these routes for a
 * caller to smuggle another user's id through — a structural IDOR defense,
 * not a remembered check.
 */
async function getMyProfile({ context }) {
  const db = scopedDb().for(context);
  const row = await db.table('users').where({ id: context.userId }).first('id', 'email', 'first_name', 'last_name', 'phone');
  return serializeMyProfile(row);
}

/**
 * Validates only the fields actually present in `changes` (a partial
 * update) — mutates and returns the same object with trimmed values.
 * `email` is never accepted here: it is read-only in this pass (confirmed
 * with the user) — no edit path exists for it anywhere, for any role; this
 * function has no branch that could ever touch it, by construction, not by
 * a body-field filter alone.
 */
function validateMyProfileChanges(changes) {
  if (changes.first_name !== undefined) {
    const trimmed = String(changes.first_name).trim();
    if (!trimmed) throw new ValidationError('FIRST_NAME_REQUIRED', 'First name is required.');
    if (trimmed.length > MY_PROFILE_MAX_NAME_LENGTH) {
      throw new ValidationError('FIRST_NAME_TOO_LONG', `First name must be ${MY_PROFILE_MAX_NAME_LENGTH} characters or fewer.`);
    }
    changes.first_name = trimmed;
  }
  if (changes.last_name !== undefined) {
    const trimmed = String(changes.last_name).trim();
    if (!trimmed) throw new ValidationError('LAST_NAME_REQUIRED', 'Last name is required.');
    if (trimmed.length > MY_PROFILE_MAX_NAME_LENGTH) {
      throw new ValidationError('LAST_NAME_TOO_LONG', `Last name must be ${MY_PROFILE_MAX_NAME_LENGTH} characters or fewer.`);
    }
    changes.last_name = trimmed;
  }
  if (changes.phone !== undefined) {
    const trimmed = changes.phone == null ? null : String(changes.phone).trim();
    if (trimmed && trimmed.length > MY_PROFILE_MAX_PHONE_LENGTH) {
      throw new ValidationError('PHONE_TOO_LONG', `Phone number must be ${MY_PROFILE_MAX_PHONE_LENGTH} characters or fewer.`);
    }
    changes.phone = trimmed || null;
  }
  return changes;
}

async function updateMyProfile({ context, changes: rawChanges, ip, userAgent, requestId }) {
  const changes = validateMyProfileChanges({ ...rawChanges });
  const db = scopedDb().for(context);
  if (Object.keys(changes).length === 0) return getMyProfile({ context }); // nothing recognized to change — no-op, no audit row

  const before = await db.table('users').where({ id: context.userId }).first('id', 'email', 'first_name', 'last_name', 'phone');
  await db.table('users').where({ id: context.userId }).update(changes);
  const after = await db.table('users').where({ id: context.userId }).first('id', 'email', 'first_name', 'last_name', 'phone');

  // `src/auth`'s own routes never pass through `attachAudit()` (mounted
  // later, inside `buildStaffRouter()` — every route here responds
  // directly, so `req.audit` is undefined) — calling `recordAuditEntry`
  // directly is the same precedent `src/modules/signup/service.js`
  // already established for a service function outside that pipeline.
  await recordAuditEntry(db, {
    entityType: 'users',
    entityId: context.userId,
    action: 'update_profile',
    source: 'web',
    userId: context.userId,
    propertyId: context.propertyId ?? null,
    beforeState: before,
    afterState: after,
    requestId,
    ipAddress: ip,
    userAgent,
  });

  return serializeMyProfile(after);
}

/**
 * Self-service password change WHILE LOGGED IN — distinct from
 * `completePasswordReset` (the forgot-password flow, which needs a reset
 * TOKEN and has no "current password" to check, since it runs pre-auth).
 * This requires the CURRENT password, and — confirmed with the user —
 * revokes every OTHER active session for this account while sparing the
 * one behind THIS request, so the device making the change stays signed
 * in and every other device/browser is signed out.
 *
 * "This request's own session" can only be identified from the refresh-
 * token cookie (`refresh-cookie.js`) — the access token's own `jti` claim
 * is generated fresh on every sign and never persisted anywhere, so it has
 * no relationship to a `sessions` row at all. That is the whole reason
 * `POST /auth/me/password` (unlike `GET`/`PATCH /auth/me`) must live under
 * `/api/v1/auth`, the one path prefix the cookie is actually scoped to
 * (`refresh-cookie.js`'s `COOKIE_PATH`).
 *
 * A request that somehow carries no refresh cookie at all (should be
 * near-impossible from a real browser hitting this exact path — the
 * cookie's own path always matches) has nothing to spare, so it falls
 * back to the same "revoke everything" shape `completePasswordReset`
 * already uses — the safer of the two directions to fail in, matching
 * this codebase's own instinct elsewhere (§7's "a false negative is safe,
 * a false positive is the one that matters").
 */
async function changeMyPassword({ context, refreshToken, currentPassword, newPassword, ip, userAgent, requestId }) {
  const validationIssue = await validatePassword(newPassword);
  if (validationIssue) throw new ValidationError(validationIssue.code, validationIssue.message);

  const db = scopedDb().for(context);
  const user = await db.table('users').where({ id: context.userId }).first();

  const currentOk = await verifyPassword(currentPassword, user.password_hash);
  if (!currentOk) {
    await writeAuthEvent({
      audience: 'staff',
      eventType: 'password_changed',
      failureReason: 'invalid_password',
      tenantId: context.tenantId,
      userId: context.userId,
      ip,
      userAgent,
      requestId,
    });
    throw new ValidationError('CURRENT_PASSWORD_INCORRECT', 'Current password is incorrect.');
  }

  let currentSessionId = null;
  if (refreshToken) {
    const hash = hashRefreshToken(refreshToken);
    const session = await db.table('sessions').where({ refresh_token_hash: hash, user_id: context.userId }).whereNull('revoked_at').first('id');
    currentSessionId = session?.id ?? null;
  }

  await db.table('users').where({ id: context.userId }).update({ password_hash: await hashPassword(newPassword) });

  const baseQuery = () => db.table('sessions').where({ user_id: context.userId }).whereNull('revoked_at');
  const otherSessionsRevoked = currentSessionId
    ? await baseQuery().whereNot({ id: currentSessionId }).update({ revoked_at: new Date(), revoked_reason: 'password_changed' })
    : await baseQuery().update({ revoked_at: new Date(), revoked_reason: 'password_changed' });

  // Matches `completePasswordReset`'s own precedent: a password mutation is
  // recorded in `auth_events`, never `audit_log` — the password hash
  // itself must never end up in an audit `before_state`/`after_state`.
  await writeAuthEvent({
    audience: 'staff',
    eventType: 'password_changed',
    tenantId: context.tenantId,
    userId: context.userId,
    ip,
    userAgent,
    requestId,
  });

  return { status: 'ok', otherSessionsRevoked };
}

/**
 * TESTING.md AUTH-7. Always returns the same shape whether or not the email
 * resolves — the request-a-reset endpoint must not confirm account existence
 * any more than login does (PRODUCT_REQUIREMENTS.md §3.16).
 *
 * Actual delivery goes through the outbox/notifications module once it
 * exists (ARCHITECTURE.md §13 — an external send does not belong inside this
 * transaction). Until then, outside `production`, the raw token is returned
 * directly so the flow is testable end to end without a mail sender; this is
 * a Phase 0 stopgap, not the shipped behaviour.
 */
async function requestPasswordReset({ tenantId, email, ip, userAgent, requestId }) {
  const db = scopedDb();
  const context = contextFromSession({ tenantId });
  const scoped = db.for(context);

  const user = await scoped.table('users').where({ email, status: 'active' }).first();

  let devOnlyToken = null;
  if (user) {
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    await scoped.table('password_resets').insert({
      user_id: user.id,
      token_hash: hash,
      expires_at: hoursFromNow(1),
    });
    if (process.env.NODE_ENV !== 'production') devOnlyToken = token;
  }

  await writeAuthEvent({
    audience: 'staff',
    eventType: 'password_reset_requested',
    tenantId,
    userId: user?.id ?? null,
    emailAttempted: email,
    ip,
    userAgent,
    requestId,
  });

  return { status: 'ok', devOnlyToken };
}

/**
 * TESTING.md AUTH-7 (single-use, expiry) and AUTH-8 (completing a reset
 * invalidates every existing session).
 *
 * The single-use claim is a conditional UPDATE with an affected-row check
 * (ARCHITECTURE.md §5), not a read-then-write: two concurrent completions of
 * the same token can each read `used_at IS NULL`, but only one UPDATE can
 * actually flip it, and the loser's affected-row count is 0.
 */
async function completePasswordReset({ tenantId, token, newPassword, ip, userAgent, requestId }) {
  const validationIssue = await validatePassword(newPassword);
  if (validationIssue) throw new ValidationError(validationIssue.code, validationIssue.message);

  const db = scopedDb();
  const context = contextFromSession({ tenantId });
  const scoped = db.for(context);

  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const reset = await scoped.table('password_resets').where({ token_hash: hash }).first();

  const reject = async (failureReason) => {
    await writeAuthEvent({
      audience: 'staff',
      eventType: 'password_reset_completed',
      failureReason,
      tenantId,
      userId: reset?.user_id ?? null,
      ip,
      userAgent,
      requestId,
    });
    throw new TokenInvalidError();
  };

  if (!reset) return reject('token_unknown');
  if (reset.expires_at && new Date(reset.expires_at) <= new Date()) return reject('token_expired');
  if (reset.used_at) return reject('token_already_used');

  // The single-use claim itself (ARCHITECTURE.md §5).
  const claimed = await scoped
    .table('password_resets')
    .where({ id: reset.id })
    .whereNull('used_at')
    .update({ used_at: new Date() });
  if (claimed === 0) return reject('token_already_used');

  const authedContext = contextFromSession({ tenantId, userId: reset.user_id });
  const authedScoped = db.for(authedContext);

  await authedScoped
    .table('users')
    .where({ id: reset.user_id })
    .update({ password_hash: await hashPassword(newPassword) });

  // AUTH-8: every existing session for this user dies, not just a future one.
  await authedScoped
    .table('sessions')
    .where({ user_id: reset.user_id })
    .whereNull('revoked_at')
    .update({ revoked_at: new Date(), revoked_reason: 'password_reset' });

  await writeAuthEvent({
    audience: 'staff',
    eventType: 'password_reset_completed',
    tenantId,
    userId: reset.user_id,
    ip,
    userAgent,
    requestId,
  });

  return { status: 'ok' };
}

/**
 * PLAN.md Phase 1 gap closure — PRODUCT_REQUIREMENTS.md §3.16's staff
 * invitation flow: "the invitee sets their own password... admins never set
 * a password on someone's behalf." `invitation_accepted` (this pass's own
 * migration, 20260910094000) is reused for both the success and every
 * rejection branch, distinguished by `failureReason` — the exact shape
 * `completePasswordReset` above already established.
 *
 * Scoped to the common case only (this session's confirmed simplification):
 * accepting always creates a brand-new user. An email that already belongs
 * to a user in this tenant — being invited to a SECOND property — is a
 * real, separate case (granting an existing user another property's access,
 * rather than onboarding a new person) this pass does not handle; flagged
 * here rather than silently mishandled.
 */
async function acceptInvitation({ tenantId, token, firstName, lastName, password, ip, userAgent, requestId }) {
  const validationIssue = await validatePassword(password);
  if (validationIssue) throw new ValidationError(validationIssue.code, validationIssue.message);

  const db = scopedDb();
  const context = contextFromSession({ tenantId });
  const scoped = db.for(context);

  const hash = crypto.createHash('sha256').update(token).digest('hex');
  // acrossProperties(): this caller holds no session at all yet, so there is
  // no active property to scope by — the same reasoning `roleAtProperty`
  // (src/auth/roles.js) already documents for the identical shape.
  const invitation = await scoped.acrossProperties().table('user_invitations').where({ token_hash: hash }).first();

  const reject = async (failureReason) => {
    await writeAuthEvent({
      audience: 'staff',
      eventType: 'invitation_accepted',
      failureReason,
      tenantId,
      ip,
      userAgent,
      requestId,
    });
    throw new TokenInvalidError();
  };

  if (!invitation) return reject('token_unknown');
  if (invitation.expires_at && new Date(invitation.expires_at) <= new Date()) return reject('token_expired');
  if (invitation.accepted_at) return reject('token_already_used');

  const existingUser = await scoped.table('users').where({ email: invitation.email }).first();
  if (existingUser) return reject('token_already_used');

  // Single-use claim (ARCHITECTURE.md §5) — same conditional-UPDATE-with-
  // affected-row-check shape `completePasswordReset` above already uses.
  const claimed = await scoped
    .acrossProperties()
    .table('user_invitations')
    .where({ id: invitation.id })
    .whereNull('accepted_at')
    .update({ accepted_at: new Date() });
  if (claimed === 0) return reject('token_already_used');

  const [userId] = await scoped.table('users').insert({
    email: invitation.email,
    password_hash: await hashPassword(password),
    first_name: firstName,
    last_name: lastName,
  });

  const propertyScoped = db.for(contextFromSession({ tenantId, propertyId: invitation.property_id }));
  await propertyScoped.table('user_property_access').insert({ user_id: userId, role: invitation.role });

  await writeAuthEvent({
    audience: 'staff',
    eventType: 'invitation_accepted',
    tenantId,
    userId,
    ip,
    userAgent,
    requestId,
  });

  return { status: 'ok' };
}

/**
 * PLAN.md Phase 4 (the guest booking portal), PRODUCT_REQUIREMENTS.md
 * §3.14/§3.16's "guest account registration/login." Mirrors `guestLogin`'s
 * own property-by-slug resolution exactly. Unlike `acceptInvitation` (this
 * codebase's other "create an account" flow, for staff), this signs the
 * caller in immediately on success — a guest mid-booking shouldn't have to
 * log in a second time right after registering, and there's no
 * privileged-inviter/invitee split here to keep separate.
 *
 * Always creates a NEW `guests` row — no dedup/merge against an existing
 * guest identity that might share this email from an earlier anonymous
 * booking. `guests.status`'s `merged` lifecycle exists in the schema for
 * exactly that case but is real, deferred scope, the same simplification
 * `acceptInvitation`'s own header already accepts for staff invitations.
 */
async function guestRegister({ tenantId, propertySlug, email, password, firstName, lastName, phone, ip, userAgent, requestId }) {
  const validationIssue = await validatePassword(password);
  if (validationIssue) throw new ValidationError(validationIssue.code, validationIssue.message);

  const db = scopedDb();
  const property = await resolvePropertyBySlug({ db, tenantId, propertySlug });
  if (!property) throw new ValidationError('PROPERTY_NOT_FOUND', 'The specified property does not exist.');

  const guestContext = guestContextFromSession({ tenantId, propertyId: property.id });
  const scoped = db.for(guestContext);

  let result;
  try {
    result = await scoped.transaction(async (trx) => {
      const [guestId] = await trx.table('guests').insert({
        first_name: firstName,
        last_name: lastName,
        email,
        phone: phone ?? null,
      });
      const [guestAccountId] = await trx.table('guest_accounts').insert({
        guest_id: guestId,
        email,
        password_hash: await hashPassword(password),
      });
      return { guestAccountId };
    });
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      throw new DuplicateEntryError('guest_accounts', `An account with email "${email}" already exists at this property.`);
    }
    throw error;
  }

  const accessToken = signAccessToken({
    aud: 'guest',
    sub: String(result.guestAccountId),
    tenant_id: String(tenantId),
    property_id: String(property.id),
  });

  await writeAuthEvent({
    audience: 'guest',
    eventType: 'registration',
    tenantId,
    propertyId: property.id,
    guestAccountId: result.guestAccountId,
    ip,
    userAgent,
    requestId,
  });

  // Same access-token-only shape as guestLogin — see that function's own
  // comment for why (no guest_sessions table exists in this pass).
  return { status: 'ok', accessToken };
}

/**
 * Guest portal login — TESTING.md AUTH-12's counterpart on the minting side.
 * The portal is reached through the same tenant Host resolution as staff
 * (`resolveTenant`); `propertySlug` narrows to the one property this portal
 * instance serves.
 */
async function guestLogin({ tenantId, propertySlug, email, password, ip, userAgent, requestId }) {
  const db = scopedDb();
  const property = await resolvePropertyBySlug({ db, tenantId, propertySlug });

  if (!property) throw new InvalidCredentialsError();

  const guestContext = guestContextFromSession({ tenantId, propertyId: property.id });
  const guest = await db.for(guestContext).table('guest_accounts').where({ email }).first();

  if (!guest || guest.status !== 'active' || !(await verifyPassword(password, guest.password_hash))) {
    await writeAuthEvent({
      audience: 'guest',
      eventType: 'login_failure',
      failureReason: !guest ? 'unknown_email' : 'invalid_password',
      tenantId,
      propertyId: property.id,
      emailAttempted: email,
      ip,
      userAgent,
      requestId,
    });
    throw new InvalidCredentialsError();
  }

  const accessToken = signAccessToken({
    aud: 'guest',
    sub: String(guest.id),
    tenant_id: String(tenantId),
    property_id: String(property.id),
  });

  await writeAuthEvent({
    audience: 'guest',
    eventType: 'login_success',
    tenantId,
    propertyId: property.id,
    guestAccountId: guest.id,
    ip,
    userAgent,
    requestId,
  });

  // No refresh token yet — see the module surface's header for why guest
  // sessions are access-token-only in this pass (no guest_sessions table
  // exists; a guest simply re-authenticates on expiry, matching
  // PRODUCT_REQUIREMENTS.md §3.16's "log in rarely").
  return { status: 'ok', accessToken };
}

/**
 * Gap closure (flagged in CLAUDE.md's own Phase 4 section, built via
 * feature-dev): guest password-reset. Follows `requestPasswordReset`'s own
 * shape — anti-enumeration (identical response whether or not the email
 * resolves), single-use token, 1-hour expiry, an `auth_events` row
 * regardless of outcome — against `guest_accounts` instead of `users`.
 *
 * Unlike staff's own version (which still returns the dev-only token as a
 * Phase 0 stopgap with no real delivery), this ALSO writes a real outbox
 * event inside the same transaction as the token insert — the exact
 * "both, not either/or" precedent `users/service.js`'s `inviteUser`
 * already established for staff invitations. No reactive dispatch enqueue:
 * this is a public, pre-auth endpoint with no `req.context` or
 * Idempotency-Key header, so delivery relies purely on the 60-second
 * periodic sweep (`runOutboxDispatchSweep`) — the same shape `inviteUser`
 * itself uses.
 *
 * `propertySlug` resolution failing is NOT part of the anti-enumeration
 * surface — a property slug is public route data (it's in the URL a guest
 * is already looking at), not a secret about which email addresses exist;
 * this mirrors `guestRegister`'s own choice, not `guestLogin`'s.
 */
async function requestGuestPasswordReset({ tenantId, propertySlug, email, ip, userAgent, requestId }) {
  const db = scopedDb();
  const property = await resolvePropertyBySlug({ db, tenantId, propertySlug });
  if (!property) throw new ValidationError('PROPERTY_NOT_FOUND', 'The specified property does not exist.');

  const guestContext = guestContextFromSession({ tenantId, propertyId: property.id });
  const scoped = db.for(guestContext);
  const guest = await scoped.table('guest_accounts').where({ email, status: 'active' }).first();

  let devOnlyToken = null;
  if (guest) {
    await scoped.transaction(async (trx) => {
      const token = crypto.randomBytes(32).toString('base64url');
      const hash = crypto.createHash('sha256').update(token).digest('hex');

      const [id] = await trx.table('guest_password_resets').insert({
        guest_account_id: guest.id,
        token_hash: hash,
        expires_at: hoursFromNow(1),
      });

      if (process.env.NODE_ENV !== 'production') devOnlyToken = token;

      const tenant = await trx.table('tenants').where({ id: tenantId }).first('slug');
      // No port here deliberately — resolves correctly in production; a
      // local dev run of the Vite dev server still needs ":5173" appended
      // by hand, the same manual step `inviteUser`'s own invitationUrl and
      // `seeds/01_dev_tenants.js`'s printed dev-login URL already expect
      // of a human running it.
      const resetUrl = tenant?.slug
        ? `http://${tenant.slug}.${process.env.APP_DOMAIN}/portal/${propertySlug}/reset-password?token=${token}`
        : null;

      await writeOutboxEvent({
        trx,
        eventType: 'guest.password_reset_requested',
        aggregateType: 'guest_password_resets',
        aggregateId: id,
        propertyId: property.id,
        payload: {
          guestEmail: email,
          propertyName: property.name,
          resetUrl,
          expiresInHours: 1,
        },
      });
    });
  }

  await writeAuthEvent({
    audience: 'guest',
    eventType: 'password_reset_requested',
    tenantId,
    propertyId: property.id,
    guestAccountId: guest?.id ?? null,
    emailAttempted: email,
    ip,
    userAgent,
    requestId,
  });

  return { status: 'ok', devOnlyToken };
}

/**
 * The completion half. Deliberately takes no `propertySlug` — the token
 * alone resolves the property, via `acrossProperties()` on a tenant-only
 * context, the exact mechanism `acceptInvitation` already uses for the
 * identical "no session yet, property not known" shape. The frontend route
 * naturally carries the slug (`/portal/:propertySlug/reset-password`), but
 * the backend has no need of it.
 *
 * Single-use claim is a conditional UPDATE with an affected-row check
 * (ARCHITECTURE.md §5), not read-then-write — the same shape
 * `completePasswordReset`/`acceptInvitation` both already use.
 *
 * Session invalidation: sets `guest_accounts.password_changed_at`, which
 * `authenticate('guest')`'s live per-request re-check
 * (`src/auth/middleware.js`) compares against a presented token's own
 * `iat` claim — see that migration's own header for why this, not a
 * `sessions`-table revoke, is the correct mechanism for an audience with
 * no revocable-session table at all.
 */
async function completeGuestPasswordReset({ tenantId, token, newPassword, ip, userAgent, requestId }) {
  const validationIssue = await validatePassword(newPassword);
  if (validationIssue) throw new ValidationError(validationIssue.code, validationIssue.message);

  const db = scopedDb();
  const context = contextFromSession({ tenantId });
  const scoped = db.for(context);

  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const reset = await scoped.acrossProperties().table('guest_password_resets').where({ token_hash: hash }).first();

  const reject = async (failureReason) => {
    await writeAuthEvent({
      audience: 'guest',
      eventType: 'password_reset_completed',
      failureReason,
      tenantId,
      propertyId: reset?.property_id ?? null,
      guestAccountId: reset?.guest_account_id ?? null,
      ip,
      userAgent,
      requestId,
    });
    throw new TokenInvalidError();
  };

  if (!reset) return reject('token_unknown');
  if (reset.expires_at && new Date(reset.expires_at) <= new Date()) return reject('token_expired');
  if (reset.used_at) return reject('token_already_used');

  // The single-use claim itself (ARCHITECTURE.md §5).
  const claimed = await scoped
    .acrossProperties()
    .table('guest_password_resets')
    .where({ id: reset.id })
    .whereNull('used_at')
    .update({ used_at: new Date() });
  if (claimed === 0) return reject('token_already_used');

  const guestContext = guestContextFromSession({ tenantId, propertyId: reset.property_id });
  const guestScoped = db.for(guestContext);

  await guestScoped
    .table('guest_accounts')
    .where({ id: reset.guest_account_id })
    .update({
      password_hash: await hashPassword(newPassword),
      // The session-invalidation mechanism itself — see this function's
      // own header.
      password_changed_at: new Date(),
    });

  await writeAuthEvent({
    audience: 'guest',
    eventType: 'password_reset_completed',
    tenantId,
    propertyId: reset.property_id,
    guestAccountId: reset.guest_account_id,
    ip,
    userAgent,
    requestId,
  });

  return { status: 'ok' };
}

/** Platform MFA uses one pending credential per account; a new login supersedes it. */
function platformTokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function platformLogin({ email, password, ip, userAgent, requestId }) {
  const result = await scopedDb().for(systemContext()).transaction(async (db) => {
    const platformUser = await db.platform().table('platform_users').where({ email }).forUpdate().first();
    const event = { audience: 'platform', platformUserId: platformUser?.id, emailAttempted: email, ip, userAgent, requestId };
    const dimension = await checkPlatformLockout({ platformUserId: platformUser?.id, ip, db });
    if (dimension) {
      await writeAuthEvent({ ...event, eventType: 'lockout' }, db);
      return { error: new AccountLockedError(dimension) };
    }
    if (!platformUser || platformUser.status !== 'active' || !(await verifyPassword(password, platformUser.password_hash))) {
      await writeAuthEvent({ ...event, eventType: 'login_failure', failureReason: !platformUser ? 'unknown_email' : 'invalid_password' }, db);
      return { error: new InvalidCredentialsError() };
    }
    const secretPlaintext = platformUser.mfa_secret ? null : generateTotpSecret();
    const token = secretPlaintext
      ? signPlatformMfaEnrollmentToken({ platformUserId: platformUser.id, secretPlaintext })
      : signPlatformMfaChallengeToken({ platformUserId: platformUser.id });
    await db.platform().table('platform_users').where({ id: platformUser.id }).update({ mfa_pending_token_hash: platformTokenHash(token) });
    await writeAuthEvent({ ...event, eventType: 'mfa_challenge_issued' }, db);
    if (secretPlaintext) {
      return { status: 'mfa_enrollment_required', enrollmentToken: token, manualEntryKey: secretPlaintext,
        otpAuthUrl: buildOtpAuthUrl({ secretPlaintext, accountLabel: platformUser.email }) };
    }
    return { status: 'mfa_challenge_required', challengeToken: token };
  });
  // Expected failures must commit their lockout evidence before throwing.
  if (result.error) throw result.error;
  if (result.otpAuthUrl) result.qrCodeDataUrl = await generateQrCodeDataUrl(result.otpAuthUrl);
  return result;
}

async function completePlatformMfa({ token, code, enrollment, ip, userAgent, requestId }) {
  let payload;
  const db = scopedDb().for(systemContext());
  try {
    payload = enrollment ? verifyPlatformMfaEnrollmentToken(token) : verifyPlatformMfaChallengeToken(token);
  } catch {
    const dimension = await checkPlatformLockout({ ip, db });
    if (dimension) throw new AccountLockedError(dimension);
    await writeAuthEvent({ audience: 'platform', eventType: 'mfa_failed', ip, userAgent, requestId });
    throw new TokenInvalidError('This verification link is no longer valid. Log in again.');
  }
  const result = await db.transaction(async (trx) => {
    const user = await trx.platform().table('platform_users').where({ id: String(payload.sub) }).forUpdate().first();
    const event = { audience: 'platform', platformUserId: user?.id, ip, userAgent, requestId };
    const dimension = await checkPlatformLockout({ platformUserId: user?.id, ip, db: trx });
    if (dimension) {
      await writeAuthEvent({ ...event, eventType: 'lockout' }, trx);
      return { error: new AccountLockedError(dimension) };
    }
    if (!user || user.status !== 'active' || user.mfa_pending_token_hash !== platformTokenHash(token)
      || payload.exp <= Math.floor(Date.now() / 1000) || (enrollment ? !!user.mfa_secret : !user.mfa_secret)) {
      await writeAuthEvent({ ...event, eventType: 'mfa_failed' }, trx);
      return { error: new TokenInvalidError('This verification link is no longer valid. Log in again.') };
    }
    const secretPlaintext = enrollment ? payload.secret : decrypt(user.mfa_secret);
    const step = verifiedTotpStep({ secretPlaintext, code });
    if (step === null || (user.mfa_last_used_step !== null && step <= Number(user.mfa_last_used_step))) {
      await writeAuthEvent({ ...event, eventType: 'mfa_failed' }, trx);
      return { error: new MfaCodeInvalidError() };
    }
    await trx.platform().table('platform_users').where({ id: user.id }).update({
      ...(enrollment ? { mfa_secret: encrypt(secretPlaintext) } : {}),
      mfa_pending_token_hash: null, mfa_last_used_step: step, last_login_at: new Date(),
    });
    await writeAuthEvent({ ...event, eventType: enrollment ? 'mfa_enrolled' : 'mfa_verified' }, trx);
    await writeAuthEvent({ ...event, eventType: 'login_success' }, trx);
    const accessToken = signAccessToken({ aud: 'platform', sub: String(user.id) }, { expiresIn: PLATFORM_ACCESS_TTL });
    // PLAN.md Phase 5's platform-staff tiering — the frontend needs this to
    // show or hide the impersonate/suspend/reactivate actions sensibly
    // (UI-level convenience only; the real check is `requirePlatformRole`
    // at the route, re-verified from the database on every request).
    return { status: 'ok', accessToken, platformUserId: String(user.id), role: user.role };
  });
  if (result.error) throw result.error;
  return result;
}

async function confirmPlatformMfaEnrollment({ enrollmentToken, ...args }) {
  return completePlatformMfa({ ...args, token: enrollmentToken, enrollment: true });
}

async function verifyPlatformMfa({ challengeToken, ...args }) {
  return completePlatformMfa({ ...args, token: challengeToken, enrollment: false });
}

module.exports = {
  staffLogin,
  staffRefresh,
  staffLogout,
  switchProperty,
  getMyProfile,
  updateMyProfile,
  changeMyPassword,
  requestPasswordReset,
  completePasswordReset,
  acceptInvitation,
  guestRegister,
  guestLogin,
  requestGuestPasswordReset,
  completeGuestPasswordReset,
  platformLogin,
  confirmPlatformMfaEnrollment,
  verifyPlatformMfa,
  verifyStaffMfa,
  // PLAN.md Phase 5 — self-service signup (`src/modules/signup/service.js`)
  // is the second caller of this: mint the newly-created admin's first
  // session at the end of the same provisioning transaction, the identical
  // "hash a password, insert transactionally, sign in immediately" shape
  // `staffLogin`/`verifyStaffMfa` already use, without duplicating it.
  issueStaffSession,
};
