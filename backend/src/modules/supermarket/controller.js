'use strict';

const { ok, notFound } = require('../../shared/response');
const { runIdempotentMutation } = require('../../shared/mutation');
const { ValidationError } = require('../../shared/errors');
const service = require('./service');

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
        });
        return { status: 201, body: ok(sale) };
      },
    });
  } catch (error) {
    next(error);
  }
}

async function getSale(req, res, next) {
  try {
    res.json(ok(await service.getSale({ context: req.context, id: req.params.id })));
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

async function summary(req, res, next) {
  try {
    res.json(ok(await service.summarize({ context: req.context, outletId: req.query.outlet_id, from: req.query.from, to: req.query.to })));
  } catch (error) {
    next(error);
  }
}

async function voidSale(req, res, next) {
  try {
    await runIdempotentMutation(req, res, {
      operationType: 'supermarket.void_sale',
      entityType: 'supermarket_sales',
      entityId: req.params.id,
      action: 'void',
      handler: async (trx) => ({ status: 200, body: ok(await service.voidSale({ trx, id: req.params.id, reason: req.body?.reason, userId: req.context.userId })) }),
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

module.exports = { setupFlags, lowStock, mySales, listMyOutlets, lookup, createSale, getSale, listSales, summary, voidSale, listBarcodes, addBarcode, removeBarcode };
