import { Link, useNavigate, useOutletContext } from 'react-router-dom';
import { Button } from '../../shared/components/index.js';
import { useBranding } from '../branding/BrandingContext.jsx';
import { useGuestAuth } from '../auth/GuestAuthContext.jsx';
import styles from '../PortalScreen.module.css';
import formStyles from '../PortalForm.module.css';

/** PropertyLandingScreen — the portal's own front door: branding, then straight into a search. */
export function PropertyLandingScreen() {
  const { propertySlug } = useOutletContext();
  const { branding } = useBranding();
  const { isAuthenticated, guest, logout } = useGuestAuth();
  const navigate = useNavigate();

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        {branding?.logoUrl && <img className={styles.logo} src={branding.logoUrl} alt="" />}
        <h1 className={styles.title}>{branding === null ? 'Loading…' : branding.name || 'Book your stay'}</h1>
      </div>

      <nav className={styles.nav} aria-label="Portal navigation">
        {isAuthenticated ? (
          <>
            <span>Signed in as {guest?.email}</span>
            <Link className={formStyles.link} to={`/portal/${propertySlug}/account/bookings`}>
              My bookings
            </Link>
            <Button variant="ghost" size="compact" onClick={logout}>
              Sign out
            </Button>
          </>
        ) : (
          <>
            <Link className={formStyles.link} to={`/portal/${propertySlug}/login`}>
              Sign in
            </Link>
            <Link className={formStyles.link} to={`/portal/${propertySlug}/register`}>
              Create an account
            </Link>
          </>
        )}
      </nav>

      <Button onClick={() => navigate(`/portal/${propertySlug}/search`)}>Search availability</Button>
    </div>
  );
}
