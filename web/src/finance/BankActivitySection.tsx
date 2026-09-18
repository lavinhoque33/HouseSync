import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  confirmBankActivity,
  dismissBankActivity,
  fetchBankActivity,
  fetchCsrf,
  fetchFinancialConnections,
  fetchTransactionCategories,
  fetchTransactions,
  postConnectionSync,
  type BankActivity,
  type BankActivityDecision,
  type BankActivityDismissReason,
  type BankActivityPage,
  type BankActivityReviewState,
  type BankActivityState,
  type CsrfToken,
  type FinancialConnection,
  type Household,
  type Transaction,
  type TransactionCategory,
} from '../auth/client';
import { draftFor, type ConfirmDraft } from './bank-activity';
import {
  isConfirmable,
  isDismissable,
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
    return 'The bank revised this after you added it. The ledger entry is unchanged; review it in a later step.';
  }
  if (activity.changeState === 'REMOVED') {
    return 'The bank removed this after you added it. The ledger entry is unchanged; review it in a later step.';
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
  const [refundOptions, setRefundOptions] = useState<Transaction[] | null>(
    null,
  );
  const [dismissOpen, setDismissOpen] = useState<string | null>(null);
  const [dismissReason, setDismissReason] =
    useState<BankActivityDismissReason>('ALREADY_RECORDED');
  const [decisionBusy, setDecisionBusy] = useState(false);
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
  const noticeRef = useRef<HTMLDivElement>(null);
  const confirmHeadingRef = useRef<HTMLHeadingElement>(null);
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
    const draft =
      existing && existing.version === activity.version
        ? existing
        : draftFor(activity);
    draftsRef.current[activity.id] = draft;
    setConfirmDraft(draft);
    setRefundOptions(null);
    setNotice(null);
  }

  function updateDraft(patch: Partial<ConfirmDraft>) {
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

  useEffect(() => {
    if (confirmDraft) confirmHeadingRef.current?.focus();
  }, [confirmDraft]);

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
        invalid items never enter the ledger or household totals. Reviewing a
        bank revision that changed after confirmation is a later step; nothing
        is changed automatically.
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
                    <label>
                      Category
                      <select
                        value={confirmDraft.category}
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
                      onClick={() => setConfirmDraft(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
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
