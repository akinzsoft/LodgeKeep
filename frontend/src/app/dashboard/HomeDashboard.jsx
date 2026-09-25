import { useEffect, useState } from 'react';
import { StatusPill, Button, Skeleton } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { reservationsApi, setupApi, housekeepingApi, reportingApi, nightAuditApi, ApiError } from '../../shared/api/index.js';
import { STATUS_TONE as NIGHT_AUDIT_STATUS_TONE } from '../night-audit/NightAuditScreen.jsx';
import { AreaChart, DonutChart, Sparkline, segmentClassName } from './DashboardCharts.jsx';
import { BookingsIcon, RoomsIcon, NewGuestsIcon, RevenueIcon } from './dashboardIcons.jsx';
import {
  bookingsByRoomType,
  countBookings,
  countDelta,
  countNewGuests,
  dateWindow,
  formatLongDate,
  greetingForHour,
  isZeroMoney,
  moneyPercentDelta,
  moneyToChartValue,
  monthRange,
  newVsReturningByDay,
  ratio,
  shiftDate,
  shortWeekday,
  totalMoney,
} from './dashboardMetrics.js';
import styles from './HomeDashboard.module.css';

const NOT_FOR_ROLE = 'Not available for your role.';

/**
 * HomeDashboard — PRODUCT_REQUIREMENTS.md's "Manager dashboard (Home)":
 * greeting, two summary widgets, a 4-card KPI row, a 2-chart row, and the
 * operational alert strip.
 *
 * Every figure is real — nothing here is a placeholder:
 *
 * - **Windows**: "this week" = the 7 business days ending on the property's
 *   own business date (ARCHITECTURE.md §6, never the wall clock), compared
 *   against the 7 business days before it. See `dashboardMetrics.js`.
 * - **Total Bookings**: room-holding reservations arriving this week (delta
 *   vs. last week); its bar is the week's average occupancy.
 * - **Rooms Available**: tonight's live sellable rooms (occupancy report's
 *   physical count minus rooms sold; delta vs. the previous business date);
 *   its bar is the share of rooms still free.
 * - **New Guests**: guests whose first-ever stay arrives this week (delta vs.
 *   last week); its bar is their share of this week's bookings.
 * - **Total Revenue**: today's posted room revenue (delta vs. the previous
 *   business date); its bar is today's share of this week's income.
 * - **Total Income — this week**: the week's room revenue, summed exactly,
 *   with a daily sparkline.
 * - **New vs. Returning Guests**: arrivals per business date, split by
 *   whether the guest has an earlier stay.
 * - **Bookings by Room Type**: room-holding reservations arriving in the
 *   business date's calendar month ("This month"), by type.
 * - **Guest Rating**: no guest reviews/ratings are collected anywhere in
 *   this codebase yet (confirmed: no table or endpoint exists), so this
 *   widget stays an honest empty state rather than showing invented stars.
 *
 * Each source is fetched independently, so one role's missing grant (e.g.
 * `reports.view_financial` for a front-desk account) degrades only the
 * cards that need it — to "Not available for your role.", never an error
 * banner — while everything else still renders.
 *
 * @param {string} [greetingName]   The signed-in user's first name.
 * @param {string|null} businessDate   'YYYY-MM-DD' — the active property's current business date.
 * @param {object} [activeProperty]   The active property record (name, timezone, base_currency).
 * @param {() => void} [onNavigateToSetup]
 * @param {Date} [now]   Injectable clock for the greeting — tests only.
 */
export function HomeDashboard({ greetingName, businessDate, activeProperty, onNavigateToSetup, now: nowProp }) {
  const [now] = useState(() => nowProp ?? new Date());
  const [reservations, setReservations] = useState(LOADING);
  const [roomTypes, setRoomTypes] = useState(null);
  const [occupancyResult, setOccupancy] = useState(LOADING);
  const [revenueResult, setRevenue] = useState(LOADING);
  // Both reports need a business date to anchor on — a property that has
  // never had one configured gets a named empty state, not a fetch.
  const occupancy = businessDate ? occupancyResult : NO_BUSINESS_DATE;
  // `Money` refuses to format an amount with no currency (ARCHITECTURE.md
  // §1) — revenue cards wait on the property record rather than guessing one.
  const revenue = !businessDate ? NO_BUSINESS_DATE : activeProperty?.base_currency ? revenueResult : NO_CURRENCY;
  const [arrivals, setArrivals] = useState(null);
  const [departures, setDepartures] = useState(null);
  const [discrepancies, setDiscrepancies] = useState(null);
  const [oversold, setOversold] = useState(null);
  const [nightAudit, setNightAudit] = useState(null);
  const [setupProgress, setSetupProgress] = useState(null);

  const propertyId = activeProperty?.id;

  useEffect(() => {
    let cancelled = false;
    const guard = (setter) => (value) => {
      if (!cancelled) setter(value);
    };

    reservationsApi
      .listReservations()
      .then((rows) => guard(setReservations)({ state: 'success', data: rows }))
      .catch((caught) => guard(setReservations)(failure(caught)));

    // Names only — a role without `setup.view` still gets a real donut,
    // labelled "Room type {id}", rather than losing the chart entirely.
    setupApi
      .listRoomTypes()
      .then(guard(setRoomTypes))
      .catch(() => guard(setRoomTypes)([]));

    if (businessDate) {
      reportingApi
        .getOccupancyReport({ dateFrom: shiftDate(businessDate, -7), dateTo: businessDate })
        .then((rows) => guard(setOccupancy)({ state: 'success', data: rows }))
        .catch((caught) => guard(setOccupancy)(failure(caught)));
      reportingApi
        .getRevenueReport({ dateFrom: shiftDate(businessDate, -13), dateTo: businessDate })
        .then((rows) => guard(setRevenue)({ state: 'success', data: rows }))
        .catch((caught) => guard(setRevenue)(failure(caught)));
      reportingApi.getOversoldRoomTypes(businessDate).then(guard(setOversold)).catch(() => guard(setOversold)(null));
    }

    reservationsApi.listArrivals().then(guard(setArrivals)).catch(() => guard(setArrivals)(null));
    reservationsApi.listDepartures().then(guard(setDepartures)).catch(() => guard(setDepartures)(null));
    housekeepingApi
      .listDiscrepancies({ resolved: false })
      .then(guard(setDiscrepancies))
      .catch(() => guard(setDiscrepancies)(null));

    nightAuditApi
      .listRuns()
      .then((runs) => {
        const todayRun = runs.find((run) => run.business_date === businessDate);
        guard(setNightAudit)({ status: todayRun?.status ?? null, message: null });
      })
      .catch((caught) => guard(setNightAudit)({ status: null, message: failure(caught).message }));

    setupApi
      .getSetupProgress()
      .then(guard(setSetupProgress))
      .catch(() => guard(setSetupProgress)(null));

    return () => {
      cancelled = true;
    };
  }, [businessDate, propertyId]);

  const currencyCode = activeProperty?.base_currency;
  const timeZone = activeProperty?.timezone;
  const week = businessDate ? dateWindow(businessDate) : [];
  const weekFrom = week[0];
  const lastWeekFrom = businessDate ? shiftDate(businessDate, -13) : null;
  const lastWeekTo = businessDate ? shiftDate(businessDate, -7) : null;
  const yesterday = businessDate ? shiftDate(businessDate, -1) : null;

  const reservationRows = reservations.state === 'success' ? reservations.data : null;
  const hasReservations = reservationRows !== null && reservationRows.length > 0;
  const occupancyByDate = new Map((occupancy.state === 'success' ? occupancy.data : []).map((row) => [row.date, row]));
  const revenueByDate = new Map((revenue.state === 'success' ? revenue.data : []).map((row) => [row.date, row]));

  const bookingsThisWeek = reservationRows && businessDate ? countBookings(reservationRows, weekFrom, businessDate) : 0;
  const weekOccupancyValues = week.map((date) => occupancyByDate.get(date)?.occupancyPct).filter((value) => typeof value === 'number');
  const averageOccupancy =
    weekOccupancyValues.length > 0 ? weekOccupancyValues.reduce((sum, value) => sum + value, 0) / weekOccupancyValues.length : null;

  const weekRevenue = week.map((date) => revenueByDate.get(date)?.roomRevenue ?? '0.00');
  const weekIncome = totalMoney(weekRevenue);
  const todayRevenue = revenueByDate.get(businessDate)?.roomRevenue ?? '0.00';

  return (
    <div className={styles.page}>
      <div className={styles.greetingRow}>
        <div className={styles.greetingText}>
          <h1 className={styles.greeting}>
            {greetingForHour(now, timeZone)}
            {greetingName ? `, ${greetingName}` : ''}
          </h1>
          <p className={styles.subline}>
            {activeProperty?.name ? `${activeProperty.name} — ` : ''}
            {formatLongDate(now, timeZone)}
          </p>
        </div>

        <div className={styles.summaryWidgets}>
          <section className={styles.widget} aria-label="Guest Rating">
            <h2 className={styles.widgetTitle}>Guest Rating</h2>
            <p className={styles.emptyMessage}>Guest ratings appear once guest reviews are collected.</p>
          </section>

          <section className={styles.widget} aria-label="Total Income — this week">
            <h2 className={styles.widgetTitle}>
              Total Income <span className={styles.widgetPeriod}>— this week</span>
            </h2>
            <WidgetBody
              source={revenue}
              isEmpty={isZeroMoney(weekIncome)}
              emptyMessage="Total income appears once Cashiering is posting revenue."
            >
              <div className={styles.incomeRow}>
                <span className={styles.widgetValue}>
                  <Money amount={weekIncome} currencyCode={currencyCode} />
                </span>
                <Sparkline values={weekRevenue.map(moneyToChartValue)} ariaLabel="Daily income over the last 7 business days" />
              </div>
            </WidgetBody>
          </section>
        </div>
      </div>

      {setupProgress?.operational === false && (
        <div className={styles.setupBanner} role="alert">
          <p className={styles.setupBannerText}>
            This property isn&rsquo;t fully set up yet — some figures below won&rsquo;t show real data until setup is complete.
          </p>
          {onNavigateToSetup && (
            <Button variant="secondary" size="compact" onClick={onNavigateToSetup}>
              Finish setup
            </Button>
          )}
        </div>
      )}

      <div className={styles.kpiGrid}>
        <KpiCard
          accent="primary"
          icon={<BookingsIcon />}
          label="Total Bookings"
          periodHint="Arrivals in the last 7 business days"
          source={reservations}
          isEmpty={!hasReservations || !businessDate}
          emptyMessage={businessDate ? 'No reservations yet.' : 'Available once this property has a business date.'}
          value={bookingsThisWeek}
          delta={reservationRows && businessDate ? countDelta(bookingsThisWeek, countBookings(reservationRows, lastWeekFrom, lastWeekTo)) : null}
          deltaContext="vs. the previous 7 days"
          progress={averageOccupancy === null ? null : ratio(averageOccupancy, 100)}
          progressLabel={averageOccupancy === null ? null : `Average occupancy this week: ${Math.round(averageOccupancy)}%`}
        />
        <RoomsAvailableCard occupancy={occupancy} today={occupancyByDate.get(businessDate)} yesterday={occupancyByDate.get(yesterday)} />
        <NewGuestsCard reservationsSource={reservations} rows={reservationRows} businessDate={businessDate} week={week} bookingsThisWeek={bookingsThisWeek} />
        <KpiCard
          accent="primary"
          icon={<RevenueIcon />}
          label="Total Revenue"
          periodHint="Room revenue posted today"
          source={revenue}
          isEmpty={isZeroMoney(todayRevenue)}
          emptyMessage="No revenue posted for today yet."
          value={<Money amount={todayRevenue} currencyCode={currencyCode} />}
          delta={moneyPercentDelta(todayRevenue, revenueByDate.get(yesterday)?.roomRevenue ?? '0.00')}
          deltaContext="vs. the previous business day"
          deltaSuffix="today"
          progress={isZeroMoney(weekIncome) ? null : ratio(moneyToChartValue(todayRevenue), moneyToChartValue(weekIncome))}
          progressLabel={
            isZeroMoney(weekIncome)
              ? null
              : `Today is ${Math.round(ratio(moneyToChartValue(todayRevenue), moneyToChartValue(weekIncome)) * 100)}% of this week's income`
          }
        />
      </div>

      <div className={styles.chartRow}>
        <section className={`${styles.chartCard} ${styles.chartCardWide}`} aria-label="New vs. Returning Guests">
          <div className={styles.chartHeader}>
            <div>
              <h2 className={styles.chartTitle}>New vs. Returning Guests</h2>
              <p className={styles.chartSubtitle}>Last 7 days</p>
            </div>
            <ul className={styles.legend}>
              <li className={styles.legendItem}>
                <span className={`${styles.legendSwatch} ${segmentClassName(0)}`} aria-hidden="true" />
                New
              </li>
              <li className={styles.legendItem}>
                <span className={`${styles.legendSwatch} ${segmentClassName(1)}`} aria-hidden="true" />
                Returning
              </li>
            </ul>
          </div>
          <NewVsReturningBody reservationsSource={reservations} rows={reservationRows} week={week} businessDate={businessDate} />
        </section>

        <section className={`${styles.chartCard} ${styles.chartCardNarrow}`} aria-label="Bookings by Room Type">
          <div className={styles.chartHeader}>
            <div>
              <h2 className={styles.chartTitle}>Bookings by Room Type</h2>
              <p className={styles.chartSubtitle}>This month</p>
            </div>
          </div>
          <RoomTypeBody reservationsSource={reservations} rows={reservationRows} roomTypes={roomTypes} businessDate={businessDate} />
        </section>
      </div>

      <section className={styles.chartCard} aria-label="Today at a glance">
        <h2 className={styles.chartTitle}>Today at a glance</h2>
        <ul className={styles.alertList}>
          <AlertRow label="Arrivals today" count={arrivals?.length} />
          <AlertRow label="Departures today" count={departures?.length} />
          <AlertRow label="Housekeeping discrepancies" count={discrepancies?.length} dangerIfNonZero />
          <AlertRow label="Oversold room types tonight" count={oversold?.length} dangerIfNonZero />
          <AlertRow label="Night audit for today's business date" pill={nightAuditPill(nightAudit)} />
        </ul>
      </section>
    </div>
  );
}

const LOADING = { state: 'loading' };
const NO_BUSINESS_DATE = { state: 'empty', message: 'Available once this property has a business date.' };
const NO_CURRENCY = { state: 'empty', message: 'Available once this property has a base currency.' };

/** A 403 is correct enforcement for a role without the grant — an honest empty state, not an error. Anything else is a real error. */
function failure(caught) {
  if (caught instanceof ApiError && caught.code === 'FORBIDDEN_PERMISSION') return { state: 'empty', message: NOT_FOR_ROLE };
  return { state: 'error', message: caught instanceof ApiError ? caught.message : 'Could not load.' };
}

function WidgetBody({ source, isEmpty, emptyMessage, children }) {
  if (source.state === 'loading') return <Skeleton height="2.25rem" />;
  if (source.state === 'error') return <p className={styles.errorMessage}>{source.message}</p>;
  if (source.state === 'empty') return <p className={styles.emptyMessage}>{source.message}</p>;
  if (isEmpty) return <p className={styles.emptyMessage}>{emptyMessage}</p>;
  return children;
}

function RoomsAvailableCard({ occupancy, today, yesterday }) {
  const physical = today?.physicalCount ?? 0;
  const available = today ? Math.max(physical - today.roomsSold, 0) : 0;
  let delta = null;
  if (today && yesterday) {
    // An already-audited day carries no physical count (its snapshot stores
    // the reproduced occupancy % instead) — today's live count stands in.
    const yesterdayPhysical = yesterday.physicalCount ?? physical;
    delta = countDelta(available, Math.max(yesterdayPhysical - yesterday.roomsSold, 0));
  }
  return (
    <KpiCard
      accent="secondary"
      icon={<RoomsIcon />}
      label="Rooms Available"
      periodHint="Sellable rooms still free tonight"
      source={occupancy}
      isEmpty={!today || physical === 0}
      emptyMessage="No rooms configured yet."
      value={available}
      delta={delta}
      deltaContext="vs. the previous business day"
      deltaSuffix="today"
      progress={ratio(available, physical)}
      progressLabel={physical ? `${available} of ${physical} rooms free tonight` : null}
    />
  );
}

function NewGuestsCard({ reservationsSource, rows, businessDate, week, bookingsThisWeek }) {
  const newThisWeek = rows && businessDate ? countNewGuests(rows, week[0], businessDate) : 0;
  const newLastWeek = rows && businessDate ? countNewGuests(rows, shiftDate(businessDate, -13), shiftDate(businessDate, -7)) : 0;
  const share = ratio(newThisWeek, bookingsThisWeek);
  return (
    <KpiCard
      accent="tertiary"
      icon={<NewGuestsIcon />}
      label="New Guests"
      periodHint="First-time guests arriving in the last 7 business days"
      source={reservationsSource}
      isEmpty={!rows || rows.length === 0 || !businessDate}
      emptyMessage={businessDate ? 'No guest stays yet.' : 'Available once this property has a business date.'}
      value={newThisWeek}
      delta={rows && businessDate ? countDelta(newThisWeek, newLastWeek) : null}
      deltaContext="vs. the previous 7 days"
      progress={share}
      progressLabel={share === null ? null : `${Math.round(share * 100)}% of this week's bookings are first-time guests`}
    />
  );
}

const DELTA_WORD = { up: 'Up', down: 'Down', flat: 'No change' };

function KpiCard({ accent, icon, label, periodHint, source, isEmpty, emptyMessage, value, delta, deltaContext, deltaSuffix, progress, progressLabel }) {
  const accentClass =
    accent === 'secondary' ? styles.accentSecondary : accent === 'tertiary' ? styles.accentTertiary : styles.accentPrimary;
  let body;
  if (source.state === 'loading') {
    body = (
      <div data-testid="kpi-loading" className={styles.kpiLoading}>
        <Skeleton variant="circle" height="2.25rem" />
        <Skeleton height="1.75rem" width="60%" />
        <Skeleton variant="text" width="45%" />
      </div>
    );
  } else if (source.state === 'error') {
    body = <p className={styles.errorMessage}>{source.message}</p>;
  } else if (source.state === 'empty' || isEmpty) {
    body = <p className={styles.emptyMessage}>{source.state === 'empty' ? source.message : emptyMessage}</p>;
  }

  return (
    <article className={`${styles.kpiCard} ${accentClass}`} aria-label={label}>
      {body ?? (
        <>
          <div className={styles.kpiTop}>
            <span className={styles.iconBadge}>{icon}</span>
            {delta && (
              <span
                className={`${styles.delta} ${styles[`delta_${delta.direction}`]}`}
                aria-label={
                  delta.direction === 'flat'
                    ? `${DELTA_WORD.flat} ${deltaContext}`
                    : `${DELTA_WORD[delta.direction]} ${delta.label.replace(/^[+−]/, '')} ${deltaContext}`
                }
                title={deltaContext}
              >
                <span aria-hidden="true">{delta.direction === 'up' ? '↗' : delta.direction === 'down' ? '↘' : '→'}</span>
                {delta.label}
                {deltaSuffix ? ` ${deltaSuffix}` : ''}
              </span>
            )}
          </div>
          <p className={styles.kpiValue}>{value}</p>
          <p className={styles.kpiLabel} title={periodHint}>
            {label}
          </p>
          {progress !== null && progress !== undefined && (
            <div
              className={styles.progressTrack}
              role="progressbar"
              aria-label={progressLabel}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress * 100)}
              title={progressLabel}
            >
              <div className={styles.progressFill} style={{ width: `${progress * 100}%` }} />
            </div>
          )}
        </>
      )}
      {body && <p className={styles.kpiLabelMuted}>{label}</p>}
    </article>
  );
}

function NewVsReturningBody({ reservationsSource, rows, week, businessDate }) {
  if (reservationsSource.state === 'loading') return <Skeleton height="13.75rem" />;
  if (reservationsSource.state !== 'success') {
    const className = reservationsSource.state === 'error' ? styles.errorMessage : styles.emptyMessage;
    return <p className={className}>{reservationsSource.message}</p>;
  }
  if (!businessDate) return <p className={styles.emptyMessage}>Available once this property has a business date.</p>;
  if (rows.length === 0) {
    return <p className={styles.emptyMessage}>This trend chart fills in once Reservations and Guest Profiles are tracking bookings.</p>;
  }
  const days = newVsReturningByDay(rows, week);
  const newTotal = days.reduce((sum, day) => sum + day.newGuests, 0);
  const returningTotal = days.reduce((sum, day) => sum + day.returningGuests, 0);
  if (newTotal + returningTotal === 0) {
    return <p className={styles.emptyMessage}>No guest arrivals in the last 7 business days.</p>;
  }
  return (
    <AreaChart
      labels={week.map(shortWeekday)}
      series={[
        { key: 'new', label: 'New', tone: 'primary', values: days.map((day) => day.newGuests) },
        { key: 'returning', label: 'Returning', tone: 'secondary', values: days.map((day) => day.returningGuests) },
      ]}
      ariaLabel={`Guest arrivals over the last 7 business days: ${newTotal} new, ${returningTotal} returning`}
    />
  );
}

/** Arrivals within the business date's calendar month, matching the card's "This month" subtitle. */
function RoomTypeBody({ reservationsSource, rows, roomTypes, businessDate }) {
  if (reservationsSource.state === 'loading') return <Skeleton height="11rem" />;
  if (reservationsSource.state !== 'success') {
    const className = reservationsSource.state === 'error' ? styles.errorMessage : styles.emptyMessage;
    return <p className={className}>{reservationsSource.message}</p>;
  }
  if (!businessDate) return <p className={styles.emptyMessage}>Available once this property has a business date.</p>;
  if (rows.length === 0) {
    return <p className={styles.emptyMessage}>This breakdown appears once Rooms and Reservations are configured.</p>;
  }
  const segments = bookingsByRoomType(rows, roomTypes, monthRange(businessDate));
  if (segments.length === 0) {
    return <p className={styles.emptyMessage}>No bookings arriving this month yet.</p>;
  }
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  return (
    <>
      <DonutChart
        segments={segments}
        centerValue={total}
        centerLabel={total === 1 ? 'booking' : 'bookings'}
        ariaLabel={`Bookings by room type: ${segments.map((segment) => `${segment.label} ${segment.percent}%`).join(', ')}`}
      />
      <ul className={styles.donutLegend}>
        {segments.map((segment, index) => (
          <li key={segment.key} className={styles.donutLegendItem}>
            <span className={`${styles.legendSwatch} ${segmentClassName(index)}`} aria-hidden="true" />
            <span className={styles.donutLegendLabel}>{segment.label}</span>
            <span className={styles.donutLegendPercent}>{segment.percent}%</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * `count === undefined` (load failed or not fetched) keeps the honest "Not
 * available yet" pill; a present count renders a real number, in danger tone
 * when it's a discrepancy/oversell figure and non-zero.
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

/** Maps the real `GET /night-audit/runs` result (or its load failure) onto a status pill, reusing `NightAuditScreen`'s own status→tone vocabulary. */
function nightAuditPill(nightAudit) {
  if (!nightAudit) return <StatusPill tone="neutral" label="Not available yet" />;
  if (nightAudit.message) return <StatusPill tone="neutral" label={nightAudit.message} />;
  if (!nightAudit.status) return <StatusPill tone="neutral" label="Not yet run" />;
  return <StatusPill tone={NIGHT_AUDIT_STATUS_TONE[nightAudit.status] ?? 'neutral'} label={nightAudit.status} />;
}
