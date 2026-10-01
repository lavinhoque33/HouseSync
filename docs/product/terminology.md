# Product terminology

This vocabulary describes implemented concepts and explicitly labeled unsupported
policies; it does not rename backend schema or endpoint fields.

| Term | Meaning and boundary |
| --- | --- |
| User | A person with a HouseSync identity; distinct from any financial account. |
| Actor | The authenticated identity performing an operation, including a deliberately scoped system operation. |
| Household | The central organizational/tenant boundary for shared finance, initially designed for 2–5 people. |
| Membership | A user's association with a household, including its lifecycle and permissions. It does not grant blanket access to personal data. |
| Role | Current household `OWNER` or `MEMBER`; administrative ownership does not override financial privacy. |
| Invitation | A controlled offer to join a household; acceptance must establish the intended membership exactly once. |
| Financial account | An owner-private manual or selected connected checking, savings or credit-card account. |
| Financial connection | The stateful relationship with an external provider/institution; may supply several financial accounts and may need reconnection. |
| Account owner | The person or ownership model associated with an account; ownership and visibility must be modeled separately. |
| Financial owner | Stable authenticated user who owns a private financial account and its entries; distinct from a household administrative `OWNER`. |
| Transaction | A dated financial record with amount, currency, account, provenance, and lifecycle. It may be manual or imported. |
| Pending transaction | Provisional provider observation; never admitted to the confirmed ledger or household totals. |
| Posted/finalized transaction | A booked record; “finalized” does not guarantee the provider will never correct or reverse it. |
| Merchant | The counterparty/merchant identity or normalized label; not necessarily identical to the raw description. |
| Category | One of the server-owned taxonomy tokens with a human-readable label; descriptive, not an access or money rule. |
| Classification | Effective category and provenance; optional heuristic/AI output is only a suggestion pending owner review. |
| Rule | Owner-private deterministic exact-match categorization rule; never household-owned or automatically retroactive. |
| User correction | An explicit user change that takes precedence over automated suggestions and survives reprocessing. |
| Review item | An unresolved ambiguity requiring user attention; not proof that a record is erroneous. |
| Shared expense | A financial event intentionally included in household coordination; does not automatically make the entire source account visible. |
| Allocation / split | Exact participant shares of a disclosed expense, equal or exact unequal, with conserved refund attribution. |
| Payer | The financial owner who paid the expense; not an independently nominated payer in the implemented allocation contract. |
| Participant | A current member chosen for a share; retained obligations survive departure under the contract. |
| Personal portion | A payer-retained cost share; not a private portion of a disclosed purchase. |
| Member balance | A derived net obligation between household members for the defined scope; not a bank account balance. |
| Settlement suggestion | A proposal for reducing member obligations; does not initiate a payment. |
| Visibility | Which actor can see a resource or permitted summary; separate from permission to edit it. |
| Household-visible transaction | Explicit disclosure of a complete transaction to all current household members, including later joiners; source account metadata stays private. Visibility alone creates no split or obligation. |
| Household totals only | A possible future disclosure policy; not a supported sharing mode. |
| Transfer | Movement between accounts; must be distinguished from spending to avoid double-counting. |
| Refund | A return of money that must be associated with the chosen expense/reporting policy rather than silently counted as unrelated income. |
| Reversal / removal | A source lifecycle change that invalidates or removes a prior record; downstream totals and allocations need deliberate reconciliation. |
| Synchronization | Refreshing local account/transaction state from a provider, with durable progress and recoverable failures. |
| Reconciliation | Deterministically matching source changes to existing records while preserving provenance and user-owned decisions. |
| Idempotency | Repeating the same scoped operation safely without creating duplicate domain effects. |
| Reporting period | A defined interval using explicit calendar/time-zone and transaction-date semantics. |

## Language conventions

- Prefer **financial account** when “account” could mean a login identity.
- Prefer **posted** in transaction lifecycle discussions; it does not guarantee the provider will never correct an observation.
- Always distinguish **bank balance**, **household spending**, and **member balance** in labels and APIs.
- Pair every amount with currency. A `$` symbol alone does not establish which dollar currency is meant.
- Do not use **shared** as shorthand for “every household member can see every detail.”
- Reserve **connected**, **synced**, and **AI-assisted** for actual capabilities; label demonstration content clearly.
- AI assistance is an implemented optional suggestion path disabled by default; it never categorizes the ledger autonomously.

Money, signs/dates, private accounts, selected transaction sharing, retained history, allocations, balances,
and reporting are
defined in [ADR 0006](../decisions/ADR-0006-manual-finance-contracts.md) and the
[manual-finance API contract](../architecture/manual-finance-api.md) and are implemented. A financial owner is not
an administrative `OWNER`, a visible purchase is not automatically split, and an archived account or voided entry
retains its history rather than deleting it.

See [system overview](../architecture/system-overview.md) for ownership and [known limits](known-limits.md) for scope.
