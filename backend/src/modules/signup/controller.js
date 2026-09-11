'use strict';

const { ok } = require('../../shared/response');
const service = require('./service');

async function signup(req, res, next) {
  try {
    const body = req.body ?? {};
    const result = await service.signupTenant({
      companyName: body.company_name,
      slug: body.slug,
      timezone: body.timezone,
      baseCurrency: body.base_currency,
      propertyName: body.property_name,
      adminEmail: body.admin_email,
      adminPassword: body.admin_password,
      adminFirstName: body.admin_first_name,
      adminLastName: body.admin_last_name,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      requestId: req.requestId,
    });
    res.status(201).json(ok(result));
  } catch (error) {
    next(error);
  }
}

module.exports = { signup };
