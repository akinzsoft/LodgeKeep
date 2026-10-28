---
images:
  - file: screens/housekeeping/board.webp
    alt: The Housekeeping Board with the room assignments and the Assign a dirty room form
    caption: Housekeeping → Board
  - file: screens/housekeeping/discrepancies.webp
    alt: The Discrepancies tab with an Open filter and a Resolve button
    caption: Housekeeping → Discrepancies
  - file: screens/housekeeping/out-of-order.webp
    alt: The Out of Order tab with the schedule form and the list of periods
    caption: Housekeeping → Out of Order
---
# Housekeeping: the board, discrepancies and out-of-order rooms
## What it is for
Housekeeping shows which rooms need cleaning and who is cleaning them. It also records when a room is not usable, and when what the front desk thinks about a room (vacant or occupied) disagrees with what the housekeeper sees.
## Who can do this
- Seeing the board needs `housekeeping.view`. Starting and finishing your own cleaning needs `housekeeping.operate`. Assigning rooms, resolving discrepancies and scheduling out-of-order periods need `housekeeping.manage`.
- By default the housekeeping role has view and operate. The front desk role can only view. Manager, admin and super admin have all three.
- None of these actions asks for a manager PIN.
## Where to click
Housekeeping → **Board**, **Discrepancies** or **Out of Order**.
## Fields that matter
1. **Board.** Pick the **Business date**. Managers see every assignment under **Today's board**. A housekeeper sees only **My rooms today**. Each row shows the **Room**, the **Attendant**, its **Status** (assigned, in progress, completed) and whether a **Discrepancy** is open.
2. **Assign a dirty room.** Managers choose a **Dirty room** (only rooms that are dirty and not already on this date's board are listed) and a **Housekeeper**, then press **Assign**. A room can only be assigned once for a date.
3. **Start cleaning.** The housekeeper presses **Start cleaning** on their row, then **Mark complete** when finished.
4. **Vacant or occupied?** When you press **Mark complete**, the board asks **Room vacant or occupied now?** Press **Vacant** or **Occupied**. The room is then recorded as clean with that reading.
5. **Discrepancies.** If the housekeeper's reading disagrees with the front desk's, a discrepancy is opened for the room. The tab shows **Front desk says** and **Housekeeping says**. Filter by **Open**, **Resolved** or **All**. A manager presses **Resolve** and confirms. Resolving cannot be undone. A later matching reading does not close it by itself.
6. **Out of Order.** To take a room out of use, choose the **Room**, the **Type** (**Out of order** or **Out of service**), a **Reason**, a **Start date** and **End date**, and press **Schedule**. The list shows every period. **Close now** ends a period early.
## Why this matters for selling rooms
- A room with an open discrepancy, or inside an out-of-order period, is taken out of the count of rooms that can be sold, and check-in into it is refused.
- Night Audit will not close a business date while a discrepancy is open. See [Running Night Audit](help:screens/back-office-and-admin/01-running-night-audit).
## You are done when
- A cleaned room shows **completed** on the board.
- The **Discrepancies** tab shows no open items for the day, or each is resolved.
- An out-of-order period appears in the list with the right dates.
## What can go wrong
- **The room you want to assign is not in the list.** It is not marked dirty, or it is already on the board for that date.
- **No housekeeping staff to choose.** Nobody has the housekeeping role at this property yet. Add staff in Setup → Users.
- **Night Audit refuses to run.** Resolve open discrepancies first. See [Night Audit will not run](help:common-problems/night-audit-will-not-run).
- **Check-in is refused for a room.** It may be out of order or have a discrepancy. See [Front desk](help:screens/front-desk/01-front-desk-check-in-and-out).
