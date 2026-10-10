#!/usr/bin/env node
'use strict';

/**
 * Opens a LodgeKeep emailed database backup. Dependency-free: needs only Node 18+,
 * no LodgeKeep code, no database, no network. It is attached to every backup email.
 *
 *   LODGEKEEP_BACKUP_PASSPHRASE='the passphrase' node decrypt-lodgekeep-backup.js <backup.sql.gz.enc> <out.sql.gz>
 *   (or --passphrase-file <file>, or leave both off to be asked)
 *
 * Then:  gunzip out.sql.gz   and   mysql -u <user> -p <empty_database> < out.sql
 *
 * Formats understood:
 *   v2 (current)  "LKBK" | 0x02 | salt(16) | PBKDF2 iterations (uint32 BE) | IV(12) | ciphertext | GCM tag(16)
 *                 AES-256-GCM, key = PBKDF2-SHA256(passphrase, salt). The whole header is authenticated, and
 *                 the file is verified BEFORE any output is written: a corrupted or tampered file, or a wrong
 *                 passphrase, is refused and nothing is produced.
 *   v1 (legacy)   OpenSSL `enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256` ("Salted__" + salt + ciphertext).
 *                 Backups emailed before the v2 format. CBC carries NO integrity check, so a v1 file that
 *                 decrypts cannot be proven untampered; the gzip trailer checksum is the only protection.
 *                 (The stock `openssl enc -d ...` command still opens v1 files too.)
 *
 * This file is deliberately self-contained; backend/tests/platform/backup.test.js proves it agrees with the
 * code that writes the backups.
 */

const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');

const MAGIC = Buffer.from('LKBK', 'ascii');
const V2 = 2;
const HEADER_LENGTH = 4 + 1 + 16 + 4 + 12;
const TAG_LENGTH = 16;
const MAX_ITERATIONS = 10_000_000; // a header can't be trusted to ask for unbounded work
const LEGACY_ITERATIONS = 200000;

class BackupDecryptError extends Error {}

function decryptV2(file, passphrase) {
  if (file.length < HEADER_LENGTH + TAG_LENGTH) throw new BackupDecryptError('The file is too short to be a LodgeKeep backup.');
  const header = file.subarray(0, HEADER_LENGTH);
  const salt = header.subarray(5, 21);
  const iterations = header.readUInt32BE(21);
  const iv = header.subarray(25, 37);
  if (iterations < 1 || iterations > MAX_ITERATIONS) throw new BackupDecryptError('The backup header is invalid (corrupted).');
  const key = crypto.pbkdf2Sync(passphrase, salt, iterations, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(header);
  decipher.setAuthTag(file.subarray(file.length - TAG_LENGTH));
  try {
    return Buffer.concat([decipher.update(file.subarray(HEADER_LENGTH, file.length - TAG_LENGTH)), decipher.final()]);
  } catch {
    throw new BackupDecryptError('Wrong passphrase, or the backup file is corrupted or has been tampered with. Nothing was written.');
  }
}

function decryptLegacyV1(file, passphrase) {
  const salt = file.subarray(8, 16);
  const keyAndIv = crypto.pbkdf2Sync(passphrase, salt, LEGACY_ITERATIONS, 48, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-cbc', keyAndIv.subarray(0, 32), keyAndIv.subarray(32, 48));
  let plain;
  try {
    plain = Buffer.concat([decipher.update(file.subarray(16)), decipher.final()]);
  } catch {
    throw new BackupDecryptError('Wrong passphrase, or the backup file is corrupted.');
  }
  try {
    zlib.gunzipSync(plain); // the only integrity signal a v1 file has
  } catch {
    throw new BackupDecryptError('Wrong passphrase, or the backup file is corrupted (the result is not a valid gzip file).');
  }
  return plain;
}

function decryptBackup(file, passphrase) {
  if (file.subarray(0, 4).equals(MAGIC)) {
    if (file[4] !== V2) throw new BackupDecryptError(`This backup uses format version ${file[4]}, which this tool does not know. Use a newer decrypt-lodgekeep-backup.js.`);
    return decryptV2(file, passphrase);
  }
  if (file.subarray(0, 8).toString('ascii') === 'Salted__') return decryptLegacyV1(file, passphrase);
  throw new BackupDecryptError('This is not a LodgeKeep backup file.');
}

function readPassphrase(argv) {
  const fromFile = argv.indexOf('--passphrase-file');
  if (fromFile !== -1) return fs.readFileSync(argv[fromFile + 1], 'utf8').replace(/\r?\n$/, '');
  if (process.env.LODGEKEEP_BACKUP_PASSPHRASE) return process.env.LODGEKEEP_BACKUP_PASSPHRASE;
  return null;
}

function main(argv) {
  const args = argv.filter((arg, index) => !arg.startsWith('--') && argv[index - 1] !== '--passphrase-file');
  if (args.length !== 2) {
    console.error('Usage: LODGEKEEP_BACKUP_PASSPHRASE=... node decrypt-lodgekeep-backup.js <backup.sql.gz.enc> <out.sql.gz>');
    return 2;
  }
  const passphrase = readPassphrase(argv);
  if (!passphrase) {
    console.error('Set LODGEKEEP_BACKUP_PASSPHRASE, or pass --passphrase-file <file>.');
    return 2;
  }
  let plain;
  try {
    plain = decryptBackup(fs.readFileSync(args[0]), passphrase);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    return 1;
  }
  fs.writeFileSync(args[1], plain, { mode: 0o600 });
  console.error(`OK: ${plain.length} bytes written to ${args[1]}. Next: gunzip it, then load it into an EMPTY database.`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { decryptBackup, BackupDecryptError };
