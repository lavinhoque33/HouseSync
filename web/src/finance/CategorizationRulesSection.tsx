import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  ApiError,
  fetchCategorizationRules,
  fetchCsrf,
  patchCategorizationRule,
  type CategorizationRule,
  type CategorizationRuleMatchType,
  type CategorizationRuleStatus,
  type CsrfToken,
  type Household,
  type TransactionCategory,
} from '../auth/client';
import { FilterBar } from '../ui/FilterBar';
import { categoryLabel } from './categories';

interface Notice {
  kind: 'info' | 'error' | 'warning';
  text: string;
  correlationId?: string | undefined;
  showReload?: boolean | undefined;
}

/** `ALL` omits the documented `status` query parameter. */
type RuleFilter = CategorizationRuleStatus | 'ALL';

/** The documented page bound; the contract default is 50. */
const RULE_PAGE_LIMIT = 50;

/**
 * Calm labels for the two server-derived match types. The match type is safe
 * to show; the match key it was derived from never leaves the server.
 */
const MATCH_TYPE_LABELS: Record<CategorizationRuleMatchType, string> = {
  PROVIDER_MERCHANT: 'Bank merchant',
  NORMALIZED_TEXT: 'Description text',
};

const EMPTY_STATE_TEXT: Record<RuleFilter, string> = {
  ACTIVE:
    'No active rules yet. After you choose a category, open the entry’s details and use “Use for future matches” to create one.',
  INACTIVE: 'No deactivated rules. Deactivating a rule keeps it listed here.',
  ALL: 'No rules yet. A rule reuses one of your own category decisions for future entries.',
};

interface CategorizationRulesSectionProps {
  household: Household;
  csrf: CsrfToken | null;
  onCsrfRefreshed: (token: CsrfToken) => void;
  onSessionExpired: () => void;
  onHouseholdAccessChanged: () => void;
  authorityConfirmed: boolean;
  /**
   * The taxonomy already loaded by the parent. Server-returned labels are the
   * only user-visible category names, so a missing list disables the category
   * editor rather than falling back to a raw enum token.
   */
  categories: TransactionCategory[] | null;
  /**
   * Bumped by the parent after a rule create commits elsewhere in the
   * section, so the list converges on the committed rule without remounting
   * this component or discarding the open filter and editor.
   */
  refreshSignal: number;
  /**
   * Bumped by the parent whenever the whole section's scope is cleared —
   * sign-out, confirmed session expiry, household switch, or access loss.
   * The private list, the open editor, the confirmation, and every in-flight
   * request are dropped with it, so no private merchant label survives a
   * scope change and no late response can publish into the new scope.
   */
  scopeResetSignal: number;
}

/**
 * Owner-private management of the current actor's own future-match rules.
 * Every route behind it is scoped to this household and this
 * financial owner: another member's rules are never listed, probed, or
 * counted, and the section renders for every member because each one manages
 * only their own.
 *
 * Rule updates are version-guarded rather than keyed, so an unknown outcome
 * is always recovered by reloading the list before retrying, and a
 * deactivation (one-way) asks for confirmation because it cannot be
 * undone in this version. Sign-out, session expiry, household switch, and
 * access loss drop the list, the filter, the open editor, and every in-flight
 * request: private merchant labels never survive a scope change.
 */
export function CategorizationRulesSection({
  household,
  csrf,
  onCsrfRefreshed,
  onSessionExpired,
  onHouseholdAccessChanged,
  authorityConfirmed,
  categories,
  refreshSignal,
  scopeResetSignal,
}: CategorizationRulesSectionProps) {
  const [rules, setRules] = useState<CategorizationRule[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [filter, setFilter] = useState<RuleFilter>('ACTIVE');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCategory, setEditCategory] = useState('');
  const [editError, setEditError] = useState<string | undefined>(undefined);
  const [pendingDeactivate, setPendingDeactivate] =
    useState<CategorizationRule | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const csrfRef = useRef(csrf);
  const genRef = useRef(0);
  const moreSeqRef = useRef(0);
  const updatingRef = useRef(false);
  const unmountedRef = useRef(false);
  const ownedRef = useRef<Set<AbortController>>(new Set());
  const noticeRef = useRef<HTMLDivElement>(null);
  const editCategoryRef = useRef<HTMLSelectElement>(null);
  const deactivateConfirmRef = useRef<HTMLDivElement>(null);
  /**
   * The filter and signal pair the mounted instance has already served, so
   * the initial load is never repeated by the change effect below.
   */
  const servedRef = useRef<{ filter: RuleFilter; signal: number } | null>(null);
  /** The scope reset the mounted instance has already observed. */
  const servedScopeRef = useRef(scopeResetSignal);

  useEffect(() => {
    csrfRef.current = csrf;
  }, [csrf]);

  function isCurrent(generation: number): boolean {
    return !unmountedRef.current && genRef.current === generation;
  }

  function track(controller: AbortController) {
    ownedRef.current.add(controller);
  }

  function untrack(controller: AbortController) {
    ownedRef.current.delete(controller);
  }

  /**
   * Drops every private rule value and invalidates in-flight continuations:
   * the retained list, the filter, the open editor and confirmation, and the
   * mutation gate all return to their initial state. Nothing is loading
   * afterwards, so the panel never claims a request that no longer exists.
   */
  function clearScopedState() {
    genRef.current += 1;
    moreSeqRef.current += 1;
    updatingRef.current = false;
    // In-flight private requests are aborted with the state they would have
    // published into.
    for (const owned of ownedRef.current) owned.abort();
    setRules(null);
    setHasMore(false);
    setFilter('ACTIVE');
    setLoading(false);
    setLoadingMore(false);
    setNotice(null);
    setEditingId(null);
    setEditCategory('');
    setEditError(undefined);
    setPendingDeactivate(null);
    setUpdatingId(null);
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
   * section-level failure.
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

  async function loadPage(
    generation: number,
    controller: AbortController,
    offset: number,
    append: boolean,
    status: RuleFilter,
    preserveNotice: boolean,
  ) {
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
      // A recovery reload keeps the outcome notice that explains why it is
      // happening; a manual refresh clears notices instead.
      if (!preserveNotice) setNotice(null);
    }
    try {
      const page = await fetchCategorizationRules(
        household.id,
        {
          limit: RULE_PAGE_LIMIT,
          offset,
          status: status === 'ALL' ? undefined : status,
        },
        controller.signal,
      );
      if (!isCurrent(generation) || controller.signal.aborted) return;
      setRules((current) => {
        if (!append || current === null) return page.items;
        // Offset paging can repeat a rule that moved between requests; the
        // identity of a rule is its id, so a duplicate is never listed twice.
        const seen = new Set(current.map((rule) => rule.id));
        return [...current, ...page.items.filter((rule) => !seen.has(rule.id))];
      });
      setHasMore(page.hasMore);
      setLoading(false);
      setLoadingMore(false);
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
          ? 'Loading your rules timed out. Reload to try again.'
          : apiError.message || 'Could not load your categorization rules.',
        correlationId: apiError.correlationId,
        showReload: true,
      });
    }
  }

  function startLoad(status: RuleFilter, preserveNotice = false) {
    const generation = ++genRef.current;
    const controller = new AbortController();
    track(controller);
    void loadPage(
      generation,
      controller,
      0,
      false,
      status,
      preserveNotice,
    ).finally(() => untrack(controller));
  }

  useEffect(() => {
    unmountedRef.current = false;
    startLoad('ACTIVE');
    const owned = ownedRef.current;
    return () => {
      unmountedRef.current = true;
      genRef.current += 1;
      for (const tracked of owned) tracked.abort();
    };
    // Household identity is fixed for this keyed component instance; the
    // filter and refresh signal are served by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A filter change or a sibling rule commit reloads the first page: the
  // committed state is the authority, so an appended page is never kept
  // alongside it.
  useEffect(() => {
    if (servedRef.current === null) {
      servedRef.current = { filter, signal: refreshSignal };
      return;
    }
    if (
      servedRef.current.filter === filter &&
      servedRef.current.signal === refreshSignal
    ) {
      return;
    }
    servedRef.current = { filter, signal: refreshSignal };
    startLoad(filter);
    // The filter and signal alone drive this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, refreshSignal]);

  // A parent scope clear drops this panel's private state with the rest of
  // the section: the retained list, the open editor, the confirmation, and
  // every in-flight request go, and nothing is refetched into a scope that
  // was just invalidated.
  useEffect(() => {
    if (servedScopeRef.current === scopeResetSignal) return;
    servedScopeRef.current = scopeResetSignal;
    clearScopedState();
    // The scope reset alone drives this effect; `clearScopedState` is a
    // component-scoped declaration that the rule does not need to track.
  }, [scopeResetSignal]);

  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

  useEffect(() => {
    if (pendingDeactivate) deactivateConfirmRef.current?.focus();
  }, [pendingDeactivate]);

  useEffect(() => {
    if (editingId) editCategoryRef.current?.focus();
  }, [editingId]);

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

  function reloadRules() {
    // A recovery reload keeps the notice that explains the recovery.
    startLoad(filter, true);
  }

  /** The notice's own reload control is a manual refresh: it clears notices. */
  function refreshRules() {
    startLoad(filter);
  }

  /**
   * Applies a committed rule to the visible list in the server's documented
   * order (`updatedAt DESC`). A rule that no longer matches the open filter
   * leaves the list; the notice and the filter itself explain where it went.
   */
  function applyCommittedRule(updated: CategorizationRule, status: RuleFilter) {
    setRules((current) => {
      if (current === null) return current;
      const matches = status === 'ALL' || updated.status === status;
      if (!matches) return current.filter((rule) => rule.id !== updated.id);
      return [updated, ...current.filter((rule) => rule.id !== updated.id)];
    });
  }

  function beginCategoryEdit(rule: CategorizationRule) {
    if (loading || updatingId !== null) return;
    setEditingId(rule.id);
    setEditCategory(rule.category);
    setEditError(undefined);
    setPendingDeactivate(null);
  }

  function cancelCategoryEdit(ruleId: string) {
    setEditingId(null);
    setEditCategory('');
    setEditError(undefined);
    requestAnimationFrame(() => {
      if (unmountedRef.current) return;
      document.getElementById(`rule-edit-${ruleId}`)?.focus();
    });
  }

  function openDeactivateConfirm(rule: CategorizationRule) {
    if (loading || updatingId !== null) return;
    setPendingDeactivate(rule);
    setEditingId(null);
    setEditError(undefined);
  }

  function cancelDeactivateConfirm(ruleId: string) {
    setPendingDeactivate(null);
    requestAnimationFrame(() => {
      if (unmountedRef.current) return;
      document.getElementById(`rule-deactivate-${ruleId}`)?.focus();
    });
  }

  function handleDeactivateKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      const rule = pendingDeactivate;
      if (rule) cancelDeactivateConfirm(rule.id);
    }
  }

  /**
   * Shared failure handling for both version-guarded rule updates. Returns
   * true when the failure was fully handled, so the caller stops.
   */
  async function handleUpdateFailure(
    apiError: ApiError,
    generation: number,
    controller: AbortController,
    rule: CategorizationRule,
  ): Promise<boolean> {
    if (!isCurrent(generation) || controller.signal.aborted) return true;
    if (mapScopeErrors(apiError)) return true;
    if (apiError.code === 'CSRF_INVALID') {
      const refreshed = await refreshCsrf(generation, controller.signal);
      if (!isCurrent(generation) || controller.signal.aborted) return true;
      setNotice({
        kind: 'error',
        text: refreshed
          ? 'Your security token was refreshed. Review the rule and try again.'
          : 'Your secure request expired. Reload before retrying.',
        correlationId: apiError.correlationId,
      });
      // The draft is preserved: a rejected CSRF token means the request never
      // reached the rule, so nothing was changed.
      return true;
    }
    if (apiError.code === 'CATEGORY_RULE_NOT_FOUND') {
      // Deactivation is retained, never deleted, so a missing rule means this
      // list is stale: drop the row and reload the authoritative page.
      setRules((current) =>
        (current ?? []).filter((value) => value.id !== rule.id),
      );
      setEditingId(null);
      setPendingDeactivate(null);
      setNotice({
        kind: 'warning',
        text: 'That rule is no longer in your list. The list was reloaded.',
        correlationId: apiError.correlationId,
        showReload: true,
      });
      reloadRules();
      return true;
    }
    if (
      apiError.code === 'RESOURCE_VERSION_CONFLICT' ||
      apiError.code === 'RESOURCE_VERSION_EXHAUSTED' ||
      apiError.code === 'TRANSACTION_VOIDED' ||
      apiError.timedOut ||
      apiError.code === 'FINANCE_BUSY' ||
      apiError.code === 'NETWORK_ERROR'
    ) {
      // Stale or uncertain: the visible row may no longer describe the
      // server's state, so the editor and confirmation close and the
      // authoritative page is reloaded before any retry.
      setEditingId(null);
      setPendingDeactivate(null);
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
            ? 'The change has an unknown outcome. Your rules were reloaded; review before retrying.'
            : 'This rule changed on the server. Your rules were reloaded; review before retrying.',
        correlationId: apiError.correlationId,
        showReload: true,
      });
      reloadRules();
      return true;
    }
    return false;
  }

  async function submitCategoryChange(
    event: FormEvent,
    rule: CategorizationRule,
  ) {
    event.preventDefault();
    if (updatingRef.current || !authorityConfirmed) return;
    if (editCategory === '' || editCategory === rule.category) {
      setEditError('Choose a different category for this rule.');
      requestAnimationFrame(() => editCategoryRef.current?.focus());
      return;
    }
    const generation = genRef.current;
    const controller = new AbortController();
    track(controller);
    updatingRef.current = true;
    setUpdatingId(rule.id);
    setEditError(undefined);
    setNotice(null);
    try {
      const token = await ensureCsrf(generation, controller.signal);
      if (!isCurrent(generation) || controller.signal.aborted) return;
      if (!token) {
        setNotice({ kind: 'error', text: 'Security setup failed. Retry.' });
        return;
      }
      const updated = await patchCategorizationRule(
        household.id,
        rule.id,
        { expectedVersion: rule.version, category: editCategory },
        token,
        controller.signal,
      );
      if (!isCurrent(generation) || controller.signal.aborted) return;
      applyCommittedRule(updated, filter);
      setEditingId(null);
      setEditCategory('');
      setNotice({
        kind: 'info',
        text: `Rule updated: future matches for “${updated.matchLabel}” now use ${categoryLabel(updated.category, categories)}. Entries it already categorized keep their category.`,
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
      if (await handleUpdateFailure(apiError, generation, controller, rule)) {
        return;
      }
      if (apiError.code === 'VALIDATION_FAILED') {
        // Bind the rejection to the control the user must correct and keep
        // the chosen category visible.
        setEditError(
          apiError.fieldErrors?.category ??
            'That category is not accepted for this rule.',
        );
        setNotice({
          kind: 'error',
          text: 'Check the highlighted rule category.',
          correlationId: apiError.correlationId,
        });
        // The notice and the field both re-render after this failure. Two
        // frames place focus after the notice's own announcement focus, on
        // the control that needs correction.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => editCategoryRef.current?.focus()),
        );
        return;
      }
      setNotice({
        kind: 'error',
        text: apiError.message || 'The rule could not be updated.',
        correlationId: apiError.correlationId,
      });
    } finally {
      untrack(controller);
      updatingRef.current = false;
      if (!unmountedRef.current) setUpdatingId(null);
    }
  }

  async function confirmDeactivate(rule: CategorizationRule) {
    if (updatingRef.current || !authorityConfirmed) return;
    const generation = genRef.current;
    const controller = new AbortController();
    track(controller);
    updatingRef.current = true;
    setUpdatingId(rule.id);
    setNotice(null);
    try {
      const token = await ensureCsrf(generation, controller.signal);
      if (!isCurrent(generation) || controller.signal.aborted) return;
      if (!token) {
        setNotice({ kind: 'error', text: 'Security setup failed. Retry.' });
        return;
      }
      const updated = await patchCategorizationRule(
        household.id,
        rule.id,
        { expectedVersion: rule.version, status: 'INACTIVE' },
        token,
        controller.signal,
      );
      if (!isCurrent(generation) || controller.signal.aborted) return;
      applyCommittedRule(updated, filter);
      setPendingDeactivate(null);
      setNotice({
        kind: 'info',
        text: `Rule deactivated: future entries matching “${updated.matchLabel}” no longer use ${categoryLabel(updated.category, categories)}. Entries it already categorized keep their category.`,
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
      if (await handleUpdateFailure(apiError, generation, controller, rule)) {
        return;
      }
      setNotice({
        kind: 'error',
        text: apiError.message || 'The rule could not be deactivated.',
        correlationId: apiError.correlationId,
      });
    } finally {
      untrack(controller);
      updatingRef.current = false;
      if (!unmountedRef.current) setUpdatingId(null);
    }
  }

  function loadMore() {
    if (
      rules === null ||
      !hasMore ||
      loading ||
      loadingMore ||
      updatingId !== null
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
      rules.length,
      true,
      filter,
      false,
    ).finally(() => {
      untrack(controller);
      if (!unmountedRef.current && moreSeqRef.current === sequence) {
        setLoadingMore(false);
      }
    });
  }

  const busy = loading || loadingMore || updatingId !== null;

  return (
    <div
      className="finance-rules"
      role="region"
      aria-labelledby={`finance-rules-title-${household.id}`}
    >
      <div className="finance-accounts-heading">
        <div>
          <p className="eyebrow">Private automation</p>
          <h5 id={`finance-rules-title-${household.id}`}>
            Your future-match rules
          </h5>
        </div>
        <span className="privacy-chip">Only you can see these</span>
      </div>
      <p className="finance-helper">
        A rule reuses one of your own category decisions for future entries that
        match the same merchant or description text. Rules apply to new entries
        only: nothing already recorded changes, and no other member ever sees
        your rules.
      </p>

      <FilterBar
        title="Rule filters"
        summary={
          filter === 'ACTIVE'
            ? 'Active rules'
            : filter === 'INACTIVE'
              ? 'Deactivated rules'
              : 'All rules'
        }
        activeCount={filter === 'ACTIVE' ? 0 : 1}
        disabled={busy}
        onReset={() => {
          setFilter('ACTIVE');
          setEditingId(null);
          setEditError(undefined);
          setPendingDeactivate(null);
        }}
      >
        <div className="household-field">
          <label htmlFor={`rules-filter-${household.id}`}>Show</label>
          <select
            id={`rules-filter-${household.id}`}
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value as RuleFilter);
              setEditingId(null);
              setEditError(undefined);
              setPendingDeactivate(null);
            }}
            disabled={busy}
          >
            <option value="ACTIVE">Active rules</option>
            <option value="INACTIVE">Deactivated rules</option>
            <option value="ALL">All rules</option>
          </select>
        </div>
      </FilterBar>

      {!authorityConfirmed && (
        <p role="status" className="household-stale">
          Refresh the household before changing rules.
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
          {notice.showReload && (
            <button
              type="button"
              className="household-button household-button--secondary"
              disabled={busy}
              onClick={refreshRules}
            >
              Reload rules
            </button>
          )}
        </div>
      )}

      {rules === null && loading && (
        <p role="status" aria-live="polite">
          Loading your rules…
        </p>
      )}

      {rules === null && !loading && notice === null && (
        // Reached only after a scope clear or a failed first load that already
        // reported itself: the panel claims no rules it does not have.
        <p className="finance-empty">
          Your rules are not loaded. Refresh the household to load them again.
        </p>
      )}

      {rules !== null && rules.length === 0 && !loading && (
        <p className="finance-empty">{EMPTY_STATE_TEXT[filter]}</p>
      )}

      {rules !== null && rules.length > 0 && (
        <ul className="finance-rule-list" aria-label="Your future-match rules">
          {rules.map((rule) => {
            const active = rule.status === 'ACTIVE';
            return (
              <li key={rule.id} className="finance-rule-card">
                <div className="finance-transaction-summary">
                  <div>
                    <p className="finance-transaction-name">
                      {rule.matchLabel}
                    </p>
                    <p className="household-meta">
                      {MATCH_TYPE_LABELS[rule.matchType]} · Category:{' '}
                      {categoryLabel(rule.category, categories)} · Updated{' '}
                      <time dateTime={rule.updatedAt}>
                        {new Date(rule.updatedAt).toLocaleString(undefined, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </time>
                    </p>
                  </div>
                  <span className="finance-note-chip">
                    {active ? 'Active' : 'Deactivated'}
                  </span>
                </div>

                {active ? (
                  editingId === rule.id ? (
                    <form
                      className="finance-rule-editor"
                      onSubmit={(event) =>
                        void submitCategoryChange(event, rule)
                      }
                      noValidate
                    >
                      <div className="household-field">
                        <label htmlFor={`rule-category-${rule.id}`}>
                          Rule category
                        </label>
                        <select
                          ref={editCategoryRef}
                          id={`rule-category-${rule.id}`}
                          value={editCategory}
                          onChange={(event) => {
                            setEditCategory(event.target.value);
                            setEditError(undefined);
                          }}
                          disabled={busy || categories === null}
                          aria-invalid={Boolean(editError)}
                          aria-describedby={
                            editError
                              ? `rule-category-error-${rule.id}`
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
                            Category unavailable. Refresh the section to retry
                            the list.
                          </p>
                        )}
                        {editError && (
                          <p
                            id={`rule-category-error-${rule.id}`}
                            className="household-error"
                            role="alert"
                          >
                            {editError}
                          </p>
                        )}
                      </div>
                      <div className="finance-account-actions">
                        <button
                          type="submit"
                          className="household-button"
                          disabled={
                            busy || !authorityConfirmed || categories === null
                          }
                        >
                          {updatingId === rule.id
                            ? 'Saving…'
                            : 'Save rule category'}
                        </button>
                        <button
                          type="button"
                          className="household-button household-button--secondary"
                          disabled={busy}
                          onClick={() => cancelCategoryEdit(rule.id)}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="finance-account-actions">
                      <button
                        type="button"
                        id={`rule-edit-${rule.id}`}
                        className="household-button household-button--secondary"
                        disabled={busy || !authorityConfirmed}
                        aria-label={`Change category for ${rule.matchLabel}`}
                        onClick={() => beginCategoryEdit(rule)}
                      >
                        Change category
                      </button>
                      <button
                        type="button"
                        id={`rule-deactivate-${rule.id}`}
                        className="household-button household-button--secondary"
                        disabled={busy || !authorityConfirmed}
                        aria-label={`Deactivate the rule for ${rule.matchLabel}`}
                        onClick={() => openDeactivateConfirm(rule)}
                      >
                        Deactivate
                      </button>
                    </div>
                  )
                ) : (
                  <p className="household-hint">
                    Deactivated — it no longer assigns categories to new
                    entries. Deactivated rules stay listed and cannot be
                    reactivated in this version.
                  </p>
                )}

                {pendingDeactivate?.id === rule.id && (
                  <div
                    ref={deactivateConfirmRef}
                    tabIndex={-1}
                    role="group"
                    aria-label={`Confirm deactivating the rule for ${rule.matchLabel}`}
                    className="household-notice household-notice--warning finance-void-confirm"
                    onKeyDown={handleDeactivateKeyDown}
                  >
                    <p>
                      Deactivate the rule for “{rule.matchLabel}”? New entries
                      matching it stop receiving this category. Entries it
                      already categorized keep their category, and you cannot
                      reactivate it in this version.
                    </p>
                    <div className="finance-account-actions">
                      <button
                        type="button"
                        className="household-button"
                        disabled={busy || !authorityConfirmed}
                        onClick={() => void confirmDeactivate(rule)}
                      >
                        Deactivate rule
                      </button>
                      <button
                        type="button"
                        className="household-button household-button--secondary"
                        disabled={busy}
                        onClick={() => cancelDeactivateConfirm(rule.id)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {rules !== null && hasMore && (
        <div className="finance-account-actions">
          <button
            type="button"
            className="household-button household-button--secondary"
            disabled={busy}
            onClick={loadMore}
          >
            {loadingMore ? 'Loading more rules…' : 'Load more rules'}
          </button>
        </div>
      )}
    </div>
  );
}
