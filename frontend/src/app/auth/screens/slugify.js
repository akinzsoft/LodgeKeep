/**
 * A plain, best-effort slug suggestion for `SignupScreen`'s "auto-fill the
 * subdomain from the company name" convenience — the standard SaaS-signup
 * touch (Slack, Notion, Linear all do this) this form was missing. Never the
 * source of truth for validity: the real `SLUG_PATTERN` lives in
 * `backend/src/modules/signup/service.js` and is what actually accepts or
 * rejects a slug — this only has to produce something that USUALLY already
 * satisfies it, since the field stays a normal, editable input either way.
 */
export function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
