import { useEffect, useState } from 'react';
import { DataTable } from '../../shared/components/index.js';
import { doorAccessApi, ApiError } from '../../shared/api/index.js';
import { formatInZone } from './format.js';
import styles from './DoorAccess.module.css';

/**
 * First key-card use after check-in — one row per stay, low priority, no
 * acknowledge/resolve step. Later door openings during the same stay are
 * deliberately not listed anywhere: ordinary guest movement is not a fraud
 * signal, and a running log of it would be sensitive movement data
 * (PRODUCT_REQUIREMENTS.md §3.23's privacy note).
 */
export function StayConfirmationsTab({ config }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    doorAccessApi
      .listStayConfirmations()
      .then((data) => !cancelled && setRows(data))
      .catch((caught) => {
        if (cancelled) return;
        setRows([]);
        setError(caught instanceof ApiError ? caught.message : 'Could not load stay confirmations.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <p className={styles.notice}>
        Confirms each guest&rsquo;s key card worked, from the first door opening found after check-in. Only the first opening per
        stay is recorded — ordinary comings and goings are not logged.
      </p>
      <DataTable
        title="Stay confirmations"
        state={rows === null ? 'loading' : error ? 'error' : 'success'}
        errorMessage={error}
        emptyMessage="No stay confirmations yet. They appear after a lock log covering an in-house stay is imported."
        columns={[
          { key: 'room_number', label: 'Room' },
          { key: 'guest', label: 'Guest', render: (row) => `${row.guest_first_name ?? ''} ${row.guest_last_name ?? ''}`.trim() || '—' },
          { key: 'confirmation_number', label: 'Confirmation' },
          { key: 'checked_in_at', label: 'Checked in', render: (row) => formatInZone(row.checked_in_at, config.timezone) },
          { key: 'opened_at', label: 'First door opening', render: (row) => formatInZone(row.opened_at, config.timezone) },
        ]}
        rows={rows ?? []}
        rowKey={(row) => row.id}
      />
    </>
  );
}
