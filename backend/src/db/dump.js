'use strict';

/**
 * A logical SQL dump of the whole database, in plain Node — the platform
 * console's backup (user-requested). No `mysqldump` binary exists in the
 * backend image, and a MariaDB client's dump of a MySQL 8 server has known
 * incompatibilities, so the dump is written here instead: for every base
 * table, `DROP TABLE IF EXISTS` + its own `SHOW CREATE TABLE`, then its rows
 * as multi-row INSERTs, all between `SET FOREIGN_KEY_CHECKS=0/1`, so the
 * file restores with a plain `mysql <database> < file.sql`.
 *
 * A deliberate, narrow exception to "every module reaches the database
 * through the scoped accessor" (the same one `shared/health.js` and the
 * tenant purge make): a backup is, by definition, every row of every
 * tenant. It lives in `src/db`, the one place the lint rule lets open a
 * connection, and only READS.
 *
 * Correctness choices:
 *   - One dedicated connection in a `READ ONLY` transaction `WITH
 *     CONSISTENT SNAPSHOT`: every table is read at the same instant, so a
 *     booking committed mid-backup is either wholly in it or wholly out.
 *   - `dateStrings: true`: dates and datetimes come back as the exact
 *     stored text (the app stores UTC), never re-interpreted in a timezone.
 *   - JSON columns come back as their UTF-8 text (mysql2 would otherwise
 *     parse them into objects, which escape as `key = value` pairs, not
 *     JSON; and read without an explicit encoding, the protocol's binary
 *     flag mangles emoji — caught by the dump's own round-trip test).
 *   - DECIMAL and BIGINT stay strings (the app's own connection settings).
 *   - Generated columns (VIRTUAL/STORED) are left out of the INSERTs — MySQL
 *     recomputes them. `DEFAULT_GENERATED` (a `DEFAULT CURRENT_TIMESTAMP`
 *     column) is real data and is kept; matching plain "GENERATED" dropped
 *     every `created_at`, caught by the round-trip test.
 */

const mysql = require('mysql2/promise');
const knexfile = require('../../knexfile');

const ROWS_PER_SELECT = 1000;
const ROWS_PER_INSERT = 200;

const ident = (name) => `\`${String(name).replace(/`/g, '``')}\``;

async function openDumpConnection() {
  const env = process.env.NODE_ENV || 'development';
  const config = knexfile[env];
  if (!config) throw new Error(`No knexfile config for NODE_ENV="${env}".`);
  return mysql.createConnection({
    ...config.connection,
    dateStrings: true,
    typeCast(field, next) {
      // JSON arrives flagged as binary: decode it as UTF-8 explicitly, or emoji and accents are mangled.
      if (field.type === 'JSON') return field.string('utf8');
      return next();
    },
  });
}

/**
 * @returns {Promise<{sql: string, tableCount: number, rowCount: number}>}
 */
async function dumpDatabaseSql({ now = new Date() } = {}) {
  const conn = await openDumpConnection();
  const parts = [];
  let rowCount = 0;
  try {
    await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [[{ db }]] = await conn.query('SELECT DATABASE() AS db');
    const [tables] = await conn.query(
      "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"
    );

    parts.push(
      `-- LodgeKeep database backup of \`${db}\`, taken ${now.toISOString()}`,
      `-- ${tables.length} tables. Restore into an EMPTY database: mysql -u <user> -p <database> < this-file.sql`,
      '/*!40101 SET NAMES utf8mb4 */;',
      "SET time_zone = '+00:00';",
      'SET FOREIGN_KEY_CHECKS = 0;',
      "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';",
      ''
    );

    for (const { name } of tables) {
      const [[created]] = await conn.query(`SHOW CREATE TABLE ${ident(name)}`);
      parts.push(`DROP TABLE IF EXISTS ${ident(name)};`, `${created['Create Table']};`, '');

      const [columns] = await conn.query(
        'SELECT COLUMN_NAME AS name, EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
        [name]
      );
      // Only real generated columns (VIRTUAL/STORED GENERATED) are recomputed by MySQL. `DEFAULT_GENERATED`
      // is MySQL 8's mark on `DEFAULT CURRENT_TIMESTAMP` columns — those hold real data and must be kept.
      const insertable = columns.filter((column) => !/\b(VIRTUAL|STORED) GENERATED\b/i.test(column.extra)).map((column) => column.name);
      const [keyColumns] = await conn.query(
        "SELECT COLUMN_NAME AS name FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION",
        [name]
      );
      const columnList = insertable.map(ident).join(', ');
      const orderBy = keyColumns.length ? ` ORDER BY ${keyColumns.map((column) => ident(column.name)).join(', ')}` : '';

      const writeRows = (rows) => {
        for (let start = 0; start < rows.length; start += ROWS_PER_INSERT) {
          const values = rows
            .slice(start, start + ROWS_PER_INSERT)
            .map((row) => `(${row.map((value) => conn.escape(value)).join(', ')})`)
            .join(',\n');
          parts.push(`INSERT INTO ${ident(name)} (${columnList}) VALUES\n${values};`);
        }
        rowCount += rows.length;
      };
      if (keyColumns.length) {
        // Paged in primary-key order; the snapshot keeps pages consistent.
        for (let offset = 0; ; offset += ROWS_PER_SELECT) {
          const [rows] = await conn.query({ sql: `SELECT ${columnList} FROM ${ident(name)}${orderBy} LIMIT ? OFFSET ?`, rowsAsArray: true }, [ROWS_PER_SELECT, offset]);
          writeRows(rows);
          if (rows.length < ROWS_PER_SELECT) break;
        }
      } else {
        // No primary key, so no stable order to page by: read it in one go.
        const [rows] = await conn.query({ sql: `SELECT ${columnList} FROM ${ident(name)}`, rowsAsArray: true });
        writeRows(rows);
      }
      parts.push('');
    }

    parts.push('SET FOREIGN_KEY_CHECKS = 1;', `-- End of backup (${rowCount} rows).`, '');
    await conn.query('COMMIT');
    return { sql: parts.join('\n'), tableCount: tables.length, rowCount };
  } finally {
    await conn.end();
  }
}

module.exports = { dumpDatabaseSql };
