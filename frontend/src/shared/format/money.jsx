/**
 * Money display — ARCHITECTURE.md §1/§12 ("Money is exact, always ... every
 * money column carries its currency"), TESTING.md FE-3 ("Money display:
 * tabular numerals; currency always shown"), DESIGN_SYSTEM.md §1 ("Tabular
 * figures on every money column and folio total").
 *
 * The API sends money as a DECIMAL string ("1250.00"), never a float, to
 * avoid the drift repeated float arithmetic causes (ARCHITECTURE.md §1). This
 * file never does arithmetic on that value — it only formats one value for
 * display, once, which is a safe use of a JS number: the precision risk
 * ARCHITECTURE.md warns about is cumulative float math, not a single
 * display-time parse of an already-computed total.
 *
 * The currency symbol is never a literal in this codebase (TESTING.md FE-2,
 * enforced by eslint.config.js's currency-symbol rule) — `Intl.NumberFormat`
 * derives the correct symbol, placement, and grouping from the currency code
 * itself, which is also correct for a currency this codebase's authors have
 * never manually accounted for (a hand-written symbol table would need one
 * more entry every time a tenant's country needs one).
 *
 * ── WHY A LOCALE IS DERIVED FROM THE CURRENCY, NOT LEFT TO THE BROWSER ────
 *
 * `Intl`'s currency-symbol resolution is itself locale-dependent, and not in
 * the way it first appears: `Intl.NumberFormat('en-US', { currency: 'NGN' })`
 * renders "NGN 5.00", not "₦5.00" — CLDR only maps a currency to its symbol
 * for locales associated with that currency, and a generic "en" locale isn't
 * one of them for NGN. Deferring to the viewing browser's own locale would
 * mean the same amount renders with a symbol or an ISO code depending on
 * which staff member is looking at the screen, which fails FE-3's "currency
 * always shown" in spirit even where it technically passes it. ISO 4217 codes
 * are built as [ISO 3166 region][currency letter] for the vast majority of
 * real currencies (NGN → NG, GBP → GB, USD → US), so a locale derived from
 * the currency code itself resolves the correct symbol reliably — verified
 * against NGN, GBP, USD, KES, GHS, ZAR, JPY, EUR, INR, and CNY. A caller that
 * genuinely wants the viewer's own grouping conventions can still pass an
 * explicit `locale`; the derived one is only the default.
 */

/**
 * @param {string|number} amount   A DECIMAL amount, as the string the API
 *   returns ("1250.00") or, at a pinch, a number already computed elsewhere.
 * @param {string} currencyCode    ISO 4217, e.g. "NGN", "GBP", "USD" — required, never defaulted (a defaulted currency is a silent misstatement of an amount, not a convenience).
 * @param {string} [locale]        BCP 47 locale override. Defaults to a locale derived from currencyCode (see the file header) so the symbol renders reliably regardless of the viewer's own browser locale.
 */
function defaultLocaleFor(currencyCode) {
  return `en-${currencyCode.slice(0, 2).toUpperCase()}`;
}

export function formatMoney(amount, currencyCode, locale) {
  if (!currencyCode) {
    throw new Error('formatMoney requires a currencyCode — an amount with no currency is not money (ARCHITECTURE.md §1).');
  }
  const numeric = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(numeric)) {
    throw new Error(`formatMoney received a non-numeric amount: ${JSON.stringify(amount)}`);
  }
  const resolvedLocale = locale || defaultLocaleFor(currencyCode);
  return new Intl.NumberFormat(resolvedLocale, { style: 'currency', currency: currencyCode }).format(numeric);
}

/**
 * The component form — DESIGN_SYSTEM.md §1's tabular-nums requirement applied
 * automatically, so a column of `<Money>` cells always aligns, and no caller
 * has to remember the class name.
 */
export function Money({ amount, currencyCode, locale, className = '' }) {
  return <span className={`tabular-nums ${className}`.trim()}>{formatMoney(amount, currencyCode, locale)}</span>;
}
