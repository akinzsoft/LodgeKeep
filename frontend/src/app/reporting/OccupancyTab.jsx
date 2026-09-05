import { useState } from 'react';
import { DataTable, Button } from '../../shared/components/index.js';
import { reportingApi, ApiError } from '../../shared/api/index.js';
import { triggerDownload } from '../../shared/download.js';
import styles from './ReportingScreen.module.css';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * PRODUCT_REQUIREMENTS.md §3.11: "Reporting — report catalogue ..., date-range
 * picker, on-screen table + export." Occupancy is computed live from
 * `room_type_inventory` and the live physical-room count (this session's
 * confirmed scope decision — see `src/modules/reporting/index.js`'s own
 * backend header for why there is no `daily_reports` snapshot this pass).
 */
export function OccupancyTab() {
  const [dateFrom, setDateFrom] = useState(todayIso());
  const [dateTo, setDateTo] = useState(todayIso());
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);

  async function runReport(event) {
    event?.preventDefault();
    setError(null);
    try {
      setRows(await reportingApi.getOccupancyReport({ dateFrom, dateTo }));
    } catch (caught) {
      setRows([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load the occupancy report.');
    }
  }

  async function handleExport() {
    setExporting(true);
    setError(null);
    try {
      const blob = await reportingApi.getOccupancyReportCsv({ dateFrom, dateTo });
      triggerDownload(blob, `occupancy-${dateFrom}-to-${dateTo}.csv`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not export the occupancy report.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      {error && (
        <p role="alert" className={styles.errorBanner}>
          {error}
        </p>
      )}
      {/* The date-range form lives OUTSIDE DataTable's own toolbar slot,
          deliberately — Card (which DataTable wraps) only renders `children`
          (toolbar included) while `state === 'success'`, so a control that
          must stay reachable before the first run ever produces a row
          cannot live inside a state-gated DataTable. */}
      <form className={styles.toolbar} onSubmit={runReport}>
        <label className={styles.field}>
          <span className={styles.label}>From</span>
          <input type="date" className={styles.input} value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>To</span>
          <input type="date" className={styles.input} value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
        </label>
        <Button type="submit">Run report</Button>
        <Button type="button" variant="secondary" loading={exporting} disabled={rows === null || rows.length === 0} onClick={handleExport}>
          Export CSV
        </Button>
      </form>
      <DataTable
        title="Occupancy"
        state={rows === null || rows.length === 0 ? 'empty' : 'success'}
        emptyMessage="Choose a date range and run the report."
        columns={[
          { key: 'date', label: 'Date' },
          { key: 'physicalCount', label: 'Physical rooms', align: 'right' },
          { key: 'roomsSold', label: 'Rooms sold', align: 'right' },
          { key: 'occupancyPct', label: 'Occupancy %', align: 'right', render: (row) => `${row.occupancyPct}%` },
        ]}
        rows={rows ?? []}
        rowKey={(row) => row.date}
      />
    </div>
  );
}
