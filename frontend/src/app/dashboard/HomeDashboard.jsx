import { useEffect, useState } from 'react';
import { Card, KPICard, StatusPill } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { reservationsApi, setupApi, housekeepingApi, reportingApi, nightAuditApi, ApiError } from '../../shared/api/index.js';
import { STATUS_TONE as NIGHT_AUDIT_STATUS_TONE } from '../night-audit/NightAuditScreen.jsx';
import styles from './HomeDashboard.module.css';

/**
 * HomeDashboard — PRODUCT_REQUIREMENTS.md's "Manager dashboard (Home)"
 * layout: greeting, summary widgets, a 4-card KPI row, a 2-widget chart row,
 * and an operational alert strip.
 *
 * PLAN.md Phase 3 is what finally gives three of the four KPI cards and
 * four of the five alert rows real data — Reservations, Rooms, Housekeeping,
 * and Reporting all exist now. Each is fetched independently (not
 * `Promise.all`) so one role's missing grant (e.g. `reports.view_financial`
 * for a front-desk account) degrades only its own card to an honest error
 * state rather than blanking the whole dashboard.
 *
 * "Night audit for today's business date" (PLAN.md Phase 2.5) reads the real
 * `GET /night-audit/runs` list and reports whichever run, if any, matches
 * the `businessDate` prop — a manager/admin account sees the real status
 * (or "Not yet run", the expected state for the current, still-open
 * business date); a role without `night_audit.view` gets the same honest
 * "Not available for your role" treatment the Total Revenue KPI already
 * uses for its own permission gap, not a scary error banner.
 *
 * One piece still renders its original honest-empty state, flagged rather
 * than approximated: "New Customers" has no way to filter guests by
 * creation date yet (no endpoint for it — `src/modules/reservations`'s
 * guest stub is create/list only). The two chart-row widgets also stay
 * empty: no chart library is installed in this codebase yet, and building
 * trend/donut charts from scratch was out of scope for this pass.
 *
 * @param {string} greetingName   Shown as "Hi, {name}!" — falls back to a generic greeting if empty.
 * @param {string} businessDate   'YYYY-MM-DD' — see `main.jsx`'s own `BUSINESS_DATE` header for why this is a prop, not derived here.
 * @param {string} [activePropertyId]   Fetched into a currency code for the Total Revenue KPI (ARCHITECTURE.md §1: "every money column carries its currency") — the same "no display name yet, only an id" gap `SetupScreen`/`BookingScreen` already work around by fetching properties themselves.
 */
export function HomeDashboard({ greetingName, businessDate, activePropertyId }) {
  const [totalBooking, setTotalBooking] = useState({ state: 'loading', value: null });
  const [roomsAvailable, setRoomsAvailable] = useState({ state: 'loading', value: null });
  const [totalRevenue, setTotalRevenue] = useState({ state: 'loading', value: null });
  const [currencyCode, setCurrencyCode] = useState('USD');
  const [arrivals, setArrivals] = useState(null);
  const [departures, setDepartures] = useState(null);
  const [discrepancies, setDiscrepancies] = useState(null);
  const [oversold, setOversold] = useState(null);
  // null until the first fetch settles (renders the same "Not available yet"
  // pill as arrivals/departures/discrepancies/oversold do while loading);
  // { status, message } after — `status` is a real night_audit_runs.status
  // value or null (no run yet for today's business date), `message` is set
  // only on a load failure.
  const [nightAudit, setNightAudit] = useState(null);

  useEffect(() => {
    reservationsApi
      .listReservations()
      .then((rows) => setTotalBooking({ state: rows.length === 0 ? 'empty' : 'success', value: rows.length }))
      .catch((caught) =>
        setTotalBooking({ state: 'error', value: null, message: caught instanceof ApiError ? caught.message : 'Could not load.' })
      );

    setupApi
      .listRooms()
      .then((rows) => {
        const active = rows.filter((room) => room.status === 'active').length;
        setRoomsAvailable({ state: rows.length === 0 ? 'empty' : 'success', value: active });
      })
      .catch((caught) =>
        setRoomsAvailable({ state: 'error', value: null, message: caught instanceof ApiError ? caught.message : 'Could not load.' })
      );

    reportingApi
      .getRevenueReport({ dateFrom: businessDate, dateTo: businessDate })
      .then((rows) => {
        const today = rows[0];
        setTotalRevenue({ state: !today || Number(today.roomRevenue) === 0 ? 'empty' : 'success', value: today?.roomRevenue });
      })
      .catch((caught) => {
        // A front-desk/cashier/housekeeping account genuinely lacks
        // `reports.view_financial` (SECURITY.md §5's matrix) — a 403 here is
        // correct enforcement, not a bug, so it renders as this card's own
        // honest empty state rather than a scary error banner.
        const forbidden = caught instanceof ApiError && caught.code === 'FORBIDDEN_PERMISSION';
        setTotalRevenue({
          state: 'empty',
          value: null,
          message: forbidden ? 'Not available for your role.' : caught instanceof ApiError ? caught.message : 'Could not load.',
        });
      });

    reservationsApi.listArrivals().then(setArrivals).catch(() => setArrivals(null));
    reservationsApi.listDepartures().then(setDepartures).catch(() => setDepartures(null));
    housekeepingApi
      .listDiscrepancies({ resolved: false })
      .then(setDiscrepancies)
      .catch(() => setDiscrepancies(null));
    reportingApi
      .getOversoldRoomTypes(businessDate)
      .then(setOversold)
      .catch(() => setOversold(null));

    nightAuditApi
      .listRuns()
      .then((runs) => {
        const todayRun = runs.find((run) => run.business_date === businessDate);
        setNightAudit({ status: todayRun?.status ?? null, message: null });
      })
      .catch((caught) => {
        // Same treatment as the Total Revenue KPI's own `reports.view_financial`
        // gap: a role without `night_audit.view` (SECURITY.md §5) gets a
        // correct 403 here, rendered as an honest "not for your role" pill
        // rather than an alarming error state.
        const forbidden = caught instanceof ApiError && caught.code === 'FORBIDDEN_PERMISSION';
        setNightAudit({
          status: null,
          message: forbidden ? 'Not available for your role.' : caught instanceof ApiError ? caught.message : 'Could not load.',
        });
      });

    setupApi
      .listProperties()
      .then((rows) => {
        const active = rows.find((property) => String(property.id) === String(activePropertyId));
        if (active) setCurrencyCode(active.base_currency);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch-on-mount for a fixed businessDate prop; a real business-date-advance mechanism (Night Audit) doesn't exist yet to re-trigger this.
  }, []);

  return (
    <div className={styles.page}>
      <div className={styles.greetingRow}>
        <h1 className={styles.greeting}>{greetingName ? `Hi, ${greetingName}!` : 'Welcome back!'}</h1>

        <div className={styles.summaryWidgets}>
          <Card
            className={styles.summaryCard}
            state="empty"
            emptyMessage="Customer ratings appear once guest reviews are collected."
          />
          <Card
            className={styles.summaryCard}
            state="empty"
            emptyMessage="Total income appears once Cashiering is posting revenue."
          />
        </div>
      </div>

      <div className={styles.kpiGrid}>
        <KPICard
          domain="booking"
          icon="📅"
          label="Total Booking"
          state={totalBooking.state}
          value={totalBooking.value}
          emptyMessage="No reservations yet."
          errorMessage={totalBooking.message}
        />
        <KPICard
          domain="rooms"
          icon="🛏️"
          label="Rooms Available"
          state={roomsAvailable.state}
          value={roomsAvailable.value}
          emptyMessage="No rooms configured yet."
          errorMessage={roomsAvailable.message}
        />
        <KPICard
          domain="guest"
          icon="👤"
          label="New Customers"
          state="empty"
          emptyMessage="Available once guest profiles can be filtered by date."
        />
        <KPICard
          domain="money"
          icon="💰"
          label="Total Revenue (today)"
          state={totalRevenue.state}
          value={totalRevenue.value && <Money amount={totalRevenue.value} currencyCode={currencyCode} />}
          emptyMessage={totalRevenue.message ?? 'No revenue posted for today yet.'}
        />
      </div>

      <div className={styles.chartRow}>
        <Card
          className={styles.chartCardWide}
          title="New vs Returning Customers"
          state="empty"
          emptyMessage="This trend chart fills in once Reservations and Guest Profiles are tracking bookings."
        />
        <Card
          className={styles.chartCardNarrow}
          title="Bookings by Room Type"
          state="empty"
          emptyMessage="This breakdown appears once Rooms and Reservations are configured."
        />
      </div>

      <Card className={styles.alertCard} title="Today at a glance">
        <ul className={styles.alertList}>
          <AlertRow label="Arrivals today" count={arrivals?.length} />
          <AlertRow label="Departures today" count={departures?.length} />
          <AlertRow label="Housekeeping discrepancies" count={discrepancies?.length} dangerIfNonZero />
          <AlertRow label="Oversold room types tonight" count={oversold?.length} dangerIfNonZero />
          <AlertRow label="Night audit for today's business date" pill={nightAuditPill(nightAudit)} />
        </ul>
      </Card>
    </div>
  );
}

/**
 * `count === undefined` (load failed or not fetched) keeps the original
 * honest "Not available yet" pill; `count` present renders a real number,
 * red when it's a discrepancy/oversell figure and non-zero. A caller with a
 * status that isn't a plain count (Night audit) supplies a pre-built `pill`
 * instead, which takes priority over `count`.
 */
function AlertRow({ label, count, dangerIfNonZero = false, pill }) {
  const resolvedPill =
    pill ??
    (count === undefined ? (
      <StatusPill tone="neutral" label="Not available yet" />
    ) : (
      <StatusPill tone={dangerIfNonZero && count > 0 ? 'danger' : 'neutral'} label={String(count)} />
    ));
  return (
    <li className={styles.alertRow}>
      <span className={styles.alertLabel}>{label}</span>
      {resolvedPill}
    </li>
  );
}

/** Maps the real `GET /night-audit/runs` result (or its load failure) onto a status pill, reusing `NightAuditScreen`'s own status→tone vocabulary rather than a second copy of it. */
function nightAuditPill(nightAudit) {
  if (!nightAudit) return <StatusPill tone="neutral" label="Not available yet" />;
  if (nightAudit.message) return <StatusPill tone="neutral" label={nightAudit.message} />;
  if (!nightAudit.status) return <StatusPill tone="neutral" label="Not yet run" />;
  return <StatusPill tone={NIGHT_AUDIT_STATUS_TONE[nightAudit.status] ?? 'neutral'} label={nightAudit.status} />;
}
