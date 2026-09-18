import {
  useEffect,
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
  fetchTransactions,
  patchAllocationRevoke,
  patchTransaction,
  postTransaction,
  postTransactionAllocation,
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

/**
 * Server-returned labels are the only user-visible category names; the raw
 * token is shown verbatim only when the taxonomy could not be loaded for
 * that code.
 */
function categoryLabel(
  category: string | null,
  categories: TransactionCategory[] | null,
): string {
  if (category === null) return 'Uncategorized';
  return (
    categories?.find((value) => value.code === category)?.label ?? category
  );
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
  const [householdTransactions, setHouseholdTransactions] = useState<
    Transaction[] | null
  >(null);
  const [householdHasMore, setHouseholdHasMore] = useState(false);
  const [activeView, setActiveView] = useState<TransactionFeedView>('OWN');
  const [loading, setLoading] = useState(true);
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
  const controllersRef = useRef<Set<AbortController>>(new Set());
  const creatingRef = useRef(false);
  const updatingRef = useRef<string | null>(null);
  // Synchronous source of truth for in-flight detail fetches: state updates
  // are async, so a second activation in the same flush must be refused by
  // the ref, not the not-yet-flushed state.
  const detailLoadingRef = useRef(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  const createAccountRef = useRef<HTMLSelectElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const editAmountRef = useRef<HTMLInputElement>(null);
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

  function track(controller: AbortController) {
    controllersRef.current.add(controller);
  }

  function untrack(controller: AbortController) {
    controllersRef.current.delete(controller);
  }

  function setFeedPage(
    view: TransactionFeedView,
    items: Transaction[],
    hasMore: boolean,
  ) {
    if (view === 'OWN') {
      setOwnTransactions(items);
      setOwnHasMore(hasMore);
    } else {
      setHouseholdTransactions(items);
      setHouseholdHasMore(hasMore);
    }
  }

  function feedIsLoaded(view: TransactionFeedView): boolean {
    return (view === 'OWN' ? ownTransactions : householdTransactions) !== null;
  }

  function activeTransactions(): Transaction[] | null {
    return activeView === 'OWN' ? ownTransactions : householdTransactions;
  }

  function activeHasMore(): boolean {
    return activeView === 'OWN' ? ownHasMore : householdHasMore;
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
    },
  ) {
    setLoading(true);
    if (!options.preserveNotice) setNotice(null);
    try {
      const [meta, feedPages] = await Promise.all([
        options.includeMeta
          ? Promise.all([
              fetchFinancialAccounts(household.id, controller.signal),
              fetchTransactionCategories(household.id, controller.signal),
            ])
          : Promise.resolve(null),
        Promise.all(
          options.views.map((view) =>
            fetchTransactions(household.id, view, controller.signal),
          ),
        ),
      ]);
      if (!current(generation) || controller.signal.aborted) return;
      if (meta) {
        setAccounts(meta[0].items);
        setCategories(meta[1].items);
      }
      options.views.forEach((view, index) => {
        const page = feedPages[index];
        if (page) setFeedPage(view, page.items, page.hasMore);
      });
      setLoading(false);
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
    reloadViews(loadedViews(), true, false);
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
  ) {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    track(controller);
    // A reload that settles a mutation keeps that mutation's outcome
    // notice visible; manual refreshes clear notices instead.
    void load(generation, controller, {
      views,
      includeMeta,
      preserveNotice,
    }).finally(() => untrack(controller));
  }

  function switchView(view: TransactionFeedView) {
    if (view === activeView) return;
    if (
      loading ||
      creatingRef.current ||
      updatingRef.current !== null ||
      detailLoadingRef.current ||
      !authorityConfirmed
    ) {
      return;
    }
    setActiveView(view);
    if (!feedIsLoaded(view)) {
      reloadViews([view], categories === null, false);
    }
  }

  function clearScopedState() {
    // Old generations must not publish into cleared state: in-flight
    // load continuations are ignored from here on.
    generationRef.current += 1;
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
   * initial load settles is parked, never marked served.
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
      reloadViews(views, true, true);
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
    if (notice) noticeRef.current?.focus();
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
      setters.focusAmount();
      return true;
    }
    return false;
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
          focusAmount: () => amountRef.current?.focus(),
        })
      ) {
        setPendingCreate(null);
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
      if (detail?.id === updated.id) setDetail(null);
      setNotice({
        kind: 'info',
        text: `Transaction corrected: ${formatMoney(
          updated.money.amount,
          updated.money.currency,
        )} on ${updated.occurredOn}.`,
      });
      // A money correction of a refund or expense changes derived
      // balances; description/date/category changes do not.
      if (changedMoney) bumpBalances();
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
          focusAmount: () => editAmountRef.current?.focus(),
        })
      ) {
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
    setOwnTransactions((currentRows) =>
      (currentRows ?? []).filter((value) => value.id !== transactionId),
    );
    setHouseholdTransactions((currentRows) =>
      (currentRows ?? []).filter((value) => value.id !== transactionId),
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

  async function openDetail(transaction: Transaction) {
    // The ref guards same-flush double activations; the aligned opener
    // guard refuses confirmations, mutations, loads, and unconfirmed
    // authority for defense in depth.
    if (confirmOrMutationActive() || detailLoadingRef.current) return;
    if (detailLoadingId !== null) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    track(controller);
    detailLoadingRef.current = true;
    setDetailLoadingId(transaction.id);
    setNotice(null);
    try {
      const fresh = await fetchTransaction(
        household.id,
        transaction.id,
        controller.signal,
      );
      // Guards block every late continuation after unmount, a household
      // replacement, or any newer generation taking over this section.
      if (!current(generation) || controller.signal.aborted) return;
      setDetail(fresh);
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
        removeFromFeeds(transaction.id);
        if (detail?.id === transaction.id) setDetail(null);
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
    // The Details trigger element persists (the panel renders after the
    // list, not in place of the row actions), so focus returns by its
    // stable id after the flush removes the panel.
    if (closing) {
      requestAnimationFrame(() => {
        if (unmountedRef.current) return;
        document.getElementById(`details-trigger-${closing.id}`)?.focus();
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

  const busy =
    loading ||
    creating ||
    updatingId !== null ||
    detailLoadingId !== null ||
    splitLoadingId !== null;

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
            name={`transactions-feed-${household.id}`}
            value="OWN"
            checked={activeView === 'OWN'}
            onChange={() => switchView('OWN')}
            disabled={busy || pendingCreate !== null || !authorityConfirmed}
          />
          <span>My transactions</span>
        </label>
        <label className="finance-feed-option">
          <input
            type="radio"
            name={`transactions-feed-${household.id}`}
            value="HOUSEHOLD"
            checked={activeView === 'HOUSEHOLD'}
            onChange={() => switchView('HOUSEHOLD')}
            disabled={busy || pendingCreate !== null || !authorityConfirmed}
          />
          <span>Household feed</span>
        </label>
      </fieldset>

      {!authorityConfirmed && (
        <p role="status" className="household-stale">
          Refresh the household before changing transactions.
        </p>
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

      {hasMore && (
        <p role="status" className="finance-helper">
          Showing the first 100 transactions. Additional paging will arrive with
          larger-history support.
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
            <div>
              <dt>Status</dt>
              <dd>{detail.status === 'POSTED' ? 'Posted' : 'Voided'}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>Manual</dd>
            </div>
            <div>
              <dt>Refund source</dt>
              <dd>
                {detail.refundOfTransactionId
                  ? detail.refundOfTransactionId
                  : 'None — not a refund'}
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
                  Categories could not be loaded. Refresh the section to retry.
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
            {(categories ?? []).map((category) => (
              <option key={category.code} value={category.code}>
                {category.label}
              </option>
            ))}
          </select>
          {categories === null && (
            <p className="household-hint">
              Categories could not be loaded. Refresh the section to retry.
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
