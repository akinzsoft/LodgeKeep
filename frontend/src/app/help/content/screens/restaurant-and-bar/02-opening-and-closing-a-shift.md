---
images:
  - file: screens/pos/shifts.webp
    alt: The Shifts tab with the Open a shift form and the shift history table
    caption: POS → Shifts. Open a shift at the top, history below
---
# Opening and closing a shift
## What it is for
A **shift** is one person's session on one till (terminal). You count the cash drawer when it ends, and LodgeKeep compares your count with the cash it expected to find. The difference is recorded against the shift.
## Who can do this
- Opening a shift, and closing your own, needs the permission `pos.operate`. By default that is the POS operator, manager, admin and super admin roles.
- Closing **someone else's** shift needs `pos.manage`, which by default is manager, admin and super admin. A reason is required.
- If you only work at some outlets, you can only open a shift on a terminal at those outlets.
## Where to click
POS → **Shifts**.
## Fields that matter
1. **Open a shift.** Choose the **Terminal** and type the **Opening float** (the cash already in the drawer). Press **Open shift**. A terminal that already has an open shift is not offered, because a terminal can only have one open shift at a time.
2. **Sell as normal** in the Register. Selling does not stop you if no shift is open, but a sale made while no shift is open on that terminal belongs to no shift, so it will not be in any cash count.
3. **Close your shift.** Find your shift in the history table and press **Close (blind count)**.
4. **Count the drawer** and type the cash in **Counted cash**. The screen does not show what it expected until you submit, on purpose. Press **Submit count**. This cannot be undone.
5. **Read the result.** The Cash-up result shows **Counted**, **Expected** and **Variance**. Variance is what you counted minus what was expected. A negative number means the drawer is short, and a positive number means it is over.
6. If any discounts or comps were given in the shift, the result also shows **Discounts given** and **Comps given**. The cash figures above them already take them into account.
## What counts as expected cash
- Expected cash is the opening float plus the **cash** sales in this shift (the price, tax, service charge and any tip). A cash sale that was voided is left out.
- Card, NQR, Card (external terminal) and Charge to room sales are **not** counted. No cash went into the drawer for them.
## Closing someone else's shift
If a colleague has gone home without closing, a manager presses **Close on their behalf**, types a reason (it asks for "Reason for closing" that person's shift), counts the drawer and submits. Other people do not see this button on someone else's shift.
## You are done when
The shift shows a **Closed** time with your Counted, Expected and Variance in the history table. If the variance is not what you expected, tell your manager before the next shift opens.
## What can go wrong
- If the Open shift form offers no terminal, every terminal already has an open shift. Close the old one first, or ask a manager to.
- A terminal must exist before you can open a shift. See [POS outlets, menu, terminals and QR codes](help:getting-started/05-pos).
- For where shifts sit in the day, see [The daily routine](help:getting-started/08-daily-routine).
