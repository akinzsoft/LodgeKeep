/**
 * The Standard plan's monthly price is now NGN 35,000 (it was seeded at 50,000),
 * matching the price quoted on the public landing page so a tenant is never
 * charged more than was quoted.
 *
 * Only a plan still at the original seeded 50,000.00 is changed, so a price an
 * operator set by hand is never overwritten. Invoices copy the plan's price when
 * they are created (billing/service.js), so existing invoices keep the amount
 * they were issued at; only invoices created from now on use the new price.
 */
const DEFAULT_PLAN_CODE = 'standard';

exports.up = async function up(knex) {
  await knex('plans').where({ code: DEFAULT_PLAN_CODE, price: '50000.00' }).update({ price: '35000.00' });
};

exports.down = async function down(knex) {
  await knex('plans').where({ code: DEFAULT_PLAN_CODE, price: '35000.00' }).update({ price: '50000.00' });
};
