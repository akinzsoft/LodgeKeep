import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, StatusPill } from '../../shared/components/index.js';
import { posApi, ApiError } from '../../shared/api/index.js';
import formStyles from './POSForm.module.css';
import styles from './TicketsTab.module.css';

/** How often the queue re-reads itself while the tab is open. */
export const REFRESH_MS = 10_000;
/** A ticket waiting longer than these reads as late, then very late. */
const LATE_MINUTES = 15;
const VERY_LATE_MINUTES = 30;

const GUEST_STATUS = {
  received: { tone: 'warning', label: 'Guest · Not accepted yet' },
  preparing: { tone: 'info', label: 'Guest · Preparing' },
};

/**
 * TicketsTab — the kitchen/bar ticket screen (PRODUCT_REQUIREMENTS.md §3.4:
 * "printed or displayed, so the order reaches whoever makes it"). A grid of
 * ticket cards, oldest first, each showing what to make and how long the
 * tab has been waiting, with a Done button that takes it off the queue.
 *
 * - A ticket is any tab the kitchen has not marked done, open or already
 *   paid — orders paid at the point of ordering (guest QR card orders,
 *   "Send to Bar & Checkout") settle within seconds. Adding an item to a
 *   tab puts its ticket back on the queue.
 * - One request per load (`GET /pos/tickets`), re-read every
 *   `REFRESH_MS` and on demand, so a new order reaches the screen without
 *   anyone leaving the tab. A failed refresh keeps the last good tickets on
 *   screen and says so; the next good refresh clears the warning.
 * - Guest QR orders appear once paid. One not yet accepted on the Guest
 *   orders tab is flagged and cannot be marked done (it may still be
 *   auto-rejected and refunded); an unpaid one never appears (both
 *   enforced by the backend).
 * - An outlet picker narrows the queue to the bar or kitchen this screen
 *   serves; empty tabs are left out since there is nothing to make.
 */
export function TicketsTab() {
  const [outlets, setOutlets] = useState([]);
  const [outletId, setOutletId] = useState('');
  const [tickets, setTickets] = useState(null);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const latestRequest = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++latestRequest.current;
    try {
      const rows = await posApi.listKitchenTickets({ outletId: outletId || undefined });
      if (requestId !== latestRequest.current) return;
      setTickets(rows);
      setError(null);
      setLastUpdated(new Date());
    } catch (caught) {
      if (requestId !== latestRequest.current) return;
      setError(caught instanceof ApiError ? caught.message : 'Could not load tickets.');
      setTickets((previous) => previous ?? []);
    } finally {
      setNow(Date.now());
    }
  }, [outletId]);

  const [doneError, setDoneError] = useState(null);
  const [markingDone, setMarkingDone] = useState(null);

  async function markDone(ticket) {
    setMarkingDone(ticket.id);
    setDoneError(null);
    try {
      await posApi.markTicketDone(ticket.id);
      setTickets((previous) => (previous ?? []).filter((row) => row.id !== ticket.id));
      await load();
    } catch (caught) {
      setDoneError(caught instanceof ApiError ? caught.message : `Could not mark ticket #${ticket.id} done.`);
    } finally {
      setMarkingDone(null);
    }
  }

  // A different outlet is a different queue: never keep showing the old outlet's tickets.
  function changeOutlet(nextOutletId) {
    setOutletId(nextOutletId);
    setTickets(null);
    setLastUpdated(null);
    setError(null);
  }

  async function refreshNow() {
    setManualRefreshing(true);
    await load();
    setManualRefreshing(false);
  }

  useEffect(() => {
    posApi
      .listOutlets()
      .then((rows) => setOutlets(rows.filter((outlet) => outlet.status !== 'archived')))
      .catch(() => setOutlets([]));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount/outlet change, then poll; no data-fetching library exists yet to own this
    load();
    const refresh = setInterval(load, REFRESH_MS);
    return () => clearInterval(refresh);
  }, [load]);

  const hadTickets = tickets !== null && lastUpdated !== null;
  const cardState = tickets === null ? 'loading' : error && !hadTickets ? 'error' : tickets.length === 0 ? 'empty' : 'success';
  const count = tickets?.length ?? 0;

  return (
    <div className={formStyles.form}>
      <div className={styles.toolbar}>
        <label className={styles.outletField}>
          <span className={formStyles.label}>Outlet</span>
          <select className={formStyles.select} value={outletId} onChange={(event) => changeOutlet(event.target.value)}>
            <option value="">All outlets</option>
            {outlets.map((outlet) => (
              <option key={outlet.id} value={outlet.id}>
                {outlet.name}
              </option>
            ))}
          </select>
        </label>
        <p className={styles.updated} aria-live="polite">
          {lastUpdated ? `Updated ${formatClock(lastUpdated)} · refreshes every ${REFRESH_MS / 1000}s` : 'Loading…'}
        </p>
        <Button variant="secondary" onClick={refreshNow} disabled={manualRefreshing}>
          {manualRefreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {doneError && (
        <p role="alert" className={formStyles.errorBanner}>
          {doneError}
        </p>
      )}

      {error && hadTickets && (
        <p role="alert" className={formStyles.errorBanner}>
          {`Couldn't refresh (${error}). Showing tickets from ${formatClock(lastUpdated)}.`}
        </p>
      )}

      <Card
        title={cardState === 'success' ? `Open tickets · ${count}` : 'Open tickets'}
        state={cardState}
        emptyMessage="No tickets to make right now."
        errorMessage={error}
      >
        <ul className={styles.grid} aria-label="Tickets">
          {(tickets ?? []).map((ticket) => (
            <TicketCard key={ticket.id} ticket={ticket} now={now} showOutlet={!outletId} onDone={markDone} marking={markingDone === ticket.id} />
          ))}
        </ul>
      </Card>
    </div>
  );
}

function TicketCard({ ticket, now, showOutlet, onDone, marking }) {
  const minutes = Math.max(0, Math.floor((now - new Date(ticket.opened_at).getTime()) / 60_000));
  const ageTone = minutes >= VERY_LATE_MINUTES ? 'danger' : minutes >= LATE_MINUTES ? 'warning' : 'neutral';
  const guest = ticket.source === 'guest' ? GUEST_STATUS[ticket.guest_status] : null;
  const name = ticketName(ticket);
  const totalItems = ticket.items.reduce((sum, item) => sum + item.quantity, 0);
  const awaitingAcceptance = ticket.source === 'guest' && ticket.guest_status === 'received';

  return (
    <li className={`${styles.ticket} ${styles[`ticket_${ageTone}`] ?? ''}`.trim()} aria-label={`Ticket #${ticket.id}, ${name}`}>
      <div className={styles.ticketHeader}>
        <div className={styles.ticketTitle}>
          <span className={styles.ticketNumber}>#{ticket.id}</span>
          <h3 className={styles.ticketName}>{name}</h3>
        </div>
        <StatusPill tone={ageTone} label={formatAge(minutes)} />
      </div>
      <div className={styles.ticketMeta}>
        {guest && <StatusPill tone={guest.tone} label={guest.label} />}
        {guest && ticket.guest_name && <span>{ticket.guest_name}</span>}
        {showOutlet && <span>{ticket.outlet_name}</span>}
        <span>Opened {formatClock(new Date(ticket.opened_at))}</span>
      </div>
      <ul className={styles.items} aria-label={`Items for ticket #${ticket.id}`}>
        {ticket.items.map((item) => (
          <li key={item.id} className={styles.item}>
            <span className={styles.quantity}>{item.quantity}×</span>
            <span className={styles.itemName}>
              {item.name}
              {Array.isArray(item.modifiers) && item.modifiers.length > 0 && (
                <span className={styles.modifiers}>{item.modifiers.map((modifier) => [modifier.name, modifier.option].filter(Boolean).join(': ')).join(' · ')}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      <div className={styles.ticketFooter}>
        <span>
          {totalItems} item{totalItems === 1 ? '' : 's'}
          {ticket.status === 'settled' ? ' · Paid' : ''}
        </span>
        {awaitingAcceptance ? (
          <span className={styles.acceptHint}>Accept on Guest orders first</span>
        ) : (
          <Button onClick={() => onDone(ticket)} disabled={marking} aria-label={`Mark ticket #${ticket.id} done`}>
            {marking ? 'Marking…' : 'Done'}
          </Button>
        )}
      </div>
    </li>
  );
}

/** A guest order's label is the raw QR table label ("6") or "Room 204". */
export function ticketName(ticket) {
  const label = ticket.table_label?.trim();
  if (ticket.source !== 'guest') return label || 'Walk-up';
  if (!label) return 'Guest order';
  return /^room\b/i.test(label) ? label : `Table ${label}`;
}

export function formatAge(minutes) {
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function formatClock(date) {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
