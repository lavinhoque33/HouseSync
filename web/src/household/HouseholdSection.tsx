import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  fetchCsrf,
  fetchHouseholds,
  postHousehold,
  type CsrfToken,
  type Household,
} from '../auth/client';
import { validateHouseholdName } from '../auth/validation';
import { InvitationSection } from '../invitation/InvitationSection';
import {
  FinancialAccountsSection,
  type PendingCreate as PendingAccountCreate,
} from '../finance/FinancialAccountsSection';
import { BankActivitySection } from '../finance/BankActivitySection';
import { FinancialConnectionsSection } from '../finance/FinancialConnectionsSection';
import { TransactionsSection } from '../finance/TransactionsSection';
import { MembersSection } from './MembersSection';
import { householdPath, type HouseholdPage } from '../navigation';
import { AppLink } from '../NavigationMenu';
import { HouseholdCard } from './HouseholdCard';
import { Icon } from '../ui/Icon';
import { HouseholdInbox } from './HouseholdInbox';

interface HouseholdNotice {
  kind: 'info' | 'error' | 'warning';
  text: string;
  correlationId?: string | undefined;
  showRefresh?: boolean | undefined;
}

interface HouseholdSectionProps {
  csrf: CsrfToken | null;
  onCsrfRefreshed: (token: CsrfToken) => void;
  onSessionExpired: () => void;
  /**
   * Bumped by the parent after an invitation acceptance so the authorized
   * collection reloads and shows the newly joined household.
   */
  refreshSignal?: number | undefined;
  /**
   * Reports the served signal value once the reload it triggered settles,
   * so a requester (the join flow) can order an explicit retry after
   * reconciliation. Manual and initial loads never report.
   */
  onRefreshSettled?: ((signal: number) => void) | undefined;
  /** Signed-in account id separating self and other-member controls. */
  currentUserId: string;
  /**
   * Requests an authoritative household-collection reload for membership
   * writes and stale-access recovery. The parent normally supplies this as
   * a queued refresh-signal bump; it falls back to a direct refresh.
   */
  onHouseholdReconcile?: (() => void) | undefined;
  route?: { householdId: string; page: HouseholdPage } | null;
  active?: boolean;
  createMode?: boolean;
  headerInboxTarget?: HTMLElement | null;
}

function sortHouseholds(values: Household[]): Household[] {
  return [...values].sort((a, b) => {
    // Compare parsed instants numerically: lexicographic order mis-sorts
    // valid ISO-8601 forms within the same second (`...00Z` versus
    // `...00.9Z`). Fall back to raw-string order for unexpected values so
    // the tie-break stays deterministic.
    const aTime = Date.parse(a.createdAt);
    const bTime = Date.parse(b.createdAt);
    if (!Number.isNaN(aTime) && !Number.isNaN(bTime) && aTime !== bTime) {
      return aTime - bTime;
    }
    if (a.createdAt < b.createdAt) return -1;
    if (a.createdAt > b.createdAt) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function HouseholdSection({
  csrf,
  onCsrfRefreshed,
  onSessionExpired,
  refreshSignal = 0,
  onRefreshSettled,
  currentUserId,
  onHouseholdReconcile,
  route = null,
  active = true,
  createMode = false,
  headerInboxTarget = null,
}: HouseholdSectionProps) {
  const [households, setHouseholds] = useState<Household[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<HouseholdNotice | null>(null);
  const [name, setName] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [createNotice, setCreateNotice] = useState<HouseholdNotice | null>(
    null,
  );
  const [creating, setCreating] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  // Per-household sibling account-list signals: a committed account-list
  // mutation in FinancialAccountsSection (create, rename, archive,
  // reactivate) or an admitted account selection in
  // FinancialConnectionsSection bumps its household's entry so the keyed
  // FinancialAccountsSection refetches its rows and the keyed
  // TransactionsSection refetches account metadata, each without remounting
  // or discarding its entry draft.
  const [accountSignals, setAccountSignals] = useState<Record<string, number>>(
    {},
  );
  // Per-household sibling signals. Bank-activity refreshes are driven by
  // definitive connection lifecycle/selection commits; ledger refreshes are
  // driven only by a successful bank-activity confirmation. Keeping them
  // separate means a dismiss never disturbs the transaction feed.
  const [bankActivitySignals, setBankActivitySignals] = useState<
    Record<string, number>
  >({});
  const [ledgerSignals, setLedgerSignals] = useState<Record<string, number>>(
    {},
  );
  const [membershipSignals, setMembershipSignals] = useState<
    Record<string, number>
  >({});
  const [inboxSignals, setInboxSignals] = useState<Record<string, number>>({});
  // A scoped reader may disagree with the collection briefly. Recheck the
  // collection once per denied scope, then wait for an explicit user retry;
  // otherwise remounting the reader after every successful list response
  // creates an unbounded read/reconcile loop.
  const [unavailableScopes, setUnavailableScopes] = useState<Set<string>>(
    () => new Set(),
  );
  const deniedScopesRef = useRef<Set<string>>(new Set());
  const [navigationState, setNavigationState] = useState<{
    requestedId: string | null;
    householdId: string | null;
    scope: string;
    visited: HouseholdPage[];
    accountIntent: PendingAccountCreate | null;
  }>({
    requestedId: null,
    householdId: null,
    scope: '',
    visited: [],
    accountIntent: null,
  });

  const csrfRef = useRef<CsrfToken | null>(csrf);
  const genRef = useRef(0);
  const unmountedRef = useRef(false);
  const ownedRef = useRef<Set<AbortController>>(new Set());
  const listNoticeRef = useRef<HTMLDivElement>(null);
  const createNoticeRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const lastSignalRef = useRef(refreshSignal);
  const queuedSignalRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const onRefreshSettledRef = useRef(onRefreshSettled);

  useEffect(() => {
    csrfRef.current = csrf;
  }, [csrf]);

  useEffect(() => {
    busyRef.current = loading || creating;
    onRefreshSettledRef.current = onRefreshSettled;
  });

  function track(controller: AbortController) {
    ownedRef.current.add(controller);
  }

  function untrack(controller: AbortController) {
    ownedRef.current.delete(controller);
  }

  function isCurrent(generation: number): boolean {
    return !unmountedRef.current && genRef.current === generation;
  }
  function revokeLeftHousehold(id: string): void {
    // A collection read predating the successful leave cannot restore access.
    genRef.current++;
    for (const controller of ownedRef.current) controller.abort();
    setHouseholds(
      (current) => current?.filter((household) => household.id !== id) ?? null,
    );
  }

  async function load(signal: AbortSignal, generation: number) {
    setLoading(true);
    setListError(null);
    try {
      const result = await fetchHouseholds(signal);
      if (!isCurrent(generation) || signal.aborted) return;
      const authorized = new Set(
        result.map((household) => `${household.id}:${household.role}`),
      );
      deniedScopesRef.current = new Set(
        [...deniedScopesRef.current].filter((scope) => authorized.has(scope)),
      );
      setUnavailableScopes((current) => {
        const retained = new Set(
          [...current].filter((scope) => authorized.has(scope)),
        );
        return retained.size === current.size ? current : retained;
      });
      if (loaded) {
        setMembershipSignals((current) => {
          const next = { ...current };
          for (const household of result)
            next[household.id] = (next[household.id] ?? 0) + 1;
          return next;
        });
      }
      setHouseholds(sortHouseholds(result));
      setLoaded(true);
      setListError(null);
      // The refreshed list answers the unknown-outcome check that requested
      // it: clear that notice. Other create notices (validation, success)
      // carry no refresh request and are preserved.
      setCreateNotice((current) => (current?.showRefresh ? null : current));
      setLoading(false);
    } catch (error) {
      if (!isCurrent(generation) || signal.aborted) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message:
                'Could not load your households. Check your connection and refresh the list.',
            });
      if (apiError.status === 401) {
        // An established session ended: the parent runs the confirmed
        // sign-in-again recovery and unmounts this section, clearing it.
        setHouseholds(null);
        setLoaded(false);
        setLoading(false);
        onSessionExpired();
        return;
      }
      setLoading(false);
      if (apiError.timedOut) {
        setListError({
          kind: 'error',
          text: 'Loading your households timed out. Refresh the list to try again.',
        });
        return;
      }
      if (apiError.code === 'NETWORK_ERROR') {
        setListError({ kind: 'error', text: apiError.message });
        return;
      }
      setListError({
        kind: 'error',
        text: apiError.message || 'Could not load your households.',
        correlationId: apiError.correlationId,
      });
    }
  }

  function startLoad(servedSignal: number | null): void {
    const generation = ++genRef.current;
    const controller = new AbortController();
    track(controller);
    void (async () => {
      try {
        await load(controller.signal, generation);
      } finally {
        untrack(controller);
        if (isCurrent(generation)) {
          if (servedSignal !== null) {
            // The serving reload settled: report first so a waiter can
            // proceed, then drain any signal that arrived while busy.
            onRefreshSettledRef.current?.(servedSignal);
          }
          drainQueuedSignal();
        }
      }
    })();
  }

  function drainQueuedSignal(): void {
    if (unmountedRef.current) {
      queuedSignalRef.current = null;
      return;
    }
    const queued = queuedSignalRef.current;
    if (queued === null || queued === lastSignalRef.current) {
      queuedSignalRef.current = null;
      return;
    }
    queuedSignalRef.current = null;
    lastSignalRef.current = queued;
    startLoad(queued);
  }

  useEffect(() => {
    // StrictMode replays setup→cleanup→setup in development: the cleanup
    // aborts the first controller and the generation guard ignores its late
    // continuations, so only the second load can publish state.
    unmountedRef.current = false;
    startLoad(null);
    const owned = ownedRef.current;
    return () => {
      unmountedRef.current = true;
      for (const tracked of owned) tracked.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Invitation acceptance elsewhere (the join flow) bumps refreshSignal so
  // the newly joined household appears without a manual refresh. A signal
  // arriving while a load or creation is busy is queued — never consumed
  // silently — and a second fetch runs after the busy work settles.
  useEffect(() => {
    if (lastSignalRef.current === refreshSignal) return;
    if (busyRef.current) {
      queuedSignalRef.current = refreshSignal;
      return;
    }
    lastSignalRef.current = refreshSignal;
    startLoad(refreshSignal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  useEffect(() => {
    if (listError && listNoticeRef.current) {
      listNoticeRef.current.focus();
    }
  }, [listError]);

  useEffect(() => {
    if (createNotice && createNoticeRef.current) {
      createNoticeRef.current.focus();
    }
  }, [createNotice]);

  function handleRefresh() {
    if (loading || creating) return;
    startLoad(null);
  }
  function handleScopedReadDenied(household: Household) {
    const deniedScope = `${household.id}:${household.role}`;
    if (deniedScopesRef.current.has(deniedScope)) return;
    deniedScopesRef.current.add(deniedScope);
    setUnavailableScopes((current) => new Set(current).add(deniedScope));
    (onHouseholdReconcile ?? handleRefresh)();
  }

  function retryScopedAccess(household: Household) {
    if (loading || creating) return;
    const deniedScope = `${household.id}:${household.role}`;
    deniedScopesRef.current.delete(deniedScope);
    setUnavailableScopes((current) => {
      const next = new Set(current);
      next.delete(deniedScope);
      return next;
    });
    startLoad(null);
  }

  function refreshInbox(householdId: string) {
    setInboxSignals((current) => ({
      ...current,
      [householdId]: (current[householdId] ?? 0) + 1,
    }));
  }

  function handleAccountListCommitted(householdId: string) {
    setAccountSignals((current) => ({
      ...current,
      [householdId]: (current[householdId] ?? 0) + 1,
    }));
  }

  function handleBankActivityChanged(householdId: string) {
    setBankActivitySignals((current) => ({
      ...current,
      [householdId]: (current[householdId] ?? 0) + 1,
    }));
    refreshInbox(householdId);
  }

  function handleLedgerChanged(householdId: string) {
    setLedgerSignals((current) => ({
      ...current,
      [householdId]: (current[householdId] ?? 0) + 1,
    }));
    refreshInbox(householdId);
  }

  async function ensureCsrf(
    signal: AbortSignal,
    generation: number,
  ): Promise<CsrfToken | null> {
    if (csrfRef.current !== null) return csrfRef.current;
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

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (creating || loading) return;
    const generation = genRef.current;
    const localError = validateHouseholdName(name);
    if (localError) {
      setFieldError(localError);
      setCreateNotice({
        kind: 'error',
        text: 'Check the highlighted field.',
      });
      requestAnimationFrame(() => nameInputRef.current?.focus());
      return;
    }
    const controller = new AbortController();
    track(controller);
    setCreating(true);
    setFieldError(undefined);
    setCreatedId(null);
    setCreateNotice(null);
    try {
      const requestCsrf = await ensureCsrf(controller.signal, generation);
      if (!isCurrent(generation) || controller.signal.aborted) return;
      if (requestCsrf === null) {
        setCreateNotice({
          kind: 'error',
          text: 'Security setup is still loading. Wait a moment and retry.',
        });
        return;
      }
      const trimmed = name.trim();
      const created = await postHousehold(
        trimmed,
        requestCsrf,
        controller.signal,
      );
      if (!isCurrent(generation) || controller.signal.aborted) return;
      setHouseholds((current) => sortHouseholds([...(current ?? []), created]));
      setCreatedId(created.id);
      setName('');
      setFieldError(undefined);
      setCreateNotice({
        kind: 'info',
        text: `Household “${created.name}” created. Open it from your households.`,
      });
    } catch (error) {
      if (!isCurrent(generation) || controller.signal.aborted) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message:
                'Could not reach the server. Check your connection and retry.',
            });
      if (apiError.status === 401) {
        setHouseholds(null);
        setLoaded(false);
        onSessionExpired();
        return;
      }
      if (apiError.timedOut) {
        // A timed-out creation may still have completed server-side: never
        // claim failure and never silently resubmit. Keep the name and
        // offer a list refresh to discover the outcome.
        setCreateNotice({
          kind: 'error',
          text: 'Household creation timed out. Its outcome is unknown — refresh the list to check before retrying.',
          showRefresh: true,
        });
        return;
      }
      if (apiError.code === 'CSRF_INVALID') {
        let refreshed = false;
        try {
          const fresh = await fetchCsrf(controller.signal);
          if (!isCurrent(generation) || controller.signal.aborted) return;
          csrfRef.current = fresh;
          onCsrfRefreshed(fresh);
          refreshed = true;
        } catch {
          // The refresh failed; refreshed stays false below.
        }
        if (!isCurrent(generation) || controller.signal.aborted) return;
        setCreateNotice({
          kind: 'error',
          text: refreshed
            ? 'Your security token was refreshed. Review the name and try creating the household again.'
            : 'Your session request was rejected. Reload and try again.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      if (apiError.fieldErrors?.name) {
        // Recoverable validation failure: keep the safe input and
        // associate the server message with the field.
        setFieldError(apiError.fieldErrors.name);
        setCreateNotice({
          kind: 'error',
          text: 'Check the highlighted field.',
          correlationId: apiError.correlationId,
        });
        requestAnimationFrame(() => nameInputRef.current?.focus());
        return;
      }
      if (apiError.code === 'NETWORK_ERROR') {
        setCreateNotice({ kind: 'error', text: apiError.message });
        return;
      }
      setCreateNotice({
        kind: 'error',
        text: apiError.message || 'Household creation could not be completed.',
        correlationId: apiError.correlationId,
      });
    } finally {
      untrack(controller);
      if (isCurrent(generation)) {
        setCreating(false);
        drainQueuedSignal();
      }
    }
  }

  // The create form is only offered against a confirmed membership state:
  // after a successful list response with no active list error. A failed
  // refresh keeps a previously loaded list visible but stale, with creation
  // unavailable until refresh succeeds.
  const showForm = createMode && loaded && listError === null;
  const stale =
    loaded &&
    listError !== null &&
    households !== null &&
    households.length > 0;

  const selectedHousehold =
    route &&
    households?.find((household) => household.id === route.householdId);
  const requestedId = route?.householdId ?? navigationState.requestedId;
  const retainedId =
    route &&
    (route.householdId !== navigationState.requestedId ||
      navigationState.householdId === null)
      ? (selectedHousehold?.id ?? null)
      : navigationState.householdId;
  const controllerHousehold =
    households?.find((household) => household.id === retainedId) ?? null;
  const scope = controllerHousehold
    ? `${controllerHousehold.id}:${controllerHousehold.role}`
    : '';
  const currentPage =
    active && route && controllerHousehold?.id === route.householdId
      ? route.page
      : null;
  const visited =
    navigationState.scope === scope ? navigationState.visited : [];
  const nextVisited =
    currentPage && !visited.includes(currentPage)
      ? [...visited, currentPage]
      : visited;
  // React retries this render before committing any child. Revoked access
  // therefore removes private controllers in the same transition, and a
  // changed role discards all retained drafts and page visits.
  if (
    navigationState.requestedId !== requestedId ||
    navigationState.householdId !== (controllerHousehold?.id ?? null) ||
    navigationState.scope !== scope ||
    navigationState.visited !== nextVisited
  ) {
    setNavigationState({
      requestedId,
      householdId: controllerHousehold?.id ?? null,
      scope,
      visited: nextVisited,
      accountIntent:
        navigationState.scope === scope ? navigationState.accountIntent : null,
    });
  }

  return (
    <>
      {active && (
        <div className="household">
          <h3 id="household-title" className="household-title">
            {createMode
              ? 'Create a household'
              : route
                ? 'Household'
                : 'Your households'}
          </h3>
          {loading && households === null && !listError && (
            <div role="status" aria-live="polite" aria-atomic="true">
              <p>Loading your households…</p>
            </div>
          )}

          {listError && (
            <div
              ref={listNoticeRef}
              tabIndex={-1}
              role="alert"
              className="household-notice household-notice--error"
            >
              <p>{listError.text}</p>
              {listError.correlationId && (
                <p className="household-notice-detail">
                  Reference: {listError.correlationId}
                </p>
              )}
              <button
                type="button"
                className="household-button household-button--secondary"
                onClick={handleRefresh}
                disabled={loading || creating}
              >
                Refresh list
              </button>
            </div>
          )}

          {households !== null &&
            route === null &&
            !createMode &&
            !loading &&
            !listError &&
            households.length === 0 && (
              <div role="status" aria-live="polite" aria-atomic="true">
                <p className="household-empty">
                  You do not belong to a household yet. Use Create household in
                  the menu to get started.
                </p>
              </div>
            )}

          {stale && (
            <p role="status" className="household-stale">
              Showing previously loaded households, which may be out of date.
              Refresh the list to continue.
            </p>
          )}

          {!createMode &&
            route === null &&
            households !== null &&
            households.length > 0 && (
              <ul className="household-list" aria-label="Your households">
                {households.map((household) => (
                  <HouseholdCard
                    key={`${household.id}:${household.role}`}
                    household={household}
                    currentUserId={currentUserId}
                    enabled={
                      !stale &&
                      !loading &&
                      listError === null &&
                      !unavailableScopes.has(
                        `${household.id}:${household.role}`,
                      )
                    }
                    accessUnavailable={unavailableScopes.has(
                      `${household.id}:${household.role}`,
                    )}
                    onRetryAccess={() => retryScopedAccess(household)}
                    refreshSignal={
                      (accountSignals[household.id] ?? 0) +
                      (membershipSignals[household.id] ?? 0)
                    }
                    onSessionExpired={onSessionExpired}
                    onHouseholdAccessChanged={() =>
                      handleScopedReadDenied(household)
                    }
                  />
                ))}
              </ul>
            )}

          {route !== null &&
            households !== null &&
            !loading &&
            !listError &&
            !households.some(
              (household) => household.id === route.householdId,
            ) && (
              <div
                role="status"
                className="household-notice household-notice--warning"
              >
                <p>This household is not available to your account.</p>
                <AppLink to="/households" className="household-page-link">
                  Return to your households
                </AppLink>
              </div>
            )}

          {!createMode &&
            route !== null &&
            households
              ?.filter((household) => household.id === route.householdId)
              .map((household) => (
                <div key={household.id} className="household-context">
                  <AppLink to="/households" className="household-context__back">
                    Households
                  </AppLink>
                  <span aria-hidden="true">/</span>
                  <strong>{household.name}</strong>
                  <span className="household-context__role">
                    {household.role.toLowerCase()}
                  </span>
                </div>
              ))}

          {!createMode &&
            route &&
            controllerHousehold &&
            unavailableScopes.has(scope) &&
            !loading &&
            !listError && (
              <div
                role="status"
                className="household-notice household-notice--warning"
              >
                <p>
                  Private directory and inbox details are unavailable for this
                  household. Refresh access to check again.
                </p>
                <button
                  type="button"
                  className="household-button household-button--secondary"
                  onClick={() => retryScopedAccess(controllerHousehold)}
                >
                  Retry household access
                </button>
              </div>
            )}
          {showForm && (
            <form
              className="household-form"
              onSubmit={(event) => void handleCreate(event)}
              noValidate
            >
              <h4 className="household-form-title">Name your household</h4>
              <div className="household-field">
                <label htmlFor="household-name">Household name</label>
                <input
                  id="household-name"
                  ref={nameInputRef}
                  name="household-name"
                  type="text"
                  autoComplete="off"
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  aria-invalid={Boolean(fieldError)}
                  aria-describedby={
                    fieldError ? 'household-name-error' : 'household-name-hint'
                  }
                  disabled={creating || loading}
                />
                <p id="household-name-hint" className="household-hint">
                  Between 1 and 100 characters. Leading and trailing spaces are
                  removed.
                </p>
                {fieldError && (
                  <p
                    id="household-name-error"
                    role="alert"
                    className="household-error"
                  >
                    {fieldError}
                  </p>
                )}
              </div>
              <button
                type="submit"
                className="household-button"
                disabled={creating || loading}
              >
                {creating ? 'Creating…' : 'Create household'}
              </button>
            </form>
          )}

          {createMode && createNotice && (
            <div
              ref={createNoticeRef}
              tabIndex={-1}
              role={createNotice.kind === 'error' ? 'alert' : 'status'}
              aria-live="polite"
              className={`household-notice household-notice--${createNotice.kind}`}
            >
              <p>{createNotice.text}</p>
              {createNotice.correlationId && (
                <p className="household-notice-detail">
                  Reference: {createNotice.correlationId}
                </p>
              )}
              {createNotice.showRefresh && (
                <button
                  type="button"
                  className="household-button household-button--secondary"
                  onClick={handleRefresh}
                  disabled={loading || creating}
                >
                  Refresh list
                </button>
              )}
            </div>
          )}
          {createMode &&
            createdId &&
            households?.some((household) => household.id === createdId) && (
              <AppLink
                to={householdPath(createdId, 'overview')}
                className="household-card__open"
              >
                Open your new household <Icon name="arrow-right" />
              </AppLink>
            )}
          {createMode && households?.length ? (
            <AppLink to="/households" className="household-page-link">
              View your households
            </AppLink>
          ) : null}
        </div>
      )}
      {headerInboxTarget &&
        active &&
        !createMode &&
        currentPage &&
        controllerHousehold &&
        !loading &&
        !unavailableScopes.has(scope) &&
        !listError && (
          <HouseholdInbox
            key={scope}
            target={headerInboxTarget}
            household={controllerHousehold}
            page={currentPage}
            refreshSignal={
              (inboxSignals[controllerHousehold.id] ?? 0) +
              (bankActivitySignals[controllerHousehold.id] ?? 0) +
              (ledgerSignals[controllerHousehold.id] ?? 0)
            }
            onSessionExpired={onSessionExpired}
            onHouseholdAccessChanged={() =>
              handleScopedReadDenied(controllerHousehold)
            }
          />
        )}
      {controllerHousehold &&
        active &&
        route?.page === 'accounts' &&
        route.householdId === controllerHousehold.id && (
          <FinancialAccountsSection
            retainedCreate={
              navigationState.scope === scope
                ? navigationState.accountIntent
                : null
            }
            onRetainedCreateChange={(pending) =>
              setNavigationState((current) =>
                current.scope === scope
                  ? { ...current, accountIntent: pending }
                  : current,
              )
            }
            key={`${scope}:accounts`}
            household={controllerHousehold}
            csrf={csrf}
            onCsrfRefreshed={onCsrfRefreshed}
            onSessionExpired={onSessionExpired}
            onHouseholdAccessChanged={onHouseholdReconcile ?? handleRefresh}
            authorityConfirmed={!stale && !loading && listError === null}
            onAccountListCommitted={() =>
              handleAccountListCommitted(controllerHousehold.id)
            }
            accountsRefreshSignal={accountSignals[controllerHousehold.id] ?? 0}
          />
        )}
      {controllerHousehold && visited.includes('connections') && (
        <FinancialConnectionsSection
          key={`${scope}:connections`}
          active={
            active &&
            route?.page === 'connections' &&
            route.householdId === controllerHousehold.id
          }
          household={controllerHousehold}
          csrf={csrf}
          onCsrfRefreshed={onCsrfRefreshed}
          onSessionExpired={onSessionExpired}
          onHouseholdAccessChanged={onHouseholdReconcile ?? handleRefresh}
          authorityConfirmed={!stale && !loading && listError === null}
          onAccountListCommitted={() =>
            handleAccountListCommitted(controllerHousehold.id)
          }
          onBankActivityChanged={() =>
            handleBankActivityChanged(controllerHousehold.id)
          }
        />
      )}
      {controllerHousehold && visited.includes('bank-activity') && (
        <BankActivitySection
          key={`${scope}:bank-activity`}
          active={
            active &&
            route?.page === 'bank-activity' &&
            route.householdId === controllerHousehold.id
          }
          household={controllerHousehold}
          csrf={csrf}
          onCsrfRefreshed={onCsrfRefreshed}
          onSessionExpired={onSessionExpired}
          onHouseholdAccessChanged={onHouseholdReconcile ?? handleRefresh}
          authorityConfirmed={!stale && !loading && listError === null}
          refreshSignal={bankActivitySignals[controllerHousehold.id] ?? 0}
          onLedgerChanged={() => handleLedgerChanged(controllerHousehold.id)}
          onInboxChanged={() => refreshInbox(controllerHousehold.id)}
        />
      )}
      {controllerHousehold &&
        active &&
        route?.page === 'members' &&
        route.householdId === controllerHousehold.id && (
          <MembersSection
            household={controllerHousehold}
            currentUserId={currentUserId}
            csrf={csrf}
            onCsrfRefreshed={onCsrfRefreshed}
            onSessionExpired={onSessionExpired}
            onHouseholdAccessChanged={onHouseholdReconcile ?? handleRefresh}
            onRosterCommitted={() =>
              setMembershipSignals((current) => ({
                ...current,
                [controllerHousehold.id]:
                  (current[controllerHousehold.id] ?? 0) + 1,
              }))
            }
            onSelfLeft={() => revokeLeftHousehold(controllerHousehold.id)}
          />
        )}
      {controllerHousehold &&
        active &&
        route?.page === 'invitations' &&
        route.householdId === controllerHousehold.id &&
        controllerHousehold.role === 'OWNER' && (
          <InvitationSection
            household={controllerHousehold}
            csrf={csrf}
            onCsrfRefreshed={onCsrfRefreshed}
            onSessionExpired={onSessionExpired}
            onHouseholdAccessChanged={onHouseholdReconcile ?? handleRefresh}
          />
        )}
      {active &&
        controllerHousehold &&
        route?.householdId === controllerHousehold.id &&
        route?.page === 'invitations' &&
        controllerHousehold.role !== 'OWNER' && (
          <p role="status">Invitations are available to household owners.</p>
        )}
      {controllerHousehold && (
        <TransactionsSection
          key={`${scope}:finance`}
          household={controllerHousehold}
          page={
            active && route?.householdId === controllerHousehold.id
              ? route.page
              : 'inactive'
          }
          currentUserId={currentUserId}
          csrf={csrf}
          onCsrfRefreshed={onCsrfRefreshed}
          onSessionExpired={onSessionExpired}
          onHouseholdAccessChanged={onHouseholdReconcile ?? handleRefresh}
          authorityConfirmed={!stale && !loading && listError === null}
          accountsRefreshSignal={accountSignals[controllerHousehold.id] ?? 0}
          ledgerRefreshSignal={ledgerSignals[controllerHousehold.id] ?? 0}
          membershipRefreshSignal={
            membershipSignals[controllerHousehold.id] ?? 0
          }
        />
      )}
    </>
  );
}
