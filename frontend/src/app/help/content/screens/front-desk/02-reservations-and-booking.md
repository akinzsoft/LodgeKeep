---
images:
  - file: screens/booking/availability.webp
    alt: The Availability tab with the search form and the Book this stay form
    caption: Booking → Availability. Search first, then book
  - file: screens/booking/tape-chart.webp
    alt: The Tape Chart with a column for each night and a row for each room type
    caption: Booking → Tape Chart. Each cell shows how many rooms are free that night
  - file: screens/booking/reservations.webp
    alt: The Reservations list with search, status filter and Cancel buttons
    caption: Booking → Reservations
  - file: screens/booking/waitlist.webp
    alt: The Waitlist tab with Promote and Cancel buttons
    caption: Booking → Waitlist
---
# Reservations: availability, booking, the tape chart and the waitlist
## What it is for
The Booking screen is where you check whether a room type is free for the dates a guest wants, book it, and look after the booking until the guest arrives.
## Who can do this
- Looking needs `reservations.view`. Booking and cancelling need `reservations.manage`. By default front desk, manager, admin and super admin can book. A cashier can look but not book.
- Taking a payment while booking also needs `cashiering.post_charge`.
- No manager PIN is asked on this screen.
## Where to click
Booking, then one of the tabs: **Availability**, **Tape Chart**, **Reservations**, **Waitlist**. (**Front Desk** is the fifth tab, see [Front desk](help:screens/front-desk/01-front-desk-check-in-and-out).)
## Fields that matter
1. **Search availability.** On **Availability**, choose the **Room type**, the **Arrival** and **Departure** dates and press **Search**. Arrival cannot be before the property's business date. You get one row per night with the rooms of that type, how many are **Booked**, how many are **Available to sell**, and a status of **Available** or **Fully sold**. If any night is full, a red message says a new booking will need the waitlist.
2. **Rooms.** Under the table a keypad shows every room of that type as **Available** or **Not available**, with the reason. Tap an available room to ask for it as the **Preferred room**. This is a request only. The room is chosen at check-in.
3. **Book this stay.** Pick the guest (by the **Phone number** box, the **Guest** list, or **Add guest**), a **Rate code**, and the **Adults** and **Children**. Optional: **Preferred room**, **Group block**. The **Book** button stays off until a guest and a rate code are chosen.
4. **Hold only (tentative).** Tick this to hold the room without confirming it.
5. **Add to waitlist if fully booked.** Tick this to put the booking on the waitlist when the dates are full. A waitlisted booking holds no room.
6. **Payment (optional).** After a confirmed booking, a **Payment** card appears with **Cash**, **Card** and **Card (terminal)**. Taking a payment now is optional. If you do not, the balance stays owing and is settled later. A hold or a waitlisted booking does not get a payment card.
7. **Tape Chart.** Shows 14 nights, one row per room type. Each cell is the number of rooms still free that night. Use **Previous week**, **Today**, **Next week ▶** or **Jump to date**. It shows room types, not individual rooms.
8. **Reservations.** Search by guest name, phone or confirmation number and filter by **Status**. Pages hold 25 bookings. A **Cancel** button appears on bookings that are confirmed, tentative or waitlisted.
9. **Cancel.** Press **Cancel**, type the reason (required) and press **Confirm cancellation**. A confirmed or tentative booking releases its room straight away. This cannot be undone.
10. **Waitlist.** Lists who is waiting, the dates and how long they have waited. **Promote** tries to give them a room. It fails if the dates are still full. It is switched off when the arrival date has passed (the row says **Arrival passed**). **Cancel** removes them, with a reason.
## You are done when
- A booking shows in **Reservations** with a reference and the status you expected (confirmed, tentative or waitlisted).
- If a payment was taken, the **Payment** card shows the balance reduced.
- After booking, **Book** stays off until you run a new search, so a booking is not made twice by accident.
## What can go wrong
- **Fully sold.** Pick other dates, tick **Add to waitlist if fully booked**, or look at the Tape Chart for the next free night.
- **Cannot book, no rate code, or no rooms listed.** See [Cannot book a room](help:common-problems/cannot-book-a-room).
- **The Card button is off.** The guest has no e-mail on file. Add one, or use **Card (terminal)** or **Cash**.
- **Marking a no-show.** The Status filter has a no-show option, but this screen has no button to mark a booking as a no-show.
- Cancelling does not post a cancellation fee to a folio. If you need to charge one, post it in Cashiering. See [Cashiering and folios](help:screens/cashiering-and-money/01-cashiering-folios).
