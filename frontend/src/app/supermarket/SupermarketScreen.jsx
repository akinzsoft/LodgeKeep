import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, Button, DataTable, ConfirmDialog, PrintDocument, PrintLetterhead } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { sumMoney, multiplyMoney } from '../../shared/money.js';
import { supermarketApi, ApiError } from '../../shared/api/index.js';
import { SupermarketReceipt } from './SupermarketReceipt.jsx';
import formStyles from '../pos/POSForm.module.css';
import styles from './Supermarket.module.css';

const MAX_QUANTITY = 999;

/**
 * SupermarketScreen — the supermarket quick-sale till (Stage 1): scan or type
 * a product, build the cart, take cash or a card-terminal payment, and get a
 * receipt. Sells through the existing POS (the server prices every line from
 * the menu and settles through `settleOrder`); this screen never computes tax.
 * The cart's "Items total" is the sum of shelf prices; the receipt shows the
 * tax and the total actually charged.
 *
 * Permissions are three: `supermarket.sales` sells, `supermarket.report` reads
 * the sales list and report (and cannot sell), `supermarket.manage` voids.
 * The server is the real check; this only stops offering what would 403.
 */
export function SupermarketScreen({ activeProperty, isOffline = false, permissions = new Set() }) {
  const canSell = permissions.has('supermarket.sales');
  const canReport = permissions.has('supermarket.report');
  const canVoid = permissions.has('supermarket.manage');

  const [outlets, setOutlets] = useState(null);
  const [outletId, setOutletId] = useState('');
  const [outletsError, setOutletsError] = useState(null);

  const [scan, setScan] = useState('');
  const [results, setResults] = useState([]);
  const [cart, setCart] = useState([]);
  const [lookupError, setLookupError] = useState(null);
  const [method, setMethod] = useState('cash');
  const [submitting, setSubmitting] = useState(false);
  const [saleError, setSaleError] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [printing, setPrinting] = useState(false);

  const [sales, setSales] = useState(null);
  const [salesError, setSalesError] = useState(null);
  const [voidTarget, setVoidTarget] = useState(null);

  const [lowStock, setLowStock] = useState(null);
  const [mySales, setMySales] = useState([]);
  const [mySalesError, setMySalesError] = useState(null);
  const [isReprint, setIsReprint] = useState(false);
  const [flags, setFlags] = useState(null);
  const [flagsError, setFlagsError] = useState(null);
  const [barcodeDrafts, setBarcodeDrafts] = useState({});

  // One Idempotency-Key per sale attempt: a retry of the same cart reuses it, a changed cart gets a new one.
  const attemptKey = useRef(null);
  const scanInput = useRef(null);

  useEffect(() => {
    let cancelled = false;
    supermarketApi
      .listMyOutlets()
      .then((rows) => {
        if (cancelled) return;
        setOutlets(rows);
        if (rows.length === 1) setOutletId(String(rows[0].id));
      })
      .catch((caught) => {
        if (cancelled) return;
        setOutlets([]);
        setOutletsError(caught instanceof ApiError ? caught.message : 'Could not load your supermarket outlets.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!printing) return;
    window.print();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the print dialog has closed; unmount the printable copy
    setPrinting(false);
  }, [printing]);

  const loadSales = useCallback(async () => {
    if (!canReport || !outletId) return;
    try {
      setSales(await supermarketApi.listSales({ outletId }));
      setSalesError(null);
    } catch (caught) {
      setSales([]);
      setSalesError(caught instanceof ApiError ? caught.message : 'Could not load sales.');
    }
  }, [canReport, outletId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on outlet change
    loadSales();
  }, [loadSales]);

  // Stage 2: the till's low-stock banner. A failed load shows nothing and never blocks selling.
  const loadLowStock = useCallback(async () => {
    if (!outletId || !(canSell || canReport || canVoid)) return;
    try {
      setLowStock(await supermarketApi.getLowStock(outletId));
    } catch {
      setLowStock(null);
    }
  }, [outletId, canSell, canReport, canVoid]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on outlet change
    loadLowStock();
  }, [loadLowStock]);

  // A cashier's own sales today, for reprinting.
  const loadMySales = useCallback(async () => {
    if (!canSell || !outletId) return;
    try {
      setMySales(await supermarketApi.listMySales(outletId));
      setMySalesError(null);
    } catch (caught) {
      setMySales([]);
      setMySalesError(caught instanceof ApiError ? caught.message : 'Could not load your sales.');
    }
  }, [canSell, outletId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on outlet change
    loadMySales();
  }, [loadMySales]);

  // Products needing setup (managers only).
  const loadFlags = useCallback(async () => {
    if (!canVoid || !outletId) return;
    try {
      setFlags(await supermarketApi.getSetupFlags(outletId));
      setFlagsError(null);
    } catch (caught) {
      setFlags(null);
      setFlagsError(caught instanceof ApiError ? caught.message : 'Could not load product setup.');
    }
  }, [canVoid, outletId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on outlet change
    loadFlags();
  }, [loadFlags]);

  async function handleAddBarcode(event, item) {
    event.preventDefault();
    const code = (barcodeDrafts[item.id] ?? '').trim();
    if (!code) return;
    try {
      await supermarketApi.addBarcode(item.id, code);
      setBarcodeDrafts((current) => ({ ...current, [item.id]: '' }));
      setFlagsError(null);
      await loadFlags();
    } catch (caught) {
      setFlagsError(caught instanceof ApiError ? caught.message : 'Could not add that barcode.');
    }
  }

  function addToCart(item, barcode = null) {
    attemptKey.current = null;
    setCart((current) => {
      const index = current.findIndex((line) => String(line.menuItem.id) === String(item.id));
      if (index === -1) return [...current, { menuItem: item, barcode, quantity: 1 }];
      return current.map((line, i) => (i === index ? { ...line, quantity: Math.min(line.quantity + 1, MAX_QUANTITY) } : line));
    });
  }

  function changeQuantity(index, delta) {
    attemptKey.current = null;
    setCart((current) => current.flatMap((line, i) => {
      if (i !== index) return [line];
      const quantity = Math.min(line.quantity + delta, MAX_QUANTITY);
      return quantity < 1 ? [] : [{ ...line, quantity }];
    }));
  }

  async function handleScan(event) {
    event.preventDefault();
    const value = scan.trim();
    if (!value || !outletId) return;
    setLookupError(null);
    setResults([]);
    try {
      // A scanner types digits/letters with no spaces and presses Enter: try it as a barcode first.
      if (!/\s/.test(value)) {
        try {
          addToCart(await supermarketApi.lookupBarcode(outletId, value), value);
          setScan('');
          return;
        } catch (caught) {
          if (!(caught instanceof ApiError) || caught.status !== 404) throw caught;
        }
      }
      const found = await supermarketApi.searchItems(outletId, value);
      if (found.length === 0) setLookupError(`No product matches "${value}".`);
      setResults(found);
    } catch (caught) {
      setLookupError(caught instanceof ApiError ? caught.message : 'Could not look that up.');
    } finally {
      scanInput.current?.focus();
    }
  }

  async function handleComplete() {
    if (cart.length === 0 || submitting) return;
    setSubmitting(true);
    setSaleError(null);
    attemptKey.current ??= crypto.randomUUID();
    try {
      const sale = await supermarketApi.createSale({
        outletId,
        method,
        idempotencyKey: attemptKey.current,
        items: cart.map((line) => ({ menu_item_id: line.menuItem.id, quantity: line.quantity })),
      });
      setIsReprint(false);
      setReceipt(sale);
      setCart([]);
      setScan('');
      setResults([]);
      attemptKey.current = null;
      loadSales();
      loadLowStock();
      loadMySales();
    } catch (caught) {
      setSaleError(caught instanceof ApiError ? caught.message : 'The sale could not be completed.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVoid(reason) {
    const target = voidTarget;
    setVoidTarget(null);
    try {
      const voided = await supermarketApi.voidSale(target.id, reason);
      if (receipt && String(receipt.id) === String(voided.id)) setReceipt(voided);
      await loadSales();
      loadLowStock();
      loadMySales();
    } catch (caught) {
      setSalesError(caught instanceof ApiError ? caught.message : 'Could not void that sale.');
    }
  }

  async function showReceipt(row) {
    try {
      setIsReprint(true);
      setReceipt(await supermarketApi.getSale(row.id));
    } catch (caught) {
      setSalesError(caught instanceof ApiError ? caught.message : 'Could not open that receipt.');
    }
  }

  const currency = activeProperty?.base_currency;
  const itemsTotal = sumMoney(cart.map((line) => multiplyMoney(line.menuItem.price, line.quantity)));

  if (outlets === null) return <p>Loading…</p>;

  return (
    <div className={styles.layout}>
      <h1>Supermarket</h1>
      {outletsError && <p className={styles.errorBanner} role="alert">{outletsError}</p>}
      {outlets.length === 0 && !outletsError && <p>You are not assigned to a supermarket outlet. Ask a manager to assign you in Setup → Staff.</p>}

      {outlets.length > 0 && (
        <label className={formStyles.field}>
          <span className={formStyles.label}>Outlet</span>
          <select className={formStyles.select} value={outletId} onChange={(event) => { setOutletId(event.target.value); setCart([]); setResults([]); setReceipt(null); setLowStock(null); setFlags(null); }}>
            <option value="">Select an outlet</option>
            {outlets.map((outlet) => (
              <option key={outlet.id} value={outlet.id}>{outlet.name}</option>
            ))}
          </select>
        </label>
      )}

      {outletId && lowStock && lowStock.total > 0 && (
        <p className={styles.errorBanner} role="status">
          Low stock: {lowStock.items.slice(0, 5).map((item) => `${item.name} ${item.current_quantity} (reorder at ${item.reorder_level})`).join('; ')}
          {lowStock.total > 5 ? ` and ${lowStock.total - 5} more` : ''}.
        </p>
      )}

      {outletId && canSell && (
        <Card title="Sell">
          <form className={styles.scanRow} onSubmit={handleScan}>
            <label className={`${formStyles.field} ${styles.scanField}`}>
              <span className={formStyles.label}>Scan a barcode or type a product name</span>
              <input ref={scanInput} className={formStyles.input} value={scan} onChange={(event) => setScan(event.target.value)} autoFocus disabled={isOffline} />
            </label>
            <Button type="submit" disabled={isOffline || !scan.trim()}>Add</Button>
          </form>
          {lookupError && <p className={styles.errorBanner} role="alert">{lookupError}</p>}
          {results.length > 0 && (
            <ul className={styles.results} aria-label="Matching products">
              {results.map((item) => (
                <li key={item.id}>
                  <Button variant="secondary" className={styles.resultButton} onClick={() => { addToCart(item); setResults([]); setScan(''); scanInput.current?.focus(); }}>
                    {item.name} — <Money amount={item.price} currencyCode={currency} />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {cart.length === 0 ? (
            <p className={styles.hint}>Scan or search to start a sale.</p>
          ) : (
            <>
              <table className={styles.cartTable}>
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col" className={styles.num}>Price</th>
                    <th scope="col" className={styles.num}>Qty</th>
                    <th scope="col" className={styles.num}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {cart.map((line, index) => (
                    <tr key={line.menuItem.id}>
                      <td>{line.menuItem.name}</td>
                      <td className={styles.num}><Money amount={line.menuItem.price} currencyCode={currency} /></td>
                      <td className={styles.num}>
                        <span className={styles.qtyControls}>
                          <Button size="compact" variant="secondary" aria-label={`Fewer ${line.menuItem.name}`} onClick={() => changeQuantity(index, -1)}>−</Button>
                          {line.quantity}
                          <Button size="compact" variant="secondary" aria-label={`More ${line.menuItem.name}`} onClick={() => changeQuantity(index, 1)}>+</Button>
                        </span>
                      </td>
                      <td className={styles.num}><Money amount={multiplyMoney(line.menuItem.price, line.quantity)} currencyCode={currency} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className={styles.payRow}>
                <Button variant={method === 'cash' ? 'primary' : 'secondary'} aria-pressed={method === 'cash'} onClick={() => setMethod('cash')}>Cash</Button>
                <Button variant={method === 'terminal' ? 'primary' : 'secondary'} aria-pressed={method === 'terminal'} onClick={() => setMethod('terminal')}>Card (terminal)</Button>
                <span className={styles.itemsTotal}>Items total: <Money amount={itemsTotal} currencyCode={currency} /></span>
                <Button onClick={handleComplete} disabled={isOffline || submitting}>{submitting ? 'Completing…' : 'Complete sale'}</Button>
              </div>
              <p className={styles.hint}>Tax is added on the receipt according to the supermarket VAT setting.</p>
            </>
          )}
          {saleError && <p className={styles.errorBanner} role="alert">{saleError}</p>}
        </Card>
      )}

      {outletId && !canSell && canReport && <p className={styles.hint}>You can view sales here but not sell.</p>}

      {receipt && (
        <Card title={`Receipt ${receipt.receipt_code}${isReprint ? ' (reprint)' : ''}`}>
          <SupermarketReceipt sale={receipt} property={activeProperty} />
          <div className={styles.payRow}>
            <Button variant="secondary" onClick={() => setPrinting(true)}>Print receipt</Button>
            <Button variant="secondary" onClick={() => setReceipt(null)}>Close</Button>
          </div>
        </Card>
      )}
      {printing && receipt && (
        <PrintDocument>
          <PrintLetterhead logoUrl={activeProperty?.logo_url} organisation={activeProperty?.name} title={`Receipt ${receipt.receipt_code}`} details={isReprint ? [receipt.outlet_name, 'REPRINT — copy of an earlier receipt'] : [receipt.outlet_name]} />
          <SupermarketReceipt sale={receipt} property={activeProperty} />
        </PrintDocument>
      )}

      {outletId && canSell && (
        <Card title="Today's sales (reprint)">
          {mySalesError && <p className={styles.errorBanner} role="alert">{mySalesError}</p>}
          <DataTable
            state={mySales.length === 0 ? 'empty' : 'success'}
            emptyMessage="You have not made any sales today."
            columns={[
              { key: 'receipt', label: 'Receipt', render: (row) => `${row.receipt_code}${row.voided_at ? ' (void)' : ''}` },
              { key: 'time', label: 'Time', render: (row) => new Date(row.created_at).toLocaleTimeString() },
              { key: 'total', label: 'Total', align: 'right', render: (row) => <Money amount={row.total} currencyCode={row.currency} /> },
              { key: 'actions', label: '', render: (row) => <Button size="compact" variant="secondary" onClick={() => showReceipt(row)}>Reprint</Button> },
            ]}
            rows={mySales}
            rowKey={(row) => row.id}
          />
        </Card>
      )}

      {outletId && canVoid && (
        <Card title="Products needing setup">
          {flagsError && <p className={styles.errorBanner} role="alert">{flagsError}</p>}
          {flags && flags.items.length === 0 && <p className={styles.hint}>Every product has a barcode and is stock-tracked.</p>}
          {flags && flags.items.length > 0 && (
            <>
              <p className={styles.hint}>{flags.counts.missing_barcode} without a barcode, {flags.counts.not_stock_tracked} not stock-tracked (sales do not reduce stock). These can still be sold.</p>
              <ul className={styles.results} aria-label="Products needing setup">
                {flags.items.map((item) => (
                  <li key={item.id}>
                    <strong>{item.name}</strong>
                    {item.missing_barcode && <span> · No barcode</span>}
                    {item.not_stock_tracked && <span> · Not stock-tracked</span>}
                    {item.missing_barcode && (
                      <form className={styles.scanRow} onSubmit={(event) => handleAddBarcode(event, item)}>
                        <input
                          className={formStyles.input}
                          aria-label={`Barcode for ${item.name}`}
                          value={barcodeDrafts[item.id] ?? ''}
                          onChange={(event) => setBarcodeDrafts((current) => ({ ...current, [item.id]: event.target.value }))}
                          disabled={isOffline}
                        />
                        <Button type="submit" size="compact" variant="secondary" disabled={isOffline || !(barcodeDrafts[item.id] ?? '').trim()}>Add barcode</Button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      )}

      {outletId && canReport && (
        <Card title="Recent sales">
          {salesError && <p className={styles.errorBanner} role="alert">{salesError}</p>}
          <DataTable
            state={sales === null ? 'loading' : sales.length === 0 ? 'empty' : 'success'}
            emptyMessage="No sales yet."
            columns={[
              { key: 'receipt', label: 'Receipt', render: (row) => `#${row.receipt_number}${row.voided_at ? ' (void)' : ''}` },
              { key: 'time', label: 'Time', render: (row) => new Date(row.created_at).toLocaleString() },
              { key: 'method', label: 'Paid by', render: (row) => (row.method === 'terminal' ? 'Card (terminal)' : 'Cash') },
              { key: 'total', label: 'Total', align: 'right', render: (row) => <Money amount={row.total} currencyCode={row.currency} /> },
              {
                key: 'actions',
                label: '',
                render: (row) => (
                  <>
                    <Button size="compact" variant="secondary" onClick={() => showReceipt(row)}>Receipt</Button>
                    {canVoid && !row.voided_at && (
                      <Button size="compact" variant="secondary" disabled={isOffline} onClick={() => setVoidTarget(row)}>Void</Button>
                    )}
                  </>
                ),
              },
            ]}
            rows={sales ?? []}
            rowKey={(row) => row.id}
          />
        </Card>
      )}

      {voidTarget && (
        <ConfirmDialog
          title={`Void receipt #${voidTarget.receipt_number}?`}
          consequence="The sale is cancelled and its stock is returned. The receipt number is kept and shows as void."
          requireReason
          confirmLabel="Void sale"
          onConfirm={handleVoid}
          onCancel={() => setVoidTarget(null)}
        />
      )}
    </div>
  );
}
