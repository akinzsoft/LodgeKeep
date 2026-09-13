import { useState } from 'react';
import { useBranding } from '../../shared/branding/BrandingProvider.jsx';
import styles from './QrBrandHeader.module.css';

/**
 * The hotel's own identity at the top of every guest QR page: its uploaded
 * logo (Setup → Branding) beside the tenant's name, with the property name
 * beneath. No logo — or one that fails to load — falls back to a monogram,
 * so the header never shows a broken image. While branding is still
 * loading, a same-height placeholder keeps the page from jumping.
 */
export function QrBrandHeader() {
  const { branding } = useBranding();
  const [logoFailed, setLogoFailed] = useState(false);

  if (!branding) {
    return <header className={styles.band} aria-busy="true"><div className={styles.inner} /></header>;
  }

  const tenantName = branding.tenantName || branding.name;
  const propertyName = branding.name && branding.name !== tenantName ? branding.name : null;
  if (!tenantName && !branding.logoUrl) return null;

  const showLogo = branding.logoUrl && !logoFailed;

  return (
    <header className={styles.band}>
      <div className={styles.inner}>
        {showLogo ? (
          <span className={styles.logoBox}>
            <img className={styles.logo} src={branding.logoUrl} alt={tenantName ? `${tenantName} logo` : 'Logo'} onError={() => setLogoFailed(true)} />
          </span>
        ) : (
          tenantName && (
            <span className={styles.monogram} aria-hidden="true">
              {tenantName.trim().slice(0, 1).toUpperCase()}
            </span>
          )
        )}
        {tenantName && (
          <div className={styles.names}>
            <p className={styles.tenantName}>{tenantName}</p>
            {propertyName && <p className={styles.propertyName}>{propertyName}</p>}
          </div>
        )}
      </div>
    </header>
  );
}
