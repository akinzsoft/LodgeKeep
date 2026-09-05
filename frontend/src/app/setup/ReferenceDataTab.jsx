import { useEffect, useState } from 'react';
import { Card, DataTable, Button } from '../../shared/components/index.js';
import { setupApi, ApiError } from '../../shared/api/index.js';
import styles from './SetupScreen.module.css';
import formStyles from './SetupForm.module.css';

const FEE_TYPES = [
  { value: 'none', label: 'No fee' },
  { value: 'flat_fee', label: 'Flat fee' },
  { value: 'first_night', label: "First night's rate" },
  { value: 'percentage', label: 'Percentage of stay' },
];

/**
 * ReferenceDataTab — PLAN.md Phase 1 gap closure, PRODUCT_REQUIREMENTS.md
 * §3.19: "Market segments / booking sources — simple reference-data lists,
 * editable" and "Cancellation & no-show policies: rules and any associated
 * fees, referenced at reservation time."
 *
 * One tab for all three, the same reasoning `CashieringScreen`'s own header
 * gives for combining four Cashiering screens into one — these are three
 * short, closely-related reference-data lists a setup admin fills in once
 * during onboarding, not three screens someone navigates between
 * separately. Archive is deliberately not wired to a button here, matching
 * `RoomTypesTab`'s own precedent (the backend endpoint exists; no setup tab
 * in this codebase surfaces archive in its UI yet).
 *
 * Fee computation/posting at cancellation time is NOT built — see the
 * `cancellation_policies` migration's own header. This screen only lets an
 * admin define the rule; nothing yet charges it.
 */
export function ReferenceDataTab({ disabled }) {
  const [marketSegments, setMarketSegments] = useState(null);
  const [bookingSources, setBookingSources] = useState(null);
  const [cancellationPolicies, setCancellationPolicies] = useState(null);

  const [segmentForm, setSegmentForm] = useState({ code: '', name: '' });
  const [segmentSubmitting, setSegmentSubmitting] = useState(false);
  const [segmentError, setSegmentError] = useState(null);

  const [sourceForm, setSourceForm] = useState({ code: '', name: '' });
  const [sourceSubmitting, setSourceSubmitting] = useState(false);
  const [sourceError, setSourceError] = useState(null);

  const [policyForm, setPolicyForm] = useState({ code: '', name: '', cutoff_hours: '', fee_type: 'none', fee_value: '' });
  const [policySubmitting, setPolicySubmitting] = useState(false);
  const [policyError, setPolicyError] = useState(null);

  async function reload() {
    try {
      const [segments, sources, policies] = await Promise.all([
        setupApi.listMarketSegments(),
        setupApi.listBookingSources(),
        setupApi.listCancellationPolicies(),
      ]);
      setMarketSegments(segments);
      setBookingSources(sources);
      setCancellationPolicies(policies);
    } catch (caught) {
      // The same "never leave the table stuck loading" fix this codebase's
      // other setup tabs already carry — the error banners below are what
      // actually explain what happened.
      setMarketSegments([]);
      setBookingSources([]);
      setCancellationPolicies([]);
      const message = caught instanceof ApiError ? caught.message : 'Could not load reference data.';
      setSegmentError(message);
      setSourceError(message);
      setPolicyError(message);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    if (!disabled) reload();
  }, [disabled]);

  if (disabled) {
    return (
      <p className={formStyles.disabledNotice}>
        Create a property first — market segments, booking sources, and cancellation policies belong to one property.
      </p>
    );
  }

  async function handleCreateSegment(event) {
    event.preventDefault();
    setSegmentSubmitting(true);
    setSegmentError(null);
    try {
      await setupApi.createMarketSegment({ code: segmentForm.code, name: segmentForm.name });
      setSegmentForm({ code: '', name: '' });
      await reload();
    } catch (caught) {
      setSegmentError(caught instanceof ApiError ? caught.message : 'Could not create the market segment.');
    } finally {
      setSegmentSubmitting(false);
    }
  }

  async function handleCreateSource(event) {
    event.preventDefault();
    setSourceSubmitting(true);
    setSourceError(null);
    try {
      await setupApi.createBookingSource({ code: sourceForm.code, name: sourceForm.name });
      setSourceForm({ code: '', name: '' });
      await reload();
    } catch (caught) {
      setSourceError(caught instanceof ApiError ? caught.message : 'Could not create the booking source.');
    } finally {
      setSourceSubmitting(false);
    }
  }

  async function handleCreatePolicy(event) {
    event.preventDefault();
    setPolicySubmitting(true);
    setPolicyError(null);
    try {
      await setupApi.createCancellationPolicy({
        code: policyForm.code,
        name: policyForm.name,
        cutoff_hours: policyForm.cutoff_hours ? Number(policyForm.cutoff_hours) : undefined,
        fee_type: policyForm.fee_type,
        fee_value: policyForm.fee_value || undefined,
      });
      setPolicyForm({ code: '', name: '', cutoff_hours: '', fee_type: 'none', fee_value: '' });
      await reload();
    } catch (caught) {
      setPolicyError(caught instanceof ApiError ? caught.message : 'Could not create the cancellation policy.');
    } finally {
      setPolicySubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <DataTable
        title="Market segments"
        state={marketSegments === null ? 'loading' : marketSegments.length === 0 ? 'empty' : 'success'}
        emptyMessage="No market segments yet — add one below."
        columns={[
          { key: 'code', label: 'Code' },
          { key: 'name', label: 'Name' },
        ]}
        rows={marketSegments ?? []}
        rowKey={(row) => row.id}
      />
      <Card title="Add a market segment">
        {segmentError && (
          <p role="alert" className={formStyles.errorBanner}>
            {segmentError}
          </p>
        )}
        <form className={formStyles.form} onSubmit={handleCreateSegment}>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Code</span>
              <input
                className={formStyles.input}
                value={segmentForm.code}
                onChange={(event) => setSegmentForm({ ...segmentForm, code: event.target.value })}
                placeholder="CORP"
                required
              />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Name</span>
              <input
                className={formStyles.input}
                value={segmentForm.name}
                onChange={(event) => setSegmentForm({ ...segmentForm, name: event.target.value })}
                placeholder="Corporate"
                required
              />
            </label>
          </div>
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={segmentSubmitting}>
              Add market segment
            </Button>
          </div>
        </form>
      </Card>

      <DataTable
        title="Booking sources"
        state={bookingSources === null ? 'loading' : bookingSources.length === 0 ? 'empty' : 'success'}
        emptyMessage="No booking sources yet — add one below."
        columns={[
          { key: 'code', label: 'Code' },
          { key: 'name', label: 'Name' },
        ]}
        rows={bookingSources ?? []}
        rowKey={(row) => row.id}
      />
      <Card title="Add a booking source">
        {sourceError && (
          <p role="alert" className={formStyles.errorBanner}>
            {sourceError}
          </p>
        )}
        <form className={formStyles.form} onSubmit={handleCreateSource}>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Code</span>
              <input
                className={formStyles.input}
                value={sourceForm.code}
                onChange={(event) => setSourceForm({ ...sourceForm, code: event.target.value })}
                placeholder="DIRECT"
                required
              />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Name</span>
              <input
                className={formStyles.input}
                value={sourceForm.name}
                onChange={(event) => setSourceForm({ ...sourceForm, name: event.target.value })}
                placeholder="Direct"
                required
              />
            </label>
          </div>
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={sourceSubmitting}>
              Add booking source
            </Button>
          </div>
        </form>
      </Card>

      <DataTable
        title="Cancellation policies"
        state={cancellationPolicies === null ? 'loading' : cancellationPolicies.length === 0 ? 'empty' : 'success'}
        emptyMessage="No cancellation policies yet — add one below."
        columns={[
          { key: 'code', label: 'Code' },
          { key: 'name', label: 'Name' },
          { key: 'cutoff_hours', label: 'Cutoff (hrs)', align: 'right', render: (row) => row.cutoff_hours ?? '—' },
          {
            key: 'fee_type',
            label: 'Fee',
            render: (row) => FEE_TYPES.find((f) => f.value === row.fee_type)?.label ?? row.fee_type,
          },
        ]}
        rows={cancellationPolicies ?? []}
        rowKey={(row) => row.id}
      />
      <Card title="Add a cancellation policy">
        {policyError && (
          <p role="alert" className={formStyles.errorBanner}>
            {policyError}
          </p>
        )}
        <form className={formStyles.form} onSubmit={handleCreatePolicy}>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Code</span>
              <input
                className={formStyles.input}
                value={policyForm.code}
                onChange={(event) => setPolicyForm({ ...policyForm, code: event.target.value })}
                placeholder="FLEX"
                required
              />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Name</span>
              <input
                className={formStyles.input}
                value={policyForm.name}
                onChange={(event) => setPolicyForm({ ...policyForm, name: event.target.value })}
                placeholder="Flexible"
                required
              />
            </label>
          </div>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Cutoff (hours before arrival)</span>
              <input
                className={formStyles.input}
                type="number"
                min="0"
                value={policyForm.cutoff_hours}
                onChange={(event) => setPolicyForm({ ...policyForm, cutoff_hours: event.target.value })}
                placeholder="48"
              />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Fee type</span>
              <select
                className={formStyles.select}
                value={policyForm.fee_type}
                onChange={(event) => setPolicyForm({ ...policyForm, fee_type: event.target.value })}
              >
                {FEE_TYPES.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {(policyForm.fee_type === 'flat_fee' || policyForm.fee_type === 'percentage') && (
            <label className={formStyles.field}>
              <span className={formStyles.label}>
                {policyForm.fee_type === 'flat_fee' ? 'Fee amount' : 'Fee percentage (0-100)'}
              </span>
              <input
                className={formStyles.input}
                inputMode="decimal"
                value={policyForm.fee_value}
                onChange={(event) => setPolicyForm({ ...policyForm, fee_value: event.target.value })}
                placeholder={policyForm.fee_type === 'flat_fee' ? '50.00' : '25'}
              />
            </label>
          )}
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={policySubmitting}>
              Add cancellation policy
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
