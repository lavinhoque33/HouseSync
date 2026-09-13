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
}

function formatCreatedAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  try {
    return parsed.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return value;
  }
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

  async function load(signal: AbortSignal, generation: number) {
    setLoading(true);
    setListError(null);
    try {
      const result = await fetchHouseholds(signal);
      if (!isCurrent(generation) || signal.aborted) return;
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
      setName('');
      setFieldError(undefined);
      setCreateNotice({
        kind: 'info',
        text: `Household “${created.name}” created.`,
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
  const showForm = loaded && listError === null;
  const stale =
    loaded &&
    listError !== null &&
    households !== null &&
    households.length > 0;

  return (
    <div className="household">
      <h3 id="household-title" className="household-title">
        Households
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
        !loading &&
        !listError &&
        households.length === 0 && (
          <div role="status" aria-live="polite" aria-atomic="true">
            <p className="household-empty">
              You do not belong to a household yet. Create your first household
              below.
            </p>
          </div>
        )}

      {stale && (
        <p role="status" className="household-stale">
          Showing previously loaded households, which may be out of date.
          Refresh the list to continue.
        </p>
      )}

      {households !== null && households.length > 0 && (
        <ul className="household-list" aria-label="Your households">
          {households.map((household) => (
            <li key={household.id} className="household-card">
              <p className="household-name">{household.name}</p>
              <p className="household-meta">Role: {household.role}</p>
              <p className="household-meta">
                Created:{' '}
                <time dateTime={household.createdAt}>
                  {formatCreatedAt(household.createdAt)}
                </time>
              </p>
              {household.role === 'OWNER' && (
                <InvitationSection
                  household={household}
                  csrf={csrf}
                  onCsrfRefreshed={onCsrfRefreshed}
                  onSessionExpired={onSessionExpired}
                  onHouseholdAccessChanged={handleRefresh}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {showForm && (
        <form
          className="household-form"
          onSubmit={(event) => void handleCreate(event)}
          noValidate
        >
          <h4 className="household-form-title">Create a household</h4>
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

      {createNotice && (
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
    </div>
  );
}
