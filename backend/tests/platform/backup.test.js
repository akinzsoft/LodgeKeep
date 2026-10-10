'use strict';

/**
 * Whole-database backups from the platform console (user-requested).
 * Confirmed: the whole database; encrypted with a passphrase typed for that
 * backup; platform admins only.
 *
 *   - the encryption is OpenSSL's own `enc` format, proven with the real
 *     `openssl` binary, and a wrong passphrase cannot open it;
 *   - the SQL dump restores values EXACTLY — quotes, backslashes, newlines,
 *     emoji, JSON, datetimes — proven by replaying its INSERTs into
 *     temporary copies of the tables and comparing every column (real
 *     committed rows: a separate connection cannot see the shared test
 *     transaction);
 *   - the HTTP flow: admin-only, validation, one at a time, the emailed
 *     attachment decrypts to a dump of the schema, a stale "running" row is
 *     reported as interrupted, and no real mailbox in production is refused.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync, spawnSync } = require('child_process');

jest.mock('../../src/modules/notifications/email-adapter', () => {
  const actual = jest.requireActual('../../src/modules/notifications/email-adapter');
  return { ...actual, getEmailAdapter: jest.fn() };
});

const emailAdapter = require('../../src/modules/notifications/email-adapter');
const { useTestApp } = require('../helpers/app');
const { db } = require('../helpers/db');
const { seedPlatformUser } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { dumpDatabaseSql } = require('../../src/db/dump');
const { encryptForOpenssl, decryptFromOpenssl, encryptBackup, decryptBackup, PBKDF2_ITERATIONS } = require('../../src/modules/platform/backup');

const DECRYPT_SCRIPT = path.join(__dirname, '../../scripts/decrypt-lodgekeep-backup.js');

/** Runs the standalone restore script exactly as a recipient would. */
function runScript(encrypted, passphrase) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-dec-'));
  const input = path.join(dir, 'in.enc');
  const output = path.join(dir, 'out.sql.gz');
  fs.writeFileSync(input, encrypted);
  const result = spawnSync(process.execPath, [DECRYPT_SCRIPT, input, output], { env: { ...process.env, LODGEKEEP_BACKUP_PASSPHRASE: passphrase }, encoding: 'utf8' });
  const produced = fs.existsSync(output) ? fs.readFileSync(output) : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: result.status, stderr: result.stderr, produced };
}

const PASSPHRASE = 'correct horse battery staple';

function hasOpenssl() {
  try {
    execFileSync('openssl', ['version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether decrypting with `passphrase` gives back the original data. A wrong
 * passphrase USUALLY fails the CBC padding check and throws, but about 1 time
 * in 256 the garbage it produces ends in valid-looking padding and comes back
 * as bytes instead (the salt is random per run, so which runs hit that is
 * random too — the old `toThrow()` assertion failed intermittently). What a
 * wrong passphrase must never do is recover the data; that is what this checks.
 */
function wrongPassphraseRecovers(encrypted, plain, passphrase, iterations) {
  try {
    return decryptFromOpenssl(encrypted, passphrase, iterations).equals(plain);
  } catch {
    return false;
  }
}

describe('the v2 (AES-256-GCM) backup format', () => {
  const plain = zlib.gzipSync(Buffer.from('SELECT 1; -- ünïcödé 🏨\n'.repeat(500)));
  // Few iterations: these tests tamper with many positions.
  const encrypted = encryptBackup(plain, PASSPHRASE, 1000);

  test('round-trips, uses a fresh salt and IV every time, and starts with the version marker', () => {
    expect(encrypted.subarray(0, 4).toString('ascii')).toBe('LKBK');
    expect(encrypted[4]).toBe(2);
    expect(decryptBackup(encrypted, PASSPHRASE).equals(plain)).toBe(true);
    expect(encryptBackup(plain, PASSPHRASE, 1000).equals(encrypted)).toBe(false);
  });

  test('a wrong passphrase is always rejected (authenticated: no 1-in-256 quiet failure)', () => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      expect(() => decryptBackup(encrypted, `wrong-${attempt}`)).toThrow();
    }
  });

  test('a flipped bit ANYWHERE in the file is rejected — header, salt, iterations, IV, ciphertext and tag', () => {
    const positions = [0, 4, 5, 20, 21, 24, 25, 36, 37, 100, encrypted.length - 17, encrypted.length - 16, encrypted.length - 1];
    for (const position of positions) {
      const tampered = Buffer.from(encrypted);
      tampered[position] ^= 0x01;
      expect(() => decryptBackup(tampered, PASSPHRASE)).toThrow();
    }
  });

  test('a truncated or extended file is rejected', () => {
    expect(() => decryptBackup(encrypted.subarray(0, encrypted.length - 1), PASSPHRASE)).toThrow();
    expect(() => decryptBackup(Buffer.concat([encrypted, Buffer.from([0])]), PASSPHRASE)).toThrow();
    expect(() => decryptBackup(encrypted.subarray(0, 20), PASSPHRASE)).toThrow();
  });

  test('the standalone script opens it, and refuses (writing nothing) on tampering or a wrong passphrase', () => {
    const ok = runScript(encrypted, PASSPHRASE);
    expect(ok.status).toBe(0);
    expect(ok.produced.equals(plain)).toBe(true);

    const tampered = Buffer.from(encrypted);
    tampered[60] ^= 0x01;
    const bad = runScript(tampered, PASSPHRASE);
    expect(bad.status).toBe(1);
    expect(bad.produced).toBeNull();
    expect(bad.stderr).toMatch(/tampered|corrupted/i);

    const wrong = runScript(encrypted, 'definitely not it');
    expect(wrong.status).toBe(1);
    expect(wrong.produced).toBeNull();
  });

  test('the script bounds a hostile iteration count and rejects other files', () => {
    const hostile = Buffer.from(encrypted);
    hostile.writeUInt32BE(0xffffffff, 21);
    const result = runScript(hostile, PASSPHRASE);
    expect(result.status).toBe(1);
    expect(result.produced).toBeNull();
    expect(runScript(Buffer.from('hello world, not a backup at all......'), PASSPHRASE).status).toBe(1);
  });
});

describe('legacy (v1, OpenSSL CBC) backups emailed before v2 still restore', () => {
  const plain = zlib.gzipSync(Buffer.from('CREATE TABLE legacy (id int);\n'.repeat(300)));

  test('the standalone script opens a v1 file made with the old code, and so does the stock openssl command', () => {
    const legacy = encryptForOpenssl(plain, PASSPHRASE);
    const viaScript = runScript(legacy, PASSPHRASE);
    expect(viaScript.status).toBe(0);
    expect(viaScript.produced.equals(plain)).toBe(true);

    if (!hasOpenssl()) return;
    const file = path.join(os.tmpdir(), `lk-legacy-${process.pid}.enc`);
    fs.writeFileSync(file, legacy);
    try {
      const opened = execFileSync('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', String(PBKDF2_ITERATIONS), '-md', 'sha256', '-in', file, '-pass', `pass:${PASSPHRASE}`]);
      expect(Buffer.from(opened).equals(plain)).toBe(true);
    } finally {
      fs.unlinkSync(file);
    }
  });

  test('a v1 file whose contents are not a valid gzip (corrupted before encryption, or a quiet wrong-passphrase decrypt) is refused', () => {
    const notGzip = encryptForOpenssl(Buffer.from('this decrypts fine but is not gzip data at all'), PASSPHRASE);
    const result = runScript(notGzip, PASSPHRASE);
    expect(result.status).toBe(1);
    expect(result.produced).toBeNull();
    expect(result.stderr).toMatch(/gzip/i);
  });

  test('a wrong passphrase on a v1 file never produces output (padding failure or invalid gzip)', () => {
    const legacy = encryptForOpenssl(plain, PASSPHRASE, PBKDF2_ITERATIONS);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = runScript(legacy, `wrong-${attempt}`);
      expect(result.status).toBe(1);
      expect(result.produced).toBeNull();
    }
  });
});

describe('the backup file format', () => {
  test('encrypts in OpenSSL enc format: the real openssl binary opens it, and a wrong passphrase cannot', () => {
    const plain = zlib.gzipSync(Buffer.from('SELECT 1; -- ünïcödé 🏨\n'.repeat(500)));
    const encrypted = encryptForOpenssl(plain, PASSPHRASE);
    expect(encrypted.subarray(0, 8).toString('ascii')).toBe('Salted__');
    expect(decryptFromOpenssl(encrypted, PASSPHRASE).equals(plain)).toBe(true);
    expect(wrongPassphraseRecovers(encrypted, plain, 'not the passphrase at all')).toBe(false);
    // A fresh salt every time: the same data never encrypts the same way twice.
    expect(encryptForOpenssl(plain, PASSPHRASE).equals(encrypted)).toBe(false);

    if (!hasOpenssl()) return;
    const file = path.join(os.tmpdir(), `lk-backup-${process.pid}.enc`);
    fs.writeFileSync(file, encrypted);
    try {
      const opened = execFileSync('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', String(PBKDF2_ITERATIONS), '-md', 'sha256', '-in', file, '-pass', `pass:${PASSPHRASE}`]);
      expect(Buffer.from(opened).equals(plain)).toBe(true);
    } finally {
      fs.unlinkSync(file);
    }
  });

  test('a wrong passphrase that happens to pass the padding check still cannot recover the data', () => {
    // 1 PBKDF2 iteration so hundreds of attempts are cheap. Keep trying wrong
    // passphrases until one decrypts WITHOUT throwing (about 1 in 256) — the
    // exact case that made the old toThrow() assertion flaky — and check it
    // gives back garbage, not the data.
    const plain = zlib.gzipSync(Buffer.from('SELECT 1;\n'.repeat(50)));
    const encrypted = encryptForOpenssl(plain, PASSPHRASE, 1);
    let quietFailure = null;
    for (let attempt = 0; attempt < 5000 && !quietFailure; attempt += 1) {
      try {
        quietFailure = { passphrase: `wrong-${attempt}`, output: decryptFromOpenssl(encrypted, `wrong-${attempt}`, 1) };
      } catch {
        // the usual outcome: bad padding
      }
    }
    expect(quietFailure).not.toBeNull();
    expect(quietFailure.output.equals(plain)).toBe(false);
    expect(wrongPassphraseRecovers(encrypted, plain, quietFailure.passphrase, 1)).toBe(false);
    expect(wrongPassphraseRecovers(encrypted, plain, PASSPHRASE, 1)).toBe(true);
  });
});

describe('the SQL dump restores values exactly', () => {
  const awkward = `O'Brien \\ "Q" 🏨\nsecond line\ttab`;
  let platformUserId;
  let webhookEventId;

  beforeAll(async () => {
    [platformUserId] = await db()('platform_users').insert({ email: `dump-${Date.now()}@planmsys.test`, password_hash: 'x', first_name: awkward, last_name: '', role: 'support' });
    [webhookEventId] = await db()('payment_webhook_events').insert({
      provider: 'dumptest',
      provider_event_id: `dump-${Date.now()}`,
      payload: JSON.stringify({ quote: "it's", nested: { list: [1, 'two', null] }, emoji: '🏨', backslash: 'a\\b' }),
      verified: true,
      processed_at: '2027-03-04 05:06:07',
    });
  });

  afterAll(async () => {
    await db()('payment_webhook_events').where({ id: webhookEventId }).delete();
    await db()('platform_users').where({ id: platformUserId }).delete();
  });

  /** Replays the dump's INSERTs for `table` into a temporary copy, on one connection, and returns the copy's rows. */
  async function replay(sql, table) {
    const inserts = sql.split('\n\n').flatMap((block) => block.split(/;\n(?=INSERT INTO )/)).filter((statement) => statement.startsWith(`INSERT INTO \`${table}\``));
    expect(inserts.length).toBeGreaterThan(0);
    return db().transaction(async (trx) => {
      await trx.raw(`CREATE TEMPORARY TABLE \`copy_${table}\` LIKE \`${table}\``);
      for (const statement of inserts) {
        await trx.raw(statement.replace(`INSERT INTO \`${table}\``, `INSERT INTO \`copy_${table}\``).replace(/;$/, ''));
      }
      const rows = await trx(`copy_${table}`).select('*');
      await trx.raw(`DROP TEMPORARY TABLE \`copy_${table}\``);
      return rows;
    });
  }

  test('covers every table, disables foreign-key checks around the data, and counts rows', async () => {
    const { sql, tableCount, rowCount } = await dumpDatabaseSql();
    const [tables] = await db().raw("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'");
    expect(tableCount).toBe(Number(tables[0].n));
    expect(sql).toContain('CREATE TABLE `tenants`');
    expect(sql).toContain('CREATE TABLE `knex_migrations`');
    expect(sql.indexOf('SET FOREIGN_KEY_CHECKS = 0;')).toBeLessThan(sql.indexOf('CREATE TABLE'));
    expect(sql.trimEnd().split('\n').slice(-2)[0]).toBe('SET FOREIGN_KEY_CHECKS = 1;');
    expect(rowCount).toBeGreaterThan(0);
  });

  test('strings with quotes, backslashes, newlines and emoji come back byte for byte', async () => {
    const { sql } = await dumpDatabaseSql();
    const rows = await replay(sql, 'platform_users');
    expect(rows.find((row) => String(row.id) === String(platformUserId)).first_name).toBe(awkward);
  });

  test('JSON stays JSON and datetimes keep their exact stored value', async () => {
    const { sql } = await dumpDatabaseSql();
    const rows = await replay(sql, 'payment_webhook_events');
    const row = rows.find((candidate) => String(candidate.id) === String(webhookEventId));
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    expect(payload).toEqual({ quote: "it's", nested: { list: [1, 'two', null] }, emoji: '🏨', backslash: 'a\\b' });
    const original = await db()('payment_webhook_events').where({ id: webhookEventId }).first();
    expect(new Date(row.processed_at).toISOString()).toBe(new Date(original.processed_at).toISOString());
    expect(new Date(row.created_at).toISOString()).toBe(new Date(original.created_at).toISOString());
  });
});

describe('POST/GET /api/v1/platform/backups', () => {
  const t = useTestApp();
  let admin;
  let support;
  const sent = [];

  const token = (user) => signAccessToken({ aud: 'platform', sub: String(user.id) });
  const start = (user, body) => t.request.post('/api/v1/platform/backups').set('Authorization', `Bearer ${token(user)}`).send(body);
  const list = (user) => t.request.get('/api/v1/platform/backups').set('Authorization', `Bearer ${token(user)}`);

  async function settled(id) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = await t.trx('platform_backups').where({ id }).first();
      if (row.status !== 'running') return row;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('backup did not finish');
  }

  beforeAll(async () => {
    admin = await seedPlatformUser(t.trx, 'backup-admin@planmsys.test', 'admin');
    support = await seedPlatformUser(t.trx, 'backup-support@planmsys.test', 'support');
  });

  beforeEach(() => {
    sent.length = 0;
    emailAdapter.getEmailAdapter.mockReturnValue({ name: 'smtp', send: jest.fn(async (message) => sent.push(message)) });
  });

  test('an admin starts one: 202 at once, then the encrypted dump is emailed and the row records it', async () => {
    const res = await start(admin, { recipient_email: 'owner@example.com', passphrase: PASSPHRASE });
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ status: 'running', recipient_email: 'owner@example.com', requested_by_platform_user_id: String(admin.id) });
    expect(JSON.stringify(res.body)).not.toContain(PASSPHRASE);

    const row = await settled(res.body.data.id);
    expect(row).toMatchObject({ status: 'sent', email_provider: 'smtp', error: null });
    expect(row.file_name).toMatch(/^lodgekeep-backup-\d{8}-\d{6}\.sql\.gz\.enc$/);
    expect(Number(row.table_count)).toBeGreaterThan(50);

    expect(sent).toHaveLength(1);
    const [message] = sent;
    expect(message.to).toBe('owner@example.com');
    expect(message.html).toContain('decrypt-lodgekeep-backup.js');
    expect(message.html).not.toContain(PASSPHRASE);
    const attachment = message.attachments[0];
    expect(attachment.filename).toBe(row.file_name);
    expect(Number(row.size_bytes)).toBe(attachment.content.length);
    // The script attached to the email opens the attached backup, with nothing from LodgeKeep.
    const script = message.attachments[1];
    expect(script.filename).toBe('decrypt-lodgekeep-backup.js');
    expect(script.content.toString('utf8')).toBe(fs.readFileSync(DECRYPT_SCRIPT, 'utf8'));
    const opened = runScript(attachment.content, PASSPHRASE);
    expect(opened.status).toBe(0);
    const sql = zlib.gunzipSync(opened.produced).toString('utf8');
    expect(sql).toContain('CREATE TABLE `platform_backups`');

    // The passphrase is nowhere in the database.
    expect(JSON.stringify(await t.trx('platform_backups').where({ id: row.id }).first())).not.toContain(PASSPHRASE);
  });

  test('the history lists who asked, where it went and how it went, and says whether email is set up', async () => {
    const res = await list(support);
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ emailConfigured: true, emailProvider: 'smtp' });
    expect(res.body.data[0]).toMatchObject({ status: 'sent', recipient_email: 'owner@example.com', requested_by: { email: 'backup-admin@planmsys.test' } });
  });

  test('a support-tier account can see the history but cannot start one', async () => {
    const res = await start(support, { recipient_email: 'owner@example.com', passphrase: PASSPHRASE });
    expect(res.status).toBe(403);
  });

  test('a staff token cannot reach it at all', async () => {
    const staff = signAccessToken({ aud: 'staff', sub: '1', tenant_id: '1', property_id: '1' });
    const res = await t.request.get('/api/v1/platform/backups').set('Authorization', `Bearer ${staff}`);
    expect(res.status).toBe(401);
  });

  test('a bad email or a short passphrase is refused before anything runs', async () => {
    const before = await t.trx('platform_backups').count({ n: '*' }).first();
    const badEmail = await start(admin, { recipient_email: 'not-an-email', passphrase: PASSPHRASE });
    expect(badEmail.status).toBe(400);
    expect(badEmail.body.error.code).toBe('VALIDATION_INVALID_EMAIL');
    const shortPass = await start(admin, { recipient_email: 'owner@example.com', passphrase: 'short' });
    expect(shortPass.status).toBe(400);
    expect(shortPass.body.error.code).toBe('VALIDATION_WEAK_PASSPHRASE');
    expect((await t.trx('platform_backups').count({ n: '*' }).first()).n).toBe(before.n);
  });

  test('one at a time: a second while one is running is refused, naming it', async () => {
    const [runningId] = await t.trx('platform_backups').insert({ requested_by_platform_user_id: admin.id, recipient_email: 'x@example.com', status: 'running' });
    try {
      const res = await start(admin, { recipient_email: 'owner@example.com', passphrase: PASSPHRASE });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'CONFLICT_BACKUP_IN_PROGRESS', details: { backupId: Number(runningId) } });
    } finally {
      await t.trx('platform_backups').where({ id: runningId }).delete();
    }
  });

  test('a backup left "running" by a restart is reported as interrupted', async () => {
    const [staleId] = await t.trx('platform_backups').insert({
      requested_by_platform_user_id: admin.id,
      recipient_email: 'x@example.com',
      status: 'running',
      requested_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    const res = await list(admin);
    expect(res.body.data.find((row) => row.id === String(staleId))).toMatchObject({ status: 'failed', error: expect.stringMatching(/Interrupted/) });
  });

  test('a sending failure is recorded on the row, not lost', async () => {
    emailAdapter.getEmailAdapter.mockReturnValue({ name: 'smtp', send: jest.fn(async () => { throw new Error('550 mailbox unavailable'); }) });
    const res = await start(admin, { recipient_email: 'owner@example.com', passphrase: PASSPHRASE });
    expect(res.status).toBe(202);
    expect(await settled(res.body.data.id)).toMatchObject({ status: 'failed', error: '550 mailbox unavailable' });
  });

  test('with no real mailbox in production, a backup is refused before any data is read', async () => {
    emailAdapter.getEmailAdapter.mockReturnValue(emailAdapter.consoleAdapter);
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await start(admin, { recipient_email: 'owner@example.com', passphrase: PASSPHRASE });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_BACKUP_EMAIL_NOT_CONFIGURED');
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
