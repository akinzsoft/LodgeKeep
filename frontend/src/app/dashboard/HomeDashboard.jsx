import { Card, IconBadge, StatusPill } from '../../shared/components/index.js';
import styles from './HomeDashboard.module.css';

/**
 * HomeDashboard — PRODUCT_REQUIREMENTS.md's "Manager dashboard (Home)"
 * layout: greeting, summary widgets, a 4-card KPI row, a 2-widget chart row,
 * and an operational alert strip.
 *
 * Every number on the real version of this screen is explicit about coming
 * from a module: "Total Booking → Reservations", "Rooms Available → Rooms
 * Management", "New Customers → Profiles", "Total Revenue → Cashiering/AR" —
 * and the spec says outright, "bound to real module data, never mock
 * values." None of those modules exists yet (PLAN.md Phase 1+), so this
 * renders the real layout with every data-bearing piece in its honest empty
 * state instead — DESIGN_SYSTEM.md §2: "Empty — explain what belongs here."
 * The moment a module ships, its card's `emptyMessage` becomes a real value
 * and nothing else about this file's structure needs to change.
 *
 * This also happens to be the first real screen where all four domain
 * accents (`--domain-booking/rooms/guest/money`) appear as actual icon
 * badges — DESIGN_SYSTEM.md §1's "colour by domain, reused across every
 * screen" needs a screen with domain-shaped content to reuse them *on*, and
 * the shell chrome itself never had one.
 *
 * @param {string} greetingName   Shown as "Hi, {name}!" — falls back to a generic greeting if empty.
 */
export function HomeDashboard({ greetingName }) {
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
        <KpiPlaceholder domain="booking" icon="📅" label="Total Booking" source="Reservations" />
        <KpiPlaceholder domain="rooms" icon="🛏️" label="Rooms Available" source="Rooms Management" />
        <KpiPlaceholder domain="guest" icon="👤" label="New Customers" source="Guest Profiles" />
        <KpiPlaceholder domain="money" icon="💰" label="Total Revenue" source="Cashiering" />
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
          <AlertRow label="Arrivals today" />
          <AlertRow label="Departures today" />
          <AlertRow label="Housekeeping discrepancies" />
          <AlertRow label="Oversold room types tonight" />
          <AlertRow label="Night audit for today's business date" />
        </ul>
      </Card>
    </div>
  );
}

function KpiPlaceholder({ domain, icon, label, source }) {
  return (
    <Card className={styles.kpiCard}>
      <div className={styles.kpiRow}>
        <IconBadge domain={domain}>{icon}</IconBadge>
        <div className={styles.kpiText}>
          <p className={styles.kpiLabel}>{label}</p>
          <p className={styles.kpiValue}>—</p>
          <p className={styles.kpiCaption}>Available once {source} is set up</p>
        </div>
      </div>
    </Card>
  );
}

function AlertRow({ label }) {
  return (
    <li className={styles.alertRow}>
      <span className={styles.alertLabel}>{label}</span>
      <StatusPill tone="neutral" label="Not available yet" />
    </li>
  );
}
