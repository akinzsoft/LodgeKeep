# Paystack test → live cutover

Applies to: one Paystack account used for both guest/POS card payments and subscription billing.
This file contains **no secrets**. Never paste a key into a shell argument, a ticket, a chat or a commit.

## How it is wired (so the steps make sense)

| | Guest / POS / QR / supermarket payments | Subscription billing |
|---|---|---|
| Key lives in | `platform_payment_integrations.secret_key_encrypted` (NGN row, AES-256-GCM with `ENCRYPTION_KEY`) | `BILLING_PAYSTACK_SECRET_KEY` in `.env.production` |
| How to change | `backend/scripts/set-platform-paystack-key.js` (step 3) | edit `.env.production`, recreate the backend |
| Read at | every call (no restart needed) | process start (restart needed) |

`PAYSTACK_SECRET_KEY` in `.env.production` is **not** read at runtime; it only seeded the row once, at migration time. Changing it does nothing.

Paystack allows **one** live webhook URL per account. That URL is
`https://lodgekeep.ng/api/v1/webhooks/paystack`. It serves both integrations: events whose reference starts `billing-` go to subscription billing, everything else to guest/POS payments. `/api/v1/webhooks/billing-paystack` keeps working as an alias into the same dispatcher. A request that no configured key signs is refused with **401** (and kept as unverified evidence); a validly signed event we hold nothing for gets 200 and one log line with event type and reference only.

Shell setup used below (same pattern as `RESTORE.md`):

```bash
cd /path/to/lodgekeep
export C="docker compose --env-file .env.production -f docker-compose.prod.yml"
# Run read-only SQL like this (heredoc keeps quoting simple):
#   $C exec -T mysql sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysql -uroot "$MYSQL_DATABASE"' <<'SQL'
#   ...statements...
#   SQL
```

---

## 1. Pre-flight (read-only)

Nothing below writes. Save the output; you will compare after cutover.

### 1.1 Subscriptions holding a (test) card token

Every one of these will fail to charge against a live key. Each real tenant must re-add a card after cutover, otherwise dunning runs (day 0/3/7/10/14) and the tenant is auto-suspended after about 14 days. Manual (cash/transfer) subscriptions are skipped by the sweep and are not affected.

```bash
$C exec -T mysql sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysql -uroot "$MYSQL_DATABASE"' <<'SQL'
SELECT t.id AS tenant_id, t.slug, t.status AS tenant_status,
       s.status AS subscription_status, s.payment_method_provider,
       s.payment_method_brand, s.payment_method_last4, s.current_period_end,
       (s.payment_method_authorization_code IS NOT NULL) AS has_card_token
FROM subscriptions s
JOIN tenants t ON t.id = s.tenant_id
WHERE s.payment_method_provider = 'paystack'
  AND s.payment_method_authorization_code IS NOT NULL
ORDER BY t.id;
SQL
```

### 1.2 Payments still open at Paystack

```bash
$C exec -T mysql sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysql -uroot "$MYSQL_DATABASE"' <<'SQL'
SELECT id, tenant_id, property_id, settlement_target, status, amount, currency, provider_reference, created_at
FROM payments
WHERE provider = 'paystack' AND parent_payment_id IS NULL AND status IN ('INITIATED','PENDING')
ORDER BY created_at;
SQL
```

### 1.3 Supermarket online sales waiting for payment

```bash
$C exec -T mysql sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysql -uroot "$MYSQL_DATABASE"' <<'SQL'
SELECT id, tenant_id, property_id, outlet_id, payment_id, status, expected_total, currency, expires_at, created_at
FROM supermarket_sale_intents
WHERE status IN ('pending','needs_review')
ORDER BY created_at;
SQL
```

### 1.4 Refunds in flight (Paystack refund intents not yet finished)

```bash
$C exec -T mysql sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysql -uroot "$MYSQL_DATABASE"' <<'SQL'
SELECT id, tenant_id, property_id, parent_payment_id, status, amount, currency, provider_reference, created_at
FROM payments
WHERE provider = 'paystack' AND parent_payment_id IS NOT NULL AND status IN ('INITIATED','PENDING')
ORDER BY created_at;
SQL
```

### 1.5 Webhook events not yet decided

```bash
$C exec -T mysql sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysql -uroot "$MYSQL_DATABASE"' <<'SQL'
SELECT 'guest' AS kind, id, tenant_id, provider_event_id, verified, outcome, attempt_count, created_at
FROM payment_webhook_events WHERE processed_at IS NULL AND verified = 1
UNION ALL
SELECT 'billing', id, tenant_id, provider_event_id, verified, outcome, attempt_count, created_at
FROM subscription_webhook_events WHERE processed_at IS NULL AND verified = 1
ORDER BY created_at;
SQL
```

### 1.6 Subaccounts that must be re-created in live mode, and who owns them

**Every** subaccount in this list was created under the test key, so none of them exists in live mode. Each must be re-created in live mode; the old test ones are not reused. Expect rows for alpha-motel (tenant 1) **and STICAL (tenant 2)**: STICAL has a property subaccount (Moniepoint ending 0847, account holder PASCAL ODOGWU, created 2026-10-04) even though it takes no online payments today. Do not rely on memory about who has one; the query below is the source of truth.

```bash
$C exec -T mysql sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysql -uroot "$MYSQL_DATABASE"' <<'SQL'
SELECT 'property' AS level, t.id AS tenant_id, t.slug AS tenant, p.name AS property, NULL AS outlet,
       s.subaccount_code, s.bank_name, s.account_number_last4, s.is_active
FROM property_payment_subaccounts s
JOIN properties p ON p.id = s.property_id AND p.tenant_id = s.tenant_id
JOIN tenants t ON t.id = s.tenant_id
UNION ALL
SELECT 'outlet', t.id, t.slug, p.name, o.name,
       s.subaccount_code, s.bank_name, s.account_number_last4, s.is_active
FROM pos_outlet_payment_subaccounts s
JOIN pos_outlets o ON o.id = s.outlet_id AND o.tenant_id = s.tenant_id
JOIN properties p ON p.id = o.property_id AND p.tenant_id = o.tenant_id
JOIN tenants t ON t.id = s.tenant_id
ORDER BY tenant_id, level;
SQL
```

Also check the current key kind (prints only true/false, never the key):

```bash
$C exec -T backend node scripts/set-platform-paystack-key.js --check
```

### 1.7 Stranded Register card payments

Before cutover the Register must have none stranded. Check both:

- In the app, the Register banner and the bell show no stranded card payments.
- No Paystack payment is `INITIATED`/`PENDING` and older than 30 minutes (this is the 1.2 query with an age filter; it must return no rows):

```bash
$C exec -T mysql sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysql -uroot "$MYSQL_DATABASE"' <<'SQL'
SELECT id, tenant_id, property_id, settlement_target, status, amount, currency, provider_reference, created_at
FROM payments
WHERE provider = 'paystack' AND parent_payment_id IS NULL
  AND status IN ('INITIATED','PENDING')
  AND created_at < NOW() - INTERVAL 30 MINUTE
ORDER BY created_at;
SQL
```

Anything listed is a test-mode leftover that live mode cannot verify. Close it with `backend/scripts/close-stale-paystack-payments.js` (`--before` is required; dry-run by default, `--apply` closes the payments as CANCELLED with an audit row each and never refunds). Run the dry run first and read what it would close. That script and the Register banner/bell come from the stale-payments-cleanup and stranded-register-payments-alert branches: confirm both are merged and deployed before relying on this step.

### 1.8 Property timezone and business date

Every property must have a real IANA timezone (for example `Africa/Lagos`) and a current business date within one day of today, otherwise the first live day's charges, premature-run guard and overdue-audit alert misbehave.

```bash
$C exec -T mysql sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysql -uroot "$MYSQL_DATABASE"' <<'SQL'
SELECT t.slug AS tenant, p.id AS property_id, p.name, p.timezone, p.current_business_date,
       DATEDIFF(CURDATE(), p.current_business_date) AS days_behind
FROM properties p JOIN tenants t ON t.id = p.tenant_id
ORDER BY t.id, p.id;
SQL
```

- Timezone: SQL cannot tell a valid IANA name from a typo, so run `$C exec -T backend node scripts/fix-property-timezones.js --dry-run`. It must report nothing unrecognised (exit 0). Fix any it lists before cutover; `--apply` writes only `properties.timezone` and an audit row per property.
- Business date: `days_behind` must be 0 or 1 (and not negative) for every property. A larger gap means Night Audit has not been run; it is a manual, one-day-per-run action, so catching up is a deliberate step by the property, not part of this cutover. Resolve or knowingly accept it before going live.

---

## 2. Backups (before touching anything)

```bash
umask 077
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p ~/paystack-cutover-$STAMP && cd ~/paystack-cutover-$STAMP

# Full DB dump
$C exec -T mysql sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysqldump -uroot --single-transaction --routines --triggers --events --no-tablespaces "$MYSQL_DATABASE"' > db.sql
tail -1 db.sql        # must say "-- Dump completed"

# Env file (holds BILLING_PAYSTACK_SECRET_KEY, ENCRYPTION_KEY: keep it private, delete when done)
cp /path/to/lodgekeep/.env.production env.production.bak

# The current (encrypted) guest-key row, for rollback
$C exec -T mysql sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysqldump -uroot --no-tablespaces --skip-add-drop-table --no-create-info "$MYSQL_DATABASE" platform_payment_integrations' > platform_payment_integrations.sql
```

Also note where the **test** secret key can be re-copied from (Paystack dashboard, test mode) in case you must roll back; the encrypted copy above is useless without `ENCRYPTION_KEY`.

---

## 3. Cutover order

1. **Drain.** From the pre-flight lists: let open payments finish or fail, cancel/expire stale supermarket sales, clear or finish in-flight refunds (a manager can use *Clear stuck refund* after 3 checks and 30 minutes), let section 1.5 reach zero. Do this in a quiet period.
2. **Update the guest/POS key** (no restart needed). The key travels only through an env var, never as an argument:
   ```bash
   read -rs NEW_PAYSTACK_SECRET_KEY && export NEW_PAYSTACK_SECRET_KEY   # paste the sk_live_... key; nothing is echoed
   $C exec -T -e NEW_PAYSTACK_SECRET_KEY backend node scripts/set-platform-paystack-key.js --dry-run
   # expect: dry run: would update 1 row(s). Nothing was changed.
   $C exec -T -e NEW_PAYSTACK_SECRET_KEY backend node scripts/set-platform-paystack-key.js
   # expect: rows updated: 1
   $C exec -T backend node scripts/set-platform-paystack-key.js --check
   # expect: live key: true / test key: false
   ```
   The script refuses anything not starting `sk_live_` (unless `--allow-test`, used for rollback), writes only the NGN paystack row, and prints only counts and true/false.
3. **Set the billing key.** Edit `.env.production`: `BILLING_PAYSTACK_SECRET_KEY=<the same live key>` (and `BILLING_PAYSTACK_PUBLIC_KEY` if you use it). Then `unset NEW_PAYSTACK_SECRET_KEY`.
4. **Redeploy the backend** so it picks up the env var, and read the boot log:
   ```bash
   $C up -d backend
   $C logs --tail 80 backend      # healthy start, no "not configured" or decrypt errors
   $C ps                          # backend: healthy
   ```
5. **Register the one live webhook** in the Paystack dashboard: *Settings → API Keys & Webhooks → Live Webhook URL* =
   `https://lodgekeep.ng/api/v1/webhooks/paystack`
   (Paystack has separate test and live webhook fields; set the live one.)
6. **Reachability check** (section 4).
7. **Re-save every property and outlet payout account in live mode** (subaccount codes created under the test key do not exist in live). For each row from 1.6: *Setup → Payments* (property) and *Setup → outlet → Online payout account* (outlet), entering the real bank details. Then press **Verify with Paystack** on each outlet and check bank/last-4 match. A property subaccount is replaced in place; an outlet one adds a new history row.
   - **Confirm each one in the live Paystack dashboard.** After re-saving each property/outlet subaccount, open the live dashboard → *Subaccounts*, find the new subaccount and confirm it shows **verified** and that the account name matches the registered account holder. The first payout on a new or updated subaccount is held until it is verified, so an unverified one delays that tenant's first settlement.
8. **Tenants re-add cards** under *Billing → payment method* (list from 1.1). Tell them before cutover; do it for every real tenant before their next billing date.

### 3.1 Settlement and fees (what to expect and what not to change)

- **Payouts are next business day (T+1)** to each subaccount's bank account. Plan the smoke test (section 5) around that.
- **The hotel bears the Paystack fee** (1.5% + ₦100, the ₦100 waived under ₦2,500, capped at ₦2,000) through `bearer=subaccount` (`PAYSTACK_FEE_BEARER`, default `subaccount`). The platform account is PLANMSYS LTD.
- In the Paystack dashboard the **"Pass transaction fees to customers" toggle must stay OFF**. Turning it on would charge guests more than the amount LodgeKeep recorded, and the amount check would then reject those payments.

---

## 4. Webhook reachability check

```bash
curl -i -X POST https://lodgekeep.ng/api/v1/webhooks/paystack \
  -H 'content-type: application/json' -d '{"event":"ping"}'
```

| Response | Meaning |
|---|---|
| **401** `AUTH_WEBHOOK_SIGNATURE_INVALID` | Correct: reachable, signature required. (One unverified evidence row is stored.) |
| 404 | Routing or domain problem (Caddy / wrong host / old image). Do not register the URL yet. |
| 5xx | Backend or database problem. Read `$C logs backend`. |
| 200 | Unexpected for an unsigned request. Stop and investigate. |

Then use *Send test event* in the Paystack dashboard: it is signed, so expect 200 and a log line `unmatched event ignored: event=... reference=...`.

---

## 5. Smoke tests (real money, small amounts)

1. **Folio payment.** Pick a property whose re-saved subaccount is **your own bank account**. Take a small card payment (for example ₦100) on a folio. Check: a `payment_webhook_events` row with `verified=1` and `outcome='applied'`, the payment is `CAPTURED`, the folio balance moves, and the settlement reaches your bank at Paystack's normal settlement time.
2. **Refund it** in full from the folio. Check the refund row finishes (the webhook or the reconciliation sweep completes it) and the original payment shows REFUNDED and the money returns.
3. **Billing card check.** On a throwaway tenant (not a customer), add a card under Billing. It charges ₦50 (`BILLING_CARD_VERIFICATION_AMOUNT`) and refunds it. Check: a `subscription_webhook_events` row `verified=1`, the card shows on the tenant's Billing screen, the ₦50 is refunded.
4. Optionally one supermarket *Online payment* sale and a void (refund) at an outlet you own.

Useful read-only check after each test:

```bash
$C exec -T mysql sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysql -uroot "$MYSQL_DATABASE"' <<'SQL'
SELECT id, provider_event_id, verified, outcome, attempt_count, created_at FROM payment_webhook_events ORDER BY id DESC LIMIT 5;
SELECT id, provider_event_id, verified, outcome, attempt_count, created_at FROM subscription_webhook_events ORDER BY id DESC LIMIT 5;
SQL
```

---

## 6. What happens to alpha-motel

The guest key is **global**: after cutover every tenant's online card payments go through the live key. alpha-motel's payout subaccounts were all created in test mode (as were STICAL's, see below), so its online checkouts would fail with a Paystack error until its subaccounts are re-created live with its real bank accounts.

Recommendation: after go-live, **deactivate alpha-motel's subaccounts** unless you are using one as your own smoke-test account (section 5). A deactivated subaccount makes checkout refuse cleanly with "payout account not configured" instead of a confusing gateway error. This is a **write**: do it deliberately, per row from 1.6, for example:

```sql
-- confirm the tenant id from 1.6 first; run only on explicit approval
UPDATE property_payment_subaccounts SET is_active = 0 WHERE tenant_id = <alpha-motel tenant id>;
UPDATE pos_outlet_payment_subaccounts SET is_active = 0 WHERE tenant_id = <alpha-motel tenant id>;
```

Its cash, terminal and transfer payments are unaffected. Stical (tenant 2) takes no online payments today but **does** have a property subaccount (Moniepoint ending 0847, PASCAL ODOGWU, created 2026-10-04), which was created in test mode like the others: re-create it live, or deactivate it the same way, before Stical takes any online payment. Isaac (tenant 3) has none.

---

## 7. Rollback

1. Put the test key back in the guest row, from the dashboard's **test** secret key, via the same script:
   ```bash
   read -rs NEW_PAYSTACK_SECRET_KEY && export NEW_PAYSTACK_SECRET_KEY   # the sk_test_... key
   $C exec -T -e NEW_PAYSTACK_SECRET_KEY backend node scripts/set-platform-paystack-key.js --allow-test
   unset NEW_PAYSTACK_SECRET_KEY
   ```
   (Alternative: restore the row from `platform_payment_integrations.sql` taken in step 2, using the same `ENCRYPTION_KEY`.)
2. Restore `BILLING_PAYSTACK_SECRET_KEY` in `.env.production` from `env.production.bak`, then `$C up -d backend`.
3. Re-register the **test** webhook URL if you changed it (test and live URLs are separate in Paystack) and, if you re-saved subaccounts in live mode, re-save them again in test mode (their live codes do not exist under the test key).

What to expect for payments taken **in live mode** before the rollback: they exist at Paystack live but the test key cannot see them. Their webhooks fail verification, `verify`/refund calls say "transaction not found", and the payments stay open or unreconciled locally. Reconcile them by hand against the Paystack live dashboard and refund there. Keep the live window short and the amounts small until you are sure.

---

## 8. Known risks

- **Live subaccount creation is untested.** Only test mode has run. Live Paystack validates bank accounts against the real banking network and Paystack's duplicate-account wording is unknown, so the first live save per property/outlet may show a generic rejection. Do the first one yourself.
- **Stale test card tokens** in `subscriptions` (section 1.1) cannot be charged in live, so dunning starts and the tenant is suspended after about 14 days unless a card is re-added. Contact tenants first.
- **Test payments cannot be refunded in live**, and live refunds of test payments fail. Refunds stuck in flight stay reserved until a manager uses *Clear stuck refund* (after 3 checks and 30 minutes).
- **One URL, one account.** If you ever give billing its own Paystack account, its events will need their own live webhook URL. The `/api/v1/webhooks/billing-paystack` alias is kept for that case.
- A webhook signed by one of our keys but whose reference belongs to the other integration is acknowledged (200) and ignored, not applied.
- A key rotation script run against the wrong container prints counts only; always run `--check` afterwards.
