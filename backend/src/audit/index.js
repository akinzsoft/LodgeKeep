'use strict';

/**
 * `src/audit`'s public surface — ARCHITECTURE.md §2: "/audit (audit trail
 * middleware/service)".
 */

const { recordAuditEntry } = require('./service');
const { attachAudit } = require('./middleware');

module.exports = { recordAuditEntry, attachAudit };
