/**
 * BrandLogo — LodgeKeep's OWN logo, for LodgeKeep's own surfaces only (the
 * sidebar brand row, staff login, signup, the landing page, the app footer).
 * It is never a stand-in for a hotel's logo: a property's uploaded logo is
 * shown by the guest portal, QR ordering, printed documents, receipts and
 * emails, and those surfaces print no LodgeKeep logo when a property has none.
 *
 * The caller names the SURFACE, not a file: a light surface gets the -colour
 * artwork and a dark one (navy sidebar, login brand panel, dark footer) the
 * -white artwork, so a colour logo can never land on navy.
 *
 * Files live in public/brand and are served same-origin (no CSP change).
 * Width and height are always set from the artwork's real aspect ratio so the
 * image reserves its space before it loads.
 */
const ARTWORK = {
  // file stem + intrinsic size of the supplied PNGs
  horizontal: { stem: 'lodgekeep-logo-horizontal', width: 1405, height: 339 },
  mark: { stem: 'lodgekeep-mark', width: 446, height: 339 },
  stacked: { stem: 'lodgekeep-logo', width: 742, height: 580 },
};

const SURFACE_SUFFIX = { light: 'colour', dark: 'white' };

/** @returns {string} The public URL of the artwork for a variant on a surface. */
export function brandLogoSrc(variant = 'horizontal', surface = 'light') {
  const art = ARTWORK[variant] ?? ARTWORK.horizontal;
  return `/brand/${art.stem}-${SURFACE_SUFFIX[surface] ?? SURFACE_SUFFIX.light}.png`;
}

/**
 * @param {'horizontal'|'mark'|'stacked'} [variant]  horizontal = icon + wordmark lockup; mark = icon only.
 * @param {'light'|'dark'} [surface]                 The background the logo sits on.
 * @param {number} [height]                          Rendered height in px; width follows the artwork's aspect ratio.
 */
export function BrandLogo({ variant = 'horizontal', surface = 'light', height = 32, className, style }) {
  const art = ARTWORK[variant] ?? ARTWORK.horizontal;
  const width = Math.round((height * art.width) / art.height);
  return (
    <img
      src={brandLogoSrc(variant, surface)}
      alt="Lodgekeep"
      width={width}
      height={height}
      className={className}
      style={{ aspectRatio: `${art.width} / ${art.height}`, objectFit: 'contain', ...style }}
      data-brand-variant={variant}
      data-brand-surface={surface}
    />
  );
}
