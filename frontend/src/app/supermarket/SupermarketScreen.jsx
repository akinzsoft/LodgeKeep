import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, Button, DataTable, ConfirmDialog, PrintDocument, PrintLetterhead } from '../../shared/components/index.js';
import { Money } from '../../shared/format/money.jsx';
import { sumMoney, multiplyMoney } from '../../shared/money.js';
import { supermarketApi, posApi, ApiError } from '../../shared/api/index.js';
import { SupermarketReceipt } from './SupermarketReceipt.jsx';
import { ProductTile } from './ProductTile.jsx';
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
 *
 * Layout (visual redesign): tabs Sell / Today's sales / All sales / Setup.
 * Sell is a tile grid of the outlet's whole menu (category pills, scan bar on
 * top) beside a "Current sale" panel; below 900px the panel stacks under the
 * grid and a fixed bar carries the total and "Review & pay". The full menu
 * comes from the POS menu endpoints (`pos.operate`); if that call fails the
 * till still sells by scan and name search, exactly as before.
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

  const [tab, setTab] = useState(null);
  const [menu, setMenu] = useState(null); // null loading, [] items, or 'unavailable'
  const [menuCategoryNames, setMenuCategoryNames] = useState([]);
  const [category, setCategory] = useState('All');

  // One Idempotency-Key per sale attempt: a retry of the same cart reuses it, a changed cart gets a new one.
  const attemptKey = useRef(null);
  const scanInput = useRef(null);
  const cartPanel = useRef(null);

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

  // The outlet's whole menu for the tiles. Failure is not an error: the till sells by scan/search.
  const loadMenu = useCallback(async () => {
    if (!canSell || !outletId) return;
    try {
      const [items, categories] = await Promise.all([posApi.listMenuItems(outletId), posApi.listMenuCategories({ outletId }).catch(() => [])]);
      setMenu(Array.isArray(items) ? items : 'unavailable');
      setMenuCategoryNames((Array.isArray(categories) ? categories : []).map((row) => row.name));
    } catch {
      setMenu('unavailable');
    }
  }, [canSell, outletId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on outlet change
    loadMenu();
  }, [loadMenu]);

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
      loadMenu();
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
  const itemCount = cart.reduce((sum, line) => sum + line.quantity, 0);
  const quantityById = new Map(cart.map((line) => [String(line.menuItem.id), line.quantity]));

  const menuItems = Array.isArray(menu) ? menu : [];
  // Registered categories plus any an item names, like the Register's rail; an empty one still shows (count 0).
  const categoryNames = [...new Set([...menuCategoryNames, ...menuItems.map((item) => item.category).filter(Boolean)])].sort((a, b) => a.localeCompare(b));
  const categoryTabs = [{ name: 'All', count: menuItems.length }, ...categoryNames.map((name) => ({ name, count: menuItems.filter((item) => item.category === name).length }))];
  const visibleItems = category === 'All' ? menuItems : menuItems.filter((item) => item.category === category);

  const tabs = [
    canSell && { key: 'sell', label: 'Sell' },
    canSell && { key: 'today', label: "Today's sales" },
    canReport && { key: 'sales', label: 'All sales' },
    canVoid && { key: 'setup', label: 'Setup' },
  ].filter(Boolean);
  const activeTab = tabs.some((entry) => entry.key === tab) ? tab : tabs[0]?.key;

  function pickFromResults(item) {
    addToCart(item);
    setResults([]);
    setScan('');
    scanInput.current?.focus();
  }

  if (outlets === null) return <p>Loading…</p>;

  return (
    <div className={styles.layout}>
      <div className={styles.header}>
        <h1 className={styles.title}>Supermarket</h1>
        {outlets.length > 0 && tabs.length > 0 && outletId && (
          <div className={styles.viewTabs} role="tablist" aria-label="Till views">
            {tabs.map((entry) => (
              <button
                key={entry.key}
                type="button"
                role="tab"
                id={`supermarket-tab-${entry.key}`}
                aria-selected={activeTab === entry.key}
                aria-controls={`supermarket-panel-${entry.key}`}
                className={`${styles.viewTab} ${activeTab === entry.key ? styles.viewTabActive : ''}`}
                onClick={() => setTab(entry.key)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        )}
        {outlets.length > 1 && (
          <label className={styles.outletPicker}>
            <span className={formStyles.label}>Outlet</span>
            <select className={formStyles.select} value={outletId} onChange={(event) => { setOutletId(event.target.value); setCart([]); setResults([]); setReceipt(null); setLowStock(null); setFlags(null); setMenu(null); setCategory('All'); }}>
              <option value="">Select an outlet</option>
              {outlets.map((outlet) => (
                <option key={outlet.id} value={outlet.id}>{outlet.name}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {outletsError && <p className={styles.errorBanner} role="alert">{outletsError}</p>}
      {outlets.length === 0 && !outletsError && <p>You are not assigned to a supermarket outlet. Ask a manager to assign you in Setup → Staff.</p>}

      {outletId && lowStock && lowStock.total > 0 && (
        <p className={styles.lowStockBanner} role="status">
          <strong>Low stock:</strong>{' '}
          {lowStock.items.slice(0, 5).map((item) => `${item.name} ${item.current_quantity} (reorder at ${item.reorder_level})`).join('; ')}
          {lowStock.total > 5 ? ` and ${lowStock.total - 5} more` : ''}.
        </p>
      )}

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

      {outletId && activeTab === 'sell' && (
        <section id="supermarket-panel-sell" role="tabpanel" aria-labelledby="supermarket-tab-sell" className={styles.sellPanel}>
          <div className={styles.catalogue}>
            <form className={styles.scanRow} onSubmit={handleScan}>
              <label className={styles.scanField}>
                <span className={styles.visuallyHidden}>Scan a barcode or type a product name</span>
                <svg className={styles.scanIcon} viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5v14M7 5v14M11 5v14M14 5v14M18 5v14M21 5v14" /></svg>
                <input ref={scanInput} className={styles.scanInput} placeholder="Scan a barcode or type a product name" value={scan} onChange={(event) => setScan(event.target.value)} autoFocus disabled={isOffline} />
              </label>
              <button type="submit" className={styles.scanButton} disabled={isOffline || !scan.trim()}>Add</button>
            </form>
            {lookupError && <p className={styles.errorBanner} role="alert">{lookupError}</p>}

            {results.length > 0 ? (
              <>
                <div className={styles.resultsHeader}>
                  <span>Matching products</span>
                  <button type="button" className={styles.linkButton} onClick={() => setResults([])}>Clear search</button>
                </div>
                <div className={styles.tileGrid} aria-label="Matching products" role="group">
                  {results.map((item) => (
                    <ProductTile key={item.id} item={item} currency={currency} quantityInCart={quantityById.get(String(item.id)) ?? 0} disabled={isOffline} onAdd={pickFromResults} />
                  ))}
                </div>
              </>
            ) : menu === 'unavailable' ? (
              <p className={styles.hint}>Product tiles could not be loaded. Scan a barcode or type a product name to add it.</p>
            ) : menu === null ? (
              <p className={styles.hint}>Loading products…</p>
            ) : (
              <>
                <div className={styles.categoryTabs} role="tablist" aria-label="Categories">
                  {categoryTabs.map((entry) => (
                    <button
                      key={entry.name}
                      type="button"
                      role="tab"
                      aria-selected={category === entry.name}
                      className={`${styles.categoryTab} ${category === entry.name ? styles.categoryTabActive : ''}`}
                      onClick={() => setCategory(entry.name)}
                    >
                      {entry.name} <span className={styles.categoryCount}>{entry.count}</span>
                    </button>
                  ))}
                </div>
                {visibleItems.length === 0 ? (
                  <p className={styles.hint}>{menuItems.length === 0 ? 'This outlet has no products yet. Add them in POS → Setup.' : 'No products in this category yet.'}</p>
                ) : (
                  <div className={styles.tileGrid} aria-label="Products" role="group">
                    {visibleItems.map((item) => (
                      <ProductTile key={item.id} item={item} currency={currency} quantityInCart={quantityById.get(String(item.id)) ?? 0} disabled={isOffline} onAdd={addToCart} />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <aside ref={cartPanel} className={styles.cartPanel} aria-label="Current sale">
            <div className={styles.cartHeader}>
              <div>
                <h2 className={styles.cartTitle}>Current sale</h2>
                <span className={styles.cartCount}>{itemCount === 1 ? '1 item' : `${itemCount} items`}</span>
              </div>
              {cart.length > 0 && (
                <button type="button" className={styles.linkButton} onClick={() => { attemptKey.current = null; setCart([]); }}>Clear</button>
              )}
            </div>
            <div className={styles.cartBody}>
              {cart.length === 0 ? (
                <p className={styles.cartEmpty}>Scan or search to start a sale.</p>
              ) : (
                <table className={styles.cartTable}>
                  <tbody>
                    {cart.map((line, index) => (
                      <tr key={line.menuItem.id}>
                        <td>
                          <span className={styles.lineName}>{line.menuItem.name}</span>
                          <span className={styles.lineUnit}><Money amount={line.menuItem.price} currencyCode={currency} /> each</span>
                          <span className={styles.qtyControls}>
                            <button type="button" className={styles.stepper} aria-label={`Fewer ${line.menuItem.name}`} onClick={() => changeQuantity(index, -1)}>−</button>
                            <span className={styles.qty}>{line.quantity}</span>
                            <button type="button" className={styles.stepper} aria-label={`More ${line.menuItem.name}`} onClick={() => changeQuantity(index, 1)}>+</button>
                          </span>
                        </td>
                        <td className={styles.lineTotal}><Money amount={multiplyMoney(line.menuItem.price, line.quantity)} currencyCode={currency} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {cart.length > 0 && (
              <div className={styles.cartFooter}>
                <div className={styles.totalRow}>
                  <span>Items total</span>
                  <span className={styles.totalAmount}><Money amount={itemsTotal} currencyCode={currency} /></span>
                </div>
                <p className={styles.taxNote}>Tax is added on the receipt according to the supermarket VAT setting.</p>
                <div className={styles.methods} role="group" aria-label="Payment method">
                  <button type="button" className={`${styles.method} ${method === 'cash' ? styles.methodActive : ''}`} aria-pressed={method === 'cash'} onClick={() => setMethod('cash')}>Cash</button>
                  <button type="button" className={`${styles.method} ${method === 'terminal' ? styles.methodActive : ''}`} aria-pressed={method === 'terminal'} onClick={() => setMethod('terminal')}>Card (terminal)</button>
                </div>
                <button type="button" className={styles.payButton} onClick={handleComplete} disabled={isOffline || submitting}>{submitting ? 'Completing…' : 'Complete sale'}</button>
                {saleError && <p className={styles.errorBanner} role="alert">{saleError}</p>}
              </div>
            )}
          </aside>

          {cart.length > 0 && (
            <>
              <div className={styles.orderBarSpacer} aria-hidden="true" />
              <div className={styles.orderBar}>
                <span className={styles.orderBarSummary}>
                  <span>{itemCount === 1 ? '1 item' : `${itemCount} items`}</span>
                  <Money amount={itemsTotal} currencyCode={currency} />
                </span>
                <button type="button" className={styles.orderBarButton} onClick={() => cartPanel.current?.scrollIntoView({ block: 'start' })}>Review &amp; pay</button>
              </div>
            </>
          )}
        </section>
      )}

      {outletId && activeTab === 'today' && (
        <section id="supermarket-panel-today" role="tabpanel" aria-labelledby="supermarket-tab-today">
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
        </section>
      )}

      {outletId && activeTab === 'sales' && (
        <section id="supermarket-panel-sales" role="tabpanel" aria-labelledby="supermarket-tab-sales">
          {!canSell && <p className={styles.hint}>You can view sales here but not sell.</p>}
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
        </section>
      )}

      {outletId && activeTab === 'setup' && (
        <section id="supermarket-panel-setup" role="tabpanel" aria-labelledby="supermarket-tab-setup">
          <Card title="Products needing setup">
            {flagsError && <p className={styles.errorBanner} role="alert">{flagsError}</p>}
            {flags && flags.items.length === 0 && <p className={styles.hint}>Every product has a barcode and is stock-tracked.</p>}
            {flags && flags.items.length > 0 && (
              <>
                <p className={styles.hint}>{flags.counts.missing_barcode} without a barcode, {flags.counts.not_stock_tracked} not stock-tracked (sales do not reduce stock). These can still be sold.</p>
                <ul className={styles.setupList} aria-label="Products needing setup">
                  {flags.items.map((item) => (
                    <li key={item.id} className={styles.setupRow}>
                      <span className={styles.setupName}>{item.name}</span>
                      <span className={styles.setupBadges}>
                        {item.missing_barcode && <span className={styles.badgeWarning}>No barcode</span>}
                        {item.not_stock_tracked && <span className={styles.badgeNeutral}>Not stock-tracked</span>}
                      </span>
                      {item.missing_barcode && (
                        <form className={styles.barcodeForm} onSubmit={(event) => handleAddBarcode(event, item)}>
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
        </section>
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
