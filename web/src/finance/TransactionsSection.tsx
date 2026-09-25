import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  ApiError,
  fetchCsrf,
  fetchFinancialAccounts,
  fetchHouseholdMembers,
  fetchTransaction,
  fetchTransactionAllocation,
  fetchTransactionCategories,
  fetchTransactionCategorization,
  fetchTransactions,
  patchAllocationRevoke,
  patchTransaction,
  postTransaction,
  postTransactionAllocation,
  postTransactionCategorizationRule,
  type CategorizationOrigin,
  type CategorizationState,
  type CreateAllocationInput,
  type CreateTransactionInput,
  type CsrfToken,
  type FinancialAccount,
  type Household,
  type HouseholdMember,
  type Money,
  type Transaction,
  type TransactionAllocation,
  type TransactionCategory,
  type TransactionFeedView,
  type TransactionVisibility,
  type TransactionKind,
} from '../auth/client';
import {
  decodeMoneyAmount,
  encodeMoneyMagnitude,
  formatMoney,
  isSupportedTransactionDate,
  magnitudeOfMinorUnits,
  minorUnitsOfMagnitude,
  type FinancialAccountCurrency,
  type MoneySign,
} from './money';
import { previewEqualShares, sortCanonicalUserIds } from './allocation';
import { categoryLabel } from './categories';
import { CategorizationReviewsSection } from './CategorizationReviewsSection';
import { CategorizationRulesSection } from './CategorizationRulesSection';
import { MemberBalancesSection } from './MemberBalancesSection';
import { ReportingSettingsSection } from './ReportingSettingsSection';
import { SpendingDashboardSection } from './SpendingDashboardSection';
import {
  isFutureDateInZone,
  resolveCalculationZone,
  todayInZone,
} from './reporting';

interface Notice {
  kind: 'info' | 'error' | 'warning';
  text: string;
  correlationId?: string | undefined;
  showRefresh?: boolean | undefined;
}

interface PendingCreate {
  key: string;
  input: CreateTransactionInput;
}

interface PendingVoid {
  transaction: Transaction;
}

interface PendingShare {
  transaction: Transaction;
  action: 'SHARE' | 'REVOKE';
}

/**
 * One explicit "Use for future matches" intent: the durable idempotency key
 * and the exact request are retained together while the outcome is unknown,
 * so a retry never sends an edited payload under an uncertain key and a
 * same-key replay can never create a second rule.
 */
interface PendingRuleCreate {
  key: string;
  transactionId: string;
  description: string;
  expectedTransactionVersion: number;
}

/**
 * One allocation-create intent: the durable key and the exact request are
 * retained together while the outcome is unknown, so an explicit retry
 * never sends an edited payload under an uncertain key.
 */
interface PendingAllocationCreate {
  key: string;
  transactionId: string;
  input: CreateAllocationInput;
}

interface PendingAllocationRevoke {
  transaction: Transaction;
  allocation: TransactionAllocation;
}

interface FieldErrors {
  account?: string | undefined;
  amount?: string | undefined;
  date?: string | undefined;
  description?: string | undefined;
  category?: string | undefined;
  participants?: string | undefined;
}

/**
 * Owner-only provenance for the single open detail panel. It is never
 * fetched per feed row: only the financial owner's own transaction is
 * queried, and every close, generation change, or scope clear drops the
 * request so private evidence cannot publish into a stale panel.
 */
type DetailProvenance =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; state: CategorizationState }
  | { status: 'unavailable' };

/**
 * Calm user-facing provenance labels for the six assignment origins. A raw
 * origin code is never prose, and LEGACY deliberately reads as an existing
 * value rather than an owner choice: only USER is the owner's own decision.
 */
const ORIGIN_LABELS: Record<CategorizationOrigin, string> = {
  NONE: 'No category assigned yet — HouseSync has not classified this entry.',
  LEGACY: 'Existing category — recorded before you chose one.',
  USER: 'Chosen by you — your decision; automation will not replace it.',
  OWNER_RULE: 'Your merchant rule — matched a rule you created.',
  PROVIDER: 'Bank category — mapped from the connected bank data.',
  INHERITED: 'Inherited from expense — this refund follows its source expense.',
};

/** The ledger source of an entry: manual entry or a connected bank feed. */
const SOURCE_LABELS: Record<Transaction['source'], string> = {
  MANUAL: 'Manual',
  CONNECTED: 'Connected',
};

interface TransactionsSectionProps {
  household: Household;
  csrf: CsrfToken | null;
  onCsrfRefreshed: (token: CsrfToken) => void;
  onSessionExpired: () => void;
  onHouseholdAccessChanged: () => void;
  authorityConfirmed: boolean;
  currentUserId: string;
  /** Injected clock for zone-derived entry-date defaults; test seams only. */
  nowProvider?: (() => Date) | undefined;
  /**
   * Bumped by the parent after a sibling account-list mutation commits, so
   * the account selector refetches metadata without remounting this section
   * or discarding the in-progress entry draft.
   */
  accountsRefreshSignal?: number | undefined;
  /**
   * Bumped by the parent after a confirmed bank-activity admission commits,
   * so the visible feed and account metadata converge without remounting
   * this section or discarding form/detail drafts. Dismissals never bump it.
   */
  ledgerRefreshSignal?: number | undefined;
}

const KIND_OPTIONS: Array<{
  value: TransactionKind;
  label: string;
  hint: string;
}> = [
  { value: 'EXPENSE', label: 'Expense', hint: 'Money out' },
  { value: 'INCOME', label: 'Income', hint: 'Money in' },
  { value: 'REFUND', label: 'Refund', hint: 'Money returned for an expense' },
  {
    value: 'TRANSFER',
    label: 'Transfer',
    hint: 'Money in or out of this account',
  },
];

const MIN_DATE = '1900-01-01';
const MAX_DATE = '9999-12-30';

function kindLabel(kind: TransactionKind): string {
  return KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
}

function validateDescription(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return 'Enter a description.';
  if ([...trimmed].length > 200) {
    return 'Description must be at most 200 characters.';
  }
  if (/\p{Cc}/u.test(trimmed)) {
    return 'Description must not contain control characters.';
  }
  return undefined;
}

/**
 * The economic sign is encoded from the kind and, for transfers, the
 * chosen direction; the user always types a positive magnitude.
 */
function signFor(kind: TransactionKind, direction: 'OUT' | 'IN'): MoneySign {
  switch (kind) {
    case 'EXPENSE':
      return 'negative';
    case 'REFUND':
    case 'INCOME':
      return 'positive';
    case 'TRANSFER':
      return direction === 'OUT' ? 'negative' : 'positive';
  }
}

/**
 * The earliest date a corrected expense may keep: every live refund on the
 * loaded page must stay on or after the expense date. Unknown history
 * remains a server-enforced `REFUND_CONFLICT`.
 */
function earliestLiveRefundDate(
  transactions: Transaction[],
  expenseId: string,
): string | undefined {
  let earliest: string | undefined;
  for (const transaction of transactions) {
    if (
      transaction.refundOfTransactionId === expenseId &&
      transaction.status === 'POSTED' &&
      (earliest === undefined || transaction.occurredOn < earliest)
    ) {
      earliest = transaction.occurredOn;
    }
  }
  return earliest;
}

/**
 * Exact combined minor units of the expense's POSTED refunds on the loaded
 * page, or null when none exist. Voided refunds never count toward the
 * documented sum bound, and unpaged history stays a server-enforced
 * `REFUND_CONFLICT`; this is a usability bound for the visible page only.
 */
function postedRefundMinorUnits(
  transactions: Transaction[],
  expenseId: string,
  currency: FinancialAccountCurrency,
): bigint | null {
  let total: bigint | null = null;
  for (const transaction of transactions) {
    if (
      transaction.refundOfTransactionId !== expenseId ||
      transaction.status !== 'POSTED' ||
      transaction.money.currency !== currency
    ) {
      continue;
    }
    const magnitude = transaction.money.amount.startsWith('-')
      ? transaction.money.amount.slice(1)
      : transaction.money.amount;
    total = (total ?? 0n) + minorUnitsOfMagnitude(magnitude, currency);
  }
  return total;
}

/** The positive magnitude of an expense's recorded amount. */
function expenseMagnitudeOf(transaction: Transaction): string {
  return transaction.money.amount.startsWith('-')
    ? transaction.money.amount.slice(1)
    : transaction.money.amount;
}

/**
 * Only a POSTED HOUSEHOLD EXPENSE can carry an active allocation, so only
 * such rows are allocation-fetch candidates. Private, voided, and
 * non-expense rows are never queried, so other members' private or
 * revoked state is never probed or leaked.
 */
function isAllocationFetchable(transaction: Transaction): boolean {
  return (
    transaction.kind === 'EXPENSE' &&
    transaction.status === 'POSTED' &&
    transaction.visibility === 'HOUSEHOLD'
  );
}

export function TransactionsSection({
  household,
  csrf,
  onCsrfRefreshed,
  onSessionExpired,
  onHouseholdAccessChanged,
  authorityConfirmed,
  currentUserId,
  nowProvider,
  accountsRefreshSignal = 0,
  ledgerRefreshSignal = 0,
}: TransactionsSectionProps) {
  function clockNow(): Date {
    return nowProvider ? nowProvider() : new Date();
  }
  const [accounts, setAccounts] = useState<FinancialAccount[] | null>(null);
  const [categories, setCategories] = useState<TransactionCategory[] | null>(
    null,
  );
  const [ownTransactions, setOwnTransactions] = useState<Transaction[] | null>(
    null,
  );
  const [ownHasMore, setOwnHasMore] = useState(false);
  const [ownNextOffset, setOwnNextOffset] = useState(0);
  const [ownVisibility, setOwnVisibility] =
    useState<TransactionVisibility | null>(null);
  const [householdTransactions, setHouseholdTransactions] = useState<
    Transaction[] | null
  >(null);
  const [householdHasMore, setHouseholdHasMore] = useState(false);
  const [householdNextOffset, setHouseholdNextOffset] = useState(0);
  const [activeView, setActiveView] = useState<TransactionFeedView>('OWN');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Create-form draft state. The date default follows the household
  // reporting zone for the injected clock, never the browser zone; it starts
  // at the documented initial zone until the settings section reports the
  // stored one.
  const [createAccountId, setCreateAccountId] = useState('');
  const [createKind, setCreateKind] = useState<
    'EXPENSE' | 'INCOME' | 'TRANSFER'
  >('EXPENSE');
  const [createAmount, setCreateAmount] = useState('');
  const [createDirection, setCreateDirection] = useState<'OUT' | 'IN'>('OUT');
  const [createDate, setCreateDate] = useState(() =>
    todayInZone('Etc/UTC', clockNow()),
  );
  /**
   * True once the viewer edits the date input. A loaded zone recomputes the
   * default only while the draft is pristine; user-edited dates survive
   * every zone change. A ref suffices because the flag is only read when a
   * zone arrives, never rendered.
   */
  const createDateTouchedRef = useRef(false);
  const [createDescription, setCreateDescription] = useState('');
  // '' means the explicit uncategorized option; a token otherwise.
  const [createCategory, setCreateCategory] = useState('');
  const [createFieldErrors, setCreateFieldErrors] = useState<FieldErrors>({});
  // Refund creation originates from a posted expense row and locks the
  // account, currency, and source in the form below.
  const [refundSource, setRefundSource] = useState<Transaction | null>(null);

  const [creating, setCreating] = useState(false);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(
    null,
  );

  const [detail, setDetail] = useState<Transaction | null>(null);
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  // Owner-only provenance for the open detail panel. It is fetched
  // when the owner opens one entry's details and never per feed row.
  const [detailProvenance, setDetailProvenance] = useState<DetailProvenance>({
    status: 'idle',
  });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editDirection, setEditDirection] = useState<'OUT' | 'IN'>('OUT');
  const [editDate, setEditDate] = useState('');
  const [editDescription, setEditDescription] = useState('');
  // '' means uncategorized; a token otherwise.
  const [editCategory, setEditCategory] = useState('');
  const [editFieldErrors, setEditFieldErrors] = useState<FieldErrors>({});

  const [pendingVoid, setPendingVoid] = useState<PendingVoid | null>(null);
  const [pendingShare, setPendingShare] = useState<PendingShare | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  // Explicit rule learning. `pendingRuleCreate` retains the durable key
  // and the exact request together while the outcome is unknown, so an
  // explicit retry can never create a second rule under a fresh key; the
  // signal converges the private rule list after a create commits.
  const [pendingRuleCreate, setPendingRuleCreate] =
    useState<PendingRuleCreate | null>(null);
  const [ruleCreating, setRuleCreating] = useState(false);
  const [rulesRefresh, setRulesRefresh] = useState(0);
  // Reviews: every commit that can create, supersede, or resolve an
  // owner-private suggestion (a manual entry, a category correction, a void,
  // or a connected admission) bumps this signal so the review queue and its
  // open count converge without remounting the section.
  const [reviewsRefresh, setReviewsRefresh] = useState(0);
  // Bumped by every scope clear so the private rule panel drops its own
  // retained list and in-flight requests with the rest of the section.
  const [scopeReset, setScopeReset] = useState(0);

  // Allocation state. The cache holds the active allocation per
  // transaction ID, null when the server answers that none is active, and
  // stays undefined while unknown; only the affected entry is ever cleared.
  const [allocationByTransaction, setAllocationByTransaction] = useState<
    Record<string, TransactionAllocation | null>
  >({});
  const [splitTransaction, setSplitTransaction] = useState<Transaction | null>(
    null,
  );
  const [splitLoadingId, setSplitLoadingId] = useState<string | null>(null);
  const [splitParticipants, setSplitParticipants] = useState<string[]>([]);
  const [splitFieldErrors, setSplitFieldErrors] = useState<FieldErrors>({});
  const [roster, setRoster] = useState<HouseholdMember[] | null>(null);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [rosterError, setRosterError] = useState<string | undefined>(undefined);
  const [allocationCreating, setAllocationCreating] = useState(false);
  const [pendingAllocation, setPendingAllocation] =
    useState<PendingAllocationCreate | null>(null);
  const [pendingRevoke, setPendingRevoke] =
    useState<PendingAllocationRevoke | null>(null);
  // Derived balances refresh after every mutation that can change them.
  const [balancesRefresh, setBalancesRefresh] = useState(0);
  // Reporting: the authoritative zone reported up by the settings
  // section (initially the documented Etc/UTC) and a refresh signal that
  // refetches the spending dashboard after relevant mutations.
  const [reportingZone, setReportingZone] = useState('Etc/UTC');
  const [reportingRefresh, setReportingRefresh] = useState(0);

  const csrfRef = useRef(csrf);
  const generationRef = useRef(0);
  const unmountedRef = useRef(false);
  const pageLoadingRef = useRef(false);
  const controllersRef = useRef<Set<AbortController>>(new Set());
  const creatingRef = useRef(false);
  const updatingRef = useRef<string | null>(null);
  // Synchronous source of truth for in-flight detail fetches: state updates
  // are async, so a second activation in the same flush must be refused by
  // the ref, not the not-yet-flushed state.
  const detailLoadingRef = useRef(false);
  // Owner-only provenance requests are superseded by sequence and aborted by
  // the newest request, the panel's close, and every scope clear.
  const provenanceControllerRef = useRef<AbortController | null>(null);
  const provenanceSeqRef = useRef(0);
  const ruleCreatingRef = useRef(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  const feedControlRef = useRef<HTMLInputElement>(null);
  const topPagerRef = useRef<HTMLButtonElement>(null);
  const bottomPagerRef = useRef<HTMLButtonElement>(null);
  // A final page removes both pagers. Remember whether one held focus before
  // that update, then hand off only after React has committed its removal.
  const pendingPagerFocusRef = useRef<{
    generation: number;
    signal: AbortSignal;
  } | null>(null);
  // A field-level rejection announces through the notice but moves focus to
  // the rejected control, so the notice's own focus effect yields exactly once
  // for that notice instead of racing the field focus.
  const skipNoticeFocusRef = useRef(false);
  const createAccountRef = useRef<HTMLSelectElement>(null);
  const createCategoryRef = useRef<HTMLSelectElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const editAmountRef = useRef<HTMLInputElement>(null);
  const editCategoryRef = useRef<HTMLSelectElement>(null);
  const voidConfirmRef = useRef<HTMLDivElement>(null);
  const voidTriggerRef = useRef<HTMLButtonElement | null>(null);
  const detailPanelRef = useRef<HTMLDivElement>(null);
  const shareConfirmRef = useRef<HTMLDivElement>(null);
  const shareTriggerRef = useRef<HTMLButtonElement | null>(null);
  const splitPanelRef = useRef<HTMLDivElement>(null);
  const splitTriggerRef = useRef<HTMLButtonElement | null>(null);
  const revokeConfirmRef = useRef<HTMLDivElement>(null);
  const revokeTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Synchronous source of truth for in-flight split-panel work: state
  // updates are async, so a same-flush second activation reads this ref.
  const splitLoadingRef = useRef(false);
  // Latest reporting zone for async mutation continuations, which otherwise
  // close over a stale render's value when resetting the entry-date draft.
  const reportingZoneRef = useRef(reportingZone);
  // Sibling account-list refresh sequencing, deliberately decoupled from
  // the shared transaction-feed generation so a feed reload or mutation can
  // never invalidate an in-flight metadata fetch. `servedAccountSignalRef`
  // holds the last signal whose metadata converged (starting at the initial
  // prop so mounting never refetches what the initial load already
  // includes); `pendingAccountSignalRef` keeps a pre-load signal alive until
  // the initial metadata settles; `accountRefreshSeqRef` orders concurrent
  // metadata fetches so only the newest response publishes; and
  // `activeAccountRefreshRef` aborts the superseded request.
  const servedAccountSignalRef = useRef(accountsRefreshSignal);
  const pendingAccountSignalRef = useRef(false);
  const accountRefreshSeqRef = useRef(0);
  const activeAccountRefreshRef = useRef<AbortController | null>(null);

  // Dedicated ledger signal from a sibling bank-activity confirmation. It is
  // deliberately separate from account-only semantics: a confirmation changes
  // the visible ledger and household spending but no account identity. A
  // signal that arrives before the initial load settles is parked and served
  // afterwards, so a commit can never be lost to a racing first read.
  const servedLedgerSignalRef = useRef(ledgerRefreshSignal);
  const pendingLedgerSignalRef = useRef(false);
  useEffect(() => {
    reportingZoneRef.current = reportingZone;
  }, [reportingZone]);

  // Intl-safe zone for every local date calculation below. The stored zone
  // itself stays authoritative for display; a host that cannot support it
  // computes against the explicit fallback instead of throwing.
  const calculationZone = resolveCalculationZone(reportingZone).zone;

  /**
   * Adopt the stored zone and, while the date draft is pristine, its
   * zone-derived default for the injected clock. A user-edited date is never
   * overwritten by a zone arrival.
   */
  function handleZoneLoaded(zone: string) {
    setReportingZone(zone);
    if (!createDateTouchedRef.current) {
      setCreateDate(
        todayInZone(
          resolveCalculationZone(zone).zone,
          nowProvider ? nowProvider() : new Date(),
        ),
      );
    }
  }

  useEffect(() => {
    csrfRef.current = csrf;
  }, [csrf]);

  function current(generation: number): boolean {
    return !unmountedRef.current && generationRef.current === generation;
  }

  useLayoutEffect(() => {
    const pending = pendingPagerFocusRef.current;
    if (!pending) return;
    if (!current(pending.generation) || pending.signal.aborted) {
      pendingPagerFocusRef.current = null;
      return;
    }
    // Another commit may precede the page commit; wait until the focused
    // pager has actually gone rather than guessing when a frame will run.
    if (topPagerRef.current || bottomPagerRef.current) return;
    pendingPagerFocusRef.current = null;
    // A notice or a deliberate focus move must retain precedence.
    if (!notice && document.activeElement === document.body) {
      feedControlRef.current?.focus();
    }
  });

  function track(controller: AbortController) {
    controllersRef.current.add(controller);
  }

  function untrack(controller: AbortController) {
    controllersRef.current.delete(controller);
  }

  function setFeedPage(
    view: TransactionFeedView,
    page: {
      items: Transaction[];
      hasMore: boolean;
      offset: number;
      limit: number;
    },
  ) {
    const byId = new Map<string, Transaction>();
    for (const item of page.items) {
      const previous = byId.get(item.id);
      if (!previous || item.version > previous.version) byId.set(item.id, item);
    }
    const rows = [...byId.values()];
    if (view === 'OWN') {
      setOwnTransactions(rows);
      setOwnHasMore(page.hasMore);
      setOwnNextOffset(page.offset + page.limit);
    } else {
      setHouseholdTransactions(rows);
      setHouseholdHasMore(page.hasMore);
      setHouseholdNextOffset(page.offset + page.limit);
    }
  }

  function activeTransactions(): Transaction[] | null {
    return activeView === 'OWN' ? ownTransactions : householdTransactions;
  }

  function activeHasMore(): boolean {
    return activeView === 'OWN' ? ownHasMore : householdHasMore;
  }

  function activeNextOffset(): number {
    return activeView === 'OWN' ? ownNextOffset : householdNextOffset;
  }
  async function loadMore() {
    const view = activeView;
    const offset = activeNextOffset();
    if (
      pageLoadingRef.current ||
      loading ||
      !authorityConfirmed ||
      !activeHasMore() ||
      offset > 10000 ||
      confirmOrMutationActive()
    )
      return;
    const generation = generationRef.current;
    const controller = new AbortController();
    track(controller);
    pageLoadingRef.current = true;
    setLoadingMore(true);
    setPageError(null);
    try {
      const page = await fetchTransactions(
        household.id,
        view,
        controller.signal,
        {
          offset,
          visibility: view === 'OWN' ? (ownVisibility ?? undefined) : undefined,
        },
      );
      if (!current(generation) || controller.signal.aborted) return;
      if (
        (!page.hasMore || page.offset + page.limit > 10000) &&
        (document.activeElement === topPagerRef.current ||
          document.activeElement === bottomPagerRef.current)
      ) {
        pendingPagerFocusRef.current = {
          generation,
          signal: controller.signal,
        };
      }
      // Offset comes from the server page boundary, not the count of unique rows.
      // A newer version from an earlier page wins against a stale overlapping row.
      const merge = (rows: Transaction[] | null) => {
        const merged = new Map((rows ?? []).map((row) => [row.id, row]));
        for (const row of page.items) {
          const previous = merged.get(row.id);
          if (!previous || row.version > previous.version)
            merged.set(row.id, row);
        }
        return [...merged.values()];
      };
      if (view === 'OWN') {
        setOwnTransactions(merge);
        setOwnHasMore(page.hasMore);
        setOwnNextOffset(page.offset + page.limit);
      } else {
        setHouseholdTransactions(merge);
        setHouseholdHasMore(page.hasMore);
        setHouseholdNextOffset(page.offset + page.limit);
      }
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      if (error instanceof ApiError && mapCommonErrors(error)) return;
      setPageError(
        error instanceof ApiError && error.timedOut
          ? 'Loading more transactions timed out. Try again.'
          : 'Could not load the next page. Try again.',
      );
    } finally {
      untrack(controller);
      if (current(generation)) {
        pageLoadingRef.current = false;
        setLoadingMore(false);
      }
    }
  }

  function loadedViews(): TransactionFeedView[] {
    const views: TransactionFeedView[] = [];
    if (ownTransactions !== null) views.push('OWN');
    if (householdTransactions !== null) views.push('HOUSEHOLD');
    return views;
  }

  async function load(
    generation: number,
    controller: AbortController,
    options: {
      views: TransactionFeedView[];
      includeMeta: boolean;
      preserveNotice: boolean;
      visibility?: TransactionVisibility | null;
    },
  ) {
    setLoading(true);
    if (!options.preserveNotice) setNotice(null);
    try {
      const [accountsPage, categoriesOutcome, feedPages] = await Promise.all([
        options.includeMeta
          ? fetchFinancialAccounts(household.id, controller.signal)
          : Promise.resolve(null),
        options.includeMeta
          ? fetchTransactionCategories(household.id, controller.signal).then(
              (page) => ({ items: page.items, failure: null as unknown }),
              (failure: unknown) => ({ items: null, failure }),
            )
          : Promise.resolve(null),
        Promise.all(
          options.views.map((view) =>
            fetchTransactions(household.id, view, controller.signal, {
              visibility:
                view === 'OWN' ? (options.visibility ?? undefined) : undefined,
            }),
          ),
        ),
      ]);
      if (!current(generation) || controller.signal.aborted) return;
      if (accountsPage) setAccounts(accountsPage.items);
      options.views.forEach((view, index) => {
        const page = feedPages[index];
        if (page) setFeedPage(view, page);
      });
      setPageError(null);
      setLoadingMore(false);
      pageLoadingRef.current = false;
      setLoading(false);
      if (categoriesOutcome) {
        if (categoriesOutcome.items) {
          setCategories(categoriesOutcome.items);
        } else {
          const apiError =
            categoriesOutcome.failure instanceof ApiError
              ? categoriesOutcome.failure
              : new ApiError({
                  status: 0,
                  code: 'NETWORK_ERROR',
                  message: 'Could not load transaction categories.',
                });
          if (apiError.status === 401) {
            clearScopedState();
            onSessionExpired();
            return;
          }
          if (apiError.code === 'HOUSEHOLD_NOT_FOUND') {
            clearScopedState();
            onHouseholdAccessChanged();
            return;
          }
          setCategories(null);
          setNotice({
            kind: 'warning',
            text: 'The category list could not be loaded, so category names are unavailable. Refresh to retry.',
            correlationId: apiError.correlationId,
            showRefresh: true,
          });
        }
      }
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not load your transactions.',
            });
      setLoading(false);
      if (apiError.status === 401) {
        clearScopedState();
        onSessionExpired();
        return;
      }
      if (apiError.code === 'HOUSEHOLD_NOT_FOUND') {
        clearScopedState();
        onHouseholdAccessChanged();
        return;
      }
      setNotice({
        kind: 'error',
        text: apiError.timedOut
          ? 'Loading transactions timed out. Refresh to try again.'
          : apiError.message || 'Could not load your transactions.',
        correlationId: apiError.correlationId,
        showRefresh: true,
      });
    }
  }

  function refresh() {
    if (loading || creatingRef.current || updatingRef.current !== null) return;
    const views = loadedViews();
    reloadViews(views.length ? views : [activeView], true, false);
  }

  /**
   * Mutation outcomes refresh every loaded feed so the own and household
   * projections never contradict the committed server state.
   */
  function reloadTransactions(preserveNotice = false) {
    reloadViews(loadedViews(), false, preserveNotice);
    // Every committed transaction/share/refund mutation can move household
    // spending, so the dashboard refetches the shown period alongside the
    // feeds. Manual feed refreshes keep their own scope; the dashboard has
    // its own refresh control.
    setReportingRefresh((value) => value + 1);
  }

  function reloadViews(
    views: TransactionFeedView[],
    includeMeta: boolean,
    preserveNotice: boolean,
    visibility: TransactionVisibility | null = ownVisibility,
  ) {
    const generation = ++generationRef.current;
    pendingPagerFocusRef.current = null;
    pageLoadingRef.current = false;
    setLoadingMore(false);
    setPageError(null);
    const controller = new AbortController();
    track(controller);
    // A filtered page cannot establish whether an open detail was revoked.
    // Reauthorize by ID independently; a transient failure keeps the panel
    // and offers refresh, while a confirmed 404 closes it.
    if (detail) {
      const detailId = detail.id;
      void fetchTransaction(household.id, detailId, controller.signal).then(
        (fresh) => {
          if (!current(generation) || controller.signal.aborted) return;
          // A reauthorization read can be answered by a representation older
          // than one this session already committed (for example a detail
          // GET issued before a just-committed category correction). It must
          // never overwrite the newer committed representation, which would
          // silently revert the correction and desynchronize the provenance
          // panel; the next authoritative read reconciles it.
          setDetail((opened) =>
            opened?.id === detailId && fresh.version >= opened.version
              ? fresh
              : opened,
          );
        },
        (error: unknown) => {
          if (!current(generation) || controller.signal.aborted) return;
          if (error instanceof ApiError && mapCommonErrors(error)) return;
          if (
            error instanceof ApiError &&
            error.code === 'TRANSACTION_NOT_FOUND'
          ) {
            setDetail((opened) => (opened?.id === detailId ? null : opened));
            resetProvenance();
            removeFromFeeds(detailId);
            return;
          }
          setNotice({
            kind: 'warning',
            text: 'Could not verify the open transaction details. Refresh to try again.',
            showRefresh: true,
          });
        },
      );
    }
    void load(generation, controller, {
      views,
      includeMeta,
      preserveNotice,
      visibility,
    }).finally(() => untrack(controller));
  }

  function switchView(view: TransactionFeedView) {
    if (view === activeView) return;
    if (
      loading ||
      creatingRef.current ||
      updatingRef.current !== null ||
      detailLoadingRef.current ||
      pendingCreate !== null ||
      pendingVoid !== null ||
      pendingShare !== null ||
      pendingRevoke !== null ||
      !authorityConfirmed
    ) {
      return;
    }
    setActiveView(view);
    if (view === 'OWN') {
      setOwnTransactions(null);
      setOwnNextOffset(0);
      setOwnHasMore(false);
    } else {
      setHouseholdTransactions(null);
      setHouseholdNextOffset(0);
      setHouseholdHasMore(false);
    }
    reloadViews([view], categories === null, false);
  }

  function switchVisibility(visibility: TransactionVisibility | null) {
    if (
      visibility === ownVisibility ||
      pendingCreate !== null ||
      confirmOrMutationActive() ||
      detailLoadingRef.current
    )
      return;
    setOwnVisibility(visibility);
    setOwnTransactions(null);
    setOwnHasMore(false);
    setOwnNextOffset(0);
    // The new filter is passed explicitly because React has not rendered its
    // state update yet.
    reloadViews(['OWN'], categories === null, false, visibility);
  }

  /**
   * Drops the owner-only provenance of the open panel: the in-flight request
   * is aborted, its sequence invalidated, and the state returned to idle so a
   * late response can never publish into a closed panel or a cleared scope.
   */
  function resetProvenance() {
    provenanceControllerRef.current?.abort();
    provenanceControllerRef.current = null;
    provenanceSeqRef.current += 1;
    setDetailProvenance((current) =>
      current.status === 'idle' ? current : { status: 'idle' },
    );
  }
  function clearScopedState() {
    // Old generations must not publish into cleared state: in-flight
    // load continuations are ignored from here on.
    generationRef.current += 1;
    pendingPagerFocusRef.current = null;
    for (const controller of controllersRef.current) controller.abort();
    pageLoadingRef.current = false;
    setLoadingMore(false);
    setPageError(null);
    setOwnNextOffset(0);
    setHouseholdNextOffset(0);
    setOwnVisibility(null);
    setAccounts(null);
    setCategories(null);
    setOwnTransactions(null);
    setOwnHasMore(false);
    setHouseholdTransactions(null);
    setHouseholdHasMore(false);
    setPendingCreate(null);
    setRefundSource(null);
    setDetail(null);
    setEditingId(null);
    setEditAmount('');
    setEditDescription('');
    setEditCategory('');
    setEditFieldErrors({});
    // Owner-only provenance is private classification evidence: it is aborted
    // and dropped with every other scoped draft on sign-out, session expiry,
    // household switch, and access loss.
    resetProvenance();
    // The retained learn intent is private merchant evidence too: it is
    // dropped with the same scope change, never retried into a new household.
    ruleCreatingRef.current = false;
    setPendingRuleCreate(null);
    setRuleCreating(false);
    setScopeReset((value) => value + 1);
    setPendingVoid(null);
    setPendingShare(null);
    shareTriggerRef.current = null;
    setCreateCategory('');
    setCreateAmount('');
    setCreateDescription('');
    setCreateFieldErrors({});
    // Allocation/balance scoped state: allocation cache, split panel,
    // roster, retained create intent, revoke confirm, and balances.
    setAllocationByTransaction({});
    setSplitTransaction(null);
    setSplitParticipants([]);
    setSplitFieldErrors({});
    setRoster(null);
    setRosterLoading(false);
    setRosterError(undefined);
    setAllocationCreating(false);
    setPendingAllocation(null);
    setPendingRevoke(null);
    setSplitLoadingId(null);
    splitTriggerRef.current = null;
    revokeTriggerRef.current = null;
    splitLoadingRef.current = false;
    setReportingZone('Etc/UTC');
    createDateTouchedRef.current = false;
  }

  useEffect(() => {
    unmountedRef.current = false;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    track(controller);
    void load(generation, controller, {
      views: ['OWN'],
      includeMeta: true,
      preserveNotice: false,
    }).finally(() => untrack(controller));
    const controllers = controllersRef.current;
    return () => {
      unmountedRef.current = true;
      generationRef.current += 1;
      pendingPagerFocusRef.current = null;
      for (const owned of controllers) owned.abort();
    };
    // Household identity is fixed for this keyed component instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Refetches sibling-committed account metadata without touching feeds,
   * categories, panels, or the entry draft, and without consulting the
   * shared feed generation: feed reloads and mutations proceed
   * independently. Only the newest started fetch may publish — an older
   * response that arrives late is dropped — and unmount always wins.
   * Failures stay silent: the selector keeps its last-known list and the
   * existing manual refresh recovers, so a background error can never steal
   * focus from or discard an in-progress draft.
   */
  function refreshAccountMetadata(signal: number) {
    // Abort the superseded request first so its late response can never
    // publish after the newer one; the sequence guard below covers a
    // response that already slipped past the abort.
    activeAccountRefreshRef.current?.abort();
    const controller = new AbortController();
    activeAccountRefreshRef.current = controller;
    track(controller);
    const sequence = ++accountRefreshSeqRef.current;
    void (async () => {
      try {
        const page = await fetchFinancialAccounts(
          household.id,
          controller.signal,
        );
        if (
          unmountedRef.current ||
          controller.signal.aborted ||
          accountRefreshSeqRef.current !== sequence
        ) {
          return;
        }
        setAccounts(page.items);
        servedAccountSignalRef.current = signal;
      } catch {
        // Silent by design; see the doc comment above.
      } finally {
        untrack(controller);
        if (activeAccountRefreshRef.current === controller) {
          activeAccountRefreshRef.current = null;
        }
      }
    })();
  }

  // A sibling account-list mutation (create, rename, archive, reactivate)
  // bumps accountsRefreshSignal after its list change commits. A signal
  // that arrives before the initial metadata settles stays pending — it is
  // never marked served — and the accounts effect below serves it with a
  // post-load fetch that guarantees the committed result converges.
  useEffect(() => {
    if (servedAccountSignalRef.current === accountsRefreshSignal) return;
    if (accounts === null) {
      pendingAccountSignalRef.current = true;
      return;
    }
    pendingAccountSignalRef.current = false;
    refreshAccountMetadata(accountsRefreshSignal);
    // The signal alone drives this effect; `accounts` is read only to park
    // the pre-load signal for the accounts effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountsRefreshSignal]);

  // Serves a signal parked while metadata was still loading: once the
  // initial load settles, refetch so the committed account converges even
  // when the initial read raced the commit and missed it.
  useEffect(() => {
    if (accounts === null || !pendingAccountSignalRef.current) return;
    if (servedAccountSignalRef.current === accountsRefreshSignal) {
      pendingAccountSignalRef.current = false;
      return;
    }
    pendingAccountSignalRef.current = false;
    refreshAccountMetadata(accountsRefreshSignal);
    // `accounts` becoming non-null is the trigger; the parked flag and the
    // signal decide whether a fetch is owed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts]);

  /**
   * Serves the dedicated ledger signal with a metadata-inclusive reload so a
   * confirmed CONNECTED entry and a possibly stale selector converge while
   * every form and detail draft stays in place. A signal arriving before the
   * initial load settles is parked, never marked served. The allocation
   * cache is cleared because a void or replacement deactivates
   * allocations atomically; the feed-driven probe repopulates live state.
   */
  function serveLedgerSignal(signal: number) {
    // Deferred past the current task so the signal effect never performs a
    // synchronous cascading state update; the parked/served refs still settle
    // before any later signal can be observed.
    void (async () => {
      await Promise.resolve();
      const views = loadedViews();
      if (views.length === 0) {
        pendingLedgerSignalRef.current = true;
        return;
      }
      pendingLedgerSignalRef.current = false;
      servedLedgerSignalRef.current = signal;
      // A sibling void or replacement retires allocations: unknown beats
      // stale, and the probe below repopulates only live entries.
      setAllocationByTransaction({});
      reloadViews(views, true, true);
      // A confirmed connected entry can be classified by the deterministic
      // classifier, so the owner's private review count and queue converge
      // alongside the feed. Dismissals never reach here.
      setReviewsRefresh((value) => value + 1);
      // A confirmed entry can move household spending exactly like a manual
      // mutation, so the dashboard refetches the shown period too.
      setReportingRefresh((value) => value + 1);
    })();
  }

  useEffect(() => {
    if (servedLedgerSignalRef.current === ledgerRefreshSignal) return;
    if (accounts === null || loadedViews().length === 0) {
      pendingLedgerSignalRef.current = true;
      return;
    }
    serveLedgerSignal(ledgerRefreshSignal);
    // The signal alone drives this effect; other state is read only to park a
    // pre-load signal for the settling effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerRefreshSignal]);

  useEffect(() => {
    if (!pendingLedgerSignalRef.current) return;
    if (accounts === null || loadedViews().length === 0) return;
    if (servedLedgerSignalRef.current === ledgerRefreshSignal) {
      pendingLedgerSignalRef.current = false;
      return;
    }
    serveLedgerSignal(ledgerRefreshSignal);
    // Initial-load settling is the trigger; the parked flag decides whether a
    // fetch is owed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, ownTransactions, householdTransactions]);

  useEffect(() => {
    if (!notice) return;
    if (skipNoticeFocusRef.current) {
      skipNoticeFocusRef.current = false;
      return;
    }
    noticeRef.current?.focus();
  }, [notice]);

  useEffect(() => {
    if (pendingVoid) voidConfirmRef.current?.focus();
  }, [pendingVoid]);

  useEffect(() => {
    if (pendingShare) shareConfirmRef.current?.focus();
  }, [pendingShare]);

  useEffect(() => {
    if (detail) detailPanelRef.current?.focus();
  }, [detail]);

  // Private provenance exists only while a detail panel is open. Defer cleanup past the current
  // render; opening a replacement detail increments the sequence first, so this closure cannot
  // abort the replacement request.
  useEffect(() => {
    if (detail) return;
    const sequence = provenanceSeqRef.current;
    void Promise.resolve().then(() => {
      if (
        unmountedRef.current ||
        provenanceSeqRef.current !== sequence ||
        detail
      ) {
        return;
      }
      resetProvenance();
    });
  }, [detail]);

  async function ensureCsrf(
    generation: number,
    signal: AbortSignal,
  ): Promise<CsrfToken | null> {
    if (csrfRef.current) return csrfRef.current;
    try {
      const fresh = await fetchCsrf(signal);
      if (!current(generation) || signal.aborted) return null;
      csrfRef.current = fresh;
      onCsrfRefreshed(fresh);
      return fresh;
    } catch {
      return null;
    }
  }

  async function refreshCsrf(generation: number, signal: AbortSignal) {
    try {
      const fresh = await fetchCsrf(signal);
      if (!current(generation) || signal.aborted) return false;
      csrfRef.current = fresh;
      onCsrfRefreshed(fresh);
      return true;
    } catch {
      return false;
    }
  }

  function handleSessionLost() {
    clearScopedState();
    onSessionExpired();
  }

  function handleAccessLost() {
    clearScopedState();
    onHouseholdAccessChanged();
  }

  function mapCommonErrors(apiError: ApiError): boolean {
    if (apiError.status === 401) {
      handleSessionLost();
      return true;
    }
    if (apiError.code === 'HOUSEHOLD_NOT_FOUND') {
      handleAccessLost();
      return true;
    }
    return false;
  }

  function setAllocationFor(
    transactionId: string,
    allocation: TransactionAllocation | null,
  ) {
    setAllocationByTransaction((current) => ({
      ...current,
      [transactionId]: allocation,
    }));
  }

  function bumpBalances() {
    setBalancesRefresh((value) => value + 1);
  }

  /**
   * Converges the visible feeds and the open detail panel on a transaction
   * whose category a review decision just committed. The category is
   * descriptive, so member balances and exact spending totals stay exactly as
   * they are (they are category-agnostic), and unrelated create, edit, split,
   * and review drafts stay untouched. The committed representation lands
   * immediately, and the authoritative feed reload that follows corrects
   * ordering or paging the local update cannot.
   */
  function handleReviewedTransaction(transaction: Transaction) {
    setOwnTransactions((current) =>
      current === null
        ? current
        : current.map((value) =>
            value.id === transaction.id ? transaction : value,
          ),
    );
    setHouseholdTransactions((current) =>
      current === null
        ? current
        : current.map((value) =>
            value.id === transaction.id ? transaction : value,
          ),
    );
    setDetail((current) =>
      current?.id === transaction.id ? transaction : current,
    );
    // Owner-only provenance follows the committed decision, so the panel
    // explains the new origin without being reopened.
    if (detail?.id === transaction.id) void loadProvenance(transaction);
    reloadViews(loadedViews(), false, true);
  }

  /**
   * A mutation failure with an uncertain server outcome (stale version,
   * exhausted retries, or an unknown result) must not cache a confident
   * "none": removing the key returns the entry to unknown so the next
   * feed-driven probe reconciles with the server's actual state.
   */
  function clearAllocationFor(transactionId: string) {
    setAllocationByTransaction((current) => {
      if (!(transactionId in current)) return current;
      const next = { ...current };
      delete next[transactionId];
      return next;
    });
  }

  /**
   * Background allocation probe for one expense: an active allocation is
   * cached; `ALLOCATION_NOT_FOUND` or a stale-row 404 clears only this
   * entry so another member's private or revoked state never leaks;
   * session and access errors reconcile upward; other errors leave the
   * entry unknown instead of spamming per-row notices.
   */
  async function loadAllocationFor(
    transactionId: string,
    generation: number,
    controller: AbortController,
  ): Promise<void> {
    try {
      const allocation = await fetchTransactionAllocation(
        household.id,
        transactionId,
        controller.signal,
      );
      if (!current(generation) || controller.signal.aborted) return;
      setAllocationFor(transactionId, allocation);
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      if (!(error instanceof ApiError)) return;
      if (
        error.code === 'ALLOCATION_NOT_FOUND' ||
        error.code === 'TRANSACTION_NOT_FOUND'
      ) {
        setAllocationFor(transactionId, null);
        return;
      }
      if (error.status === 401) {
        handleSessionLost();
        return;
      }
      if (error.code === 'HOUSEHOLD_NOT_FOUND') {
        handleAccessLost();
      }
    }
  }

  // Allocation state for rendered expense rows: unknown entries are probed
  // once per feed page; known entries (active or none) are never refetched
  // here, and the affected entry alone is cleared on a stale 404.
  useEffect(() => {
    const seen = new Set<string>();
    const unknownIds: string[] = [];
    for (const transaction of [
      ...(ownTransactions ?? []),
      ...(householdTransactions ?? []),
    ]) {
      if (!isAllocationFetchable(transaction)) continue;
      if (seen.has(transaction.id)) continue;
      seen.add(transaction.id);
      if (allocationByTransaction[transaction.id] === undefined) {
        unknownIds.push(transaction.id);
      }
    }
    if (unknownIds.length === 0) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    track(controller);
    void (async () => {
      await Promise.all(
        unknownIds.map((id) => loadAllocationFor(id, generation, controller)),
      );
    })().finally(() => untrack(controller));
    // The cache is read only to decide what is unknown; feed pages drive
    // this effect so a mid-flight cache write never duplicates probes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownTransactions, householdTransactions]);

  function buildCreateInput():
    | { ok: true; input: CreateTransactionInput }
    | { ok: false; errors: FieldErrors } {
    const errors: FieldErrors = {};
    const source = refundSource;
    const accountId = source ? (source.accountId ?? '') : createAccountId;
    const account = accounts?.find((value) => value.id === accountId);
    if (!source && !createAccountId) {
      // The select's first option is an explicit placeholder.
      errors.account = 'Choose an account.';
    }
    if (!account) {
      return { ok: false, errors: { account: 'Choose an account.' } };
    }
    const kind = source ? 'REFUND' : createKind;
    const sign = signFor(kind, createDirection);
    const encoded = encodeMoneyMagnitude(createAmount, account.currency, sign);
    if (!encoded.ok) {
      errors.amount = encoded.error;
    }
    if (!isSupportedTransactionDate(createDate)) {
      errors.date = `Enter a calendar date between ${MIN_DATE} and ${MAX_DATE}.`;
    } else if (source && createDate < source.occurredOn) {
      errors.date = `The refund date cannot be before the expense date (${source.occurredOn}).`;
    }
    const description = validateDescription(createDescription);
    if (description) {
      errors.description = description;
    }
    if (Object.keys(errors).length > 0) {
      return { ok: false, errors };
    }
    // Validations passed, so the encoding is known to be ok.
    const money: Money = {
      amount: encoded.ok ? encoded.amount : '',
      currency: account.currency,
    };
    if (source) {
      // Refund visibility and category are inherited from the source
      // expense by omission; the exact source is carried on the payload.
      return {
        ok: true,
        input: {
          accountId: source.accountId ?? '',
          kind: 'REFUND',
          money,
          occurredOn: createDate,
          description: createDescription.trim(),
          refundOfTransactionId: source.id,
        },
      };
    }
    return {
      ok: true,
      input: {
        accountId,
        kind: createKind,
        money,
        occurredOn: createDate,
        description: createDescription.trim(),
        visibility: 'PRIVATE',
        category: createCategory === '' ? null : createCategory,
      },
    };
  }

  function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (creatingRef.current || pendingCreate || !authorityConfirmed) return;
    const built = buildCreateInput();
    if (!built.ok) {
      setCreateFieldErrors(built.errors);
      // The notice announces the rejection; focus belongs on the first
      // invalid control, so the notice focus effect yields once.
      skipNoticeFocusRef.current = true;
      setNotice({ kind: 'error', text: 'Check the highlighted fields.' });
      // Focus the first field that needs attention.
      const focus =
        built.errors.account !== undefined
          ? createAccountRef.current
          : amountRef.current;
      requestAnimationFrame(() => focus?.focus());
      return;
    }
    setCreateFieldErrors({});
    const request: PendingCreate = {
      key: crypto.randomUUID(),
      input: built.input,
    };
    setPendingCreate(request);
    void submitCreate(request);
  }

  /** Intl-safe zone for continuations that outlive their render's closure. */
  function effectiveZone(): string {
    return resolveCalculationZone(reportingZoneRef.current).zone;
  }

  function resetCreateForm() {
    // Like the accounts section, a known outcome clears the entry draft
    // but keeps the chosen account, type, and direction for convenience.
    // The date returns to the pristine zone default for the injected clock.
    setCreateAmount('');
    setCreateDate(todayInZone(effectiveZone(), clockNow()));
    createDateTouchedRef.current = false;
    setCreateDescription('');
    setCreateCategory('');
    setCreateFieldErrors({});
    setRefundSource(null);
  }

  function mapCreateFieldErrors(
    apiError: ApiError,
    setters: {
      setFieldErrors: (errors: FieldErrors) => void;
      focusAmount: () => void;
      focusCategory: () => void;
    },
  ): boolean {
    const fieldErrors = apiError.fieldErrors;
    if (!fieldErrors) return false;
    const mapped: FieldErrors = {};
    if (fieldErrors['money.amount']) {
      mapped.amount = fieldErrors['money.amount'];
    }
    if (fieldErrors.occurredOn) {
      mapped.date = fieldErrors.occurredOn;
    }
    if (fieldErrors.description) {
      mapped.description = fieldErrors.description;
    }
    if (fieldErrors.category) {
      mapped.category = fieldErrors.category;
    }
    if (Object.keys(mapped).length > 0) {
      setters.setFieldErrors(mapped);
      // Focus follows the rejected control: a category rejection lands on the
      // category selector instead of sending the user back to the amount.
      if (mapped.category && !mapped.amount) setters.focusCategory();
      else setters.focusAmount();
      return true;
    }
    return false;
  }

  /**
   * Names the durable meaning of a committed category correction, including
   * explicit uncategorized: the server records it as the owner's own USER
   * decision, and no rule, provider mapping, sync, or later model result
   * replaces it.
   */
  function categoryDecisionText(category: string | null): string {
    if (category === null) {
      return 'Category cleared: this entry stays uncategorized because you decided so — automation will not replace your decision.';
    }
    const label =
      categories === null ? null : categoryLabel(category, categories);
    return label === null
      ? 'Category saved as your decision — automation will not replace it.'
      : `Category set to ${label}: this is your decision — automation will not replace it.`;
  }

  async function submitCreate(request: PendingCreate) {
    if (creatingRef.current || !authorityConfirmed) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    track(controller);
    creatingRef.current = true;
    setCreating(true);
    setNotice(null);
    try {
      const token = await ensureCsrf(generation, controller.signal);
      if (!current(generation) || controller.signal.aborted) return;
      if (!token) {
        setNotice({
          kind: 'error',
          text: 'Security setup is still loading. Retry the same request.',
        });
        return;
      }
      const created = await postTransaction(
        household.id,
        request.input,
        request.key,
        token,
        controller.signal,
      );
      if (!current(generation) || controller.signal.aborted) return;
      setPendingCreate(null);
      resetCreateForm();
      setNotice({
        kind: 'info',
        text: `${kindLabel(created.kind)} recorded: ${formatMoney(
          created.money.amount,
          created.money.currency,
        )} on ${created.occurredOn}.`,
      });
      // A posted refund changes the source expense's cumulative refunded
      // magnitude and therefore derived balances.
      if (created.kind === 'REFUND') bumpBalances();
      // A new entry without an explicit category is classified on commit and
      // may open a suggestion, so the private review count converges too.
      setReviewsRefresh((value) => value + 1);
      reloadTransactions(true);
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not reach the server.',
            });
      if (mapCommonErrors(apiError)) return;
      if (apiError.code === 'CSRF_INVALID') {
        const refreshed = await refreshCsrf(generation, controller.signal);
        if (!current(generation) || controller.signal.aborted) return;
        setNotice({
          kind: 'error',
          text: refreshed
            ? 'Your security token was refreshed. Retry the same transaction request.'
            : 'Your secure request expired. Reload before retrying.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      if (
        apiError.timedOut ||
        apiError.code === 'NETWORK_ERROR' ||
        apiError.code === 'FINANCE_BUSY'
      ) {
        // The exact request and key stay retained in the durable block
        // below; this transient notice deliberately carries no actions so
        // a later notice can never strand the retained retry. A committed
        // refund changes derived balances, so both feeds and balances
        // refresh while the same-key retry stays available.
        setNotice({
          kind: 'warning',
          text: 'Transaction creation has an unknown outcome. Retry the same request safely, or refresh the list before retrying.',
          correlationId: apiError.correlationId,
        });
        bumpBalances();
        reloadTransactions(true);
        return;
      }
      if (
        mapCreateFieldErrors(apiError, {
          setFieldErrors: setCreateFieldErrors,
          // Controls are disabled while the request is in flight, so the
          // focus lands on the next frame, after the re-render that clears
          // the pending request.
          focusAmount: () =>
            requestAnimationFrame(() => amountRef.current?.focus()),
          focusCategory: () =>
            requestAnimationFrame(() => {
              if (refundSource) amountRef.current?.focus();
              else createCategoryRef.current?.focus();
            }),
        })
      ) {
        setPendingCreate(null);
        skipNoticeFocusRef.current = true;
        setNotice({
          kind: 'error',
          text: 'Check the highlighted transaction details.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      setPendingCreate(null);
      setNotice({
        kind: 'error',
        text: createFailureText(apiError),
        correlationId: apiError.correlationId,
        showRefresh:
          apiError.code === 'ACCOUNT_ARCHIVED' ||
          apiError.code === 'IDEMPOTENCY_CONFLICT' ||
          apiError.code === 'REFUND_CONFLICT' ||
          apiError.code === 'FINANCIAL_ACCOUNT_NOT_FOUND' ||
          apiError.code === 'TRANSACTION_NOT_FOUND',
      });
    } finally {
      untrack(controller);
      creatingRef.current = false;
      if (!unmountedRef.current) setCreating(false);
    }
  }

  function createFailureText(apiError: ApiError): string {
    switch (apiError.code) {
      case 'ACCOUNT_ARCHIVED':
        return 'That account is archived now. Refresh accounts before recording here.';
      case 'IDEMPOTENCY_CONFLICT':
        return 'This request key was already used with different details. Review the entry and start again.';
      case 'REFUND_CONFLICT':
        return 'The refund no longer matches its expense. Refresh the list and check the expense.';
      case 'FINANCIAL_ACCOUNT_NOT_FOUND':
        return 'The account for this entry is no longer available. Refresh accounts.';
      case 'TRANSACTION_NOT_FOUND':
        return 'The expense this refund refers to is no longer available. Refresh the list.';
      default:
        return (
          apiError.message || 'Transaction creation could not be completed.'
        );
    }
  }

  /**
   * Every opener refuses while a confirmation is pending, a mutation is in
   * flight, a load is running, or authority is unconfirmed. The disabled
   * attributes already gate pointer use; these guards are defense in depth
   * so a racing activation can never open a second panel or unmount a
   * trigger another panel still needs for focus restoration.
   */
  function confirmOrMutationActive(): boolean {
    return (
      pendingVoid !== null ||
      pendingShare !== null ||
      pendingRevoke !== null ||
      updatingRef.current !== null ||
      creatingRef.current ||
      loading ||
      !authorityConfirmed
    );
  }

  function beginEdit(transaction: Transaction) {
    if (confirmOrMutationActive()) return;
    const decoded = decodeMoneyAmount(
      transaction.money.amount,
      transaction.money.currency,
    );
    setEditingId(transaction.id);
    setEditAmount(decoded ? decoded.magnitude : '');
    setEditDirection(decoded && decoded.sign === 'negative' ? 'OUT' : 'IN');
    setEditDate(transaction.occurredOn);
    setEditDescription(transaction.description);
    setEditCategory(transaction.category ?? '');
    setEditFieldErrors({});
    requestAnimationFrame(() => editAmountRef.current?.focus());
  }

  function cancelEdit(transactionId?: string) {
    setEditingId(null);
    setEditAmount('');
    setEditDescription('');
    setEditCategory('');
    setEditFieldErrors({});
    // Cancel is the initiating control's dismissal: restore focus to the
    // re-created Edit trigger. Programmatic closes (success, conflict)
    // pass no id because the outcome notice takes focus instead.
    if (transactionId) {
      requestAnimationFrame(() => {
        if (unmountedRef.current) return;
        document.getElementById(`edit-trigger-${transactionId}`)?.focus();
      });
    }
  }

  async function submitEdit(transaction: Transaction) {
    if (updatingRef.current !== null || !authorityConfirmed) return;
    const generation = generationRef.current;
    const account = accounts?.find(
      (value) => value.id === transaction.accountId,
    );
    const currency = transaction.money.currency;
    const sign =
      transaction.kind === 'TRANSFER'
        ? editDirection === 'OUT'
          ? 'negative'
          : 'positive'
        : transaction.kind === 'EXPENSE'
          ? 'negative'
          : 'positive';
    const errors: FieldErrors = {};
    const encoded = encodeMoneyMagnitude(editAmount, currency, sign);
    if (!encoded.ok) errors.amount = encoded.error;
    const amountString = encoded.ok ? encoded.amount : '';
    const changedMoney = amountString !== transaction.money.amount;
    if (!isSupportedTransactionDate(editDate)) {
      errors.date = `Enter a calendar date between ${MIN_DATE} and ${MAX_DATE}.`;
    } else if (transaction.kind === 'REFUND') {
      const source = ownTransactions?.find(
        (value) => value.id === transaction.refundOfTransactionId,
      );
      if (source && editDate < source.occurredOn) {
        errors.date = `The refund date cannot be before the expense date (${source.occurredOn}).`;
      }
    } else if (transaction.kind === 'EXPENSE' && account) {
      const bound = earliestLiveRefundDate(
        ownTransactions ?? [],
        transaction.id,
      );
      if (bound && editDate > bound) {
        errors.date = `This expense has refunds on ${bound}; its date cannot be later.`;
      }
    }
    const description = validateDescription(editDescription);
    if (description) errors.description = description;
    if (encoded.ok && changedMoney && transaction.kind === 'EXPENSE') {
      // The documented bound: combined posted refunds may equal but never
      // exceed the expense magnitude. The loaded page's posted refunds are
      // known exactly; unpaged history stays a server `REFUND_CONFLICT`.
      const refundTotal = postedRefundMinorUnits(
        ownTransactions ?? [],
        transaction.id,
        currency,
      );
      const correctedMagnitude = encoded.amount.startsWith('-')
        ? encoded.amount.slice(1)
        : encoded.amount;
      if (
        refundTotal !== null &&
        minorUnitsOfMagnitude(correctedMagnitude, currency) < refundTotal
      ) {
        errors.amount = `This expense has posted refunds totalling ${formatMoney(
          magnitudeOfMinorUnits(refundTotal, currency),
          currency,
        )} on this page; the corrected amount cannot be below that total. Refunds beyond this page stay a server check.`;
      }
    }
    if (changedMoney && allocationByTransaction[transaction.id]) {
      // An active allocation freezes the recorded amount: guide the user
      // to revoke first. The backend remains the authority; a stale cache
      // still gets the specific ALLOCATION_CONFLICT guidance below.
      errors.amount =
        'This expense has an active allocation; its amount cannot change while shares are recorded. Revoke the allocation first — other corrections stay allowed.';
    }
    if (Object.keys(errors).length > 0) {
      setEditFieldErrors(errors);
      // The notice announces the rejection; focus belongs on the field that
      // needs attention, so the notice focus effect yields once.
      skipNoticeFocusRef.current = true;
      setNotice({ kind: 'error', text: 'Check the highlighted fields.' });
      requestAnimationFrame(() => editAmountRef.current?.focus());
      return;
    }
    const patch: {
      expectedVersion: number;
      money?: Money;
      occurredOn?: string;
      description?: string;
      category?: string | null;
    } = { expectedVersion: transaction.version };
    // Validations passed, so the encoding is known to be ok.
    const changedDate = editDate !== transaction.occurredOn;
    const changedDescription =
      editDescription.trim() !== transaction.description;
    const changedCategory = editCategory !== (transaction.category ?? '');
    if (
      !changedMoney &&
      !changedDate &&
      !changedDescription &&
      !changedCategory
    ) {
      // An unchanged correction must not send `{expectedVersion}` only:
      // close locally with a status instead of a no-op request.
      cancelEdit(transaction.id);
      setNotice({
        kind: 'info',
        text: 'The correction matches the recorded entry. Nothing to save.',
      });
      return;
    }
    if (changedMoney) {
      patch.money = { amount: amountString, currency };
    }
    if (changedDate) patch.occurredOn = editDate;
    if (changedDescription) patch.description = editDescription.trim();
    if (changedCategory) {
      patch.category = editCategory === '' ? null : editCategory;
    }
    const controller = new AbortController();
    track(controller);
    updatingRef.current = transaction.id;
    setUpdatingId(transaction.id);
    setNotice(null);
    try {
      const token = await ensureCsrf(generation, controller.signal);
      if (!current(generation) || controller.signal.aborted) return;
      if (!token) {
        setNotice({ kind: 'error', text: 'Security setup failed. Retry.' });
        return;
      }
      const updated = await patchTransaction(
        household.id,
        transaction.id,
        patch,
        token,
        controller.signal,
      );
      if (!current(generation) || controller.signal.aborted) return;
      cancelEdit();
      if (detail?.id === updated.id) {
        // An open panel keeps the committed representation, and a category
        // correction refreshes its owner-only provenance so the durable
        // decision is visible without reopening anything. Unrelated drafts
        // (the entry form, the split panel, the review draft) are untouched.
        setDetail(updated);
      }
      const correctedText = `Transaction corrected: ${formatMoney(
        updated.money.amount,
        updated.money.currency,
      )} on ${updated.occurredOn}.`;
      setNotice({
        kind: 'info',
        text: changedCategory
          ? `${correctedText} ${categoryDecisionText(updated.category)}`
          : correctedText,
      });
      // A money correction of a refund or expense changes derived
      // balances; description/date/category changes do not.
      if (changedMoney) bumpBalances();
      // Every committed correction moves the entry's version, and a category
      // or description change can supersede an open suggestion, so the
      // private review queue and its count converge on the committed state.
      setReviewsRefresh((value) => value + 1);
      reloadTransactions(true);
      if (detail?.id === updated.id) {
        void loadProvenance(updated);
      }
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not reach the server.',
            });
      if (mapCommonErrors(apiError)) return;
      if (apiError.code === 'CSRF_INVALID') {
        const refreshed = await refreshCsrf(generation, controller.signal);
        if (!current(generation) || controller.signal.aborted) return;
        setNotice({
          kind: 'error',
          text: refreshed
            ? 'Your security token was refreshed. Review the correction and retry.'
            : 'Your secure request expired. Reload before retrying.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      if (apiError.code === 'TRANSACTION_NOT_FOUND') {
        // The row is stale in this list: drop it locally and offer a
        // refresh, never a claimed success or failure. Detail cleanup is
        // scoped to the affected transaction so an unrelated open panel
        // survives.
        removeFromFeeds(transaction.id);
        cancelEdit();
        if (detail?.id === transaction.id) setDetail(null);
        setNotice({
          kind: 'warning',
          text: 'This transaction is no longer available to you. Refresh to see the current list.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        return;
      }
      if (apiError.code === 'ALLOCATION_CONFLICT') {
        // The server is authoritative: an active allocation blocked this
        // correction (or the local cache was stale). Reload and guide.
        cancelEdit();
        if (detail?.id === transaction.id) setDetail(null);
        setNotice({
          kind: 'error',
          text: 'The server blocked this correction: an active allocation records shares for this expense. Open Allocation, revoke it, then correct the amount.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        reloadTransactions(true);
        return;
      }
      if (
        apiError.code === 'RESOURCE_VERSION_CONFLICT' ||
        apiError.code === 'TRANSACTION_VOIDED' ||
        apiError.code === 'RESOURCE_VERSION_EXHAUSTED' ||
        apiError.timedOut ||
        apiError.code === 'FINANCE_BUSY' ||
        apiError.code === 'NETWORK_ERROR'
      ) {
        // Stale or uncertain: the editor may no longer describe the
        // server's state, so close it and reload before any correction.
        // Detail cleanup stays scoped to the affected transaction.
        cancelEdit();
        if (detail?.id === transaction.id) setDetail(null);
        setNotice({
          kind:
            apiError.timedOut || apiError.code === 'FINANCE_BUSY'
              ? 'warning'
              : 'error',
          text:
            apiError.timedOut ||
            apiError.code === 'FINANCE_BUSY' ||
            apiError.code === 'NETWORK_ERROR'
              ? 'The correction has an unknown outcome. Refresh the list before retrying.'
              : 'This transaction changed on the server. The list was refreshed; review before retrying.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        reloadTransactions(true);
        return;
      }
      if (
        mapCreateFieldErrors(apiError, {
          setFieldErrors: setEditFieldErrors,
          // The editor and the notice re-render after this failure. The
          // notice keeps its announcement role but yields focus, so the
          // rejected control owns focus once the re-render commits.
          focusAmount: () =>
            requestAnimationFrame(() => editAmountRef.current?.focus()),
          focusCategory: () =>
            requestAnimationFrame(() => {
              if (transaction.kind === 'REFUND') {
                editAmountRef.current?.focus();
              } else {
                editCategoryRef.current?.focus();
              }
            }),
        })
      ) {
        skipNoticeFocusRef.current = true;
        setNotice({
          kind: 'error',
          text: 'Check the highlighted transaction details.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      setNotice({
        kind: 'error',
        text:
          apiError.code === 'REFUND_CONFLICT'
            ? "The correction conflicts with this expense's refunds. Refresh the list and check the bound."
            : apiError.message || 'The transaction could not be corrected.',
        correlationId: apiError.correlationId,
      });
    } finally {
      untrack(controller);
      updatingRef.current = null;
      if (!unmountedRef.current) setUpdatingId(null);
    }
  }

  function removeFromFeeds(transactionId: string) {
    setOwnTransactions(
      (currentRows) =>
        currentRows?.filter((value) => value.id !== transactionId) ?? null,
    );
    setHouseholdTransactions(
      (currentRows) =>
        currentRows?.filter((value) => value.id !== transactionId) ?? null,
    );
  }

  function openVoidConfirm(
    transaction: Transaction,
    trigger: HTMLButtonElement,
  ) {
    if (confirmOrMutationActive()) return;
    voidTriggerRef.current = trigger;
    setPendingVoid({ transaction });
  }

  function cancelVoidConfirm() {
    setPendingVoid(null);
    const trigger = voidTriggerRef.current;
    voidTriggerRef.current = null;
    trigger?.focus();
  }

  function handleVoidConfirmKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelVoidConfirm();
    }
  }

  async function confirmVoid() {
    const pending = pendingVoid;
    if (!pending || updatingRef.current !== null) return;
    setPendingVoid(null);
    voidTriggerRef.current = null;
    const { transaction } = pending;
    const generation = generationRef.current;
    const controller = new AbortController();
    track(controller);
    updatingRef.current = transaction.id;
    setUpdatingId(transaction.id);
    setNotice(null);
    try {
      const token = await ensureCsrf(generation, controller.signal);
      if (!current(generation) || controller.signal.aborted) return;
      if (!token) {
        setNotice({ kind: 'error', text: 'Security setup failed. Retry.' });
        return;
      }
      const voided = await patchTransaction(
        household.id,
        transaction.id,
        { expectedVersion: transaction.version, status: 'VOIDED' },
        token,
        controller.signal,
      );
      if (!current(generation) || controller.signal.aborted) return;
      // The outcome notice must own focus after a void, so a matching open
      // detail closes instead of being refreshed (and stealing focus).
      if (detail?.id === voided.id) setDetail(null);
      // Voiding deactivates the expense's allocation atomically and
      // changes derived balances (a voided refund raises the payer
      // credit); reconcile both here. A revoke patch afterwards answers
      // ALLOCATION_NOT_FOUND, so the cache clears without a probe.
      if (voided.kind === 'EXPENSE') setAllocationFor(voided.id, null);
      setNotice({
        kind: 'info',
        text: `Transaction voided. It stays listed as voided and stops counting toward spending.`,
      });
      bumpBalances();
      // A void supersedes an open suggestion for the entry, so the private
      // review count converges on the committed state.
      setReviewsRefresh((value) => value + 1);
      reloadTransactions(true);
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not reach the server.',
            });
      if (mapCommonErrors(apiError)) return;
      if (apiError.code === 'CSRF_INVALID') {
        const refreshed = await refreshCsrf(generation, controller.signal);
        if (!current(generation) || controller.signal.aborted) return;
        setNotice({
          kind: 'error',
          text: refreshed
            ? 'Your security token was refreshed. Review the transaction and retry the void.'
            : 'Your secure request expired. Reload before retrying.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      if (apiError.code === 'TRANSACTION_NOT_FOUND') {
        removeFromFeeds(transaction.id);
        if (detail?.id === transaction.id) setDetail(null);
        setNotice({
          kind: 'warning',
          text: 'This transaction is no longer available to you. Refresh to see the current list.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        return;
      }
      if (
        apiError.code === 'RESOURCE_VERSION_CONFLICT' ||
        apiError.code === 'TRANSACTION_VOIDED' ||
        apiError.code === 'RESOURCE_VERSION_EXHAUSTED'
      ) {
        // Known rejection: the transaction changed on the server, so the
        // refreshed list is authoritative before any retry.
        setNotice({
          kind: 'error',
          text: 'This transaction changed on the server. The list was refreshed; review before retrying.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        reloadTransactions(true);
        return;
      }
      if (
        apiError.timedOut ||
        apiError.code === 'FINANCE_BUSY' ||
        apiError.code === 'NETWORK_ERROR'
      ) {
        // Unknown outcome: the void may or may not have committed, so the
        // wording must not claim a known result. A committed void deactivates
        // the allocation and changes derived balances, so both feeds and
        // balances refresh while the list settles.
        setNotice({
          kind: 'warning',
          text: 'The void has an unknown outcome. Refresh the list before retrying.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        bumpBalances();
        reloadTransactions(true);
        return;
      }
      setNotice({
        kind: 'error',
        text:
          apiError.code === 'REFUND_CONFLICT'
            ? 'Void its refunds before voiding this expense. Refresh the list to see them.'
            : apiError.message || 'The transaction could not be voided.',
        correlationId: apiError.correlationId,
        showRefresh: apiError.code === 'REFUND_CONFLICT',
      });
    } finally {
      untrack(controller);
      updatingRef.current = null;
      if (!unmountedRef.current) setUpdatingId(null);
    }
  }

  function openShareConfirm(
    transaction: Transaction,
    action: PendingShare['action'],
    trigger: HTMLButtonElement,
  ) {
    if (confirmOrMutationActive()) return;
    shareTriggerRef.current = trigger;
    setPendingShare({ transaction, action });
  }

  function cancelShareConfirm() {
    setPendingShare(null);
    const trigger = shareTriggerRef.current;
    shareTriggerRef.current = null;
    trigger?.focus();
  }

  function handleShareConfirmKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelShareConfirm();
    }
  }

  async function confirmShare() {
    const pending = pendingShare;
    if (!pending || updatingRef.current !== null) return;
    setPendingShare(null);
    shareTriggerRef.current = null;
    const { transaction, action } = pending;
    const generation = generationRef.current;
    const controller = new AbortController();
    track(controller);
    updatingRef.current = transaction.id;
    setUpdatingId(transaction.id);
    setNotice(null);
    try {
      const token = await ensureCsrf(generation, controller.signal);
      if (!current(generation) || controller.signal.aborted) return;
      if (!token) {
        setNotice({ kind: 'error', text: 'Security setup failed. Retry.' });
        return;
      }
      const updated = await patchTransaction(
        household.id,
        transaction.id,
        {
          expectedVersion: transaction.version,
          visibility: action === 'SHARE' ? 'HOUSEHOLD' : 'PRIVATE',
        },
        token,
        controller.signal,
      );
      if (!current(generation) || controller.signal.aborted) return;
      // The outcome notice must own focus after a sharing change, so a
      // matching open detail closes instead of being refreshed (and
      // stealing focus).
      if (detail?.id === updated.id) setDetail(null);
      setNotice({
        kind: 'info',
        text:
          action === 'SHARE'
            ? 'Shared with the household. Every member can read its details; account details stay private.'
            : 'This entry is private again. Members lose access on their next refresh; information already read is not retracted.',
      });
      reloadTransactions(true);
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not reach the server.',
            });
      if (mapCommonErrors(apiError)) return;
      if (apiError.code === 'CSRF_INVALID') {
        const refreshed = await refreshCsrf(generation, controller.signal);
        if (!current(generation) || controller.signal.aborted) return;
        setNotice({
          kind: 'error',
          text: refreshed
            ? 'Your security token was refreshed. Review the entry and retry the change.'
            : 'Your secure request expired. Reload before retrying.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      if (apiError.code === 'TRANSACTION_NOT_FOUND') {
        removeFromFeeds(transaction.id);
        if (detail?.id === transaction.id) setDetail(null);
        setNotice({
          kind: 'warning',
          text: 'This transaction is no longer available to you. Refresh to see the current list.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        return;
      }
      if (apiError.code === 'ALLOCATION_CONFLICT') {
        // Visibility alone never creates or removes debt; an active
        // allocation does block this revocation until it is revoked.
        setNotice({
          kind: 'error',
          text: 'The server blocked this change: an active allocation records shares for this expense. Open Allocation, revoke it, then make the entry private.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        reloadTransactions(true);
        return;
      }
      if (
        apiError.code === 'RESOURCE_VERSION_CONFLICT' ||
        apiError.code === 'TRANSACTION_VOIDED' ||
        apiError.code === 'RESOURCE_VERSION_EXHAUSTED' ||
        apiError.timedOut ||
        apiError.code === 'FINANCE_BUSY' ||
        apiError.code === 'NETWORK_ERROR'
      ) {
        // Stale or unknown: the entry changed or the outcome is unknown,
        // so refresh both loaded feeds and let the user decide again.
        setNotice({
          kind:
            apiError.timedOut || apiError.code === 'FINANCE_BUSY'
              ? 'warning'
              : 'error',
          text:
            apiError.timedOut ||
            apiError.code === 'FINANCE_BUSY' ||
            apiError.code === 'NETWORK_ERROR'
              ? 'The sharing change has an unknown outcome. Refresh the list before retrying.'
              : 'This transaction changed on the server. The list was refreshed; review before retrying.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        reloadTransactions(true);
        return;
      }
      setNotice({
        kind: 'error',
        text:
          apiError.code === 'FORBIDDEN'
            ? 'Only the financial owner can change this entry.'
            : apiError.message || 'The sharing change could not be completed.',
        correlationId: apiError.correlationId,
      });
    } finally {
      untrack(controller);
      updatingRef.current = null;
      if (!unmountedRef.current) setUpdatingId(null);
    }
  }

  /**
   * Opening the panel refetches the allocation first: a cached "none" can
   * be stale (the owner may have revoked elsewhere), so the fresh GET
   * decides between the read-only active view and the creation form.
   */
  function openSplit(transaction: Transaction, trigger: HTMLButtonElement) {
    if (confirmOrMutationActive() || splitLoadingRef.current) return;
    if (splitLoadingId !== null) return;
    splitTriggerRef.current = trigger;
    setSplitParticipants([]);
    setSplitFieldErrors({});
    setRoster(null);
    setRosterError(undefined);
    setSplitTransaction(transaction);
  }

  function cancelSplit(restoreTrigger = false) {
    const trigger = restoreTrigger ? splitTriggerRef.current : null;
    splitTriggerRef.current = null;
    setSplitTransaction(null);
    setSplitParticipants([]);
    setSplitFieldErrors({});
    setRoster(null);
    setRosterError(undefined);
    if (restoreTrigger) trigger?.focus();
  }

  function handleSplitKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelSplit(true);
    }
  }

  // The panel fetches the fresh allocation for its transaction; a 404
  // (none active, or the row became invisible) resolves the state so the
  // form can render, while session/access errors reconcile upward.
  async function loadSplitPanel(transaction: Transaction) {
    const generation = generationRef.current;
    const controller = new AbortController();
    track(controller);
    splitLoadingRef.current = true;
    setSplitLoadingId(transaction.id);
    try {
      const allocation = await fetchTransactionAllocation(
        household.id,
        transaction.id,
        controller.signal,
      );
      if (!current(generation) || controller.signal.aborted) return;
      setAllocationFor(transaction.id, allocation);
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError = error instanceof ApiError ? error : null;
      if (
        apiError &&
        (apiError.code === 'ALLOCATION_NOT_FOUND' ||
          apiError.code === 'TRANSACTION_NOT_FOUND')
      ) {
        setAllocationFor(transaction.id, null);
        return;
      }
      if (apiError?.status === 401) {
        handleSessionLost();
        return;
      }
      if (apiError?.code === 'HOUSEHOLD_NOT_FOUND') {
        handleAccessLost();
        return;
      }
      setNotice({
        kind: 'error',
        text:
          apiError?.message ||
          'Could not load the allocation for this transaction.',
        correlationId: apiError?.correlationId,
        showRefresh: true,
      });
    } finally {
      // Untracking belongs here: early returns inside the try/catch skip
      // any statement placed after this block.
      untrack(controller);
      splitLoadingRef.current = false;
      if (!unmountedRef.current) setSplitLoadingId(null);
    }
  }

  useEffect(() => {
    if (!splitTransaction) return;
    void (async () => {
      await loadSplitPanel(splitTransaction);
    })();
    // Roster loading for the creation form runs in its own effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitTransaction]);

  // The creation form needs a roster snapshot for participant selection.
  // Opening or closing the panel clears it, so every resolved creation
  // form refetches; the snapshot is a selection aid only, and the backend
  // remains the authority over actual membership when the allocation is
  // recorded.
  const splitAllocationState = splitTransaction
    ? allocationByTransaction[splitTransaction.id]
    : undefined;
  // A member-visible read-only copy of the active allocation for the open
  // detail panel; only fetched allocation state is ever shown.
  const detailAllocation =
    detail && isAllocationFetchable(detail)
      ? allocationByTransaction[detail.id]
      : undefined;
  async function loadSplitRoster() {
    const generation = generationRef.current;
    const controller = new AbortController();
    track(controller);
    setRosterLoading(true);
    setRosterError(undefined);
    try {
      const members = await fetchHouseholdMembers(
        household.id,
        controller.signal,
      );
      if (!current(generation) || controller.signal.aborted) return;
      setRoster(members);
      // Sensible default: every current member starts selected, payer
      // included (the payer may be omitted explicitly).
      setSplitParticipants(
        sortCanonicalUserIds(members.map((member) => member.userId)),
      );
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError = error instanceof ApiError ? error : null;
      if (apiError?.status === 401) {
        handleSessionLost();
        return;
      }
      if (apiError?.code === 'HOUSEHOLD_NOT_FOUND') {
        handleAccessLost();
        return;
      }
      setRosterError(
        apiError?.timedOut
          ? 'Loading members timed out. Close and reopen the allocation to retry.'
          : apiError?.message ||
              'Could not load the current members for participant selection.',
      );
    } finally {
      untrack(controller);
      if (!unmountedRef.current) setRosterLoading(false);
    }
  }

  useEffect(() => {
    if (!splitTransaction || splitAllocationState !== null) return;
    void (async () => {
      await loadSplitRoster();
    })();
    // Only the panel's resolved allocation state drives this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitTransaction, splitAllocationState]);

  function toggleSplitParticipant(userId: string, checked: boolean) {
    setSplitFieldErrors({});
    setSplitParticipants((current) =>
      checked
        ? [...new Set([...current, userId])]
        : current.filter((value) => value !== userId),
    );
  }

  function allocationCreatedText(allocation: TransactionAllocation): string {
    const shares = allocation.participants
      .map((participant) =>
        formatMoney(participant.share.amount, allocation.currency),
      )
      .join(', ');
    return `Allocation recorded in participant order: ${shares}. The expense version is now ${allocation.transactionVersion}.`;
  }

  function handleAllocationSubmit() {
    const transaction = splitTransaction;
    if (!transaction) return;
    if (
      allocationCreating ||
      pendingAllocation !== null ||
      updatingRef.current !== null ||
      !authorityConfirmed
    ) {
      return;
    }
    if (!isAllocationFetchable(transaction)) {
      // The panel is stale: the row changed on the server.
      cancelSplit();
      setNotice({
        kind: 'warning',
        text: 'This entry changed on the server. Refresh the list before allocating.',
        showRefresh: true,
      });
      return;
    }
    const selected = sortCanonicalUserIds(splitParticipants);
    if (selected.length === 0) {
      setSplitFieldErrors({
        participants: 'Select at least one participant.',
      });
      setNotice({ kind: 'error', text: 'Check the highlighted fields.' });
      return;
    }
    // Invalid local state (malformed or duplicated participant IDs) is
    // rejected instead of previewed or submitted.
    const preview = previewEqualShares(
      expenseMagnitudeOf(transaction),
      transaction.money.currency,
      selected,
    );
    if (!preview) {
      setSplitFieldErrors({
        participants: 'Choose distinct, valid participants.',
      });
      setNotice({ kind: 'error', text: 'Check the highlighted fields.' });
      return;
    }
    const request: PendingAllocationCreate = {
      key: crypto.randomUUID(),
      transactionId: transaction.id,
      input: {
        expectedVersion: transaction.version,
        participantUserIds: selected,
      },
    };
    setPendingAllocation(request);
    void submitAllocationCreate(request);
  }

  async function submitAllocationCreate(request: PendingAllocationCreate) {
    if (updatingRef.current !== null || !authorityConfirmed) return;
    const transactionId = request.transactionId;
    const generation = generationRef.current;
    const controller = new AbortController();
    track(controller);
    updatingRef.current = transactionId;
    setUpdatingId(transactionId);
    setAllocationCreating(true);
    setNotice(null);
    try {
      const token = await ensureCsrf(generation, controller.signal);
      if (!current(generation) || controller.signal.aborted) return;
      if (!token) {
        setNotice({
          kind: 'error',
          text: 'Security setup is still loading. Retry the same request.',
        });
        return;
      }
      const allocation = await postTransactionAllocation(
        household.id,
        transactionId,
        request.input,
        request.key,
        token,
        controller.signal,
      );
      if (!current(generation) || controller.signal.aborted) return;
      if (allocation.status === 'REVOKED') {
        // A same-key replay can expose a since-revoked creation: the
        // outcome is known and no active allocation exists now.
        setPendingAllocation(null);
        setAllocationFor(transactionId, null);
        cancelSplit();
        setNotice({
          kind: 'info',
          text: 'This allocation request had already been recorded and its allocation is now revoked. Recreating needs a fresh request.',
        });
      } else {
        setPendingAllocation(null);
        setAllocationFor(transactionId, allocation);
        setNotice({
          kind: 'info',
          text: allocationCreatedText(allocation),
        });
      }
      bumpBalances();
      reloadTransactions(true);
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not reach the server.',
            });
      if (mapCommonErrors(apiError)) return;
      if (apiError.code === 'CSRF_INVALID') {
        const refreshed = await refreshCsrf(generation, controller.signal);
        if (!current(generation) || controller.signal.aborted) return;
        setNotice({
          kind: 'error',
          text: refreshed
            ? 'Your security token was refreshed. Retry the same allocation request.'
            : 'Your secure request expired. Reload before retrying.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      if (
        apiError.timedOut ||
        apiError.code === 'NETWORK_ERROR' ||
        apiError.code === 'FINANCE_BUSY'
      ) {
        // Unknown outcome: the retained durable block keeps the exact key
        // and payload available for an explicit same-key retry. A
        // committed allocation changes derived balances, so both feeds and
        // balances refresh while the same-key retry stays available.
        setNotice({
          kind: 'warning',
          text: 'The allocation request has an unknown outcome. Retry the same request safely, or refresh the list first.',
          correlationId: apiError.correlationId,
        });
        bumpBalances();
        reloadTransactions(true);
        return;
      }
      if (apiError.code === 'ALLOCATION_CONFLICT') {
        // Known rejection: the expense's allocation state moved or the
        // entry is not eligible. The stale cache entry goes back to
        // unknown so the reload's probe reconciles; refresh before any
        // retry.
        clearAllocationFor(transactionId);
        setPendingAllocation(null);
        cancelSplit();
        setNotice({
          kind: 'error',
          text: 'This expense cannot be allocated right now. The list was refreshed; review the entry before retrying.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        reloadTransactions(true);
        return;
      }
      if (
        apiError.code === 'RESOURCE_VERSION_CONFLICT' ||
        apiError.code === 'RESOURCE_VERSION_EXHAUSTED'
      ) {
        // Stale expense version: reload before offering a correction.
        setPendingAllocation(null);
        cancelSplit();
        setNotice({
          kind: 'error',
          text: 'This expense changed on the server. The list was refreshed; review before retrying.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        reloadTransactions(true);
        return;
      }
      if (apiError.code === 'TRANSACTION_NOT_FOUND') {
        setPendingAllocation(null);
        removeFromFeeds(transactionId);
        cancelSplit();
        setNotice({
          kind: 'warning',
          text: 'This transaction is no longer available to you. Refresh to see the current list.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        return;
      }
      if (apiError.code === 'IDEMPOTENCY_CONFLICT') {
        setPendingAllocation(null);
        cancelSplit();
        setNotice({
          kind: 'error',
          text: 'This request key was already used with different details. Review the entry and start again.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        return;
      }
      if (apiError.fieldErrors?.participantUserIds) {
        setPendingAllocation(null);
        setSplitFieldErrors({
          participants: apiError.fieldErrors.participantUserIds,
        });
        setNotice({
          kind: 'error',
          text: 'Check the highlighted participants.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      setPendingAllocation(null);
      setNotice({
        kind: 'error',
        text:
          apiError.code === 'FORBIDDEN'
            ? 'Only the financial owner can allocate this expense.'
            : apiError.message || 'Allocation creation could not be completed.',
        correlationId: apiError.correlationId,
      });
    } finally {
      untrack(controller);
      updatingRef.current = null;
      if (!unmountedRef.current) {
        setUpdatingId(null);
        setAllocationCreating(false);
      }
    }
  }

  function openRevokeConfirm(
    transaction: Transaction,
    allocation: TransactionAllocation,
    trigger: HTMLButtonElement,
  ) {
    if (confirmOrMutationActive()) return;
    revokeTriggerRef.current = trigger;
    setPendingRevoke({ transaction, allocation });
  }

  function cancelRevokeConfirm() {
    setPendingRevoke(null);
    const trigger = revokeTriggerRef.current;
    revokeTriggerRef.current = null;
    trigger?.focus();
  }

  function handleRevokeConfirmKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelRevokeConfirm();
    }
  }

  async function confirmAllocationRevoke() {
    const pending = pendingRevoke;
    if (!pending || updatingRef.current !== null) return;
    setPendingRevoke(null);
    revokeTriggerRef.current = null;
    const { transaction } = pending;
    const generation = generationRef.current;
    const controller = new AbortController();
    track(controller);
    updatingRef.current = transaction.id;
    setUpdatingId(transaction.id);
    setNotice(null);
    try {
      const token = await ensureCsrf(generation, controller.signal);
      if (!current(generation) || controller.signal.aborted) return;
      if (!token) {
        setNotice({ kind: 'error', text: 'Security setup failed. Retry.' });
        return;
      }
      await patchAllocationRevoke(
        household.id,
        transaction.id,
        transaction.version,
        token,
        controller.signal,
      );
      if (!current(generation) || controller.signal.aborted) return;
      // A revoked allocation is never returned again: the entry clears so
      // the panel can offer a fresh-key recreation.
      setAllocationFor(transaction.id, null);
      setNotice({
        kind: 'info',
        text: 'Allocation revoked. Member balances no longer include this expense; the recorded shares stay retained on the server. A new allocation needs a fresh request.',
      });
      bumpBalances();
      reloadTransactions(true);
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not reach the server.',
            });
      if (mapCommonErrors(apiError)) return;
      if (apiError.code === 'CSRF_INVALID') {
        const refreshed = await refreshCsrf(generation, controller.signal);
        if (!current(generation) || controller.signal.aborted) return;
        setNotice({
          kind: 'error',
          text: refreshed
            ? 'Your security token was refreshed. Review the entry and retry the revoke.'
            : 'Your secure request expired. Reload before retrying.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      if (apiError.code === 'TRANSACTION_NOT_FOUND') {
        removeFromFeeds(transaction.id);
        clearAllocationFor(transaction.id);
        cancelSplit();
        setNotice({
          kind: 'warning',
          text: 'This transaction is no longer available to you. Refresh to see the current list.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        return;
      }
      if (apiError.code === 'ALLOCATION_NOT_FOUND') {
        // Already gone (revoked or voided elsewhere): reconcile locally.
        setAllocationFor(transaction.id, null);
        cancelSplit();
        setNotice({
          kind: 'warning',
          text: 'This allocation is no longer active. The list was refreshed; review the entry.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        reloadTransactions(true);
        return;
      }
      if (
        apiError.code === 'RESOURCE_VERSION_CONFLICT' ||
        apiError.code === 'RESOURCE_VERSION_EXHAUSTED'
      ) {
        // Stale: the revoke never became certain, so the cache entry goes
        // back to unknown for the reload's probe to reconcile.
        clearAllocationFor(transaction.id);
        cancelSplit();
        setNotice({
          kind: 'error',
          text: 'This expense changed on the server. The list was refreshed; review before retrying.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        reloadTransactions(true);
        return;
      }
      if (
        apiError.timedOut ||
        apiError.code === 'FINANCE_BUSY' ||
        apiError.code === 'NETWORK_ERROR'
      ) {
        // Unknown outcome: the revoke may or may not have committed.
        // PATCH carries no idempotency key, so the refreshed list is the
        // only safe basis for another attempt. The cache entry goes back
        // to unknown so the reload's probe reconciles the real state, and
        // balances refresh in case a revoke committed.
        clearAllocationFor(transaction.id);
        cancelSplit();
        setNotice({
          kind: 'warning',
          text: 'The revoke has an unknown outcome. Refresh the list before retrying.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        bumpBalances();
        reloadTransactions(true);
        return;
      }
      setNotice({
        kind: 'error',
        text:
          apiError.code === 'FORBIDDEN'
            ? 'Only the financial owner can revoke this allocation.'
            : apiError.message ||
              'Allocation revocation could not be completed.',
        correlationId: apiError.correlationId,
      });
    } finally {
      untrack(controller);
      updatingRef.current = null;
      if (!unmountedRef.current) setUpdatingId(null);
    }
  }

  // Keep the panel honest against feed reality: when its transaction is
  // gone, voided, made private, or simply moved (a new version), close or
  // adopt the fresh row so no stale version or stale form is offered.
  async function reconcileSplitPanel() {
    const transaction = splitTransaction;
    if (!transaction) return;
    const fresh = findTransactionById(transaction.id);
    if (
      !fresh ||
      fresh.kind !== 'EXPENSE' ||
      fresh.status !== 'POSTED' ||
      fresh.visibility !== 'HOUSEHOLD'
    ) {
      cancelSplit();
      return;
    }
    if (fresh.version !== transaction.version) {
      setSplitTransaction(fresh);
    }
  }

  useEffect(() => {
    if (!splitTransaction) return;
    void (async () => {
      await reconcileSplitPanel();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownTransactions, householdTransactions]);

  useEffect(() => {
    if (splitTransaction) splitPanelRef.current?.focus();
  }, [splitTransaction]);

  useEffect(() => {
    if (pendingRevoke) revokeConfirmRef.current?.focus();
  }, [pendingRevoke]);

  /**
   * Loads the owner-only provenance of exactly one opened entry. Only
   * the financial owner's own transaction is a candidate, so another member's
   * shared row is never probed with a request that could disclose the
   * existence of private classification state. A superseded request is
   * aborted, and every continuation rechecks its generation and sequence, so
   * closing the panel, switching household, signing out, or losing access
   * never publishes stale private evidence.
   */
  async function loadProvenance(transaction: Transaction) {
    resetProvenance();
    if (transaction.ownerUserId !== currentUserId) return;
    const generation = generationRef.current;
    const sequence = provenanceSeqRef.current;
    const controller = new AbortController();
    provenanceControllerRef.current = controller;
    track(controller);
    setDetailProvenance({ status: 'loading' });
    try {
      const state = await fetchTransactionCategorization(
        household.id,
        transaction.id,
        controller.signal,
      );
      if (
        !current(generation) ||
        controller.signal.aborted ||
        provenanceSeqRef.current !== sequence
      ) {
        return;
      }
      setDetailProvenance({ status: 'ready', state });
    } catch (error) {
      if (
        !current(generation) ||
        controller.signal.aborted ||
        provenanceSeqRef.current !== sequence
      ) {
        return;
      }
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not reach the server.',
            });
      if (apiError.status === 401) {
        handleSessionLost();
        return;
      }
      if (apiError.code === 'HOUSEHOLD_NOT_FOUND') {
        handleAccessLost();
        return;
      }
      // Calm and recoverable: the panel keeps the effective category and
      // offers an explicit retry instead of an error notice for a
      // resource this viewer may simply not have.
      setDetailProvenance({ status: 'unavailable' });
    } finally {
      untrack(controller);
      if (provenanceControllerRef.current === controller) {
        provenanceControllerRef.current = null;
      }
    }
  }

  /**
   * Starts the explicit "Use for future matches" intent for the decision the
   * open panel is showing. The server alone decides eligibility: the action
   * only exists while the owner-only resource reports `ruleEligible`, so no
   * match key is ever derived, submitted, or rendered here. The transaction's
   * current version and a fresh durable key are captured together, and the
   * category that was already saved stays committed whatever happens next.
   */
  function createRuleFrom(
    transaction: Transaction,
    state: CategorizationState,
  ) {
    if (ruleCreatingRef.current || !authorityConfirmed) return;
    const request: PendingRuleCreate = {
      key: crypto.randomUUID(),
      transactionId: transaction.id,
      description: transaction.description,
      expectedTransactionVersion: state.transactionVersion,
    };
    setPendingRuleCreate(request);
    void submitRuleCreate(request);
  }

  /**
   * Sends exactly one learn intent. A same-key replay returns the already
   * created rule, so an explicit retry after a timed-out, busy, or
   * unreachable attempt is safe and can never create a second rule. Every
   * failure keeps the saved category: learning is a separate, additive step.
   */
  async function submitRuleCreate(request: PendingRuleCreate) {
    if (ruleCreatingRef.current || !authorityConfirmed) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    track(controller);
    ruleCreatingRef.current = true;
    setRuleCreating(true);
    setNotice(null);
    try {
      const token = await ensureCsrf(generation, controller.signal);
      if (!current(generation) || controller.signal.aborted) return;
      if (!token) {
        setNotice({ kind: 'error', text: 'Security setup failed. Retry.' });
        return;
      }
      const rule = await postTransactionCategorizationRule(
        household.id,
        request.transactionId,
        { expectedTransactionVersion: request.expectedTransactionVersion },
        request.key,
        token,
        controller.signal,
      );
      if (!current(generation) || controller.signal.aborted) return;
      setPendingRuleCreate(null);
      // The private rule list converges on the committed rule, including a
      // same-key replay that created it earlier.
      setRulesRefresh((value) => value + 1);
      setNotice({
        kind: 'info',
        text: `Future matches for “${rule.matchLabel}” now use ${categoryLabel(
          rule.category,
          categories,
        )}. Entries already recorded keep the category they have.`,
      });
      // The capability is spent for this entry: the reloaded decision shows
      // the owner rule instead of offering the same action again. An
      // unrelated open panel and every other draft stay untouched.
      if (detail?.id === request.transactionId) void loadProvenance(detail);
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not reach the server.',
            });
      if (mapCommonErrors(apiError)) return;
      if (apiError.code === 'CSRF_INVALID') {
        const refreshed = await refreshCsrf(generation, controller.signal);
        if (!current(generation) || controller.signal.aborted) return;
        setNotice({
          kind: 'error',
          text: refreshed
            ? 'Your security token was refreshed. Retry the same request with its original key.'
            : 'Your secure request expired. Reload before retrying.',
          correlationId: apiError.correlationId,
        });
        // The request never reached the rule, so the retained intent stays
        // available for the same-key retry.
        return;
      }
      if (apiError.code === 'CATEGORY_RULE_CONFLICT') {
        // Another active rule already covers this key. Nothing about that
        // rule is disclosed here beyond its existence; the private list below
        // is where the owner manages it.
        setPendingRuleCreate(null);
        setRulesRefresh((value) => value + 1);
        setNotice({
          kind: 'warning',
          text: 'You already have an active rule for this merchant. It keeps assigning the category; manage it under “Your future-match rules”.',
          correlationId: apiError.correlationId,
        });
        if (detail?.id === request.transactionId) void loadProvenance(detail);
        return;
      }
      if (apiError.code === 'TRANSACTION_NOT_FOUND') {
        removeFromFeeds(request.transactionId);
        setPendingRuleCreate(null);
        if (detail?.id === request.transactionId) setDetail(null);
        setNotice({
          kind: 'warning',
          text: 'This transaction is no longer available to you. Refresh to see the current list.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        return;
      }
      if (
        apiError.code === 'RESOURCE_VERSION_CONFLICT' ||
        apiError.code === 'TRANSACTION_VOIDED' ||
        apiError.code === 'RESOURCE_VERSION_EXHAUSTED' ||
        apiError.code === 'VALIDATION_FAILED' ||
        apiError.code === 'IDEMPOTENCY_CONFLICT'
      ) {
        // A definite rejection: the entry changed, was voided, or can no
        // longer supply a safe key. The saved category is untouched and the
        // decision is reloaded so the offer reflects the current state.
        setPendingRuleCreate(null);
        if (detail?.id === request.transactionId) setDetail(null);
        setNotice({
          kind: 'error',
          text:
            apiError.code === 'VALIDATION_FAILED'
              ? 'This decision cannot become a rule right now. The category you saved is unchanged; review the current decision and try again.'
              : 'This entry changed on the server. The list was refreshed; review the current decision before teaching it.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        reloadTransactions(true);
        return;
      }
      // Anything else — a timeout, a busy ledger, an unreachable server, or
      // an unexpected server failure — leaves the outcome unknown, so the
      // exact same request stays retained for a same-key retry.
      setNotice({
        kind:
          apiError.timedOut ||
          apiError.code === 'FINANCE_BUSY' ||
          apiError.code === 'NETWORK_ERROR'
            ? 'warning'
            : 'error',
        text:
          apiError.timedOut ||
          apiError.code === 'FINANCE_BUSY' ||
          apiError.code === 'NETWORK_ERROR'
            ? 'The rule request has an unknown outcome. Retry the same request with its original key, or refresh first — the category you saved is unchanged.'
            : apiError.message ||
              'The future-match rule could not be created. The category you saved is unchanged.',
        correlationId: apiError.correlationId,
      });
    } finally {
      untrack(controller);
      ruleCreatingRef.current = false;
      if (!unmountedRef.current) setRuleCreating(false);
    }
  }

  async function openDetail(transaction: Transaction | string) {
    // The ref guards same-flush double activations; the aligned opener
    // guard refuses confirmations, mutations, loads, and unconfirmed
    // authority for defense in depth.
    if (confirmOrMutationActive() || detailLoadingRef.current) return;
    if (detailLoadingId !== null) return;
    const transactionId =
      typeof transaction === 'string' ? transaction : transaction.id;
    const generation = generationRef.current;
    const controller = new AbortController();
    track(controller);
    detailLoadingRef.current = true;
    setDetailLoadingId(transactionId);
    setNotice(null);
    try {
      const fresh = await fetchTransaction(
        household.id,
        transactionId,
        controller.signal,
      );
      // Guards block every late continuation after unmount, a household
      // replacement, or any newer generation taking over this section.
      if (!current(generation) || controller.signal.aborted) return;
      setDetail(fresh);
      // Owner-only, and only for the entry whose details are open: shared
      // entries and feed rows are never probed.
      void loadProvenance(fresh);
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not reach the server.',
            });
      if (apiError.code === 'TRANSACTION_NOT_FOUND') {
        // A stale shared detail 404 must clear the affected detail view and
        // the row; the feed refresh shows the reconciled state. The cleanup
        // is scoped so an unrelated open panel survives.
        removeFromFeeds(transactionId);
        if (detail?.id === transactionId) setDetail(null);
        setNotice({
          kind: 'warning',
          text: 'This transaction is no longer available to you. Refresh to see the current list.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
      } else if (apiError.status === 401) {
        handleSessionLost();
      } else if (apiError.code === 'HOUSEHOLD_NOT_FOUND') {
        handleAccessLost();
      } else {
        setNotice({
          kind: 'error',
          text: apiError.message || 'Could not load this transaction.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
      }
    } finally {
      untrack(controller);
      detailLoadingRef.current = false;
      if (!unmountedRef.current) setDetailLoadingId(null);
    }
  }

  function closeDetail() {
    const closing = detail;
    setDetail(null);
    // The row may be outside the loaded page (refund-source navigation);
    // return focus to the feed control when its Details trigger is absent.
    if (closing) {
      requestAnimationFrame(() => {
        if (unmountedRef.current) return;
        const trigger = document.getElementById(
          `details-trigger-${closing.id}`,
        );
        if (trigger) trigger.focus();
        else
          document
            .querySelector<HTMLInputElement>(
              `input[name="transactions-feed-${household.id}"]:checked`,
            )
            ?.focus();
      });
    }
  }

  function startRefund(expense: Transaction) {
    if (confirmOrMutationActive()) return;
    if (expense.accountId === null) return;
    setRefundSource(expense);
    setCreateAccountId(expense.accountId);
    setCreateKind('EXPENSE');
    setCreateAmount('');
    setCreateDate(todayInZone(effectiveZone(), clockNow()));
    createDateTouchedRef.current = false;
    setCreateDescription('');
    setCreateCategory('');
    setCreateFieldErrors({});
    requestAnimationFrame(() => amountRef.current?.focus());
  }

  function cancelRefund() {
    setRefundSource(null);
    setCreateKind('EXPENSE');
    setCreateFieldErrors({});
  }

  const activeAccounts = (accounts ?? []).filter(
    // Manual entry stays MANUAL-only: CONNECTED accounts receive entries
    // exclusively through bank-activity confirmation, so they are never
    // offered by the manual create form.
    (account) => account.status === 'ACTIVE' && account.source === 'MANUAL',
  );
  const accountNameById = new Map<string, string>();
  for (const account of accounts ?? []) {
    accountNameById.set(account.id, account.name);
  }
  const selectedAccount = accounts?.find(
    (account) =>
      account.id === (refundSource ? refundSource.accountId : createAccountId),
  );
  const selectedCurrency = selectedAccount?.currency;
  const createMinDate = refundSource ? refundSource.occurredOn : MIN_DATE;
  const createFutureWarning = isFutureDateInZone(createDate, calculationZone);

  const transactions = activeTransactions();
  const hasMore = activeHasMore();
  const isOwnView = activeView === 'OWN';

  const mutating =
    creating ||
    updatingId !== null ||
    detailLoadingId !== null ||
    splitLoadingId !== null;
  const busy = loading || mutating;
  /**
   * The feed and visibility radios keep their place while their own scoped
   * load runs. A focused control that becomes disabled loses focus to the
   * document body in real browsers, which strands a keyboard user mid-switch;
   * the list already reports that load with its own status text. Every switch
   * handler keeps its refusal guards, so an enabled control cannot start
   * overlapping work: a second scope change while a load or mutation is active
   * is ignored rather than raced.
   */
  const feedControlsDisabled =
    mutating ||
    pendingCreate !== null ||
    pendingVoid !== null ||
    pendingShare !== null ||
    pendingRevoke !== null ||
    !authorityConfirmed;
  /**
   * Both pager controls stay focusable during a page request. A failed page
   * changes the early pager into a retry at the same keyboard position; a
   * second activation while loading cannot start a duplicate request.
   */
  const pagerBlocked =
    busy ||
    loadingMore ||
    !authorityConfirmed ||
    pendingVoid !== null ||
    pendingShare !== null ||
    pendingRevoke !== null;

  const linkedRefunds = (expenseId: string): Transaction[] =>
    (ownTransactions ?? []).filter(
      (value) =>
        value.refundOfTransactionId === expenseId && value.accountId !== null,
    );

  const refundRelationshipText = (transaction: Transaction): string => {
    if (transaction.kind === 'REFUND') {
      return `Refund of expense ${transaction.refundOfTransactionId}.`;
    }
    const linked = linkedRefunds(transaction.id);
    if (linked.length === 0) return 'None — not a refund group.';
    return `The whole refund group changes together: ${linked.length} linked ${
      linked.length === 1 ? 'refund' : 'refunds'
    } on this page, including voided ones, change with this entry.`;
  };

  return (
    <section
      className="finance-transactions"
      aria-labelledby={`finance-transactions-${household.id}`}
    >
      <div className="finance-accounts-heading">
        <div>
          <p className="eyebrow">Manual entry</p>
          <h4 id={`finance-transactions-${household.id}`}>Transactions</h4>
        </div>
        <span className="privacy-chip">Entries private by default</span>
      </div>
      <p className="finance-helper">
        Every entry starts private to you. Sharing is explicit: an entry you
        mark household-visible appears in the household feed with its exact
        details, never with your account details. Voided entries stay listed and
        are never counted.
      </p>

      <fieldset className="finance-feed-toggle">
        <legend>Feed</legend>
        <label className="finance-feed-option">
          <input
            type="radio"
            ref={activeView === 'OWN' ? feedControlRef : undefined}
            name={`transactions-feed-${household.id}`}
            value="OWN"
            checked={activeView === 'OWN'}
            onChange={() => switchView('OWN')}
            disabled={feedControlsDisabled}
          />
          <span>My transactions</span>
        </label>
        <label className="finance-feed-option">
          <input
            type="radio"
            ref={activeView === 'HOUSEHOLD' ? feedControlRef : undefined}
            name={`transactions-feed-${household.id}`}
            value="HOUSEHOLD"
            checked={activeView === 'HOUSEHOLD'}
            onChange={() => switchView('HOUSEHOLD')}
            disabled={feedControlsDisabled}
          />
          <span>Household feed</span>
        </label>
      </fieldset>
      {activeView === 'OWN' && (
        <fieldset className="finance-feed-toggle">
          <legend>My transactions visibility</legend>
          {(
            [
              [null, 'All'],
              ['PRIVATE', 'Private'],
              ['HOUSEHOLD', 'Shared by me'],
            ] as const
          ).map(([visibility, label]) => (
            <label className="finance-feed-option" key={label}>
              <input
                type="radio"
                name={`transactions-visibility-${household.id}`}
                checked={ownVisibility === visibility}
                onChange={() => switchVisibility(visibility)}
                disabled={feedControlsDisabled}
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
      )}

      {!authorityConfirmed && (
        <p role="status" className="household-stale">
          Refresh the household before changing transactions.
        </p>
      )}

      {hasMore && activeNextOffset() <= 10000 && (
        // A full page of rows contributes hundreds of focusable controls, so
        // the pager below the list sits far outside a keyboard or screen
        // reader user's reach. This pager is the short path to the next page
        // and exists only while another page can actually be loaded, exactly
        // like the control below the list.
        <nav
          className="finance-feed-pager"
          aria-label={
            isOwnView
              ? 'Your transactions paging'
              : 'Household transactions paging'
          }
        >
          <button
            ref={topPagerRef}
            type="button"
            className="household-button household-button--secondary"
            aria-disabled={pagerBlocked || undefined}
            onClick={() => {
              if (pagerBlocked) return;
              void loadMore();
            }}
          >
            {loadingMore
              ? 'Loading more…'
              : pageError
                ? 'Retry next page'
                : 'Load more transactions'}
            <span className="finance-sr-only"> (top of list)</span>
          </button>
        </nav>
      )}

      {loading && activeTransactions() === null && (
        <p role="status" aria-live="polite">
          Loading transactions…
        </p>
      )}

      {notice && (
        <div
          ref={noticeRef}
          tabIndex={-1}
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={`household-notice household-notice--${notice.kind}`}
        >
          <p>{notice.text}</p>
          {notice.correlationId && (
            <p className="household-notice-detail">
              Reference: {notice.correlationId}
            </p>
          )}
          {notice.showRefresh && (
            <button
              type="button"
              className="household-button household-button--secondary"
              disabled={busy}
              onClick={refresh}
            >
              Refresh transactions
            </button>
          )}
        </div>
      )}

      {transactions !== null && pendingCreate !== null && (
        // Durable same-key retry affordance: it lives outside the transient
        // notice so a refresh or any later notice can never strand the
        // retained request. A refresh deliberately does not clear it — the
        // list cannot prove which unknown request committed, because
        // duplicate descriptions are valid — so the exact request stays
        // reconcilable until a same-key retry returns a known outcome.
        <div className="finance-pending-request">
          <p>
            An earlier transaction still has an unknown result. Retry the exact
            same request with its original key, or refresh the list first.
            Refreshing keeps this request available; it cannot prove which
            request was recorded.
          </p>
          <div className="finance-account-actions">
            <button
              type="button"
              className="household-button"
              disabled={busy || !authorityConfirmed}
              onClick={() => void submitCreate(pendingCreate)}
            >
              Retry same request
            </button>
            <button
              type="button"
              className="household-button household-button--secondary"
              disabled={busy}
              onClick={refresh}
            >
              Refresh transactions
            </button>
          </div>
        </div>
      )}

      {transactions !== null && pendingRuleCreate !== null && (
        // The same durable same-key retry affordance as a transaction create:
        // it lives outside the transient notice so no later notice or refresh
        // can strand the retained request. The saved category is already
        // committed either way; only the additive rule is uncertain.
        <div className="finance-pending-request">
          <p>
            A “Use for future matches” request for “
            {pendingRuleCreate.description}” still has an unknown result. Retry
            the exact same request with its original key, or reload your rules
            first. Reloading keeps this request available; only a same-key retry
            can prove whether the rule was created.
          </p>
          <div className="finance-account-actions">
            <button
              type="button"
              className="household-button"
              disabled={busy || !authorityConfirmed}
              onClick={() => void submitRuleCreate(pendingRuleCreate)}
            >
              Retry same request
            </button>
            <button
              type="button"
              className="household-button household-button--secondary"
              disabled={busy}
              onClick={() => setRulesRefresh((value) => value + 1)}
            >
              Reload rules
            </button>
          </div>
        </div>
      )}

      {transactions !== null && transactions.length === 0 && !loading && (
        <p className="finance-empty">
          {isOwnView ? 'No transactions yet.' : 'No shared transactions yet.'}
        </p>
      )}

      {transactions !== null && transactions.length > 0 && (
        <ul
          className="finance-transaction-list"
          aria-label={
            isOwnView ? 'Your transactions' : 'Household transactions'
          }
        >
          {transactions.map((transaction) => {
            const isOwn = transaction.ownerUserId === currentUserId;
            const voided = transaction.status === 'VOIDED';
            const refundLabel = transaction.refundOfTransactionId
              ? `Refund of an expense recorded on ${
                  findTransactionById(transaction.refundOfTransactionId)
                    ?.occurredOn ?? 'an earlier date'
                }`
              : null;
            return (
              <li
                key={transaction.id}
                className={`finance-transaction-card${
                  voided ? ' finance-transaction-card--voided' : ''
                }`}
              >
                <div className="finance-transaction-summary">
                  <div>
                    <p className="finance-transaction-name">
                      {transaction.description}
                    </p>
                    <p className="household-meta">
                      {kindLabel(transaction.kind)} ·{' '}
                      <time dateTime={transaction.occurredOn}>
                        {transaction.occurredOn}
                      </time>{' '}
                      ·{' '}
                      {isOwn
                        ? (accountNameById.get(transaction.accountId ?? '') ??
                          'Your account')
                        : 'Shared by another member'}{' '}
                      · {voided ? 'Voided' : 'Posted'}
                    </p>
                    {refundLabel && (
                      <p className="household-meta">{refundLabel}</p>
                    )}
                  </div>
                  <span className="finance-amount">
                    {formatMoney(
                      transaction.money.amount,
                      transaction.money.currency,
                    )}
                  </span>
                </div>
                <div className="finance-transaction-meta">
                  <span className="privacy-chip">
                    {transaction.visibility === 'HOUSEHOLD'
                      ? 'Household'
                      : 'Private'}
                  </span>
                  {transaction.kind === 'REFUND' && (
                    <span className="finance-note-chip">
                      Follows the source expense
                    </span>
                  )}
                  {isAllocationFetchable(transaction) &&
                    Boolean(allocationByTransaction[transaction.id]) && (
                      <span className="finance-note-chip">Allocated</span>
                    )}
                  {transaction.category !== null && (
                    <span className="finance-category-chip">
                      {categoryLabel(transaction.category, categories)}
                    </span>
                  )}
                  {voided && (
                    <span className="finance-voided-chip">Voided</span>
                  )}
                </div>

                {editingId === transaction.id ? (
                  <EditForm
                    transaction={transaction}
                    currency={transaction.money.currency}
                    editAmount={editAmount}
                    editDirection={editDirection}
                    editDate={editDate}
                    editDescription={editDescription}
                    editCategory={editCategory}
                    editFieldErrors={editFieldErrors}
                    categories={categories}
                    busy={busy}
                    authorityConfirmed={authorityConfirmed}
                    reportingZone={calculationZone}
                    minDate={
                      transaction.kind === 'REFUND'
                        ? (findTransactionById(
                            transaction.refundOfTransactionId ?? '',
                          )?.occurredOn ?? MIN_DATE)
                        : MIN_DATE
                    }
                    linkedRefundCount={
                      transaction.kind === 'EXPENSE'
                        ? linkedRefunds(transaction.id).length
                        : 0
                    }
                    onAmountChange={setEditAmount}
                    onDirectionChange={setEditDirection}
                    onDateChange={setEditDate}
                    onDescriptionChange={setEditDescription}
                    onCategoryChange={setEditCategory}
                    onSubmit={() => void submitEdit(transaction)}
                    onCancel={() => cancelEdit(transaction.id)}
                    editAmountRef={editAmountRef}
                    editCategoryRef={editCategoryRef}
                  />
                ) : (
                  <div className="finance-account-actions">
                    <button
                      type="button"
                      id={`details-trigger-${transaction.id}`}
                      className="household-button household-button--secondary"
                      disabled={busy || !authorityConfirmed}
                      aria-label={`Details for ${transaction.description}`}
                      onClick={() => void openDetail(transaction)}
                    >
                      Details
                    </button>
                    {isOwn && !voided && (
                      <>
                        <button
                          type="button"
                          id={`edit-trigger-${transaction.id}`}
                          className="household-button household-button--secondary"
                          disabled={busy || !authorityConfirmed}
                          aria-label={`Edit ${transaction.description}`}
                          onClick={() => beginEdit(transaction)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="household-button household-button--secondary"
                          disabled={busy || !authorityConfirmed}
                          aria-label={`Void ${transaction.description}`}
                          onClick={(event) =>
                            openVoidConfirm(transaction, event.currentTarget)
                          }
                        >
                          Void
                        </button>
                        {transaction.kind === 'EXPENSE' && (
                          <button
                            type="button"
                            className="household-button household-button--secondary"
                            disabled={busy || !authorityConfirmed}
                            aria-label={`Record a refund for ${transaction.description}`}
                            onClick={() => startRefund(transaction)}
                          >
                            Refund
                          </button>
                        )}
                        {isOwn &&
                          transaction.kind === 'EXPENSE' &&
                          transaction.visibility === 'HOUSEHOLD' && (
                            <button
                              type="button"
                              id={`allocation-trigger-${transaction.id}`}
                              className="household-button household-button--secondary"
                              disabled={busy || !authorityConfirmed}
                              aria-label={`Allocation for ${transaction.description}`}
                              onClick={(event) =>
                                openSplit(transaction, event.currentTarget)
                              }
                            >
                              {allocationByTransaction[transaction.id]
                                ? 'Allocation'
                                : 'Split'}
                            </button>
                          )}
                      </>
                    )}
                    {isOwn && transaction.kind !== 'REFUND' && (
                      <button
                        type="button"
                        className="household-button household-button--secondary"
                        disabled={busy || !authorityConfirmed}
                        aria-label={
                          transaction.visibility === 'HOUSEHOLD'
                            ? `Make ${transaction.description} private`
                            : `Share ${transaction.description} with the household`
                        }
                        onClick={(event) =>
                          openShareConfirm(
                            transaction,
                            transaction.visibility === 'HOUSEHOLD'
                              ? 'REVOKE'
                              : 'SHARE',
                            event.currentTarget,
                          )
                        }
                      >
                        {transaction.visibility === 'HOUSEHOLD'
                          ? 'Make private'
                          : 'Share'}
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {pageError && (
        <div role="alert" className="household-notice household-notice--error">
          <p>{pageError} Already loaded transactions remain available.</p>
        </div>
      )}
      {hasMore && activeNextOffset() <= 10000 && (
        <button
          ref={bottomPagerRef}
          type="button"
          className="household-button household-button--secondary"
          aria-disabled={pagerBlocked || undefined}
          onClick={() => {
            if (pagerBlocked) return;
            void loadMore();
          }}
        >
          {loadingMore
            ? 'Loading more…'
            : pageError
              ? 'Retry next page'
              : 'Load more transactions'}
        </button>
      )}
      {hasMore && activeNextOffset() > 10000 && (
        <p role="status" className="finance-helper">
          More history exists beyond the 10000 offset limit. This is not a
          complete export.
        </p>
      )}

      {pendingVoid && (
        <div
          ref={voidConfirmRef}
          tabIndex={-1}
          role="group"
          aria-label={`Confirm void for ${pendingVoid.transaction.description}`}
          className="household-notice household-notice--warning finance-void-confirm"
          onKeyDown={handleVoidConfirmKeyDown}
        >
          <p>
            Void “{pendingVoid.transaction.description}”? It stays listed as
            voided, stops counting toward spending, and can never be edited or
            restored. If it is an expense, void its refunds first.
          </p>
          <div className="finance-account-actions">
            <button
              type="button"
              className="household-button"
              disabled={busy}
              onClick={() => void confirmVoid()}
            >
              Void transaction
            </button>
            <button
              type="button"
              className="household-button household-button--secondary"
              disabled={busy}
              onClick={cancelVoidConfirm}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {pendingShare && (
        <div
          ref={shareConfirmRef}
          tabIndex={-1}
          role="group"
          aria-label={
            pendingShare.action === 'SHARE'
              ? `Confirm sharing ${pendingShare.transaction.description}`
              : `Confirm making ${pendingShare.transaction.description} private`
          }
          className={`household-notice ${
            pendingShare.action === 'SHARE'
              ? 'household-notice--info'
              : 'household-notice--warning'
          } finance-share-confirm`}
          onKeyDown={handleShareConfirmKeyDown}
        >
          {pendingShare.action === 'SHARE' ? (
            <>
              <h5>
                Share “{pendingShare.transaction.description}” with the
                household?
              </h5>
              <p>
                Every current member will be able to read the entry exactly as
                recorded, and members who join later will see it too. These
                fields are disclosed:
              </p>
              <dl className="finance-detail-list finance-disclosure-list">
                <div>
                  <dt>Amount</dt>
                  <dd>
                    {formatMoney(
                      pendingShare.transaction.money.amount,
                      pendingShare.transaction.money.currency,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Currency</dt>
                  <dd>{pendingShare.transaction.money.currency}</dd>
                </div>
                <div>
                  <dt>Date</dt>
                  <dd>
                    <time dateTime={pendingShare.transaction.occurredOn}>
                      {pendingShare.transaction.occurredOn}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>Kind</dt>
                  <dd>{kindLabel(pendingShare.transaction.kind)}</dd>
                </div>
                <div>
                  <dt>Description</dt>
                  <dd>{pendingShare.transaction.description}</dd>
                </div>
                <div>
                  <dt>Category</dt>
                  <dd>
                    {categoryLabel(
                      pendingShare.transaction.category,
                      categories,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Owner</dt>
                  <dd>You ({pendingShare.transaction.ownerUserId})</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>
                    {pendingShare.transaction.status === 'POSTED'
                      ? 'Posted'
                      : 'Voided'}
                  </dd>
                </div>
                <div>
                  <dt>Refund relationship</dt>
                  <dd>{refundRelationshipText(pendingShare.transaction)}</dd>
                </div>
              </dl>
              <p>
                Account details stay private: the account name, kind, and
                balances are never disclosed, and other members never see which
                account an entry came from.
              </p>
            </>
          ) : (
            <>
              <h5>
                Make “{pendingShare.transaction.description}” private again?
              </h5>
              <p>
                Household members lose access on their next refresh. Information
                already read cannot be retracted.
              </p>
              <p>
                The whole refund group changes together: every linked refund,
                including voided ones, becomes private with this entry.
              </p>
            </>
          )}
          <div className="finance-account-actions">
            <button
              type="button"
              className="household-button"
              disabled={busy}
              onClick={() => void confirmShare()}
            >
              {pendingShare.action === 'SHARE'
                ? 'Share with household'
                : 'Make private'}
            </button>
            <button
              type="button"
              className="household-button household-button--secondary"
              disabled={busy}
              onClick={cancelShareConfirm}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {pendingShare &&
        pendingShare.action === 'REVOKE' &&
        Boolean(allocationByTransaction[pendingShare.transaction.id]) && (
          <p role="status" className="household-hint finance-allocation-guide">
            This expense has an active allocation. Making it private is blocked
            while the allocation is active — revoke the allocation first.
            Revoking keeps the recorded shares on the server but removes them
            from member balances.
          </p>
        )}

      {splitTransaction && (
        <div
          ref={splitPanelRef}
          tabIndex={-1}
          role="group"
          aria-label={`Allocation for ${splitTransaction.description}`}
          className="finance-detail-panel finance-allocation-panel"
          onKeyDown={handleSplitKeyDown}
        >
          <h5>Allocation — “{splitTransaction.description}”</h5>
          {splitLoadingId === splitTransaction.id ? (
            <p role="status" aria-live="polite">
              Checking the current allocation…
            </p>
          ) : splitAllocationState === undefined ? (
            <p role="alert" className="household-error">
              The allocation state could not be checked. Close and reopen the
              allocation, or refresh the transactions, to retry.
            </p>
          ) : splitAllocationState ? (
            <div className="finance-allocation-active">
              <dl className="finance-detail-list">
                <div>
                  <dt>Amount allocated</dt>
                  <dd>
                    {formatMoney(
                      splitAllocationState.originalAmount.amount,
                      splitAllocationState.currency,
                    )}{' '}
                    — the full amount, never a partial share
                  </dd>
                </div>
                <div>
                  <dt>Payer</dt>
                  <dd>
                    {splitAllocationState.payerUserId === currentUserId
                      ? 'You'
                      : 'Financial owner'}{' '}
                    ({splitAllocationState.payerUserId})
                  </dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>Active</dd>
                </div>
                <div>
                  <dt>Recorded</dt>
                  <dd>
                    <time dateTime={splitAllocationState.createdAt}>
                      {splitAllocationState.createdAt}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>Expense version</dt>
                  <dd>
                    {splitAllocationState.transactionVersion} — informational;
                    mutations always read the live version first
                  </dd>
                </div>
              </dl>
              <p className="finance-helper">
                Recorded shares, in participant order. They are frozen: the
                participant set changes only by revoking this allocation and
                creating a new one with a fresh request. Members who leave keep
                their recorded shares.
              </p>
              <ul className="finance-allocation-shares">
                {splitAllocationState.participants.map((participant) => (
                  <li key={participant.userId}>
                    <span>
                      {participant.userId === currentUserId ? 'You' : 'Member'}{' '}
                      {participant.userId}
                    </span>
                    <span>
                      {formatMoney(
                        participant.share.amount,
                        splitAllocationState.currency,
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="finance-helper">
                Household visibility alone creates no debt; only this active
                allocation does. While it is active, the entry cannot be made
                private and its amount cannot be corrected.
              </p>
              {splitTransaction.ownerUserId === currentUserId ? (
                <div className="finance-account-actions">
                  <button
                    type="button"
                    className="household-button"
                    disabled={busy || !authorityConfirmed}
                    onClick={(event) =>
                      openRevokeConfirm(
                        splitTransaction,
                        splitAllocationState,
                        event.currentTarget,
                      )
                    }
                  >
                    Revoke allocation
                  </button>
                </div>
              ) : (
                <p className="finance-helper">
                  Read-only: only this expense's financial owner can change or
                  revoke this allocation.
                </p>
              )}
            </div>
          ) : (
            <AllocationCreateForm
              transaction={splitTransaction}
              magnitude={expenseMagnitudeOf(splitTransaction)}
              roster={roster}
              rosterLoading={rosterLoading}
              rosterError={rosterError}
              selected={splitParticipants}
              fieldError={splitFieldErrors.participants}
              busy={busy}
              creating={allocationCreating}
              currentUserId={currentUserId}
              onToggle={toggleSplitParticipant}
              onSubmit={() => {
                void handleAllocationSubmit();
              }}
              onCancel={() => cancelSplit(true)}
            />
          )}
          <div className="finance-account-actions">
            <button
              type="button"
              className="household-button household-button--secondary"
              disabled={busy}
              onClick={() => cancelSplit(true)}
            >
              Close allocation
            </button>
          </div>
        </div>
      )}

      {pendingAllocation !== null && (
        // Durable same-key retry affordance for the allocation create, like
        // the transaction block: the exact request and its original key stay
        // reconcilable until a same-key retry returns a known outcome.
        <div className="finance-pending-request">
          <p>
            An earlier allocation request still has an unknown result. Retry the
            exact same request with its original key, or refresh the list first.
            Refreshing keeps this request available.
          </p>
          <div className="finance-account-actions">
            <button
              type="button"
              className="household-button"
              disabled={busy || !authorityConfirmed}
              onClick={() => void submitAllocationCreate(pendingAllocation)}
            >
              Retry same request
            </button>
            <button
              type="button"
              className="household-button household-button--secondary"
              disabled={busy}
              onClick={refresh}
            >
              Refresh transactions
            </button>
          </div>
        </div>
      )}

      {pendingRevoke && (
        <div
          ref={revokeConfirmRef}
          tabIndex={-1}
          role="group"
          aria-label={`Confirm allocation revoke for ${pendingRevoke.transaction.description}`}
          className="household-notice household-notice--warning finance-void-confirm"
          onKeyDown={handleRevokeConfirmKeyDown}
        >
          <p>
            Revoke the allocation for “{pendingRevoke.transaction.description}
            ”? Member balances will no longer include this expense, and the
            recorded shares stay retained on the server but are never shown
            again. You can create a new allocation afterwards with a fresh
            request.
          </p>
          <div className="finance-account-actions">
            <button
              type="button"
              className="household-button"
              disabled={busy}
              onClick={() => void confirmAllocationRevoke()}
            >
              Revoke allocation
            </button>
            <button
              type="button"
              className="household-button household-button--secondary"
              disabled={busy}
              onClick={cancelRevokeConfirm}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {detail && (
        <div
          ref={detailPanelRef}
          tabIndex={-1}
          role="group"
          aria-label={`Details for ${detail.description}`}
          className="finance-detail-panel"
        >
          <h5>Transaction details</h5>
          <dl className="finance-detail-list">
            <div>
              <dt>Description</dt>
              <dd>{detail.description}</dd>
            </div>
            <div>
              <dt>Amount</dt>
              <dd>{formatMoney(detail.money.amount, detail.money.currency)}</dd>
            </div>
            <div>
              <dt>Kind</dt>
              <dd>{kindLabel(detail.kind)}</dd>
            </div>
            <div>
              <dt>Date</dt>
              <dd>
                <time dateTime={detail.occurredOn}>{detail.occurredOn}</time>
              </dd>
            </div>
            <div>
              <dt>Account</dt>
              <dd>
                {detail.accountId === null
                  ? 'Hidden — account details stay private with the owner.'
                  : (accountNameById.get(detail.accountId) ?? detail.accountId)}
              </dd>
            </div>
            <div>
              <dt>Owner</dt>
              <dd>
                {detail.ownerUserId === currentUserId
                  ? `You (${detail.ownerUserId})`
                  : detail.ownerUserId}
              </dd>
            </div>
            <div>
              <dt>Privacy</dt>
              <dd>
                {detail.visibility === 'HOUSEHOLD'
                  ? detail.ownerUserId === currentUserId
                    ? 'Household — every member can read these details; account details stay private.'
                    : 'Household — shared by another member; read-only for you.'
                  : 'Private — only you can read this entry.'}
              </dd>
            </div>
            <div>
              <dt>Category</dt>
              <dd>
                {detail.kind === 'REFUND'
                  ? `${categoryLabel(detail.category, categories)} — inherited from the source expense.`
                  : categoryLabel(detail.category, categories)}
              </dd>
            </div>
            {detailProvenanceRow(detail)}
            <div>
              <dt>Status</dt>
              <dd>{detail.status === 'POSTED' ? 'Posted' : 'Voided'}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{SOURCE_LABELS[detail.source]}</dd>
            </div>
            <div>
              <dt>Refund source</dt>
              <dd>
                {detail.refundOfTransactionId ? (
                  <button
                    type="button"
                    className="household-button household-button--secondary"
                    disabled={busy || !authorityConfirmed}
                    onClick={() => {
                      if (detail.refundOfTransactionId)
                        void openDetail(detail.refundOfTransactionId);
                    }}
                  >
                    View source expense
                  </button>
                ) : (
                  'None — not a refund'
                )}
              </dd>
            </div>
            {detail.kind === 'EXPENSE' &&
              detail.status === 'POSTED' &&
              detail.visibility === 'HOUSEHOLD' &&
              Boolean(allocationByTransaction[detail.id]) && (
                <div>
                  <dt>Allocation</dt>
                  <dd>
                    Active — the full amount is divided into recorded shares.
                    Only the financial owner can change or revoke this
                    allocation.
                  </dd>
                </div>
              )}
            {detailAllocation && (
              <div className="finance-allocation-detail">
                <dt>Recorded shares (read-only)</dt>
                <dd>
                  <ul className="finance-allocation-shares">
                    {detailAllocation.participants.map((participant) => (
                      <li key={participant.userId}>
                        <span>
                          {participant.userId === currentUserId
                            ? 'You'
                            : 'Member'}{' '}
                          {participant.userId}
                        </span>
                        <span>
                          {formatMoney(
                            participant.share.amount,
                            detailAllocation.currency,
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
            <div>
              <dt>Version</dt>
              <dd>{detail.version}</dd>
            </div>
            <div>
              <dt>Recorded</dt>
              <dd>
                <time dateTime={detail.createdAt}>{detail.createdAt}</time>
              </dd>
            </div>
            <div>
              <dt>Last changed</dt>
              <dd>
                <time dateTime={detail.updatedAt}>{detail.updatedAt}</time>
              </dd>
            </div>
          </dl>
          <div className="finance-account-actions">
            {/* A source expense reached by ID may sit outside the loaded
                pages, so the panel itself offers the same owner actions a
                row would: the exact versioned visibility change and the
                allocation route. Another member's shared entry stays
                read-only, and a refund never carries a direct visibility
                patch — its group follows the source expense. */}
            {detail.ownerUserId === currentUserId &&
              detail.kind !== 'REFUND' && (
                <button
                  type="button"
                  className="household-button household-button--secondary"
                  disabled={busy || !authorityConfirmed}
                  aria-label={
                    detail.visibility === 'HOUSEHOLD'
                      ? `Make ${detail.description} private from details`
                      : `Share ${detail.description} with the household from details`
                  }
                  onClick={(event) =>
                    openShareConfirm(
                      detail,
                      detail.visibility === 'HOUSEHOLD' ? 'REVOKE' : 'SHARE',
                      event.currentTarget,
                    )
                  }
                >
                  {detail.visibility === 'HOUSEHOLD' ? 'Make private' : 'Share'}
                </button>
              )}
            {isAllocationFetchable(detail) &&
              detail.ownerUserId === currentUserId && (
                <button
                  type="button"
                  className="household-button household-button--secondary"
                  disabled={busy || !authorityConfirmed}
                  aria-label={`Allocation for ${detail.description} from details`}
                  onClick={(event) => openSplit(detail, event.currentTarget)}
                >
                  {allocationByTransaction[detail.id] ? 'Allocation' : 'Split'}
                </button>
              )}
            <button
              type="button"
              className="household-button household-button--secondary"
              disabled={busy}
              onClick={closeDetail}
            >
              Close details
            </button>
          </div>
        </div>
      )}

      {transactions !== null && !loading && (
        <form
          className="finance-create-form"
          onSubmit={handleCreate}
          noValidate
        >
          <h5>Record a transaction</h5>
          {refundSource && (
            <p className="finance-refund-context">
              Refund of the expense “{refundSource.description}” recorded on{' '}
              {refundSource.occurredOn}. The account, currency, and source are
              fixed to it, and the refund inherits this expense's category and
              privacy.
            </p>
          )}
          {!refundSource && (
            <div className="household-field">
              <label htmlFor={`new-transaction-account-${household.id}`}>
                Account
              </label>
              <select
                ref={createAccountRef}
                id={`new-transaction-account-${household.id}`}
                value={createAccountId}
                onChange={(event) => {
                  setCreateAccountId(event.target.value);
                  setCreateFieldErrors({});
                }}
                disabled={busy || pendingCreate !== null || !authorityConfirmed}
                aria-invalid={Boolean(createFieldErrors.account)}
                aria-describedby={
                  createFieldErrors.account
                    ? `new-transaction-account-error-${household.id}`
                    : undefined
                }
              >
                <option value="">Choose an account…</option>
                {activeAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} · {account.currency}
                  </option>
                ))}
              </select>
              {createFieldErrors.account && (
                <p
                  id={`new-transaction-account-error-${household.id}`}
                  className="household-error"
                  role="alert"
                >
                  {createFieldErrors.account}
                </p>
              )}
            </div>
          )}
          <div className="finance-create-grid">
            <div className="household-field">
              <label htmlFor={`new-transaction-kind-${household.id}`}>
                Entry type
              </label>
              {refundSource ? (
                <p className="finance-locked-value">Refund (fixed)</p>
              ) : (
                <select
                  id={`new-transaction-kind-${household.id}`}
                  value={createKind}
                  onChange={(event) =>
                    setCreateKind(
                      event.target.value as 'EXPENSE' | 'INCOME' | 'TRANSFER',
                    )
                  }
                  disabled={
                    busy || pendingCreate !== null || !authorityConfirmed
                  }
                >
                  {KIND_OPTIONS.filter(
                    (option) => option.value !== 'REFUND',
                  ).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} — {option.hint}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="household-field">
              <span className="household-field-label">Currency</span>
              <p className="finance-locked-value">
                {selectedCurrency ??
                  (refundSource ? refundSource.money.currency : '—')}
              </p>
            </div>
          </div>
          {createKind === 'TRANSFER' && !refundSource && (
            <fieldset className="finance-direction-fieldset">
              <legend>Transfer direction</legend>
              <label className="finance-direction-option">
                <input
                  type="radio"
                  name={`transfer-direction-${household.id}`}
                  value="OUT"
                  checked={createDirection === 'OUT'}
                  onChange={() => setCreateDirection('OUT')}
                  disabled={
                    busy || pendingCreate !== null || !authorityConfirmed
                  }
                />
                <span>Money out (−)</span>
              </label>
              <label className="finance-direction-option">
                <input
                  type="radio"
                  name={`transfer-direction-${household.id}`}
                  value="IN"
                  checked={createDirection === 'IN'}
                  onChange={() => setCreateDirection('IN')}
                  disabled={
                    busy || pendingCreate !== null || !authorityConfirmed
                  }
                />
                <span>Money in (+)</span>
              </label>
            </fieldset>
          )}
          <div className="household-field">
            <label htmlFor={`new-transaction-amount-${household.id}`}>
              Amount
            </label>
            <input
              ref={amountRef}
              id={`new-transaction-amount-${household.id}`}
              value={createAmount}
              onChange={(event) => {
                setCreateAmount(event.target.value);
                setCreateFieldErrors({});
              }}
              inputMode="decimal"
              autoComplete="off"
              disabled={busy || pendingCreate !== null || !authorityConfirmed}
              aria-invalid={Boolean(createFieldErrors.amount)}
              aria-describedby={
                createFieldErrors.amount
                  ? `new-transaction-amount-hint-${household.id} new-transaction-amount-error-${household.id}`
                  : `new-transaction-amount-hint-${household.id}`
              }
            />
            <p
              id={`new-transaction-amount-hint-${household.id}`}
              className="household-hint"
            >
              {refundSource
                ? 'The returned amount, without a sign.'
                : 'Positive size only; the entry type sets the direction. Use a decimal point (12.50), not a comma.'}
            </p>
            {createFieldErrors.amount && (
              <p
                id={`new-transaction-amount-error-${household.id}`}
                className="household-error"
                role="alert"
              >
                {createFieldErrors.amount}
              </p>
            )}
            <p role="status" className="finance-amount-preview">
              {createAmountPreview()}
            </p>
          </div>
          <div className="finance-create-grid">
            <div className="household-field">
              <label htmlFor={`new-transaction-date-${household.id}`}>
                Date
              </label>
              <input
                id={`new-transaction-date-${household.id}`}
                type="date"
                value={createDate}
                min={createMinDate}
                max={MAX_DATE}
                onChange={(event) => {
                  setCreateDate(event.target.value);
                  createDateTouchedRef.current = true;
                  setCreateFieldErrors({});
                }}
                disabled={busy || pendingCreate !== null || !authorityConfirmed}
                aria-invalid={Boolean(createFieldErrors.date)}
                aria-describedby={
                  createFieldErrors.date
                    ? `new-transaction-date-error-${household.id}`
                    : undefined
                }
              />
              {createFieldErrors.date && (
                <p
                  id={`new-transaction-date-error-${household.id}`}
                  className="household-error"
                  role="alert"
                >
                  {createFieldErrors.date}
                </p>
              )}
              {createFutureWarning && (
                <p role="status" className="household-hint">
                  This date is in the future. It stays a recorded fact and
                  appears in reports only when a period covers its date.
                </p>
              )}
            </div>
            <div className="household-field">
              <label htmlFor={`new-transaction-description-${household.id}`}>
                Description
              </label>
              <input
                id={`new-transaction-description-${household.id}`}
                value={createDescription}
                onChange={(event) => {
                  setCreateDescription(event.target.value);
                  setCreateFieldErrors({});
                }}
                autoComplete="off"
                disabled={busy || pendingCreate !== null || !authorityConfirmed}
                aria-invalid={Boolean(createFieldErrors.description)}
                aria-describedby={
                  createFieldErrors.description
                    ? `new-transaction-description-error-${household.id}`
                    : undefined
                }
              />
              {createFieldErrors.description && (
                <p
                  id={`new-transaction-description-error-${household.id}`}
                  className="household-error"
                  role="alert"
                >
                  {createFieldErrors.description}
                </p>
              )}
            </div>
          </div>
          {!refundSource && (
            <div className="household-field">
              <label htmlFor={`new-transaction-category-${household.id}`}>
                Category
              </label>
              <select
                ref={createCategoryRef}
                id={`new-transaction-category-${household.id}`}
                value={createCategory}
                onChange={(event) => {
                  setCreateCategory(event.target.value);
                  setCreateFieldErrors({});
                }}
                disabled={busy || pendingCreate !== null || !authorityConfirmed}
                aria-invalid={Boolean(createFieldErrors.category)}
                aria-describedby={
                  createFieldErrors.category
                    ? `new-transaction-category-error-${household.id}`
                    : undefined
                }
              >
                <option value="">Uncategorized — no category</option>
                {(categories ?? []).map((category) => (
                  <option key={category.code} value={category.code}>
                    {category.label}
                  </option>
                ))}
              </select>
              {categories === null && (
                <p className="household-hint">
                  Category unavailable. Refresh the section to retry the list.
                </p>
              )}
              {createFieldErrors.category && (
                <p
                  id={`new-transaction-category-error-${household.id}`}
                  className="household-error"
                  role="alert"
                >
                  {createFieldErrors.category}
                </p>
              )}
            </div>
          )}
          <p className="finance-helper">
            {refundSource
              ? 'The refund is recorded against this expense in its account and currency. Its category and privacy follow the expense.'
              : 'Privacy stays private unless you explicitly share. Account and entry type cannot be changed later; a wrong one is corrected by voiding and recording a new entry.'}
          </p>
          <div className="finance-account-actions">
            <button
              type="submit"
              className="household-button"
              disabled={busy || pendingCreate !== null || !authorityConfirmed}
            >
              {creating ? 'Recording…' : 'Record transaction'}
            </button>
            {refundSource && (
              <button
                type="button"
                className="household-button household-button--secondary"
                disabled={busy || pendingCreate !== null}
                onClick={cancelRefund}
              >
                Cancel refund
              </button>
            )}
          </div>
        </form>
      )}

      <CategorizationRulesSection
        household={household}
        csrf={csrf}
        onCsrfRefreshed={onCsrfRefreshed}
        onSessionExpired={onSessionExpired}
        onHouseholdAccessChanged={onHouseholdAccessChanged}
        authorityConfirmed={authorityConfirmed}
        categories={categories}
        refreshSignal={rulesRefresh}
        scopeResetSignal={scopeReset}
      />
      <CategorizationReviewsSection
        household={household}
        csrf={csrf}
        onCsrfRefreshed={onCsrfRefreshed}
        onSessionExpired={onSessionExpired}
        onHouseholdAccessChanged={onHouseholdAccessChanged}
        authorityConfirmed={authorityConfirmed}
        categories={categories}
        refreshSignal={reviewsRefresh}
        scopeResetSignal={scopeReset}
        onTransactionChanged={handleReviewedTransaction}
      />
      <MemberBalancesSection
        household={household}
        currentUserId={currentUserId}
        refreshSignal={balancesRefresh}
        onSessionExpired={onSessionExpired}
        onHouseholdAccessChanged={onHouseholdAccessChanged}
      />
      <ReportingSettingsSection
        household={household}
        csrf={csrf}
        onCsrfRefreshed={onCsrfRefreshed}
        onSessionExpired={onSessionExpired}
        onHouseholdAccessChanged={onHouseholdAccessChanged}
        onZoneLoaded={handleZoneLoaded}
        authorityConfirmed={authorityConfirmed}
      />
      <SpendingDashboardSection
        household={household}
        reportingZone={reportingZone}
        refreshSignal={reportingRefresh}
        onSessionExpired={onSessionExpired}
        onHouseholdAccessChanged={onHouseholdAccessChanged}
      />
    </section>
  );

  /**
   * Owner-only provenance for the open detail panel. Another member's shared
   * entry renders nothing here: the panel then shows only the effective
   * category that is already visible to every household reader. Loading, an
   * out-of-date response, and an unavailable resource all stay calm prose
   * with an explicit retry, never a raw code and never a claimed state.
   */
  function detailProvenanceRow(entry: Transaction) {
    if (entry.ownerUserId !== currentUserId) return null;
    const freshState =
      detailProvenance.status === 'ready' &&
      detailProvenance.state.transactionVersion === entry.version
        ? detailProvenance.state
        : null;
    return (
      <div>
        <dt>Category decision</dt>
        <dd>
          {freshState ? (
            <>
              <span>{ORIGIN_LABELS[freshState.origin]}</span>{' '}
              <span className="household-meta">
                Assigned{' '}
                <time dateTime={freshState.assignedAt}>
                  {freshState.assignedAt}
                </time>
                .
              </span>
              {freshState.ruleEligible && (
                // The offer exists only while the server reports a safe
                // derived key and no active rule for it: the browser neither
                // derives the key nor decides eligibility, and a rule
                // failure never rolls back the category already saved.
                <div className="finance-rule-offer">
                  <button
                    type="button"
                    className="household-button household-button--secondary"
                    disabled={
                      busy || pendingRuleCreate !== null || !authorityConfirmed
                    }
                    onClick={() => createRuleFrom(entry, freshState)}
                  >
                    {ruleCreating ? 'Creating rule…' : 'Use for future matches'}
                  </button>
                  <p className="household-hint">
                    Creates a private rule: future entries that match this one
                    use {categoryLabel(freshState.category, categories)}.
                    Nothing already recorded changes, and only you can see the
                    rule.
                  </p>
                </div>
              )}
              {freshState.reviewState === 'OPEN' && (
                // The owner-only resource reports a suggestion for
                // this entry. Only that fact appears here — the suggestion,
                // its reason, and the decision all live in the private review
                // queue below, where "Keep uncategorized" is an explicit
                // decision rather than a missing one.
                <p className="household-hint">
                  HouseSync has a category suggestion for this entry. It is
                  waiting for your decision under “Category reviews”.
                </p>
              )}
            </>
          ) : detailProvenance.status === 'loading' ? (
            'Loading your category decision…'
          ) : (
            <>
              <span>
                {detailProvenance.status === 'ready'
                  ? 'This decision changed on the server — retry to load the current one.'
                  : 'Category decision unavailable.'}
              </span>{' '}
              <button
                type="button"
                className="household-button household-button--secondary"
                disabled={busy}
                onClick={() => void loadProvenance(entry)}
              >
                Retry category decision
              </button>
            </>
          )}
        </dd>
      </div>
    );
  }

  function createAmountPreview(): string {
    // The preview announces the encoded value; specific validation errors
    // stay in the field's alert paragraph and are never duplicated here.
    const notRecordable = 'The entered value is not recordable yet.';
    if (refundSource) {
      if (createAmount === '') return 'Records nothing yet.';
      const encoded = encodeMoneyMagnitude(
        createAmount,
        refundSource.money.currency,
        'positive',
      );
      return encoded.ok
        ? `Records ${formatMoney(encoded.amount, refundSource.money.currency)}.`
        : notRecordable;
    }
    const account = accounts?.find((value) => value.id === createAccountId);
    if (!account) return 'Choose an account to see the recorded value.';
    if (createAmount === '')
      return `Records nothing yet in ${account.currency}.`;
    const sign = signFor(createKind, createDirection);
    const encoded = encodeMoneyMagnitude(createAmount, account.currency, sign);
    return encoded.ok
      ? `Records ${formatMoney(encoded.amount, account.currency)}.`
      : notRecordable;
  }

  function findTransactionById(id: string): Transaction | undefined {
    return (
      ownTransactions?.find((value) => value.id === id) ??
      householdTransactions?.find((value) => value.id === id)
    );
  }
}

interface EditFormProps {
  transaction: Transaction;
  currency: string;
  editAmount: string;
  editDirection: 'OUT' | 'IN';
  editDate: string;
  editDescription: string;
  editCategory: string;
  editFieldErrors: FieldErrors;
  categories: TransactionCategory[] | null;
  busy: boolean;
  authorityConfirmed: boolean;
  /** Household reporting zone for the future-date warning. */
  reportingZone: string;
  minDate: string;
  linkedRefundCount: number;
  onAmountChange: (value: string) => void;
  onDirectionChange: (value: 'OUT' | 'IN') => void;
  onDateChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onCategoryChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  editAmountRef: React.RefObject<HTMLInputElement | null>;
  editCategoryRef: React.RefObject<HTMLSelectElement | null>;
}

function EditForm({
  transaction,
  currency,
  editAmount,
  editDirection,
  editDate,
  editDescription,
  editCategory,
  editFieldErrors,
  categories,
  busy,
  authorityConfirmed,
  reportingZone,
  minDate,
  linkedRefundCount,
  onAmountChange,
  onDirectionChange,
  onDateChange,
  onDescriptionChange,
  onCategoryChange,
  onSubmit,
  onCancel,
  editAmountRef,
  editCategoryRef,
}: EditFormProps) {
  return (
    <form
      className="finance-edit-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      noValidate
    >
      <p className="finance-helper">
        {transaction.kind === 'TRANSFER'
          ? 'A transfer keeps its entry type; its direction and amount can be corrected.'
          : `The entry type stays ${kindLabel(transaction.kind).toLowerCase()}; the sign follows it.`}
      </p>
      {transaction.kind === 'TRANSFER' && (
        <fieldset className="finance-direction-fieldset">
          <legend>Transfer direction</legend>
          <label className="finance-direction-option">
            <input
              type="radio"
              name={`edit-transfer-direction-${transaction.id}`}
              checked={editDirection === 'OUT'}
              onChange={() => onDirectionChange('OUT')}
              disabled={busy || !authorityConfirmed}
            />
            <span>Money out (−)</span>
          </label>
          <label className="finance-direction-option">
            <input
              type="radio"
              name={`edit-transfer-direction-${transaction.id}`}
              checked={editDirection === 'IN'}
              onChange={() => onDirectionChange('IN')}
              disabled={busy || !authorityConfirmed}
            />
            <span>Money in (+)</span>
          </label>
        </fieldset>
      )}
      <div className="household-field">
        <label htmlFor={`edit-transaction-amount-${transaction.id}`}>
          Amount
        </label>
        <input
          ref={editAmountRef}
          id={`edit-transaction-amount-${transaction.id}`}
          value={editAmount}
          onChange={(event) => onAmountChange(event.target.value)}
          inputMode="decimal"
          autoComplete="off"
          disabled={busy || !authorityConfirmed}
          aria-invalid={Boolean(editFieldErrors.amount)}
          aria-describedby={
            editFieldErrors.amount
              ? `edit-transaction-amount-hint-${transaction.id} edit-transaction-amount-error-${transaction.id}`
              : `edit-transaction-amount-hint-${transaction.id}`
          }
        />
        <p
          id={`edit-transaction-amount-hint-${transaction.id}`}
          className="household-hint"
        >
          {currency} · positive size only; the sign follows the entry.
        </p>
        {editFieldErrors.amount && (
          <p
            id={`edit-transaction-amount-error-${transaction.id}`}
            className="household-error"
            role="alert"
          >
            {editFieldErrors.amount}
          </p>
        )}
      </div>
      <div className="finance-create-grid">
        <div className="household-field">
          <label htmlFor={`edit-transaction-date-${transaction.id}`}>
            Date
          </label>
          <input
            id={`edit-transaction-date-${transaction.id}`}
            type="date"
            value={editDate}
            min={minDate}
            max={MAX_DATE}
            onChange={(event) => onDateChange(event.target.value)}
            disabled={busy || !authorityConfirmed}
            aria-invalid={Boolean(editFieldErrors.date)}
            aria-describedby={
              editFieldErrors.date
                ? `edit-transaction-date-error-${transaction.id}`
                : undefined
            }
          />
          {editFieldErrors.date && (
            <p
              id={`edit-transaction-date-error-${transaction.id}`}
              className="household-error"
              role="alert"
            >
              {editFieldErrors.date}
            </p>
          )}
          {isFutureDateInZone(editDate, reportingZone) && (
            <p role="status" className="household-hint">
              This date is in the future. It stays a recorded fact and appears
              in reports only when a period covers its date.
            </p>
          )}
        </div>
        <div className="household-field">
          <label htmlFor={`edit-transaction-description-${transaction.id}`}>
            Description
          </label>
          <input
            id={`edit-transaction-description-${transaction.id}`}
            value={editDescription}
            onChange={(event) => onDescriptionChange(event.target.value)}
            autoComplete="off"
            disabled={busy || !authorityConfirmed}
            aria-invalid={Boolean(editFieldErrors.description)}
            aria-describedby={
              editFieldErrors.description
                ? `edit-transaction-description-error-${transaction.id}`
                : undefined
            }
          />
          {editFieldErrors.description && (
            <p
              id={`edit-transaction-description-error-${transaction.id}`}
              className="household-error"
              role="alert"
            >
              {editFieldErrors.description}
            </p>
          )}
        </div>
      </div>
      {transaction.kind === 'REFUND' ? (
        <p className="finance-refund-context">
          This refund inherits its category and privacy from the source expense.
          Change them on the expense; a direct change here is never accepted.
        </p>
      ) : (
        <div className="household-field">
          <label htmlFor={`edit-transaction-category-${transaction.id}`}>
            Category
          </label>
          <select
            ref={editCategoryRef}
            id={`edit-transaction-category-${transaction.id}`}
            value={editCategory}
            onChange={(event) => onCategoryChange(event.target.value)}
            disabled={busy || !authorityConfirmed}
            aria-invalid={Boolean(editFieldErrors.category)}
            aria-describedby={
              editFieldErrors.category
                ? `edit-transaction-category-error-${transaction.id}`
                : undefined
            }
          >
            <option value="">Clear category — uncategorized</option>
            {categories === null && editCategory !== '' && (
              // The stored token stays selected so the control never
              // misreports the recorded category; its label is the calm
              // unavailable text rather than a raw code.
              <option value={editCategory}>Category unavailable</option>
            )}
            {(categories ?? []).map((category) => (
              <option key={category.code} value={category.code}>
                {category.label}
              </option>
            ))}
          </select>
          {categories === null && (
            <p className="household-hint">
              Category unavailable. Refresh the section to retry the list.
            </p>
          )}
          {editFieldErrors.category && (
            <p
              id={`edit-transaction-category-error-${transaction.id}`}
              className="household-error"
              role="alert"
            >
              {editFieldErrors.category}
            </p>
          )}
          {linkedRefundCount > 0 && (
            <p role="status" className="household-hint">
              This expense has {linkedRefundCount} linked{' '}
              {linkedRefundCount === 1 ? 'refund' : 'refunds'} on this page.
              Saving applies the category to the whole refund group, including
              voided refunds.
            </p>
          )}
        </div>
      )}
      <div className="finance-account-actions">
        <button
          type="submit"
          className="household-button"
          disabled={busy || !authorityConfirmed}
        >
          Save correction
        </button>
        <button
          type="button"
          className="household-button household-button--secondary"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

interface AllocationCreateFormProps {
  transaction: Transaction;
  magnitude: string;
  roster: HouseholdMember[] | null;
  rosterLoading: boolean;
  rosterError: string | undefined;
  selected: string[];
  fieldError: string | undefined;
  busy: boolean;
  creating: boolean;
  currentUserId: string;
  onToggle: (userId: string, checked: boolean) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/**
 * The allocation creation form: roster-based explicit participant
 * selection (payer included or omitted), the exact equal-division preview
 * in checked minor units, and the contract explanations before an
 * irreversible freeze. The participant set is bounded by the loaded
 * roster; the selection is nonempty before submission.
 */
function AllocationCreateForm({
  transaction,
  magnitude,
  roster,
  rosterLoading,
  rosterError,
  selected,
  fieldError,
  busy,
  creating,
  currentUserId,
  onToggle,
  onSubmit,
  onCancel,
}: AllocationCreateFormProps) {
  const currency = transaction.money.currency;
  const selectedSet = new Set(selected);
  const orderedRoster = sortCanonicalUserIds(
    (roster ?? []).map((member) => member.userId),
  ).map(
    (userId) =>
      (roster ?? []).find((member) => member.userId === userId) as
        HouseholdMember | undefined,
  );
  const preview = previewEqualShares(magnitude, currency, selected);

  function previewText(): string {
    if (selected.length === 0) {
      return 'Select participants to preview the exact shares.';
    }
    if (!preview) return 'The selection is not valid yet.';
    const shares = preview.map((entry) => formatMoney(entry.share, currency));
    return `Divides the full ${formatMoney(magnitude, currency)} exactly: ${shares.join(' + ')} across ${preview.length} ${preview.length === 1 ? 'participant' : 'participants'}.`;
  }

  return (
    <form
      className="finance-allocation-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      noValidate
    >
      <p className="finance-helper">
        Payer: you recorded the full {formatMoney(magnitude, currency)} in this
        household-visible expense. The allocation covers 100% of it. You may
        include yourself among the participants or leave yourself out.
      </p>
      {rosterError && (
        <p role="alert" className="household-error">
          {rosterError}
        </p>
      )}
      <fieldset className="finance-participants-fieldset">
        <legend>Participants</legend>
        <p className="household-hint">
          Select every member who shares this expense. Everyone starts selected.
        </p>
        {rosterLoading && (
          <p role="status" aria-live="polite">
            Loading current members…
          </p>
        )}
        {orderedRoster.map((member) =>
          member ? (
            <label key={member.userId} className="finance-participant-option">
              <input
                type="checkbox"
                checked={selectedSet.has(member.userId)}
                onChange={(event) =>
                  onToggle(member.userId, event.target.checked)
                }
                disabled={busy || rosterLoading}
              />
              <span>
                {member.email}
                {member.userId === currentUserId ? ' — you (payer)' : ''}
                <span className="finance-participant-uuid">
                  {member.userId}
                </span>
              </span>
            </label>
          ) : null,
        )}
        {roster !== null && orderedRoster.length === 0 && !rosterLoading && (
          <p role="alert" className="household-error">
            No current members are available to select. Refresh the household
            before allocating.
          </p>
        )}
      </fieldset>
      {fieldError && (
        <p role="alert" className="household-error">
          {fieldError}
        </p>
      )}
      <p role="status" className="finance-amount-preview finance-share-preview">
        {previewText()}
      </p>
      <p className="finance-helper">
        Shares freeze when the allocation is created: the participant set and
        each exact share are recorded and never change. To correct the
        participants later, revoke the allocation and create a new one with a
        fresh request. Members who leave keep their recorded shares and
        obligations. Sharing an entry with the household alone creates no debt —
        only this allocation does.
      </p>
      <div className="finance-account-actions">
        <button
          type="submit"
          className="household-button"
          disabled={busy || rosterLoading}
        >
          {creating ? 'Creating…' : 'Create allocation'}
        </button>
        <button
          type="button"
          className="household-button household-button--secondary"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
