# Discounts, comps and vouchers: design (awaiting "go")

Status: design only. No code has been edited. Source of the need: product_audit_report.md (roadmap item 3; gap-table row "Discounts, comps, vouchers, promotions"; negative tips/charges were the loophole, now closed by F-02/F-03).

## 1. Findings that shape the design

- No discount concept exists. Every check is priced from one `baseAmount`, computed independently in: `previewSettlement` (pos/service.js ~1271), `settleOrder` (~1407), `prepareRegisterPayment` (~1652), `finalizePosOrderCardCapture` (cashiering/service.js ~949), QR ordering (not touched), supermarket `recordReceiptedSale` / `priceCart` / capture re-price, and pos/sales-report.js. A discount therefore goes into ONE shared helper that all those sites call.
- The hotel golden suite dumps `SELECT *` of `pos_order_settlements`, `pos_order_items`, `pos_orders`, `payments` and folio lines. Any new column on those tables (even null) changes all 14 snapshots. So: NEW TABLES ONLY, and new response keys appear only when a discount exists.
- The approval token binds action + target record + person at the till + approver, but NOT a value. A token approved for 10% could be spent on 100%. The design binds the value by making the approval target a pre-created `discounts` row (no approvals schema change).
- Tax engine: `computeChargeWithTax({baseAmount, taxVersions})`. Passing a discounted base is enough; the engine and its frozen tests are not edited.
- Card/NQR/online-supermarket intents price server-side and the claim step enforces an exact `compareMoney(payment.amount, total)` (`amount_mismatch`). Because the intent and the settle both use the shared helper, a discount stays consistent; a discount changed after the intent forces "restart the payment" (existing behaviour).

## 2. Tax and service charge (choice to confirm)

Default: the discount is subtracted from `baseAmount` BEFORE `computeChargeWithTax`.
- VAT is computed on the discounted amount, for exclusive and inclusive tax. This matches Nigerian invoice practice: a trade discount shown on the invoice reduces the taxable value, VAT follows the consideration actually charged.
- Service charge is computed on the net after discount (it already follows the tax engine's net).
- Comps (100%) give 0 VAT and 0 service charge. Whether a staff meal or gift should still attract VAT is an accountant question; the alternative (tax on the pre-comp value) is a one-line change in the helper if wanted.
- The settlement's `subtotal` is therefore the discounted net, so cash-up expected cash, reconciliation, the sales report and the department P&L all become net of discounts automatically. Gross and discount are stored in `settlement_discounts`.

## 3. Schema (new tables only; every one scoped)

All PROPERTY_SCOPED unless noted; composite (tenant_id, property_id, id) parent keys where referenced.

1. `discount_reasons`: id, code (unique per property), name, kind (`discount` | `comp` | `both`), status (`active` | `archived`).
   Seeded defaults: staff_meal (comp), complaint, managers_gift (comp), promo, damaged_goods.
2. `discount_limits`: role_code, max_percent (DECIMAL(5,2)); UNIQUE(property, role_code). Missing row = built-in default (never "off"), same precedent as notification_role_rules.
3. `discounts` (the request/grant; carries the rule, never trusted money):
   id, outlet_id, pos_order_id (nullable), pos_order_item_id (nullable, line scope), scope (`order` | `line`), kind (`discount` | `comp` | `voucher`), type (`percent` | `fixed`), value (DECIMAL(12,2); percent or amount as entered), reason_id, voucher_id (nullable), status (`pending_approval` | `active` | `removed` | `applied` | `expired` | `rejected`), applied_by_user_id, approved_by_user_id, approval_id, requested_at, expires_at, plus for the supermarket cart-bound form `menu_item_id` (nullable) and `consumed_at`.
   Pending rows are excluded from pricing. `applied` means frozen into a settlement.
4. `settlement_discounts` (frozen amounts, one row per discount per settlement): settlement_id, discount_id, scope, kind, type, value, base_before (gross), amount (the money actually taken off, derived by the server), reason_id and reason name snapshot, applied_by, approved_by, voucher_code snapshot, outlet_id, business_date, voided_at. Reports, receipts, refunds read this; nothing recomputes it.
5. `vouchers`: id, code (stored upper-cased, UNIQUE per property), type, value, valid_from, valid_to, max_total_uses (nullable = unlimited), used_count, min_spend, status (`active` | `paused` | `archived`).
6. `voucher_outlets`: voucher_id, outlet_id (no rows = all outlets).
7. `voucher_redemptions`: voucher_id, settlement_id, discount_id, amount; UNIQUE(voucher_id, settlement_id).

Registered in table-scopes.js, purge-plan.js (children first), tests/helpers/entities.js + fixtures (a row per tenant, so the generic ISO suite applies). Export default includes them (no secrets).

## 4. Calculation rules (server only)

The client sends only: scope, type (percent|fixed), value as a string, reason id, optional voucher code, optional line id. Never an amount, percent result or total.
- Validation like tip/charge fixes: strings matching `^\d+(\.\d{1,2})?$`, no sign/exponent/separators/JSON numbers, percent in (0,100], fixed > 0, ceiling (`MAX_DISCOUNT_AMOUNT`, env, garbage falls back), reason mandatory and active, reason kind must allow the discount kind. 400 `VALIDATION_INVALID_DISCOUNT`.
- Order: line discounts first, each capped at its line total; then at most ONE order-level discount (manual OR voucher, no stacking of the two) on the remaining base. Fixed is capped at the base, so a total can never go negative; a discount never exceeds the value it applies to.
- Rounding: percent amount = round-half-up to 2 decimals via shared money helpers (BigInt cents), same as service charge.
- Splits: an order-level discount is allocated across split groups proportionally to each group's base with the existing largest-remainder helper (shared/line-allocation.js), so group discounts sum exactly. A line discount belongs to its line's group.
- Item void before settlement: totals are derived at settle time, so the discount re-derives (percent shrinks; fixed is capped to the remaining base; a line discount on a voided line becomes inactive).
- Helper: `shared/discount-pricing.js` `applyDiscounts({items, discounts})` returns `{gross, discountTotal, baseAmount, perDiscount[]}`; with no discounts `baseAmount` equals today's value exactly (golden-safe).

## 5. Approval mechanism

Reuses the existing manager-PIN approval registry; adds actions, not schema.
1. Cashier requests a discount (`POST /pos/orders/:id/discounts`, idempotent). Server computes the EFFECTIVE percent (fixed is converted to % of its base) and compares with the actor's role limit (`discount_limits`, default if no row).
2. Within the limit and not a comp: status `active` immediately, audit row `discount_applied`.
3. Above the limit, or any comp, or role without limit: status `pending_approval`. The UI opens ManagerApprovalDialog with action `pos.discount_approval` and target = the discount id, so the approval binds this exact type/value/reason/scope.
4. `POST /pos/discounts/:id/approve` carries `X-Manager-Approval`; `claimApproval` runs inside the transaction (one conditional UPDATE, single use, 2 minutes, bound to the cashier and the discount). Approver must hold `discount.approve`, their OWN role limit must cover the effective percent, and a comp needs `discount.comp`. Result: `active`, `approved_by`, audit `discount_approved`. A rolled-back request leaves the token unused.
5. A manager applying their own discount over their own limit still types their own PIN (existing rule). Rejected approvals audit `discount_rejected`.
6. Supermarket: there is no order before payment, so the same `discounts` row is created cart-bound (outlet + menu_item for line scope, no order). `createSale` carries the grant id; it is claimed in the sale transaction by a conditional UPDATE (`consumed_at IS NULL`, requester = cashier, outlet match, not expired, 30 min). A retry with the same Idempotency-Key replays the stored response and never re-claims; a second sale cannot reuse the grant.
7. Registry additions: `pos.discount_approval`, `supermarket.discount_approval`, both requiring `discount.approve` on the approver.
8. Who approved is on the `discounts` row, `settlement_discounts` and the audit rows. The existing gated actions' audit rows are not touched.

## 6. Permission keys (migration-seeded; skip purging/purged tenants)

| Key | Default roles |
|---|---|
| discount.apply | pos_operator, manager, admin, super_admin |
| discount.approve | manager, admin, super_admin |
| discount.comp (apply/approve comps) | manager, admin, super_admin |
| discount.manage (reasons, limits, vouchers) | manager, admin, super_admin |
| reports.view_discounts | manager, admin, super_admin |

Updated: migration backfill (copy of 20261202090000), default-rbac.js, seeds/01_dev_tenants.js, tests/helpers/fixtures.js.

## 7. Default limits (editable per property in Setup)

pos_operator 5%; manager 25%; admin 50%; super_admin 100%. Comps always need approval from a holder of `discount.comp`. The limit is on the EFFECTIVE percent of what the discount applies to. Reasons seeded as in section 3.

## 8. Voucher redemption and concurrency

- A voucher is applied to an order as a `discounts` row (kind `voucher`) after validation (active, dates, outlet scope, min spend on the current base, uses remaining). Validation at apply is advisory.
- It is CONSUMED only at settlement, inside the settle transaction, after the order row lock: one conditional `UPDATE vouchers SET used_count = used_count + 1 WHERE id=? AND status='active' AND valid_from<=? AND valid_to>=? AND (max_total_uses IS NULL OR used_count < max_total_uses)`; affected rows must be 1, else 422 `BUSINESS_RULE_VOUCHER_EXHAUSTED` (or expired/inactive/min spend) and nothing is written. `voucher_redemptions` UNIQUE(voucher, settlement) is the second guard. Min spend and dates are re-checked at settle.
- Retries/double clicks: settle already runs under runIdempotentMutation and the order lock, so a replay returns the stored result and a second concurrent settle sees the order not open. Real-connection concurrency test: N simultaneous settlements of N orders carrying a voucher with max uses = 1 -> exactly one wins; usage never exceeds the limit.
- Voiding a settlement gives the use back (decrement guarded `used_count > 0`) and marks the redemption/settlement_discounts voided.
- Per-guest limits are NOT built (the till has no customer identity).

## 9. Refunds, voids and splits on a discounted order

- Refund = amount actually paid, never more: the payment's captured amount is the discounted total, and `refundPayment` already caps at the captured remainder. Tests: full refund of a discounted card sale refunds exactly the discounted amount; refund above it is rejected; the settlement void keeps `settlement_discounts` as history and restores the voucher use.
- Existing behaviour retained: a gateway refund voids the whole linked settlement (even partial); settlement void refuses gateway-paid settlements; supermarket void/online refund flows unchanged except they restore the voucher use.
- Splits: one settlement per group; each group stores its own `settlement_discounts` share; group shares sum exactly to the order-level discount.
- Comps still deplete stock and appear in cost of sales (the item was given away); revenue is zero, so department P&L shows the cost against nil revenue. Called out in the Discounts report.

## 10. Reporting and shift cash-up

- New Reporting tab "Discounts & comps" (`reports.view_discounts`): totals and counts by reason, applied-by user, approved-by user, outlet, kind (discount/comp/voucher), voucher code and period; discount % of gross sales; drill-down list; CSV. Built from `settlement_discounts` for non-voided settlements.
- POS Sales report and supermarket sales/report: discount columns and a summary line, present only when discounts exist (golden-safe).
- Shift close: `closeShift` response and the Shifts cash-up card gain `discounts: {count, total, comps}` only when nonzero. Expected cash already reflects the discounted `subtotal`. Blind count is unchanged.
- Business Summary and reconciliation: unchanged and still equal to the kobo (their sales-before-tax is net of discounts). Discounts live in their own report.
- Audit rows for every grant, approval, rejection, removal and redemption (`discount_applied`, `discount_pending`, `discount_approved`, `discount_rejected`, `discount_removed`, `voucher_redeemed`, `voucher_redemption_reversed`), with actor, reason, before/after.

## 11. Screens

- Register (RegisterTab): Discount action on the ticket and per line; dialog with type, value, reason, voucher code; pending-approval state opens ManagerApprovalDialog; ticket shows Gross, "Discount (reason) -X", Tax, Service, Total; split forms show per-group discount; receipt snapshot includes discount lines. Hidden without `discount.apply`.
- Supermarket (SupermarketScreen): Discount action in the cart footer and per line, voucher code field, discount line in the cart totals, receipt (PrintDocument), sales list and SalesTotals.
- Setup -> new "Discounts" card (`discount.manage`): reasons CRUD, role limits, vouchers CRUD with usage.
- Reporting: new tab above. POS Sales tab and Shifts result: conditional discount fields.
- Not touched: QR guest ordering and guest portal.

## 12. Migrations

1. `..._create_discounts_tables`: the seven tables (down drops in dependency order; refuses if redemptions exist, matching earlier convention).
2. `..._seed_discount_permissions_and_reasons`: permission rows + role grants (skip purging/purged), default reasons and limits for existing properties; idempotent; down removes grants/keys.
Rehearsal: up/down/up on prod-2026-10-06-0016.sql with CHECKSUM TABLE before/after; only knex_migrations, permissions, role_permissions and the new tables change.

## 13. Tests (red first)

Pure helper (rounding, caps, allocation sums, no negative totals); validation matrix; tax interaction (exclusive, inclusive, supermarket row, 100% comp); approval (limit, above-limit pending, comp, value-bound token cannot approve another discount, approver limit, wrong PIN); voucher (all rule failures, atomic max-uses under real concurrency, void restores); settle/preview/card-intent consistency and `amount_mismatch`; refund/void/split; shift expected cash; reports; cross-tenant isolation (tenant B cannot see or redeem tenant A's vouchers/discounts); RBAC; hotel golden suite 14/14 byte-identical, tax-engine regression unchanged. Each guard mutation-checked. Frontend tests for Register, Supermarket, Setup card, Reporting tab. Full backend/frontend suites, lint, stylelint, build.

## 14. Deliberately left for a follow-up

- Hotel folio discounts/comps (folios keep `cashiering.void_line` adjustments; later reuse reasons catalogue + approval).
- Vouchers on Paystack paths (Register card/NQR, online supermarket) since they would need a hold at checkout start and release on cancel/expiry; manual discounts ARE allowed there.
- Per-guest voucher limits; gift cards; auto-applied promotions and happy-hour pricing; QR guest ordering discounts.
- Tax on pre-comp value (only if the accountant requires it).

## 15. Decisions requested before "go"

1. Comp tax/service: 0 (default) vs tax on pre-comp value.
2. Manual discounts on Paystack paths allowed, vouchers deferred there: OK?
3. Stacking: line discounts + one order-level discount; no manual+voucher together: OK?
4. Default limits 5/25/50/100%: OK?
5. Hotel folio as a follow-up PR: OK?
