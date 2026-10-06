'use strict';

/**
 * What the platform console may edit on the landing page, and how each field
 * is validated. This is an ALLOW-LIST: any key not named here is rejected, so
 * a new field must be added deliberately (and on the frontend too).
 *
 * The values are stored as OVERRIDES of the defaults in
 * `frontend/src/landing/landingContent.js`. A key that is absent means "use the
 * default". Everything is plain text: the page renders it as text, never HTML,
 * and the contact links are built from digits only.
 *
 * NOT editable, by decision: the monthly fee (read live from the billing plan)
 * and the trial length (the real trial setting) — and so also every line that
 * quotes them (the hero's "14-day free trial" line and the pricing card's trial
 * line, which the page builds from the real values) — so the page cannot promise
 * what customers are not charged or given.
 */

const { ValidationError } = require('../../shared/errors');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
const MEDIA_PATH = /^\/[A-Za-z0-9._\-/]+\.(mp4|webm|webp|png|jpe?g)$/;

const text = (max, { allowEmpty = false } = {}) => ({ kind: 'text', max, allowEmpty });

const SCHEMA = {
  hero: {
    headline: text(120),
    subhead: text(300),
    primaryCta: text(40),
    secondaryCta: text(40),
  },
  pricing: {
    title: text(80),
    lead: text(200),
    setupAmount: { kind: 'money', allowEmpty: true },
    setupLabel: text(60),
    includes: { kind: 'list', min: 1, max: 12, item: 140 },
  },
  contact: {
    title: text(80),
    lead: text(300),
    whatsapp: { kind: 'digits', allowEmpty: true },
    phone: { kind: 'digits', allowEmpty: true },
    email: { kind: 'email', allowEmpty: true },
    whatsappMessage: text(200),
  },
  testimonials: {
    items: { kind: 'testimonials', max: 6 },
  },
  video: {
    src: { kind: 'media', allowEmpty: true },
    poster: { kind: 'media', allowEmpty: true },
  },
};

function problem(path, issue, message) {
  return { field: path, issue, message };
}

function checkField(rule, value, path, problems) {
  const label = path;
  switch (rule.kind) {
    case 'text': {
      if (typeof value !== 'string') return problems.push(problem(path, 'invalid', `${label} must be text.`));
      const clean = value.trim();
      if (!clean && !rule.allowEmpty) return problems.push(problem(path, 'empty', `${label} cannot be empty.`));
      if (clean.length > rule.max) return problems.push(problem(path, 'too_long', `${label} must be at most ${rule.max} characters.`));
      return clean;
    }
    case 'money': {
      if (value === null || value === '') return '';
      const clean = String(value).trim();
      if (!MONEY.test(clean)) return problems.push(problem(path, 'invalid', `${label} must be an amount like 500000 or 500000.00.`));
      return Number(clean).toFixed(2);
    }
    case 'digits': {
      if (typeof value !== 'string') return problems.push(problem(path, 'invalid', `${label} must be a phone number.`));
      const digits = value.replace(/[\s()+-]/g, '');
      if (digits === '') return '';
      if (!/^\d{8,15}$/.test(digits)) return problems.push(problem(path, 'invalid', `${label} must be 8 to 15 digits in international form, e.g. 2347031308712.`));
      return digits;
    }
    case 'email': {
      if (typeof value !== 'string') return problems.push(problem(path, 'invalid', `${label} must be an email address.`));
      const clean = value.trim();
      if (clean === '') return '';
      if (clean.length > 255 || !EMAIL.test(clean)) return problems.push(problem(path, 'invalid', `${label} must be a valid email address.`));
      return clean;
    }
    case 'media': {
      if (typeof value !== 'string') return problems.push(problem(path, 'invalid', `${label} must be a file path.`));
      const clean = value.trim();
      if (clean === '') return '';
      if (clean.length > 200 || clean.includes('//') || clean.includes('..') || !MEDIA_PATH.test(clean)) {
        return problems.push(problem(path, 'invalid', `${label} must be a file on this site, like /lodgekeep-demo.mp4 (the page only plays files it hosts itself).`));
      }
      return clean;
    }
    case 'list': {
      if (!Array.isArray(value)) return problems.push(problem(path, 'invalid', `${label} must be a list.`));
      if (value.length < rule.min || value.length > rule.max) return problems.push(problem(path, 'invalid', `${label} needs ${rule.min} to ${rule.max} entries.`));
      const out = [];
      value.forEach((entry, index) => {
        const clean = typeof entry === 'string' ? entry.trim() : '';
        if (!clean || clean.length > rule.item) problems.push(problem(`${path}[${index}]`, 'invalid', `Each entry must be 1 to ${rule.item} characters.`));
        else out.push(clean);
      });
      return out;
    }
    case 'testimonials': {
      if (!Array.isArray(value) || value.length > rule.max) return problems.push(problem(path, 'invalid', `${label} must be a list of at most ${rule.max}.`));
      const out = [];
      value.forEach((entry, index) => {
        const quote = typeof entry?.quote === 'string' ? entry.quote.trim() : '';
        const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
        const role = typeof entry?.role === 'string' ? entry.role.trim() : '';
        if (!quote || quote.length > 400) problems.push(problem(`${path}[${index}].quote`, 'invalid', 'A testimonial needs a quote of up to 400 characters.'));
        if (!name || name.length > 80) problems.push(problem(`${path}[${index}].name`, 'invalid', 'A testimonial needs a name of up to 80 characters.'));
        if (role.length > 80) problems.push(problem(`${path}[${index}].role`, 'too_long', 'A role must be at most 80 characters.'));
        out.push({ quote, name, role });
      });
      return out;
    }
    default:
      return undefined;
  }
}

/**
 * Validates a whole overrides object. Unknown sections or fields are rejected
 * (not silently dropped), so the console cannot pretend to save something the
 * page will never show. Returns the cleaned object; throws ValidationError with
 * every problem found.
 */
function validateContent(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('INVALID_CONTENT', 'The content must be an object.', [problem('content', 'invalid', 'The content must be an object.')]);
  }
  const problems = [];
  const clean = {};
  for (const [section, fields] of Object.entries(input)) {
    const sectionSchema = SCHEMA[section];
    if (!sectionSchema) {
      problems.push(problem(section, 'unknown', `"${section}" is not an editable section.`));
      continue;
    }
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
      problems.push(problem(section, 'invalid', `"${section}" must be an object.`));
      continue;
    }
    for (const [field, value] of Object.entries(fields)) {
      const rule = sectionSchema[field];
      const path = `${section}.${field}`;
      if (!rule) {
        problems.push(problem(path, 'unknown', `"${path}" is not an editable field.`));
        continue;
      }
      const before = problems.length;
      const cleaned = checkField(rule, value, path, problems);
      if (problems.length === before && cleaned !== undefined) {
        clean[section] ??= {};
        clean[section][field] = cleaned;
      }
    }
  }
  if (problems.length > 0) {
    throw new ValidationError('INVALID_CONTENT', 'Some of the landing page content is not valid.', problems);
  }
  return clean;
}

module.exports = { validateContent, SCHEMA };
