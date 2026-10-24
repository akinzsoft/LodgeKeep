---
images:
  - file: screens/pos/sales.webp
    alt: The Sales tab with the sales summary and the Settled tabs table
    caption: POS → Sales. Totals, settled tabs and the Refund column
  - file: screens/reporting/payment-reconciliation.webp
    alt: The Payment reconciliation report listing every payment in a date range
    caption: Reporting → Payment reconciliation. Every payment, refunds included
---
# Voids and card refunds from Sales
## What it is for
The Sales tab shows what the Register took. It is also where a manager refunds a card sale that was already paid, and where a refund that has not finished can be followed up.
## Who can do this
- The **Sales** tab needs the permission `pos.manage`. By default that is manager, admin and super admin.
- The **Refund** button needs `cashiering.void_line` as well. By default that is cashier, manager, admin and super admin.
- Every refund needs a **manager's approval PIN**. The manager who approves must hold `pos.manage`, and must have set a PIN under My Profile.
- **Clear stuck refund** needs `cashiering.refund_clear`. By default that is manager, admin and super admin.
## Where to click
POS → **Sales**. Choose the dates and, if you wish, an **Outlet**, then press **Run report**.
## Fields that matter
1. **Voiding before payment.** An item or a whole tab that has not been paid is removed in the Register, with a reason. See [Selling at the Register](help:screens/restaurant-and-bar/01-selling-at-the-register). The Sales tab has no button to void a sale that is already settled.
2. **Refund a card sale.** In **Settled tabs**, find the tab and press **Refund** in its Refund column. This is only for sales paid by Card or NQR through Paystack.
3. **Check the facts.** The window shows the tab, the **Amount to refund** and the **Paystack reference**. The refund is always the whole amount paid. There is no box to type a different amount.
4. **Say why.** Under "Why is this being refunded?" choose one of: Customer requested a refund, Wrong item or overcharged, Duplicate payment, Service or quality complaint, Order cancelled, or Other. If you choose Other you must say why in a few words.
5. **Get the manager's PIN.** Press **Continue to manager PIN**. A manager picks their own name, types their 6-digit PIN and a reason, then presses **Approve refund**. The message says the refund goes to Paystack and cannot be undone.
6. **Wait for Paystack.** You will see "Refund sent to Paystack." The tab then shows **Refund pending** until Paystack finishes, and **Refunded** once it has. LodgeKeep asks Paystack again by itself. The screen cannot tell you when the money reaches the customer's bank.
## If the Refund button is greyed out
The reason is written beside it. The ones you may see are:
- "A refund for this sale is waiting on Paystack."
- "This sale has already been refunded."
- "This sale was refunded in part. Refunding the rest is not available here yet."
- "This sale is no longer standing."
- "The card payment was not captured."
## Card payments to refund
This list shows card money that Paystack took but that no sale is using, for example a guest who paid after their tab was removed. Press **Refund**, and a manager enters their PIN and a reason in the same way.
## What it looks like in the reports
- The original sale stays in the totals on the day it was sold. The refund is a separate line on the day the refund was processed. Past days do not change.
- The Sales summary then shows **Refunds** and **Net sales**, and a table called **Refunds processed in this period** lists each one with the day it counts on and the day it was sold. The tab in Settled tabs is marked "(refunded)".
- A sale refunded in full no longer counts in top-selling items or profit, and the stock it used is put back.
- In Reporting → **Payment reconciliation** the refund is listed as its own line on the day it was processed. That report needs the permission `reconciliation.view` (by default manager, admin and super admin).
## A refund that is stuck
Some refunds stay "waiting on Paystack" because Paystack was not reachable or its answer was unclear. They are listed under **Card refunds waiting on Paystack**, with a note of what LodgeKeep found when it last checked.
1. Do nothing at first. LodgeKeep keeps checking.
2. If it still has not finished, a manager may see **Clear stuck refund**. It only appears after LodgeKeep has checked Paystack several times without getting an answer. By default that is at least 3 checks and 30 minutes.
3. Press it. A manager enters their PIN and a reason. LodgeKeep asks Paystack one more time. If Paystack did refund the customer, the refund is recorded. If not, the refund is cancelled on our side so the amount can be refunded another way.
## You are done when
The tab shows **Refunded**, or you can see **Refund pending** and know it is waiting on Paystack. The Refunds line in the Sales summary matches what you expect.
## What can go wrong
- The PIN is refused, or no manager can be chosen: see [A refund or void asks for approval](help:common-problems/approval-pin-and-refunds).
- Card payments do not work at all: see [Online payments do not start](help:common-problems/online-payments-do-not-start).
