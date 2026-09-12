import { useEffect, useState } from 'react';
import { Card, DataTable, Button, StatusPill } from '../../shared/components/index.js';
import { posApi, setupApi, ApiError } from '../../shared/api/index.js';
import formStyles from './POSForm.module.css';

/**
 * QrTokensTab — PLAN.md Phase 6's QR self-ordering configuration surface:
 * per-outlet QR codes (table or room) plus the outlet-level guest-ordering
 * toggle and policy (accept timeout / per-token order rate limit / max
 * unpaid value). Gated on `pos.manage` at the API layer only, not here —
 * the same "always reachable once the POS nav item itself is visible
 * (`pos.operate`), the real 403 is what a lower-tier account gets" reasoning
 * `SetupTab.jsx`'s own header already establishes for this identical shape.
 *
 * ── RE-DISPLAY, A REAL DEVIATION FROM THE ORIGINAL BRIEF ─────────────────
 *
 * The brief for this tab assumed `GET /pos/qr-tokens` returns a
 * `qrImageDataUrl` for re-printing an EXISTING token. Reading the real
 * backend (`qr-ordering/service.js`'s `listTokensForOutlet`) shows it
 * decrypts and returns the real `raw_token` VALUE for every row (the
 * "reversible re-display via encryption" the brief refers to), but only
 * `createToken`/`regenerateToken` ever call `renderTokenQrImage` to
 * produce an actual PNG — because a fresh raw value comes out of THOSE two
 * calls specifically, at the moment they mint one. No QR-code-rendering
 * library exists in this frontend (`qrcode`, the package the BACKEND uses
 * for this, is a Node-only dependency of that module, never added to this
 * app's own `package.json`), and adding one to render a second PNG for an
 * already-existing token client-side is a real new dependency this
 * frontend-only pass has no authorization to add speculatively. Given
 * that, an existing token's own "re-display" here is the real guest URL
 * itself (built from `raw_token`, the same `{baseUrl}/{token}/menu` shape
 * `tokens.js`'s own `renderTokenQrImage` uses) — copyable/printable as a
 * plain link — while the actual scannable `<img>` is shown, per the
 * brief's own instruction, right after a genuinely fresh create/regenerate
 * call, when the backend really does hand back a `qrImageDataUrl`.
 */
export function QrTokensTab() {
  const [outlets, setOutlets] = useState(null);
  const [outletError, setOutletError] = useState(null);
  const [selectedOutletId, setSelectedOutletId] = useState(null);
  const [rooms, setRooms] = useState(null);

  const [tokens, setTokens] = useState(null);
  const [tokenError, setTokenError] = useState(null);
  const [lastCreated, setLastCreated] = useState(null); // {tokenId, qrImageDataUrl}

  const [tokenForm, setTokenForm] = useState({ type: 'table', table_label: '', room_id: '' });
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const [policyForm, setPolicyForm] = useState({ accept_timeout_minutes: '', rate_limit_max: '', max_unpaid_value: '' });
  const [policySubmitting, setPolicySubmitting] = useState(false);
  const [policyError, setPolicyError] = useState(null);
  const [togglingOrdering, setTogglingOrdering] = useState(false);

  const baseUrl = `${window.location.origin}/qr-order`;

  useEffect(() => {
    posApi
      .listOutlets()
      .then(setOutlets)
      .catch((caught) => {
        setOutlets([]);
        setOutletError(caught instanceof ApiError ? caught.message : 'Could not load outlets.');
      });
    setupApi
      .listRooms()
      .then(setRooms)
      .catch(() => setRooms([]));
  }, []);

  const selectedOutlet = (outlets ?? []).find((outlet) => outlet.id === selectedOutletId);

  async function reloadTokens(outletId) {
    try {
      setTokens(await posApi.listQrTokens(outletId));
      setTokenError(null);
    } catch (caught) {
      setTokens([]);
      setTokenError(caught instanceof ApiError ? caught.message : 'Could not load QR codes for this outlet.');
    }
  }

  function handleSelectOutlet(outlet) {
    setSelectedOutletId(outlet.id);
    setTokens(null);
    setLastCreated(null);
    setPolicyForm({
      accept_timeout_minutes: String(outlet.guest_order_accept_timeout_minutes ?? ''),
      rate_limit_max: String(outlet.guest_order_rate_limit_max ?? ''),
      max_unpaid_value: outlet.guest_order_max_unpaid_value ?? '',
    });
    reloadTokens(outlet.id);
  }

  async function handleToggleGuestOrdering() {
    setTogglingOrdering(true);
    setPolicyError(null);
    try {
      const updated = await posApi.toggleGuestOrdering(selectedOutletId, !selectedOutlet.guest_ordering_enabled);
      setOutlets((prev) => prev.map((outlet) => (outlet.id === updated.id ? updated : outlet)));
    } catch (caught) {
      setPolicyError(caught instanceof ApiError ? caught.message : 'Could not update guest ordering.');
    } finally {
      setTogglingOrdering(false);
    }
  }

  async function handlePolicySubmit(event) {
    event.preventDefault();
    setPolicySubmitting(true);
    setPolicyError(null);
    try {
      const updated = await posApi.updateGuestOrderPolicy(selectedOutletId, {
        acceptTimeoutMinutes: Number(policyForm.accept_timeout_minutes),
        rateLimitMax: Number(policyForm.rate_limit_max),
        maxUnpaidValue: policyForm.max_unpaid_value || null,
      });
      setOutlets((prev) => prev.map((outlet) => (outlet.id === updated.id ? updated : outlet)));
    } catch (caught) {
      setPolicyError(caught instanceof ApiError ? caught.message : 'Could not save this policy.');
    } finally {
      setPolicySubmitting(false);
    }
  }

  async function handleCreateToken(event) {
    event.preventDefault();
    setCreating(true);
    setTokenError(null);
    try {
      const result = await posApi.createQrToken({
        outletId: selectedOutletId,
        type: tokenForm.type,
        tableLabel: tokenForm.type === 'table' ? tokenForm.table_label : undefined,
        roomId: tokenForm.type === 'room' ? tokenForm.room_id : undefined,
        baseUrl,
      });
      setLastCreated({ tokenId: result.token.id, qrImageDataUrl: result.qrImageDataUrl, rawToken: result.rawToken });
      setTokenForm({ type: 'table', table_label: '', room_id: '' });
      await reloadTokens(selectedOutletId);
    } catch (caught) {
      setTokenError(caught instanceof ApiError ? caught.message : 'Could not create this QR code.');
    } finally {
      setCreating(false);
    }
  }

  async function handleRegenerate(token) {
    setBusyId(token.id);
    setTokenError(null);
    try {
      const result = await posApi.regenerateQrToken(token.id, baseUrl);
      setLastCreated({ tokenId: result.token.id, qrImageDataUrl: result.qrImageDataUrl, rawToken: result.rawToken });
      await reloadTokens(selectedOutletId);
    } catch (caught) {
      setTokenError(caught instanceof ApiError ? caught.message : 'Could not regenerate this QR code.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDeactivate(token) {
    setBusyId(token.id);
    setTokenError(null);
    try {
      await posApi.deactivateQrToken(token.id);
      await reloadTokens(selectedOutletId);
    } catch (caught) {
      setTokenError(caught instanceof ApiError ? caught.message : 'Could not deactivate this QR code.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleReactivate(token) {
    setBusyId(token.id);
    setTokenError(null);
    try {
      await posApi.reactivateQrToken(token.id);
      await reloadTokens(selectedOutletId);
    } catch (caught) {
      setTokenError(caught instanceof ApiError ? caught.message : 'Could not reactivate this QR code.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className={formStyles.form}>
      {outletError && (
        <p role="alert" className={formStyles.errorBanner}>
          {outletError}
        </p>
      )}

      <DataTable
        title="Outlets"
        state={outlets === null ? 'loading' : outlets.length === 0 ? 'empty' : 'success'}
        emptyMessage="No outlets yet — add one on the Setup tab first."
        columns={[
          { key: 'name', label: 'Name' },
          {
            key: 'guest_ordering_enabled',
            label: 'Guest ordering',
            render: (row) => <StatusPill tone={row.guest_ordering_enabled ? 'success' : 'neutral'} label={row.guest_ordering_enabled ? 'Enabled' : 'Disabled'} />,
          },
        ]}
        rows={outlets ?? []}
        rowKey={(row) => row.id}
        actions={(row) => (
          <Button size="compact" variant="ghost" onClick={() => handleSelectOutlet(row)}>
            Manage
          </Button>
        )}
      />

      {selectedOutlet && (
        <>
          <Card title={`Guest-ordering policy — ${selectedOutlet.name}`}>
            {policyError && (
              <p role="alert" className={formStyles.errorBanner}>
                {policyError}
              </p>
            )}
            <div className={formStyles.actionsRow}>
              <Button type="button" variant={selectedOutlet.guest_ordering_enabled ? 'danger' : 'primary'} loading={togglingOrdering} onClick={handleToggleGuestOrdering}>
                {selectedOutlet.guest_ordering_enabled ? 'Disable guest ordering' : 'Enable guest ordering'}
              </Button>
            </div>
            <form className={formStyles.row} onSubmit={handlePolicySubmit}>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Accept timeout (minutes)</span>
                <input
                  className={formStyles.input}
                  type="number"
                  min="1"
                  value={policyForm.accept_timeout_minutes}
                  onChange={(event) => setPolicyForm({ ...policyForm, accept_timeout_minutes: event.target.value })}
                  required
                />
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Max orders per code (per hour)</span>
                <input
                  className={formStyles.input}
                  type="number"
                  min="1"
                  value={policyForm.rate_limit_max}
                  onChange={(event) => setPolicyForm({ ...policyForm, rate_limit_max: event.target.value })}
                  required
                />
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Max unpaid value (optional)</span>
                <input
                  className={formStyles.input}
                  type="number"
                  step="0.01"
                  min="0"
                  value={policyForm.max_unpaid_value ?? ''}
                  onChange={(event) => setPolicyForm({ ...policyForm, max_unpaid_value: event.target.value })}
                />
              </label>
              <div className={formStyles.actionsRow}>
                <Button type="submit" loading={policySubmitting}>
                  Save policy
                </Button>
              </div>
            </form>
          </Card>

          <Card title={`New QR code — ${selectedOutlet.name}`}>
            {lastCreated && (
              <div>
                <p className={formStyles.hint}>You can view/re-print this code again later from the table below (as its own working link).</p>
                <img className={formStyles.qrImage} src={lastCreated.qrImageDataUrl} alt="Scannable QR code for this table or room" />
              </div>
            )}
            <form className={formStyles.row} onSubmit={handleCreateToken}>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Type</span>
                <select className={formStyles.select} value={tokenForm.type} onChange={(event) => setTokenForm({ ...tokenForm, type: event.target.value })}>
                  <option value="table">Table</option>
                  <option value="room">Room</option>
                </select>
              </label>
              {tokenForm.type === 'table' ? (
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Table label</span>
                  <input
                    className={formStyles.input}
                    value={tokenForm.table_label}
                    onChange={(event) => setTokenForm({ ...tokenForm, table_label: event.target.value })}
                    required
                  />
                </label>
              ) : (
                <label className={formStyles.field}>
                  <span className={formStyles.label}>Room</span>
                  <select
                    className={formStyles.select}
                    value={tokenForm.room_id}
                    onChange={(event) => setTokenForm({ ...tokenForm, room_id: event.target.value })}
                    required
                  >
                    <option value="">Select a room…</option>
                    {(rooms ?? []).map((room) => (
                      <option key={room.id} value={room.id}>
                        {room.room_number}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className={formStyles.actionsRow}>
                <Button type="submit" loading={creating}>
                  Create QR code
                </Button>
              </div>
            </form>
          </Card>

          <DataTable
            title={`QR codes — ${selectedOutlet.name}`}
            state={tokens === null ? 'loading' : tokenError ? 'error' : tokens.length === 0 ? 'empty' : 'success'}
            errorMessage={tokenError}
            emptyMessage="No QR codes yet — create one above."
            columns={[
              { key: 'type', label: 'Type', render: (row) => (row.type === 'room' ? 'Room' : 'Table') },
              { key: 'table_label', label: 'Label', render: (row) => row.table_label ?? (rooms ?? []).find((r) => r.id === row.room_id)?.room_number ?? '—' },
              { key: 'active', label: 'Status', render: (row) => <StatusPill tone={row.active ? 'success' : 'neutral'} label={row.active ? 'Active' : 'Inactive'} /> },
              {
                key: 'link',
                label: 'Guest link',
                render: (row) =>
                  row.active ? (
                    <a className={formStyles.tokenLink} href={`${baseUrl}/${row.raw_token}/menu`} target="_blank" rel="noreferrer">
                      {`${baseUrl}/${row.raw_token}/menu`}
                    </a>
                  ) : (
                    '—'
                  ),
              },
            ]}
            rows={tokens ?? []}
            rowKey={(row) => row.id}
            actions={(row) => (
              <>
                <Button size="compact" variant="ghost" loading={busyId === row.id} onClick={() => handleRegenerate(row)}>
                  Regenerate
                </Button>
                {row.active ? (
                  <Button size="compact" variant="danger" loading={busyId === row.id} onClick={() => handleDeactivate(row)}>
                    Deactivate
                  </Button>
                ) : (
                  <Button size="compact" loading={busyId === row.id} onClick={() => handleReactivate(row)}>
                    Reactivate
                  </Button>
                )}
              </>
            )}
          />
        </>
      )}
    </div>
  );
}
