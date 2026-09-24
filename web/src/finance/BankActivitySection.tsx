import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  ApiError,
  confirmBankActivity,
  dismissBankActivity,
  fetchBankActivity,
  fetchBankActivityDetail,
  fetchCsrf,
  fetchFinancialConnections,
  fetchTransaction,
  fetchTransactionAllocation,
  fetchTransactionCategories,
  fetchTransactions,
  postConnectionSync,
  replaceBankActivityLedger,
  resolveBankActivity,
  type BankActivity,
  type BankActivityDecision,
  type BankActivityDismissReason,
  type BankActivityPage,
  type BankActivityReviewState,
  type BankActivityState,
  type CsrfToken,
  type FinancialConnection,
  type Household,
  type ReplaceBody,
  type ResolveApplyField,
  type ResolveBody,
  type Transaction,
  type TransactionAllocation,
  type TransactionCategory,
} from '../auth/client';
import {
  confirmEvidenceOf,
  draftFor,
  replaceDraftFor,
  resolveDraftFor,
  type ConfirmDraft,
  type ReplaceDraft,
  type ResolveDraft,
} from './bank-activity';
import {
  isConfirmable,
  isDismissable,
  isNeedsReview,
  isSyncStale,
  requiresOwnerDescription,
} from './bank-activity';
import { formatMoney } from './money';

interface Notice {
  kind: 'info' | 'error' | 'warning';
  text: string;
  correlationId?: string | undefined;
}

interface BankActivitySectionProps {
  household: Household;
  csrf: CsrfToken | null;
  onCsrfRefreshed: (token: CsrfToken) => void;
  onSessionExpired: () => void;
  onHouseholdAccessChanged: () => void;
  authorityConfirmed: boolean;
  /**
   * Bumped by the parent after a definitive connection lifecycle or account
   * selection commit, so the connection list and inbox converge without
   * remounting this section or discarding its drafts. A signal arriving
   * before the initial load settles is parked and served afterwards.
   */
  refreshSignal?: number | undefined;
  /**
   * Called after a successful confirmation admits a ledger entry, so the
   * sibling transaction feed refetches without remounting or discarding its
   * form drafts. Dismissal never calls it.
   */
  onLedgerChanged?: (() => void) | undefined;
}

const STATE_FILTERS: ReadonlyArray<'ALL' | BankActivityState> = [
  'ALL',
  'PENDING',
  'POSTED',
  'REMOVED',
  'INVALID',
];

const REVIEW_FILTERS: ReadonlyArray<'ALL' | BankActivityReviewState> = [
  'ALL',
  'UNREVIEWED',
  'CONFIRMED',
  'DISMISSED',
];

const DISMISS_REASONS: ReadonlyArray<{
  value: BankActivityDismissReason;
  label: string;
}> = [
  { value: 'ALREADY_RECORDED', label: 'Already recorded manually' },
  { value: 'NOT_NEEDED', label: 'Not needed' },
];

function stateLabel(state: BankActivityState): string {
  switch (state) {
    case 'PENDING':
      return 'Pending';
    case 'POSTED':
      return 'Posted';
    case 'REMOVED':
      return 'Removed by bank';
    case 'INVALID':
      return 'Needs review';
  }
}

function reviewLabel(review: BankActivityReviewState): string {
  switch (review) {
    case 'UNREVIEWED':
      return 'Not reviewed';
    case 'CONFIRMED':
      return 'In the ledger';
    case 'DISMISSED':
      return 'Dismissed';
  }
}

function connectionStateLabel(state: FinancialConnection['state']): string {
  switch (state) {
    case 'LINKING':
      return 'Linking…';
    case 'ACTIVE':
      return 'Active';
    case 'REAUTH_REQUIRED':
      return 'Needs reconnection';
    case 'SUSPENDED':
      return 'Suspended';
    case 'DISCONNECTING':
      return 'Disconnecting…';
    case 'DISCONNECTED':
      return 'Disconnected';
    case 'ERROR':
      return 'Needs attention';
  }
}

function changeLabel(activity: BankActivity): string | null {
  if (activity.changeState === 'MODIFIED') {
    return 'Needs review: the bank revised this after you added it. Your ledger entry is unchanged and household totals still use it. Open Review to keep the ledger, apply the bank revision, or void it.';
  }
  if (activity.changeState === 'REMOVED') {
    return 'Needs review: the bank removed this after you added it. Your ledger entry is unchanged and household totals still use it. Open Review to keep the ledger or void it; the bank revision cannot be applied because the bank no longer carries it.';
  }
  return null;
}

/** Wall-clock read isolated from the component body for the purity lint rule. */
function currentTimeMs(): number {
  return Date.now();
}

function activitySummary(activity: BankActivity): string {
  const money =
    activity.money === null
      ? 'an unknown amount'
      : formatMoney(activity.money.amount, activity.money.currency);
  const date = activity.occurredOn ?? 'an unknown date';
  return `${money} on ${date}`;
}

function syncStateLabel(connection: FinancialConnection): string | null {
  switch (connection.syncState) {
    case 'FAILED':
      return 'Sync failed — request a sync to retry';
    case 'RETRY_WAIT':
      return 'Waiting to retry the sync';
    case 'RUNNING':
      return 'Syncing…';
    case 'QUEUED':
      return 'Sync queued';
    case 'IDLE':
      return null;
  }
}

/**
 * The message a confirmation rejection deserves on the category control, or
 * undefined when it belongs anywhere else. A rejection the server attributed
 * to another field — or to any other code — is never shown here, and the
 * fallback names no submitted token: a raw enum value never reaches prose.
 */
function categoryRejectionError(
  apiError: ApiError,
  submittedCategory: string,
): string | undefined {
  if (apiError.code !== 'VALIDATION_FAILED') return undefined;
  const named = apiError.fieldErrors?.category;
  if (named !== undefined && named.length > 0) return named;
  // An unattributed rejection with no other field error can only be the
  // category the owner chose from the bounded taxonomy; anything the server
  // pinned elsewhere keeps its own handling.
  if (submittedCategory.length === 0) return undefined;
  if (Object.keys(apiError.fieldErrors ?? {}).length > 0) return undefined;
  return 'That category could not be saved. Pick a category from the list and try again.';
}

/**
 * Reconciliation panel for one needs-review row. Everything shown
 * stays in this owner-only inbox: the ledger summary is the owner's own
 * entry and the bank revision never leaves this view. Resolution never
 * depends on connection state, so a retained admitted entry can be resolved
 * after disconnect.
 */
function ResolvePanel({
  activity,
  draft,
  ledger,
  ledgerLoading,
  activeAllocation,
  decisionBusy,
  ref,
  onPatch,
  onSubmit,
  onCancel,
}: {
  activity: BankActivity;
  draft: ResolveDraft;
  ledger: Transaction | null | undefined;
  ledgerLoading: boolean;
  activeAllocation: TransactionAllocation | null | undefined;
  decisionBusy: boolean;
  ref: RefObject<HTMLHeadingElement | null>;
  onPatch: (patch: Partial<ResolveDraft>) => void;
  onSubmit: (activity: BankActivity) => void;
  onCancel: (activityId: string) => void;
}) {
  const applyUnavailable =
    activity.state === 'REMOVED' || activity.changeState === 'REMOVED';
  return (
    <div
      className="bank-activity-form"
      role="group"
      aria-labelledby={`resolve-heading-${activity.id}`}
    >
      <h5 ref={ref} tabIndex={-1} id={`resolve-heading-${activity.id}`}>
        Review the bank revision for {activitySummary(activity)}
      </h5>
      <p className="finance-helper">
        Your ledger entry is unchanged and household totals still use it.
        Nothing here restarts sync or shares bank detail with the household.
      </p>
      {ledgerLoading && <p role="status">Loading your ledger entry…</p>}
      {!ledgerLoading && ledger === null && (
        <p className="bank-activity-warning" role="status">
          The ledger entry is no longer available. Refresh the inbox before
          reviewing.
        </p>
      )}
      {!ledgerLoading && ledger !== undefined && ledger !== null && (
        <p className="bank-activity-meta">
          Ledger now: {formatMoney(ledger.money.amount, ledger.money.currency)}{' '}
          on {ledger.occurredOn} · {ledger.description}
        </p>
      )}
      <p className="bank-activity-meta">
        Bank now:{' '}
        {activity.money === null
          ? 'amount unavailable (removed by the bank)'
          : formatMoney(activity.money.amount, activity.money.currency)}{' '}
        on {activity.occurredOn ?? 'an unknown date'}
        {activity.providerDescription
          ? ` · ${activity.providerDescription}`
          : ''}
      </p>
      <fieldset className="finance-direction-fieldset">
        <legend>Resolution</legend>
        <label className="finance-direction-option">
          <input
            type="radio"
            name={`resolve-action-${activity.id}`}
            checked={draft.action === 'KEEP_LEDGER'}
            onChange={() => onPatch({ action: 'KEEP_LEDGER' })}
          />
          Keep my ledger entry
        </label>
        <label className="finance-direction-option">
          <input
            type="radio"
            name={`resolve-action-${activity.id}`}
            checked={draft.action === 'APPLY_BANK'}
            disabled={applyUnavailable}
            onChange={() => onPatch({ action: 'APPLY_BANK' })}
          />
          Apply the bank fields I choose
        </label>
        <label className="finance-direction-option">
          <input
            type="radio"
            name={`resolve-action-${activity.id}`}
            checked={draft.action === 'VOID_LEDGER'}
            onChange={() => onPatch({ action: 'VOID_LEDGER' })}
          />
          Void my ledger entry
        </label>
      </fieldset>
      {draft.action === 'KEEP_LEDGER' && (
        <p className="finance-helper">
          Records your decision against this exact bank revision. If the bank
          revises it again materially, review reopens.
        </p>
      )}
      {draft.action === 'APPLY_BANK' && !applyUnavailable && (
        <fieldset className="finance-direction-fieldset">
          <legend>Bank fields to apply</legend>
          <label className="finance-direction-option">
            <input
              type="checkbox"
              checked={draft.applyMoney}
              onChange={(event) =>
                onPatch({ applyMoney: event.target.checked })
              }
            />
            Amount
          </label>
          <label className="finance-direction-option">
            <input
              type="checkbox"
              checked={draft.applyDate}
              onChange={(event) => onPatch({ applyDate: event.target.checked })}
            />
            Date
          </label>
          <label className="finance-direction-option">
            <input
              type="checkbox"
              checked={draft.applyDescription}
              disabled={!activity.descriptionValid}
              onChange={(event) =>
                onPatch({ applyDescription: event.target.checked })
              }
            />
            Description
          </label>
        </fieldset>
      )}
      {draft.action === 'APPLY_BANK' && applyUnavailable && (
        <p className="bank-activity-warning">
          The bank removed this entry, so its revision cannot be applied. Keep
          the ledger or void it instead.
        </p>
      )}
      {draft.action === 'APPLY_BANK' &&
        !applyUnavailable &&
        !activity.descriptionValid && (
          <p className="bank-activity-warning">
            The bank description cannot be used as ledger text, so it cannot be
            applied. Enter a correction through replacement instead, or apply
            only amount and date.
          </p>
        )}
      {draft.action === 'APPLY_BANK' && !applyUnavailable && (
        <p className="finance-helper">
          Only the selected amount, date, and description change, under the
          usual ledger rules. Kind, account, category, visibility, and refund
          links never change here.
        </p>
      )}
      {activeAllocation !== undefined && activeAllocation !== null && (
        <p className="bank-activity-warning">
          This entry has an active allocation (
          {activeAllocation.participants.length} participant
          {activeAllocation.participants.length === 1 ? '' : 's'}). Its amount
          cannot change while shares are recorded: uncheck the amount, revoke
          the allocation in the ledger first, or void/replace instead.
        </p>
      )}
      {draft.action === 'VOID_LEDGER' && (
        <p className="bank-activity-warning">
          Voiding removes this entry from household totals and obligations. Void
          any live refunds on it first, as usual; an active allocation is
          deactivated atomically. This cannot be undone from here.
        </p>
      )}
      <div className="finance-account-actions">
        <button
          type="button"
          className="household-button"
          disabled={decisionBusy}
          onClick={() => onSubmit(activity)}
        >
          {decisionBusy ? 'Resolving…' : 'Resolve revision'}
        </button>
        <button
          type="button"
          className="household-button household-button--secondary"
          disabled={decisionBusy}
          onClick={() => onCancel(activity.id)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Atomic-replacement panel. One step voids the old entry under the
 * usual rules, admits the replacement from the current posted bank revision,
 * and moves the association while retaining history. The replacement is
 * private unless it is a linked refund inheriting disclosure; no allocation
 * is ever copied forward.
 */
function ReplacePanel({
  activity,
  draft,
  ledgerLoading,
  ledgerGone,
  activeAllocation,
  categories,
  refundOptions,
  decisionBusy,
  ref,
  onPatch,
  onKindChange,
  onSubmit,
  onCancel,
}: {
  activity: BankActivity;
  draft: ReplaceDraft;
  ledgerLoading: boolean;
  ledgerGone: boolean;
  activeAllocation: TransactionAllocation | null | undefined;
  categories: TransactionCategory[];
  refundOptions: Transaction[] | null;
  decisionBusy: boolean;
  ref: RefObject<HTMLHeadingElement | null>;
  onPatch: (patch: Partial<ReplaceDraft>) => void;
  onKindChange: (kind: ReplaceDraft['kind'], draft: ReplaceDraft) => void;
  onSubmit: (activity: BankActivity) => void;
  onCancel: (activityId: string) => void;
}) {
  return (
    <div
      className="bank-activity-form"
      role="group"
      aria-labelledby={`replace-heading-${activity.id}`}
    >
      <h5 ref={ref} tabIndex={-1} id={`replace-heading-${activity.id}`}>
        Replace the ledger entry for {activitySummary(activity)}
      </h5>
      <p className="finance-helper">
        One atomic step: the old entry is voided under the usual rules, a
        replacement is created from the current posted bank revision, and the
        association moves while history is retained. The replacement is private
        unless it is a linked refund inheriting disclosure. The old entry cannot
        be replaced while live refunds remain, and no new allocation is created
        here.
      </p>
      {ledgerLoading && <p role="status">Loading your ledger entry…</p>}
      {!ledgerLoading && ledgerGone && (
        <p className="bank-activity-warning" role="status">
          The ledger entry is no longer available. Refresh the inbox before
          replacing.
        </p>
      )}
      <label>
        Entry type
        <select
          value={draft.kind}
          onChange={(event) =>
            onKindChange(event.target.value as ReplaceDraft['kind'], draft)
          }
        >
          <option value="EXPENSE">Expense</option>
          <option value="INCOME">Income</option>
          <option value="TRANSFER">Transfer</option>
          <option value="REFUND">Refund</option>
        </select>
      </label>
      <label>
        Description
        <input
          type="text"
          maxLength={200}
          value={draft.description}
          placeholder={activity.providerDescription ?? 'Enter a description'}
          onChange={(event) => onPatch({ description: event.target.value })}
        />
      </label>
      {categories.length > 0 && (
        <label>
          Category
          <select
            value={draft.category}
            onChange={(event) => onPatch({ category: event.target.value })}
          >
            <option value="">Uncategorized</option>
            {categories.map((category) => (
              <option key={category.code} value={category.code}>
                {category.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {draft.kind === 'REFUND' && (
        <>
          <label>
            Refunded expense
            <select
              value={draft.refundOfTransactionId}
              onChange={(event) =>
                onPatch({ refundOfTransactionId: event.target.value })
              }
            >
              <option value="">Choose a connected expense…</option>
              {(refundOptions ?? []).map((option) => (
                <option key={option.id} value={option.id}>
                  {formatMoney(option.money.amount, option.money.currency)} ·{' '}
                  {option.description} · {option.occurredOn}
                </option>
              ))}
            </select>
          </label>
          <label className="bank-activity-checkbox">
            <input
              type="checkbox"
              checked={draft.acknowledgeDisclosure}
              onChange={(event) =>
                onPatch({ acknowledgeDisclosure: event.target.checked })
              }
            />
            Share this refund with the household (required when the expense is
            shared)
          </label>
          {refundOptions !== null && refundOptions.length === 0 && (
            <p className="bank-activity-warning">
              No connected posted expense matches this account and currency yet.
            </p>
          )}
        </>
      )}
      {activeAllocation !== undefined && activeAllocation !== null && (
        <>
          <p className="bank-activity-warning">
            Replacing removes the recorded allocation (
            {activeAllocation.participants.length} participant
            {activeAllocation.participants.length === 1 ? '' : 's'}) and its
            obligations. The allocation is deactivated, never copied to the
            replacement.
          </p>
          <label className="bank-activity-checkbox">
            <input
              type="checkbox"
              checked={draft.acknowledgeAllocationRemoval}
              onChange={(event) =>
                onPatch({ acknowledgeAllocationRemoval: event.target.checked })
              }
            />
            I understand the recorded allocation and its obligations are removed
          </label>
        </>
      )}
      <div className="finance-account-actions">
        <button
          type="button"
          className="household-button"
          disabled={decisionBusy}
          onClick={() => onSubmit(activity)}
        >
          {decisionBusy ? 'Replacing…' : 'Replace entry'}
        </button>
        <button
          type="button"
          className="household-button household-button--secondary"
          disabled={decisionBusy}
          onClick={() => onCancel(activity.id)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Owner-private bank activity inbox. Owner-scoped reads and
 * decisions; pending, invalid, removed, and unreviewed rows are informational
 * and never contribute to the confirmed ledger or household reporting. Draft
 * confirm forms live in memory keyed by observation id, so a background
 * refresh never discards typed text; sign-out or a household switch unmounts
 * this component and clears every private value with it.
 */
export function BankActivitySection({
  household,
  csrf,
  onCsrfRefreshed,
  onSessionExpired,
  onHouseholdAccessChanged,
  authorityConfirmed,
  refreshSignal = 0,
  onLedgerChanged,
}: BankActivitySectionProps) {
  const [page, setPage] = useState<BankActivityPage | null>(null);
  const [connections, setConnections] = useState<FinancialConnection[] | null>(
    null,
  );
  const [categories, setCategories] = useState<TransactionCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [stateFilter, setStateFilter] = useState<'ALL' | BankActivityState>(
    'ALL',
  );
  const [reviewFilter, setReviewFilter] = useState<
    'ALL' | BankActivityReviewState
  >('ALL');
  const [syncBusy, setSyncBusy] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState<Record<string, number>>(
    {},
  );
  const [confirmDraft, setConfirmDraft] = useState<ConfirmDraft | null>(null);
  // A confirmation the server rejected on the category control: the message
  // lives beside that select, and the typed draft stays open for correction.
  const [confirmCategoryError, setConfirmCategoryError] = useState<
    string | undefined
  >(undefined);
  const [refundOptions, setRefundOptions] = useState<Transaction[] | null>(
    null,
  );
  const [dismissOpen, setDismissOpen] = useState<string | null>(null);
  const [dismissReason, setDismissReason] =
    useState<BankActivityDismissReason>('ALREADY_RECORDED');
  const [decisionBusy, setDecisionBusy] = useState(false);
  // Reconciliation state. Resolve/replace drafts live beside the
  // confirm drafts so refreshes never discard them; the ledger cache holds
  // the current ledger entry per needs-review activity (null only while
  // loading or when the entry is gone) and the allocation cache holds the
  // active allocation per ledger transaction id (null when none is active,
  // undefined while unknown).
  const [resolveDraft, setResolveDraft] = useState<ResolveDraft | null>(null);
  const [replaceDraft, setReplaceDraft] = useState<ReplaceDraft | null>(null);
  const [ledgerByActivity, setLedgerByActivity] = useState<
    Record<string, Transaction | null>
  >({});
  const [ledgerLoading, setLedgerLoading] = useState<Record<string, boolean>>(
    {},
  );
  const [allocationByLedger, setAllocationByLedger] = useState<
    Record<string, TransactionAllocation | null | undefined>
  >({});
  const [replaceRefundOptions, setReplaceRefundOptions] = useState<
    Transaction[] | null
  >(null);
  // Explicit pagination: the inbox never silently truncates; load-more walks
  // the bounded offset page until hasMore is false.
  const [loadingMore, setLoadingMore] = useState(false);
  // Ticking clock for the client-side per-connection sync cooldown; the
  // interval only runs while a cooldown is pending so idle pages stay quiet.
  const [clockMs, setClockMs] = useState(0);

  const csrfRef = useRef<CsrfToken | null>(csrf);
  const generationRef = useRef(0);
  const unmountedRef = useRef(false);
  const ownedRef = useRef<Set<AbortController>>(new Set());
  const draftsRef = useRef<Record<string, ConfirmDraft>>({});
  // The evidence each retained confirmation draft was built from, so a
  // non-material inbox refresh reuses the typed draft instead of rebuilding
  // it while a material revision still replaces it.
  const draftEvidenceRef = useRef<Record<string, string>>({});
  const resolveDraftsRef = useRef<Record<string, ResolveDraft>>({});
  const replaceDraftsRef = useRef<Record<string, ReplaceDraft>>({});
  const noticeRef = useRef<HTMLDivElement>(null);
  const confirmHeadingRef = useRef<HTMLHeadingElement>(null);
  const confirmCategoryRef = useRef<HTMLSelectElement>(null);
  const resolveHeadingRef = useRef<HTMLHeadingElement>(null);
  const replaceHeadingRef = useRef<HTMLHeadingElement>(null);
  const loadGenerationRef = useRef(0);
  // Sibling refresh sequencing: a signal whose refetch converged, plus a
  // parked flag for signals that arrive before the initial load settles.
  const servedRefreshSignalRef = useRef(refreshSignal);
  const pendingRefreshSignalRef = useRef(false);

  useEffect(() => {
    csrfRef.current = csrf;
  }, [csrf]);

  useEffect(() => {
    unmountedRef.current = false;
    const owned = ownedRef.current;
    return () => {
      unmountedRef.current = true;
      for (const controller of owned) controller.abort();
      owned.clear();
    };
  }, []);

  const track = useCallback(() => {
    const controller = new AbortController();
    ownedRef.current.add(controller);
    return controller;
  }, []);

  const current = useCallback(
    (generation: number) =>
      !unmountedRef.current && generationRef.current === generation,
    [],
  );

  const showNotice = useCallback(
    (kind: Notice['kind'], text: string, correlationId?: string) => {
      setNotice({ kind, text, correlationId });
    },
    [],
  );

  const ensureCsrf = useCallback(
    async (generation: number, signal: AbortSignal) => {
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
    },
    [current, onCsrfRefreshed],
  );

  const handleAuthFailure = useCallback(
    (apiError: ApiError, generation: number) => {
      if (!current(generation)) return true;
      if (apiError.code === 'UNAUTHENTICATED') {
        onSessionExpired();
        return true;
      }
      if (apiError.code === 'CSRF_INVALID' || apiError.status === 403) {
        onHouseholdAccessChanged();
        showNotice('warning', 'Refresh to continue: your session changed.');
        return true;
      }
      return false;
    },
    [current, onHouseholdAccessChanged, onSessionExpired, showNotice],
  );

  const load = useCallback(
    async (generation: number, quiet = false) => {
      const controller = track();
      if (!quiet) setLoading(true);
      try {
        const [activityPage, connectionPage] = await Promise.all([
          fetchBankActivity(
            household.id,
            {
              state: stateFilter === 'ALL' ? undefined : stateFilter,
              review: reviewFilter === 'ALL' ? undefined : reviewFilter,
            },
            controller.signal,
          ),
          fetchFinancialConnections(household.id, controller.signal),
        ]);
        if (!current(generation) || controller.signal.aborted) return;
        setPage(activityPage);
        setConnections(connectionPage.items);
        setLoading(false);
      } catch (error) {
        if (!current(generation) || controller.signal.aborted) return;
        setLoading(false);
        if (error instanceof ApiError) {
          if (handleAuthFailure(error, generation)) return;
          showNotice(
            'error',
            error.message || 'Could not load bank activity.',
            error.correlationId,
          );
          return;
        }
        showNotice('error', 'Could not load bank activity.');
      } finally {
        ownedRef.current.delete(controller);
      }
    },
    [
      current,
      handleAuthFailure,
      household.id,
      reviewFilter,
      showNotice,
      stateFilter,
      track,
    ],
  );

  useEffect(() => {
    const generation = ++loadGenerationRef.current;
    generationRef.current = generation;
    void load(generation);
    return () => {
      // The next effect run or unmount invalidates in-flight work.
    };
  }, [load]);

  /**
   * Serves a sibling refresh signal with a quiet refetch of both the
   * connection list and the inbox. Drafts live in `draftsRef`, so a refetch
   * never discards typed text. A signal that arrives before the initial load
   * settles is parked (never marked served) and served once `page` exists.
   */
  function serveRefreshSignal() {
    if (servedRefreshSignalRef.current === refreshSignal) return;
    if (page === null) {
      pendingRefreshSignalRef.current = true;
      return;
    }
    pendingRefreshSignalRef.current = false;
    servedRefreshSignalRef.current = refreshSignal;
    const generation = ++loadGenerationRef.current;
    generationRef.current = generation;
    void load(generation, true);
  }

  useEffect(() => {
    serveRefreshSignal();
    // The signal alone drives this effect; `page` is read only to park a
    // pre-load signal for the settling effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  useEffect(() => {
    if (!pendingRefreshSignalRef.current || page === null) return;
    serveRefreshSignal();
    // `page` becoming non-null is the trigger; the parked flag and signal
    // decide whether a fetch is owed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  /** Appends the next bounded page; the offset is the current item count. */
  async function loadMore() {
    if (!page || !page.hasMore || loadingMore) return;
    const generation = generationRef.current;
    const controller = track();
    setLoadingMore(true);
    try {
      const nextPage = await fetchBankActivity(
        household.id,
        {
          offset: page.items.length,
          state: stateFilter === 'ALL' ? undefined : stateFilter,
          review: reviewFilter === 'ALL' ? undefined : reviewFilter,
        },
        controller.signal,
      );
      if (!current(generation) || controller.signal.aborted) return;
      setPage((currentPage) => {
        if (!currentPage) return nextPage;
        const known = new Set(currentPage.items.map((item) => item.id));
        return {
          ...nextPage,
          items: [
            ...currentPage.items,
            ...nextPage.items.filter((item) => !known.has(item.id)),
          ],
        };
      });
    } catch (error) {
      if (!current(generation)) return;
      if (error instanceof ApiError) {
        if (handleAuthFailure(error, generation)) return;
        showNotice(
          'error',
          error.message || 'Could not load more bank activity.',
          error.correlationId,
        );
        return;
      }
      showNotice('error', 'Could not load more bank activity.');
    } finally {
      ownedRef.current.delete(controller);
      if (current(generation)) setLoadingMore(false);
    }
  }

  // Categories are optional enrichment for the confirm form; a failure never
  // blocks the inbox.
  useEffect(() => {
    const controller = track();
    void (async () => {
      try {
        const result = await fetchTransactionCategories(
          household.id,
          controller.signal,
        );
        if (unmountedRef.current || controller.signal.aborted) return;
        setCategories(result.items);
      } catch {
        // Optional.
      } finally {
        ownedRef.current.delete(controller);
      }
    })();
    return () => controller.abort();
  }, [household.id, track]);

  async function refresh() {
    const generation = ++loadGenerationRef.current;
    generationRef.current = generation;
    await load(generation, true);
  }

  async function runSync(connection: FinancialConnection) {
    const generation = generationRef.current;
    const controller = track();
    const requestedAt = currentTimeMs();
    setSyncBusy(connection.id);
    try {
      const activeCsrf = await ensureCsrf(generation, controller.signal);
      if (!current(generation) || controller.signal.aborted) return;
      if (!activeCsrf) {
        onSessionExpired();
        return;
      }
      await postConnectionSync(
        household.id,
        connection.id,
        connection.version,
        crypto.randomUUID(),
        activeCsrf,
        controller.signal,
      );
      if (!current(generation)) return;
      setClockMs(requestedAt);
      setCooldownUntil((currentCooldowns) => ({
        ...currentCooldowns,
        [connection.id]: requestedAt + 60_000,
      }));
      showNotice(
        'info',
        'Sync requested. New bank activity appears after the bank responds; pending items are never added automatically.',
      );
      await load(generation, true);
    } catch (error) {
      if (!current(generation)) return;
      if (error instanceof ApiError) {
        if (error.code === 'MANUAL_SYNC_RATE_LIMITED') {
          setClockMs(requestedAt);
          setCooldownUntil((currentCooldowns) => ({
            ...currentCooldowns,
            [connection.id]: requestedAt + 60_000,
          }));
          showNotice('info', 'A sync ran moments ago. Try again shortly.');
          return;
        }
        if (handleAuthFailure(error, generation)) return;
        showNotice('error', error.message || 'Sync could not be started.');
        return;
      }
      showNotice('error', 'Sync could not be started.');
    } finally {
      ownedRef.current.delete(controller);
      if (current(generation)) setSyncBusy(null);
    }
  }

  function openConfirm(activity: BankActivity) {
    const existing = draftsRef.current[activity.id];
    const evidence = confirmEvidenceOf(activity);
    // A refresh that changed only non-material evidence keeps the owner's
    // typed draft; its version still converges so the next submit is guarded
    // against the current revision. Anything ledger-relevant rebuilds it.
    const draft =
      existing !== undefined &&
      draftEvidenceRef.current[activity.id] === evidence
        ? { ...existing, version: activity.version }
        : draftFor(activity);
    draftsRef.current[activity.id] = draft;
    draftEvidenceRef.current[activity.id] = evidence;
    setConfirmDraft(draft);
    setConfirmCategoryError(undefined);
    setRefundOptions(null);
    setNotice(null);
  }

  function updateDraft(patch: Partial<ConfirmDraft>) {
    // Every edit supersedes the last rejection, so a bound category error
    // never lingers once the owner changes the draft.
    setConfirmCategoryError(undefined);
    setConfirmDraft((currentDraft) => {
      if (!currentDraft) return currentDraft;
      const next = { ...currentDraft, ...patch };
      draftsRef.current[next.activityId] = next;
      return next;
    });
  }

  async function loadRefundOptions(draft: ConfirmDraft) {
    const generation = generationRef.current;
    const controller = track();
    try {
      const transactions = await fetchTransactions(
        household.id,
        'OWN',
        controller.signal,
      );
      if (!current(generation) || controller.signal.aborted) return;
      setRefundOptions(
        transactions.items.filter(
          (transaction) =>
            transaction.source === 'CONNECTED' &&
            transaction.kind === 'EXPENSE' &&
            transaction.status === 'POSTED' &&
            transaction.accountId !== null &&
            transaction.accountId === draft.localAccountId &&
            transaction.money.currency === draft.currency,
        ),
      );
    } catch {
      if (!current(generation)) return;
      setRefundOptions([]);
    } finally {
      ownedRef.current.delete(controller);
    }
  }

  function closeConfirm() {
    setConfirmCategoryError(undefined);
    setConfirmDraft(null);
  }

  async function submitConfirm() {
    const draft = confirmDraft;
    if (!draft) return;
    if (!draft.descriptionValid && draft.description.trim().length === 0) {
      showNotice(
        'warning',
        'Enter your own description: the bank text cannot be used for the ledger.',
      );
      return;
    }
    if (draft.kind === 'REFUND' && !draft.refundOfTransactionId) {
      showNotice('warning', 'Choose the connected expense being refunded.');
      return;
    }
    const generation = generationRef.current;
    const controller = track();
    setDecisionBusy(true);
    try {
      const activeCsrf = await ensureCsrf(generation, controller.signal);
      if (!current(generation) || controller.signal.aborted) return;
      if (!activeCsrf) {
        onSessionExpired();
        return;
      }
      const decision = await confirmBankActivity(
        household.id,
        draft.activityId,
        {
          expectedVersion: draft.version,
          kind: draft.kind,
          description: draft.description,
          category: draft.category.length === 0 ? null : draft.category,
          refundOfTransactionId:
            draft.kind === 'REFUND' ? draft.refundOfTransactionId : undefined,
          acknowledgeDisclosure: draft.acknowledgeDisclosure,
        },
        draft.idempotencyKey,
        activeCsrf,
        controller.signal,
      );
      if (!current(generation)) return;
      delete draftsRef.current[draft.activityId];
      delete draftEvidenceRef.current[draft.activityId];
      setConfirmCategoryError(undefined);
      setConfirmDraft(null);
      applyDecision(decision);
      showNotice(
        'info',
        'Added to your private ledger. Pending and unreviewed bank activity never contributes to household totals.',
      );
      // The confirmed ledger entry must be discoverable in the sibling
      // transaction feed without a reload; dismissal never triggers this.
      onLedgerChanged?.();
      await refresh();
    } catch (error) {
      if (!current(generation)) return;
      if (error instanceof ApiError) {
        if (handleAuthFailure(error, generation)) return;
        if (staleDecisionRecovery(error, draft.activityId)) return;
        const categoryError = categoryRejectionError(error, draft.category);
        if (categoryError !== undefined) {
          // Bind the rejection to the control the owner must correct: the
          // draft stays open with every typed value, and focus returns to
          // the category select instead of the section notice.
          setConfirmCategoryError(categoryError);
          showNotice(
            'error',
            'Check the highlighted category.',
            error.correlationId,
          );
          // The notice and the field both re-render after this failure; two
          // frames place focus on the control that needs correction, after
          // the notice's own announcement focus.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              if (unmountedRef.current) return;
              confirmCategoryRef.current?.focus();
            }),
          );
          return;
        }
        showNotice(
          'error',
          error.message || 'That bank activity could not be confirmed.',
          error.correlationId,
        );
        return;
      }
      showNotice('error', 'That bank activity could not be confirmed.');
    } finally {
      ownedRef.current.delete(controller);
      // The decision owns this flag: a successful outcome refreshes and
      // advances the load generation, so only unmount may skip the reset.
      if (!unmountedRef.current) setDecisionBusy(false);
    }
  }

  async function submitDismiss(activity: BankActivity) {
    const generation = generationRef.current;
    const controller = track();
    setDecisionBusy(true);
    try {
      const activeCsrf = await ensureCsrf(generation, controller.signal);
      if (!current(generation) || controller.signal.aborted) return;
      if (!activeCsrf) {
        onSessionExpired();
        return;
      }
      const decision = await dismissBankActivity(
        household.id,
        activity.id,
        activity.version,
        dismissReason,
        crypto.randomUUID(),
        activeCsrf,
        controller.signal,
      );
      if (!current(generation)) return;
      setDismissOpen(null);
      applyDecision(decision);
      showNotice(
        'info',
        'Dismissed. The item stays as retained evidence and never affects the ledger.',
      );
      await refresh();
    } catch (error) {
      if (!current(generation)) return;
      if (error instanceof ApiError) {
        if (handleAuthFailure(error, generation)) return;
        if (staleDecisionRecovery(error, activity.id)) return;
        showNotice(
          'error',
          error.message || 'That bank activity could not be dismissed.',
          error.correlationId,
        );
        return;
      }
      showNotice('error', 'That bank activity could not be dismissed.');
    } finally {
      ownedRef.current.delete(controller);
      // The decision owns this flag: a successful outcome refreshes and
      // advances the load generation, so only unmount may skip the reset.
      if (!unmountedRef.current) setDecisionBusy(false);
    }
  }

  function applyDecision(decision: BankActivityDecision) {
    setPage((currentPage) => {
      if (!currentPage) return currentPage;
      return {
        ...currentPage,
        items: currentPage.items.map((item) =>
          item.id === decision.activity.id ? decision.activity : item,
        ),
      };
    });
  }

  /**
   * Loads the current ledger entry behind a needs-review row plus its active
   * allocation probe. Results are cached per activity/ledger id so reopening
   * a panel never refetches; a 404 clears only that entry and every other
   * error leaves it unknown. Provider bank detail is never copied into a
   * shared view: everything here stays in this owner-only inbox.
   */
  function ledgerKeyFor(activity: BankActivity): string | null {
    return activity.ledgerTransactionId;
  }

  async function ensureLedgerFor(activity: BankActivity) {
    if (
      ledgerByActivity[activity.id] !== undefined ||
      ledgerLoading[activity.id]
    ) {
      return;
    }
    const ledgerId = ledgerKeyFor(activity);
    if (!ledgerId) return;
    const generation = generationRef.current;
    const controller = track();
    setLedgerLoading((currentLoading) => ({
      ...currentLoading,
      [activity.id]: true,
    }));
    try {
      const transaction = await fetchTransaction(
        household.id,
        ledgerId,
        controller.signal,
      );
      if (!current(generation) || controller.signal.aborted) return;
      setLedgerByActivity((currentLedger) => ({
        ...currentLedger,
        [activity.id]: transaction,
      }));
      // Reconcile the open draft's ledger version without touching typed
      // fields, so a slow load never discards a choice made meanwhile.
      setResolveDraft((currentDraft) =>
        currentDraft?.activityId === activity.id &&
        currentDraft.expectedLedgerVersion === null
          ? { ...currentDraft, expectedLedgerVersion: transaction.version }
          : currentDraft,
      );
      setReplaceDraft((currentDraft) =>
        currentDraft?.activityId === activity.id &&
        currentDraft.expectedLedgerVersion === null
          ? { ...currentDraft, expectedLedgerVersion: transaction.version }
          : currentDraft,
      );
      if (
        transaction.kind === 'EXPENSE' &&
        transaction.status === 'POSTED' &&
        transaction.visibility === 'HOUSEHOLD' &&
        allocationByLedger[transaction.id] === undefined
      ) {
        try {
          const allocation = await fetchTransactionAllocation(
            household.id,
            transaction.id,
            controller.signal,
          );
          if (!current(generation) || controller.signal.aborted) return;
          setAllocationByLedger((currentAllocations) => ({
            ...currentAllocations,
            [transaction.id]: allocation,
          }));
        } catch (error) {
          if (!current(generation) || controller.signal.aborted) return;
          if (
            error instanceof ApiError &&
            (error.code === 'ALLOCATION_NOT_FOUND' ||
              error.code === 'TRANSACTION_NOT_FOUND')
          ) {
            setAllocationByLedger((currentAllocations) => ({
              ...currentAllocations,
              [transaction.id]: null,
            }));
          }
        }
      }
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      if (error instanceof ApiError) {
        if (handleAuthFailure(error, generation)) return;
        if (
          error.code === 'TRANSACTION_NOT_FOUND' ||
          error.code === 'HOUSEHOLD_NOT_FOUND'
        ) {
          setLedgerByActivity((currentLedger) => ({
            ...currentLedger,
            [activity.id]: null,
          }));
          return;
        }
      }
    } finally {
      ownedRef.current.delete(controller);
      if (current(generation)) {
        setLedgerLoading((currentLoading) => ({
          ...currentLoading,
          [activity.id]: false,
        }));
      }
    }
  }

  function openResolve(activity: BankActivity) {
    const ledger = ledgerByActivity[activity.id];
    const existing = resolveDraftsRef.current[activity.id];
    const draft =
      existing && existing.version === activity.version
        ? existing
        : resolveDraftFor(
            activity,
            ledger === undefined ? null : (ledger?.version ?? null),
          );
    resolveDraftsRef.current[activity.id] = draft;
    setResolveDraft(draft);
    setReplaceDraft((currentDraft) =>
      currentDraft?.activityId === activity.id ? null : currentDraft,
    );
    setNotice(null);
    void ensureLedgerFor(activity);
  }

  function updateResolveDraft(patch: Partial<ResolveDraft>) {
    setResolveDraft((currentDraft) => {
      if (!currentDraft) return currentDraft;
      const next = { ...currentDraft, ...patch };
      resolveDraftsRef.current[next.activityId] = next;
      return next;
    });
  }

  function openReplace(activity: BankActivity) {
    const ledger = ledgerByActivity[activity.id];
    const existing = replaceDraftsRef.current[activity.id];
    const draft =
      existing && existing.version === activity.version
        ? existing
        : replaceDraftFor(
            activity,
            ledger === undefined ? null : (ledger?.version ?? null),
          );
    replaceDraftsRef.current[activity.id] = draft;
    setReplaceDraft(draft);
    setResolveDraft((currentDraft) =>
      currentDraft?.activityId === activity.id ? null : currentDraft,
    );
    setReplaceRefundOptions(null);
    setNotice(null);
    void ensureLedgerFor(activity);
  }

  function updateReplaceDraft(patch: Partial<ReplaceDraft>) {
    setReplaceDraft((currentDraft) => {
      if (!currentDraft) return currentDraft;
      const next = { ...currentDraft, ...patch };
      replaceDraftsRef.current[next.activityId] = next;
      return next;
    });
  }

  async function loadReplaceRefundOptions(draft: ReplaceDraft) {
    const generation = generationRef.current;
    const controller = track();
    try {
      const transactions = await fetchTransactions(
        household.id,
        'OWN',
        controller.signal,
      );
      if (!current(generation) || controller.signal.aborted) return;
      setReplaceRefundOptions(
        transactions.items.filter(
          (transaction) =>
            transaction.source === 'CONNECTED' &&
            transaction.kind === 'EXPENSE' &&
            transaction.status === 'POSTED' &&
            transaction.accountId !== null &&
            transaction.accountId === draft.localAccountId &&
            transaction.money.currency === draft.currency,
        ),
      );
    } catch {
      if (!current(generation)) return;
      setReplaceRefundOptions([]);
    } finally {
      ownedRef.current.delete(controller);
    }
  }

  function resolveFieldsOf(draft: ResolveDraft): ResolveApplyField[] {
    const fields: ResolveApplyField[] = [];
    if (draft.applyMoney) fields.push('amount');
    if (draft.applyDate) fields.push('occurredOn');
    if (draft.applyDescription) fields.push('description');
    return fields;
  }

  /**
   * Stale-version refetch-and-review: the bank revision or the ledger moved
   * under the request, so refetch both, publish them into the page and the
   * open draft versions, and ask for review instead of resending blindly.
   * Typed draft fields are preserved; only versions converge.
   */
  async function refetchAfterConflict(activityId: string) {
    const generation = generationRef.current;
    const controller = track();
    try {
      const [freshActivity, ledgerId] = await (async () => {
        const fresh = await fetchBankActivityDetail(
          household.id,
          activityId,
          controller.signal,
        );
        return [fresh, fresh.ledgerTransactionId] as const;
      })();
      if (!current(generation) || controller.signal.aborted) return;
      setPage((currentPage) => {
        if (!currentPage) return currentPage;
        return {
          ...currentPage,
          items: currentPage.items.map((item) =>
            item.id === freshActivity.id ? freshActivity : item,
          ),
        };
      });
      const resolveOpen = resolveDraftsRef.current[activityId];
      if (resolveOpen) {
        const next = { ...resolveOpen, version: freshActivity.version };
        resolveDraftsRef.current[activityId] = next;
        setResolveDraft((currentDraft) =>
          currentDraft?.activityId === activityId ? next : currentDraft,
        );
      }
      const confirmOpen = draftsRef.current[activityId];
      if (confirmOpen) {
        const next = { ...confirmOpen, version: freshActivity.version };
        draftsRef.current[activityId] = next;
        draftEvidenceRef.current[activityId] = confirmEvidenceOf(freshActivity);
        setConfirmDraft((currentDraft) =>
          currentDraft?.activityId === activityId ? next : currentDraft,
        );
      }
      const replaceOpen = replaceDraftsRef.current[activityId];
      if (replaceOpen) {
        const next = { ...replaceOpen, version: freshActivity.version };
        replaceDraftsRef.current[activityId] = next;
        setReplaceDraft((currentDraft) =>
          currentDraft?.activityId === activityId ? next : currentDraft,
        );
      }
      if (ledgerId) {
        try {
          const freshLedger = await fetchTransaction(
            household.id,
            ledgerId,
            controller.signal,
          );
          if (!current(generation) || controller.signal.aborted) return;
          setLedgerByActivity((currentLedger) => ({
            ...currentLedger,
            [activityId]: freshLedger,
          }));
          setResolveDraft((currentDraft) =>
            currentDraft?.activityId === activityId
              ? { ...currentDraft, expectedLedgerVersion: freshLedger.version }
              : currentDraft,
          );
          setReplaceDraft((currentDraft) =>
            currentDraft?.activityId === activityId
              ? { ...currentDraft, expectedLedgerVersion: freshLedger.version }
              : currentDraft,
          );
          const resolveStored = resolveDraftsRef.current[activityId];
          if (resolveStored) {
            resolveDraftsRef.current[activityId] = {
              ...resolveStored,
              version: freshActivity.version,
              expectedLedgerVersion: freshLedger.version,
            };
          }
          const replaceStored = replaceDraftsRef.current[activityId];
          if (replaceStored) {
            replaceDraftsRef.current[activityId] = {
              ...replaceStored,
              version: freshActivity.version,
              expectedLedgerVersion: freshLedger.version,
            };
          }
        } catch {
          // The ledger read is best-effort here; the activity already
          // converged above and the next submit refetches versions.
        }
      }
      showNotice(
        'warning',
        'The bank or ledger changed while you were reviewing. The latest versions are loaded; review them before retrying.',
      );
    } catch (error) {
      if (!current(generation)) return;
      if (error instanceof ApiError) {
        if (handleAuthFailure(error, generation)) return;
      }
      showNotice(
        'warning',
        'The bank or ledger changed while you were reviewing. Refresh the inbox and review the latest before retrying.',
      );
    } finally {
      ownedRef.current.delete(controller);
    }
  }

  /**
   * Stale confirm/dismiss recovery: the observation version moved under the
   * request, so the current revision is refetched, the open draft keeps every
   * typed field for review, and only versions converge. The owner never
   * resends blind and never loses text to a conflict.
   */
  function staleDecisionRecovery(
    apiError: ApiError,
    activityId: string,
  ): boolean {
    if (apiError.code !== 'RESOURCE_VERSION_CONFLICT') return false;
    void refetchAfterConflict(activityId);
    return true;
  }

  function resolveFailureNotice(
    apiError: ApiError,
    activity: BankActivity,
  ): boolean {
    if (
      apiError.code === 'RESOURCE_VERSION_CONFLICT' ||
      apiError.code === 'RECONCILIATION_REQUIRED'
    ) {
      void refetchAfterConflict(activity.id);
      return true;
    }
    return false;
  }

  async function submitResolve(activity: BankActivity) {
    const draft = resolveDraft;
    if (!draft || draft.activityId !== activity.id) return;
    if (draft.expectedLedgerVersion === null) {
      showNotice(
        'warning',
        'The ledger entry is still loading. Wait a moment and retry.',
      );
      return;
    }
    if (
      draft.action === 'APPLY_BANK' &&
      activity.state === 'REMOVED' &&
      resolveFieldsOf(draft).length > 0
    ) {
      showNotice(
        'warning',
        'The bank removed this entry, so its revision cannot be applied. Keep the ledger or void it instead.',
      );
      return;
    }
    if (draft.action === 'APPLY_BANK' && resolveFieldsOf(draft).length === 0) {
      showNotice(
        'warning',
        'Choose at least one bank field to apply: amount, date, or description.',
      );
      return;
    }
    if (
      draft.action === 'APPLY_BANK' &&
      draft.applyDescription &&
      !activity.descriptionValid
    ) {
      showNotice(
        'warning',
        'The bank description cannot be used as ledger text. Uncheck the description or replace the entry with your own text instead.',
      );
      return;
    }
    const activeAllocation =
      ledgerByActivity[activity.id] !== undefined &&
      ledgerByActivity[activity.id] !== null
        ? allocationByLedger[ledgerByActivity[activity.id]?.id ?? '']
        : undefined;
    if (draft.action === 'APPLY_BANK' && draft.applyMoney && activeAllocation) {
      showNotice(
        'warning',
        'The amount is locked by the active allocation. Uncheck the amount, revoke the allocation in the ledger, or void/replace instead — nothing was sent and the ledger is unchanged.',
      );
      return;
    }
    const generation = generationRef.current;
    const controller = track();
    setDecisionBusy(true);
    try {
      const activeCsrf = await ensureCsrf(generation, controller.signal);
      if (!current(generation) || controller.signal.aborted) return;
      if (!activeCsrf) {
        onSessionExpired();
        return;
      }
      const body: ResolveBody = {
        expectedVersion: draft.version,
        expectedLedgerVersion: draft.expectedLedgerVersion,
        action: draft.action,
        fields:
          draft.action === 'APPLY_BANK' ? resolveFieldsOf(draft) : undefined,
      };
      const decision = await resolveBankActivity(
        household.id,
        draft.activityId,
        body,
        draft.idempotencyKey,
        activeCsrf,
        controller.signal,
      );
      if (!current(generation)) return;
      delete resolveDraftsRef.current[draft.activityId];
      setResolveDraft(null);
      applyDecision(decision);
      if (draft.action === 'VOID_LEDGER') {
        // A void deactivates allocations atomically; drop the cached active
        // allocation for the old ledger entry so the sibling feed converges.
        const ledgerId = ledgerByActivity[draft.activityId]?.id;
        if (ledgerId) {
          setAllocationByLedger((currentAllocations) => ({
            ...currentAllocations,
            [ledgerId]: null,
          }));
        }
      }
      // Every resolution bumps versions on one side or the other; drop the
      // cached ledger entry so a reopened review refetches versions instead
      // of reusing stale ones before the quiet refresh converges.
      setLedgerByActivity((currentLedger) => {
        if (!(draft.activityId in currentLedger)) return currentLedger;
        const next = { ...currentLedger };
        delete next[draft.activityId];
        return next;
      });
      showNotice(
        'info',
        draft.action === 'KEEP_LEDGER'
          ? 'Kept your ledger entry against this bank revision. It keeps contributing to household totals until the bank changes again.'
          : draft.action === 'APPLY_BANK'
            ? 'Applied the selected bank fields to your private ledger entry.'
            : 'Voided the ledger entry. Household totals and obligations no longer include it.',
      );
      onLedgerChanged?.();
      await refresh();
    } catch (error) {
      if (!current(generation)) return;
      if (error instanceof ApiError) {
        if (handleAuthFailure(error, generation)) return;
        if (resolveFailureNotice(error, activity)) return;
        showNotice(
          'error',
          error.message || 'That bank revision could not be resolved.',
          error.correlationId,
        );
        return;
      }
      showNotice('error', 'That bank revision could not be resolved.');
    } finally {
      ownedRef.current.delete(controller);
      if (!unmountedRef.current) setDecisionBusy(false);
    }
  }

  async function submitReplace(activity: BankActivity) {
    const draft = replaceDraft;
    if (!draft || draft.activityId !== activity.id) return;
    if (draft.expectedLedgerVersion === null) {
      showNotice(
        'warning',
        'The ledger entry is still loading. Wait a moment and retry.',
      );
      return;
    }
    if (draft.description.trim().length === 0) {
      showNotice('warning', 'Enter a description for the replacement entry.');
      return;
    }
    if (draft.kind === 'REFUND' && !draft.refundOfTransactionId) {
      showNotice('warning', 'Choose the connected expense being refunded.');
      return;
    }
    const ledger = ledgerByActivity[activity.id];
    const activeAllocation =
      ledger !== undefined && ledger !== null
        ? allocationByLedger[ledger.id]
        : undefined;
    if (activeAllocation && !draft.acknowledgeAllocationRemoval) {
      showNotice(
        'warning',
        'This replacement removes the recorded allocation and its obligations. Review the shares below and acknowledge the removal before replacing.',
      );
      return;
    }
    const generation = generationRef.current;
    const controller = track();
    setDecisionBusy(true);
    try {
      const activeCsrf = await ensureCsrf(generation, controller.signal);
      if (!current(generation) || controller.signal.aborted) return;
      if (!activeCsrf) {
        onSessionExpired();
        return;
      }
      const body: ReplaceBody = {
        expectedVersion: draft.version,
        expectedLedgerVersion: draft.expectedLedgerVersion,
        kind: draft.kind,
        description: draft.description,
        // A refund with no explicit category omits the field so the server
        // inherits the source expense's category (INHERIT); an explicit null
        // travels only for non-refunds, where it means uncategorized.
        category:
          draft.category.length === 0
            ? draft.kind === 'REFUND'
              ? undefined
              : null
            : draft.category,
        refundOfTransactionId:
          draft.kind === 'REFUND' ? draft.refundOfTransactionId : undefined,
        acknowledgeDisclosure: draft.acknowledgeDisclosure,
        acknowledgeAllocationRemoval: draft.acknowledgeAllocationRemoval,
      };
      const decision = await replaceBankActivityLedger(
        household.id,
        draft.activityId,
        body,
        draft.idempotencyKey,
        activeCsrf,
        controller.signal,
      );
      if (!current(generation)) return;
      delete replaceDraftsRef.current[draft.activityId];
      setReplaceDraft(null);
      // The replacement response carries the full new entry plus the
      // retained superseded identity; the inbox page converges on the
      // review, whose association already points at the replacement.
      applyDecision({
        activity: decision.activity,
        transactionId: decision.transaction.id,
        transactionVersion: decision.transaction.version,
      });
      // Replacement voids the old entry (deactivating its allocation) and
      // admits a new private one; never copy the allocation forward. The
      // cached ledger entry is invalidated alongside the allocation so a
      // reopened review refetches versions instead of reusing stale ones.
      const oldLedgerId = ledger?.id;
      if (oldLedgerId) {
        setAllocationByLedger((currentAllocations) => ({
          ...currentAllocations,
          [oldLedgerId]: null,
        }));
      }
      setLedgerByActivity((currentLedger) => {
        if (!(draft.activityId in currentLedger)) return currentLedger;
        const next = { ...currentLedger };
        delete next[draft.activityId];
        return next;
      });
      showNotice(
        'info',
        'Replaced the ledger entry. The replacement is private unless it is a linked refund inheriting disclosure; household totals use the new entry.',
      );
      onLedgerChanged?.();
      await refresh();
    } catch (error) {
      if (!current(generation)) return;
      if (error instanceof ApiError) {
        if (handleAuthFailure(error, generation)) return;
        if (resolveFailureNotice(error, activity)) return;
        showNotice(
          'error',
          error.message || 'That ledger entry could not be replaced.',
          error.correlationId,
        );
        return;
      }
      showNotice('error', 'That ledger entry could not be replaced.');
    } finally {
      ownedRef.current.delete(controller);
      if (!unmountedRef.current) setDecisionBusy(false);
    }
  }

  function closeReviewPanels(
    activityId?: string,
    panel?: 'resolve' | 'replace',
  ) {
    if (activityId) {
      // Restore focus to the trigger that opened the closing panel, so
      // keyboard users land back where they started instead of on removed
      // panel controls.
      const triggerId =
        panel === 'replace'
          ? `replace-trigger-${activityId}`
          : `review-trigger-${activityId}`;
      requestAnimationFrame(() => {
        if (unmountedRef.current) return;
        document.getElementById(triggerId)?.focus();
      });
    }
    setResolveDraft(null);
    setReplaceDraft(null);
  }

  useEffect(() => {
    // Direct focus to the outcome notice so success and error states are
    // announced without leaving focus on an unmounting panel control.
    if (notice) noticeRef.current?.focus();
  }, [notice]);

  useEffect(() => {
    if (confirmDraft) confirmHeadingRef.current?.focus();
  }, [confirmDraft]);

  useEffect(() => {
    if (resolveDraft) resolveHeadingRef.current?.focus();
  }, [resolveDraft]);

  useEffect(() => {
    if (replaceDraft) replaceHeadingRef.current?.focus();
  }, [replaceDraft]);

  useEffect(() => {
    if (Object.keys(cooldownUntil).length === 0) return;
    const timer = window.setInterval(() => setClockMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  const items = page?.items ?? [];
  const busy = loading || decisionBusy;
  const staleConnections = (connections ?? []).filter(
    (connection) =>
      connection.state === 'ACTIVE' &&
      isSyncStale(connection.lastSuccessfulSyncAt),
  );

  return (
    <section
      className="bank-activity"
      aria-labelledby={`bank-activity-${household.id}`}
    >
      <div className="finance-accounts-heading">
        <div>
          <p className="eyebrow">Private to you</p>
          <h4 tabIndex={-1} id={`bank-activity-${household.id}`}>
            Bank activity
          </h4>
        </div>
        <span className="privacy-chip">Owner-only inbox</span>
      </div>
      <p className="finance-helper">
        Bank activity stays private until you confirm it. Pending, removed, and
        invalid items never enter the ledger or household totals. A bank
        revision that changed after confirmation never edits the ledger on its
        own: the confirmed entry keeps contributing until you resolve the
        difference below.
      </p>

      {!authorityConfirmed && (
        <p role="status" className="household-stale">
          Refresh the household before reviewing bank activity.
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
        </div>
      )}

      <div className="bank-activity-toolbar">
        <label>
          Status
          <select
            value={stateFilter}
            onChange={(event) =>
              setStateFilter(event.target.value as 'ALL' | BankActivityState)
            }
          >
            {STATE_FILTERS.map((state) => (
              <option key={state} value={state}>
                {state === 'ALL' ? 'All statuses' : stateLabel(state)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Review
          <select
            value={reviewFilter}
            onChange={(event) =>
              setReviewFilter(
                event.target.value as 'ALL' | BankActivityReviewState,
              )
            }
          >
            {REVIEW_FILTERS.map((review) => (
              <option key={review} value={review}>
                {review === 'ALL' ? 'All reviews' : reviewLabel(review)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="household-button household-button--secondary"
          disabled={busy || !authorityConfirmed}
          onClick={() => void refresh()}
        >
          Refresh inbox
        </button>
      </div>

      {page && (
        <p className="bank-activity-counts" role="status">
          {page.unreviewedCount} awaiting review · {page.changedCount} bank
          revisions need attention
        </p>
      )}

      {(connections ?? []).length > 0 && (
        <div className="bank-activity-sync">
          <h5>Sync</h5>
          <ul aria-label="Connected bank sync controls">
            {(connections ?? []).map((connection) => {
              const cooling = (cooldownUntil[connection.id] ?? 0) > clockMs;
              const active = connection.state === 'ACTIVE';
              return (
                <li key={connection.id}>
                  <span>
                    {active
                      ? staleConnections.some(
                          (stale) => stale.id === connection.id,
                        )
                        ? 'Active · no successful sync in 24 hours'
                        : 'Active'
                      : connectionStateLabel(connection.state)}
                    {connection.lastSuccessfulSyncAt && (
                      <>
                        {' '}
                        · last success{' '}
                        <time dateTime={connection.lastSuccessfulSyncAt}>
                          {connection.lastSuccessfulSyncAt.slice(0, 10)}
                        </time>
                      </>
                    )}
                    {syncStateLabel(connection) && (
                      <span className="bank-sync-state" role="status">
                        {' '}
                        · {syncStateLabel(connection)}
                      </span>
                    )}
                    {!connection.historyReady && (
                      <span className="bank-sync-state">
                        {' '}
                        · history import incomplete
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    className="household-button household-button--secondary"
                    disabled={
                      !active ||
                      !authorityConfirmed ||
                      busy ||
                      syncBusy === connection.id ||
                      cooling
                    }
                    aria-label={`Sync bank connection ${connection.id}`}
                    onClick={() => void runSync(connection)}
                  >
                    {syncBusy === connection.id ? 'Requesting…' : 'Sync now'}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="finance-helper">
            Sync asks the bank for changes; it never adds anything to the
            ledger. At most one request per connection per minute.
          </p>
        </div>
      )}

      {loading && page === null && (
        <p role="status" aria-live="polite">
          Loading your bank activity…
        </p>
      )}

      {page !== null && items.length === 0 && (
        <p className="bank-activity-empty">
          No bank activity matches these filters yet.{' '}
          {staleConnections.length > 0
            ? 'A connection has not synced recently; request a sync above.'
            : ''}
        </p>
      )}

      {items.length > 0 && (
        <ul className="bank-activity-list" aria-label="Bank activity">
          {items.map((activity) => (
            <li key={activity.id} className="bank-activity-item">
              <div className="bank-activity-item-head">
                <p className="bank-activity-item-title">
                  {activity.money === null
                    ? 'Amount unavailable'
                    : formatMoney(
                        activity.money.amount,
                        activity.money.currency,
                      )}
                </p>
                <p className="bank-activity-badges">
                  <span className="bank-badge">
                    {stateLabel(activity.state)}
                  </span>
                  <span className="bank-badge">
                    {reviewLabel(activity.reviewState)}
                  </span>
                  {isNeedsReview(activity) && (
                    <span className="bank-badge bank-badge--review">
                      Needs review
                    </span>
                  )}
                </p>
              </div>
              <p className="bank-activity-meta">
                {activity.occurredOn ?? 'Date unavailable'}
                {activity.providerDescription
                  ? ` · ${activity.providerDescription}`
                  : ''}
              </p>
              {requiresOwnerDescription(activity) &&
                activity.reviewState === 'UNREVIEWED' &&
                activity.state === 'POSTED' && (
                  <p className="bank-activity-warning" role="status">
                    The bank description needs your own text before this can be
                    added.
                  </p>
                )}
              {activity.invalidReason && (
                <p className="bank-activity-warning">
                  Quarantined: {activity.invalidReason}. This item can only be
                  dismissed.
                </p>
              )}
              {changeLabel(activity) && (
                <p className="bank-activity-warning">{changeLabel(activity)}</p>
              )}
              {activity.pendingPredecessorId && (
                <p className="bank-activity-meta">
                  Linked from an earlier pending entry.
                </p>
              )}

              <div className="finance-account-actions">
                {isConfirmable(activity) && (
                  <button
                    type="button"
                    className="household-button"
                    disabled={busy || !authorityConfirmed}
                    aria-label={`Confirm bank activity ${activitySummary(activity)}`}
                    aria-expanded={confirmDraft?.activityId === activity.id}
                    onClick={() => openConfirm(activity)}
                  >
                    Confirm…
                  </button>
                )}
                {isDismissable(activity) && (
                  <button
                    type="button"
                    className="household-button household-button--secondary"
                    disabled={busy || !authorityConfirmed}
                    aria-label={`Dismiss bank activity ${activitySummary(activity)}`}
                    aria-expanded={dismissOpen === activity.id}
                    onClick={() => {
                      setDismissOpen(
                        dismissOpen === activity.id ? null : activity.id,
                      );
                      setDismissReason('ALREADY_RECORDED');
                    }}
                  >
                    Dismiss…
                  </button>
                )}
                {/*
                  Needs-review actions never depend on connection state: a
                  retained admitted entry may be resolved after disconnect,
                  and resolution never restarts sync or admits new history.
                */}
                {isNeedsReview(activity) && (
                  <button
                    type="button"
                    id={`review-trigger-${activity.id}`}
                    className="household-button"
                    disabled={busy || !authorityConfirmed}
                    aria-label={`Review bank revision ${activitySummary(activity)}`}
                    aria-expanded={resolveDraft?.activityId === activity.id}
                    onClick={() => openResolve(activity)}
                  >
                    Review…
                  </button>
                )}
                {isNeedsReview(activity) && activity.state === 'POSTED' && (
                  <button
                    type="button"
                    id={`replace-trigger-${activity.id}`}
                    className="household-button household-button--secondary"
                    disabled={busy || !authorityConfirmed}
                    aria-label={`Replace ledger entry for bank activity ${activitySummary(activity)}`}
                    aria-expanded={replaceDraft?.activityId === activity.id}
                    onClick={() => openReplace(activity)}
                  >
                    Replace…
                  </button>
                )}
              </div>

              {confirmDraft?.activityId === activity.id && (
                <div
                  className="bank-activity-form"
                  role="group"
                  aria-labelledby={`confirm-heading-${activity.id}`}
                >
                  <h5
                    ref={confirmHeadingRef}
                    tabIndex={-1}
                    id={`confirm-heading-${activity.id}`}
                  >
                    Add {activitySummary(activity)} to your ledger
                  </h5>
                  <label>
                    Entry type
                    <select
                      value={confirmDraft.kind}
                      onChange={(event) => {
                        const kind = event.target.value as ConfirmDraft['kind'];
                        updateDraft({ kind });
                        if (kind === 'REFUND') {
                          void loadRefundOptions({
                            ...confirmDraft,
                            kind,
                          });
                        }
                      }}
                    >
                      <option value="EXPENSE">Expense</option>
                      <option value="INCOME">Income</option>
                      <option value="TRANSFER">Transfer</option>
                      <option value="REFUND">Refund</option>
                    </select>
                  </label>
                  <label>
                    Description
                    <input
                      type="text"
                      maxLength={200}
                      value={confirmDraft.description}
                      placeholder={
                        activity.providerDescription ?? 'Enter a description'
                      }
                      onChange={(event) =>
                        updateDraft({ description: event.target.value })
                      }
                    />
                  </label>
                  {categories.length > 0 && (
                    <>
                      <label>
                        Category
                        <select
                          ref={confirmCategoryRef}
                          value={confirmDraft.category}
                          aria-invalid={Boolean(confirmCategoryError)}
                          aria-describedby={
                            confirmCategoryError
                              ? `confirm-category-error-${activity.id}`
                              : undefined
                          }
                          onChange={(event) =>
                            updateDraft({ category: event.target.value })
                          }
                        >
                          <option value="">Uncategorized</option>
                          {categories.map((category) => (
                            <option key={category.code} value={category.code}>
                              {category.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      {confirmCategoryError && (
                        <p
                          id={`confirm-category-error-${activity.id}`}
                          className="household-error"
                          role="alert"
                        >
                          {confirmCategoryError}
                        </p>
                      )}
                    </>
                  )}
                  {confirmDraft.kind === 'REFUND' && (
                    <>
                      <label>
                        Refunded expense
                        <select
                          value={confirmDraft.refundOfTransactionId}
                          onChange={(event) =>
                            updateDraft({
                              refundOfTransactionId: event.target.value,
                            })
                          }
                        >
                          <option value="">Choose a connected expense…</option>
                          {(refundOptions ?? []).map((option) => (
                            <option key={option.id} value={option.id}>
                              {formatMoney(
                                option.money.amount,
                                option.money.currency,
                              )}{' '}
                              · {option.description} · {option.occurredOn}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="bank-activity-checkbox">
                        <input
                          type="checkbox"
                          checked={confirmDraft.acknowledgeDisclosure}
                          onChange={(event) =>
                            updateDraft({
                              acknowledgeDisclosure: event.target.checked,
                            })
                          }
                        />
                        Share this refund with the household (required when the
                        expense is shared)
                      </label>
                      {refundOptions !== null && refundOptions.length === 0 && (
                        <p className="bank-activity-warning">
                          No connected posted expense matches this account and
                          currency yet.
                        </p>
                      )}
                    </>
                  )}
                  <div className="finance-account-actions">
                    <button
                      type="button"
                      className="household-button"
                      disabled={decisionBusy}
                      onClick={() => void submitConfirm()}
                    >
                      {decisionBusy ? 'Adding…' : 'Add to ledger'}
                    </button>
                    <button
                      type="button"
                      className="household-button household-button--secondary"
                      disabled={decisionBusy}
                      onClick={closeConfirm}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {resolveDraft?.activityId === activity.id && (
                <ResolvePanel
                  activity={activity}
                  draft={resolveDraft}
                  ledger={ledgerByActivity[activity.id]}
                  ledgerLoading={ledgerLoading[activity.id] === true}
                  activeAllocation={
                    ledgerByActivity[activity.id] === undefined ||
                    ledgerByActivity[activity.id] === null ||
                    ledgerByActivity[activity.id]?.id === undefined
                      ? undefined
                      : allocationByLedger[
                          ledgerByActivity[activity.id]?.id as string
                        ]
                  }
                  decisionBusy={decisionBusy}
                  ref={resolveHeadingRef}
                  onPatch={(patch) => updateResolveDraft(patch)}
                  onSubmit={(item) => void submitResolve(item)}
                  onCancel={(activityId) =>
                    closeReviewPanels(activityId, 'resolve')
                  }
                />
              )}

              {replaceDraft?.activityId === activity.id && (
                <ReplacePanel
                  activity={activity}
                  draft={replaceDraft}
                  ledgerLoading={ledgerLoading[activity.id] === true}
                  ledgerGone={ledgerByActivity[activity.id] === null}
                  activeAllocation={
                    ledgerByActivity[activity.id] === undefined ||
                    ledgerByActivity[activity.id] === null ||
                    ledgerByActivity[activity.id]?.id === undefined
                      ? undefined
                      : allocationByLedger[
                          ledgerByActivity[activity.id]?.id as string
                        ]
                  }
                  categories={categories}
                  refundOptions={replaceRefundOptions}
                  decisionBusy={decisionBusy}
                  ref={replaceHeadingRef}
                  onPatch={(patch) => updateReplaceDraft(patch)}
                  onKindChange={(kind, draft) => {
                    updateReplaceDraft({ kind });
                    if (kind === 'REFUND') {
                      void loadReplaceRefundOptions({ ...draft, kind });
                    }
                  }}
                  onSubmit={(item) => void submitReplace(item)}
                  onCancel={(activityId) =>
                    closeReviewPanels(activityId, 'replace')
                  }
                />
              )}

              {dismissOpen === activity.id && (
                <div
                  className="bank-activity-form"
                  role="group"
                  aria-label={`Dismiss ${activitySummary(activity)}`}
                >
                  <label>
                    Reason
                    <select
                      value={dismissReason}
                      onChange={(event) =>
                        setDismissReason(
                          event.target.value as BankActivityDismissReason,
                        )
                      }
                    >
                      {DISMISS_REASONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="finance-helper">
                    Dismissing keeps the item as evidence and never touches the
                    ledger.
                  </p>
                  <div className="finance-account-actions">
                    <button
                      type="button"
                      className="household-button"
                      disabled={decisionBusy}
                      onClick={() => void submitDismiss(activity)}
                    >
                      {decisionBusy ? 'Dismissing…' : 'Dismiss item'}
                    </button>
                    <button
                      type="button"
                      className="household-button household-button--secondary"
                      disabled={decisionBusy}
                      onClick={() => setDismissOpen(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {page !== null && page.hasMore && (
        <div className="bank-activity-more">
          <button
            type="button"
            className="household-button household-button--secondary"
            disabled={busy || loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? 'Loading more…' : 'Load more activity'}
          </button>
        </div>
      )}
    </section>
  );
}
