'use strict';

/** `src/modules/discounts`' public surface. The settlement paths use `store`; the HTTP layer is `discountsRouter`. */

const { discountsRouter } = require('./routes');
const service = require('./service');
const store = require('./store');

module.exports = { discountsRouter, service, store };
