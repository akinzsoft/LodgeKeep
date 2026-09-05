import { useState } from 'react';
import { Card, Button, StatusPill, DataTable } from '../../shared/components/index.js';
import { reportingApi, ApiError } from '../../shared/api/index.js';
import styles from './ReportingScreen.module.css';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/** PRODUCT_REQUIREMENTS.md §3.11's report catalogue names "housekeeping" as one of the report types; PLAN.md Phase 3's Housekeeping bullet names "discrepancy detection and report" — this is that report, plus tonight's oversold room types (feeds the manager dashboard alert strip). */
export function HousekeepingSummaryTab() {
  const [businessDate, setBusinessDate] = useState(todayIso());
  const [summary, setSummary] = useState(null);
  const [oversold, setOversold] = useState(null);
  const [error, setError] = useState(null);

  async function runReport(event) {
    event?.preventDefault();
    setError(null);
    try {
      const [summaryResult, oversoldResult] = await Promise.all([
        reportingApi.getHousekeepingSummary(businessDate),
        reportingApi.getOversoldRoomTypes(businessDate),
      ]);
      setSummary(summaryResult);
      setOversold(oversoldResult);
    } catch (caught) {
      setSummary(null);
      setOversold([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load the housekeeping summary.');
    }
  }

  return (
    <div>
      {error && (
        <p role="alert" className={styles.errorBanner}>
          {error}
        </p>
      )}
      <form className={styles.toolbar} onSubmit={runReport}>
        <label className={styles.field}>
          <span className={styles.label}>Business date</span>
          <input type="date" className={styles.input} value={businessDate} onChange={(event) => setBusinessDate(event.target.value)} />
        </label>
        <Button type="submit">Run report</Button>
      </form>

      <Card
        title="Discrepancies & assignments"
        state={summary === null ? 'empty' : 'success'}
        emptyMessage="Choose a business date and run the report."
      >
        {summary && (
          <>
            <p>
              <StatusPill tone={summary.openDiscrepancies > 0 ? 'danger' : 'success'} label={`${summary.openDiscrepancies} open discrepancies`} />{' '}
              <StatusPill tone="neutral" label={`${summary.resolvedDiscrepancies} resolved`} />
            </p>
            <p>
              Assignments — assigned: {summary.assignments.assigned}, in progress: {summary.assignments.in_progress}, completed:{' '}
              {summary.assignments.completed}
            </p>
          </>
        )}
      </Card>

      <DataTable
        title="Oversold room types tonight"
        state={oversold === null ? 'empty' : oversold.length === 0 ? 'empty' : 'success'}
        emptyMessage="No room type is oversold for this date."
        columns={[
          { key: 'roomTypeCode', label: 'Room type' },
          { key: 'roomsSold', label: 'Rooms sold', align: 'right' },
          { key: 'threshold', label: 'Threshold', align: 'right' },
          { key: 'physicalCount', label: 'Physical rooms', align: 'right' },
        ]}
        rows={oversold ?? []}
        rowKey={(row) => row.roomTypeId}
      />
    </div>
  );
}
