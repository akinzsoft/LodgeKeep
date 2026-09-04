import { useAuth } from '../AuthContext.jsx';
import { Button } from '../../../shared/components/index.js';
import { Footer } from '../../shell/Footer.jsx';
import styles from './MfaChallengeScreen.module.css';

/**
 * MfaChallengeScreen — PRODUCT_REQUIREMENTS.md §3.16: "MFA challenge as a
 * second step for roles that require it." The backend issues the challenge
 * for real (`src/auth/service.js`'s `mfaRequired` branch, `AUTH-9`) but
 * verification itself (the mfa/verify endpoint) is a fixed `501
 * AUTH_MFA_NOT_IMPLEMENTED` stub — there is no real second step to render a
 * code-entry form for yet. This screen says so plainly instead of drawing a
 * code input that could never succeed, which DESIGN_SYSTEM.md §2's error
 * guidance ("say what happened ... without a raw exception string") applies
 * to just as much as an actual error response does.
 */
export function MfaChallengeScreen() {
  const { logout } = useAuth();

  return (
    <div className={styles.page}>
      <div className={styles.center}>
        <div className={styles.card}>
          <h1 className={styles.title}>Verification required</h1>
          <p className={styles.body}>
            This account requires multi-factor authentication. That verification step isn&rsquo;t available in this
            environment yet, so sign-in can&rsquo;t continue from here — contact your administrator.
          </p>
          <Button variant="secondary" onClick={logout}>
            Back to sign in
          </Button>
        </div>
      </div>

      <Footer />
    </div>
  );
}
