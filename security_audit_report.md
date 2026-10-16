# LodgeKeep Security Audit Report

**Audit date:** 2026-10-07  
**Scope:** Backend and frontend source, Docker/production configuration, CI configuration, committed dependency manifests and lockfiles. No source files were modified as part of this audit.

## Summary

Four confirmed issues require remediation. There were no **Critical** findings. The most important items are preventing payment callbacks from using cleartext HTTP, adding authenticity to emailed database backups, and bounding concurrent in-memory file uploads.

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 0 |
| Medium | 3 |
| Low | 1 |

`npm audit --package-lock-only --omit=dev --json` was run against both `backend` and `frontend`; it reported **0 known production dependency vulnerabilities** at the time of this audit.

## Findings

### 1. Cleartext payment return URLs are permitted

**Risk level:** Medium

**Affected file:** `backend/src/shared/callback-url.js:74-76`

The callback URL validator accepts both `http:` and `https:`. The callback may include a payment reference after a customer completes checkout. Allowing an HTTP callback for an otherwise approved tenant hostname permits network observers or active attackers to read or alter the redirect and its payment reference.

**Exact fix:** Require HTTPS exclusively, including for a tenant's default subdomain and verified custom domains.

```js
if (parsed.protocol !== 'https:') {
  throw invalidCallbackUrlError();
}
```

Add regression tests for `http://<tenant>.APP_DOMAIN/...` and `http://<verified-custom-domain>/...`, both expecting `INVALID_CALLBACK_URL`.

### 2. Emailed database backups are encrypted but not authenticated

**Risk level:** Medium

**Affected file:** `backend/src/modules/platform/backup.js:71-85`

Backups use AES-256-CBC with PBKDF2, which provides confidentiality but no cryptographic integrity/authenticity. CBC ciphertext is malleable: a party able to alter the emailed attachment can make controlled changes to decrypted plaintext blocks. Padding errors are not a substitute for a message-authentication check.

**Exact fix:** Replace the custom CBC format with an authenticated-encryption format, preferably AES-256-GCM, and store/transmit all required metadata: a random 12-byte IV, 16-byte authentication tag, salt, ciphertext, and an explicit version marker. During restore, verify the tag before returning any plaintext. Use a versioned format so existing backups can either be rejected explicitly or supported by a read-only legacy decoder.

At minimum, if OpenSSL-compatible `enc` output is a product requirement, append an encrypt-then-MAC HMAC-SHA-256 generated from a separately derived key and verify it with `crypto.timingSafeEqual` before CBC decryption. AES-GCM is the preferred solution.

### 3. Authorized users can exhaust Node.js memory through concurrent in-memory uploads

**Risk level:** Medium

**Affected file:** `backend/src/modules/access-monitoring/routes.js:18,29-31`

The three door-access import endpoints use Multer `memoryStorage()` with a 20 MiB per-request limit. A user with `door_access.manage` can submit many simultaneous uploads; each accepted request buffers the full body in the shared Node.js heap before controller processing. There is no route-specific concurrency/rate limit, so enough parallel requests can cause memory pressure, process termination, or degraded service for all tenants.

**Exact fix:** Do not buffer these uploads in memory. Use disk/object storage with a randomly generated server filename, validate and stream/parse with a strict size and record limit, then remove the temporary object in a `finally` block. Add a Redis-backed per-user and per-tenant upload rate/concurrency control before Multer. For example, allow one active import per tenant and a small request budget per time window. Also configure the reverse proxy with a request-body limit aligned with the application limit.

### 4. Development stack uses mutable images and known default credentials

**Risk level:** Low

**Affected file:** `docker-compose.yml:29-32,53,69-80`

The development stack embeds MySQL credentials (`change-me` / `change-me-root`), runs Redis without authentication, and uses mutable image tags (`mysql:8`, `redis:7-alpine`, `adminer`, `phpmyadmin:latest`). The ports are correctly bound to `127.0.0.1`, which substantially limits exposure, but any process or local user able to connect to loopback can access the services with public credentials. Mutable images also weaken reproducibility and supply-chain review for developer environments.

**Exact fix:** Move development credentials to an ignored `.env` file with generated per-developer values; require a Redis password and configure the application to use it. Pin all development images to reviewed digests, matching the production Compose approach. If Adminer/phpMyAdmin are retained, put them behind an explicit Compose profile so they are not started by default.

## Positive Controls Observed

- Production containers do not publish backend, MySQL, or Redis ports to the host; the public frontend reverse-proxies the API.
- Production base images and production MySQL/Redis images are pinned by digest.
- JWT and encryption key startup validation fails closed, and refresh cookies are `HttpOnly`, `Secure` in production, and scoped.
- The frontend proxy sets HSTS, CSP, `nosniff`, anti-framing, referrer, and permissions-policy headers.
- Upload image names are random, path traversal is constrained, byte signatures are checked, and public media responses use `nosniff` and a restrictive CSP.
- Authentication and public-facing endpoints use Redis-backed rate limits, and production dependency advisories were clear at audit time.

## Verification After Remediation

1. Add automated tests rejecting all HTTP callback URLs.
2. Add a backup test that flips one ciphertext/tag byte and proves restoration fails before plaintext is returned.
3. Load-test concurrent door-access uploads and confirm bounded memory use plus `429`/`409` responses at the configured limit.
4. Run `docker compose config` for the development stack and verify it reads secrets from ignored environment files, uses authenticated Redis, and references image digests.
