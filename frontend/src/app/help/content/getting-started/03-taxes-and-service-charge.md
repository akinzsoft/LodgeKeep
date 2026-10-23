---
images:
  - file: getting-started/03-taxes-and-service-charge/1-taxes.webp
    alt: The Taxes tab listing VAT 7.5 percent
    caption: Setup → Taxes
---
# Taxes and service charge

## What it is for
Taxes are added to room charges and POS sales automatically, using the rate that was in force on the charge's business date. The **service charge** is a separate, per-outlet percentage on POS sales.

## Where to click
Setup → **Taxes** for taxes. POS → **Setup** → **Service charge** for each outlet.

## Fields that matter
1. Tax: **name**, **code**, **rate**, **effective from**, and whether it is **inclusive** or added on top. Changing a rate adds a new version from a date; old bills keep the old rate.
2. Only the super admin can add, switch off or delete taxes. Managers and admins can view them.
3. Service charge: the percentage for the outlet (default 7.5%). QR orders add it only if the outlet's QR mode is set to charge.
4. A supermarket outlet uses its own tax row, marked "Supermarket sales only". The hotel tax does not apply to it.

## You are done when
The Taxes list shows each tax you charge, and no "tax is off" banner is shown. A small test charge shows the tax line you expect.

Trouble? See [A tax is missing or wrong](help:common-problems/tax-missing-or-wrong).
