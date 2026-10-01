# Synthetic walkthrough

The README images are actual Chromium captures of a separate localhost instance. Every identity, household, account, description and amount below is synthetic. No provider was connected and no mock responses or DOM substitutions were used.

1. Follow [local setup](local-setup.md) in a new disposable Compose project; keep integrations disabled. Issue an enrollment grant for `alex@example.test`, register with a new disposable password, and sign in. Registration does not sign in automatically.
2. Create **Maple House**, then a private **Everyday checking** account (`CHECKING`, `USD`).
3. Add these transactions using the account. Negative amounts are expenses; the UI takes a positive magnitude and the expense kind. Explicitly choose household sharing for these rows.

| Date | Description | Signed amount (USD) | Category |
| --- | --- | --- | --- |
| 2026-08-01 | Maple rent | -1500.00 | HOUSING |
| 2026-08-05 | Fresh market | -310.40 | GROCERIES |
| 2026-08-10 | City utilities | -145.20 | UTILITIES |
| 2026-08-15 | Neighborhood cafe | -96.50 | DINING |
| 2026-08-20 | Streambox | -18.00 | SUBSCRIPTIONS |
| 2026-09-01 | Maple rent | -1500.00 | HOUSING |
| 2026-09-05 | Fresh market | -245.80 | GROCERIES |
| 2026-09-09 | City utilities | -138.40 | UTILITIES |
| 2026-09-14 | Neighborhood cafe | -64.50 | DINING |
| 2026-09-20 | Streambox | -18.00 | SUBSCRIPTIONS |
| 2026-09-23 | Fresh market | -82.35 | GROCERIES |
| 2026-09-25 | Metro pass | -45.00 | TRANSPORTATION |
| 2026-08-28 | Household contribution | 3200.00 | INCOME |
| 2026-09-28 | Household contribution | 3200.00 | INCOME |

4. Add a **private** expense, **Personal notebook**, `24.99 USD`, dated `2026-09-26`, category `PERSONAL`. It must remain outside household Insights even for its owner.
5. Open Insights and select September 2026 versus August 2026 in USD. Create an overall September target of `2400.00 USD`, review the disclosure and confirm it. For later calendar dates, explicitly select these historical months; do not expect the default current month to reproduce the images.

## Expected exact results

- August shared net spending: **2070.10 USD**.
- September shared net spending: **2094.05 USD**; increase **23.95 USD**, or **1.16%** against the positive baseline.
- September income: **3200.00 USD**, displayed separately rather than subtracted from spending.
- September overall target: **2400.00 USD**; signed remaining **305.95 USD**.
- The private `24.99 USD` expense appears in the owner’s transaction feed but not these shared totals.

The screenshot’s reporting clock reflects the capture date; target progress is based on the selected full calendar month, not a forecast. The unavailable bank-inbox badge reflects the disabled optional integration, not a fabricated bank connection. Mobile images use a 390-CSS-pixel Chromium viewport; they are not proof of real-device, keyboard, screen-reader or production accessibility acceptance.

The repository includes only the screenshots and this recipe—not login credentials, enrollment codes, session state or a seeded database. Use normal API/UI authorization throughout; never insert identity or financial rows directly to bypass it.
