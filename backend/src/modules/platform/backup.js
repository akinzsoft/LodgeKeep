'use strict';

/**
 * Whole-database backups, emailed from the platform console
 * (user-requested: "a feature in the platform page where I can click Backup
 * and specify the email to send it to"). Confirmed with the user: the WHOLE
 * database; encrypted with a passphrase typed for that one backup; platform
 * admins only (the route enforces `requirePlatformRole('admin')`).
 *
 * The passphrase exists only in this process's memory for the few seconds
 * the backup takes. It is never written to the database, a log, Redis or the
 * email — which is why the work runs in-process right after the request is
 * answered, not as a queued job (a job payload would persist it). The price:
 * a backup running when the process restarts is lost; `listBackups` reports
 * such a row as failed after `STALE_AFTER_MS` rather than leaving it
 * "running" forever, and the admin simply clicks Backup again.
 *
 * The file: SQL (`src/db/dump.js`) → gzip → AES-256-CBC in OpenSSL's own
 * `enc` format with a PBKDF2-SHA256 key (salted), so it opens with a stock
 * command and no LodgeKeep code:
 *   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -in <file> -out backup.sql.gz
 *
 * It is sent through the SERVER's own mailbox (`EMAIL_PROVIDER`/`SMTP_*`),
 * never a hotel's Setup → Email settings: every hotel's data must not travel
 * through one customer's mail account. With no real server mailbox in
 * production the backup is refused before any data is read.
 *
 * `platform_backups` is the permanent record of every copy of the database
 * that left the server: who, to which address, when, how big, and whether
 * it was delivered. The file itself is not kept on the server.
 */

const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const { scopedDb } = require('../../db');
const { dumpDatabaseSql } = require('../../db/dump');
const { systemContext } = require('../tenancy');
const { getEmailAdapter, isUndeliverable } = require('../notifications/email-adapter');
const { AppError, ValidationError } = require('../../shared/errors');

const gzip = promisify(zlib.gzip);

const PBKDF2_ITERATIONS = 200000;
const MIN_PASSPHRASE_LENGTH = 12;
const STALE_AFTER_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // most mailboxes refuse attachments over ~20-25 MB
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class BackupInProgressError extends AppError {
  constructor(backupId) {
    super('CONFLICT_BACKUP_IN_PROGRESS', `A backup is already running (#${backupId}). Wait for it to finish.`, 409, { backupId });
  }
}

class BackupEmailNotConfiguredError extends AppError {
  constructor() {
    super(
      'BUSINESS_RULE_BACKUP_EMAIL_NOT_CONFIGURED',
      'This server has no email mailbox configured (EMAIL_PROVIDER / SMTP_* in .env.production), so a backup cannot be emailed.',
      422
    );
  }
}

function maxAttachmentBytes() {
  const value = Number(process.env.BACKUP_EMAIL_MAX_BYTES);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_ATTACHMENT_BYTES;
}

/** OpenSSL `enc -aes-256-cbc -pbkdf2 -iter N -md sha256` format: "Salted__" + 8-byte salt + ciphertext. */
function encryptForOpenssl(plain, passphrase, iterations = PBKDF2_ITERATIONS) {
  const salt = crypto.randomBytes(8);
  const keyAndIv = crypto.pbkdf2Sync(passphrase, salt, iterations, 48, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-cbc', keyAndIv.subarray(0, 32), keyAndIv.subarray(32, 48));
  return Buffer.concat([Buffer.from('Salted__', 'ascii'), salt, cipher.update(plain), cipher.final()]);
}

/** The inverse, for tests and for anyone restoring without openssl at hand. */
function decryptFromOpenssl(encrypted, passphrase, iterations = PBKDF2_ITERATIONS) {
  if (encrypted.subarray(0, 8).toString('ascii') !== 'Salted__') throw new Error('Not an OpenSSL salted file.');
  const salt = encrypted.subarray(8, 16);
  const keyAndIv = crypto.pbkdf2Sync(passphrase, salt, iterations, 48, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-cbc', keyAndIv.subarray(0, 32), keyAndIv.subarray(32, 48));
  return Buffer.concat([decipher.update(encrypted.subarray(16)), decipher.final()]);
}

const platformTable = (context) => scopedDb().for(context).platform().table('platform_backups');
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function emailBody({ fileName, sizeBytes, tableCount, rowCount, takenAt, requestedBy }) {
  return `
<p>Your LodgeKeep database backup is attached.</p>
<p><strong>${fileName}</strong><br>
Taken ${takenAt.toISOString().replace('T', ' ').slice(0, 19)} UTC by ${requestedBy}<br>
${tableCount} tables, ${rowCount} rows, ${formatBytes(sizeBytes)} encrypted.</p>
<p>It is encrypted with the passphrase typed when the backup was started. The passphrase is not in this email and is not stored anywhere by LodgeKeep — without it the file cannot be opened.</p>
<p><strong>To restore</strong> (into an empty database):</p>
<pre>openssl enc -d -aes-256-cbc -pbkdf2 -iter ${PBKDF2_ITERATIONS} -md sha256 -in ${fileName} -out lodgekeep-backup.sql.gz
gunzip lodgekeep-backup.sql.gz
mysql -u &lt;user&gt; -p &lt;empty_database&gt; &lt; lodgekeep-backup.sql</pre>
<p>This file holds every hotel's guest details and financial records. Keep it somewhere safe and delete copies you no longer need.</p>
`;
}

/**
 * Validates, records the request, and starts the backup. Returns the new
 * row at once plus `done`, a promise that settles when the backup has been
 * sent or has failed (the controller does not wait for it; tests do).
 */
async function startBackup({ context, recipientEmail, passphrase }) {
  const email = String(recipientEmail ?? '').trim();
  if (!EMAIL_PATTERN.test(email) || email.length > 255) {
    throw new ValidationError('INVALID_EMAIL', 'Enter the email address to send the backup to.', [{ field: 'recipient_email', issue: 'invalid' }]);
  }
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new ValidationError('WEAK_PASSPHRASE', `The passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`, [{ field: 'passphrase', issue: 'too_short' }]);
  }
  const adapter = getEmailAdapter();
  if (isUndeliverable(adapter)) throw new BackupEmailNotConfiguredError();

  await expireStaleBackups();
  const running = await platformTable(context).where({ status: 'running' }).orderBy('id', 'asc').first();
  if (running) throw new BackupInProgressError(Number(running.id));

  // Stamped by the app, like the stale-backup cutoff it is compared with — never mix the database's clock with ours.
  const [id] = await platformTable(context).insert({
    requested_by_platform_user_id: context.platformUserId,
    recipient_email: email,
    status: 'running',
    requested_at: new Date(),
  });
  const requester = await scopedDb().for(context).platform().table('platform_users').where({ id: context.platformUserId }).first();
  const requestedBy = requester ? [requester.first_name, requester.last_name].filter(Boolean).join(' ') || requester.email : 'a platform admin';
  const backup = await platformTable(context).where({ id }).first();

  const done = runBackup({ id, email, passphrase, adapter, requestedBy });
  return { backup, done };
}

async function runBackup({ id, email, passphrase, adapter, requestedBy }) {
  try {
    const takenAt = new Date();
    const { sql, tableCount, rowCount } = await dumpDatabaseSql({ now: takenAt });
    const encrypted = encryptForOpenssl(await gzip(Buffer.from(sql, 'utf8')), passphrase);
    const fileName = `lodgekeep-backup-${stamp(takenAt)}.sql.gz.enc`;
    if (encrypted.length > maxAttachmentBytes()) {
      throw new Error(`The backup is ${formatBytes(encrypted.length)} — too big to email (limit ${formatBytes(maxAttachmentBytes())}).`);
    }
    await adapter.send({
      to: email,
      subject: `LodgeKeep database backup — ${takenAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      html: emailBody({ fileName, sizeBytes: encrypted.length, tableCount, rowCount, takenAt, requestedBy }),
      attachments: [{ filename: fileName, content: encrypted, contentType: 'application/octet-stream' }],
    });
    await platformTable(systemContext()).where({ id }).update({
      status: 'sent',
      file_name: fileName,
      size_bytes: encrypted.length,
      table_count: tableCount,
      row_count: rowCount,
      email_provider: adapter.name,
      completed_at: new Date(),
    });
  } catch (error) {
    try {
      await platformTable(systemContext())
        .where({ id })
        .update({ status: 'failed', error: String(error?.message ?? error).slice(0, 500), completed_at: new Date() });
    } catch {
      // The row stays "running" and is reported as interrupted after STALE_AFTER_MS.
    }
  }
}

/** A backup still "running" long after it started was interrupted (the process restarted): say so. */
async function expireStaleBackups() {
  await platformTable(systemContext())
    .where({ status: 'running' })
    .where('requested_at', '<', new Date(Date.now() - STALE_AFTER_MS))
    .update({ status: 'failed', error: 'Interrupted — the server restarted before the backup finished. Start it again.', completed_at: new Date() });
}

async function listBackups({ context }) {
  await expireStaleBackups();
  const rows = await platformTable(context).orderBy('id', 'desc').limit(50);
  const userIds = [...new Set(rows.map((row) => String(row.requested_by_platform_user_id)))];
  const users = userIds.length
    ? new Map((await scopedDb().for(context).platform().table('platform_users').whereIn('id', userIds).select('id', 'email', 'first_name', 'last_name')).map((u) => [String(u.id), u]))
    : new Map();
  const adapter = getEmailAdapter();
  return {
    emailConfigured: !isUndeliverable(adapter),
    emailProvider: adapter.name,
    backups: rows.map((row) => {
      const user = users.get(String(row.requested_by_platform_user_id));
      return { ...row, requested_by: user ? { email: user.email, name: [user.first_name, user.last_name].filter(Boolean).join(' ') || null } : null };
    }),
  };
}

module.exports = {
  startBackup,
  listBackups,
  encryptForOpenssl,
  decryptFromOpenssl,
  PBKDF2_ITERATIONS,
  MIN_PASSPHRASE_LENGTH,
  STALE_AFTER_MS,
  BackupInProgressError,
  BackupEmailNotConfiguredError,
};
