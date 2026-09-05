'use strict';

/**
 * The two-tenant fixture set (TESTING.md Part 2, ground rules).
 *
 * "Two tenants in every fixture set, with overlapping IDs — tenant A's
 * reservation 1 and tenant B's reservation 1 both exist. Single-tenant fixtures
 * hide the exact bug that matters most."
 *
 * A note on "overlapping IDs", because it cannot be taken literally in this
 * schema: primary keys here are a single global AUTO_INCREMENT sequence per
 * table (ARCHITECTURE.md §10), so two rows in `users` cannot both be id 1. Two
 * tenants would only hold literally-identical ids under a database-per-tenant
 * design, which this is not.
 *
 * What the ground rule is actually protecting against is a query that loses its
 * tenant filter and silently returns a neighbouring row. So this fixture
 * reproduces that condition instead of the literal id collision: rows are
 * created **interleaved**, A then B then A then B, so every tenant A row has a
 * tenant B row immediately adjacent in id order, and each tenant holds a row at
 * the same ordinal position in every table. An unscoped `SELECT ... LIMIT 1`,
 * an off-by-one, or a filter dropped from a join lands on the other tenant's
 * data rather than on nothing — which is the failure the rule is written to
 * catch. `expectInterleavedIds` asserts the property holds, so the fixture
 * cannot quietly stop providing it.
 *
 * Everything is created inside a caller-supplied transaction that the caller
 * rolls back (see `useRolledBackTransaction`), so the fixtures never persist.
 */

const crypto = require('crypto');

/**
 * The seven roles of SECURITY.md §5's authorization matrix, seeded per tenant.
 *
 * Roles are TENANT_SCOPED (ARCHITECTURE.md §3), so each tenant owns its own
 * copy of the vocabulary and `user_property_access.role` can only reference a
 * code its own tenant defines.
 */
const SYSTEM_ROLES = [
  'front_desk',
  'cashier',
  'housekeeping',
  'pos_operator',
  'manager',
  'admin',
  'super_admin',
];

/** A bcrypt-shaped placeholder. Never a real password — AUTH-11 asserts hashes only. */
const PASSWORD_HASH = '$2b$12$' + 'x'.repeat(53);

/**
 * A SHA-256 hex digest of `label`, standing in for the digest of a real random
 * token (see the hashing note in the auth-credentials migration).
 *
 * Derived from a label rather than randomly generated so a fixture row and the
 * assertion about it can name the same token without passing the value around,
 * and so a failing test is reproducible. `crypto` is used rather than a
 * hand-written 64-character string because it guarantees the width and alphabet
 * the CHAR(64) columns expect — a fixture that quietly inserted a 63-character
 * value would make the uniqueness tests pass for the wrong reason.
 */
function tokenHash(label) {
  return crypto.createHash('sha256').update(label).digest('hex');
}

/**
 * A datetime `hours` from now, for `expires_at` columns.
 *
 * Negative values are how the suite builds an already-expired row: expiry is a
 * timestamp comparison rather than a status column (DATABASE.md §3, and the
 * lifecycle note in the auth-credentials migration), so "expired" is not a state
 * a fixture can set — it can only be a time already past.
 */
function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 3600 * 1000);
}

async function insertReturningId(trx, table, row) {
  const [id] = await trx(table).insert(row);
  return id;
}

/**
 * Seeds two tenants with matching shapes and interleaved ids.
 *
 * Returns `{ a, b, permissions }`, where each tenant carries:
 *   id, slug, properties[2], roles{code->id}, exclusiveRoleCode,
 *   users[2], access[], guestAccounts[],
 *   sessions[2], passwordResets[2], mfaDevices[2], invitations[2], auditLog[2]
 *
 * The four credential arrays each hold one live row and one spent one, found by
 * their `label` — 'live'/'revoked', 'pending'/'used', 'confirmed'/'unconfirmed',
 * 'pending'/'accepted'.
 *
 * `exclusiveRoleCode` is a role code that tenant defines and the other does
 * not — the only way to prove the role foreign key is tenant-bound, since a
 * code both tenants define (`manager`) legitimately resolves to the caller's
 * own role.
 */
async function seedTwoTenants(trx) {
  const emptyTenant = (label, slug) => ({
    label,
    slug,
    roles: {},
    properties: [],
    users: [],
    access: [],
    guestAccounts: [],
    sessions: [],
    passwordResets: [],
    mfaDevices: [],
    invitations: [],
    auditLog: [],
    roomTypes: [],
    rooms: [],
    rateCodes: [],
    rateCalendar: [],
    taxes: [],
    guests: [],
    roomTypeInventory: [],
    reservations: [],
    reservationRooms: [],
    reservationDailyRates: [],
    reservationNotes: [],
    folios: [],
    idempotencyKeys: [],
    outOfOrderPeriods: [],
    housekeepingAssignments: [],
    housekeepingDiscrepancies: [],
    outboxEvents: [],
    emailTemplates: [],
    notificationLog: [],
    inAppNotifications: [],
    folioLineItems: [],
    payments: [],
    nightAuditRuns: [],
    dailyReports: [],
  });

  // Two symmetric example hotels, not one reference customer
  // (PRODUCT_REQUIREMENTS.md §1: "no per-customer forks or hardcoded customer
  // logic"). These are also the exact tenant slugs `src/auth/tenant-resolution.js`
  // resolves in local dev — visiting alpha-hotels.localhost:3000 or
  // beta-resorts.localhost:3000 against a dev server reaches one of these two
  // once seeded, no /etc/hosts entry required (RFC 6761: *.localhost always
  // resolves to loopback).
  const a = emptyTenant('A', 'alpha-hotels');
  const b = emptyTenant('B', 'beta-resorts');
  const both = [a, b];

  // Tenants, interleaved from here down: A, B, A, B ...
  for (const t of both) {
    t.id = await insertReturningId(trx, 'tenants', {
      name: `Fixture tenant ${t.label}`,
      slug: t.slug,
      status: 'active',
    });
  }

  for (const t of both) {
    t.domain = `${t.slug}.example.com`;
    await trx('tenant_domains').insert({ tenant_id: t.id, domain: t.domain });
  }

  for (let i = 0; i < 2; i += 1) {
    for (const t of both) {
      t.properties.push({
        id: await insertReturningId(trx, 'properties', {
          tenant_id: t.id,
          slug: `${t.slug}-property-${i + 1}`,
          name: `Fixture property ${t.label}${i + 1}`,
          // Two different timezones on purpose: every property sits at its own
          // point in time (ARCHITECTURE.md §6), and a fixture where they all
          // match the server hides business-date bugs (NA-7, NA-9).
          timezone: i === 0 ? 'Africa/Lagos' : 'Europe/London',
          base_currency: i === 0 ? 'NGN' : 'GBP',
        }),
        ordinal: i,
      });
    }
  }

  // ------------------------------------------------------------------
  // Property setup (PLAN.md Phase 1) — one of each entity per tenant, on
  // properties[0], interleaved A/B like everything else in this fixture.
  // Enough for the ISO-* suite (tests/helpers/entities.js) to have a real
  // row to collide with, reference cross-tenant, and read back.
  // ------------------------------------------------------------------
  for (const t of both) {
    const property = t.properties[0];

    t.roomTypes.push({
      id: await insertReturningId(trx, 'room_types', {
        tenant_id: t.id,
        property_id: property.id,
        code: 'DLX',
        name: 'Deluxe',
        default_occupancy: 2,
        base_rate: '150.00',
      }),
      property_id: property.id,
    });
  }

  for (const t of both) {
    const property = t.properties[0];
    const roomType = t.roomTypes[0];

    t.rooms.push({
      id: await insertReturningId(trx, 'rooms', {
        tenant_id: t.id,
        property_id: property.id,
        room_number: '101',
        floor: '1',
        room_type_id: roomType.id,
      }),
      property_id: property.id,
      room_type_id: roomType.id,
    });
  }

  for (const t of both) {
    const property = t.properties[0];

    t.rateCodes.push({
      id: await insertReturningId(trx, 'rate_codes', {
        tenant_id: t.id,
        property_id: property.id,
        code: 'BAR',
        base_rate: '150.00',
        // properties[0]'s base_currency is 'NGN' for both tenants — the
        // property-creation loop above keys currency/timezone off ordinal
        // (i === 0), not tenant identity.
        currency: 'NGN',
        valid_from: '2026-01-01',
      }),
      property_id: property.id,
    });
  }

  for (const t of both) {
    const property = t.properties[0];
    const roomType = t.roomTypes[0];
    const rateCode = t.rateCodes[0];

    t.rateCalendar.push({
      id: await insertReturningId(trx, 'rate_calendar', {
        tenant_id: t.id,
        property_id: property.id,
        rate_code_id: rateCode.id,
        room_type_id: roomType.id,
        stay_date: '2026-12-24',
        rate: '225.00',
      }),
      property_id: property.id,
      rate_code_id: rateCode.id,
      room_type_id: roomType.id,
    });
  }

  for (const t of both) {
    const property = t.properties[0];

    t.taxes.push({
      id: await insertReturningId(trx, 'taxes', {
        tenant_id: t.id,
        property_id: property.id,
        tax_code: 'VAT',
        name: 'VAT',
        rate: '7.5000',
        effective_from: '2026-01-01',
        is_inclusive: false,
        calculation_method: 'percentage',
      }),
      property_id: property.id,
    });
  }

  // ------------------------------------------------------------------
  // Idempotency infra (PLAN.md Phase 2) — TENANT_SCOPED, no property
  // dimension, seeded before the property-scoped tables below since it
  // depends on nothing but the tenant itself.
  // ------------------------------------------------------------------
  for (const t of both) {
    t.idempotencyKeys.push({
      id: await insertReturningId(trx, 'idempotency_keys', {
        tenant_id: t.id,
        operation_type: 'reservations.create',
        key_value: `${t.slug}-fixture-key`,
        request_hash: 'f'.repeat(64),
        response_status: 201,
        response_body: JSON.stringify({ data: { id: '1' } }),
        expires_at: hoursFromNow(24),
      }),
      operation_type: 'reservations.create',
      key_value: `${t.slug}-fixture-key`,
    });
  }

  // ------------------------------------------------------------------
  // Reservations & front desk (PLAN.md Phase 2) — one of each entity per
  // tenant, on properties[0]/roomTypes[0]/rateCodes[0]/rooms[0], interleaved
  // A/B like everything else in this fixture. Enough for the ISO-* suite
  // to have a real row to collide with, reference cross-tenant, and read
  // back.
  // ------------------------------------------------------------------
  for (const t of both) {
    t.guests.push({
      id: await insertReturningId(trx, 'guests', {
        tenant_id: t.id,
        first_name: 'Jordan',
        last_name: 'Fixture',
        email: `guest-${t.slug}@example.com`,
        phone: '+10000000000',
      }),
    });
  }

  for (const t of both) {
    const property = t.properties[0];
    const roomType = t.roomTypes[0];

    t.roomTypeInventory.push({
      id: await insertReturningId(trx, 'room_type_inventory', {
        tenant_id: t.id,
        property_id: property.id,
        room_type_id: roomType.id,
        stay_date: '2026-12-24',
        rooms_sold: 0,
        overbooking_threshold_pct: '100.00',
      }),
      property_id: property.id,
      room_type_id: roomType.id,
    });
  }

  for (const t of both) {
    const property = t.properties[0];
    const guest = t.guests[0];
    const roomType = t.roomTypes[0];
    const rateCode = t.rateCodes[0];

    t.reservations.push({
      id: await insertReturningId(trx, 'reservations', {
        tenant_id: t.id,
        property_id: property.id,
        guest_id: guest.id,
        room_type_id: roomType.id,
        rate_code_id: rateCode.id,
        arrival_date: '2026-12-24',
        departure_date: '2026-12-26',
        adults: 2,
        children: 0,
        status: 'confirmed',
        confirmation_number: `FIXTURE-${t.slug}`.toUpperCase().slice(0, 26),
      }),
      property_id: property.id,
      guest_id: guest.id,
      room_type_id: roomType.id,
    });
  }

  for (const t of both) {
    const property = t.properties[0];
    const reservation = t.reservations[0];

    for (const stayDate of ['2026-12-24', '2026-12-25']) {
      t.reservationDailyRates.push({
        id: await insertReturningId(trx, 'reservation_daily_rates', {
          tenant_id: t.id,
          property_id: property.id,
          reservation_id: reservation.id,
          stay_date: stayDate,
          rate: '150.00',
          currency: 'NGN',
        }),
        property_id: property.id,
        reservation_id: reservation.id,
      });
    }
  }

  for (const t of both) {
    const property = t.properties[0];
    const reservation = t.reservations[0];
    const room = t.rooms[0];

    t.reservationRooms.push({
      id: await insertReturningId(trx, 'reservation_rooms', {
        tenant_id: t.id,
        property_id: property.id,
        reservation_id: reservation.id,
        room_id: room.id,
        effective_from: hoursFromNow(-24),
        effective_to: null,
      }),
      property_id: property.id,
      reservation_id: reservation.id,
      room_id: room.id,
    });
  }

  for (const t of both) {
    const property = t.properties[0];
    const reservation = t.reservations[0];

    t.folios.push({
      id: await insertReturningId(trx, 'folios', {
        tenant_id: t.id,
        property_id: property.id,
        reservation_id: reservation.id,
        folio_number: `FIXTUREFOLIO-${t.slug}`.toUpperCase().slice(0, 26),
        status: 'open',
        balance: '0.00',
        currency: 'NGN',
      }),
      property_id: property.id,
      reservation_id: reservation.id,
    });
  }

  // Cashiering (PLAN.md Phase 2.5) — one charge and one captured cash
  // payment per tenant, on the property/folio already seeded above.
  for (const t of both) {
    const property = t.properties[0];
    const folio = t.folios[0];

    t.folioLineItems.push({
      id: await insertReturningId(trx, 'folio_line_items', {
        tenant_id: t.id,
        property_id: property.id,
        folio_id: folio.id,
        type: 'room_charge',
        description: 'Fixture room charge',
        amount: '150.00',
        currency: 'NGN',
        business_date: '2026-12-24',
      }),
      property_id: property.id,
      folio_id: folio.id,
    });
  }

  for (const t of both) {
    const property = t.properties[0];
    const folio = t.folios[0];

    t.payments.push({
      id: await insertReturningId(trx, 'payments', {
        tenant_id: t.id,
        property_id: property.id,
        folio_id: folio.id,
        idempotency_key: `FIXTURE-PAYMENT-${t.slug}`,
        provider: 'cash',
        provider_reference: `FIXTUREPAYREF-${t.slug}`,
        amount: '150.00',
        currency: 'NGN',
        status: 'CAPTURED',
        captured_at: new Date(),
      }),
      property_id: property.id,
      folio_id: folio.id,
    });
  }

  // Night Audit (PLAN.md Phase 2.5) — one COMPLETED historical run and its
  // daily_reports snapshot per tenant, dated well before the fixtures'
  // reservation dates so it never collides with a real test's own run.
  for (const t of both) {
    const property = t.properties[0];

    t.nightAuditRuns.push({
      id: await insertReturningId(trx, 'night_audit_runs', {
        tenant_id: t.id,
        property_id: property.id,
        business_date: '2026-12-01',
        status: 'COMPLETED',
        worker_id: 'fixture-worker',
        heartbeat_at: new Date(),
        started_at: new Date(),
        completed_at: new Date(),
      }),
      property_id: property.id,
    });
  }

  for (const t of both) {
    const property = t.properties[0];
    const run = t.nightAuditRuns[0];

    t.dailyReports.push({
      id: await insertReturningId(trx, 'daily_reports', {
        tenant_id: t.id,
        property_id: property.id,
        night_audit_run_id: run.id,
        business_date: '2026-12-01',
        room_revenue: '150.00',
        pos_revenue: '0.00',
        payments_collected: '150.00',
        occupancy_pct: '50.00',
        adr: '150.00',
        revpar: '75.00',
      }),
      property_id: property.id,
    });
  }

  // PLATFORM_SCOPED (nullable tenant/property attribution, `auth_events`'
  // own precedent) — a single, tenant-independent fixture row, not one per
  // tenant, since this table has no tenant loop to interleave (matching
  // `platform_users`' own shape).
  await trx('payment_webhook_events').insert({
    provider: 'paystack',
    provider_event_id: 'FIXTURE_DUPLICATE_EVENT_ID',
    payload: JSON.stringify({ event: 'charge.success' }),
    verified: true,
  });

  for (const code of SYSTEM_ROLES) {
    for (const t of both) {
      t.roles[code] = await insertReturningId(trx, 'roles', {
        tenant_id: t.id,
        code,
        name: code.replace(/_/g, ' '),
        is_system: true,
      });
    }
  }

  // One role per tenant that the other tenant does not define.
  a.exclusiveRoleCode = 'night_auditor';
  b.exclusiveRoleCode = 'group_coordinator';
  for (const t of both) {
    t.roles[t.exclusiveRoleCode] = await insertReturningId(trx, 'roles', {
      tenant_id: t.id,
      code: t.exclusiveRoleCode,
      name: t.exclusiveRoleCode.replace(/_/g, ' '),
      is_system: false,
    });
  }

  // Deliberately the SAME email addresses in both tenants: users are unique per
  // tenant (DATABASE.md §2), so an isolation bug that keys on email alone —
  // a password reset, an invitation, a login lookup — surfaces here.
  const staff = [
    { email: 'sam@example.com', first_name: 'Sam', last_name: 'Okoro' },
    { email: 'ada@example.com', first_name: 'Ada', last_name: 'Bello' },
  ];

  for (let i = 0; i < staff.length; i += 1) {
    for (const t of both) {
      t.users.push({
        id: await insertReturningId(trx, 'users', {
          tenant_id: t.id,
          ...staff[i],
          password_hash: PASSWORD_HASH,
          status: 'active',
        }),
        email: staff[i].email,
        ordinal: i,
      });
    }
  }

  // The per-property role model (SECURITY.md §4) in fixture form: user 0 works
  // at BOTH properties in different roles; user 1 works at the first property
  // only, so "a user without access to property X" (ISO-6) is representable.
  const grantPlan = [
    { property: 0, user: 0, role: 'manager' },
    { property: 1, user: 0, role: 'front_desk' },
    { property: 0, user: 1, role: 'housekeeping' },
  ];
  // Grant loop is plan-outer, tenant-inner so these rows interleave like every
  // other table. Seeding one tenant's grants and then the other's would give
  // tenant A ids 1-3 and tenant B ids 4-6, and a query that lost its tenant
  // filter would still return only tenant A's rows — the fixture would look
  // fine while testing nothing.
  for (const plan of grantPlan) {
    for (const t of both) {
      const property = t.properties[plan.property];
      const user = t.users[plan.user];
      t.access.push({
        id: await insertReturningId(trx, 'user_property_access', {
          tenant_id: t.id,
          property_id: property.id,
          user_id: user.id,
          role: plan.role,
        }),
        property_id: property.id,
        user_id: user.id,
        role: plan.role,
      });
    }
  }

  // reservation_notes needs a real staff user_id, so it seeds here — after
  // the staff users loop above, not alongside the rest of the Reservations
  // block further up (which runs before roles/users exist, same as the
  // Phase 1 property-setup block it follows the position of).
  for (const t of both) {
    const property = t.properties[0];
    const reservation = t.reservations[0];

    t.reservationNotes.push({
      id: await insertReturningId(trx, 'reservation_notes', {
        tenant_id: t.id,
        property_id: property.id,
        reservation_id: reservation.id,
        user_id: t.users[0].id,
        note: 'Fixture note.',
      }),
      property_id: property.id,
      reservation_id: reservation.id,
    });
  }

  // ------------------------------------------------------------------
  // Housekeeping (PLAN.md Phase 3) — needs real users/rooms, so it seeds
  // here, same position reservation_notes' own comment explains.
  // ------------------------------------------------------------------
  for (const t of both) {
    const property = t.properties[0];
    const room = t.rooms[0];

    t.outOfOrderPeriods.push({
      id: await insertReturningId(trx, 'out_of_order_periods', {
        tenant_id: t.id,
        property_id: property.id,
        room_id: room.id,
        type: 'ooo',
        reason: 'Fixture maintenance window.',
        start_date: '2026-12-24',
        end_date: '2026-12-26',
        created_by_user_id: t.users[0].id,
      }),
      property_id: property.id,
      room_id: room.id,
    });

    t.housekeepingAssignments.push({
      id: await insertReturningId(trx, 'housekeeping_assignments', {
        tenant_id: t.id,
        property_id: property.id,
        room_id: room.id,
        attendant_user_id: t.users[0].id,
        business_date: '2026-12-24',
        status: 'assigned',
      }),
      property_id: property.id,
      room_id: room.id,
    });

    t.housekeepingDiscrepancies.push({
      id: await insertReturningId(trx, 'housekeeping_discrepancies', {
        tenant_id: t.id,
        property_id: property.id,
        room_id: room.id,
        business_date: '2026-12-24',
        front_desk_status: 'vacant',
        housekeeping_status: 'occupied',
      }),
      property_id: property.id,
      room_id: room.id,
    });
  }

  // ------------------------------------------------------------------
  // Notifications (PLAN.md Phase 3) — needs real reservations/properties,
  // so it seeds alongside Housekeeping above, same reasoning.
  // ------------------------------------------------------------------
  for (const t of both) {
    const property = t.properties[0];
    const reservation = t.reservations[0];

    t.outboxEvents.push({
      id: await insertReturningId(trx, 'outbox_events', {
        tenant_id: t.id,
        property_id: property.id,
        event_type: 'reservation.confirmed',
        aggregate_type: 'reservations',
        aggregate_id: reservation.id,
        payload: JSON.stringify({ reservationId: reservation.id }),
        status: 'pending',
      }),
      property_id: property.id,
    });

    t.emailTemplates.push({
      id: await insertReturningId(trx, 'email_templates', {
        tenant_id: t.id,
        property_id: property.id,
        template_key: 'reservation_confirmed',
        locale: 'en',
        subject: 'Fixture subject',
        body_html: '<p>Fixture body.</p>',
      }),
      property_id: property.id,
    });

    t.notificationLog.push({
      id: await insertReturningId(trx, 'notification_log', {
        tenant_id: t.id,
        property_id: property.id,
        recipient_email: 'guest@example.com',
        template_key: 'reservation_confirmed',
        channel: 'email',
        status: 'sent',
        reservation_id: reservation.id,
        sent_at: hoursFromNow(-1),
      }),
      property_id: property.id,
      reservation_id: reservation.id,
    });

    t.inAppNotifications.push({
      id: await insertReturningId(trx, 'in_app_notifications', {
        tenant_id: t.id,
        user_id: t.users[0].id,
        type: 'housekeeping.discrepancy_raised',
        payload: JSON.stringify({ roomId: t.rooms[0].id }),
      }),
      user_id: t.users[0].id,
    });
  }

  // Same guest email in both tenants and at both of each tenant's properties —
  // guest accounts are unique per property, not per tenant (DATABASE.md §2).
  for (let i = 0; i < 2; i += 1) {
    for (const t of both) {
      t.guestAccounts.push({
        id: await insertReturningId(trx, 'guest_accounts', {
          tenant_id: t.id,
          property_id: t.properties[i].id,
          email: 'guest@example.com',
          password_hash: PASSWORD_HASH,
          status: 'active',
        }),
        property_id: t.properties[i].id,
        email: 'guest@example.com',
      });
    }
  }

  // ------------------------------------------------------------------
  // Auth credentials (20260903210341_create_auth_credentials).
  //
  // Every row below is seeded in the same A-then-B interleaved order as the
  // tables above, so a query that loses its tenant filter lands on the other
  // tenant's credentials rather than on nothing.
  //
  // Each table gets one row in each of its two meaningful states, because the
  // states are encoded as timestamps rather than a status column: a suite that
  // only ever saw live credentials could not tell a schema that distinguishes
  // spent ones from a schema that merely stores a date nobody checks.
  // ------------------------------------------------------------------

  // sessions: user 0 holds a live session, user 1 a revoked one (AUTH-6).
  const sessionPlan = [
    { user: 0, label: 'live', revoked_at: null, revoked_reason: null, expiresInHours: 24 },
    {
      user: 1,
      label: 'revoked',
      revoked_at: hoursFromNow(-1),
      revoked_reason: 'user_deactivated',
      expiresInHours: 24,
    },
  ];
  for (const plan of sessionPlan) {
    for (const t of both) {
      const refreshTokenHash = tokenHash(`${t.slug}-session-${plan.label}`);
      t.sessions.push({
        id: await insertReturningId(trx, 'sessions', {
          tenant_id: t.id,
          user_id: t.users[plan.user].id,
          refresh_token_hash: refreshTokenHash,
          expires_at: hoursFromNow(plan.expiresInHours),
          revoked_at: plan.revoked_at,
          revoked_reason: plan.revoked_reason,
          device_label: `Front desk terminal ${plan.user + 1}`,
          ip: '::ffff:203.0.113.7',
        }),
        refresh_token_hash: refreshTokenHash,
        user_id: t.users[plan.user].id,
        label: plan.label,
      });
    }
  }

  // password_resets: one unspent, one already used (AUTH-7).
  const resetPlan = [
    { user: 0, label: 'pending', used_at: null, expiresInHours: 1 },
    { user: 1, label: 'used', used_at: hoursFromNow(-0.5), expiresInHours: 1 },
  ];
  for (const plan of resetPlan) {
    for (const t of both) {
      const hash = tokenHash(`${t.slug}-reset-${plan.label}`);
      t.passwordResets.push({
        id: await insertReturningId(trx, 'password_resets', {
          tenant_id: t.id,
          user_id: t.users[plan.user].id,
          token_hash: hash,
          expires_at: hoursFromNow(plan.expiresInHours),
          used_at: plan.used_at,
        }),
        token_hash: hash,
        user_id: t.users[plan.user].id,
        label: plan.label,
      });
    }
  }

  // mfa_devices: user 0 confirmed, user 1 mid-enrolment. Both TOTP, which the
  // UNIQUE(tenant_id, user_id, type) constraint allows because they belong to
  // different users — and which lets a test assert the constraint bites on the
  // second device for the *same* user.
  const mfaPlan = [
    { user: 0, label: 'confirmed', confirmed_at: hoursFromNow(-72) },
    { user: 1, label: 'unconfirmed', confirmed_at: null },
  ];
  for (const plan of mfaPlan) {
    for (const t of both) {
      t.mfaDevices.push({
        id: await insertReturningId(trx, 'mfa_devices', {
          tenant_id: t.id,
          user_id: t.users[plan.user].id,
          type: 'totp',
          // Stands in for ciphertext, not a real TOTP seed — the column stores
          // an encrypted value (SECURITY.md §1.1).
          secret: `enc:v1:${t.slug}:${plan.label}`,
          confirmed_at: plan.confirmed_at,
        }),
        user_id: t.users[plan.user].id,
        type: 'totp',
        label: plan.label,
      });
    }
  }

  // user_invitations: one outstanding, one already accepted. Both name a
  // property and a role, which is the point of the table (SECURITY.md §4).
  const invitePlan = [
    { property: 0, label: 'pending', role: 'front_desk', accepted_at: null },
    { property: 1, label: 'accepted', role: 'cashier', accepted_at: hoursFromNow(-24) },
  ];
  for (const plan of invitePlan) {
    for (const t of both) {
      const hash = tokenHash(`${t.slug}-invite-${plan.label}`);
      t.invitations.push({
        id: await insertReturningId(trx, 'user_invitations', {
          tenant_id: t.id,
          property_id: t.properties[plan.property].id,
          // Deliberately an address that is NOT already a user: an invitation
          // for an existing account is a different flow, and reusing a seeded
          // staff address here would hide the difference.
          email: `invited-${plan.label}@example.com`,
          role: plan.role,
          token_hash: hash,
          expires_at: hoursFromNow(48),
          accepted_at: plan.accepted_at,
          invited_by_user_id: t.users[0].id,
        }),
        token_hash: hash,
        property_id: t.properties[plan.property].id,
        role: plan.role,
        label: plan.label,
      });
    }
  }

  // audit_log: two representative rows per tenant — enough for the generic
  // TENANT_OWNED isolation checks in tests/isolation/scoped-accessor.test.js
  // to have real data to prove isolation against, and enough variety
  // (a property-scoped entity change, a tenant-level one with no property)
  // to exercise property_id's attribution-not-scope nullability.
  const auditPlan = [
    {
      property: 0,
      entityType: 'reservations',
      action: 'create',
      afterState: { status: 'confirmed' },
    },
    {
      property: null,
      entityType: 'roles',
      action: 'update',
      beforeState: { name: 'Front Desk' },
      afterState: { name: 'Front Desk Agent' },
    },
  ];
  for (const plan of auditPlan) {
    for (const t of both) {
      t.auditLog.push({
        id: await insertReturningId(trx, 'audit_log', {
          tenant_id: t.id,
          property_id: plan.property === null ? null : t.properties[plan.property].id,
          entity_type: plan.entityType,
          entity_id: 1,
          action: plan.action,
          user_id: t.users[0].id,
          before_state: plan.beforeState ?? null,
          after_state: plan.afterState ?? null,
          source: 'web',
        }),
        entity_type: plan.entityType,
        action: plan.action,
      });
    }
  }

  // GLOBAL_REFERENCE: one catalogue, shared by both tenants' roles.
  //
  // Select-or-insert, not a blind insert: `setup.view`/`setup.manage` are no
  // longer fixture-only — 20260905095000_seed_setup_permissions.js seeds them
  // for real, once, outside any rolled-back transaction, so they already
  // exist by the time this fixture runs. Every key here is looked up first so
  // this fixture composes with a real migration-seeded catalogue instead of
  // colliding with it on `permissions.permission_key`'s global UNIQUE
  // constraint — the same shape `tests/auth/rbac.test.js`'s own
  // `if (permissionIds[key]) continue` guard already assumed for these three,
  // now made real instead of assumed.
  const permissions = {};
  for (const [key, domain] of [
    ['cashiering.post_charge', 'cashiering'],
    ['cashiering.void_line', 'cashiering'],
    ['reports.view_financial', 'reports'],
    ['setup.view', 'setup'],
    ['setup.manage', 'setup'],
    ['reservations.view', 'reservations'],
    ['reservations.manage', 'reservations'],
    ['front_desk.view', 'front_desk'],
    ['front_desk.manage', 'front_desk'],
    ['housekeeping.view', 'housekeeping'],
    ['housekeeping.manage', 'housekeeping'],
    ['notifications.view', 'notifications'],
    ['notifications.manage', 'notifications'],
    ['reports.view', 'reports'],
    ['night_audit.view', 'night_audit'],
    ['night_audit.run', 'night_audit'],
  ]) {
    const existing = await trx('permissions').where({ permission_key: key }).first('id');
    permissions[key] = existing
      ? existing.id
      : await insertReturningId(trx, 'permissions', { permission_key: key, name: key, domain });
  }

  // Cashiering (PLAN.md Phase 2.5) — SECURITY.md §5's matrix, "Limited"
  // defined per that section's own example ("post-a-charge, not
  // void-a-line"): front_desk gets `cashiering.post_charge` only;
  // cashier/manager/admin/super_admin get both keys; housekeeping/
  // pos_operator get neither.
  for (const t of both) {
    await trx('role_permissions').insert([
      { tenant_id: t.id, role_id: t.roles.front_desk, permission_id: permissions['cashiering.post_charge'] },
      { tenant_id: t.id, role_id: t.roles.cashier, permission_id: permissions['cashiering.post_charge'] },
      { tenant_id: t.id, role_id: t.roles.cashier, permission_id: permissions['cashiering.void_line'] },
      { tenant_id: t.id, role_id: t.roles.manager, permission_id: permissions['cashiering.post_charge'] },
      { tenant_id: t.id, role_id: t.roles.manager, permission_id: permissions['cashiering.void_line'] },
      { tenant_id: t.id, role_id: t.roles.admin, permission_id: permissions['cashiering.post_charge'] },
      { tenant_id: t.id, role_id: t.roles.admin, permission_id: permissions['cashiering.void_line'] },
      { tenant_id: t.id, role_id: t.roles.super_admin, permission_id: permissions['cashiering.post_charge'] },
      { tenant_id: t.id, role_id: t.roles.super_admin, permission_id: permissions['cashiering.void_line'] },
    ]);
  }

  // Night Audit (PLAN.md Phase 2.5) — SECURITY.md §5 has no Night Audit row
  // at all (confirmed by reading that file directly); this session's
  // confirmed decision: closing a business date is manager-level, not
  // operational — manager/admin/super_admin only.
  for (const t of both) {
    await trx('role_permissions').insert([
      { tenant_id: t.id, role_id: t.roles.manager, permission_id: permissions['night_audit.view'] },
      { tenant_id: t.id, role_id: t.roles.manager, permission_id: permissions['night_audit.run'] },
      { tenant_id: t.id, role_id: t.roles.admin, permission_id: permissions['night_audit.view'] },
      { tenant_id: t.id, role_id: t.roles.admin, permission_id: permissions['night_audit.run'] },
      { tenant_id: t.id, role_id: t.roles.super_admin, permission_id: permissions['night_audit.view'] },
      { tenant_id: t.id, role_id: t.roles.super_admin, permission_id: permissions['night_audit.run'] },
    ]);
  }

  // Setup domain (PLAN.md Phase 1) — this session's confirmed decision:
  // Manager gets read-only Setup access, Admin/Super-admin get full access.
  // Real fixture data, not test-file-local, so every setup-module test gets
  // it for free the same way the cashiering grant above already works.
  for (const t of both) {
    await trx('role_permissions').insert([
      { tenant_id: t.id, role_id: t.roles.manager, permission_id: permissions['setup.view'] },
      { tenant_id: t.id, role_id: t.roles.admin, permission_id: permissions['setup.view'] },
      { tenant_id: t.id, role_id: t.roles.admin, permission_id: permissions['setup.manage'] },
      { tenant_id: t.id, role_id: t.roles.super_admin, permission_id: permissions['setup.view'] },
      { tenant_id: t.id, role_id: t.roles.super_admin, permission_id: permissions['setup.manage'] },
    ]);
  }

  // Reservations & front desk (PLAN.md Phase 2) — SECURITY.md §5's matrix:
  // front_desk gets full access to both; cashier gets Read on Reservations
  // only, nothing on Front Desk; manager/admin/super_admin get full access
  // to both, the same "operational roles get what they need, management
  // roles get everything" shape the setup-domain grants above already use.
  for (const t of both) {
    await trx('role_permissions').insert([
      { tenant_id: t.id, role_id: t.roles.front_desk, permission_id: permissions['reservations.view'] },
      { tenant_id: t.id, role_id: t.roles.front_desk, permission_id: permissions['reservations.manage'] },
      { tenant_id: t.id, role_id: t.roles.front_desk, permission_id: permissions['front_desk.view'] },
      { tenant_id: t.id, role_id: t.roles.front_desk, permission_id: permissions['front_desk.manage'] },
      { tenant_id: t.id, role_id: t.roles.cashier, permission_id: permissions['reservations.view'] },
      { tenant_id: t.id, role_id: t.roles.manager, permission_id: permissions['reservations.view'] },
      { tenant_id: t.id, role_id: t.roles.manager, permission_id: permissions['reservations.manage'] },
      { tenant_id: t.id, role_id: t.roles.manager, permission_id: permissions['front_desk.view'] },
      { tenant_id: t.id, role_id: t.roles.manager, permission_id: permissions['front_desk.manage'] },
      { tenant_id: t.id, role_id: t.roles.admin, permission_id: permissions['reservations.view'] },
      { tenant_id: t.id, role_id: t.roles.admin, permission_id: permissions['reservations.manage'] },
      { tenant_id: t.id, role_id: t.roles.admin, permission_id: permissions['front_desk.view'] },
      { tenant_id: t.id, role_id: t.roles.admin, permission_id: permissions['front_desk.manage'] },
      { tenant_id: t.id, role_id: t.roles.super_admin, permission_id: permissions['reservations.view'] },
      { tenant_id: t.id, role_id: t.roles.super_admin, permission_id: permissions['reservations.manage'] },
      { tenant_id: t.id, role_id: t.roles.super_admin, permission_id: permissions['front_desk.view'] },
      { tenant_id: t.id, role_id: t.roles.super_admin, permission_id: permissions['front_desk.manage'] },
    ]);
  }

  // Housekeeping (PLAN.md Phase 3) — SECURITY.md §5's matrix: the
  // `housekeeping` role gets full access, `front_desk` gets Read only,
  // manager/admin/super_admin get full access, cashier/pos_operator get
  // neither key.
  for (const t of both) {
    await trx('role_permissions').insert([
      { tenant_id: t.id, role_id: t.roles.housekeeping, permission_id: permissions['housekeeping.view'] },
      { tenant_id: t.id, role_id: t.roles.housekeeping, permission_id: permissions['housekeeping.manage'] },
      { tenant_id: t.id, role_id: t.roles.front_desk, permission_id: permissions['housekeeping.view'] },
      { tenant_id: t.id, role_id: t.roles.manager, permission_id: permissions['housekeeping.view'] },
      { tenant_id: t.id, role_id: t.roles.manager, permission_id: permissions['housekeeping.manage'] },
      { tenant_id: t.id, role_id: t.roles.admin, permission_id: permissions['housekeeping.view'] },
      { tenant_id: t.id, role_id: t.roles.admin, permission_id: permissions['housekeeping.manage'] },
      { tenant_id: t.id, role_id: t.roles.super_admin, permission_id: permissions['housekeeping.view'] },
      { tenant_id: t.id, role_id: t.roles.super_admin, permission_id: permissions['housekeeping.manage'] },
    ]);
  }

  // Notifications (PLAN.md Phase 3) — SECURITY.md §5's matrix has no
  // Notifications column at all (confirmed by reading that file directly);
  // this session's confirmed decision follows Setup's own shape instead —
  // an admin-configuration surface, not an operational one. Manager gets
  // read-only (the delivery log); admin/super_admin get full access
  // (template editing, resend). Every other role gets neither key.
  for (const t of both) {
    await trx('role_permissions').insert([
      { tenant_id: t.id, role_id: t.roles.manager, permission_id: permissions['notifications.view'] },
      { tenant_id: t.id, role_id: t.roles.admin, permission_id: permissions['notifications.view'] },
      { tenant_id: t.id, role_id: t.roles.admin, permission_id: permissions['notifications.manage'] },
      { tenant_id: t.id, role_id: t.roles.super_admin, permission_id: permissions['notifications.view'] },
      { tenant_id: t.id, role_id: t.roles.super_admin, permission_id: permissions['notifications.manage'] },
    ]);
  }

  // Reports (PLAN.md Phase 3) — SECURITY.md §5's matrix: front_desk and
  // cashier get "Limited" (defined here, per that section's own rule, as
  // `reports.view` only — occupancy/housekeeping, no financial figures);
  // housekeeping/pos_operator get none; manager/admin/super_admin get full
  // access (`reports.view` + `reports.view_financial`).
  for (const t of both) {
    await trx('role_permissions').insert([
      { tenant_id: t.id, role_id: t.roles.front_desk, permission_id: permissions['reports.view'] },
      { tenant_id: t.id, role_id: t.roles.cashier, permission_id: permissions['reports.view'] },
      { tenant_id: t.id, role_id: t.roles.manager, permission_id: permissions['reports.view'] },
      { tenant_id: t.id, role_id: t.roles.manager, permission_id: permissions['reports.view_financial'] },
      { tenant_id: t.id, role_id: t.roles.admin, permission_id: permissions['reports.view'] },
      { tenant_id: t.id, role_id: t.roles.admin, permission_id: permissions['reports.view_financial'] },
      { tenant_id: t.id, role_id: t.roles.super_admin, permission_id: permissions['reports.view'] },
      { tenant_id: t.id, role_id: t.roles.super_admin, permission_id: permissions['reports.view_financial'] },
    ]);
  }

  return { a, b, permissions };
}

/**
 * Platform staff — PLATFORM_SCOPED, so it belongs to no tenant and is seeded
 * outside `seedTwoTenants`'s per-tenant loop by design.
 */
async function seedPlatformUser(trx, email = 'ops@planmsys.test') {
  const id = await insertReturningId(trx, 'platform_users', {
    email,
    password_hash: PASSWORD_HASH,
    first_name: 'Ops',
    last_name: 'Staff',
  });
  return { id, email };
}

/**
 * Asserts the interleaving described at the top of this file: for the given
 * table, tenant B holds a row whose id falls between two of tenant A's, so a
 * query that loses its tenant filter returns foreign data rather than nothing.
 */
function expectInterleavedIds(aIds, bIds) {
  const sortedA = [...aIds].sort((x, y) => Number(x) - Number(y));
  const sortedB = [...bIds].sort((x, y) => Number(x) - Number(y));
  const interleaved = sortedB.some(
    (id) => Number(id) > Number(sortedA[0]) && Number(id) < Number(sortedA[sortedA.length - 1])
  );
  return { interleaved, sortedA, sortedB };
}

/** Finds a seeded credential row by the `label` it was created with. */
function byLabel(rows, label) {
  const row = rows.find((r) => r.label === label);
  if (!row) {
    throw new Error(
      `No fixture row labelled "${label}" — available: ${rows.map((r) => r.label).join(', ')}`
    );
  }
  return row;
}

module.exports = {
  SYSTEM_ROLES,
  PASSWORD_HASH,
  tokenHash,
  hoursFromNow,
  byLabel,
  seedTwoTenants,
  seedPlatformUser,
  expectInterleavedIds,
};
