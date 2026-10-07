import { useEffect, useState } from 'react';
import { StatusPill, Button, Skeleton } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { reservationsApi, setupApi, housekeepingApi, reportingApi, nightAuditApi, ApiError } from '../../shared/api/index.js';
import { STATUS_TONE as NIGHT_AUDIT_STATUS_TONE } from '../night-audit/NightAuditScreen.jsx';
import { AreaChart, BarChart, DonutChart, segmentClassName } from './DashboardCharts.jsx';
import { ArrivalIcon, DepartureIcon, InHouseIcon, OccupancyIcon, RateIcon, RevenueIcon, RevparIcon, RoomsIcon } from './dashboardIcons.jsx';
import {
  bookingsByRoomType,
  dateWindow,
  dayOfMonth,
  formatBusinessDate,
  formatDateRange,
  formatLongDate,
  formatPercent,
  greetingForHour,
  moneyPercentDelta,
  moneyToChartValue,
  monthRange,
  pointsDelta,
  shiftDate,
  totalMoney,
} from './dashboardMetrics.js';
import styles from './HomeDashboard.module.css';

const NOT_FOR_ROLE = 'Not available for your role.';
const TREND_DAYS = 14;

/**
 * HomeDashboard — the property's Home screen, laid out the way hotel PMS
 * dashboards conventionally are (user-requested: "professional and
 * standard"):
 *
 * 1. A page header — greeting, property, business date, and shortcuts.
 * 2. The four headline hotel KPIs for the current business date, each
 *    against the previous business day: **Occupancy** (rooms sold ÷
 *    sellable rooms), **ADR** (room revenue ÷ rooms sold), **RevPAR** (room
 *    revenue ÷ sellable rooms) and **Room revenue**. All four come straight
 *    from the Reporting module's occupancy and revenue reports — audited
 *    `daily_reports` figures for a closed date, live figures for the open
 *    one (see `reporting/service.js`), never recomputed here.
 * 3. **Today's operations** — arrivals, departures, in-house guests and
 *    rooms still free tonight, the numbers a front desk works from.
 * 4. Trends over the last 14 business days — occupancy and daily room
 *    revenue — plus bookings by room type for the month.
 * 5. **Needs attention** — open housekeeping discrepancies, oversold room
 *    types tonight, and whether night audit has run for this business date.
 *
 * Every window is anchored on the property's business date
 * (ARCHITECTURE.md §6), never the wall clock. Each source is fetched
 * independently, so a role without a grant (e.g. `reports.view_financial`)
 * sees "Not available for your role." on the cards that need it — never an
 * error banner — while the rest still renders.
 *
 * @param {string} [greetingName]   The signed-in user's first name.
 * @param {string|null} businessDate   'YYYY-MM-DD' — the active property's current business date.
 * @param {object} [activeProperty]   The active property record (name, timezone, base_currency).
 * @param {() => void} [onNavigateToSetup]
 * @param {(key: string) => void} [onNavigate]   Opens another screen by nav key.
 * @param {(key: string) => boolean} [canNavigate]   Whether this user's role can open that screen.
 * @param {boolean} [canViewBusinessSummary]   The user holds `reports.view_business`: shows the whole-business total tile (rooms + outlets + mini-mart, gross collected).
 * @param {Date} [now]   Injectable clock for the greeting — tests only.
 */
export function HomeDashboard({ greetingName, businessDate, activeProperty, onNavigateToSetup, onNavigate, canNavigate = () => true, canViewBusinessSummary = false, now: nowProp }) {
  const [now] = useState(() => nowProp ?? new Date());
  const [reservations, setReservations] = useState(LOADING);
  const [roomTypes, setRoomTypes] = useState(null);
  const [occupancyResult, setOccupancy] = useState(LOADING);
  const [revenueResult, setRevenue] = useState(LOADING);
  const [businessResult, setBusiness] = useState(LOADING);
  // Both reports need a business date to anchor on — a property that has
  // never had one configured gets a named empty state, not a fetch.
  const occupancy = businessDate ? occupancyResult : NO_BUSINESS_DATE;
  // `Money` refuses to format an amount with no currency (ARCHITECTURE.md
  // §1) — revenue cards wait on the property record rather than guessing one.
  const revenue = !businessDate ? NO_BUSINESS_DATE : activeProperty?.base_currency ? revenueResult : NO_CURRENCY;
  const [arrivals, setArrivals] = useState(LOADING);
  const [departures, setDepartures] = useState(LOADING);
  const [inHouse, setInHouse] = useState(LOADING);
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
    const load = (promise, setter) =>
      promise.then((data) => guard(setter)({ state: 'success', data })).catch((caught) => guard(setter)(failure(caught)));

    load(reservationsApi.listReservations(), setReservations);
    // Names only — a role without `setup.view` still gets a real donut,
    // labelled "Room type {id}", rather than losing the chart entirely.
    setupApi
      .listRoomTypes()
      .then(guard(setRoomTypes))
      .catch(() => guard(setRoomTypes)([]));

    if (businessDate) {
      const from = shiftDate(businessDate, -(TREND_DAYS - 1));
      load(reportingApi.getOccupancyReport({ dateFrom: from, dateTo: businessDate }), setOccupancy);
      load(reportingApi.getRevenueReport({ dateFrom: from, dateTo: businessDate }), setRevenue);
      if (canViewBusinessSummary) load(reportingApi.getBusinessSummary({ dateFrom: businessDate, dateTo: businessDate }), setBusiness);
      reportingApi.getOversoldRoomTypes(businessDate).then(guard(setOversold)).catch(() => guard(setOversold)(null));
    }

    load(reservationsApi.listArrivals(), setArrivals);
    load(reservationsApi.listDepartures(), setDepartures);
    load(reservationsApi.listInHouse(), setInHouse);
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
  }, [businessDate, propertyId, canViewBusinessSummary]);

  const currencyCode = activeProperty?.base_currency;
  // Whole-business total for the business date: the base-currency table's grand total (gross collected).
  const business = !businessDate ? NO_BUSINESS_DATE : businessResult;
  const businessTable = business.state === 'success' ? business.data.currencies.find((table) => table.currency === currencyCode) ?? null : null;
  const otherCurrencies = business.state === 'success' ? business.data.currencies.filter((table) => table.currency !== currencyCode).length : 0;
  const timeZone = activeProperty?.timezone;
  const trend = businessDate ? dateWindow(businessDate, TREND_DAYS) : [];
  const yesterday = businessDate ? shiftDate(businessDate, -1) : null;

  const occupancyByDate = new Map((occupancy.state === 'success' ? occupancy.data : []).map((row) => [row.date, row]));
  const revenueByDate = new Map((revenue.state === 'success' ? revenue.data : []).map((row) => [row.date, row]));
  const occupancyToday = occupancyByDate.get(businessDate);
  const occupancyYesterday = occupancyByDate.get(yesterday);
  const revenueToday = revenueByDate.get(businessDate);
  const revenueYesterday = revenueByDate.get(yesterday);

  const physical = occupancyToday?.physicalCount ?? 0;
  const roomsFree = occupancyToday ? Math.max(physical - occupancyToday.roomsSold, 0) : null;

  const reservationRows = reservations.state === 'success' ? reservations.data : null;

  const shortcuts = [
    { key: 'booking', label: 'Front desk & bookings', variant: 'primary' },
    { key: 'reports', label: 'Reports', variant: 'secondary' },
  ].filter((shortcut) => onNavigate && canNavigate(shortcut.key));

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.pageTitleBlock}>
          <h1 className={styles.greeting}>
            {greetingForHour(now, timeZone)}
            {greetingName ? `, ${greetingName}` : ''}
          </h1>
          {activeProperty?.name ? <p className={styles.propertyName}>{activeProperty.name}</p> : null}
          <p className={styles.subline}>
            {formatLongDate(now, timeZone)}
            {businessDate ? ` · Business date ${formatBusinessDate(businessDate)}` : ''}
          </p>
        </div>
        {shortcuts.length > 0 && (
          <div className={styles.headerActions}>
            {shortcuts.map((shortcut) => (
              <Button key={shortcut.key} variant={shortcut.variant} onClick={() => onNavigate(shortcut.key)}>
                {shortcut.label}
              </Button>
            ))}
          </div>
        )}
      </header>

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

      <section className={styles.kpiGrid} aria-label="Key figures for the business date">
        <KpiCard
          tone="blue"
          icon={<OccupancyIcon />}
          label="Occupancy"
          source={occupancy}
          ready={Boolean(occupancyToday) && physical > 0}
          emptyMessage="No sellable rooms configured yet."
          value={formatPercent(occupancyToday?.occupancyPct)}
          delta={pointsDelta(occupancyToday?.occupancyPct, occupancyYesterday?.occupancyPct)}
          detail={occupancyToday && physical > 0 ? `${occupancyToday.roomsSold} of ${physical} rooms sold` : null}
        />
        <KpiCard
          tone="teal"
          icon={<RateIcon />}
          label="ADR"
          hint="Average daily rate — room revenue ÷ rooms sold"
          source={revenue}
          // An average rate needs at least one room sold — with none, there is no rate to show (never a false ₦0.00).
          ready={soldAny(revenueToday)}
          emptyMessage="No rooms sold on this business date yet."
          value={soldAny(revenueToday) ? <Money amount={revenueToday.adr} currencyCode={currencyCode} /> : null}
          delta={soldAny(revenueToday) && soldAny(revenueYesterday) ? moneyPercentDelta(revenueToday.adr, revenueYesterday.adr) : null}
          detail="Average daily rate"
        />
        <KpiCard
          tone="green"
          icon={<RevparIcon />}
          label="RevPAR"
          hint="Revenue per available room — room revenue ÷ sellable rooms"
          source={revenue}
          ready={Boolean(revenueToday) && revenueToday.revpar != null}
          emptyMessage="No sellable rooms configured yet."
          value={revenueToday?.revpar != null ? <Money amount={revenueToday.revpar} currencyCode={currencyCode} /> : null}
          delta={revenueToday?.revpar != null && revenueYesterday?.revpar != null ? moneyPercentDelta(revenueToday.revpar, revenueYesterday.revpar) : null}
          detail="Revenue per available room"
        />
        <KpiCard
          tone="navy"
          icon={<RevenueIcon />}
          label="Room revenue"
          source={revenue}
          ready={Boolean(revenueToday)}
          emptyMessage="No revenue posted for this business date yet."
          value={revenueToday ? <Money amount={revenueToday.roomRevenue} currencyCode={currencyCode} /> : null}
          delta={revenueToday && revenueYesterday ? moneyPercentDelta(revenueToday.roomRevenue, revenueYesterday.roomRevenue) : null}
          detail={
            revenue.state === 'success' ? (
              <>
                <Money amount={totalMoney(dateWindow(businessDate).map((date) => revenueByDate.get(date)?.roomRevenue ?? '0.00'))} currencyCode={currencyCode} /> over the last 7
                days
              </>
            ) : null
          }
        />
        {canViewBusinessSummary && (
          <KpiCard
            tone="amber"
            icon={<RevenueIcon />}
            label="Total business today"
            hint="Money collected today across rooms, bars/restaurants and the mini-mart (tax, service and tips included). Ties to Payment Reconciliation."
            source={business}
            ready={Boolean(businessTable)}
            emptyMessage="Nothing collected on this business date yet."
            value={businessTable ? <Money amount={businessTable.total.grossCollected} currencyCode={currencyCode} /> : null}
            delta={null}
            detail={otherCurrencies > 0 ? 'Collected · rooms, outlets, mini-mart (other currencies in the report)' : 'Collected · rooms, outlets, mini-mart'}
          />
        )}
      </section>

      <section className={styles.card} aria-label="Today's operations">
        <div className={styles.cardHeader}>
          <div>
            <h2 className={styles.cardTitle}>Today&rsquo;s operations</h2>
            {businessDate && <p className={styles.cardSubtitle}>{formatBusinessDate(businessDate)}</p>}
          </div>
        </div>
        <div className={styles.opsGrid}>
          <OpsStat tone="blue" icon={<ArrivalIcon />} label="Arrivals" caption="Expected to check in" source={arrivals} count={arrivals.data?.length} />
          <OpsStat tone="amber" icon={<DepartureIcon />} label="Departures" caption="Due to check out" source={departures} count={departures.data?.length} />
          <OpsStat tone="green" icon={<InHouseIcon />} label="In-house" caption="Stays checked in now" source={inHouse} count={inHouse.data?.length} />
          <OpsStat
            tone="teal"
            icon={<RoomsIcon />}
            label="Rooms available"
            caption={roomsFree === null ? 'Free tonight' : `Free tonight, of ${physical} sellable`}
            source={occupancy}
            count={roomsFree === null ? undefined : roomsFree}
          />
        </div>
      </section>

      <div className={styles.twoColumn}>
        <section className={`${styles.card} ${styles.wide}`} aria-label="Occupancy trend">
          <div className={styles.cardHeader}>
            <div>
              <h2 className={styles.cardTitle}>Occupancy</h2>
              <p className={styles.cardSubtitle}>{trend.length ? `Last ${TREND_DAYS} days · ${formatDateRange(trend[0], businessDate)}` : `Last ${TREND_DAYS} days`}</p>
            </div>
            {occupancy.state === 'success' && trendAverage(trend, occupancyByDate) !== null && (
              <div className={styles.headerFigure}>
                <span className={styles.headerFigureValue}>{formatPercent(trendAverage(trend, occupancyByDate))}</span>
                <span className={styles.headerFigureLabel}>average</span>
              </div>
            )}
          </div>
          <SourceBody source={occupancy} skeletonHeight="13.75rem">
            <AreaChart
              labels={trend.map(dayOfMonth)}
              series={[{ key: 'occupancy', label: 'Occupancy', tone: 'primary', values: trend.map((date) => occupancyByDate.get(date)?.occupancyPct ?? 0) }]}
              maxValue={100}
              formatTick={(tick) => `${tick}%`}
              ariaLabel={`Occupancy over the last ${TREND_DAYS} business days, ending at ${formatPercent(occupancyToday?.occupancyPct)}`}
            />
          </SourceBody>
        </section>

        <section className={`${styles.card} ${styles.narrow}`} aria-label="Bookings by room type">
          <div className={styles.cardHeader}>
            <div>
              <h2 className={styles.cardTitle}>Bookings by room type</h2>
              <p className={styles.cardSubtitle}>Arrivals this month</p>
            </div>
          </div>
          <RoomTypeBody reservationsSource={reservations} rows={reservationRows} roomTypes={roomTypes} businessDate={businessDate} />
        </section>
      </div>

      <div className={styles.twoColumn}>
        <section className={`${styles.card} ${styles.wide}`} aria-label="Room revenue trend">
          <div className={styles.cardHeader}>
            <div>
              <h2 className={styles.cardTitle}>Room revenue</h2>
              <p className={styles.cardSubtitle}>{trend.length ? `Last ${TREND_DAYS} days · ${formatDateRange(trend[0], businessDate)}` : `Last ${TREND_DAYS} days`}</p>
            </div>
            {revenue.state === 'success' && (
              <div className={styles.headerFigure}>
                <span className={styles.headerFigureValue}>
                  <Money amount={totalMoney(trend.map((date) => revenueByDate.get(date)?.roomRevenue ?? '0.00'))} currencyCode={currencyCode} />
                </span>
                <span className={styles.headerFigureLabel}>total</span>
              </div>
            )}
          </div>
          <SourceBody source={revenue} skeletonHeight="13.75rem">
            <BarChart
              labels={trend.map(dayOfMonth)}
              values={trend.map((date) => moneyToChartValue(revenueByDate.get(date)?.roomRevenue ?? '0.00'))}
              highlightIndex={trend.length - 1}
              ariaLabel={`Daily room revenue over the last ${TREND_DAYS} business days`}
            />
          </SourceBody>
        </section>

        <section className={`${styles.card} ${styles.narrow}`} aria-label="Needs attention">
          <div className={styles.cardHeader}>
            <div>
              <h2 className={styles.cardTitle}>Needs attention</h2>
              <p className={styles.cardSubtitle}>For this business date</p>
            </div>
          </div>
          <ul className={styles.attentionList}>
            <AttentionRow label="Housekeeping discrepancies" count={discrepancies?.length} />
            <AttentionRow label="Oversold room types tonight" count={oversold?.length} />
            <li className={styles.attentionRow}>
              <span className={styles.attentionLabel}>Night audit</span>
              {nightAuditPill(nightAudit)}
            </li>
          </ul>
        </section>
      </div>
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

/** Whether a revenue-report day sold any rooms (so its ADR means something). */
function soldAny(day) {
  return Boolean(day) && day.adr != null && Number(day.roomsSold) > 0;
}

/** Mean occupancy across the window's days that have a figure; `null` when none do. */
function trendAverage(dates, occupancyByDate) {
  const values = dates.map((date) => occupancyByDate.get(date)?.occupancyPct).filter((value) => typeof value === 'number');
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function SourceBody({ source, skeletonHeight, children }) {
  if (source.state === 'loading') return <Skeleton height={skeletonHeight} />;
  if (source.state === 'error') return <p className={styles.errorMessage}>{source.message}</p>;
  if (source.state === 'empty') return <p className={styles.emptyMessage}>{source.message}</p>;
  return children;
}

const TONE_CLASS = {
  blue: styles.toneBlue,
  teal: styles.toneTeal,
  green: styles.toneGreen,
  navy: styles.toneNavy,
  amber: styles.toneAmber,
};

const DELTA_WORD = { up: 'Up', down: 'Down', flat: 'No change' };

/**
 * One headline figure. The card keeps the same shape in every state —
 * label and icon at the top, the figure (or "—"), then a context line — so
 * a missing figure reads as "nothing yet", never as a broken card.
 */
function KpiCard({ tone, icon, label, hint, source, ready, emptyMessage, value, delta, detail }) {
  let figure;
  let context;
  if (source.state === 'loading') {
    figure = <Skeleton height="2rem" width="60%" />;
    context = <Skeleton variant="text" width="45%" />;
  } else if (source.state === 'error') {
    figure = <span className={styles.kpiValueMissing}>—</span>;
    context = <span className={styles.errorMessage}>{source.message}</span>;
  } else if (source.state === 'empty' || !ready) {
    figure = <span className={styles.kpiValueMissing}>—</span>;
    context = <span className={styles.kpiContext}>{source.state === 'empty' ? source.message : emptyMessage}</span>;
  } else {
    figure = value;
    context = (
      <>
        {delta ? (
          <span
            className={`${styles.delta} ${styles[`delta_${delta.direction}`]}`}
            aria-label={delta.direction === 'flat' ? `${DELTA_WORD.flat} vs. the previous business day` : `${DELTA_WORD[delta.direction]} ${delta.label.replace(/^[+−]/, '')} vs. the previous business day`}
          >
            <span aria-hidden="true">{delta.direction === 'up' ? '▲' : delta.direction === 'down' ? '▼' : '■'}</span>
            {delta.label}
          </span>
        ) : null}
        <span className={styles.kpiContext}>{delta ? 'vs. previous day' : detail}</span>
      </>
    );
  }

  return (
    <article className={styles.kpiCard} aria-label={label}>
      <div className={styles.kpiHeader}>
        <span className={styles.kpiLabel} title={hint}>
          {label}
        </span>
        <span className={`${styles.iconChip} ${TONE_CLASS[tone] ?? styles.toneBlue}`}>{icon}</span>
      </div>
      <p className={styles.kpiValue}>{figure}</p>
      <div className={styles.kpiFooter}>{context}</div>
      {ready && source.state === 'success' && delta && detail ? <p className={styles.kpiDetail}>{detail}</p> : null}
    </article>
  );
}

function OpsStat({ tone, icon, label, caption, source, count }) {
  let figure;
  if (source.state === 'loading') figure = <Skeleton height="1.75rem" width="3rem" />;
  else if (source.state === 'success' && typeof count === 'number') figure = count;
  else figure = <span className={styles.kpiValueMissing}>—</span>;
  const note = source.state === 'error' || source.state === 'empty' ? source.message : caption;
  return (
    <div className={styles.opsStat} role="group" aria-label={label}>
      <span className={`${styles.iconChip} ${TONE_CLASS[tone] ?? styles.toneBlue}`}>{icon}</span>
      <div className={styles.opsText}>
        <span className={styles.opsValue}>{figure}</span>
        <span className={styles.opsLabel}>{label}</span>
        <span className={styles.opsCaption}>{note}</span>
      </div>
    </div>
  );
}

/** Arrivals within the business date's calendar month, matching the card's "Arrivals this month" subtitle. */
function RoomTypeBody({ reservationsSource, rows, roomTypes, businessDate }) {
  if (reservationsSource.state === 'loading') return <Skeleton height="11rem" />;
  if (reservationsSource.state !== 'success') {
    const className = reservationsSource.state === 'error' ? styles.errorMessage : styles.emptyMessage;
    return <p className={className}>{reservationsSource.message}</p>;
  }
  if (!businessDate) return <p className={styles.emptyMessage}>Available once this property has a business date.</p>;
  const segments = bookingsByRoomType(rows, roomTypes, monthRange(businessDate));
  if (segments.length === 0) {
    return <p className={styles.emptyMessage}>No bookings arriving this month yet.</p>;
  }
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  return (
    <div className={styles.donutLayout}>
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
            <span className={styles.donutLegendCount}>{segment.count}</span>
            <span className={styles.donutLegendPercent}>{segment.percent}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * `count === undefined` (load failed or not fetched) stays an honest "Not
 * available"; zero is "None" in a success tone; anything else is a danger
 * count — these rows only ever count problems.
 */
function AttentionRow({ label, count }) {
  let pill;
  if (count === undefined) pill = <StatusPill tone="neutral" label="Not available" />;
  else if (count === 0) pill = <StatusPill tone="success" label="None" />;
  else pill = <StatusPill tone="danger" label={String(count)} />;
  return (
    <li className={styles.attentionRow}>
      <span className={styles.attentionLabel}>{label}</span>
      {pill}
    </li>
  );
}

/** Maps the real `GET /night-audit/runs` result (or its load failure) onto a status pill, reusing `NightAuditScreen`'s own status→tone vocabulary. */
function nightAuditPill(nightAudit) {
  if (!nightAudit) return <StatusPill tone="neutral" label="Not available" />;
  if (nightAudit.message) return <StatusPill tone="neutral" label={nightAudit.message} />;
  if (!nightAudit.status) return <StatusPill tone="warning" label="Not yet run" />;
  return <StatusPill tone={NIGHT_AUDIT_STATUS_TONE[nightAudit.status] ?? 'neutral'} label={nightAudit.status} />;
}
