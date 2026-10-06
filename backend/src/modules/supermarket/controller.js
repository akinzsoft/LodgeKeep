'use strict';

const { ok, notFound } = require('../../shared/response');
const { runIdempotentMutation, requireIdempotencyKey } = require('../../shared/mutation');
const { scopedDb } = require('../../db');
const { ValidationError } = require('../../shared/errors');
const service = require('./service');
const productEdit = require('./product-edit');
const online = require('./paystack-sale');
const { approvalConsumer } = require('../approvals');

/** Whether a sale was paid online (its settlement carries a supermarket Paystack payment). */
async function isOnlineSale(context, saleId) {
  const db = scopedDb().for(context);
  const sale = await db.table('supermarket_sales').where({ id: saleId }).first('settlement_id');
  if (!sale) return false;
  const settlement = await db.table('pos_order_settlements').where({ id: sale.settlement_id }).first('payment_id');
  return Boolean(settlement?.payment_id);
}

async function listMyOutlets(req, res, next) {
  try {
    res.json(ok(await service.listMyOutlets({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

async function lookup(req, res, next) {
  try {
    if (!req.query.outlet_id) throw new ValidationError('MISSING_FIELD', '"outlet_id" is required.', [{ field: 'outlet_id', issue: 'missing' }]);
    if (req.query.barcode) {
      res.json(ok(await service.lookupByBarcode({ context: req.context, outletId: req.query.outlet_id, barcode: req.query.barcode })));
    } else {
      res.json(ok(await service.searchItems({ context: req.context, outletId: req.query.outlet_id, q: req.query.q })));
    }
  } catch (error) {
    next(error);
  }
}

async function createSale(req, res, next) {
  try {
    await runIdempotentMutation(req, res, {
      operationType: 'supermarket.sale',
      entityType: 'supermarket_sales',
      action: 'sale',
      handler: async (trx) => {
        const sale = await service.createSale({
          trx,
          context: req.context,
          userId: req.context.userId,
          outletId: req.body?.outlet_id,
          lines: req.body?.items,
          method: req.body?.method,
          terminalId: req.body?.terminal_id ?? null,
          terminal: { provider: req.body?.terminal_provider, reference: req.body?.terminal_reference },
          terminalAccountId: req.body?.terminal_account_id,
          confirmOversell: req.body?.confirm_oversell === true,
          approve: approvalConsumer(req, 'supermarket.oversell'),
        });
        return { status: 201, body: ok(sale) };
      },
    });
  } catch (error) {
    next(error);
  }
}

async function stockOnHand(req, res, next) {
  try {
    res.json(ok(await service.stockOnHand({ context: req.context, outletId: req.query.outlet_id })));
  } catch (error) {
    next(error);
  }
}

async function getSale(req, res, next) {
  try {
    let sale = await service.getSale({ context: req.context, id: req.params.id });
    // A voided online sale whose refund Paystack had not processed yet: re-check it now.
    if (sale.voided_at && sale.payment_id && sale.payment_status === 'CAPTURED') {
      if (await online.refreshOnlineRefunds({ context: req.context })) sale = await service.getSale({ context: req.context, id: req.params.id });
    }
    res.json(ok(sale));
  } catch (error) {
    next(error);
  }
}

async function listSales(req, res, next) {
  try {
    res.json(ok(await service.listSales({ context: req.context, outletId: req.query.outlet_id, from: req.query.from, to: req.query.to })));
  } catch (error) {
    next(error);
  }
}

async function salesTotals(req, res, next) {
  try {
    res.json(ok(await service.salesTotals({ context: req.context, outletId: outletRequired(req), from: req.query.from, to: req.query.to })));
  } catch (error) {
    next(error);
  }
}

async function mySalesTotals(req, res, next) {
  try {
    res.json(ok(await service.mySalesTotals({ context: req.context, outletId: outletRequired(req) })));
  } catch (error) {
    next(error);
  }
}

async function summary(req, res, next) {
  try {
    res.json(ok(await service.summarize({ context: req.context, outletId: req.query.outlet_id, from: req.query.from, to: req.query.to })));
  } catch (error) {
    next(error);
  }
}

async function voidSale(req, res, next) {
  try {
    // A cashier may start a void, but only of a sale at their own outlets (another outlet's receipt is "not found").
    await service.getSale({ context: req.context, id: req.params.id });
    // A manager's approval, claimed inside the void's own transaction (for an online sale: with the refund record).
    const approve = approvalConsumer(req, 'supermarket.void_sale', req.params.id);
    // An online sale's void refunds the payment at Paystack first (outside any transaction).
    if (await isOnlineSale(req.context, req.params.id)) {
      const key = requireIdempotencyKey(req);
      const result = await online.voidOnlineSale({
        context: req.context,
        saleId: req.params.id,
        reason: req.body?.reason,
        userId: req.context.userId,
        idempotencyKey: key,
        approve,
      });
      await req.audit({ entityType: 'supermarket_sales', entityId: req.params.id, action: 'void', afterState: { refundPaymentId: result.refund.id, refundStatus: result.refund.status }, reason: req.body?.reason });
      return res.json(ok(result.sale, { refund: result.refund }));
    }
    await runIdempotentMutation(req, res, {
      operationType: 'supermarket.void_sale',
      entityType: 'supermarket_sales',
      entityId: req.params.id,
      action: 'void',
      handler: async (trx) => {
        // Claimed first: a void that then fails leaves the approval unused.
        await approve(trx);
        return { status: 200, body: ok(await service.voidSale({ trx, id: req.params.id, reason: req.body?.reason, userId: req.context.userId })) };
      },
    });
  } catch (error) {
    next(error);
  }
}

async function listBarcodes(req, res, next) {
  try {
    res.json(ok(await service.listBarcodes({ context: req.context, menuItemId: req.query.menu_item_id, outletId: req.query.outlet_id })));
  } catch (error) {
    next(error);
  }
}

async function addBarcode(req, res, next) {
  try {
    const row = await service.addBarcode({ context: req.context, menuItemId: req.body?.menu_item_id, barcode: req.body?.barcode });
    await req.audit({ entityType: 'supermarket_barcodes', entityId: row.id, action: 'create', afterState: row });
    res.status(201).json(ok(row));
  } catch (error) {
    next(error);
  }
}

async function removeBarcode(req, res, next) {
  try {
    const row = await service.removeBarcode({ context: req.context, id: req.params.id });
    await req.audit({ entityType: 'supermarket_barcodes', entityId: row.id, action: 'delete', beforeState: row });
    res.json(ok({ id: row.id }));
  } catch (error) {
    if (error?.code === 'VALIDATION_BARCODE_NOT_FOUND') return notFound(res);
    next(error);
  }
}

function outletRequired(req) {
  if (!req.query.outlet_id) throw new ValidationError('MISSING_FIELD', '"outlet_id" is required.', [{ field: 'outlet_id', issue: 'missing' }]);
  return req.query.outlet_id;
}

async function setupFlags(req, res, next) {
  try {
    res.json(ok(await service.listSetupFlags({ context: req.context, outletId: outletRequired(req) })));
  } catch (error) {
    next(error);
  }
}

async function lowStock(req, res, next) {
  try {
    res.json(ok(await service.listLowStock({ context: req.context, outletId: outletRequired(req) })));
  } catch (error) {
    next(error);
  }
}

async function mySales(req, res, next) {
  try {
    res.json(ok(await service.listMySalesToday({ context: req.context, outletId: outletRequired(req) })));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------- product editing (supermarket.manage)

async function listProducts(req, res, next) {
  try {
    const includeArchived = req.query.include_archived === 'true';
    res.json(ok(await productEdit.listProducts({ context: req.context, outletId: outletRequired(req), includeArchived })));
  } catch (error) {
    next(error);
  }
}

/** Sends a product-edit result, auditing the change; a product this outlet does not carry is a 404. */
async function respondProductChange(req, res, next, { action, run }) {
  try {
    const result = await run();
    if (result.changed !== false) {
      await req.audit({
        entityType: 'pos_menu_items',
        entityId: req.params.id,
        action,
        beforeState: result.before,
        afterState: result.after,
        reason: typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim() : undefined,
      });
    }
    res.json(ok(result.after));
  } catch (error) {
    if (error?.code === 'VALIDATION_PRODUCT_NOT_FOUND') return notFound(res);
    next(error);
  }
}

function editProduct(req, res, next) {
  return respondProductChange(req, res, next, {
    action: 'supermarket_product_edit',
    run: () => productEdit.editProduct({ context: req.context, outletId: req.body?.outlet_id, id: req.params.id, body: req.body }),
  });
}

function archiveProduct(req, res, next) {
  return respondProductChange(req, res, next, {
    action: 'supermarket_product_archive',
    run: () => productEdit.setProductArchived({ context: req.context, outletId: req.body?.outlet_id, id: req.params.id, archived: true }),
  });
}

function restoreProduct(req, res, next) {
  return respondProductChange(req, res, next, {
    action: 'supermarket_product_restore',
    run: () => productEdit.setProductArchived({ context: req.context, outletId: req.body?.outlet_id, id: req.params.id, archived: false }),
  });
}

module.exports = { stockOnHand, setupFlags, lowStock, mySales, listMyOutlets, lookup, createSale, getSale, listSales, salesTotals, mySalesTotals, summary, voidSale, listBarcodes, addBarcode, removeBarcode, listProducts, editProduct, archiveProduct, restoreProduct };
