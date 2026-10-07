'use strict';

/**
 * Business summary — one view of what the whole business took over a date range: rooms, then each
 * bar/restaurant outlet, then the mini-mart, then a grand total.
 *
 * REVENUE BASIS (stated on the report, `basis: 'gross_collected'`): money actually TAKEN, gross —
 * what an owner ticks against the drawer and the bank. It is built from the payment reconciliation
 * report's own lines (`buildReconciliation`), never re-derived, so the grand total for a currency is
 * that report's `summary[].grossTotal` to the kobo. `reconciliation.matches` says so on every response
 * and `tests/reporting/business-summary.test.js` fails if the two ever drift.
 *
 * What a source's "collected" contains, as in reconciliation: room folio payments less folio refunds;
 * for an outlet or the mini-mart, standing (non-voided) settlements at subtotal + tax + service charge +
 * tip, plus captured card payments with no settlement, plus refund lines. A POS tab CHARGED TO A ROOM
 * takes no money at the outlet; the guest pays on the folio, where it is counted once. It is therefore
 * a MEMO per outlet (`chargedToRooms`) and never in a total. For an outlet the POS Sales report's total
 * for the same dates = collected - breakdown.other + chargedToRooms (`other` being refund and unsettled-capture
 * lines, which have no sale behind them), so the two reports are bridged, not contradictory.
 *
 * Tax/service/tip are exact for settlements (outlets, mini-mart). A room folio payment is not split into
 * room charge and tax in the data, so rooms are gross only. For an outlet,
 * `breakdown.other` is the part of collected that has no settlement breakdown (unsettled captures,
 * refund lines) so net + tax + service + tips + other always equals collected.
 *
 * `roomChargesBilled` is a separate memo on a BILLED basis (room charges, before tax) from the same source
 * as the Revenue report: Night Audit's snapshot for closed days, a live booked-rate estimate otherwise.
 * `estimate: true` (with the exact `unauditedDates`) marks it provisional. The collected figures have no
 * estimate in them.
 *
 * One table per currency, never summed across. The method columns are cash / card / transfer / nqr /
 * terminal. "Transfer" is a Paystack payment whose channel is bank_transfer (the codebase has no
 * separate transfer tender); NQR is kept apart from card.
 */

const { sumMoney, compareMoney } = require('../../shared/money');
const { isSupermarketOutlet, isPointOfSaleOutlet } = require('../../shared/outlet-types');
const { buildReconciliation } = require('../reconciliation/service');
const { computeRevenue, toCsv } = require('./service');

const METHODS = ['cash', 'card', 'transfer', 'nqr', 'terminal'];
const BASIS = 'gross_collected';
const BASIS_NOTE =
  'Gross money collected (tax, service charge and tips included). Ties to the Payment Reconciliation report. ' +
  'Tabs charged to a room are a memo, counted once when the folio is paid.';

function methodKeyFor(line) {
  if (line.method === 'card' && line.providerChannel === 'bank_transfer') return 'transfer';
  if (METHODS.includes(line.method)) return line.method;
  return 'other';
}

function emptyMethods() {
  return { cash: '0.00', card: '0.00', transfer: '0.00', nqr: '0.00', terminal: '0.00', other: '0.00' };
}

function addTo(methods, key, amount) {
  methods[key] = sumMoney([methods[key], amount]);
}

function newRow({ key, kind, label, outletId = null }) {
  return {
    key,
    kind,
    label,
    outletId,
    count: 0,
    byMethod: emptyMethods(),
    grossCollected: '0.00',
    // Outlets and the mini-mart only; rooms stay gross only (see header).
    breakdown: kind === 'rooms' ? null : { net: '0.00', tax: '0.00', service: '0.00', tips: '0.00', other: '0.00' },
    chargedToRooms: kind === 'rooms' ? null : '0.00',
  };
}

const KIND_ORDER = { rooms: 0, outlet: 1, supermarket: 2, unmatched: 3 };

async function computeBusinessSummary({ context, dateFrom, dateTo }) {
  const { report, outletByLine, settlementRowByLine, chargedToRoomRows, db } = await buildReconciliation({ context, dateFrom, dateTo });
  const baseCurrency = report.currency;

  const outlets = await db.table('pos_outlets').select('id', 'name', 'type', 'status');
  const outletById = new Map(outlets.map((outlet) => [String(outlet.id), outlet]));

  // currency -> rowKey -> row
  const tables = new Map();
  const tableFor = (currency) => {
    if (!tables.has(currency)) tables.set(currency, new Map());
    return tables.get(currency);
  };
  const rowFor = (currency, spec) => {
    const table = tableFor(currency);
    if (!table.has(spec.key)) table.set(spec.key, newRow(spec));
    return table.get(spec.key);
  };
  const outletSpec = (outlet) => ({ key: `outlet:${outlet.id}`, kind: isSupermarketOutlet(outlet) ? 'supermarket' : 'outlet', label: outlet.name, outletId: String(outlet.id) });

  if (baseCurrency) {
    rowFor(baseCurrency, { key: 'rooms', kind: 'rooms', label: 'Rooms' });
    // Every active selling outlet appears, a quiet one with zeros, so "nothing sold" is visible rather than missing.
    for (const outlet of outlets) if (isPointOfSaleOutlet(outlet) && outlet.status === 'active') rowFor(baseCurrency, outletSpec(outlet));
  }

  for (const line of report.lines) {
    let row;
    if (line.source.kind === 'room_folio') {
      row = rowFor(line.currency, { key: 'rooms', kind: 'rooms', label: 'Rooms' });
    } else {
      const outlet = outletById.get(String(outletByLine.get(line) ?? ''));
      row = outlet ? rowFor(line.currency, outletSpec(outlet)) : rowFor(line.currency, { key: 'unmatched', kind: 'unmatched', label: line.source.label ?? 'Unmatched POS payment' });
    }
    row.count += 1;
    addTo(row.byMethod, methodKeyFor(line), line.grossAmount);
    row.grossCollected = sumMoney([row.grossCollected, line.grossAmount]);

    if (row.breakdown) {
      const settlement = settlementRowByLine.get(line);
      if (settlement) {
        row.breakdown.net = sumMoney([row.breakdown.net, settlement.subtotal]);
        row.breakdown.tax = sumMoney([row.breakdown.tax, settlement.tax_amount]);
        row.breakdown.service = sumMoney([row.breakdown.service, settlement.service_charge]);
        row.breakdown.tips = sumMoney([row.breakdown.tips, settlement.tip_amount]);
      } else {
        row.breakdown.other = sumMoney([row.breakdown.other, line.grossAmount]);
      }
    }
  }

  for (const settlement of chargedToRoomRows) {
    const outlet = outletById.get(String(settlement.outlet_id ?? ''));
    if (!outlet) continue;
    const row = rowFor(settlement.currency, outletSpec(outlet));
    row.chargedToRooms = sumMoney([row.chargedToRooms, settlement.subtotal, settlement.tax_amount, settlement.service_charge, settlement.tip_amount]);
  }

  const reconciliationByCurrency = new Map(report.summary.map((entry) => [entry.currency, entry.grossTotal]));
  const currencies = [...tables.entries()]
    .map(([currency, rowMap]) => {
      const rows = [...rowMap.values()].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.label.localeCompare(b.label));
      const byMethod = emptyMethods();
      for (const row of rows) for (const key of Object.keys(byMethod)) addTo(byMethod, key, row.byMethod[key]);
      const grossCollected = sumMoney(rows.map((row) => row.grossCollected));
      const reconciliationGross = reconciliationByCurrency.get(currency) ?? '0.00';
      return {
        currency,
        rows,
        total: { count: rows.reduce((n, row) => n + row.count, 0), byMethod, grossCollected },
        reconciliation: { grossTotal: reconciliationGross, matches: compareMoney(grossCollected, reconciliationGross) === 0 },
      };
    })
    .sort((a, b) => a.currency.localeCompare(b.currency));

  const revenueDays = await computeRevenue({ context, dateFrom, dateTo });
  const unauditedDates = revenueDays.filter((day) => !day.audited).map((day) => day.date);

  return {
    dateFrom,
    dateTo,
    basis: BASIS,
    basisNote: BASIS_NOTE,
    currency: baseCurrency,
    currencies,
    roomChargesBilled: {
      currency: baseCurrency,
      basis: 'billed_before_tax',
      amount: sumMoney(revenueDays.map((day) => day.roomRevenue)),
      estimate: unauditedDates.length > 0,
      unauditedDates,
    },
  };
}

const CSV_COLUMNS = ['currency', 'source', 'kind', ...METHODS, 'other', 'grossCollected', 'net', 'tax', 'service', 'tips', 'otherAdjustments', 'chargedToRooms'];

function toCsvRows(summary) {
  const out = [];
  for (const table of summary.currencies) {
    for (const row of table.rows) {
      out.push({
        currency: table.currency,
        source: row.label,
        kind: row.kind,
        ...row.byMethod,
        grossCollected: row.grossCollected,
        net: row.breakdown?.net ?? '',
        tax: row.breakdown?.tax ?? '',
        service: row.breakdown?.service ?? '',
        tips: row.breakdown?.tips ?? '',
        otherAdjustments: row.breakdown?.other ?? '',
        chargedToRooms: row.chargedToRooms ?? '',
      });
    }
    out.push({ currency: table.currency, source: 'TOTAL', kind: 'total', ...table.total.byMethod, grossCollected: table.total.grossCollected, net: '', tax: '', service: '', tips: '', otherAdjustments: '', chargedToRooms: '' });
  }
  return out;
}

module.exports = { computeBusinessSummary, toCsvRows, CSV_COLUMNS, toCsv, BASIS, METHODS };
