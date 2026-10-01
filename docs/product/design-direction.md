# Web design direction

## Product character

HouseSync aims to feel calm, clear and trustworthy: a person opening the app
on a phone should understand disclosed household spending, resolve a few
review items and leave informed. This document distinguishes implemented
interaction patterns from design guidance, not universal accessibility evidence.

## Mobile-first information hierarchy

- Lead with the user's current task and a compact summary, not a dense desktop dashboard scaled down.
- Keep frequent actions reachable and short: inspect a transaction, correct a category, review a split.
- Use progressive disclosure for account provenance, allocation detail, and explanatory metadata.
- Expand desktop layouts for comparisons and transaction exploration while preserving the mobile hierarchy.
- Let content determine responsive breakpoints; verify phone widths, zoom, long labels, and large amounts.

The web client uses focused URL destinations rather than stacking every
feature into one page. A top-left three-dot button opens a nested navigation drawer.
Active ancestors expand to expose the current page. The right side contains a signed-in profile control
and, within an authorized household, a private bank-inbox shortcut.

| Destination | Path | Responsibility |
| --- | --- | --- |
| Home | `/` | Short links to household work and Profile Settings |
| Profile Settings | `/account/security` | Existing account identity, password changes, sign-out and account-wide session revocation |
| Households | `/households` | Authorized directory with member counts and viewer-private account summaries |
| Create household | `/households/new` | Dedicated creation form and recoverable creation outcome |
| Household overview | `/households/{id}/overview` | Spending summary and household reporting settings |
| Transactions | `/households/{id}/transactions` | Private/shared feeds, entry, correction, sharing and allocation |
| Financial accounts | `/households/{id}/accounts` | Private manual accounts and their lifecycle |
| Members / Invitations | `/households/{id}/members`, `/households/{id}/invitations` | Membership and owner-managed invitation links |
| Connections / Bank activity | `/households/{id}/connections`, `/households/{id}/bank-activity` | Private provider setup and inbox; unavailable providers remain explicit |
| Reviews / Rules | `/households/{id}/reviews`, `/households/{id}/rules` | Categorization decisions and reusable private rules |
| Balances / Repayments / Contributions | `/households/{id}/balances`, `/households/{id}/repayments`, `/households/{id}/contributions` | Distinct shared-finance views, never payment execution |
| Insights | `/households/{id}/insights` | Trends, recurring plans and budget evidence |

Real links support direct reload and browser history. Route transitions move focus
to the page heading and reset scroll; typing does neither. The authenticated
controller remains mounted while changing pages, but unrelated feature panels are
not rendered or eagerly loaded. Necessary uncertain-write intent stays in scoped
memory so returning to a page can retry the same request rather than duplicate it.
Identity and household authority changes clear private state. Password drafts are
cleared when leaving security. Invitation/enrollment/recovery capabilities retain
their separate fragment-only, memory-only contracts.

## Profile, directory and inbox

- The profile panel uses the existing authenticated email identity and account ID;
  the API does not store a display name or profile photograph. Never invent either.
  Profile UI belongs to the authenticated controller and disappears on identity loss.
- Directory cards combine an icon-led household entry link with authorized member
  counts and a small account-type donut/legend. Account statistics belong to the
  **viewer**, never all members' private accounts. Bounded-page data is labeled as
  partial, and unavailable data is not shown as zero. Offscreen cards defer requests.
  Creation is reached through navigation, not embedded in the directory.
- The household bank icon's badge counts items needing review (unreviewed plus
  changed bank activity). It is not a read/unread notification system. Unknown or
  disabled provider state remains distinguishable from an empty inbox. Counts and
  the icon clear when the authorized household scope is left or lost.

## Filter sheets and motion

- Feed/privacy, bank activity, repayment activity, rules/reviews, recurring reviews,
  spending periods and Insights filters use compact summary bars and modal sheets.
  Clear/reset affects view criteria, not transaction, repayment or recovery drafts.
  Existing explicitly submitted filter forms retain applied-versus-draft semantics.
- Mutation choices such as transfer direction, allocation method and bank-review
  decisions remain with their forms; they are not list filters.
- Native modal dialogs keep the background inert; explicit Tab-edge wrapping keeps
  visible focus inside the dialog. Escape/backdrop/close restores the originating
  control. A route change closes dialogs before focusing its heading.
- Drawer/sheet/profile transitions and short page/icon entrance motion respect
  `prefers-reduced-motion`. Page animation never remounts financial controllers or
  retains a visual snapshot of a previous user's private content.

## Insights reporting hierarchy

- Lead with selected-month net spending, expenses, refunds and **separate income**
  metric cards, with baseline amounts, period states and currency kept visible.
  Category and public-description change lists are independent breakdowns, not
  additive explanations of why spending changed.
- Separate the overview, monthly trend, group comparison/evidence, budget targets,
  recurring suggestions and tracked/archived plans into labeled surfaces.
  Compact previews link to the full management sections without remounting them.
- Put supporting calculations, period boundaries, uncertainty and preview detail
  in native disclosures. Keep errors, retry actions and uncertain-write recovery
  visible; disclosure controls are not a substitute for authorization.
- Keep exact tables semantic and keyboard-scrollable, with captions, aligned
  tabular amounts, subordinate counts and explicit status labels. Overall budget
  rows overlap category rows; distinguish them visually without suggesting addition.
- An entirely zero-net trend uses a compact state instead of twelve empty bars.
  Zero net is not “no activity”: expenses, refunds and separate income remain
  available in the monthly table and group evidence.
- A separately unavailable summary retains a visible retry notice and the
  available comparison/trend. Authentication, access and stale-read failures
  still follow the existing scope-clearing/reconciliation behavior.
- Section jumps keep the focused destination below the sticky header. Mobile
  cards reflow; exact financial tables scroll within their own labeled region.

## Visual foundation

- Use a restrained neutral surface palette, one coherent accent, and explicit semantic status treatments.
- Make typography and spacing carry hierarchy before adding borders, shadows, or decorative effects.
- Favor legible body text and aligned/tabular numerals for comparable amounts where the chosen typeface supports them.
- Define reusable color, spacing, typography, radius, and focus tokens when components are implemented.
- Keep currency, sign, date, and period visible where needed; do not truncate the only representation of a value.
- Make debt/credit and error/success understandable through labels and symbols as well as color.
- The implemented palette uses cool slate/white surfaces, ink text and indigo actions,
  with 10–16px control/card corners, outlined icons and restrained shadows. System
  fonts avoid third-party font requests. Chart legends carry explicit counts;
  their indigo/teal/amber/rose swatches remain distinguishable from financial meaning.

## Financial trust and recoverable interaction

Financial confidence comes from explainable state, not visual polish alone.

- Identify the active household and make the scope of displayed totals clear.
- Distinguish bank account balances, household spending, and member obligations in labels.
- Show reporting period, currency, and relevant inclusion rules such as whether pending items count.
- Make personal/shared visibility changes explicit; never imply that joining a household shares every account.
- For splits, show payer, participants, exact portions, remainder treatment, and conserved total before saving.
- Preserve category corrections and recoverable form edits after errors; do not replace them with stale suggestions.
- Show synchronization age, reconnect needs, uncertainty and review reasons where connected
  finance is configured; a disabled provider is not an empty synced account.
- Present suggestions as suggestions. Optional AI is disabled by default; a
  settlement suggestion is not a payment. Label synthetic/demo data clearly.

## Design every state

| State | Expected experience |
| --- | --- |
| Loading | Communicate progress without flashing fabricated totals or shifting core controls unnecessarily. |
| Empty | Explain why no data exists and offer the next currently supported action. |
| Error | Give a safe, specific message and recovery path; keep recoverable edits. |
| Unauthorized | Respect the backend policy without revealing private resource details. |
| Stale/offline | Distinguish previously loaded information from current data; do not promise unsupported offline writes. |
| Validation | Identify affected fields, explain constraints, and help the user correct them. |
| Success | Confirm the effect, update related totals/state consistently, and provide undo where supported. |

## Accessibility goal

Target WCAG 2.2 AA; this is a design goal, not a certification.

- Use semantic headings, lists, buttons, links, and form controls with persistent accessible labels.
- Support keyboard navigation, visible unobscured focus, appropriate dialog focus management, and meaningful announcements.
- Maintain text/UI contrast and communicate all state without depending on color alone.
- Aim for comfortable 44 CSS-pixel touch targets; at minimum satisfy applicable 24 CSS-pixel target-size/spacing
  requirements and verify adjacent controls remain usable on a phone.
- Support text zoom/reflow and reduced motion; avoid motion required to understand financial state.
- Give charts textual summaries or data tables, accessible names, and non-hover access to important values.
- Check loading/error transitions with assistive technology, not just static markup.

Use [testing guidance](../development/testing.md) for exercised/manual evidence.
Automated checks alone cannot establish screen-reader or full zoom conformance.
