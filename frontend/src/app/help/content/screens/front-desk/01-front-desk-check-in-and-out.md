---
images:
  - file: screens/booking/front-desk.webp
    alt: The Front Desk tab with the Arrivals, Departures and In-House boards
    caption: Booking → Front Desk. Pick a board, then use the button on the guest's row
  - file: screens/booking/reservations.webp
    alt: The Reservations tab listing bookings with their status and balance
    caption: Booking → Reservations. Find a booking here if it is not on today's board
---
# Front desk: check-in, check-out, room moves and extended stays
## What it is for
The Front Desk tab is where guests arrive, stay and leave. It has three boards: **Arrivals**, **Departures** and **In-House**. From a guest's row you can check them in, move them to another room, extend their stay, or check them out.
## Who can do this
- Viewing the boards needs `front_desk.view`. Check-in, check-out, room move and extend stay need `front_desk.manage`. By default the front desk, manager, admin and super admin roles have both.
- A cashier does not have front desk permission by default, so the boards show an error for that role.
- None of these actions asks for a manager PIN.
## Where to click
Booking → **Front Desk**. Choose **Arrivals**, **Departures** or **In-House** at the top.
## Fields that matter
1. **Check in.** On **Arrivals**, press **Check In** on the guest's row. Choose the **Room**. The list shows the rooms that are free right now, with their housekeeping status in brackets. If the guest asked for a room when they booked and it is still free, it is already selected, and you can change it. Press **Confirm check-in**.
2. **Room not clean.** If the room is not marked clean, check-in is refused. Tick **Check in anyway if the room is not marked clean** to go ahead.
3. **Rooms that cannot be used.** A room that is not in service, is out of order, or has an open discrepancy is refused, and the box above does not override that. Pick another room, or see [Housekeeping](help:screens/front-desk/04-housekeeping).
4. **Move a room.** On **In-House**, press **Move Room**. Choose the **New room**, type a **Reason** (it is required) and press **Confirm move**.
5. **Extend a stay.** On **In-House**, press **Extend Stay** and choose the **New departure date**. It cannot be earlier than the current one. Press **Confirm extension**.
6. **Check out.** On **Departures** or **In-House**, press **Check Out**. The **Balance** column and a red message in the dialog tell you what is owing. The time and fee boxes are optional: leave them blank for an ordinary checkout with no early or late fee. If you do fill them in (times as HH:MM), type the fee amount yourself and it is added to the folio. Press **Confirm check-out**.
## What the Balance column means
- **Owing:** the guest has an unpaid balance. Check-out is blocked until it is cleared in Cashiering.
- **In credit:** the guest has paid more than they owe. Check-out is allowed. The credit stays on the folio and is refunded to the guest in Cashiering.
- **via AR:** the folio is billed to a company. A balance owing to the company does not block check-out. If the company's account is over its credit limit, the confirmation after check-out says so.
## Guests who stay past their departure date
Check-out is always done by front desk. If a guest is still checked in when Night Audit runs on or after their departure date, Night Audit bills that night at their last nightly rate and moves their departure date forward by one day. This repeats every night until you check them out. Check them out before running Night Audit if they have left, otherwise they are charged another night. See [Running Night Audit](help:screens/back-office-and-admin/01-running-night-audit).

If you extend a stay and some of the added nights have already been closed by Night Audit, those nights are charged to the folio straight away. The confirmation lists the nights.
## You are done when
- **Check-in:** the guest moves from Arrivals to In-House and the room shows in the **Room** column.
- **Check-out:** the guest leaves the board and the message says **Checked out.** Any fee posted is named in that message.
- **Room move or extension:** the board refreshes with the new room or departure date.
## What can go wrong
- **"Cannot check out — folio balance … is still owing."** Take the payment or adjust the folio in Cashiering. See [Cashiering and folios](help:screens/cashiering-and-money/01-cashiering-folios).
- **The guest is not on Arrivals.** The boards follow the property's business date, not the clock. See [Timezone and business date problems](help:common-problems/timezone-and-business-date).
- **No rooms to choose from.** Every room is occupied, out of order or has a discrepancy.
- **Buttons are greyed out and a banner says you are offline.** Check-in, check-out, moves and extensions are disabled until the connection returns.
- To find a booking that is not on today's board, use [Reservations and booking](help:screens/front-desk/02-reservations-and-booking).
