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
const { contextFromSession, guestContextFromSession, systemContext, withActiveProperty } = require('../modules/tenancy');
const { signAccessToken, issueRefreshToken, hashRefreshToken, REFRESH_TTL_HOURS } = require('./tokens');
const { hashPassword, verifyPassword, validatePassword } = require('./password');
const { writeAuthEvent } = require('./events');
const { checkStaffLockout } = require('./lockout');
const { listPropertyAccess, roleAtProperty, roleRequiresMfa } = require('./roles');
const { signMfaChallengeToken, verifyMfaChallengeToken, isDevBypassCode } = require('./mfa');
const {
  InvalidCredentialsError,
  AccountLockedError,
  TokenInvalidError,
  ValidationError,
  MfaNotImplementedError,
} = require('./errors');

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 3600 * 1000);
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

  // TESTING.md AUTH-9: a role that mandates MFA (PRODUCT_REQUIREMENTS.md
  // §3.16 — admin/super_admin, unconditionally) or a user who has opted in
  // gets a challenge, not tokens. Full TOTP verification is deferred (see
  // `src/auth/mfa.js`'s header); `challengeToken` is what `verifyStaffMfa`
  // below resumes this specific login with, once a code — today, only ever
  // the dev bypass code — is submitted for it.
  const mfaRequired = user.mfa_enabled || access.some((grant) => roleRequiresMfa(grant.role));
  if (mfaRequired) {
    await writeAuthEvent({
      audience: 'staff',
      eventType: 'mfa_challenge_issued',
      tenantId,
      userId: user.id,
      ip,
      userAgent,
      requestId,
    });
    return { status: 'mfa_challenge_required', challengeToken: signMfaChallengeToken({ userId: user.id, tenantId }) };
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
    activePropertyId: activePropertyId ? String(activePropertyId) : null,
    role,
    properties: access.map((grant) => ({ propertyId: String(grant.property_id), role: grant.role })),
  };
}

/**
 * Completes a challenge `staffLogin` issued above. The only real
 * verification this performs is `isDevBypassCode` — outside production,
 * with the fixed dev bypass code, this resumes the login exactly as if MFA
 * had been satisfied for real. Any other input (production, a wrong code,
 * an expired/invalid/wrong-audience token) throws `MfaNotImplementedError`,
 * the exact `501` this endpoint has always returned — a real client, and any
 * production deployment, sees no change in behaviour at all.
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

  if (!isDevBypassCode(code)) {
    await writeAuthEvent({ audience: 'staff', eventType: 'mfa_failed', tenantId, userId, ip, userAgent, requestId });
    throw new MfaNotImplementedError();
  }

  const db = scopedDb();
  const context = contextFromSession({ tenantId, userId });
  const scoped = db.for(context);

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

  // Re-verify the active property survived (SECURITY.md §3) rather than
  // trusting the caller's claim outright.
  let activePropertyId = null;
  if (propertyId) {
    const role = await roleAtProperty(authedScoped, authedContext, session.user_id, propertyId);
    activePropertyId = role ? propertyId : null;
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

  return { accessToken, refreshToken: newRefreshToken };
}

/** Revokes the session behind one refresh token — the client's own "log out". */
async function staffLogout({ context, refreshToken, ip, userAgent, requestId }) {
  const scoped = scopedDb().for(context);
  const hash = hashRefreshToken(refreshToken);
  const updated = await scoped
    .table('sessions')
    .where({ user_id: context.userId, refresh_token_hash: hash })
    .whereNull('revoked_at')
    .update({ revoked_at: new Date(), revoked_reason: 'logout' });

  await writeAuthEvent({
    audience: 'staff',
    eventType: 'logout',
    tenantId: context.tenantId,
    userId: context.userId,
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
  const validationIssue = validatePassword(newPassword);
  if (validationIssue) throw new ValidationError('PASSWORD_TOO_SHORT', validationIssue);

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
  const validationIssue = validatePassword(password);
  if (validationIssue) throw new ValidationError('PASSWORD_TOO_SHORT', validationIssue);

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
 * Guest portal login — TESTING.md AUTH-12's counterpart on the minting side.
 * The portal is reached through the same tenant Host resolution as staff
 * (`resolveTenant`); `propertySlug` narrows to the one property this portal
 * instance serves.
 */
async function guestLogin({ tenantId, propertySlug, email, password, ip, userAgent, requestId }) {
  const db = scopedDb();
  const tenantOnlyContext = contextFromSession({ tenantId });
  const property = await db
    .for(tenantOnlyContext)
    .table('properties')
    .where({ slug: propertySlug })
    .first();

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
 * Platform console login — PRODUCT_REQUIREMENTS.md §3.16 ("MFA mandatory with
 * no opt-out"). Every successful password check ends in a challenge in this
 * pass, never full tokens — see `src/auth/mfa.js`'s header. TESTING.md AUTH-13
 * is exercised against a directly-built platform context in the isolation
 * suite; this endpoint is what a real request path uses to reach one, once
 * MFA verification exists.
 */
async function platformLogin({ email, password, ip, userAgent, requestId }) {
  const db = scopedDb();
  const system = systemContext();
  const platformUser = await db.for(system).platform().table('platform_users').where({ email }).first();

  if (
    !platformUser ||
    platformUser.status !== 'active' ||
    !(await verifyPassword(password, platformUser.password_hash))
  ) {
    await writeAuthEvent({
      audience: 'platform',
      eventType: 'login_failure',
      failureReason: !platformUser ? 'unknown_email' : 'invalid_password',
      emailAttempted: email,
      ip,
      userAgent,
      requestId,
    });
    throw new InvalidCredentialsError();
  }

  await writeAuthEvent({
    audience: 'platform',
    eventType: 'mfa_challenge_issued',
    platformUserId: platformUser.id,
    ip,
    userAgent,
    requestId,
  });

  return { status: 'mfa_challenge_required' };
}

module.exports = {
  staffLogin,
  staffRefresh,
  staffLogout,
  switchProperty,
  requestPasswordReset,
  completePasswordReset,
  acceptInvitation,
  guestLogin,
  platformLogin,
  verifyStaffMfa,
};
