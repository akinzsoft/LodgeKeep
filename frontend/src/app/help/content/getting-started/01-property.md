---
images:
  - file: getting-started/01-property/1-property.webp
    alt: The Setup screen on the Property tab, showing the property's timezone and currency
    caption: Setup → Property: check the timezone and currency first
---
# Property details and business date

## What it is for
Everything in LodgeKeep belongs to a property. Its **timezone** decides when a day has really ended, and its **business date** is the accounting day every charge, payment and report is posted to. Get both right first: a wrong timezone is hard to untangle later.

## Where to click
Setup → **Guided Setup** (or Setup → **Property**). Optional: Setup → **Branding** for the logo.

## Fields that matter
1. **Name** and **base currency**. The currency is used for every amount at this property.
2. **Timezone**. Pick it from the list. It must be a real zone such as `Africa/Lagos`; free text is refused.
3. **Opening business date**. Normally today. It only moves forward when Night Audit runs.

## You are done when
The property appears under Setup → Property with the correct timezone, and the top bar shows the business date you expect.

Trouble? See [Timezone and business date problems](help:common-problems/timezone-and-business-date).
