import { useEffect, useRef, useState } from 'react';
import { Card, DataTable, Button, StatusPill, ConfirmDialog } from '../../shared/components/index.js';
import { formatQuantity, compareQuantity, quantityShortfall } from './stockFormat.js';
import { posApi, stockApi, ApiError } from '../../shared/api/index.js';
import { StockItemOptions } from './stockItemOptions.jsx';
import { isStoreOutlet } from './outletTypes.js';
import formStyles from './POSForm.module.css';

/**
 * StockRequestsTab — an outlet asks the store for stock; the storekeeper
 * issues it or rejects it (user-requested). Confirmed: several items per
 * request; raised by POS operators and managers (`pos.stock_request`);
 * issued — in full or in part — or rejected with a reason by whoever holds
 * `pos.stock_transfer` (the Storekeeper), in one step. Issuing moves the
 * stock at once, exactly like a transfer; there is no receipt step.
 *
 * One screen for both sides: the "Request stock" form shows only to a role
 * that can raise requests, the Issue/Reject controls only to one that can
 * issue, and Withdraw only to a requester. Without `permissions` every
 * control shows; the server's own check is the real enforcement.
 *
 * Top-ups (user-requested): a request is still decided once, so when the
 * store sends less than was asked, the outlet raises a NEW request for the
 * rest. "Request the rest" on an issued-short request fills the form with
 * what was not sent, between the same two outlets (the server requires
 * them), and the outlet may lower amounts, drop items or add others before
 * sending. The two requests are linked both ways ("Top-up of #12" /
 * "Topped up by #15"); only one live top-up per request is allowed.
 */

const STATUS = {
  pending: { tone: 'warning', label: 'Pending' },
  issued: { tone: 'success', label: 'Issued' },
  rejected: { tone: 'danger', label: 'Rejected' },
  cancelled: { tone: 'neutral', label: 'Withdrawn' },
};
const FILTERS = [
  { value: 'pending', label: 'Pending' },
  { value: 'issued', label: 'Issued' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'cancelled', label: 'Withdrawn' },
  { value: '', label: 'All' },
];
const QUANTITY_PATTERN = /^\d+(\.\d{1,3})?$/;

/** Lines sent short, with what is still missing — archived items are left out (they cannot be asked for again). */
const shortfallOf = (request) =>
  request.lines
    .filter((line) => line.quantityIssued != null && compareQuantity(line.quantityIssued, line.quantityRequested) < 0)
    .map((line) => ({ ...line, missing: quantityShortfall(line.quantityRequested, line.quantityIssued) }));
const liveTopUpOf = (request) => request.topUps?.find((topUp) => topUp.status === 'pending' || topUp.status === 'issued') ?? null;
const isPositiveQuantity = (value) => QUANTITY_PATTERN.test(value.trim()) && compareQuantity(value.trim(), '0') > 0;
const formatWhen = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const messageOf = (caught, fallback) => (caught instanceof ApiError ? caught.message : fallback);

let lineKeySeed = 0;
const blankLine = () => ({ key: (lineKeySeed += 1), stockItemId: '', quantity: '' });

/** What to send by default: everything asked for, or whatever the store holds if that is less (never below zero). */
function defaultIssueQuantity(line) {
  const available = line.availableAtSource ?? '0';
  if (compareQuantity(available, '0') <= 0) return '0';
  return compareQuantity(available, line.quantityRequested) < 0 ? available : line.quantityRequested;
}

/**
 * `deliverToOutletId` (the Supermarket's "Request stock" tab): requests are for that one outlet only, so
 * "Deliver to" is fixed to it and the list shows only requests delivered there.
 */
export function StockRequestsTab({ isOffline = false, permissions, intent, deliverToOutletId = null }) {
  const canRequest = !permissions || permissions.has('pos.stock_request');
  const canIssue = !permissions || permissions.has('pos.stock_transfer');

  const [outlets, setOutlets] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  // Raising a request.
  const [fromOutletId, setFromOutletId] = useState('');
  const [toOutletId, setToOutletId] = useState(deliverToOutletId ? String(deliverToOutletId) : '');
  // Staff tied to outlets (Staff screen) deliver to their own outlets only —
  // the server refuses any other; null until known or when unrestricted.
  const [myOutletIds, setMyOutletIds] = useState(null);
  const [sourceItems, setSourceItems] = useState(null);
  const [lines, setLines] = useState(() => [blankLine()]);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const itemsRequest = useRef(0);
  // The issued-short request the form is topping up, or null for an ordinary request.
  const [topUpOf, setTopUpOf] = useState(null);
  const formRef = useRef(null);

  // The list and the one request open for review.
  const [filter, setFilter] = useState(canIssue ? 'pending' : '');
  const [requests, setRequests] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [issueQuantities, setIssueQuantities] = useState({});
  const [issueNote, setIssueNote] = useState('');
  const [acting, setActing] = useState(false);
  const [dialog, setDialog] = useState(null); // 'reject' | 'cancel' | null
  const listRequest = useRef(0);
  // The request a notification pointed at, fetched on its own so it opens
  // whatever the list is filtered to (an issued request is not "Pending").
  const [focused, setFocused] = useState(null);
  const focusRequest = useRef(0);
  // User-reported: "the storekeeper could not issue the request". The
  // review panel (with Issue) renders below the request form and the list —
  // off-screen — so opening a request looked like nothing happened. Each
  // open bumps this, and the panel is scrolled into view and focused.
  const [revealTick, setRevealTick] = useState(0);
  const detailRef = useRef(null);

  const selected =
    (requests ?? []).find((row) => String(row.id) === String(selectedId)) ?? (focused && String(focused.id) === String(selectedId) ? focused : null);

  async function loadSourceItems(outletId) {
    const requestId = (itemsRequest.current += 1);
    setSourceItems(null);
    if (!outletId) return;
    try {
      const rows = await stockApi.listStockItems({ outletId });
      if (requestId === itemsRequest.current) setSourceItems(rows);
    } catch (caught) {
      if (requestId !== itemsRequest.current) return;
      setSourceItems([]);
      setError(messageOf(caught, 'Could not load the stock items for this outlet.'));
    }
  }

  useEffect(() => {
    if (!canRequest) return;
    stockApi
      .getMyRequestOutlets()
      .then((scope) => {
        if (!scope?.restricted) return;
        setMyOutletIds(scope.outletIds.map(String));
        if (scope.outletIds.length === 1 && !deliverToOutletId) setToOutletId(String(scope.outletIds[0]));
      })
      .catch(() => {}); // unknown scope: offer every outlet; the server still enforces it
  }, [canRequest, deliverToOutletId]);

  useEffect(() => {
    posApi
      .listOutlets()
      .then((rows) => {
        setOutlets(rows);
        // Most requests go to the store — start there when there is one.
        const store = rows.find(isStoreOutlet);
        if (store && canRequest) {
          setFromOutletId(String(store.id));
          loadSourceItems(String(store.id));
        }
      })
      .catch((caught) => {
        setOutlets([]);
        setError(messageOf(caught, 'Could not load outlets.'));
      });
    // Mount only: the permissions a role holds do not change while this screen is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Only the newest list response may write: switching the filter quickly
  // must never leave an older, slower answer on screen.
  async function loadRequests(status = filter) {
    const requestId = (listRequest.current += 1);
    try {
      const rows = await stockApi.listTransferRequests({ status: status || undefined, limit: 100 });
      if (requestId === listRequest.current) setRequests(rows);
    } catch (caught) {
      if (requestId !== listRequest.current) return;
      setRequests([]);
      setError(messageOf(caught, 'Could not load stock requests.'));
    }
  }

  useEffect(() => {
    const requestId = (listRequest.current += 1);
    stockApi
      .listTransferRequests({ status: filter || undefined, limit: 100 })
      .then((rows) => {
        if (requestId === listRequest.current) setRequests(rows);
      })
      .catch((caught) => {
        if (requestId !== listRequest.current) return;
        setRequests([]);
        setError(messageOf(caught, 'Could not load stock requests.'));
      });
  }, [filter]);

  // Opening a stock-request notification: fetch that request and open it.
  // Once per click (the intent's nonce); a newer click wins over a slower answer.
  const focusId = intent?.requestId ?? null;
  const focusNonce = intent?.nonce ?? null;
  function openById(id) {
    const requestId = (focusRequest.current += 1);
    stockApi
      .getTransferRequest(id)
      .then((row) => {
        if (requestId !== focusRequest.current) return;
        setFocused(row);
        setRevealTick((tick) => tick + 1);
        setSelectedId(row.id);
        setIssueNote('');
        setIssueQuantities(Object.fromEntries(row.lines.map((line) => [String(line.stockItemId), defaultIssueQuantity(line)])));
      })
      .catch(() => {
        if (requestId === focusRequest.current) setError(`Request #${id} could not be found.`);
      });
  }

  useEffect(() => {
    if (focusId) openById(focusId); // a new click (nonce) re-runs this
  }, [focusId, focusNonce]);

  useEffect(() => {
    if (!revealTick || !detailRef.current) return;
    detailRef.current.scrollIntoView?.({ block: 'start' });
    detailRef.current.focus?.({ preventScroll: true });
  }, [revealTick]);

  /** "Request the rest": the form, between the same two outlets, starting from what was not sent. */
  function startTopUp(request) {
    const missing = shortfallOf(request).filter((line) => !line.archived);
    setError(null);
    setNotice(null);
    setTopUpOf(request);
    setFromOutletId(String(request.fromOutlet.id));
    setToOutletId(String(request.toOutlet.id));
    loadSourceItems(String(request.fromOutlet.id));
    setLines(missing.length ? missing.map((line) => ({ key: (lineKeySeed += 1), stockItemId: String(line.stockItemId), quantity: line.missing })) : [blankLine()]);
    setNote(`Top-up of #${request.id}`);
    formRef.current?.scrollIntoView?.({ block: 'start' });
  }

  function stopTopUp() {
    setTopUpOf(null);
    setLines([blankLine()]);
    setNote('');
  }

  function chooseFrom(outletId) {
    setFromOutletId(outletId);
    if (outletId === toOutletId && !deliverToOutletId) setToOutletId('');
    setLines([blankLine()]);
    loadSourceItems(outletId);
  }

  function updateLine(key, changes) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...changes } : line)));
  }

  const chosenIds = new Set(lines.map((line) => line.stockItemId).filter(Boolean));
  const itemById = new Map((sourceItems ?? []).map((item) => [String(item.id), item]));
  const linesValid = lines.length > 0 && lines.every((line) => line.stockItemId && isPositiveQuantity(line.quantity));
  const canSubmit = !isOffline && !submitting && fromOutletId && toOutletId && fromOutletId !== toOutletId && linesValid;

  async function handleRaise(event) {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      const created = await stockApi.createTransferRequest({
        fromOutletId,
        toOutletId,
        lines: lines.map((line) => ({ stockItemId: line.stockItemId, quantity: line.quantity.trim() })),
        note: note.trim(),
        topUpOfRequestId: topUpOf?.id,
      });
      setNotice(topUpOf ? `Top-up #${created.id} of request #${topUpOf.id} sent to ${created.fromOutlet.name}.` : `Request #${created.id} sent to ${created.fromOutlet.name}.`);
      setTopUpOf(null);
      setLines([blankLine()]);
      setNote('');
      // The request it tops up now shows "Topped up by": drop a notification's stale copy of it.
      setFocused(null);
      await loadRequests();
    } catch (caught) {
      setError(messageOf(caught, 'Could not send this request.'));
    } finally {
      setSubmitting(false);
    }
  }

  function openRequest(row) {
    setRevealTick((tick) => tick + 1);
    setSelectedId(row.id);
    setIssueNote('');
    setIssueQuantities(Object.fromEntries(row.lines.map((line) => [String(line.stockItemId), defaultIssueQuantity(line)])));
  }

  const issueEntries = selected ? selected.lines.map((line) => [line, (issueQuantities[String(line.stockItemId)] ?? '').trim()]) : [];
  const issueProblems = issueEntries
    .filter(([line, quantity]) => !QUANTITY_PATTERN.test(quantity) || compareQuantity(quantity, line.quantityRequested) > 0 || compareQuantity(quantity, line.availableAtSource ?? '0') > 0)
    .map(([line]) => String(line.stockItemId));
  const sendsSomething = issueEntries.some(([, quantity]) => QUANTITY_PATTERN.test(quantity) && compareQuantity(quantity, '0') > 0);
  const canSendIssue = !isOffline && !acting && issueProblems.length === 0 && sendsSomething;

  async function act(action, successMessage) {
    setError(null);
    setNotice(null);
    setActing(true);
    // A decision changes the request: from here on it is shown from the refreshed list, never the copy a notification fetched.
    setFocused(null);
    try {
      const updated = await action();
      setNotice(successMessage(updated));
      setDialog(null);
      await loadRequests();
    } catch (caught) {
      setError(messageOf(caught, 'Could not update this request.'));
      setDialog(null);
      await loadRequests();
    } finally {
      setActing(false);
    }
  }

  const handleIssue = () =>
    act(
      () => stockApi.issueTransferRequest(selected.id, { lines: issueEntries.map(([line, quantity]) => ({ stockItemId: line.stockItemId, quantity })), note: issueNote.trim() }),
      (updated) => `Request #${updated.id} issued — the stock is now at ${updated.toOutlet.name}.`,
    );
  const handleReject = (reason) => act(() => stockApi.rejectTransferRequest(selected.id, { reason }), (updated) => `Request #${updated.id} rejected.`);
  const handleCancel = () => act(() => stockApi.cancelTransferRequest(selected.id), (updated) => `Request #${updated.id} withdrawn.`);

  const outletLabel = (outlet) => (isStoreOutlet(outlet) ? `${outlet.name} (store)` : outlet.name);
  const pending = selected?.status === 'pending';
  const selectedShortfall = selected?.status === 'issued' ? shortfallOf(selected) : [];
  const selectedLiveTopUp = selected ? liveTopUpOf(selected) : null;

  return (
    <div className={formStyles.form}>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className={formStyles.hint}>
          {notice}
        </p>
      )}
      {isOffline && <p className={formStyles.disabledNotice}>You are offline. Requests cannot be sent or issued until connectivity returns.</p>}

      {/* The open request sits above the form and the list, so it is where the
          eye already is — and nothing that loads later (the list) can push it
          off screen, which is what hid the Issue button. */}
      {selected && (
        <section ref={detailRef} tabIndex={-1} className={formStyles.scrollTarget} aria-label={`Request #${selected.id}`}>
          <Card title={`Request #${selected.id} — ${selected.fromOutlet.name} → ${selected.toOutlet.name}`}>
            <p className={formStyles.hint}>
              <StatusPill tone={STATUS[selected.status].tone} label={STATUS[selected.status].label} /> Requested by {selected.requestedBy.name ?? 'a staff member'},{' '}
              {formatWhen(selected.requestedAt)}
              {selected.note ? ` — “${selected.note}”` : ''}
            </p>
            {selected.decidedBy && (
              <p className={formStyles.hint}>
                {STATUS[selected.status].label} by {selected.decidedBy.name ?? 'a staff member'}, {formatWhen(selected.decidedAt)}
                {selected.decisionNote ? ` — “${selected.decisionNote}”` : ''}
              </p>
            )}
            {selected.topUpOfRequestId && (
              <div className={formStyles.actionsRow}>
                <span className={formStyles.hint}>Top-up of request #{selected.topUpOfRequestId}.</span>
                <Button type="button" size="compact" variant="ghost" onClick={() => openById(selected.topUpOfRequestId)}>
                  View #{selected.topUpOfRequestId}
                </Button>
              </div>
            )}
            {selected.topUps?.length > 0 && (
              <div className={formStyles.actionsRow}>
                <span className={formStyles.hint}>
                  Topped up by {selected.topUps.map((topUp) => `#${topUp.id} (${STATUS[topUp.status].label.toLowerCase()})`).join(', ')}.
                </span>
                {selected.topUps.map((topUp) => (
                  <Button key={topUp.id} type="button" size="compact" variant="ghost" onClick={() => openById(topUp.id)}>
                    View #{topUp.id}
                  </Button>
                ))}
              </div>
            )}

            <DataTable
              title="Items"
              columns={[
                { key: 'name', label: 'Stock item', render: (line) => (line.archived ? `${line.name} (archived)` : line.name) },
                { key: 'requested', label: 'Requested', align: 'right', render: (line) => formatQuantity(line.quantityRequested, line.unit) },
                ...(pending
                  ? [
                      { key: 'available', label: `At ${selected.fromOutlet.name}`, align: 'right', render: (line) => formatQuantity(line.availableAtSource, line.unit) },
                      ...(canIssue
                        ? [
                            {
                              key: 'send',
                              label: 'Send',
                              align: 'right',
                              render: (line) => {
                                const key = String(line.stockItemId);
                                return (
                                  <input
                                    className={formStyles.input}
                                    inputMode="decimal"
                                    aria-label={`Send ${line.name}`}
                                    value={issueQuantities[key] ?? ''}
                                    onChange={(event) => setIssueQuantities((current) => ({ ...current, [key]: event.target.value }))}
                                    aria-invalid={issueProblems.includes(key) || undefined}
                                    disabled={isOffline || acting}
                                  />
                                );
                              },
                            },
                          ]
                        : []),
                    ]
                  : [{ key: 'issued', label: 'Sent', align: 'right', render: (line) => (line.quantityIssued == null ? '—' : formatQuantity(line.quantityIssued, line.unit)) }]),
              ]}
              rows={selected.lines}
              rowKey={(line) => line.stockItemId}
              state="success"
            />

            {pending && canIssue && (
              <div className={formStyles.form}>
                {issueProblems.length > 0 && (
                  <p role="alert" className={formStyles.errorBanner}>
                    Each amount to send must be 0 or more, no more than was requested, and no more than {selected.fromOutlet.name} holds.
                  </p>
                )}
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Issue note (optional)</span>
                  <input className={formStyles.input} value={issueNote} onChange={(event) => setIssueNote(event.target.value)} maxLength={255} disabled={isOffline || acting} />
                </label>
                <div className={formStyles.actionsRow}>
                  <Button type="button" loading={acting} disabled={!canSendIssue} onClick={handleIssue}>
                    Issue stock
                  </Button>
                  <Button type="button" variant="danger" disabled={isOffline || acting} onClick={() => setDialog('reject')}>
                    Reject request
                  </Button>
                </div>
                <p className={formStyles.hint}>Set an item to 0 to send none of it. The stock moves as soon as you issue.</p>
              </div>
            )}
            {selectedShortfall.length > 0 && (
              <div className={formStyles.form}>
                <p className={formStyles.hint}>
                  Sent short: {selectedShortfall.map((line) => `${line.name} ${formatQuantity(line.missing, line.unit)} missing`).join(', ')}.
                </p>
                {canRequest && !selectedLiveTopUp && (
                  <div className={formStyles.actionsRow}>
                    <Button type="button" variant="secondary" disabled={isOffline || submitting} onClick={() => startTopUp(selected)}>
                      Request the rest
                    </Button>
                  </div>
                )}
              </div>
            )}
            {pending && canRequest && !canIssue && (
              <div className={formStyles.actionsRow}>
                <Button type="button" variant="secondary" disabled={isOffline || acting} onClick={() => setDialog('cancel')}>
                  Withdraw request
                </Button>
              </div>
            )}
          </Card>
        </section>
      )}

      {canRequest && (
        <section ref={formRef} className={formStyles.scrollTarget} aria-label="Request stock">
          <Card title={topUpOf ? `Request the rest of #${topUpOf.id}` : 'Request stock'}>
            {topUpOf ? (
              <div className={formStyles.actionsRow}>
                <p className={formStyles.hint}>
                  This asks {topUpOf.fromOutlet.name} again for what request #{topUpOf.id} did not send. Lower an amount, remove an item or add others before you send it.
                </p>
                <Button type="button" variant="ghost" size="compact" onClick={stopTopUp} disabled={submitting}>
                  Not a top-up
                </Button>
              </div>
            ) : (
              <p className={formStyles.hint}>
                Ask the store (or another outlet) for stock. The storekeeper issues it — all of it, part of it, or none with a reason — and it arrives the moment it is issued.
              </p>
            )}
            <form className={formStyles.form} onSubmit={handleRaise}>
              <div className={formStyles.row}>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Request from</span>
                  <select className={formStyles.select} value={fromOutletId} onChange={(event) => chooseFrom(event.target.value)} required disabled={isOffline || Boolean(topUpOf)}>
                    <option value="" disabled>
                      Select an outlet
                    </option>
                    {(outlets ?? []).map((outlet) => (
                      <option key={outlet.id} value={outlet.id}>
                        {outletLabel(outlet)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Deliver to</span>
                  <select className={formStyles.select} value={toOutletId} onChange={(event) => setToOutletId(event.target.value)} required disabled={isOffline || Boolean(topUpOf) || Boolean(deliverToOutletId)}>
                    <option value="" disabled>
                      Select your outlet
                    </option>
                    {(outlets ?? []).filter((outlet) => !myOutletIds || myOutletIds.includes(String(outlet.id))).map((outlet) => (
                      <option key={outlet.id} value={outlet.id} disabled={String(outlet.id) === String(fromOutletId)}>
                        {outletLabel(outlet)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {lines.map((line, index) => {
                const item = itemById.get(String(line.stockItemId));
                const badQuantity = line.quantity.trim() !== '' && !isPositiveQuantity(line.quantity);
                return (
                  <div className={formStyles.row} key={line.key}>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Item {index + 1}</span>
                      <select
                        className={formStyles.select}
                        value={line.stockItemId}
                        onChange={(event) => updateLine(line.key, { stockItemId: event.target.value })}
                        required
                        disabled={isOffline || !fromOutletId}
                      >
                        <option value="" disabled>
                          {fromOutletId ? 'Select a stock item' : 'Choose where to request from first'}
                        </option>
                        <StockItemOptions items={(sourceItems ?? []).filter((candidate) => String(candidate.id) === String(line.stockItemId) || !chosenIds.has(String(candidate.id)))} />
                      </select>
                      {item && <span className={formStyles.hint}>{formatQuantity(item.current_quantity, item.unit)} at the store now</span>}
                    </label>
                    <label className={formStyles.field}>
                      <span className={formStyles.label}>Quantity {index + 1}</span>
                      <input
                        className={formStyles.input}
                        inputMode="decimal"
                        value={line.quantity}
                        onChange={(event) => updateLine(line.key, { quantity: event.target.value })}
                        required
                        disabled={isOffline}
                        aria-invalid={badQuantity || undefined}
                      />
                      {badQuantity && <span className={formStyles.hint}>More than zero, at most 3 decimal places.</span>}
                    </label>
                    {lines.length > 1 && (
                      <div className={formStyles.actionsRow}>
                        <Button type="button" variant="ghost" size="compact" onClick={() => setLines((current) => current.filter((other) => other.key !== line.key))} disabled={isOffline}>
                          Remove item {index + 1}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
              {fromOutletId && sourceItems?.length === 0 && <p className={formStyles.hint}>This outlet carries no stock items yet.</p>}

              <div className={formStyles.actionsRow}>
                <Button type="button" variant="secondary" onClick={() => setLines((current) => [...current, blankLine()])} disabled={isOffline || !fromOutletId}>
                  Add another item
                </Button>
              </div>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Note (optional)</span>
                <input className={formStyles.input} value={note} onChange={(event) => setNote(event.target.value)} maxLength={255} disabled={isOffline} />
              </label>
              <div className={formStyles.actionsRow}>
                <Button type="submit" loading={submitting} disabled={!canSubmit}>
                  {topUpOf ? 'Send top-up' : 'Send request'}
                </Button>
              </div>
            </form>
          </Card>
        </section>
      )}

      {/* Outside the table: a DataTable renders its toolbar only when it has rows, and "no pending requests" is the normal state. */}
      <div className={formStyles.row}>
        <label className={formStyles.field}>
          <span className={formStyles.label}>Show</span>
          <select className={formStyles.select} value={filter} onChange={(event) => setFilter(event.target.value)}>
            {FILTERS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <DataTable
        title="Stock requests"
        columns={[
          { key: 'id', label: 'Request', render: (row) => (row.topUpOfRequestId ? `#${row.id} (top-up of #${row.topUpOfRequestId})` : `#${row.id}`) },
          { key: 'route', label: 'From → To', render: (row) => `${row.fromOutlet.name} → ${row.toOutlet.name}` },
          { key: 'items', label: 'Items', render: (row) => row.lines.map((line) => `${line.name} ${formatQuantity(line.quantityRequested, line.unit)}`).join(', ') },
          { key: 'requestedBy', label: 'Requested by', render: (row) => row.requestedBy.name ?? '—' },
          { key: 'requestedAt', label: 'Requested', render: (row) => formatWhen(row.requestedAt) },
          { key: 'status', label: 'Status', render: (row) => <StatusPill tone={STATUS[row.status].tone} label={STATUS[row.status].label} /> },
        ]}
        rows={(requests ?? []).filter((row) => !deliverToOutletId || String(row.toOutlet.id) === String(deliverToOutletId))}
        rowKey={(row) => row.id}
        state={requests === null ? 'loading' : requests.length === 0 ? 'empty' : 'success'}
        emptyMessage={filter === 'pending' ? 'No pending requests.' : 'No stock requests yet.'}
        actions={(row) => (
          <Button size="compact" variant="ghost" onClick={() => openRequest(row)}>
            {row.status === 'pending' && canIssue ? `Review #${row.id}` : `View #${row.id}`}
          </Button>
        )}
      />

      {dialog === 'reject' && selected && (
        <ConfirmDialog
          title={`Reject request #${selected.id}?`}
          consequence={`Nothing is sent. ${selected.toOutlet.name} is told the reason you give.`}
          requireReason
          confirmLabel="Reject request"
          onConfirm={handleReject}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === 'cancel' && selected && (
        <ConfirmDialog
          title={`Withdraw request #${selected.id}?`}
          consequence="The store will no longer see it. Raise a new request if you still need stock."
          confirmLabel="Withdraw request"
          onConfirm={handleCancel}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  );
}
