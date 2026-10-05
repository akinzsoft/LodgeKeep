import { useEffect, useState } from 'react';
import { posApi } from '../../shared/api/index.js';
import { userCanOperateRegister } from './outletTypes.js';

/**
 * Whether the signed-in user can operate at least one Register outlet (a point of sale that is neither a
 * store room nor a supermarket), for the POS nav item: a mart-only cashier has none, so POS is hidden for
 * them and they use the Supermarket screen. `known` stays false until the answer arrives, and when either
 * lookup fails, so POS is never hidden on a guess (the server still decides every request).
 *
 * `sessionKey` (user + property) restarts the lookup on a property switch; a stale answer for the
 * previous key is dropped.
 */
export function useRegisterAccess({ enabled, sessionKey }) {
  const [answer, setAnswer] = useState({ key: null, canOperate: true });

  useEffect(() => {
    if (!enabled || !sessionKey) return undefined;
    let current = true;
    Promise.all([posApi.getMyOutlets(), posApi.listOutlets()])
      .then(([mine, outlets]) => {
        if (current) setAnswer({ key: sessionKey, canOperate: userCanOperateRegister(outlets, mine) });
      })
      .catch(() => {
        if (current) setAnswer({ key: sessionKey, canOperate: true });
      });
    return () => {
      current = false;
    };
  }, [enabled, sessionKey]);

  const known = enabled && answer.key === sessionKey;
  return { known, canOperateRegister: known ? answer.canOperate : true };
}

/**
 * The permissions the NAV may show: the user's grants minus `pos.operate` when they can operate no
 * Register outlet (so POS is hidden). Anyone with `pos.manage` keeps POS (Setup, Sales, QR codes).
 */
export function navPermissionsFor(permissions, access) {
  const nav = new Set(permissions);
  if (access.known && !access.canOperateRegister && !nav.has('pos.manage')) nav.delete('pos.operate');
  return nav;
}
