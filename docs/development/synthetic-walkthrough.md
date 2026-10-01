# Synthetic walkthrough

The README images are Chromium captures of a separate localhost Compose instance (`docs/images/`, 1440 CSS px desktop and 390 CSS px mobile, device scale 1). Every identity, household, account and amount is synthetic. The only external service involved was Plaid **Sandbox**, which generates test banks and test transactions; no real bank, no mock responses and no DOM substitutions were used.

## Setup

1. Follow the README quick start in a new disposable Compose project, then enable connected finance as described under *Link a bank with Plaid Sandbox* (your own Sandbox client id and secret, `PLAID_ENV=sandbox`, a disposable 32-byte key). Keep AI categorization disabled.
2. Issue enrollment grants for `alex@example.test` and `sam@example.test`; register each with its own disposable password. Registration does not sign in automatically.

## Alex (owner): link the test bank

1. Sign in as Alex and create **Maple House**.
2. Open **Bank connections → Link a bank**. In Plaid Link choose *Continue without phone number*, search `First Platypus Bank`, pick the plain (non-OAuth) entry and sign in with `user_good` / `pass_good`. Accept the account sharing step and finish without saving a phone number.
3. On the new connection choose **Choose accounts** and admit exactly three: *Plaid Gold Standard 0% Interest Checking*, *Plaid Silver Standard 0.1% Interest Saving* and *Plaid Diamond 12.5% APR Interest Credit Card*. Loan, investment and cash-management accounts are listed as not eligible.
4. The first sync runs on admission. **Bank activity** then shows 42 posted items: Plaid's standard Sandbox history for `user_good` (United Airlines, Uber, McDonald's, Starbucks, SparkFun, Tectra Inc, KFC, Madison Bicycle Shop, Touchstone Climbing, interest and credit-card payments) repeated monthly. Sandbox dates are generated relative to the link time, so a reproduction will not show the exact dates in the images.
5. Confirm every item. Statement descriptions were kept except: `INTRST PYMNT` → income *Savings interest*; `AUTOMATIC PAYMENT - THANK` and `CREDIT CARD 3333 PAYMENT` → transfer *Credit card payment*; `Uber … SF**POOL**` → *Uber Pool*; the positive `United Airlines` entries → income *United Airlines refund*. No category was chosen on confirmation, so the deterministic classifier applied Plaid's personal-finance category where the application mapping is exact (for example McDonald's → Dining with provenance `PROVIDER`) and left the rest uncategorized.
6. Share the three `KFC` and three `Touchstone Climbing` expenses with the household and allocate each equally between Alex and Sam.

## Sam (member): manual entries

1. As Alex, create an invitation. As Sam, accept it, then add a private **Everyday checking** account (`CHECKING`, `USD`).
2. Record these transactions, shared with the household and allocated equally between Sam and Alex (negative amounts are expenses; the UI takes a positive magnitude and the expense kind):

| Date | Description | Signed amount (USD) | Category |
| --- | --- | --- | --- |
| 2026-07-01 | Maple rent | -1500.00 | HOUSING |
| 2026-08-01 | Maple rent | -1500.00 | HOUSING |
| 2026-09-01 | Maple rent | -1500.00 | HOUSING |
| 2026-07-06 | Fresh market | -284.15 | GROCERIES |
| 2026-08-05 | Fresh market | -310.40 | GROCERIES |
| 2026-09-05 | Fresh market | -245.80 | GROCERIES |
| 2026-09-23 | Fresh market | -82.35 | GROCERIES |
| 2026-07-10 | City utilities | -141.90 | UTILITIES |
| 2026-08-10 | City utilities | -145.20 | UTILITIES |
| 2026-09-09 | City utilities | -138.40 | UTILITIES |
| 2026-08-20 | Streambox | -18.00 | SUBSCRIPTIONS |
| 2026-09-20 | Streambox | -18.00 | SUBSCRIPTIONS |

3. Record two shared incomes without allocation, **Household contribution** `3200.00 USD` on 2026-08-28 and 2026-09-28, and one **private** expense, **Personal notebook** `24.99 USD` on 2026-09-26, category `PERSONAL`. The private expense must stay out of household Insights even for its owner.

## Repayments and budgets

1. As Alex, record a repayment of `1500.00 USD` to Sam completed on 2026-08-30; as Sam, confirm it. Record a second repayment of `400.00 USD` dated 2026-09-29 and leave it pending.
2. As Alex, create September 2026 budget targets: overall `3600.00 USD`, Groceries `350.00 USD`, Dining `600.00 USD`.
3. On **Insights**, select September 2026 against August 2026 in USD. For later calendar dates select these months explicitly; the default current month will not reproduce the images.

## Expected exact results

- Shared net spending: July **2504.55 USD**, August **2552.10 USD**, September **2563.05 USD**; September increase **10.95 USD**, or **0.43%** against the positive baseline. Income of **3200.00 USD** is shown separately.
- September overall target **3600.00 USD**; signed remaining **1036.95 USD** (71.20% used).
- Member balances in USD: Alex owes Sam **574.36**; the settlement plan suggests one payment Alex → Sam of 574.36. The pending repayment changes nothing until confirmed.
- Recurring suggestions include `kfc`, `touchstone climbing`, `maple rent` and `city utilities` as monthly, with three occurrences each.
- The private `24.99 USD` expense appears only in Sam's own feed, never in the household feed, balances or Insights.

Member balances identify members by id, not email. The bank-activity desktop image was captured after the July and August items were confirmed and before the September ones, so it shows both *In the ledger* and *Not reviewed* states with 14 items awaiting review. Mobile images use a 390-CSS-pixel Chromium viewport; they are not proof of real-device, keyboard, screen-reader or production accessibility acceptance.

The repository includes only the screenshots and this recipe, not Plaid credentials, encryption keys, login credentials, enrollment codes, session state or a seeded database. Use normal API/UI authorization throughout; never insert identity or financial rows directly to bypass it.
