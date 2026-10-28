---
images:
  - file: screens/night-audit/night-audit.webp
    alt: The Night Audit screen with the Run night audit button and the run history
    caption: Night Audit. Run it once for each business date
---
# Running Night Audit and reading the result
## What it is for
Night Audit closes the property's business date. It posts the room charges for the day, saves a daily report, and moves the property on to the next business date. It is run by hand, once for each date, and it does not run on a timer.
## Who can do this
- Seeing the screen needs `night_audit.view`. Running it needs `night_audit.run`. By default that is manager, admin and super admin.
- It does not ask for a manager PIN, but it does ask you to confirm.
## Where to click
**Night Audit** in the sidebar.
## Fields that matter
1. **Before you run.** Check out guests who have left (otherwise they are charged another night, see below). Resolve any open discrepancy in Housekeeping → Discrepancies.
2. **Run.** Press **Run night audit**. The confirmation says it posts room charges, closes today's business date and advances the property to the next day, and that this cannot be undone. Confirm.
3. **Last run result.** When it finishes, this card shows **Business date closed**, **Room revenue**, **Occupancy**, **Next business date** and **Exceptions flagged** (a number).
4. **Run history.** Lists each **Business date** with its **Status**: COMPLETED, FAILED, RUNNING, STALE or RECOVERABLE, and when it started and completed.
## What it does to money
- It posts one room charge for each in-house guest for the night, at the rate fixed when they booked. Tax is added by the normal tax rules. It does not charge a night twice.
- **Overstays.** A guest still checked in on or after their departure date is charged for that night at their last nightly rate, and their departure date moves forward by one day. This happens every night until you check them out. If their departure date is already in the past (for example no audit was run for some days), the missed nights are charged too.
- A room charge on a folio billed to a company is posted even when the company is over its credit limit. The account is flagged as over limit so it can be chased.
- The daily report holds that day's room revenue, payments collected, occupancy, average daily rate and revenue per available room. It is saved when the day closes and is what Reporting uses for closed days.
## Exceptions
Exceptions are things the audit noticed and did not stop for: an in-house guest with no open folio, an overstay that was extended (or one with no rate to copy), and a discrepancy still open. The screen shows how many there were but not the list. To follow them up, check the In-House board in Front Desk and the Discrepancies tab.
## You are done when
The run shows **COMPLETED** in the history, the card shows the next business date, and the top bar's business date has moved on.
## What can go wrong
- **"Cannot run yet".** The audit will not close a day until that calendar day has ended in the property's own timezone. Wait for the next day to start. See [Timezone and business date problems](help:common-problems/timezone-and-business-date).
- **Refused because of an open discrepancy.** Resolve it first.
- **It is already running.** Do not start another. Wait, then check the history. A failed run can be run again; it starts from the beginning.
- **More general help:** [Night Audit will not run](help:common-problems/night-audit-will-not-run).
- **There is no screen that lists the daily reports.** Closed days feed the Reporting screen's figures. The daily report itself is not shown on this screen.
