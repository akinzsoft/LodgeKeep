# Night Audit will not run

## Symptoms
The Run button is refused, or a run is shown as failed or running for a long time.

## What to check
1. **Has the day ended?** It will not close a business date until that date has passed in the property's timezone. See [Timezone and business date problems](help:common-problems/timezone-and-business-date).
2. **Open discrepancies.** Resolve any in Housekeeping → Discrepancies first.
3. **Permission.** Only managers and above can run it.
4. **Already done.** Each date is closed once. History shows the run.
5. **A failed run** can be run again: it starts again from the beginning rather than resuming.

## Still stuck
Do not start a second run while one shows as running. Wait a few minutes, then contact your administrator.
