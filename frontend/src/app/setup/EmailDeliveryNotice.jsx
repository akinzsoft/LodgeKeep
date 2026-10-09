import { useEffect, useState } from 'react';
import { setupApi } from '../../shared/api/index.js';
import formStyles from './SetupForm.module.css';

const MESSAGES = {
  settings: 'Invitations, verification codes, password resets and booking confirmations from this property are only written to the server log. Set up an SMTP mailbox below, save, and send a test email.',
  security: 'Admins who sign in cannot receive a verification code by email, so while the code is required they will be unable to sign in. Set up a mailbox in Setup → Email settings, or turn the requirement off only if you accept the risk.',
  invite: 'An invitation from this property will not reach the person you invite. Set up a mailbox in Setup → Email settings first, then send the invitation.',
};

/**
 * A warning shown wherever an email is about to matter, when this
 * property's emails are not actually being sent — user-reported on
 * production: an invitation from a property with no mailbox of its own
 * went only to the server log while the screen said it was sent.
 *
 * Renders nothing while loading, when emails do get sent, and when the
 * status cannot be read (a role without `setup.view`) — it only ever adds a
 * warning, never blocks anything.
 *
 * @param {'settings'|'invite'|'security'} where   Which screen, for the wording.
 * @param {*} [refreshKey]   Change it to re-check (after saving settings).
 */
export function EmailDeliveryNotice({ where, refreshKey }) {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setupApi
      .getEmailDeliveryStatus()
      .then((result) => {
        if (!cancelled) setStatus(result);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (!status || status.sendsEmail) return null;
  return (
    <div className={formStyles.warningBanner} role="alert">
      <strong>Emails from this property are not being sent.</strong>
      No mailbox is set up for it, and the server has no default one. {MESSAGES[where]}
    </div>
  );
}
