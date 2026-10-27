---
images:
  - file: screens/profiles/guests.webp
    alt: The Guests tab with the activity summary, search box and guest list
    caption: Profiles → Guests
  - file: screens/profiles/companies.webp
    alt: The Companies tab with the company list and the Add a company profile form
    caption: Profiles → Companies
---
# Guest and company profiles
## What it is for
Profiles is the address book. **Guests** finds a guest and shows their stay history. **Companies** holds the businesses and travel agents you bill, with their billing details.
## Who can do this
- Looking at guests and companies needs `reservations.view`.
- Adding, editing and archiving a company needs `ar.manage`, which by default is manager, admin and super admin. Saving a guest's linked company needs `reservations.manage`.
- No manager PIN is asked.
## Where to click
Profiles → **Guests** or **Companies**.
## Fields that matter
1. **All guests.** The Guests tab lists every guest, with name, e-mail and phone.
2. **Guest activity.** Two figures count **Active** and **Inactive** guests. Active means a reservation arriving in the last 12 months. Press either one to list just those guests.
3. **Find a guest.** Type a name, e-mail or phone in **Name, email, or phone** and press **Search**. **Show all guests** brings the full list back.
4. **View profile.** Shows **Guest details** and their **Stay history**: confirmation number, arrival, departure and status.
5. **Linked company.** On a guest's profile, pick a company in **Linked company** and press **Save**, or choose **No company linked** to remove it.
6. **Export to PDF.** Prints the guest list.
7. **Companies.** The list shows **Name**, **Type** (company, travel agent or source) and **Billing email**. Search by name. **View AR account** shows the company's credit limit, current balance and enforcement. If it says no account exists, create one in Accounts Receivable before billing a folio to it.
8. **Add a company profile.** Fill **Name**, **Type**, **Billing email**, **Billing phone**, **Billing address** and **Payment terms (days)**, then press **Add company profile**. **Edit** loads it back into the form (**Save changes**).
9. **Archive.** Press **Archive** and confirm. An archived company stops appearing in searches and pickers. Its AR accounts and invoices are not changed.
## You are done when
- A search or filter shows the guest, and their profile opens with the stay history.
- A new company appears in the list and is available when you link a guest or bill a folio.
## What can go wrong
- **A guest is missing.** Search by phone or e-mail, spelled exactly as you entered it.
- **A guest is listed as inactive** after a long gap: they simply have no reservation in the last 12 months. Nothing is deleted.
- **You can see Companies but not add one.** You need `ar.manage`.
- **Adding a new guest.** The guest list does not add guests. Use **Add guest** on the Booking → Availability screen, see [Reservations and booking](help:screens/front-desk/02-reservations-and-booking).
