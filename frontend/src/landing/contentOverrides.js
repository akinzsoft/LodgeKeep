/**
 * Applying the platform console's saved overrides to the landing page defaults,
 * and turning an edited form back into overrides. Pure functions, shared by the
 * public page and the console screen, so what the console previews is exactly
 * what the page will show.
 *
 * The defaults live in `landingContent.js`. The server stores only OVERRIDES and
 * validates them (backend `landing-content/fields.js`); this side is defensive
 * anyway and ignores anything of the wrong shape. Two things are never taken from
 * the overrides: the monthly fee and the trial length. They come from the
 * server's live facts (the billing plan and the real trial setting), and every
 * line that quotes them is built from those values.
 */

/** One entry per editable field. `kind` decides how a blank value is treated. */
export const EDITABLE_FIELDS = [
  { section: 'hero', field: 'headline', kind: 'text' },
  { section: 'hero', field: 'subhead', kind: 'text' },
  { section: 'hero', field: 'primaryCta', kind: 'text' },
  { section: 'hero', field: 'secondaryCta', kind: 'text' },
  { section: 'pricing', field: 'title', kind: 'text' },
  { section: 'pricing', field: 'lead', kind: 'text' },
  { section: 'pricing', field: 'setupAmount', kind: 'optional' },
  { section: 'pricing', field: 'setupLabel', kind: 'text' },
  { section: 'pricing', field: 'includes', kind: 'list' },
  { section: 'contact', field: 'title', kind: 'text' },
  { section: 'contact', field: 'lead', kind: 'text' },
  { section: 'contact', field: 'whatsapp', kind: 'optional' },
  { section: 'contact', field: 'phone', kind: 'optional' },
  { section: 'contact', field: 'email', kind: 'optional' },
  { section: 'contact', field: 'whatsappMessage', kind: 'text' },
  { section: 'testimonials', field: 'items', kind: 'items' },
  { section: 'video', field: 'src', kind: 'optional' },
  { section: 'video', field: 'poster', kind: 'optional' },
];

const isText = (value) => typeof value === 'string' && value.trim() !== '';

function usable(kind, value) {
  switch (kind) {
    case 'text':
      return isText(value);
    case 'optional':
      return typeof value === 'string';
    case 'list':
      return Array.isArray(value) && value.length > 0 && value.every(isText);
    case 'items':
      return Array.isArray(value) && value.every((item) => item && isText(item.quote) && isText(item.name));
    default:
      return false;
  }
}

export function trialLine(days, { capital = false } = {}) {
  return `${days}-day free trial · ${capital ? 'No' : 'no'} card needed to start`;
}

/** The page's content: the defaults, with the saved overrides and the live facts applied. */
export function applyOverrides(defaults, payload) {
  const content = {};
  for (const [section, value] of Object.entries(defaults)) {
    content[section] = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : value;
  }
  if (!payload || typeof payload !== 'object') return content;

  const overrides = payload.overrides && typeof payload.overrides === 'object' ? payload.overrides : {};
  for (const { section, field, kind } of EDITABLE_FIELDS) {
    const value = overrides?.[section]?.[field];
    if (value !== undefined && content[section] && usable(kind, value)) content[section][field] = value;
  }

  const monthly = payload.monthly;
  if (monthly && isText(monthly.amount) && isText(monthly.currency)) {
    content.pricing.amount = monthly.amount;
    content.pricing.currency = monthly.currency;
    if (monthly.interval === 'monthly') content.pricing.interval = 'per month';
  }

  const days = Number(payload.trialDays);
  if (Number.isInteger(days) && days > 0 && days <= 365) {
    content.pricing.trial = trialLine(days);
    content.hero.reassurance = trialLine(days, { capital: true });
  }
  return content;
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The overrides to save for an edited form: only fields that differ from the
 * defaults. A blank text field means "use the default" (omitted); a blank
 * optional field (a contact channel, the setup fee, the video) is kept as ''
 * when the default is not blank, because that means "hide it".
 */
export function overridesFromForm(form, defaults) {
  const overrides = {};
  for (const { section, field, kind } of EDITABLE_FIELDS) {
    let value = form?.[section]?.[field];
    if (kind === 'text' || kind === 'optional') value = typeof value === 'string' ? value.trim() : '';
    if (kind === 'list') value = (Array.isArray(value) ? value : []).map((entry) => String(entry).trim()).filter(Boolean);
    if (kind === 'items') {
      value = (Array.isArray(value) ? value : [])
        .map((item) => ({ quote: String(item?.quote ?? '').trim(), name: String(item?.name ?? '').trim(), role: String(item?.role ?? '').trim() }))
        .filter((item) => item.quote || item.name || item.role);
    }
    if (kind === 'text' && value === '') continue;
    if (kind === 'list' && value.length === 0) continue;
    const base = defaults?.[section]?.[field];
    if (sameValue(value, kind === 'items' ? (base ?? []) : base ?? (kind === 'optional' ? '' : undefined))) continue;
    overrides[section] ??= {};
    overrides[section][field] = value;
  }
  return overrides;
}

/** The form's starting values: the live page content, flattened for editing. */
export function formFromContent(content) {
  const form = {};
  for (const { section, field, kind } of EDITABLE_FIELDS) {
    const value = content?.[section]?.[field];
    form[section] ??= {};
    if (kind === 'list') form[section][field] = [...(value ?? [])];
    else if (kind === 'items') form[section][field] = (value ?? []).map((item) => ({ quote: item.quote ?? '', name: item.name ?? '', role: item.role ?? '' }));
    else form[section][field] = value ?? '';
  }
  return form;
}
