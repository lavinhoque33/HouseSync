import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  ApiError,
  fetchCategorizationAiWorkStatus,
  fetchCategorizationReview,
  fetchCategorizationReviews,
  fetchCsrf,
  resolveCategorizationReview,
  type CategorizationAiWorkStatus,
  type CategorizationReview,
  type CategorizationReviewAction,
  type CategorizationReviewConfidence,
  type CategorizationReviewPage,
  type CategorizationReviewSource,
  type CategorizationReviewStatus,
  type CategorizationReviewView,
  type CsrfToken,
  type Household,
  type ResolveCategorizationReviewInput,
  type Transaction,
  type TransactionCategory,
} from '../auth/client';
import { categoryLabel } from './categories';
import { formatMoney } from './money';

interface Notice {
  kind: 'info' | 'error' | 'warning';
  text: string;
  correlationId?: string | undefined;
  showReload?: boolean | undefined;
}

/**
 * One explicit resolution intent: the durable idempotency key and the exact
 * request body are retained together while the outcome is unknown, so an
 * explicit retry can never apply a second decision under a fresh key and a
 * same-key replay can never reapply an edited payload.
 */
interface PendingResolve {
  key: string;
  reviewId: string;
  description: string;
  input: ResolveCategorizationReviewInput;
}

/** The controls a refused or incomplete decision moves focus to. */
type ReviewFocusTarget = 'category' | 'actions' | 'pending' | 'detail';

interface CategorizationReviewsSectionProps {
  household: Household;
  csrf: CsrfToken | null;
  onCsrfRefreshed: (token: CsrfToken) => void;
  onSessionExpired: () => void;
  onHouseholdAccessChanged: () => void;
  authorityConfirmed: boolean;
  /**
   * The taxonomy already loaded by the parent. Server-returned labels are the
   * only user-visible category names, so an unavailable list disables the
   * category choice rather than exposing a raw enum token.
   */
  categories: TransactionCategory[] | null;
  /**
   * Bumped by the parent whenever something that can create, supersede, or
   * resolve a suggestion committed elsewhere in the section: a category
   * correction, a void, or a confirmed connected admission. The queue and its
   * open detail converge on the committed server state without remounting.
   */
  refreshSignal: number;
  /**
   * Bumped by the parent whenever the whole section's scope is cleared —
   * sign-out, confirmed session expiry, household switch, or access loss.
   * The retained queue, the open detail, the resolution draft, and every
   * in-flight request are dropped with it, so no private suggestion survives
   * a scope change and no late response can publish into the new scope.
   */
  scopeResetSignal: number;
  /**
   * Reports a transaction representation committed by a resolution (or
   * converged from the server afterwards) so the parent feed and the open
   * detail panel show the effective category without reloading the page.
   */
  onTransactionChanged: (transaction: Transaction) => void;
}

/** The documented page bound; the queue is a bounded, newest-first page. */
const REVIEW_PAGE_LIMIT = 50;

/**
 * The bounded wait between private AI work status reads while work is
 * pending. One timer exists at a time, it is cleared on every scope change
 * and unmount, and the read it starts is aborted with the same scope, so
 * settled work is noticed promptly without a busy loop or an orphaned
 * request. Nothing is polled while the capability is disabled.
 */
const AI_STATUS_POLL_MS = 5_000;

/**
 * Calm labels for the two suggestion sources. The source is safe display
 * text; the model identity, policy version, evidence digest, merchant key,
 * and provider codes never exist in this projection.
 *
 * The heuristic explanation states only what the delivered classifier does:
 * an exact match against a fixed built-in merchant list over the entry's
 * text (policy `exact-merchant-v1`). It is deliberately not described
 * as learning from the owner's decisions (that is a rule, a separate
 * mechanism) or from bank category data (that is the provider mapping, which
 * auto-assigns rather than suggesting).
 */
const SOURCE_LABELS: Record<CategorizationReviewSource, string> = {
  HEURISTIC: 'Built-in merchant match',
  AI: 'AI suggestion',
};

const SOURCE_EXPLANATIONS: Record<CategorizationReviewSource, string> = {
  HEURISTIC:
    'Matched by HouseSync against a fixed built-in list of recognized merchants, using this entry’s description text. It is a suggestion only.',
  AI: 'Produced by an optional AI model from a normalized description, the entry type, and this entry’s normalized bank category when the bank supplied one. No amount, date, account, or household detail is sent. It is a suggestion only.',
};

/**
 * The three documented bands. A band says how the suggestion was produced,
 * never how likely it is to be right: no percentage, no certainty, and no
 * automatic effect on the entry.
 */
const CONFIDENCE_LABELS: Record<CategorizationReviewConfidence, string> = {
  HIGH: 'High confidence band',
  MEDIUM: 'Medium confidence band',
  LOW: 'Low confidence band',
};

const CONFIDENCE_NOTE =
  'A confidence band describes how the suggestion was produced. It is not certainty and never changes an entry by itself.';

/** How a resolved suggestion ended. `OPEN` items never render this. */
const RESOLUTION_LABELS: Record<
  Exclude<CategorizationReviewStatus, 'OPEN'>,
  string
> = {
  ACCEPTED: 'Accepted as suggested',
  CHOSEN: 'Resolved with a category you chose',
  KEPT: 'You kept your own decision for this entry',
  SUPERSEDED: 'No longer needed — your own change replaced it',
};

const KIND_TEXT: Record<Transaction['kind'], string> = {
  EXPENSE: 'Expense',
  INCOME: 'Income',
  REFUND: 'Refund',
  TRANSFER: 'Transfer',
};

const EMPTY_STATE_TEXT: Record<CategorizationReviewView, string> = {
  OPEN: 'No suggestions are waiting for you. HouseSync asks only when a suggestion needs your decision.',
  HISTORY:
    'No resolved suggestions yet. Every decision you make here stays listed as history.',
};

/**
 * Owner-private review queue for the current actor. Every route
 * behind it is scoped to this household and this financial owner: another
 * member's suggestions are never listed, probed, or counted, and the section
 * renders for every member because each one reviews only their own backlog.
 *
 * Suggestions are advisory. The recorded category is the fact, the suggestion
 * is a proposal, and only one of the four explicit actions changes anything:
 * accepting it, choosing another category, keeping the recorded category, or
 * keeping the entry uncategorized. Resolution is version-guarded on both the
 * review and the evaluated transaction, so a stale queue refetches and asks
 * for a fresh decision instead of overwriting newer evidence; an unknown
 * outcome retains the exact same-key intent for an explicit retry.
 */
export function CategorizationReviewsSection({
  household,
  csrf,
  onCsrfRefreshed,
  onSessionExpired,
  onHouseholdAccessChanged,
  authorityConfirmed,
  categories,
  refreshSignal,
  scopeResetSignal,
  onTransactionChanged,
}: CategorizationReviewsSectionProps) {
  const [page, setPage] = useState<CategorizationReviewPage | null>(null);
  const [view, setView] = useState<CategorizationReviewView>('OPEN');
  const [queueOpen, setQueueOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  /**
   * The owner-private AI work counters, or null while they are not
   * loaded. The status is supplementary: a failed or unavailable read leaves
   * this null (or keeps the last known value) and never touches the queue.
   */
  const [aiStatus, setAiStatus] = useState<CategorizationAiWorkStatus | null>(
    null,
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  /**
   * The suggestion whose detail is open. It is held separately from the page
   * so a reload, a filter change, or a resolution never loses the detail the
   * owner is reading, and so a converged refetch can update it in place.
   */
  const [openReview, setOpenReview] = useState<CategorizationReview | null>(
    null,
  );
  const [draftAction, setDraftAction] =
    useState<CategorizationReviewAction>('ACCEPT_SUGGESTION');
  /** Synchronous mirror of the selected action for refetch continuations. */
  const draftActionRef =
    useRef<CategorizationReviewAction>('ACCEPT_SUGGESTION');
  const [draftCategory, setDraftCategory] = useState('');
  const [draftError, setDraftError] = useState<string | undefined>(undefined);
  const [pendingResolve, setPendingResolve] = useState<PendingResolve | null>(
    null,
  );
  const [resolving, setResolving] = useState(false);
  /**
   * The control that must take focus once the state that reveals it has been
   * committed. A counter drives the effect below, so focus never depends on
   * the timing of a request against a commit.
   */
  const [focusSignal, setFocusSignal] = useState(0);
  const focusTargetRef = useRef<ReviewFocusTarget | null>(null);

  const csrfRef = useRef(csrf);
  const genRef = useRef(0);
  const unmountedRef = useRef(false);
  const ownedRef = useRef<Set<AbortController>>(new Set());
  const resolvingRef = useRef(false);
  const moreSeqRef = useRef(0);
  /**
   * Synchronous mirrors of the two values an async continuation must read
   * exactly: state updates are not visible to a closure created in an earlier
   * render, so a reload that races a refetch would otherwise compare against
   * the wrong representation and could downgrade a fresh item.
   */
  const openReviewRef = useRef<CategorizationReview | null>(null);
  const pendingResolveRef = useRef<PendingResolve | null>(null);
  /** Synchronous mirror of the published AI status for the poll comparison. */
  const aiStatusRef = useRef<CategorizationAiWorkStatus | null>(null);
  /**
   * The AI status scope generation. It moves only when the whole panel scope
   * is cleared (sign-out, confirmed session expiry, household switch, access
   * loss) or the instance unmounts — never when the C queue reloads. A view
   * switch, a manual reload, or a sibling refresh bumps the queue generation,
   * and the pending poll must survive all of them.
   */
  const aiScopeRef = useRef(0);
  /** The newest status read; an older overlapping read never publishes. */
  const aiReadRef = useRef(0);
  /** Synchronous mirror of the shown view for timer-driven convergence. */
  const viewRef = useRef<CategorizationReviewView>('OPEN');
  const noticeRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLFieldSetElement>(null);
  const categoryRef = useRef<HTMLSelectElement>(null);
  const pendingRef = useRef<HTMLDivElement>(null);
  /**
   * The view and signal pair the mounted instance has already served, so the
   * initial load is never repeated by the change effect below.
   */
  const servedRef = useRef<{
    view: CategorizationReviewView;
    signal: number;
  } | null>(null);
  /** The scope reset the mounted instance has already observed. */
  const servedScopeRef = useRef(scopeResetSignal);

  useEffect(() => {
    csrfRef.current = csrf;
  }, [csrf]);

  function isCurrent(generation: number): boolean {
    return !unmountedRef.current && genRef.current === generation;
  }

  /**
   * The AI status counterpart of `isCurrent`: a status read and the pending
   * poll answer only to the AI scope generation, so a C queue reload can
   * neither strand the poll nor discard a status read that is still in
   * flight.
   */
  function isAiCurrent(generation: number): boolean {
    return !unmountedRef.current && aiScopeRef.current === generation;
  }

  /** Sets the selected decision and its synchronous mirror together. */
  function showDraftAction(action: CategorizationReviewAction) {
    draftActionRef.current = action;
    setDraftAction(action);
  }

  /** Asks the focus effect above to move focus once the commit lands. */
  function requestFocus(target: ReviewFocusTarget) {
    focusTargetRef.current = target;
    setFocusSignal((value) => value + 1);
  }

  /** Sets the open detail and its synchronous mirror together. */
  function showReview(review: CategorizationReview | null) {
    openReviewRef.current = review;
    setOpenReview(review);
  }

  /** Sets the retained intent and its synchronous mirror together. */
  function retainResolve(pending: PendingResolve | null) {
    pendingResolveRef.current = pending;
    setPendingResolve(pending);
  }

  function track(controller: AbortController) {
    ownedRef.current.add(controller);
  }

  function untrack(controller: AbortController) {
    ownedRef.current.delete(controller);
  }

  /**
   * Drops every private suggestion value and invalidates in-flight
   * continuations: the retained page, the open detail, the resolution draft,
   * the retained same-key intent, the private AI work counters, and the
   * mutation gate all return to their initial state. Nothing is loading
   * afterwards, so the panel never claims a request that no longer exists.
   */
  function clearScopedState() {
    genRef.current += 1;
    aiScopeRef.current += 1;
    moreSeqRef.current += 1;
    resolvingRef.current = false;
    // A focus request that belonged to the cleared scope is dropped with it.
    focusTargetRef.current = null;
    for (const owned of ownedRef.current) owned.abort();
    setPage(null);
    setView('OPEN');
    viewRef.current = 'OPEN';
    setQueueOpen(false);
    setLoading(false);
    setLoadingMore(false);
    aiStatusRef.current = null;
    setAiStatus(null);
    setNotice(null);
    showReview(null);
    showDraftAction('ACCEPT_SUGGESTION');
    setDraftCategory('');
    setDraftError(undefined);
    retainResolve(null);
    setResolving(false);
  }

  function handleSessionLost() {
    clearScopedState();
    onSessionExpired();
  }

  function handleAccessLost() {
    clearScopedState();
    onHouseholdAccessChanged();
  }

  /**
   * Maps the shared scope failures every private route can raise. Returns
   * true when the error was a scope loss and must not be rendered as a
   * queue-level failure.
   */
  function mapScopeErrors(apiError: ApiError): boolean {
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

  /**
   * Keeps the owner's resolution draft exactly as it was left. A refreshed
   * suggestion can make a preserved decision inapplicable — the recorded
   * category may have become null, or non-null, since the choice was made —
   * and that is reported as a validation message the owner answers with an
   * explicit new choice. The action is never silently rewritten into a
   * different decision, and the chosen category always survives.
   */
  function reconcileDraft(review: CategorizationReview) {
    const action = draftActionRef.current;
    const recorded = review.transaction.category;
    if (action === 'KEEP_CURRENT' && recorded === null) {
      setDraftError(
        'The recorded category changed while this suggestion was refreshed: this entry has no category to keep now. Choose the decision you want — nothing is saved until you do.',
      );
      return;
    }
    if (action === 'KEEP_UNCATEGORIZED' && recorded !== null) {
      setDraftError(
        'The recorded category changed while this suggestion was refreshed: this entry now has a category, so it cannot be kept uncategorized. Choose the decision you want — nothing is saved until you do.',
      );
      return;
    }
    setDraftError(undefined);
  }

  function openDetail(review: CategorizationReview) {
    const previous = openReviewRef.current;
    showReview(review);
    if (previous === null || previous.id !== review.id) {
      // A different suggestion starts from the primary action; the draft of
      // the suggestion that was open is not carried over.
      showDraftAction('ACCEPT_SUGGESTION');
      setDraftCategory('');
    }
    reconcileDraft(review);
    // The detail takes focus when the owner opens it, never when a background
    // refetch replaces it: a resolution or a convergence keeps focus on the
    // notice that reports what happened. Focus is requested through the
    // commit-safe effect, so a pending frame from opening can never pull
    // focus away from a control that later explains a rejected decision.
    requestFocus('detail');
  }

  function closeDetail(reviewId: string) {
    showReview(null);
    setDraftCategory('');
    setDraftError(undefined);
    // Cancel is the initiating control's dismissal: focus returns to the
    // re-created trigger. Programmatic closes (success, conflict) let the
    // outcome notice take focus instead.
    requestAnimationFrame(() => {
      if (unmountedRef.current) return;
      document.getElementById(`review-open-${reviewId}`)?.focus();
    });
  }

  function handleDetailKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    const review = openReview;
    if (review) closeDetail(review.id);
  }

  /**
   * Applies one committed resolution to the visible page. An accepted
   * decision leaves the waiting list and lowers the open count; the
   * authoritative reload below then confirms the real count.
   */
  function applyResolvedReview(
    resolved: CategorizationReview,
    currentView: CategorizationReviewView,
  ) {
    setPage((current) => {
      if (current === null) return current;
      if (currentView === 'HISTORY') {
        return {
          ...current,
          items: [
            resolved,
            ...current.items.filter((item) => item.id !== resolved.id),
          ],
          openCount: Math.max(0, current.openCount - 1),
        };
      }
      return {
        ...current,
        items: current.items.filter((item) => item.id !== resolved.id),
        openCount: Math.max(0, current.openCount - 1),
      };
    });
  }

  function dropReview(reviewId: string) {
    setPage((current) =>
      current === null
        ? current
        : {
            ...current,
            items: current.items.filter((item) => item.id !== reviewId),
            openCount: Math.max(0, current.openCount - 1),
          },
    );
  }

  /**
   * Converges the open detail with the server after a queue reload: a
   * suggestion that is still listed is refreshed in place, and one that left
   * the waiting list — resolved on another device, superseded by a direct
   * correction, or voided with its entry — is refetched so the panel shows
   * its true state instead of a stale decision form.
   */
  function reconcileOpenReview(items: CategorizationReview[]) {
    const current = openReviewRef.current;
    if (!current || current.status !== 'OPEN') return;
    // While an outcome is unknown the pending panel owns reconciliation, so a
    // reload never races it with a second read of the same item.
    if (pendingResolveRef.current !== null) return;
    const listed = items.find((item) => item.id === current.id);
    if (listed) {
      // The reloaded page and a single-item refetch can race: a review item's
      // integer version only moves forward, so the newer representation wins
      // and a reload never downgrades what a conflict refetch just learned.
      if (listed.version >= current.version) {
        showReview(listed);
        reconcileDraft(listed);
      }
      return;
    }
    void refreshOpenReview(current.id);
  }

  /**
   * Refetches exactly one review item. Used when the item left the waiting
   * page and after a both-version conflict, so the panel is rebuilt from the
   * server's current representation rather than from a rejected one.
   */
  async function refreshOpenReview(reviewId: string) {
    const generation = genRef.current;
    const controller = new AbortController();
    track(controller);
    try {
      const review = await fetchCategorizationReview(
        household.id,
        reviewId,
        controller.signal,
      );
      if (!isCurrent(generation) || controller.signal.aborted) return;
      if (review.status === 'OPEN') {
        showReview(review);
        reconcileDraft(review);
        return;
      }
      // The suggestion was resolved while this panel was open. There is
      // nothing left to decide, and who resolved it is not knowable here, so
      // the form closes with only what the server reports.
      dropReview(review.id);
      showReview(null);
      setNotice({
        kind: 'warning',
        text: 'This suggestion is no longer waiting for review, so the decision form was closed. It now appears under resolved suggestions.',
      });
    } catch (error) {
      if (!isCurrent(generation) || controller.signal.aborted) return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not reach the server.',
            });
      if (mapScopeErrors(apiError)) return;
      // Either the review-specific code or the shared privacy-preserving
      // transaction 404: both mean this owner cannot see the suggestion any
      // more, so it is treated identically and never probed further.
      if (apiError.status === 404) {
        showReview(null);
        dropReview(reviewId);
        setNotice({
          kind: 'warning',
          text: 'That suggestion is no longer available to you. The queue was reloaded.',
          correlationId: apiError.correlationId,
          showReload: true,
        });
      }
    } finally {
      untrack(controller);
    }
  }

  async function loadPage(
    generation: number,
    controller: AbortController,
    offset: number,
    append: boolean,
    requestedView: CategorizationReviewView,
    preserveNotice: boolean,
  ) {
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
      // A recovery reload keeps the notice that explains why it is happening;
      // a manual refresh clears notices instead.
      if (!preserveNotice) setNotice(null);
    }
    try {
      const loaded = await fetchCategorizationReviews(
        household.id,
        { limit: REVIEW_PAGE_LIMIT, offset, view: requestedView },
        controller.signal,
      );
      if (!isCurrent(generation) || controller.signal.aborted) return;
      setPage((current) => {
        if (!append || current === null) return loaded;
        // Offset paging can repeat an item that moved between requests; a
        // suggestion's identity is its id, so it is never listed twice.
        const seen = new Set(current.items.map((item) => item.id));
        return {
          ...loaded,
          items: [
            ...current.items,
            ...loaded.items.filter((item) => !seen.has(item.id)),
          ],
        };
      });
      setLoading(false);
      setLoadingMore(false);
      if (!append) reconcileOpenReview(loaded.items);
    } catch (error) {
      if (!isCurrent(generation) || controller.signal.aborted) return;
      setLoading(false);
      setLoadingMore(false);
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not reach the server.',
            });
      if (mapScopeErrors(apiError)) return;
      setNotice({
        kind: 'error',
        text: apiError.timedOut
          ? 'Loading your category suggestions timed out. Reload to try again.'
          : apiError.message || 'Could not load your category suggestions.',
        correlationId: apiError.correlationId,
        showReload: true,
      });
    }
  }

  function startLoad(
    requestedView: CategorizationReviewView,
    preserveNotice = false,
  ) {
    const generation = ++genRef.current;
    const controller = new AbortController();
    track(controller);
    void loadPage(
      generation,
      controller,
      0,
      false,
      requestedView,
      preserveNotice,
    ).finally(() => untrack(controller));
  }

  /**
   * Publishes one AI work status. A pending backlog that just emptied means
   * asynchronous work settled, so the owner's own waiting page and its
   * authoritative open count converge through the same background reload a
   * sibling commit uses: the retained resolution draft, a retained
   * unknown-outcome intent, and the open detail keep their existing
   * reconciliation rules and are never clobbered by this convergence.
   */
  function publishAiStatus(status: CategorizationAiWorkStatus) {
    const previous = aiStatusRef.current;
    aiStatusRef.current = status;
    setAiStatus(status);
    if (
      previous !== null &&
      previous.pendingCount > 0 &&
      status.pendingCount === 0
    ) {
      startLoad(viewRef.current, true);
    }
  }

  /**
   * Reads the private AI work status once. A scope loss clears the panel as
   * usual; every other failure is deliberately silent, because supplementary
   * progress the owner did not ask for must never become a queue-level error.
   * The last known status is kept instead of being replaced by a guess.
   *
   * The read answers only to the AI scope generation and to being the newest
   * read, so a C queue reload that commits while it is in flight cannot
   * discard a status the owner is waiting on, and an older overlapping read
   * cannot overwrite a newer one.
   */
  async function loadAiStatus(generation: number, controller: AbortController) {
    const read = ++aiReadRef.current;
    try {
      const status = await fetchCategorizationAiWorkStatus(
        household.id,
        controller.signal,
      );
      if (
        !isAiCurrent(generation) ||
        controller.signal.aborted ||
        read !== aiReadRef.current
      ) {
        return;
      }
      publishAiStatus(status);
    } catch (error) {
      if (!isAiCurrent(generation) || controller.signal.aborted) return;
      // A newer read already answered for this scope: its outcome owns the
      // panel, and a stale 401/404 must never clear what the owner just saw.
      if (read !== aiReadRef.current) return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not reach the server.',
            });
      mapScopeErrors(apiError);
    }
  }

  function startAiStatusLoad() {
    const generation = aiScopeRef.current;
    const controller = new AbortController();
    track(controller);
    void loadAiStatus(generation, controller).finally(() =>
      untrack(controller),
    );
  }

  useEffect(() => {
    unmountedRef.current = false;
    startLoad('OPEN');
    startAiStatusLoad();
    const owned = ownedRef.current;
    return () => {
      unmountedRef.current = true;
      genRef.current += 1;
      aiScopeRef.current += 1;
      for (const tracked of owned) tracked.abort();
    };
    // Household identity is fixed for this keyed component instance; the view
    // and the refresh signal are served by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A view change or a sibling commit (category correction, void, or
  // connected admission) reloads the first page with the authoritative open
  // count. The retained resolution draft is untouched: a background refresh
  // never discards a choice the owner already made.
  useEffect(() => {
    if (servedRef.current === null) {
      servedRef.current = { view, signal: refreshSignal };
      return;
    }
    if (
      servedRef.current.view === view &&
      servedRef.current.signal === refreshSignal
    ) {
      return;
    }
    const signalChanged = servedRef.current.signal !== refreshSignal;
    servedRef.current = { view, signal: refreshSignal };
    startLoad(view, true);
    // A committed sibling change can also start new asynchronous work (an
    // uncategorized admission with no deterministic match), so the private AI
    // counters are re-read with the queue. A plain view switch does not.
    if (signalChanged) startAiStatusLoad();
    // The view and signal alone drive this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, refreshSignal]);

  // The shown view, mirrored synchronously for the timer-driven convergence
  // below: a poll cycle that settles work must reload the view the owner is
  // actually looking at, not the one captured when the timer was armed.
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const aiPending =
    aiStatus !== null && aiStatus.enabled && aiStatus.pendingCount > 0;

  // While AI work is pending, one bounded timer re-reads the private status;
  // the timer is cleared and its in-flight read aborted on every scope change
  // and unmount, and every cycle is checked against the AI scope generation
  // that started it — a C queue reload (view switch, manual reload, sibling
  // refresh) never stops the poll. Nothing is polled while the capability is
  // disabled, while its status is unknown, or once no work is pending: a
  // deployment without AI costs exactly the reads the owner's own actions ask
  // for. A transient status failure keeps the last known counters and the
  // next cycle retries.
  useEffect(() => {
    if (!aiPending) return;
    const generation = aiScopeRef.current;
    const controller = new AbortController();
    track(controller);
    let stopped = false;
    let timer: number | null = null;
    const cycle = async () => {
      if (stopped || !isAiCurrent(generation)) return;
      const read = ++aiReadRef.current;
      try {
        const status = await fetchCategorizationAiWorkStatus(
          household.id,
          controller.signal,
        );
        if (stopped || !isAiCurrent(generation) || controller.signal.aborted) {
          return;
        }
        // A newer read (a manual reload, a sibling refresh) already answered
        // for this scope; the poll keeps its own schedule either way.
        if (read === aiReadRef.current) publishAiStatus(status);
      } catch (error) {
        if (stopped || !isAiCurrent(generation) || controller.signal.aborted) {
          return;
        }
        // A newer read already answered for this scope, so a stale 401/404
        // neither clears the panel nor is reported; the poll simply keeps its
        // own schedule below.
        if (read === aiReadRef.current) {
          const apiError =
            error instanceof ApiError
              ? error
              : new ApiError({
                  status: 0,
                  code: 'NETWORK_ERROR',
                  message: 'Could not reach the server.',
                });
          if (mapScopeErrors(apiError)) return;
          // A transient status failure changes nothing the owner can see: the
          // last known counters stay, the queue keeps working, and the next
          // cycle retries within the same bounded interval.
        }
      }
      if (stopped || !isAiCurrent(generation)) return;
      timer = window.setTimeout(() => void cycle(), AI_STATUS_POLL_MS);
    };
    timer = window.setTimeout(() => void cycle(), AI_STATUS_POLL_MS);
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      untrack(controller);
      controller.abort();
    };
    // Only the pending flag arms or disarms the timer; the functions it calls
    // are component-scoped declarations that read refs and the current state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiPending]);

  // A parent scope clear drops this panel's private state with the rest of
  // the section: the retained queue, the open detail, the draft, and the
  // retained intent go, and nothing is refetched into a scope that was just
  // invalidated.
  useEffect(() => {
    if (servedScopeRef.current === scopeResetSignal) return;
    servedScopeRef.current = scopeResetSignal;
    clearScopedState();
    // The scope reset alone drives this effect; `clearScopedState` is a
    // component-scoped declaration that the rule does not need to track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeResetSignal]);

  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

  // A bound field error or a refused decision moves focus to the control that
  // explains it, after the commit that rendered the message. The notice above
  // is declared first on purpose: the affected control wins the focus.
  useEffect(() => {
    if (focusSignal === 0) return;
    const target = focusTargetRef.current;
    focusTargetRef.current = null;
    if (target === 'category') {
      categoryRef.current?.focus();
    } else if (target === 'actions') {
      actionsRef.current?.focus();
    } else if (target === 'pending') {
      pendingRef.current?.focus();
    } else if (target === 'detail') {
      detailRef.current?.focus();
    }
  }, [focusSignal]);

  async function ensureCsrf(
    generation: number,
    signal: AbortSignal,
  ): Promise<CsrfToken | null> {
    if (csrfRef.current) return csrfRef.current;
    try {
      const fresh = await fetchCsrf(signal);
      if (!isCurrent(generation) || signal.aborted) return null;
      csrfRef.current = fresh;
      onCsrfRefreshed(fresh);
      return fresh;
    } catch {
      return null;
    }
  }

  async function refreshCsrf(
    generation: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      const fresh = await fetchCsrf(signal);
      if (!isCurrent(generation) || signal.aborted) return false;
      csrfRef.current = fresh;
      onCsrfRefreshed(fresh);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The notice's own reload control is a manual refresh: it clears notices.
   * It is also the recovery path for a status read that failed, so the
   * private AI progress is retried with the queue.
   */
  function refreshReviews() {
    startLoad(view);
    startAiStatusLoad();
  }

  function loadMore() {
    if (
      page === null ||
      !page.hasMore ||
      loading ||
      loadingMore ||
      resolvingRef.current
    ) {
      return;
    }
    const generation = genRef.current;
    const sequence = ++moreSeqRef.current;
    const controller = new AbortController();
    track(controller);
    void loadPage(
      generation,
      controller,
      page.items.length,
      true,
      view,
      false,
    ).finally(() => {
      untrack(controller);
      if (!unmountedRef.current && moreSeqRef.current === sequence) {
        setLoadingMore(false);
      }
    });
  }

  /**
   * A definite rejection whose exact outcome is unknown: a timeout, an
   * unreachable server, lock contention, or an unexpected server failure. The
   * retained key and body stay available for a same-key retry that can prove
   * what happened, and the draft stays for a fresh decision.
   */
  function hasUnknownOutcome(apiError: ApiError): boolean {
    return (
      apiError.timedOut ||
      apiError.status === 0 ||
      apiError.status >= 500 ||
      apiError.code === 'NETWORK_ERROR' ||
      apiError.code === 'FINANCE_BUSY' ||
      // An unparsable body or a 200 whose representation drifted: the server
      // may well have applied the decision, so it is never reported as a
      // failure the owner can safely repeat under a fresh key.
      apiError.code === 'UNKNOWN_ERROR'
    );
  }

  /**
   * Sends exactly one resolution intent. The durable key makes an explicit
   * retry after an unknown outcome safe: a same-key replay returns the
   * already-committed representation instead of applying a second decision.
   */
  async function submitResolve(request: PendingResolve) {
    if (resolvingRef.current || !authorityConfirmed) return;
    const generation = genRef.current;
    const controller = new AbortController();
    track(controller);
    resolvingRef.current = true;
    setResolving(true);
    setNotice(null);
    retainResolve(request);
    try {
      const token = await ensureCsrf(generation, controller.signal);
      if (!isCurrent(generation) || controller.signal.aborted) return;
      if (!token) {
        // The request never left the browser, so nothing can have committed:
        // the retained intent is dropped and the draft stays for a save.
        retainResolve(null);
        setNotice({
          kind: 'error',
          text: 'Security setup failed. The decision was not sent; try again.',
        });
        return;
      }
      const resolved = await resolveCategorizationReview(
        household.id,
        request.reviewId,
        request.input,
        request.key,
        token,
        controller.signal,
      );
      if (!isCurrent(generation) || controller.signal.aborted) return;
      retainResolve(null);
      showReview(resolved);
      setDraftCategory('');
      setDraftError(undefined);
      showDraftAction('ACCEPT_SUGGESTION');
      applyResolvedReview(resolved, view);
      setNotice({
        kind: 'info',
        text: `Decision saved. ${resolved.transaction.description} is now ${categoryLabel(
          resolved.transaction.category,
          categories,
        )} — your decision; automation will not replace it.`,
      });
      // The feed and the open detail panel converge on the committed entry;
      // the balance and spending projections are category-agnostic and are
      // deliberately not refetched.
      onTransactionChanged(resolved.transaction);
      startLoad(view, true);
    } catch (error) {
      if (!isCurrent(generation) || controller.signal.aborted) return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not reach the server.',
            });
      if (mapScopeErrors(apiError)) return;
      if (apiError.code === 'CSRF_INVALID') {
        const refreshed = await refreshCsrf(generation, controller.signal);
        if (!isCurrent(generation) || controller.signal.aborted) return;
        // A rejected token means the request never reached the server: the
        // retained intent goes and the draft stays for another save.
        retainResolve(null);
        setNotice({
          kind: 'error',
          text: refreshed
            ? 'Your security token was refreshed. Review the decision and save it again.'
            : 'Your secure request expired. Reload before retrying.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      // Either the review-specific code or the shared privacy-preserving
      // transaction 404: both mean this owner cannot see the suggestion any
      // more, so it is treated identically and never probed further.
      if (apiError.status === 404) {
        retainResolve(null);
        showReview(null);
        dropReview(request.reviewId);
        setNotice({
          kind: 'warning',
          text: 'That suggestion is no longer available to you. The queue was reloaded.',
          correlationId: apiError.correlationId,
          showReload: true,
        });
        startLoad(view, true);
        return;
      }
      if (
        apiError.code === 'RESOURCE_VERSION_CONFLICT' ||
        apiError.code === 'RESOURCE_VERSION_EXHAUSTED' ||
        apiError.code === 'TRANSACTION_VOIDED' ||
        apiError.code === 'IDEMPOTENCY_CONFLICT'
      ) {
        // A definite rejection: the review version, the evaluated entry
        // version, or the evidence moved on. Nothing was applied, the chosen
        // category draft is preserved, and the current representation is
        // reloaded so the owner reviews it before deciding again.
        retainResolve(null);
        setNotice({
          kind: 'error',
          text: 'This suggestion or its entry changed on the server. The latest state was reloaded; review it and save the decision again.',
          correlationId: apiError.correlationId,
          showReload: true,
        });
        await refreshOpenReview(request.reviewId);
        startLoad(view, true);
        return;
      }
      if (apiError.code === 'VALIDATION_FAILED') {
        retainResolve(null);
        setDraftError(
          apiError.fieldErrors?.category ??
            apiError.fieldErrors?.action ??
            apiError.fieldErrors?.expectedVersion ??
            apiError.fieldErrors?.expectedTransactionVersion ??
            'That decision could not be saved. Check the choice and try again.',
        );
        setNotice({
          kind: 'error',
          text: 'Check the decision and try again.',
          correlationId: apiError.correlationId,
        });
        requestFocus(
          draftAction === 'CHOOSE_CATEGORY' ? 'category' : 'actions',
        );
        return;
      }
      if (hasUnknownOutcome(apiError)) {
        // The retained key and exact body stay available: only a same-key
        // retry can prove whether the decision was applied.
        setNotice({
          kind: 'warning',
          text: 'The decision has an unknown outcome. Retry the exact same decision with its original key, or reload the queue first — reloading keeps the decision available.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      retainResolve(null);
      setNotice({
        kind: 'error',
        text:
          apiError.message ||
          'The decision could not be saved. The queue was reloaded.',
        correlationId: apiError.correlationId,
        showReload: true,
      });
      startLoad(view, true);
    } finally {
      untrack(controller);
      resolvingRef.current = false;
      if (!unmountedRef.current) setResolving(false);
    }
  }

  /**
   * Builds and sends the decision currently selected in the open detail. The
   * two expected versions travel with it, so the server can reject a decision
   * made against a moved review or a moved entry instead of applying it.
   */
  function submitDraft(event: FormEvent, review: CategorizationReview) {
    event.preventDefault();
    if (resolvingRef.current || !authorityConfirmed) return;
    if (pendingResolve !== null && pendingResolve.reviewId === review.id) {
      setNotice({
        kind: 'warning',
        text: 'An earlier decision for this suggestion still has an unknown result. Retry that exact decision, or reload the queue first.',
      });
      requestFocus('pending');
      return;
    }
    if (draftAction === 'CHOOSE_CATEGORY' && draftCategory === '') {
      setDraftError('Choose a category for this decision.');
      requestFocus('category');
      return;
    }
    if (
      draftAction === 'KEEP_CURRENT' &&
      review.transaction.category === null
    ) {
      setDraftError(
        'This entry has no recorded category, so there is nothing to keep.',
      );
      requestFocus('actions');
      return;
    }
    if (
      draftAction === 'KEEP_UNCATEGORIZED' &&
      review.transaction.category !== null
    ) {
      setDraftError('This entry already has a category to keep.');
      requestFocus('actions');
      return;
    }
    setDraftError(undefined);
    const expected = {
      expectedVersion: review.version,
      expectedTransactionVersion: review.evaluatedTransactionVersion,
    };
    const input: ResolveCategorizationReviewInput =
      draftAction === 'CHOOSE_CATEGORY'
        ? { ...expected, action: 'CHOOSE_CATEGORY', category: draftCategory }
        : { ...expected, action: draftAction };
    void submitResolve({
      key: crypto.randomUUID(),
      reviewId: review.id,
      description: review.transaction.description,
      input,
    });
  }

  function retryPending() {
    const pending = pendingResolveRef.current;
    if (!pending) return;
    void submitResolve(pending);
  }

  /**
   * Reloads the queue while an outcome is unknown and asks the server for the
   * one item itself. The read can show the suggestion's current state, but it
   * cannot attribute that state to this intent: a decision made elsewhere, a
   * direct correction, and a supersession are indistinguishable here, and a
   * same-key replay is the only proof. The retained intent therefore stays
   * available in every case, a 404 means the item is not reachable for this
   * owner any more, and a failed read changes nothing at all.
   */
  async function reloadQueueAndReconcilePending() {
    const pending = pendingResolve;
    if (!pending || resolvingRef.current) return;
    startLoad(view, true);
    const generation = genRef.current;
    const controller = new AbortController();
    track(controller);
    try {
      const review = await fetchCategorizationReview(
        household.id,
        pending.reviewId,
        controller.signal,
      );
      if (!isCurrent(generation) || controller.signal.aborted) return;
      showReview(review);
      reconcileDraft(review);
      if (review.status !== 'OPEN') {
        // The suggestion is no longer waiting, but that alone proves nothing
        // about this intent: a decision made on another device, a direct
        // correction, or a supersession all leave the same observable state.
        // Only a same-key replay can prove what this intent did, so the
        // retained intent stays available and no outcome is claimed.
        // The waiting row is gone, and with it the decision form: there is no
        // open suggestion left to decide on. The retained intent above is the
        // only thing that can still prove what this decision did.
        dropReview(review.id);
        showReview(null);
        setNotice({
          kind: 'warning',
          text: 'This suggestion is no longer waiting for review, so it left the waiting list. The outcome of your earlier decision is still unproven — retry the exact same decision with its original key to prove it.',
          showReload: true,
        });
        return;
      }
      setNotice({
        kind: 'warning',
        text: 'That suggestion is still waiting for your decision. Retry the exact same decision with its original key, or choose again.',
      });
    } catch (error) {
      if (!isCurrent(generation) || controller.signal.aborted) return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not reach the server.',
            });
      if (mapScopeErrors(apiError)) return;
      // Either the review-specific code or the shared privacy-preserving
      // transaction 404: both mean this owner cannot see the suggestion any
      // more, so it is treated identically and never probed further.
      if (apiError.status === 404) {
        retainResolve(null);
        showReview(null);
        dropReview(pending.reviewId);
        setNotice({
          kind: 'warning',
          text: 'That suggestion is no longer available to you. If your decision was saved it is already applied; the queue was reloaded.',
          correlationId: apiError.correlationId,
          showReload: true,
        });
        return;
      }
      setNotice({
        kind: 'warning',
        text: 'The queue was reloaded, but the earlier decision still has an unknown outcome. Retry it with its original key.',
        correlationId: apiError.correlationId,
      });
    } finally {
      untrack(controller);
    }
  }

  const busy = loading || loadingMore || resolving;
  const openCount = page?.openCount ?? null;
  const entryLabel =
    openCount === null
      ? 'Review suggested categories'
      : openCount === 0
        ? 'Review suggested categories — none waiting'
        : `Review suggested categories (${openCount} waiting)`;
  const queueId = `finance-reviews-queue-${household.id}`;

  function detailFor(review: CategorizationReview) {
    const effective = review.transaction.category;
    const canKeepCurrent = effective !== null;
    const canKeepUncategorized = effective === null;
    const blockedByPending = pendingResolve?.reviewId === review.id;
    const actionGroup = `review-action-${review.id}`;
    return (
      <div
        ref={detailRef}
        tabIndex={-1}
        role="group"
        className="finance-review-detail"
        aria-labelledby={`review-detail-${review.id}`}
        onKeyDown={handleDetailKeyDown}
      >
        <h6 id={`review-detail-${review.id}`}>
          Suggestion for “{review.transaction.description}”
        </h6>
        <dl className="finance-detail-list">
          <div>
            <dt>Recorded category</dt>
            <dd>
              {categoryLabel(effective, categories)}
              {effective === null ? ' — this entry has no category yet' : ''}
            </dd>
          </div>
          <div>
            <dt>Suggested category</dt>
            <dd>{categoryLabel(review.suggestedCategory, categories)}</dd>
          </div>
          <div>
            <dt>Why it was suggested</dt>
            <dd>{review.reasonLabel}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>
              {SOURCE_LABELS[review.source]} ·{' '}
              {CONFIDENCE_LABELS[review.confidence]}
            </dd>
          </div>
          <div>
            <dt>Entry</dt>
            <dd>
              {KIND_TEXT[review.transaction.kind]} ·{' '}
              {formatMoney(
                review.transaction.money.amount,
                review.transaction.money.currency,
              )}{' '}
              · {review.transaction.occurredOn}
            </dd>
          </div>
          <div>
            <dt>Suggestion state</dt>
            <dd>
              {review.status === 'OPEN'
                ? `Waiting for your decision · version ${review.version} · entry version ${review.evaluatedTransactionVersion}`
                : RESOLUTION_LABELS[review.status]}
            </dd>
          </div>
          <div>
            <dt>Raised</dt>
            <dd>
              <time dateTime={review.createdAt}>
                {new Date(review.createdAt).toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </time>
            </dd>
          </div>
        </dl>

        <p className="household-hint">
          {SOURCE_EXPLANATIONS[review.source]} {CONFIDENCE_NOTE}
        </p>

        {review.status === 'OPEN' ? (
          <>
            <p className="household-hint">
              Your decision replaces the suggestion for this entry and will not
              be replaced by automation.
            </p>
            {blockedByPending && (
              <p role="status" className="household-hint">
                An earlier decision for this suggestion still has an unknown
                result. Retry that exact decision above, or reload the queue
                before choosing again.
              </p>
            )}
            <form onSubmit={(event) => submitDraft(event, review)} noValidate>
              <fieldset
                ref={actionsRef}
                tabIndex={-1}
                className="finance-review-actions"
                aria-describedby={
                  draftError ? `review-action-error-${review.id}` : undefined
                }
              >
                <legend>Your decision</legend>
                <label className="finance-review-option">
                  <input
                    type="radio"
                    name={actionGroup}
                    value="ACCEPT_SUGGESTION"
                    checked={draftAction === 'ACCEPT_SUGGESTION'}
                    disabled={busy || !authorityConfirmed || blockedByPending}
                    onChange={() => {
                      showDraftAction('ACCEPT_SUGGESTION');
                      setDraftError(undefined);
                    }}
                  />
                  <span>
                    Accept the suggestion —{' '}
                    {categoryLabel(review.suggestedCategory, categories)}
                  </span>
                </label>
                <label className="finance-review-option">
                  <input
                    type="radio"
                    name={actionGroup}
                    value="CHOOSE_CATEGORY"
                    checked={draftAction === 'CHOOSE_CATEGORY'}
                    disabled={
                      busy ||
                      !authorityConfirmed ||
                      blockedByPending ||
                      categories === null
                    }
                    onChange={() => {
                      showDraftAction('CHOOSE_CATEGORY');
                      setDraftError(undefined);
                    }}
                  />
                  <span>Choose a different category</span>
                </label>
                {draftAction === 'CHOOSE_CATEGORY' && (
                  <div className="household-field">
                    <label htmlFor={`review-category-${review.id}`}>
                      Category for this decision
                    </label>
                    <select
                      ref={categoryRef}
                      id={`review-category-${review.id}`}
                      value={draftCategory}
                      onChange={(event) => {
                        setDraftCategory(event.target.value);
                        setDraftError(undefined);
                      }}
                      disabled={busy || !authorityConfirmed}
                      aria-invalid={Boolean(draftError)}
                      aria-describedby={
                        draftError
                          ? `review-action-error-${review.id}`
                          : undefined
                      }
                    >
                      <option value="">Choose a category…</option>
                      {(categories ?? []).map((category) => (
                        <option key={category.code} value={category.code}>
                          {category.label}
                        </option>
                      ))}
                    </select>
                    {categories === null && (
                      <p className="household-hint">
                        Category unavailable. Refresh the section to retry the
                        list.
                      </p>
                    )}
                  </div>
                )}
                <label className="finance-review-option">
                  <input
                    type="radio"
                    name={actionGroup}
                    value="KEEP_CURRENT"
                    checked={draftAction === 'KEEP_CURRENT'}
                    disabled={
                      busy ||
                      !authorityConfirmed ||
                      blockedByPending ||
                      !canKeepCurrent
                    }
                    aria-describedby={
                      canKeepCurrent
                        ? undefined
                        : `review-keep-current-hint-${review.id}`
                    }
                    onChange={() => {
                      showDraftAction('KEEP_CURRENT');
                      setDraftError(undefined);
                    }}
                  />
                  <span>
                    Keep the recorded category —{' '}
                    {categoryLabel(effective, categories)}
                  </span>
                </label>
                {!canKeepCurrent && (
                  <p
                    id={`review-keep-current-hint-${review.id}`}
                    className="household-hint"
                  >
                    This entry has no recorded category, so there is nothing to
                    keep.
                  </p>
                )}
                <label className="finance-review-option">
                  <input
                    type="radio"
                    name={actionGroup}
                    value="KEEP_UNCATEGORIZED"
                    checked={draftAction === 'KEEP_UNCATEGORIZED'}
                    disabled={
                      busy ||
                      !authorityConfirmed ||
                      blockedByPending ||
                      !canKeepUncategorized
                    }
                    aria-describedby={
                      canKeepUncategorized
                        ? undefined
                        : `review-keep-uncategorized-hint-${review.id}`
                    }
                    onChange={() => {
                      showDraftAction('KEEP_UNCATEGORIZED');
                      setDraftError(undefined);
                    }}
                  />
                  <span>Keep it uncategorized</span>
                </label>
                <p
                  id={`review-keep-uncategorized-hint-${review.id}`}
                  className="household-hint"
                >
                  {canKeepUncategorized
                    ? 'Keeping it uncategorized is a decision of your own: this entry keeps no category and HouseSync will not replace that.'
                    : 'This entry already has a category, so it cannot be kept uncategorized.'}
                </p>
              </fieldset>
              {draftError && (
                <p
                  id={`review-action-error-${review.id}`}
                  className="household-error"
                  role="alert"
                >
                  {draftError}
                </p>
              )}
              <div className="finance-account-actions">
                <button
                  type="submit"
                  className="household-button"
                  disabled={
                    busy || !authorityConfirmed || blockedByPending || loading
                  }
                >
                  {resolving && !blockedByPending
                    ? 'Saving decision…'
                    : 'Save decision'}
                </button>
                <button
                  type="button"
                  className="household-button household-button--secondary"
                  disabled={busy}
                  onClick={() => closeDetail(review.id)}
                >
                  Close
                </button>
              </div>
            </form>
          </>
        ) : (
          <p className="household-hint">
            This suggestion was resolved ({RESOLUTION_LABELS[review.status]}).
            The recorded category above is the entry’s current category.
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      className="finance-reviews"
      role="region"
      aria-labelledby={`finance-reviews-title-${household.id}`}
    >
      <div className="finance-accounts-heading">
        <div>
          <p className="eyebrow">Private suggestions</p>
          <h5 id={`finance-reviews-title-${household.id}`}>Category reviews</h5>
        </div>
        <span className="privacy-chip">Only you can see these</span>
      </div>
      <p className="finance-helper">
        HouseSync may suggest a category for one of your own entries. A
        suggestion never changes anything by itself: you accept it, choose
        another category, keep the recorded one, or keep the entry
        uncategorized. No other member ever sees your suggestions or this count.
      </p>
      <p className="household-meta" role="status" aria-live="polite">
        {openCount === null
          ? loading
            ? 'Loading your suggestions…'
            : 'Your suggestions are not loaded.'
          : openCount === 0
            ? 'No suggestions are waiting for your decision.'
            : `${openCount} ${
                openCount === 1 ? 'suggestion is' : 'suggestions are'
              } waiting for your decision.`}
      </p>
      {aiStatus !== null && aiStatus.enabled && (
        // AI progress is owner-private and supplementary to the queue:
        // it names no entry, merchant, model, provider, or failure reason,
        // and it never disables a decision. A pending backlog is announced
        // while it runs and converges on its own when it settles; a terminal
        // failure states the safe outcome and leaves the manual choice.
        <div className="finance-reviews-ai">
          {aiPending && (
            <div
              className="household-notice household-notice--info"
              role="status"
              aria-live="polite"
            >
              <p>
                {aiStatus.pendingCount === 1
                  ? 'HouseSync is asking an optional AI model for a category suggestion on 1 of your entries.'
                  : `HouseSync is asking an optional AI model for category suggestions on ${aiStatus.pendingCount} of your entries.`}{' '}
                Suggestions appear in this queue when they are ready, and
                nothing changes until you decide.
              </p>
            </div>
          )}
          {aiStatus.failedCount > 0 && (
            <div
              className="household-notice household-notice--warning"
              role="status"
              aria-live="polite"
            >
              <p>
                {aiStatus.failedCount === 1
                  ? 'No AI suggestion could be produced for 1 of your entries.'
                  : `No AI suggestions could be produced for ${aiStatus.failedCount} of your entries.`}{' '}
                Nothing was changed — choose a category yourself whenever you
                are ready.
              </p>
            </div>
          )}
        </div>
      )}
      <div className="finance-account-actions">
        <button
          type="button"
          id={`finance-reviews-entry-${household.id}`}
          className="household-button"
          aria-expanded={queueOpen}
          aria-controls={queueId}
          onClick={() => setQueueOpen((open) => !open)}
        >
          {queueOpen ? 'Hide the review queue' : entryLabel}
        </button>
      </div>

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
          {notice.showReload && (
            <button
              type="button"
              className="household-button household-button--secondary"
              disabled={busy}
              onClick={refreshReviews}
            >
              Reload suggestions
            </button>
          )}
        </div>
      )}

      {pendingResolve && (
        // Durable same-key retry affordance: it lives outside the transient
        // notice and outside the queue, so a reload, a filter change, or a
        // later notice can never strand the retained decision.
        <div
          ref={pendingRef}
          tabIndex={-1}
          role="group"
          className="household-notice household-notice--warning finance-pending-request"
          aria-label="Unresolved category review decision"
        >
          <p>
            An earlier decision for “{pendingResolve.description}” still has an
            unknown result. Retry the exact same decision with its original key,
            or reload the queue first. Reloading keeps the decision available;
            only a same-key retry can prove whether it was saved.
          </p>
          <div className="finance-account-actions">
            <button
              type="button"
              className="household-button"
              disabled={busy || !authorityConfirmed}
              onClick={retryPending}
            >
              Retry this decision
            </button>
            <button
              type="button"
              className="household-button household-button--secondary"
              disabled={busy}
              onClick={() => void reloadQueueAndReconcilePending()}
            >
              Reload the queue
            </button>
          </div>
        </div>
      )}

      <div id={queueId}>
        {queueOpen && (
          <>
            {!authorityConfirmed && (
              <p role="status" className="household-stale">
                Refresh the household before deciding on suggestions.
              </p>
            )}

            <div className="household-field">
              <label htmlFor={`reviews-view-${household.id}`}>Show</label>
              <select
                id={`reviews-view-${household.id}`}
                value={view}
                onChange={(event) => {
                  const next = event.target.value as CategorizationReviewView;
                  setView(next);
                  showReview(null);
                  setDraftCategory('');
                  setDraftError(undefined);
                }}
                disabled={busy}
              >
                <option value="OPEN">Waiting for review</option>
                <option value="HISTORY">Resolved suggestions</option>
              </select>
            </div>

            {page === null && loading && (
              <p role="status" aria-live="polite">
                Loading your suggestions…
              </p>
            )}

            {page !== null && page.items.length === 0 && !loading && (
              <p className="finance-empty">{EMPTY_STATE_TEXT[view]}</p>
            )}

            {page !== null && page.items.length > 0 && (
              <ul
                className="finance-review-list"
                aria-label="Category suggestions"
              >
                {page.items.map((review) => {
                  const expanded = openReview?.id === review.id;
                  const effective = categoryLabel(
                    review.transaction.category,
                    categories,
                  );
                  const suggested = categoryLabel(
                    review.suggestedCategory,
                    categories,
                  );
                  return (
                    <li key={review.id} className="finance-review-card">
                      <div className="finance-transaction-summary">
                        <div>
                          <p className="finance-transaction-name">
                            {review.transaction.description}
                          </p>
                          <p className="household-meta">
                            {KIND_TEXT[review.transaction.kind]} ·{' '}
                            {formatMoney(
                              review.transaction.money.amount,
                              review.transaction.money.currency,
                            )}{' '}
                            · {review.transaction.occurredOn}
                          </p>
                          <p className="household-meta">
                            Recorded: {effective} · Suggested: {suggested}
                          </p>
                        </div>
                        <span className="finance-note-chip">
                          {review.status === 'OPEN'
                            ? 'Waiting'
                            : RESOLUTION_LABELS[review.status]}
                        </span>
                      </div>
                      <div className="finance-account-actions">
                        <button
                          type="button"
                          id={`review-open-${review.id}`}
                          className="household-button household-button--secondary"
                          aria-expanded={expanded}
                          aria-label={`${
                            expanded
                              ? 'Hide the suggestion'
                              : review.status === 'OPEN'
                                ? 'Review the suggestion'
                                : 'See the resolution'
                          } for ${review.transaction.description}`}
                          disabled={busy}
                          onClick={() =>
                            expanded
                              ? closeDetail(review.id)
                              : openDetail(review)
                          }
                        >
                          {expanded
                            ? 'Hide the suggestion'
                            : review.status === 'OPEN'
                              ? 'Review the suggestion'
                              : 'See the resolution'}
                        </button>
                      </div>
                      {expanded && openReview !== null && detailFor(openReview)}
                    </li>
                  );
                })}
              </ul>
            )}

            {page !== null && page.hasMore && (
              <div className="finance-account-actions">
                <button
                  type="button"
                  className="household-button household-button--secondary"
                  disabled={busy}
                  onClick={loadMore}
                >
                  {loadingMore ? 'Loading more suggestions…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
