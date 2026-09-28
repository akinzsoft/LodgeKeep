import { useCallback, useEffect, useRef, useState } from 'react';
import { stockApi } from '../api/index.js';

const MARKER_PREFIX = 'lodgekeep.requestReminders.';

function markerSet(key) {
  try {
    return window.sessionStorage.getItem(MARKER_PREFIX + key) === '1';
  } catch {
    return false;
  }
}

function setMarker(key) {
  try {
    window.sessionStorage.setItem(MARKER_PREFIX + key, '1');
  } catch {
    // Storage blocked: the reminder simply shows again on the next reload.
  }
}

/**
 * Forgets which sign-ins have already been reminded — called when the
 * person is signed out (sign-out, or a session that expired), so the next
 * sign-in reminds them again of whatever is still pending.
 */
export function forgetRequestReminders() {
  try {
    const keys = [];
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(MARKER_PREFIX)) keys.push(key);
    }
    keys.forEach((key) => window.sessionStorage.removeItem(key));
  } catch {
    // Nothing stored, nothing to forget.
  }
}

/** A pending request as a pop-up card — shaped like a "Stock requested" notification, so the same card, wording and "Open request" apply. */
function toReminderCard(request) {
  return {
    id: `reminder:${request.id}`,
    reminder: true,
    popup: true,
    type: 'stock.transfer_requested',
    created_at: request.requestedAt,
    payload: {
      requestId: Number(request.id),
      fromOutletName: request.fromOutlet?.name ?? null,
      toOutletName: request.toOutlet?.name ?? null,
      lineCount: request.lines?.length ?? 0,
      topUpOfRequestId: request.topUpOfRequestId ? Number(request.topUpOfRequestId) : null,
      reminder: true,
    },
  };
}

/**
 * The sign-in reminder of pending stock requests (user-requested: "when the
 * user logs in it shows once; when they log out and log in again it should
 * show, until resolved"). Once per sign-in — per `sessionKey` (user and
 * property) — it asks the server which pending requests are waiting on this
 * person (`GET /pos/stock/transfer-requests/awaiting-me`: the same people the
 * "Stock requested" alert reaches) and returns them as pop-up cards.
 *
 * "Once per sign-in", not per page load: a marker in sessionStorage survives
 * a reload of the same tab, and `forgetRequestReminders()` clears it when
 * the person is signed out. A failed fetch is not marked, so the next reload
 * tries again. Nothing repeats while signed in; a resolved request is simply
 * not returned at the next sign-in.
 *
 * @param {{enabled: boolean, sessionKey: string|null, onShow?: (cards: object[]) => void}} options
 *   `enabled` only for someone who can issue stock; `onShow` (the beep) is
 *   called once when cards appear.
 */
export function usePendingRequestReminders({ enabled, sessionKey, onShow }) {
  // Tagged with the session they belong to, so switching user or property never shows the previous one's cards.
  const [state, setState] = useState({ sessionKey: null, cards: [] });
  const onShowRef = useRef(onShow);
  useEffect(() => {
    onShowRef.current = onShow;
  }, [onShow]);

  useEffect(() => {
    if (!enabled || !sessionKey || markerSet(sessionKey)) return undefined;
    let cancelled = false;
    stockApi
      .listRequestsAwaitingMe()
      .then((rows) => {
        if (cancelled) return;
        setMarker(sessionKey);
        const cards = (rows ?? []).map(toReminderCard);
        setState({ sessionKey, cards });
        if (cards.length) onShowRef.current?.(cards);
      })
      .catch(() => {
        // Not marked: the next reload of this sign-in tries again.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, sessionKey]);

  const dismiss = useCallback((id) => {
    setState((current) => ({ ...current, cards: current.cards.filter((card) => card.id !== id) }));
  }, []);

  return { reminders: enabled && state.sessionKey === sessionKey ? state.cards : [], dismiss };
}
