'use strict';

const { ValidationError } = require('./errors');
const { isSupermarketOutlet, STORE_OUTLET_TYPE } = require('./outlet-types');

/** A rate is 0 to 30 with at most 2 decimals. */
const MAX_SERVICE_CHARGE_PERCENT = '30';
const QR_MODES = ['charge', 'none'];

/** Supermarkets and stores never carry a service charge, whatever their stored columns say. */
function serviceChargeApplies(outlet) {
  return Boolean(outlet) && !isSupermarketOutlet(outlet) && outlet.type !== STORE_OUTLET_TYPE;
}

/** The rate the staff Register charges at this outlet, as a decimal string ('0' where none applies). */
function registerServiceChargePercent(outlet) {
  if (!serviceChargeApplies(outlet)) return '0';
  return String(outlet.service_charge_percent ?? '7.50');
}

/** The rate a guest QR order is charged at this outlet, or null for "no service charge on QR orders". */
function qrServiceChargePercent(outlet) {
  if (!serviceChargeApplies(outlet) || outlet.qr_service_charge_mode !== 'charge') return null;
  return String(outlet.service_charge_percent ?? '7.50');
}

function parseServiceChargePercent(value) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,2}(\.\d{1,2})?$/.test(text.trim())) {
    throw new ValidationError('INVALID_SERVICE_CHARGE_PERCENT', 'The service charge must be a number from 0 to 30 with at most 2 decimals.', [{ field: 'service_charge_percent', issue: 'invalid' }]);
  }
  const [whole, fraction = ''] = text.trim().split('.');
  const hundredths = Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
  if (hundredths > Number(MAX_SERVICE_CHARGE_PERCENT) * 100) {
    throw new ValidationError('INVALID_SERVICE_CHARGE_PERCENT', 'The service charge cannot be more than 30%.', [{ field: 'service_charge_percent', issue: 'too_large' }]);
  }
  return `${whole}.${`${fraction}00`.slice(0, 2)}`;
}

function parseQrMode(value) {
  if (!QR_MODES.includes(value)) {
    throw new ValidationError('INVALID_QR_SERVICE_CHARGE_MODE', '"qr_service_charge_mode" must be "charge" or "none".', [{ field: 'qr_service_charge_mode', issue: 'invalid' }]);
  }
  return value;
}

module.exports = { MAX_SERVICE_CHARGE_PERCENT, QR_MODES, serviceChargeApplies, registerServiceChargePercent, qrServiceChargePercent, parseServiceChargePercent, parseQrMode };
