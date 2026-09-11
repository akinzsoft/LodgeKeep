'use strict';

/**
 * Platform login + real TOTP MFA — PLAN.md Phase 5 (Platform Foundation).
 * Closes the gap `platformLogin` carried since Phase 0: every successful
 * password check used to end in `mfa_challenge_required` with nothing to
 * resume, and MFA-verify always 501'd. Real enrollment (first login, no
 * `mfa_secret` yet) and real challenge verification (every login after)
 * now both complete to a genuine `aud: 'platform'` access token.
 *
 * Runs against the real Express app (`src/app.js`), same as `auth.test.js`.
 */

const { authenticator } = require('otplib');
const { useTestApp } = require('../helpers/app');
const { hashPassword } = require('../../src/auth/password');
const { decrypt } = require('../../src/shared/encryption');

const PLATFORM_PASSWORD = 'a real platform password, not a fixture hash';

describe('platform login + real TOTP MFA (PLAN.md Phase 5)', () => {
  const t = useTestApp();

  async function createPlatformUser({ email = `ops-${Date.now()}-${Math.random()}@lodgekeep.test`, mfaSecret = null } = {}) {
    const passwordHash = await hashPassword(PLATFORM_PASSWORD);
    const [id] = await t.trx('platform_users').insert({
      email,
      password_hash: passwordHash,
      first_name: 'Test',
      last_name: 'Ops',
      mfa_secret: mfaSecret,
    });
    return { id, email };
  }

  function login(email) {
    return t.request.post('/api/v1/platform/auth/login').send({ email, password: PLATFORM_PASSWORD });
  }

  it('consumes enrollment and never replaces an enrolled secret', async () => {
    const user = await createPlatformUser();
    const first = (await login(user.email)).body.data;
    const confirm = (data) => t.request.post('/api/v1/platform/auth/mfa/enroll/confirm')
      .send({ enrollment_token: data.enrollmentToken, code: authenticator.generate(data.manualEntryKey) });
    expect((await confirm(first)).status).toBe(200);
    expect((await confirm(first)).status).toBe(401);
    const row = await t.trx('platform_users').where({ id: user.id }).first();
    expect(decrypt(row.mfa_secret)).toBe(first.manualEntryKey);
    expect(row.mfa_pending_token_hash).toBeNull();
  });

  it('rejects an enrollment issued before another secret was enrolled', async () => {
    const user = await createPlatformUser();
    const data = (await login(user.email)).body.data;
    const { encrypt } = require('../../src/shared/encryption');
    const enrolled = authenticator.generateSecret();
    await t.trx('platform_users').where({ id: user.id }).update({ mfa_secret: encrypt(enrolled) });
    const res = await t.request.post('/api/v1/platform/auth/mfa/enroll/confirm')
      .send({ enrollment_token: data.enrollmentToken, code: authenticator.generate(data.manualEntryKey) });
    expect(res.status).toBe(401);
    expect(decrypt((await t.trx('platform_users').where({ id: user.id }).first()).mfa_secret)).toBe(enrolled);
  });

  it('rechecks active status when confirming enrollment', async () => {
    const user = await createPlatformUser();
    const data = (await login(user.email)).body.data;
    await t.trx('platform_users').where({ id: user.id }).update({ status: 'inactive' });
    const res = await t.request.post('/api/v1/platform/auth/mfa/enroll/confirm')
      .send({ enrollment_token: data.enrollmentToken, code: authenticator.generate(data.manualEntryKey) });
    expect(res.status).toBe(401);
    expect((await t.trx('platform_users').where({ id: user.id }).first()).mfa_secret).toBeNull();
  });

  it('rechecks active status when verifying an ordinary MFA challenge, not just enrollment', async () => {
    // `completePlatformMfa` is one shared implementation behind both
    // `confirmPlatformMfaEnrollment` and `verifyPlatformMfa` — the enrollment
    // test above already proves the `user.status !== 'active'` check exists,
    // but names only the enrollment branch. This names the challenge branch
    // explicitly, so a future change that accidentally special-cases
    // enrollment (e.g. moving the check into an enrollment-only guard) would
    // be caught here even though the shared code makes it unlikely today.
    const { encrypt } = require('../../src/shared/encryption');
    const secret = authenticator.generateSecret();
    const user = await createPlatformUser({ mfaSecret: encrypt(secret) });
    const data = (await login(user.email)).body.data;
    await t.trx('platform_users').where({ id: user.id }).update({ status: 'inactive' });
    const res = await t.request.post('/api/v1/platform/auth/mfa/verify')
      .send({ challenge_token: data.challengeToken, code: authenticator.generate(secret) });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
    expect((await t.trx('platform_users').where({ id: user.id }).first()).last_login_at).toBeNull();
  });

  it('rejects challenge replay, including the same TOTP on a fresh challenge', async () => {
    const { encrypt } = require('../../src/shared/encryption');
    const secret = authenticator.generateSecret();
    const user = await createPlatformUser({ mfaSecret: encrypt(secret) });
    const data = (await login(user.email)).body.data;
    const verify = (token) => t.request.post('/api/v1/platform/auth/mfa/verify')
      .send({ challenge_token: token, code: authenticator.generate(secret) });
    expect((await verify(data.challengeToken)).status).toBe(200);
    expect((await verify(data.challengeToken)).status).toBe(401);
    expect((await verify((await login(user.email)).body.data.challengeToken)).status).toBe(401);
  });

  it('locks an account after five failed MFA attempts, even with a valid code next', async () => {
    const user = await createPlatformUser();
    const data = (await login(user.email)).body.data;
    const valid = authenticator.generate(data.manualEntryKey);
    const wrong = String((Number(valid) + 1) % 1000000).padStart(6, '0');
    for (let i = 0; i < 5; i++) {
      const res = await t.request.post('/api/v1/platform/auth/mfa/enroll/confirm')
        .send({ enrollment_token: data.enrollmentToken, code: wrong });
      expect(res.status).toBe(401);
    }
    const res = await t.request.post('/api/v1/platform/auth/mfa/enroll/confirm')
      .send({ enrollment_token: data.enrollmentToken, code: valid });
    expect(res.status).toBe(423);
    expect((await login(user.email)).status).toBe(423);
  });

  describe('first login — real TOTP enrollment', () => {
    it('issues a real secret, QR data URL, and enrollment token — no mfa_secret persisted yet', async () => {
      const user = await createPlatformUser();
      const res = await login(user.email);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('mfa_enrollment_required');
      expect(res.body.data.enrollmentToken).toEqual(expect.any(String));
      expect(res.body.data.manualEntryKey).toEqual(expect.any(String));
      expect(res.body.data.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(res.body.data.otpAuthUrl).toMatch(/^otpauth:\/\/totp\//);

      const row = await t.trx('platform_users').where({ id: user.id }).first();
      expect(row.mfa_secret).toBeNull();
    });

    it('confirming with the real code issues a real session and persists the secret, encrypted', async () => {
      const user = await createPlatformUser();
      const loginRes = await login(user.email);
      const { enrollmentToken, manualEntryKey } = loginRes.body.data;

      const code = authenticator.generate(manualEntryKey);
      const confirmRes = await t.request
        .post('/api/v1/platform/auth/mfa/enroll/confirm')
        .send({ enrollment_token: enrollmentToken, code });

      expect(confirmRes.status).toBe(200);
      expect(confirmRes.body.data.status).toBe('ok');
      expect(confirmRes.body.data.accessToken).toEqual(expect.any(String));

      const row = await t.trx('platform_users').where({ id: user.id }).first();
      expect(row.mfa_secret).not.toBeNull();
      expect(row.mfa_secret).not.toBe(manualEntryKey); // ciphertext, never the plaintext secret
      expect(decrypt(row.mfa_secret)).toBe(manualEntryKey);
    });

    it('rejects a wrong code and persists nothing', async () => {
      const user = await createPlatformUser();
      const loginRes = await login(user.email);
      const { enrollmentToken } = loginRes.body.data;

      const confirmRes = await t.request
        .post('/api/v1/platform/auth/mfa/enroll/confirm')
        .send({ enrollment_token: enrollmentToken, code: '000000' });

      expect(confirmRes.status).toBe(401);
      expect(confirmRes.body.error.code).toBe('AUTH_MFA_CODE_INVALID');

      const row = await t.trx('platform_users').where({ id: user.id }).first();
      expect(row.mfa_secret).toBeNull();
    });

    it('rejects a garbage enrollment token with a real 401, not the old 501 stub', async () => {
      const res = await t.request
        .post('/api/v1/platform/auth/mfa/enroll/confirm')
        .send({ enrollment_token: 'not-a-real-token', code: '123456' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
    });
  });

  describe('ordinary login — an already-enrolled account', () => {
    async function createEnrolledUser() {
      const secretPlaintext = authenticator.generateSecret();
      const { encrypt } = require('../../src/shared/encryption');
      const user = await createPlatformUser({ mfaSecret: encrypt(secretPlaintext) });
      return { ...user, secretPlaintext };
    }

    it('issues a real challenge token, not an enrollment one', async () => {
      const user = await createEnrolledUser();
      const res = await login(user.email);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('mfa_challenge_required');
      expect(res.body.data.challengeToken).toEqual(expect.any(String));
      expect(res.body.data.enrollmentToken).toBeUndefined();
    });

    it('the real code completes login to a genuine platform access token', async () => {
      const user = await createEnrolledUser();
      const loginRes = await login(user.email);
      const code = authenticator.generate(user.secretPlaintext);

      const verifyRes = await t.request
        .post('/api/v1/platform/auth/mfa/verify')
        .send({ challenge_token: loginRes.body.data.challengeToken, code });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.data.status).toBe('ok');
      expect(verifyRes.body.data.accessToken).toEqual(expect.any(String));
      expect(String(verifyRes.body.data.platformUserId)).toBe(String(user.id));

      const row = await t.trx('platform_users').where({ id: user.id }).first();
      expect(row.last_login_at).not.toBeNull();
    });

    it('rejects a wrong code with the real error, not the old 501 stub', async () => {
      const user = await createEnrolledUser();
      const loginRes = await login(user.email);

      const verifyRes = await t.request
        .post('/api/v1/platform/auth/mfa/verify')
        .send({ challenge_token: loginRes.body.data.challengeToken, code: '000000' });

      expect(verifyRes.status).toBe(401);
      expect(verifyRes.body.error.code).toBe('AUTH_MFA_CODE_INVALID');
    });

    it('rejects a garbage or expired challenge token with a real 401', async () => {
      const res = await t.request.post('/api/v1/platform/auth/mfa/verify').send({ challenge_token: 'garbage', code: '123456' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
    });

    it("a staff MFA challenge token is rejected by the platform verify endpoint (the two are genuinely separate audiences)", async () => {
      const { signMfaChallengeToken } = require('../../src/auth/mfa');
      const staffToken = signMfaChallengeToken({ userId: '1', tenantId: '1' });
      const res = await t.request.post('/api/v1/platform/auth/mfa/verify').send({ challenge_token: staffToken, code: '123456' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
    });
  });
});
