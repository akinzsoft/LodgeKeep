'use strict';

/**
 * Landing page content — the platform console edits it, the public landing page
 * reads it. See the migration's header for the storage model.
 *
 * What the PUBLIC read returns is deliberately small and tenant-free: the
 * validated overrides, plus two LIVE facts the page must never contradict — the
 * monthly fee from the billing plan and the real trial length. No tenant,
 * user or platform data is ever in it.
 */

const { scopedDb } = require('../../db');
const { systemContext } = require('../tenancy');
const { DEFAULT_TRIAL_PERIOD_DAYS } = require('../../shared/tenant-lifecycle');
const { AppError } = require('../../shared/errors');
const { validateContent } = require('./fields');

const versions = (context) => scopedDb().for(context).platform().table('landing_content_versions');

function parse(row) {
  if (!row) return null;
  const content = typeof row.content_json === 'string' ? JSON.parse(row.content_json) : row.content_json;
  return {
    id: String(row.id),
    content: content ?? {},
    note: row.note ?? null,
    created_by_platform_user_id: String(row.created_by_platform_user_id),
    created_at: row.created_at,
  };
}

/** The same plan billing charges for: the first active plan (billing's own `resolveDefaultPlan`). */
async function liveFacts() {
  const db = scopedDb().for(systemContext());
  const plan = await db.reference().table('plans').where({ is_active: true }).orderBy('id').first();
  return {
    monthly: plan ? { amount: plan.price, currency: plan.currency, interval: plan.billing_interval } : null,
    trialDays: DEFAULT_TRIAL_PERIOD_DAYS,
  };
}

async function latestVersion(context) {
  return parse(await versions(context).orderBy('id', 'desc').first());
}

/** What the public landing page fetches. */
async function getPublicContent() {
  const context = systemContext();
  const [current, facts] = await Promise.all([latestVersion(context), liveFacts()]);
  return { overrides: current?.content ?? {}, ...facts, updatedAt: current?.created_at ?? null };
}

/** What the console shows: the live version, recent history, and the live facts. */
async function getConsoleView({ context }) {
  const [rows, facts] = await Promise.all([versions(context).orderBy('id', 'desc').limit(20), liveFacts()]);
  const list = rows.map(parse);
  return { current: list[0] ?? null, versions: list, ...facts };
}

async function insertVersion(context, content, note) {
  const [id] = await versions(context).insert({
    content_json: JSON.stringify(content),
    note,
    created_by_platform_user_id: context.platformUserId,
  });
  return parse(await versions(context).where({ id }).first());
}

async function saveContent({ context, content }) {
  return insertVersion(context, validateContent(content), 'Saved');
}

async function resetToDefaults({ context }) {
  return insertVersion(context, {}, 'Reset to defaults');
}

async function restoreVersion({ context, versionId }) {
  const source = parse(await versions(context).where({ id: versionId }).first());
  if (!source) throw new AppError('LANDING_VERSION_NOT_FOUND', 'That version does not exist.', 404);
  // Re-validated: the allow-list may have changed since the version was saved.
  return insertVersion(context, validateContent(source.content), `Restored version ${source.id}`);
}

module.exports = { getPublicContent, getConsoleView, saveContent, resetToDefaults, restoreVersion };
