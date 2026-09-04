import { useEffect, useState } from 'react';
import { Card, DataTable, Button } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { setupApi, ApiError } from '../../shared/api/index.js';
import styles from './SetupScreen.module.css';
import formStyles from './SetupForm.module.css';

/**
 * RateCodesTab — PRODUCT_REQUIREMENTS.md's "Rate plan editor — rate
 * calendar per room type, date-range overrides, packages and promotions."
 *
 * The "rate calendar" here is a single-date resolve-and-override panel, not
 * a visual month grid — `DataTable` is a flat rows×columns table with no
 * 2D-matrix support, and building a full custom calendar-grid component was
 * out of scope for this pass. This still exercises the real resolution
 * rule end to end (TESTING.md SET-6: "date override wins over rate-code
 * base rate") for one date at a time; a real calendar UI is a reasonable
 * follow-up, not a functional gap in the backend it would sit on top of.
 * Packages/promotions have no backend table yet (DATABASE.md's `packages`
 * row is unbuilt) — not shown here.
 */
export function RateCodesTab({ activeProperty, disabled }) {
  const [rateCodes, setRateCodes] = useState(null);
  const [roomTypes, setRoomTypes] = useState([]);
  const [rateCodeForm, setRateCodeForm] = useState({ code: '', base_rate: '', valid_from: '', description: '' });
  const [rateCodeSubmitting, setRateCodeSubmitting] = useState(false);
  const [rateCodeError, setRateCodeError] = useState(null);

  const [calendarForm, setCalendarForm] = useState({ rate_code_id: '', room_type_id: '', stay_date: '', rate: '' });
  const [resolved, setResolved] = useState(null);
  const [calendarSubmitting, setCalendarSubmitting] = useState(false);
  const [calendarError, setCalendarError] = useState(null);

  async function reload() {
    try {
      const [rateCodesResult, roomTypesResult] = await Promise.all([setupApi.listRateCodes(), setupApi.listRoomTypes()]);
      setRateCodes(rateCodesResult);
      setRoomTypes(roomTypesResult);
    } catch (caught) {
      setRateCodeError(caught instanceof ApiError ? caught.message : 'Could not load rate codes.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    if (!disabled) reload();
  }, [disabled]);

  if (disabled) {
    return <p className={formStyles.disabledNotice}>Create a property first — rate codes belong to one property.</p>;
  }

  async function handleCreateRateCode(event) {
    event.preventDefault();
    setRateCodeSubmitting(true);
    setRateCodeError(null);
    try {
      await setupApi.createRateCode({
        code: rateCodeForm.code,
        base_rate: rateCodeForm.base_rate,
        currency: activeProperty.base_currency,
        valid_from: rateCodeForm.valid_from,
        description: rateCodeForm.description || undefined,
      });
      setRateCodeForm({ code: '', base_rate: '', valid_from: '', description: '' });
      await reload();
    } catch (caught) {
      setRateCodeError(caught instanceof ApiError ? caught.message : 'Could not create the rate code.');
    } finally {
      setRateCodeSubmitting(false);
    }
  }

  async function handleResolve(event) {
    event.preventDefault();
    setCalendarSubmitting(true);
    setCalendarError(null);
    setResolved(null);
    try {
      setResolved(
        await setupApi.resolveRate({
          rateCodeId: calendarForm.rate_code_id,
          roomTypeId: calendarForm.room_type_id,
          stayDate: calendarForm.stay_date,
        })
      );
    } catch (caught) {
      setCalendarError(caught instanceof ApiError ? caught.message : 'Could not resolve the rate.');
    } finally {
      setCalendarSubmitting(false);
    }
  }

  async function handleSetOverride() {
    setCalendarSubmitting(true);
    setCalendarError(null);
    try {
      await setupApi.setRateOverride({
        rate_code_id: calendarForm.rate_code_id,
        room_type_id: calendarForm.room_type_id,
        stay_date: calendarForm.stay_date,
        rate: calendarForm.rate,
      });
      const result = await setupApi.resolveRate({
        rateCodeId: calendarForm.rate_code_id,
        roomTypeId: calendarForm.room_type_id,
        stayDate: calendarForm.stay_date,
      });
      setResolved(result);
    } catch (caught) {
      setCalendarError(caught instanceof ApiError ? caught.message : 'Could not set the override.');
    } finally {
      setCalendarSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <DataTable
        title="Rate codes"
        state={rateCodes === null ? 'loading' : rateCodes.length === 0 ? 'empty' : 'success'}
        emptyMessage="No rate codes yet — add one below."
        columns={[
          { key: 'code', label: 'Code' },
          { key: 'description', label: 'Description', render: (row) => row.description ?? '—' },
          {
            key: 'base_rate',
            label: 'Base rate',
            align: 'right',
            render: (row) => <Money amount={row.base_rate} currencyCode={row.currency} />,
          },
          { key: 'valid_from', label: 'Valid from' },
        ]}
        rows={rateCodes ?? []}
        rowKey={(row) => row.id}
      />

      <Card title="Add a rate code">
        {rateCodeError && (
          <p role="alert" className={formStyles.errorBanner}>
            {rateCodeError}
          </p>
        )}
        <form className={formStyles.form} onSubmit={handleCreateRateCode}>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Code</span>
              <input
                className={formStyles.input}
                value={rateCodeForm.code}
                onChange={(event) => setRateCodeForm({ ...rateCodeForm, code: event.target.value })}
                placeholder="BAR"
                required
              />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Base rate ({activeProperty.base_currency})</span>
              <input
                className={formStyles.input}
                inputMode="decimal"
                value={rateCodeForm.base_rate}
                onChange={(event) => setRateCodeForm({ ...rateCodeForm, base_rate: event.target.value })}
                placeholder="150.00"
                required
              />
            </label>
          </div>
          <div className={formStyles.row}>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Valid from</span>
              <input
                className={formStyles.input}
                type="date"
                value={rateCodeForm.valid_from}
                onChange={(event) => setRateCodeForm({ ...rateCodeForm, valid_from: event.target.value })}
                required
              />
            </label>
            <label className={formStyles.field}>
              <span className={formStyles.label}>Description</span>
              <input
                className={formStyles.input}
                value={rateCodeForm.description}
                onChange={(event) => setRateCodeForm({ ...rateCodeForm, description: event.target.value })}
              />
            </label>
          </div>
          <div className={formStyles.actionsRow}>
            <Button type="submit" loading={rateCodeSubmitting}>
              Add rate code
            </Button>
          </div>
        </form>
      </Card>

      <Card title="Rate calendar — check or override one date">
        {calendarError && (
          <p role="alert" className={formStyles.errorBanner}>
            {calendarError}
          </p>
        )}
        {rateCodes?.length === 0 || roomTypes.length === 0 ? (
          <p className={formStyles.disabledNotice}>Add a rate code and a room type first.</p>
        ) : (
          <form className={formStyles.form} onSubmit={handleResolve}>
            <div className={formStyles.row}>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Rate code</span>
                <select
                  className={formStyles.select}
                  value={calendarForm.rate_code_id}
                  onChange={(event) => setCalendarForm({ ...calendarForm, rate_code_id: event.target.value })}
                  required
                >
                  <option value="" disabled>
                    Select a rate code
                  </option>
                  {rateCodes.map((rc) => (
                    <option key={rc.id} value={rc.id}>
                      {rc.code}
                    </option>
                  ))}
                </select>
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Room type</span>
                <select
                  className={formStyles.select}
                  value={calendarForm.room_type_id}
                  onChange={(event) => setCalendarForm({ ...calendarForm, room_type_id: event.target.value })}
                  required
                >
                  <option value="" disabled>
                    Select a room type
                  </option>
                  {roomTypes.map((rt) => (
                    <option key={rt.id} value={rt.id}>
                      {rt.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Date</span>
                <input
                  className={formStyles.input}
                  type="date"
                  value={calendarForm.stay_date}
                  onChange={(event) => setCalendarForm({ ...calendarForm, stay_date: event.target.value })}
                  required
                />
              </label>
            </div>

            <div className={formStyles.actionsRow}>
              <Button type="submit" variant="secondary" loading={calendarSubmitting}>
                Check rate
              </Button>
            </div>

            {resolved && (
              <p className={formStyles.disabledNotice} role="status">
                {resolved.overridden ? 'Overridden' : 'Base rate'}: <Money amount={resolved.rate} currencyCode={activeProperty.base_currency} />
              </p>
            )}

            <div className={formStyles.row}>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Set override rate ({activeProperty.base_currency})</span>
                <input
                  className={formStyles.input}
                  inputMode="decimal"
                  value={calendarForm.rate}
                  onChange={(event) => setCalendarForm({ ...calendarForm, rate: event.target.value })}
                  placeholder="225.00"
                />
              </label>
            </div>
            <div className={formStyles.actionsRow}>
              <Button
                type="button"
                onClick={handleSetOverride}
                loading={calendarSubmitting}
                disabled={!calendarForm.rate_code_id || !calendarForm.room_type_id || !calendarForm.stay_date || !calendarForm.rate}
              >
                Set override for this date
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
