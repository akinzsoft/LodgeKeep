'use strict';

/**
 * Tenant lifecycle e-mails: "your subscription is active" (one per active user, with their own login e-mail and the
 * tenant's new address) and "payment recorded" (to the tenant's super_admins). Called inside the transaction that changes
 * the tenant, by the platform console's Mark subscribed / Record payment actions and by the Paystack trial conversion.
 *
 * Idempotency: every (tenant, kind, user) is first INSERTED into `tenant_lifecycle_emails` (UNIQUE); only the insert that
 * wins writes the outbox event. Re-running the action, a retry, or the other trigger (console vs. card conversion) therefore
 * never sends a second e-mail to the same user for the same kind. Each user's e-mail is its own outbox event, so one bad
 * address fails alone while the others are delivered and retried independently.
 *
 * Nothing sensitive is ever put in the payload: no password, no code, no token. A user only gets their login e-mail,
 * the sign-in address, their role, and dates.
 */

const { writeOutboxEvent } = require('./outbox');
const { tenantBaseUrlFor } = require('./app-domains');

/**
 * @param {object} p
 * @param {object} p.platformDb  accessor with `.platform()` on the SAME transaction
 * @param {object} p.tenantDb    tenant-scoped accessor on the SAME transaction
 * @param {object} p.tenant      the tenants row AFTER the change (slug, name, app_domain)
 * @param {'subscribed'|'renewal'} p.kind
 * @param {string} p.kindKey     the idempotency kind, e.g. 'subscribed' or 'renewal:2027-05-01'
 * @param {object} p.payload     template variables common to every recipient
 * @param {boolean} [p.superAdminsOnly]
 * @returns {Promise<{queued:number, alreadySent:number, skipped:number, propertyIds:string[]}>}
 */
async function queueLifecycleEmails({ platformDb, tenantDb, tenant, kindKey, eventType, payload, superAdminsOnly = false }) {
  const users = await tenantDb.table('users').where({ status: 'active' }).orderBy('id').select('id', 'email');
  if (users.length === 0) return { queued: 0, alreadySent: 0, skipped: 0, propertyIds: [] };

  const access = await tenantDb.acrossProperties().table('user_property_access').whereIn('user_id', users.map((u) => u.id)).orderBy('property_id').select('user_id', 'property_id', 'role');
  const properties = await tenantDb.acrossProperties().table('properties').where({ status: 'active' }).select('id', 'name');
  const propertyById = new Map(properties.map((row) => [String(row.id), row]));

  const loginUrl = tenantBaseUrlFor(tenant);
  const result = { queued: 0, alreadySent: 0, skipped: 0, propertyIds: [] };

  for (const user of users) {
    const grants = access.filter((row) => String(row.user_id) === String(user.id) && propertyById.has(String(row.property_id)));
    if (grants.length === 0) { result.skipped += 1; continue; } // no active property to send from
    if (superAdminsOnly && !grants.some((row) => row.role === 'super_admin')) continue;
    const grant = superAdminsOnly ? grants.find((row) => row.role === 'super_admin') : grants[0];

    let lifecycleRowId;
    try {
      [lifecycleRowId] = await platformDb.platform().table('tenant_lifecycle_emails').insert({ tenant_id: tenant.id, kind: kindKey, user_id: user.id });
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') { result.alreadySent += 1; continue; }
      throw error;
    }

    const eventId = await writeOutboxEvent({
      trx: tenantDb,
      eventType,
      aggregateType: 'tenants',
      aggregateId: tenant.id,
      propertyId: grant.property_id,
      payload: {
        ...payload,
        recipientEmail: user.email,
        loginEmail: user.email,
        loginUrl,
        companyName: tenant.name,
        propertyName: propertyById.get(String(grant.property_id)).name,
        role: grant.role.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '),
      },
    });
    await platformDb.platform().table('tenant_lifecycle_emails').where({ id: lifecycleRowId }).update({ outbox_event_id: eventId });
    result.queued += 1;
    if (!result.propertyIds.includes(String(grant.property_id))) result.propertyIds.push(String(grant.property_id));
  }
  return result;
}

module.exports = { queueLifecycleEmails };
