'use strict';

/**
 * The hotel's property-level terminal accounts: the bank accounts the front desk's physical card terminals pay
 * into, recorded so a room/folio terminal payment can say which account it went to and reconciliation can be
 * matched against that account's own settlement report. RECORDING ONLY (no money routing).
 *
 * The hotel-side twin of the POS outlet accounts (`pos/service.js`), which are per outlet; the validation is the
 * shared `shared/terminal-account-input.js`. An operator only ever sees id, name, provider and the last 4.
 */

const { scopedDb } = require('../../db');
const { ValidationError, withDuplicateMapping } = require('../../shared/errors');
const { lastFour, accountDisplayName, normalizeAccountInput } = require('../../shared/terminal-account-input');

function withLastFour(row) {
  return row ? { ...row, account_number_last4: lastFour(row.account_number) } : row;
}

async function listTerminalAccounts({ context }) {
  const rows = await scopedDb().for(context).table('property_terminal_accounts').orderBy('id');
  return rows.map(withLastFour);
}

/** What the payment form may show: id, name, provider and last 4 only, never the full number. */
async function listTerminalAccountOptions({ context }) {
  const rows = await scopedDb().for(context).table('property_terminal_accounts').orderBy('id');
  return rows.map((row) => ({ id: row.id, name: accountDisplayName(row), provider: row.provider, last4: lastFour(row.account_number) }));
}

async function createTerminalAccount({ context, input }) {
  const db = scopedDb().for(context);
  const values = normalizeAccountInput(input);
  return db.transaction(async (trx) => {
    const id = await withDuplicateMapping('property_terminal_accounts', 'This account number is already recorded for this property.', async () => {
      const [insertedId] = await trx.table('property_terminal_accounts').insert(values);
      return insertedId;
    });
    return withLastFour(await trx.table('property_terminal_accounts').where({ id }).first());
  });
}

async function updateTerminalAccount({ context, accountId, input }) {
  const db = scopedDb().for(context);
  const values = normalizeAccountInput(input);
  return db.transaction(async (trx) => {
    const existing = await trx.table('property_terminal_accounts').where({ id: accountId }).forUpdate().first();
    if (!existing) return null;
    await withDuplicateMapping('property_terminal_accounts', 'This account number is already recorded for this property.', async () => {
      await trx.table('property_terminal_accounts').where({ id: existing.id }).update(values);
    });
    return { before: withLastFour(existing), after: withLastFour(await trx.table('property_terminal_accounts').where({ id: existing.id }).first()) };
  });
}

/** Removing an account never touches a past payment: its snapshot has no foreign key to this row. */
async function removeTerminalAccount({ context, accountId }) {
  const db = scopedDb().for(context);
  const existing = await db.table('property_terminal_accounts').where({ id: accountId }).first();
  if (!existing) return null;
  await db.table('property_terminal_accounts').where({ id: existing.id }).delete();
  return withLastFour(existing);
}

/**
 * The snapshot a payment keeps of the account it was taken on: provider, display label and last 4. Called inside the
 * payment's transaction. An account that does not exist at this property is refused (nothing written).
 */
async function snapshotAccount({ trx, accountId }) {
  const account = await trx.table('property_terminal_accounts').where({ id: accountId }).first();
  if (!account) throw new ValidationError('INVALID_TERMINAL_ACCOUNT', 'That terminal account does not exist at this property.', [{ field: 'account_id', issue: 'invalid' }]);
  return { provider: account.provider ?? null, label: (accountDisplayName(account) ?? '').slice(0, 80) || null, last4: lastFour(account.account_number) };
}

module.exports = { listTerminalAccounts, listTerminalAccountOptions, createTerminalAccount, updateTerminalAccount, removeTerminalAccount, snapshotAccount };
