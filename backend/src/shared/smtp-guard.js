'use strict';

/**
 * Safety rules for outgoing email: what a tenant may point the app's mail
 * sender at, and what may end up in a message header.
 *
 * - Custom SMTP host safety (SSRF): a tenant types its own host, so the app
 *   would otherwise open connections to any address on the tenant's behalf. We
 *   block private, loopback, link-local, carrier-grade-NAT, multicast and
 *   cloud-metadata ranges (IPv4 and IPv6, including IPv4-mapped IPv6), allow
 *   only the standard mail submission ports, and connect to the address we
 *   checked (not the name), so DNS cannot answer differently at connect time.
 * - Header safety: the From display name and the Reply-To value are built from
 *   tenant-controlled text, so control characters, quotes and angle brackets
 *   are stripped from the name and the address must be one plain mailbox.
 * - Secret scrubbing: SMTP error text is shown to tenants, so credentials are
 *   removed from it first.
 */

const dns = require('dns').promises;
const net = require('net');
const { AppError } = require('./errors');

const ALLOWED_SMTP_PORTS = [25, 465, 587, 2525];
const SMTP_SECURITY_MODES = ['tls', 'starttls'];

class SmtpHostRejectedError extends AppError {
  constructor(message) {
    super('VALIDATION_SMTP_HOST_REJECTED', message, 400, [{ field: 'smtp_host', issue: 'rejected' }]);
  }
}

/** Dev-only escape hatch (a local mail sink on localhost). Never honoured in production. */
function privateHostsAllowed() {
  return process.env.NODE_ENV !== 'production' && process.env.SMTP_ALLOW_PRIVATE_HOSTS === 'true';
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

const BLOCKED_V4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast
].map(([base, bits]) => ({ base: ipv4ToInt(base), mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0 }));

function isBlockedIPv4(ip) {
  const n = ipv4ToInt(ip) >>> 0;
  return BLOCKED_V4.some(({ base, mask }) => ((n & mask) >>> 0) === ((base & mask) >>> 0));
}

/** Expands an IPv6 literal to eight 16-bit groups, or null if it is not one. */
function parseIPv6(ip) {
  let address = ip.split('%')[0];
  let tail = [];
  const v4 = address.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[2]);
    tail = [(n >>> 16) & 0xffff, n & 0xffff];
    address = `${v4[1]}0:0`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest].map((g) => parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
  if (tail.length) {
    groups[6] = tail[0];
    groups[7] = tail[1];
  }
  return groups;
}

function isBlockedIPv6(ip) {
  const g = parseIPv6(ip);
  if (!g) return true; // cannot prove it is public
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible form.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return isBlockedIPv4(`${g[6] >>> 8}.${g[6] & 255}.${g[7] >>> 8}.${g[7] & 255}`);
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0064 && g[1] === 0xff9b) return true; // NAT64 well-known prefix
  return false;
}

function isBlockedAddress(ip) {
  if (net.isIPv4(ip)) return isBlockedIPv4(ip);
  if (net.isIPv6(ip)) return isBlockedIPv6(ip);
  return true;
}

function assertAllowedPort(port) {
  if (!ALLOWED_SMTP_PORTS.includes(Number(port))) {
    throw new SmtpHostRejectedError(`SMTP port must be one of ${ALLOWED_SMTP_PORTS.join(', ')}.`);
  }
}

/**
 * Resolves a tenant-supplied SMTP host and refuses it unless every address it
 * resolves to is public. Returns the address to connect to.
 */
async function resolveSafeSmtpHost(host) {
  const name = String(host ?? '').trim().toLowerCase();
  if (!name || name.length > 253 || /[\s/@:?#\\]/.test(name.replace(/^\[|\]$/g, '')) && !net.isIP(name.replace(/^\[|\]$/g, ''))) {
    throw new SmtpHostRejectedError('That SMTP host is not a valid host name.');
  }
  const literal = name.replace(/^\[|\]$/g, '');
  if (net.isIP(literal)) {
    if (isBlockedAddress(literal) && !privateHostsAllowed()) {
      throw new SmtpHostRejectedError('That SMTP host points to a private or internal address, which is not allowed.');
    }
    return { address: literal, family: net.isIPv6(literal) ? 6 : 4 };
  }
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.internal') || name.endsWith('.local')) {
    if (!privateHostsAllowed()) {
      throw new SmtpHostRejectedError('That SMTP host points to a private or internal address, which is not allowed.');
    }
  }
  let records;
  try {
    records = await dns.lookup(name, { all: true });
  } catch {
    throw new SmtpHostRejectedError('That SMTP host could not be found. Check the spelling of the host name.');
  }
  if (!records.length) throw new SmtpHostRejectedError('That SMTP host could not be found.');
  if (!privateHostsAllowed() && records.some((r) => isBlockedAddress(r.address))) {
    throw new SmtpHostRejectedError('That SMTP host points to a private or internal address, which is not allowed.');
  }
  return { address: records[0].address, family: records[0].family };
}

/** Control characters (incl. CR/LF), and anything that could open or close a header token. */
const UNSAFE_NAME_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029"\'`<>\\\\;,]', 'g');

/** Makes a property name safe to use as a From display name. Never returns an empty string. */
function sanitizeDisplayName(name, fallback = 'LodgeKeep') {
  const cleaned = String(name ?? '')
    .replace(UNSAFE_NAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');
const SINGLE_EMAIL = /^[A-Za-z0-9.!#$%&*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** True only for exactly one plain mailbox address: no name part, list, comment or control character. */
function isSingleEmailAddress(value) {
  if (typeof value !== 'string') return false;
  if (CONTROL_CHARS.test(value)) return false;
  if (value !== value.trim() || value.length > 254) return false;
  return SINGLE_EMAIL.test(value);
}

/** Removes known secret values (and any `user:password@` URL credentials) from error text shown to a person. */
function scrubSecrets(message, secrets = []) {
  let text = String(message ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 3) text = text.split(secret).join('***');
  }
  text = text.replace(/\/\/[^\s/:@]+:[^\s/@]+@/g, '//***@');
  text = text.replace(/(pass(?:word)?|pwd|auth(?:orization)?|token)(["'\s:=]+)[^\s"',;]+/gi, '$1$2***');
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

module.exports = {
  ALLOWED_SMTP_PORTS,
  SMTP_SECURITY_MODES,
  SmtpHostRejectedError,
  privateHostsAllowed,
  isBlockedAddress,
  assertAllowedPort,
  resolveSafeSmtpHost,
  sanitizeDisplayName,
  isSingleEmailAddress,
  scrubSecrets,
};
