# Check for duplicate folios / doubled room charges (audit finding H-2)

Before the H-2 fix, two concurrent "open folio" calls (or an open racing check-in) on one reservation could create a
second folio and post each night's room charge twice. This is a **read-only** check to see whether it ever happened to a
real tenant. It contains only `SELECT`s and changes nothing. Save the block below as a file (the repo ignores `*.sql`)
and run it on the VPS:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml exec -T mysql \
  sh -c 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' < h2-duplicate-folio-check.sql
```

Reading the result: a reservation can legitimately have several folios (split billing). Query 2 (the same night
room-charged twice) is the strong signal; query 1 with `plain_folios >= 2` and a small `seconds_apart` points at the race.
If anything appears, do not fix it by hand: send the rows over and the correction will be made through the app (void the
duplicate lines) so the audit trail stays honest.

```sql
-- READ-ONLY. Finds reservations that may have been hit by the open-folio race
-- (security audit finding H-2). Run on the VPS, e.g.:
--   docker compose --env-file .env.production -f docker-compose.prod.yml exec -T mysql \
--     sh -c 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' < docs/runbooks/h2-duplicate-folio-check.sql
-- Only SELECTs. Nothing here changes data.
--
-- NOTE: a reservation can legitimately have several folios (split billing: an
-- "additional folio" billed to a company or another guest). So query 1 shows
-- the facts to judge by, and query 2 is the stronger signal.

-- 1) Reservations with more than one folio, with the facts needed to judge:
--    the race creates a SECOND folio within a second or two of the first, with
--    no billed_to / company, and the same nights charged on both.
SELECT
  r.tenant_id,
  r.property_id,
  r.id                         AS reservation_id,
  r.confirmation_number,
  r.status                     AS reservation_status,
  COUNT(DISTINCT f.id)         AS folio_count,
  MIN(f.created_at)            AS first_folio_at,
  MAX(f.created_at)            AS last_folio_at,
  TIMESTAMPDIFF(SECOND, MIN(f.created_at), MAX(f.created_at)) AS seconds_apart,
  SUM(f.billed_to IS NULL AND f.company_profile_id IS NULL)   AS plain_folios
FROM reservations r
JOIN folios f
  ON f.tenant_id = r.tenant_id AND f.property_id = r.property_id AND f.reservation_id = r.id
GROUP BY r.tenant_id, r.property_id, r.id, r.confirmation_number, r.status
HAVING COUNT(DISTINCT f.id) > 1
ORDER BY seconds_apart ASC, r.tenant_id, r.id;
-- Suspicious: plain_folios >= 2 and a small seconds_apart.

-- 2) The same night room-charged more than once for one reservation (across
--    folios or within one folio). Non-voided "room_charge" lines only; the
--    "Late room charge —" lines are a separate, intentional mechanism and are
--    excluded.
SELECT
  r.tenant_id,
  r.property_id,
  r.id                         AS reservation_id,
  r.confirmation_number,
  l.business_date,
  COUNT(*)                     AS room_charge_lines,
  COUNT(DISTINCT l.folio_id)   AS folios_involved,
  GROUP_CONCAT(l.folio_id ORDER BY l.folio_id)  AS folio_ids,
  GROUP_CONCAT(l.amount   ORDER BY l.folio_id)  AS amounts
FROM folio_line_items l
JOIN folios f
  ON f.id = l.folio_id AND f.tenant_id = l.tenant_id AND f.property_id = l.property_id
JOIN reservations r
  ON r.id = f.reservation_id AND r.tenant_id = f.tenant_id AND r.property_id = f.property_id
WHERE l.type = 'room_charge'
  AND l.voided_at IS NULL
  AND l.description NOT LIKE 'Late room charge%'
GROUP BY r.tenant_id, r.property_id, r.id, r.confirmation_number, l.business_date
HAVING COUNT(*) > 1
ORDER BY r.tenant_id, r.id, l.business_date;

-- 3) Roll-up per tenant, to see at a glance whether any real tenant is affected.
SELECT tenant_id, COUNT(DISTINCT reservation_id) AS affected_reservations
FROM (
  SELECT r.tenant_id, r.id AS reservation_id
  FROM folio_line_items l
  JOIN folios f ON f.id = l.folio_id
  JOIN reservations r ON r.id = f.reservation_id
  WHERE l.type = 'room_charge' AND l.voided_at IS NULL AND l.description NOT LIKE 'Late room charge%'
  GROUP BY r.tenant_id, r.id, l.business_date
  HAVING COUNT(*) > 1
) dup
GROUP BY tenant_id
ORDER BY tenant_id;
```
