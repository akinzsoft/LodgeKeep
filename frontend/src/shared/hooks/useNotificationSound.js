import { useCallback, useState } from 'react';

/**
 * Whether pop-up notifications beep on THIS device (user-requested: a
 * per-device on/off, on by default). Kept in browser storage because it is
 * a preference about this terminal's speaker, not about the person — a bar
 * tablet may be muted while the store's desktop is not. Storage can be
 * unavailable (private window, blocked site data): then it simply defaults
 * to on and forgets a change after a reload, never an error.
 */
export const NOTIFICATION_SOUND_KEY = 'lodgekeep.notificationSound';

function readStored() {
  try {
    return window.localStorage.getItem(NOTIFICATION_SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function useNotificationSound() {
  const [enabled, setEnabled] = useState(readStored);

  const toggle = useCallback(() => {
    setEnabled((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(NOTIFICATION_SOUND_KEY, next ? 'on' : 'off');
      } catch {
        // Remembered for this page load only.
      }
      return next;
    });
  }, []);

  return { enabled, toggle };
}
