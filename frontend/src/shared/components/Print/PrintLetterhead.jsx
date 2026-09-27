import styles from './Print.module.css';

/**
 * The top of a printed document — the property's logo (Setup → Branding),
 * its name, the document's title and a few detail lines — plus, on paper
 * only, the same logo as a faint centred watermark (user-requested). On a
 * printed page there is no interface behind it, so a watermark reads as
 * branding rather than clutter, and an opaque logo's white box vanishes on
 * white paper. With no logo configured, only the text prints — never a
 * broken image or a placeholder.
 *
 * Render it inside something that only shows when printing (a `.printOnly`
 * block, or `PrintDocument`); it has no screen styling of its own.
 *
 * @param {string|null} logoUrl
 * @param {string} organisation   Usually the property's name.
 * @param {string} title   What the document is — "Guest folio", "Profit & Loss Statement".
 * @param {string[]} [details]   Short lines under the title (dates, references, "Printed …").
 * @param {boolean} [watermark=true]
 */
export function PrintLetterhead({ logoUrl, organisation, title, details = [], watermark = true }) {
  return (
    <>
      <header className={styles.letterhead}>
        {logoUrl && <img className={styles.logo} src={logoUrl} alt="" />}
        <div className={styles.text}>
          {organisation && <p className={styles.organisation}>{organisation}</p>}
          <h1 className={styles.title}>{title}</h1>
          {details.filter(Boolean).map((line) => (
            <p key={line} className={styles.detail}>
              {line}
            </p>
          ))}
        </div>
      </header>
      {watermark && logoUrl && <img className={styles.watermark} src={logoUrl} alt="" aria-hidden="true" data-testid="print-watermark" />}
    </>
  );
}
