'use strict';

/**
 * Every action that needs a manager's approval at the moment it happens, and
 * what the approving manager must hold — the one place a new gated action is
 * added (a front-desk fee override, a discount or comp later): one entry here
 * plus one `consumeApproval` call where the action runs.
 *
 * `permission` is checked for the APPROVER, fresh, at the property, both when
 * the PIN is entered and again when the approval is used (a manager demoted
 * in between can no longer approve). `targetType` names the record the
 * approval is bound to; `targetRequired: false` only for an action whose
 * record does not exist yet when the manager approves (a supermarket sale
 * confirmed past recorded stock).
 */

const APPROVAL_ACTIONS = Object.freeze({
  'pos.void_settlement': {
    permission: 'pos.manage',
    targetType: 'pos_order_settlements',
    targetRequired: true,
    label: 'Void a settled payment',
  },
  'pos.refund_payment': {
    permission: 'pos.manage',
    targetType: 'payments',
    targetRequired: true,
    label: 'Refund a card payment',
  },
  'pos.stock_override': {
    permission: 'pos.manage',
    targetType: 'pos_orders',
    targetRequired: true,
    label: 'Sell past recorded stock',
  },
  'supermarket.void_sale': {
    permission: 'supermarket.manage',
    targetType: 'supermarket_sales',
    targetRequired: true,
    label: 'Void a supermarket sale',
  },
  'supermarket.refund_online': {
    permission: 'supermarket.manage',
    targetType: 'supermarket_sale_intents',
    targetRequired: true,
    label: 'Refund an online payment',
  },
  'supermarket.oversell': {
    permission: 'supermarket.manage',
    targetType: null,
    targetRequired: false,
    label: 'Sell more than recorded stock',
  },
});

/** The action's definition, or null for a key that is not registered. */
function approvalAction(action) {
  return Object.hasOwn(APPROVAL_ACTIONS, action ?? '') ? APPROVAL_ACTIONS[action] : null;
}

module.exports = { APPROVAL_ACTIONS, approvalAction };
