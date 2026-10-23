import { useCallback, useEffect, useMemo, useState } from 'react';
import { setupApi, posApi, approvalsApi } from '../../shared/api/index.js';
import { buildProbes, computeProgress, loadManualTicks, saveManualTicks, storageKey } from './gettingStarted.js';

/**
 * Reads the existing read-only endpoints once per property/user and merges
 * them with the person's own ticks. Every read is independent: a role that may
 * not call one (or an outage) leaves only the steps that depend on it as
 * "can't tell — tick it yourself".
 */
export function useGettingStartedProgress({ userId, propertyId, enabled = true }) {
  const key = storageKey(userId, propertyId);
  const [manual, setManual] = useState(() => loadManualTicks(key));
  const [probes, setProbes] = useState(null);
  const [manualKey, setManualKey] = useState(key);

  // Another user or property on the same device: load that list during render.
  if (manualKey !== key) {
    setManualKey(key);
    setManual(loadManualTicks(key));
  }

  useEffect(() => {
    if (!enabled || !propertyId) return undefined;
    let cancelled = false;
    Promise.allSettled([
      setupApi.getSetupProgress(),
      setupApi.getPaymentSubaccount(),
      posApi.listOutlets(),
      posApi.listTerminals(),
      posApi.listMenuItems(),
      approvalsApi.listApprovers('pos.refund_payment'),
    ]).then(([progress, subaccount, outlets, terminals, menuItems, approvers]) => {
      if (!cancelled) setProbes(buildProbes({ progress, subaccount, outlets, terminals, menuItems, approvers }));
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, propertyId, userId]);

  const toggle = useCallback(
    (stepId) => {
      setManual((current) => {
        const next = { ...current };
        if (next[stepId]) delete next[stepId];
        else next[stepId] = true;
        saveManualTicks(key, next);
        return next;
      });
    },
    [key],
  );

  const progress = useMemo(() => computeProgress(probes ?? {}, manual), [probes, manual]);
  return { ...progress, loading: enabled && Boolean(propertyId) && probes === null, toggle };
}
