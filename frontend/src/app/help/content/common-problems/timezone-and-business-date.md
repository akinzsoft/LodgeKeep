# Timezone and business date problems

## Symptoms
Night Audit refuses to run, the top bar shows the wrong date, or the date seems stuck.

## What to check
1. **Timezone.** Setup → Property must show a real zone such as `Africa/Lagos`. Names such as "Lagos" or "Africa" are not valid and are refused when saved. If a property already holds a bad value, choose a zone from the list and save.
2. **Business date.** It moves only when Night Audit runs, one day per run. If nobody ran it, the date stays where it is.
3. If Night Audit says the day has not ended yet, the property's own local time has not passed midnight. That is expected.

## Still stuck
Ask your administrator. Do not run several audits in a row to catch up without advice, because each one posts room charges.
