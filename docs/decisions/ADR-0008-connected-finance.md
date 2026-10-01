# ADR 0008 - Connected finance through Plaid and a reviewed ledger

- **Status:** Accepted and implemented at the application/adapter boundary; live bank-initiated
  posted modification/removal and institution coverage remain unverified.
- **Scope:** Connected finance, initially United States / Canada banks.
- **Related:** [Integration contract](../architecture/connected-finance-contract.md),
  [manual finance](ADR-0006-manual-finance-contracts.md), [allocations](ADR-0007-categories-sharing-allocations.md),
  [known limits](../product/known-limits.md).

## Context

Identity, households and manual finance exist. The existing ledger has exact money,
explicit economic kinds, capped linked refunds, private accounts, selected transaction disclosure and
frozen allocations. External feeds do not guarantee those semantics: pending entries disappear, posted
entries change, and an incoming payment is not necessarily income or a linked refund.

The initial choice covers US/Canada provider accounts. Currency support does not imply bank coverage;
in particular, accepting BRL in the manual ledger does not make Plaid a Brazil integration.

## Decision

1. **Select Plaid Transactions Sync and Plaid Link for the first adapter.** Start with Sandbox and the
   Transactions product only. Support checking, savings and credit-card accounts in USD/CAD subject to the
   currency extension below. Request 90 days of history, with actual availability surfaced honestly.
   Use one Item-wide cursor; do not mix account-filtered and Item-wide streams. Paid on-demand refresh,
   balances, investments, payments, automatic categorization and multi-provider routing are out of scope.
2. **Add CAD (scale 2) deliberately.** The original manual-finance allowlist
   lacked CAD. The connected-finance extension widened backend/web validation,
   database constraints, exact formatting and checks together before CAD admission.
   Currency support still does not establish live Canadian institution coverage.
3. **Separate provider observations from the confirmed ledger.** Sync automatically populates a private
   bank activity inbox. Pending, unreviewed and invalid observations never enter spending or obligations.
   An owner confirms a posted observation's economic kind and, if applicable, refund source before its
   first ledger admission. Provider category labels remain evidence, not automatic HouseSync categories.
   This is a bounded import/reconciliation inbox; categorization is [ADR 0009](ADR-0009-deterministic-categorization.md).
4. **Never silently overwrite a confirmed ledger entry.** Later provider changes/removals create private
   reconciliation work. The last owner-confirmed ledger continues to contribute until the owner resolves
   the difference using existing money/refund/allocation rules. Clearly label its reporting basis and
   outstanding review status to its owner. Never expose private bank changes through a shared entry.
5. **Own the integration boundary.** Domain/REST types contain HouseSync identifiers and exact values;
   provider SDKs, Items, tokens, payloads, cursors and errors remain behind a provider adapter. Connection
   ownership is one household plus a stable user UUID; no household-owner override or joint-account model.
6. **Use durable PostgreSQL work, replay and fencing.** Webhooks are verified wake-up signals, not ledger
   events. Persist work before acknowledging it. Fetch outside database transactions; stage complete sync
   rounds and atomically commit observations plus cursor. A database lease with fencing prevents stale workers.
7. **Disconnect stops local imports immediately and revokes the remote Item asynchronously.** Keep encrypted
   credentials only until remote revocation is confirmed; make a failed revocation visible and retryable.
   Retain confirmed ledger and minimal reconciliation provenance. Account deletion/erasure policy remains
   a production release prerequisite; disconnect must not imply erasure or termination of provider billing
   before remote confirmation.

## Alternatives and tradeoffs

| Alternative | Decision |
| --- | --- |
| Plaid `/transactions/get` snapshots | Reject for the first adapter: Sync has explicit cursor-based changes/removals; avoid two reconciliation models. |
| Pluggy / Belvo | Relevant Brazil/LatAm alternatives; not selected for the user's US/Canada first scope. Reassess if the target market changes. |
| Tink / TrueLayer | Relevant European alternatives; not the selected regional scope. |
| Another US/Canada aggregator | Not ruled out long-term. Plaid has documented Sandbox, Link, Sync and verification flows. No claim of best price or universal bank coverage. |
| Direct imports into the existing ledger | Reject: provider signs/categories alone do not prove transfer/refund semantics, and automatic mutation could rewrite shared obligations. |
| Automatically update unallocated confirmed entries | Defer: one explicit review policy is easier to explain and preserves user corrections consistently. |
| External queue / separate sync service | Defer: durable database jobs suffice for the modular monolith; introduce infrastructure only on measured need. |

The reviewed-ledger choice costs an initial confirmation step and permits confirmed totals to lag bank
corrections. The UI must say so. It avoids inferred income/refunds, accidental disclosure and changing
household obligations without the financial owner's action. No automatic matching of manually entered
transactions to provider entries is promised.

## Prerequisites for live operation

The [contract](../architecture/connected-finance-contract.md) owns behavior and tests. Before live use,
verify Transactions coverage for the actual institutions/account types, obtain approved Plaid access and
pricing, configure redirect/webhook URLs and encryption keys, and test consent/revocation. Sandbox fixtures
do not prove real institution behavior. US and Canada are a supported target, not a promise that every bank
or account can link.

## Provider evidence

Official references reviewed on 2026-09-17; recheck provider contracts before changing the integration:

- [Transactions API and Sync pagination](https://plaid.com/docs/api/products/transactions/)
- [Transactions overview and pending transitions](https://plaid.com/docs/transactions/)
- [Link update mode](https://plaid.com/docs/link/update-mode/)
- [Webhook verification](https://plaid.com/docs/api/webhooks/webhook-verification/)
- [Billing: Transactions subscription and Item removal](https://plaid.com/docs/account/billing/)
- [Institution coverage](https://plaid.com/docs/institutions/)

Plaid documents pending-to-posted as a removed pending record plus a new posted record, optionally linked by
`pending_transaction_id`; a pagination mutation requires restarting at the original cursor. Update mode
reuses the Item's access token rather than exchanging a new public token. Transactions subscription billing
continues while an Item's valid token exists; local pause is not remote removal.
