'use strict';

/**
 * Access tokens (JWT) and refresh tokens (opaque, hashed) — SECURITY.md §3,
 * API.md §4, the auth-credentials migration's hashing note.
 *
 * ── ACCESS TOKENS ARE JWTS; REFRESH TOKENS ARE NOT ─────────────────────────
 *
 * An access token is short-lived and self-verifying: the signature alone is
 * enough to trust `aud`/`sub`/`tenant_id` for the token's lifetime, which is
 * what makes it cheap to check on every request. A refresh token is long-lived
 * and therefore must be revocable, which a self-verifying token structurally
 * cannot be — so it is a 256-bit random value whose SHA-256 digest is looked
 * up in `sessions.refresh_token_hash` on every use (the migration's own
 * reasoning; see its header for why SHA-256 rather than bcrypt).
 *
 * ── NO ROLE CLAIM ───────────────────────────────────────────────────────
 *
 * SECURITY.md §3 describes the access token as carrying tenant_id and "role
 * (where the role is tenant-wide)". This implementation carries no role claim
 * at all, deliberately: nothing in the schema built so far represents a
 * tenant-wide role as anything other than a `user_property_access` row like
 * any other (SECURITY.md §4's exception for `super-admin` is not backed by a
 * separate column or table yet). Baking a role into a signed token that lives
 * for the token's full TTL would mean a permission change takes up to
 * JWT_ACCESS_TTL to land — the same staleness problem AUTH-10 forbids for
 * deactivation. `src/auth/roles.js` resolves the role fresh, from
 * `user_property_access`, on every request that needs one; nothing here
 * should be treated as an RBAC decision on its own.
 *
 * ── HOW /auth/refresh RECOVERS ITS TENANT ──────────────────────────────────
 *
 * A refresh request carries no valid access token by definition — that is why
 * it is refreshing. It still needs `tenant_id` to run a scoped `sessions`
 * query, and gets it the same way `/auth/login` does: `resolveTenant`
 * middleware (`src/auth/tenant-resolution.js`) reads it from the request's
 * Host header before the handler runs, since in production every staff
 * request — refresh included — is served from that tenant's own subdomain or
 * custom domain. No token decoding is needed for this at all.
 *
 * ── ACCESS-TOKEN CLAIMS BY AUDIENCE (API.md §4) ────────────────────────────
 *
 *   staff      { aud: 'staff',    sub: userId,         tenant_id, property_id (nullable) }
 *   guest      { aud: 'guest',    sub: guestAccountId,  tenant_id, property_id }
 *   platform   { aud: 'platform', sub: platformUserId }
 *
 * `property_id` on a staff token is the active property (SECURITY.md §3) at
 * the moment the token was issued — re-verified against `user_property_access`
 * on every property-scoped request regardless, never trusted from the claim
 * alone for authorization; it exists on the token so the frontend can render
 * without a round trip.
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value) {
    throw new Error('JWT_SECRET is not set. See .env.example — never fall back to a default in code.');
  }
  return value;
}

const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';
const REFRESH_TTL_HOURS = ttlToHours(process.env.JWT_REFRESH_TTL || '30d');

/** Parses the simple "<n><unit>" shape .env.example uses (m/h/d) into hours. */
function ttlToHours(ttl) {
  const match = /^(\d+)([mhd])$/.exec(ttl);
  if (!match) throw new Error(`Unrecognised TTL "${ttl}" — expected e.g. "15m", "12h", "30d".`);
  const [, amount, unit] = match;
  const perHour = { m: 1 / 60, h: 1, d: 24 };
  return Number(amount) * perHour[unit];
}

function signAccessToken(claims) {
  return jwt.sign(claims, secret(), { expiresIn: ACCESS_TTL, jwtid: crypto.randomUUID() });
}

/** Ordinary verification — rejects an expired or tampered token (AUTH-5). */
function verifyAccessToken(token) {
  return jwt.verify(token, secret());
}

/** A 256-bit random refresh token, and the digest that gets stored/looked up. */
function issueRefreshToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  hashRefreshToken,
  REFRESH_TTL_HOURS,
};
