'use strict';

/**
 * HTTP layer for the setup module — parses the request, calls the service,
 * shapes the API.md §2 envelope. No business logic here; see `service.js`.
 */

const { ok, notFound } = require('../../shared/response');
const service = require('./service');
const { ValidationError } = require('../../shared/errors');

function require_(body, field) {
  const value = body?.[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value;
}

function requireBoolean(body, field) {
  const value = body?.[field];
  if (typeof value !== 'boolean') {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required and must be true or false.`, [
      { field, issue: 'missing' },
    ]);
  }
  return value;
}

// ---------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------

async function createProperty(req, res, next) {
  try {
    const name = require_(req.body, 'name');
    const slug = require_(req.body, 'slug');
    const timezone = require_(req.body, 'timezone');
    const baseCurrency = require_(req.body, 'base_currency');
    const property = await service.createProperty({
      context: req.context,
      name,
      slug,
      timezone,
      baseCurrency,
      address: req.body?.address,
      businessDate: req.body?.business_date,
    });
    await req.audit({ entityType: 'properties', entityId: property.id, action: 'create', afterState: property });
    res.status(201).json(ok(property));
  } catch (error) {
    next(error);
  }
}

async function updateProperty(req, res, next) {
  try {
    const { id } = req.params;
    const before = await service.getProperty({ context: req.context, id });
    if (!before) return notFound(res);
    const property = await service.updateProperty({ context: req.context, id, changes: req.body ?? {} });
    await req.audit({ entityType: 'properties', entityId: id, action: 'update', beforeState: before, afterState: property });
    res.status(200).json(ok(property));
  } catch (error) {
    next(error);
  }
}

async function listProperties(req, res, next) {
  try {
    const properties = await service.listProperties({ context: req.context });
    res.status(200).json(ok(properties));
  } catch (error) {
    next(error);
  }
}

async function getProperty(req, res, next) {
  try {
    const property = await service.getProperty({ context: req.context, id: req.params.id });
    if (!property) return notFound(res);
    res.status(200).json(ok(property));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Room types
// ---------------------------------------------------------------------

async function createRoomType(req, res, next) {
  try {
    const code = require_(req.body, 'code');
    const name = require_(req.body, 'name');
    const defaultOccupancy = Number(req.body?.default_occupancy);
    if (!Number.isInteger(defaultOccupancy) || defaultOccupancy < 1) {
      throw new ValidationError('INVALID_OCCUPANCY', '"default_occupancy" must be a positive whole number.', [
        { field: 'default_occupancy', issue: 'invalid' },
      ]);
    }
    const baseRate = require_(req.body, 'base_rate');
    const roomType = await service.createRoomType({
      context: req.context,
      code,
      name,
      description: req.body?.description,
      defaultOccupancy,
      baseRate,
      photos: req.body?.photos,
    });
    await req.audit({ entityType: 'room_types', entityId: roomType.id, action: 'create', afterState: roomType });
    res.status(201).json(ok(roomType));
  } catch (error) {
    next(error);
  }
}

async function updateRoomType(req, res, next) {
  try {
    const { id } = req.params;
    const before = await service.getRoomType({ context: req.context, id });
    if (!before) return notFound(res);
    const roomType = await service.updateRoomType({ context: req.context, id, changes: req.body ?? {} });
    await req.audit({ entityType: 'room_types', entityId: id, action: 'update', beforeState: before, afterState: roomType });
    res.status(200).json(ok(roomType));
  } catch (error) {
    next(error);
  }
}

async function archiveRoomType(req, res, next) {
  try {
    const { id } = req.params;
    const before = await service.getRoomType({ context: req.context, id });
    if (!before) return notFound(res);
    const roomType = await service.archiveRoomType({ context: req.context, id });
    await req.audit({ entityType: 'room_types', entityId: id, action: 'archive', beforeState: before, afterState: roomType });
    res.status(200).json(ok(roomType));
  } catch (error) {
    next(error);
  }
}

async function listRoomTypes(req, res, next) {
  try {
    res.status(200).json(ok(await service.listRoomTypes({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------

async function createRoom(req, res, next) {
  try {
    const roomNumber = require_(req.body, 'room_number');
    const roomTypeId = require_(req.body, 'room_type_id');
    const room = await service.createRoom({
      context: req.context,
      roomNumber,
      floor: req.body?.floor,
      roomTypeId,
      connectingRoomId: req.body?.connecting_room_id,
    });
    await req.audit({ entityType: 'rooms', entityId: room.id, action: 'create', afterState: room });
    res.status(201).json(ok(room));
  } catch (error) {
    next(error);
  }
}

async function bulkCreateRooms(req, res, next) {
  try {
    const roomTypeId = require_(req.body, 'room_type_id');
    const from = require_(req.body, 'from');
    const to = require_(req.body, 'to');
    const rooms = await service.bulkCreateRooms({
      context: req.context,
      roomTypeId,
      floor: req.body?.floor,
      from,
      to,
    });
    await req.audit({
      entityType: 'rooms',
      action: 'bulk_create',
      afterState: { count: rooms.length, from, to, room_type_id: roomTypeId },
    });
    res.status(201).json(ok(rooms, { count: rooms.length }));
  } catch (error) {
    next(error);
  }
}

async function updateRoom(req, res, next) {
  try {
    const { id } = req.params;
    const before = await service.getRoom({ context: req.context, id });
    if (!before) return notFound(res);
    const room = await service.updateRoom({ context: req.context, id, changes: req.body ?? {} });
    await req.audit({ entityType: 'rooms', entityId: id, action: 'update', beforeState: before, afterState: room });
    res.status(200).json(ok(room));
  } catch (error) {
    next(error);
  }
}

async function listRooms(req, res, next) {
  try {
    res.status(200).json(ok(await service.listRooms({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Rate codes
// ---------------------------------------------------------------------

async function createRateCode(req, res, next) {
  try {
    const code = require_(req.body, 'code');
    const baseRate = require_(req.body, 'base_rate');
    const currency = require_(req.body, 'currency');
    const validFrom = require_(req.body, 'valid_from');
    const rateCode = await service.createRateCode({
      context: req.context,
      code,
      description: req.body?.description,
      baseRate,
      currency,
      validFrom,
      validTo: req.body?.valid_to,
    });
    await req.audit({ entityType: 'rate_codes', entityId: rateCode.id, action: 'create', afterState: rateCode });
    res.status(201).json(ok(rateCode));
  } catch (error) {
    next(error);
  }
}

async function updateRateCode(req, res, next) {
  try {
    const { id } = req.params;
    const before = await service.getRateCode({ context: req.context, id });
    if (!before) return notFound(res);
    const rateCode = await service.updateRateCode({ context: req.context, id, changes: req.body ?? {} });
    await req.audit({ entityType: 'rate_codes', entityId: id, action: 'update', beforeState: before, afterState: rateCode });
    res.status(200).json(ok(rateCode));
  } catch (error) {
    next(error);
  }
}

async function archiveRateCode(req, res, next) {
  try {
    const { id } = req.params;
    const before = await service.getRateCode({ context: req.context, id });
    if (!before) return notFound(res);
    const rateCode = await service.archiveRateCode({ context: req.context, id });
    await req.audit({ entityType: 'rate_codes', entityId: id, action: 'archive', beforeState: before, afterState: rateCode });
    res.status(200).json(ok(rateCode));
  } catch (error) {
    next(error);
  }
}

async function listRateCodes(req, res, next) {
  try {
    res.status(200).json(ok(await service.listRateCodes({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Rate calendar
// ---------------------------------------------------------------------

async function setRateOverride(req, res, next) {
  try {
    const rateCodeId = require_(req.body, 'rate_code_id');
    const roomTypeId = require_(req.body, 'room_type_id');
    const stayDate = require_(req.body, 'stay_date');
    const rate = require_(req.body, 'rate');
    const override = await service.setRateOverride({ context: req.context, rateCodeId, roomTypeId, stayDate, rate });
    await req.audit({
      entityType: 'rate_calendar',
      entityId: override.id,
      action: 'set_override',
      afterState: override,
      reason: req.body?.reason,
    });
    res.status(200).json(ok(override));
  } catch (error) {
    next(error);
  }
}

async function deleteRateOverride(req, res, next) {
  try {
    const { id } = req.params;
    const affected = await service.deleteRateOverride({ context: req.context, id });
    if (!affected) return notFound(res);
    await req.audit({ entityType: 'rate_calendar', entityId: id, action: 'delete_override', reason: req.body?.reason });
    res.status(200).json(ok({ deleted: true }));
  } catch (error) {
    next(error);
  }
}

async function listRateCalendar(req, res, next) {
  try {
    const rateCodeId = require_(req.query, 'rate_code_id');
    const roomTypeId = require_(req.query, 'room_type_id');
    const from = require_(req.query, 'from');
    const to = require_(req.query, 'to');
    const overrides = await service.listRateCalendar({ context: req.context, rateCodeId, roomTypeId, from, to });
    res.status(200).json(ok(overrides));
  } catch (error) {
    next(error);
  }
}

async function resolveRate(req, res, next) {
  try {
    const rateCodeId = require_(req.query, 'rate_code_id');
    const roomTypeId = require_(req.query, 'room_type_id');
    const stayDate = require_(req.query, 'stay_date');
    const resolved = await service.resolveRateForDate({ context: req.context, rateCodeId, roomTypeId, stayDate });
    if (!resolved) return notFound(res);
    res.status(200).json(ok(resolved));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Taxes
// ---------------------------------------------------------------------

async function createTaxVersion(req, res, next) {
  try {
    const taxCode = require_(req.body, 'tax_code');
    const name = require_(req.body, 'name');
    const rate = require_(req.body, 'rate');
    const effectiveFrom = require_(req.body, 'effective_from');
    const isInclusive = requireBoolean(req.body, 'is_inclusive');
    const calculationMethod = require_(req.body, 'calculation_method');
    const version = await service.createTaxVersion({
      context: req.context,
      taxCode,
      name,
      rate,
      effectiveFrom,
      isInclusive,
      calculationMethod,
      priority: req.body?.priority,
      isCompound: req.body?.is_compound,
      roundingMethod: req.body?.rounding_method,
      jurisdiction: req.body?.jurisdiction,
      applies_to: req.body?.applies_to,
    });
    await req.audit({
      entityType: 'taxes',
      entityId: version.id,
      action: 'create_version',
      afterState: version,
      reason: req.body?.reason,
    });
    res.status(201).json(ok(version));
  } catch (error) {
    next(error);
  }
}

async function listTaxes(req, res, next) {
  try {
    res.status(200).json(ok(await service.listTaxes({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

async function resolveTax(req, res, next) {
  try {
    const taxCode = require_(req.query, 'tax_code');
    const businessDate = require_(req.query, 'business_date');
    const resolved = await service.resolveTaxForDate({ context: req.context, taxCode, businessDate });
    if (!resolved) return notFound(res);
    res.status(200).json(ok(resolved));
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createProperty,
  updateProperty,
  listProperties,
  getProperty,
  createRoomType,
  updateRoomType,
  archiveRoomType,
  listRoomTypes,
  createRoom,
  bulkCreateRooms,
  updateRoom,
  listRooms,
  createRateCode,
  updateRateCode,
  archiveRateCode,
  listRateCodes,
  setRateOverride,
  deleteRateOverride,
  listRateCalendar,
  resolveRate,
  createTaxVersion,
  listTaxes,
  resolveTax,
};
