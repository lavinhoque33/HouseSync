import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  ApiError,
  completeConnectionLink,
  fetchConnectionAccounts,
  fetchConnectionOperation,
  fetchCsrf,
  fetchFinancialConnection,
  fetchFinancialConnections,
  postAccountSelection,
  postConnectionDisconnect,
  postConnectionReconnect,
  startConnectionLink,
  type CompleteLinkBody,
  type ConnectionAccountMapping,
  type ConnectionOperation,
  type CsrfToken,
  type FinancialConnection,
  type Household,
  type LinkAttempt,
} from '../auth/client';
import {
  canReconnect,
  isLinkAttemptExpired,
  isTerminalOperationState,
} from './connections';
import {
  createPlaidHandler,
  loadPlaidLinkScript,
  type PlaidLinkExitError,
  type PlaidLinkHandler,
} from './plaid-link';

interface Notice {
  kind: 'info' | 'error' | 'warning';
  text: string;
  correlationId?: string | undefined;
  showRefresh?: boolean | undefined;
  /**
   * Whether presenting this notice moves keyboard focus to it. Only
   * user-triggered actionable/error outcomes set this: background poll
   * iterations and quiet refetches announce through the live region without
   * yanking focus from the viewer's current control.
   */
  focus?: boolean | undefined;
}

interface FinancialConnectionsSectionProps {
  household: Household;
  /** Visited but inactive destinations retain memory-only intents without DOM or requests. */
  active?: boolean;
  csrf: CsrfToken | null;
  onCsrfRefreshed: (token: CsrfToken) => void;
  onSessionExpired: () => void;
  onHouseholdAccessChanged: () => void;
  authorityConfirmed: boolean;
  /**
   * Called once per committed account-selection save (CONNECTED accounts
   * admitted or removed) so the sibling transaction selector refetches its
   * account metadata without remounting or discarding its entry draft.
   * Link/reconnect/disconnect never call this: they change no account list.
   */
  onAccountListCommitted?: (() => void) | undefined;
  /**
   * Called after a definitive committed connection lifecycle or selection
   * outcome, so the sibling bank-activity inbox refetches its connection list
   * and observations without remounting or discarding its drafts. Only
   * SUCCEEDED durable operations and committed selections fire it; ambiguous
   * or failed outcomes do not.
   */
  onBankActivityChanged?: (() => void) | undefined;
}

/**
 * Bounded durable-operation polling: one poll every two seconds, at most
 * thirty polls (about a minute), then a manual "check again" affordance.
 * Unknown-outcome states are terminal and never re-polled automatically.
 */
export const CONNECTION_POLL_INTERVAL_MS = 2000;
export const CONNECTION_POLL_MAX_ATTEMPTS = 30;

type TrackedOperation =
  | { kind: 'link'; operation: ConnectionOperation }
  | { kind: 'reconnect'; operation: ConnectionOperation }
  | { kind: 'disconnect'; operation: ConnectionOperation };

/** Memory-only link attempt plus its durable completion key. */
interface PendingAttempt {
  attempt: LinkAttempt;
  completeKey: string;
}

interface PendingDisconnect {
  connectionId: string;
  version: number;
}

function stateLabel(state: FinancialConnection['state']): string {
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

function operationErrorText(
  errorCode: string | null,
  kind: TrackedOperation['kind'],
): string {
  if (errorCode === 'EXCHANGE_UNKNOWN' || errorCode === 'RECOVERY_UNKNOWN') {
    return 'The bank step finished with an unknown result. If the bank shows HouseSync access, remove it in the bank\u2019s own tools before starting a new link.';
  }
  if (errorCode === 'REMOVAL_UNKNOWN') {
    return 'The bank removal finished with an unknown result. If the bank still shows HouseSync access, remove it in the bank\u2019s own tools, then retry disconnect.';
  }
  if (errorCode === 'MEMBERSHIP_REMOVED') {
    return 'Household membership changed while the request was running. Refresh the connections list before retrying.';
  }
  if (errorCode === 'ALREADY_LINKED') {
    return 'This bank access is already linked to the household. Refresh the connections list.';
  }
  if (
    errorCode === 'GENERATION_SUPERSEDED' ||
    errorCode === 'CONNECTION_INACTIVE'
  ) {
    return 'The connection changed while the request was running. Refresh the connections list before retrying.';
  }
  if (kind === 'disconnect') {
    return 'Disconnection could not be confirmed. Refresh the connections list before retrying.';
  }
  return 'The bank step could not be completed. Refresh the connections list before retrying.';
}

export function FinancialConnectionsSection({
  household,
  active = true,
  csrf,
  onCsrfRefreshed,
  onSessionExpired,
  onHouseholdAccessChanged,
  authorityConfirmed,
  onAccountListCommitted,
  onBankActivityChanged,
}: FinancialConnectionsSectionProps) {
  const [connections, setConnections] = useState<FinancialConnection[] | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  /** In-memory link attempt awaiting the bank step; never persisted. */
  const [pendingAttempt, setPendingAttempt] = useState<PendingAttempt | null>(
    null,
  );
  const [tracked, setTracked] = useState<TrackedOperation | null>(null);
  const [pollCount, setPollCount] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [mappings, setMappings] = useState<
    Record<string, ConnectionAccountMapping[]>
  >({});
  const [mappingsBusy, setMappingsBusy] = useState<Record<string, boolean>>({});
  const [mappingsError, setMappingsError] = useState<Record<string, string>>(
    {},
  );
  /**
   * Dirty-draft-safe selection state: the checkbox draft per connection and
   * whether the viewer changed it since the last server read. Background
   * refetches refresh the mapping rows but never rewrite a dirty draft.
   */
  const [drafts, setDrafts] = useState<
    Record<string, { ids: string[]; dirty: boolean }>
  >({});
  const [selectionBusy, setSelectionBusy] = useState<Record<string, boolean>>(
    {},
  );
  const [pendingSelection, setPendingSelection] = useState<{
    connectionId: string;
    expectedVersion: number;
    accountMappingIds: string[];
    key: string;
  } | null>(null);
  /**
   * Durable reconnect request: the exact connection, version, and
   * idempotency key survive an unknown outcome so the retry replays the
   * identical request instead of minting a new key or reading a fresh
   * version. Cleared only on a definitive outcome.
   */
  const [pendingReconnect, setPendingReconnect] = useState<{
    connectionId: string;
    expectedVersion: number;
    key: string;
  } | null>(null);
  /**
   * Durable disconnect request, same contract as the reconnect above.
   * Terminal FAILED/OUTCOME_UNKNOWN outcomes use a fresh request through
   * the tracked operation instead; this covers only unknown transport
   * outcomes.
   */
  const [pendingDisconnectRequest, setPendingDisconnectRequest] = useState<{
    connectionId: string;
    expectedVersion: number;
    key: string;
  } | null>(null);
  /**
   * Pre-optimistic connection state per disconnect, restored when a
   * terminal disconnect outcome arrives but the confirming list refetch
   * fails — so a failed refetch never strands a misleading DISCONNECTING
   * label without a visible refresh path.
   */
  const disconnectPrevStateRef = useRef<
    Record<string, FinancialConnection['state']>
  >({});
  const [pendingDisconnect, setPendingDisconnect] =
    useState<PendingDisconnect | null>(null);
  const [disconnectBusy, setDisconnectBusy] = useState(false);

  const csrfRef = useRef(csrf);
  const generationRef = useRef(0);
  const unmountedRef = useRef(false);
  const controllersRef = useRef<Set<AbortController>>(new Set());
  const linkBusyRef = useRef(false);
  const completeBusyRef = useRef(false);
  const selectionBusyRef = useRef<Set<string>>(new Set());
  const disconnectBusyRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollControllerRef = useRef<AbortController | null>(null);
  /** Same-key retry for a start whose outcome is unknown. */
  const startKeyRef = useRef<string | null>(null);
  /**
   * Memory-only public token retained until its completion reaches a known
   * outcome, so an unknown-outcome completion can retry with the same key.
   * Erased on known outcome, attempt expiry, sign-out, or unmount. UPDATE
   * completions never store anything here.
   */
  const publicTokenRef = useRef<string | null>(null);
  /** Exact memory-only completion body; provider callbacks cannot overwrite it. */
  const completionBodyRef = useRef<CompleteLinkBody | null>(null);
  const [completionRetryable, setCompletionRetryable] = useState(false);
  const plaidHandlerRef = useRef<PlaidLinkHandler | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const disconnectConfirmRef = useRef<HTMLDivElement>(null);
  const disconnectTriggerRef = useRef<HTMLButtonElement | null>(null);
  const resumeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [previousActive, setPreviousActive] = useState(active);
  if (previousActive !== active) {
    setPreviousActive(active);
    if (!active) {
      // Exact retry requests and drafts survive; only interrupted request
      // locks are released before this destination can become active again.
      setLinkBusy(false);
      setDisconnectBusy(false);
      setSelectionBusy({});
      setMappingsBusy({});
    }
  }
  const pendingWrite =
    pendingSelection !== null ||
    pendingReconnect !== null ||
    pendingDisconnectRequest !== null ||
    completionRetryable;

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

  function stopPolling() {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollControllerRef.current?.abort();
    pollControllerRef.current = null;
  }

  function destroyPlaidHandler() {
    try {
      plaidHandlerRef.current?.destroy();
    } catch {
      // A provider teardown failure must not break local cleanup.
    }
    plaidHandlerRef.current = null;
  }

  function clearSensitiveState() {
    // Tokens live only in component memory: dropping the attempt, the
    // retained public token, and the handler erases them. Nothing is
    // written to storage, the URL, or logs.
    setPendingAttempt(null);
    setCompletionRetryable(false);
    startKeyRef.current = null;
    publicTokenRef.current = null;
    completionBodyRef.current = null;
    destroyPlaidHandler();
  }

  function toApiError(error: unknown, fallback: string): ApiError {
    return error instanceof ApiError
      ? error
      : new ApiError({ status: 0, code: 'NETWORK_ERROR', message: fallback });
  }

  function sortConnections(
    values: FinancialConnection[],
  ): FinancialConnection[] {
    return [...values].sort((left, right) => {
      const leftTime = Date.parse(left.createdAt);
      const rightTime = Date.parse(right.createdAt);
      if (
        !Number.isNaN(leftTime) &&
        !Number.isNaN(rightTime) &&
        leftTime !== rightTime
      ) {
        return leftTime - rightTime;
      }
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
  }

  async function load(generation: number, controller: AbortController) {
    setLoading(true);
    setNotice(null);
    try {
      const page = await fetchFinancialConnections(
        household.id,
        controller.signal,
      );
      if (!current(generation) || controller.signal.aborted) return;
      setConnections(sortConnections(page.items));
      setLoading(false);
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError = toApiError(
        error,
        'Could not load your bank connections.',
      );
      setLoading(false);
      if (apiError.status === 401) {
        setConnections(null);
        clearSensitiveState();
        onSessionExpired();
        return;
      }
      if (apiError.code === 'HOUSEHOLD_NOT_FOUND') {
        setConnections(null);
        clearSensitiveState();
        onHouseholdAccessChanged();
        return;
      }
      setNotice({
        kind: 'error',
        text: apiError.timedOut
          ? 'Loading bank connections timed out. Refresh to try again.'
          : apiError.message || 'Could not load your bank connections.',
        correlationId: apiError.correlationId,
        showRefresh: true,
      });
    }
  }

  function refresh() {
    if (loading || linkBusyRef.current || disconnectBusyRef.current) return;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    track(controller);
    void load(generation, controller).finally(() => untrack(controller));
  }

  /**
   * Background list refetch after a durable outcome. It replaces only the
   * connection rows: mapping rows stay unless clean, and dirty checkbox
   * drafts are never rewritten. Returns whether the list converged; callers
   * deciding visible recovery use the result. Authorization failures still
   * reconcile upward instead of staying silent.
   */
  async function refetchListQuietly(generation: number): Promise<boolean> {
    const controller = new AbortController();
    track(controller);
    try {
      const page = await fetchFinancialConnections(
        household.id,
        controller.signal,
      );
      if (!current(generation) || controller.signal.aborted) return false;
      setConnections(sortConnections(page.items));
      return true;
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return false;
      const apiError = toApiError(error, 'Could not reach the server.');
      if (
        apiError.status === 401 ||
        apiError.code === 'HOUSEHOLD_NOT_FOUND' ||
        apiError.code === 'FINANCIAL_CONNECTION_NOT_FOUND'
      ) {
        handleAuthFailure(apiError, generation);
        return false;
      }
      // Silent otherwise by design: the outcome notice already explains the
      // state and offers refresh, so a background error must not steal focus.
      return false;
    } finally {
      untrack(controller);
    }
  }

  useEffect(() => {
    if (!active) {
      unmountedRef.current = true;
      generationRef.current += 1;
      stopPolling();
      destroyPlaidHandler();
      for (const owned of controllersRef.current) owned.abort();
      linkBusyRef.current = false;
      completeBusyRef.current = false;
      disconnectBusyRef.current = false;
      selectionBusyRef.current.clear();
      return;
    }
    unmountedRef.current = false;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    track(controller);
    void load(generation, controller).finally(() => untrack(controller));
    const controllers = controllersRef.current;
    return () => {
      unmountedRef.current = true;
      generationRef.current += 1;
      stopPolling();
      destroyPlaidHandler();
      for (const owned of controllers) owned.abort();
    };
    // Household identity is fixed for this keyed component instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    // Focus moves only for notices the viewer triggered. Background poll
    // iterations and quiet refetches announce through the live region and
    // must not yank focus from the current control.
    if (notice?.focus) noticeRef.current?.focus();
  }, [notice]);

  useEffect(() => {
    if (pendingDisconnect) disconnectConfirmRef.current?.focus();
  }, [pendingDisconnect]);

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

  function handleAuthFailure(
    apiError: ApiError,
    generation: number,
    focusNotice = true,
  ) {
    if (!current(generation)) return true;
    if (apiError.status === 401) {
      setConnections(null);
      clearSensitiveState();
      onSessionExpired();
      return true;
    }
    if (apiError.code === 'HOUSEHOLD_NOT_FOUND') {
      setConnections(null);
      clearSensitiveState();
      onHouseholdAccessChanged();
      return true;
    }
    if (apiError.code === 'FINANCIAL_CONNECTION_NOT_FOUND') {
      setNotice({
        kind: 'warning',
        text: 'This bank connection is no longer available to you. Refresh the list to see the current connections.',
        correlationId: apiError.correlationId,
        showRefresh: true,
        focus: focusNotice,
      });
      return true;
    }
    return false;
  }

  /**
   * Run an idempotent POST with CSRF, automatically retrying exactly once
   * with a refreshed token after a CSRF rejection. The retry re-invokes
   * `work` with the fresh token while the closure keeps the identical
   * idempotency key and body, so the replay is exact. Only the transport
   * POST reruns here — provider Link is opened by the caller and is never
   * re-entered by this helper, so no second bank step can result.
   */
  async function withCsrfRetry<T>(
    generation: number,
    controller: AbortController,
    work: (token: CsrfToken) => Promise<T>,
  ): Promise<{ value: T } | null> {
    const token = await ensureCsrf(generation, controller.signal);
    if (!current(generation) || controller.signal.aborted) return null;
    if (!token) {
      setNotice({
        kind: 'error',
        text: 'Security setup is still loading. Retry the same request.',
        focus: true,
      });
      return null;
    }
    try {
      return { value: await work(token) };
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return null;
      const apiError = toApiError(error, 'Could not reach the server.');
      if (handleAuthFailure(apiError, generation)) return null;
      if (apiError.code !== 'CSRF_INVALID') throw apiError;
      const refreshed = await refreshCsrf(generation, controller.signal);
      if (!current(generation) || controller.signal.aborted) return null;
      const fresh = refreshed ? csrfRef.current : null;
      if (!fresh) {
        setNotice({
          kind: 'error',
          text: 'Your secure request expired. Reload before retrying.',
          correlationId: apiError.correlationId,
          focus: true,
        });
        return null;
      }
      try {
        return { value: await work(fresh) };
      } catch (retryError) {
        if (!current(generation) || controller.signal.aborted) return null;
        const retryApiError = toApiError(
          retryError,
          'Could not reach the server.',
        );
        // A second CSRF rejection is a definitive failure, not a loop:
        // surface it rather than retrying again.
        if (handleAuthFailure(retryApiError, generation)) return null;
        throw retryApiError;
      }
    }
  }

  /** Start a NEW link attempt, then open the bank step for it. */
  async function startLink() {
    if (linkBusyRef.current || !authorityConfirmed || pendingWrite) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    track(controller);
    linkBusyRef.current = true;
    setLinkBusy(true);
    setNotice(null);
    try {
      const key = startKeyRef.current ?? crypto.randomUUID();
      startKeyRef.current = key;
      const outcome = await withCsrfRetry(generation, controller, (token) =>
        startConnectionLink(household.id, key, token, controller.signal),
      );
      if (outcome === null) return;
      if (!current(generation) || controller.signal.aborted) return;
      startKeyRef.current = null;
      const pending: PendingAttempt = {
        attempt: outcome.value,
        completeKey: crypto.randomUUID(),
      };
      setPendingAttempt(pending);
      await openBankStep(pending, generation, controller);
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError = toApiError(error, 'Could not reach the server.');
      if (
        apiError.timedOut ||
        apiError.code === 'NETWORK_ERROR' ||
        apiError.code === 'FINANCE_BUSY'
      ) {
        // Unknown outcome: the same start key is retained, so the retry
        // below replays rather than duplicating the attempt.
        setNotice({
          kind: 'warning',
          text: 'Starting bank linking has an unknown outcome. Retry the same request safely, or refresh the list before retrying.',
          correlationId: apiError.correlationId,
          focus: true,
        });
        return;
      }
      startKeyRef.current = null;
      setNotice({
        kind: 'error',
        text: apiError.message || 'Bank linking could not be started.',
        correlationId: apiError.correlationId,
        focus: true,
      });
    } finally {
      untrack(controller);
      linkBusyRef.current = false;
      if (current(generation)) setLinkBusy(false);
    }
  }

  /**
   * Open the provider bank step for a memory-held attempt. The loader runs
   * only here — after the explicit gesture that created the attempt — and
   * the handler is destroyed on unmount or before any newer attempt.
   */
  async function openBankStep(
    pending: PendingAttempt,
    generation: number,
    controller: AbortController,
  ) {
    // Never open the provider step with an expired attempt: clear the
    // in-memory attempt and direct the viewer to start over.
    if (isLinkAttemptExpired(pending.attempt)) {
      if (!current(generation) || controller.signal.aborted) return;
      clearSensitiveState();
      setNotice({
        kind: 'error',
        text: 'This link attempt expired. Start a new one.',
        focus: true,
      });
      return;
    }
    destroyPlaidHandler();
    const { attempt } = pending;
    let plaid;
    try {
      plaid = await loadPlaidLinkScript();
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      setNotice({
        kind: 'error',
        text:
          error instanceof Error
            ? error.message
            : 'The bank-link helper could not be loaded.',
      });
      resumeTriggerRef.current?.focus();
      return;
    }
    if (!current(generation) || controller.signal.aborted) return;
    const flow = attempt.flow;
    let handler: PlaidLinkHandler;
    try {
      handler = createPlaidHandler(plaid, {
        // The token crosses into the provider only; this module keeps no
        // copy beyond the attempt already held in component memory.
        token: attempt.linkToken,
        onSuccess: (publicToken) => {
          // Retain the public token in memory only until its completion
          // reaches a known outcome; it is erased in handleLinkSuccess and
          // never stored, logged, or placed in a URL.
          if (completionBodyRef.current !== null) return;
          if (flow === 'NEW') publicTokenRef.current = publicToken;
          void handleLinkSuccess(pending, flow);
        },
        onExit: (exitError) => {
          handleLinkExit(exitError, generation);
        },
      });
    } catch {
      if (!current(generation)) return;
      setNotice({
        kind: 'error',
        text: 'The bank step could not be opened. Resume when ready.',
      });
      resumeTriggerRef.current?.focus();
      return;
    }
    plaidHandlerRef.current = handler;
    try {
      handler.open();
    } catch {
      destroyPlaidHandler();
      if (!current(generation) || controller.signal.aborted) return;
      setNotice({
        kind: 'error',
        text: 'The bank step could not be opened. Resume when ready — the attempt is kept in this tab only.',
      });
      resumeTriggerRef.current?.focus();
    }
  }

  function resumeBankStep() {
    if (!pendingAttempt || linkBusyRef.current || pendingWrite) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    track(controller);
    setNotice(null);
    void openBankStep(pendingAttempt, generation, controller).finally(() =>
      untrack(controller),
    );
  }

  async function handleLinkSuccess(
    pending: PendingAttempt,
    flow: LinkAttempt['flow'],
    replay = false,
  ) {
    if (
      completeBusyRef.current ||
      (completionBodyRef.current !== null && !replay)
    )
      return;
    const generation = generationRef.current;
    const controller = new AbortController();
    track(controller);
    completeBusyRef.current = true;
    setLinkBusy(true);
    setNotice(null);
    try {
      // NEW sends the public token exactly once per completion key; UPDATE
      // completes with an empty body and never forwards the provider value.
      // An absent NEW token blocks the POST entirely: sending an empty
      // token would fail validation and could consume the attempt, so the
      // viewer resumes the bank step or starts over instead.
      const retained = publicTokenRef.current;
      if (flow === 'NEW' && !retained) {
        if (!current(generation) || controller.signal.aborted) return;
        setCompletionRetryable(false);
        setNotice({
          kind: 'error',
          text: 'The bank step returned an incomplete response, so nothing was sent. Resume the bank step, or start a new link if it stays incomplete.',
          focus: true,
        });
        return;
      }
      const body: CompleteLinkBody =
        completionBodyRef.current ??
        (flow === 'NEW' ? { publicToken: retained ?? '' } : {});
      completionBodyRef.current = body;
      // Mark this exact attempt replayable before any bytes can reach the
      // server. Route deactivation aborts the response, not the capability.
      setCompletionRetryable(true);
      const outcome = await withCsrfRetry(generation, controller, (token) =>
        completeConnectionLink(
          household.id,
          pending.attempt.id,
          body,
          pending.completeKey,
          token,
          controller.signal,
        ),
      );
      if (outcome === null) {
        if (current(generation) && !controller.signal.aborted) {
          setCompletionRetryable(false);
          completionBodyRef.current = null;
        }
        return;
      }
      if (!current(generation) || controller.signal.aborted) return;
      // The completion reached a known outcome: erase the in-memory public
      // token and the attempt now that the durable operation carries it.
      publicTokenRef.current = null;
      completionBodyRef.current = null;
      setCompletionRetryable(false);
      setPendingAttempt(null);
      destroyPlaidHandler();
      const operation = outcome.value;
      setTracked({
        kind: flow === 'NEW' ? 'link' : 'reconnect',
        operation,
      });
      if (isTerminalOperationState(operation.state)) {
        // Terminal in the direct completion response: the viewer triggered
        // this chain, so the outcome takes focus.
        void handleTerminalOperation(
          flow === 'NEW' ? 'link' : 'reconnect',
          operation,
          generation,
          true,
        );
      } else {
        void pollOperation(
          flow === 'NEW' ? 'link' : 'reconnect',
          operation,
          0,
          generation,
        );
      }
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError = toApiError(error, 'Could not reach the server.');
      if (
        apiError.timedOut ||
        apiError.code === 'NETWORK_ERROR' ||
        apiError.code === 'FINANCE_BUSY'
      ) {
        // Unknown outcome with the same completion key retained — and, for
        // NEW links, the same in-memory public token — so the retry below
        // returns the persisted operation instead of exchanging twice.
        setCompletionRetryable(true);
        setNotice({
          kind: 'warning',
          text: 'Completing bank linking has an unknown outcome. Retry the same request safely — it cannot link twice.',
          correlationId: apiError.correlationId,
          focus: true,
        });
        return;
      }
      if (apiError.code === 'LINK_ATTEMPT_EXPIRED') {
        publicTokenRef.current = null;
        completionBodyRef.current = null;
        setCompletionRetryable(false);
        setPendingAttempt(null);
        destroyPlaidHandler();
        setNotice({
          kind: 'error',
          text: 'This link attempt expired. Start a new one.',
          correlationId: apiError.correlationId,
          focus: true,
        });
        return;
      }
      if (
        apiError.code === 'CONNECTION_NOT_READY' ||
        apiError.code === 'CONNECTION_DISCONNECTED'
      ) {
        publicTokenRef.current = null;
        completionBodyRef.current = null;
        setCompletionRetryable(false);
        setPendingAttempt(null);
        destroyPlaidHandler();
        setNotice({
          kind: 'error',
          text:
            apiError.code === 'CONNECTION_DISCONNECTED'
              ? 'The connection is no longer active. Link again from the start.'
              : 'The connection changed while linking. Refresh the connections list before retrying.',
          correlationId: apiError.correlationId,
          showRefresh: true,
          focus: true,
        });
        return;
      }
      // A definitive rejection did not commit this completion. The viewer
      // may resume the bank step instead of replaying a rejected body.
      completionBodyRef.current = null;
      setCompletionRetryable(false);
      setNotice({
        kind: 'error',
        text: apiError.message || 'Bank linking could not be completed.',
        correlationId: apiError.correlationId,
        focus: true,
      });
    } finally {
      untrack(controller);
      completeBusyRef.current = false;
      if (current(generation)) setLinkBusy(false);
    }
  }

  function handleLinkExit(
    exitError: PlaidLinkExitError | null,
    generation: number,
  ) {
    if (!current(generation)) return;
    if (exitError === null) {
      // The viewer closed the bank step: the attempt stays resumable in
      // this tab only, and manual finance keeps working.
      setNotice({
        kind: 'info',
        text: 'The bank step was closed before finishing. Resume when ready — your manual accounts and transactions are unaffected.',
      });
    } else {
      setNotice({
        kind: 'error',
        text: 'The bank step ended before finishing. Resume when ready — your manual accounts and transactions are unaffected.',
      });
    }
    resumeTriggerRef.current?.focus();
  }

  /** Retry the in-memory completion with its original key (unknown outcome). */
  function retryComplete() {
    if (!pendingAttempt || !completionRetryable || completeBusyRef.current) {
      return;
    }
    void handleLinkSuccess(pendingAttempt, pendingAttempt.attempt.flow, true);
  }

  async function pollOperation(
    kind: TrackedOperation['kind'],
    operation: ConnectionOperation,
    attempts: number,
    generation: number,
  ) {
    stopPolling();
    if (!current(generation)) return;
    if (attempts >= CONNECTION_POLL_MAX_ATTEMPTS) {
      setPollCount(attempts);
      setNotice({
        kind: 'info',
        text: 'The request is still working. Check again in a moment — its result is kept safely.',
      });
      return;
    }
    setPollCount(attempts + 1);
    const controller = new AbortController();
    pollControllerRef.current = controller;
    track(controller);
    pollTimerRef.current = setTimeout(() => {
      pollTimerRef.current = null;
      void (async () => {
        try {
          const next = await fetchConnectionOperation(
            operation.statusUrl,
            controller.signal,
          );
          untrack(controller);
          if (pollControllerRef.current === controller) {
            pollControllerRef.current = null;
          }
          if (!current(generation) || controller.signal.aborted) return;
          setTracked({ kind, operation: next });
          if (isTerminalOperationState(next.state)) {
            // Terminal via background poll: announce without yanking focus.
            void handleTerminalOperation(kind, next, generation, false);
          } else {
            void pollOperation(kind, next, attempts + 1, generation);
          }
        } catch (error) {
          untrack(controller);
          if (pollControllerRef.current === controller) {
            pollControllerRef.current = null;
          }
          if (!current(generation) || controller.signal.aborted) return;
          if (error instanceof DOMException && error.name === 'AbortError') {
            return;
          }
          const apiError = toApiError(error, 'Could not reach the server.');
          if (handleAuthFailure(apiError, generation, false)) return;
          // A failed poll never discards the last known status: keep the
          // tracked operation and offer a manual check. No focus move: this
          // is a background iteration, announced via the live region.
          setNotice({
            kind: 'warning',
            text: apiError.timedOut
              ? 'Checking the request timed out. Its last known result is kept below — check again.'
              : 'Checking the request was interrupted. Its last known result is kept below — check again.',
            correlationId: apiError.correlationId,
          });
        }
      })();
    }, CONNECTION_POLL_INTERVAL_MS);
  }

  function checkTrackedAgain() {
    if (!tracked || isTerminalOperationState(tracked.operation.state)) return;
    const generation = generationRef.current;
    void pollOperation(tracked.kind, tracked.operation, 0, generation);
  }

  /**
   * Present a terminal durable outcome. `focusNotice` is true only for
   * outcomes delivered synchronously in a response to the viewer's own
   * request; background poll deliveries announce through the live region
   * without moving focus. Disconnect failures additionally reconcile the
   * optimistic DISCONNECTING label: when the confirming list refetch fails,
   * the pre-optimistic state is restored and a visible refresh path is
   * offered, so no misleading inaccessible state is left behind.
   */
  async function handleTerminalOperation(
    kind: TrackedOperation['kind'],
    operation: ConnectionOperation,
    generation: number,
    focusNotice: boolean,
  ) {
    stopPolling();
    if (operation.state === 'SUCCEEDED') {
      delete disconnectPrevStateRef.current[operation.connectionId ?? ''];
      const successText =
        kind === 'disconnect'
          ? 'The bank connection is disconnected. Its admitted history stays in your private accounts.'
          : kind === 'reconnect'
            ? 'The bank connection is active again.'
            : 'The bank connection is ready. Choose which accounts to admit below.';
      setNotice({
        kind: 'info',
        text: successText,
        focus: focusNotice,
      });
      // The definitive commit also changes what the sibling bank-activity
      // inbox can show (new connection, reconnect, or confirmed disconnect);
      // its signal is fired only for this SUCCEEDED outcome.
      onBankActivityChanged?.();
      // The durable outcome stands on its own: never repeat the operation.
      // But the list still needs its confirming read — when that fetch
      // fails, keep the honest local rows and offer a visible refresh path
      // instead of leaving success copy over a stale list with no recovery.
      const refetched = await refetchListQuietly(generation);
      if (!current(generation)) return;
      if (!refetched) {
        setNotice({
          kind: 'info',
          text: `${successText} Refresh the connections list to confirm the current state.`,
          showRefresh: true,
          focus: focusNotice,
        });
      }
      return;
    }
    if (operation.state === 'OUTCOME_UNKNOWN') {
      // Durable ambiguity: preserve it with recovery guidance, never claim
      // failure or keep polling as if more waiting would resolve it.
      const refetched = await refetchListQuietly(generation);
      if (!current(generation)) return;
      if (kind === 'disconnect' && !refetched) {
        restorePreDisconnectState(operation.connectionId);
      }
      setNotice({
        kind: 'warning',
        text: operationErrorText(operation.errorCode, kind),
        showRefresh: kind === 'disconnect' && !refetched ? true : undefined,
        focus: focusNotice || (kind === 'disconnect' && !refetched),
      });
      return;
    }
    const refetched = await refetchListQuietly(generation);
    if (!current(generation)) return;
    if (kind === 'disconnect' && !refetched) {
      restorePreDisconnectState(operation.connectionId);
    }
    setNotice({
      kind: 'error',
      text: operationErrorText(operation.errorCode, kind),
      showRefresh: kind === 'disconnect' && !refetched ? true : undefined,
      focus: focusNotice || (kind === 'disconnect' && !refetched),
    });
  }

  /** Restore the state captured before the optimistic DISCONNECTING label. */
  function restorePreDisconnectState(connectionId: string | null) {
    if (!connectionId) return;
    const previous = disconnectPrevStateRef.current[connectionId];
    delete disconnectPrevStateRef.current[connectionId];
    if (!previous) return;
    setConnections((current) =>
      (current ?? []).map((entry) =>
        entry.id === connectionId ? { ...entry, state: previous } : entry,
      ),
    );
  }

  async function loadMappings(connection: FinancialConnection) {
    const id = connection.id;
    if (mappingsBusy[id]) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    track(controller);
    setMappingsBusy((current) => ({ ...current, [id]: true }));
    setMappingsError((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    try {
      const page = await fetchConnectionAccounts(
        household.id,
        id,
        controller.signal,
      );
      if (!current(generation) || controller.signal.aborted) return;
      setMappings((current) => ({ ...current, [id]: page.items }));
      setDrafts((current) => {
        const existing = current[id];
        // A dirty viewer draft always wins over a background read.
        if (existing?.dirty) return current;
        return {
          ...current,
          [id]: {
            ids: page.items
              .filter((item) => item.selected)
              .map((item) => item.mappingId),
            dirty: false,
          },
        };
      });
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError = toApiError(error, 'Could not reach the server.');
      if (handleAuthFailure(apiError, generation)) return;
      setMappingsError((current) => ({
        ...current,
        [id]:
          apiError.timedOut || apiError.code === 'NETWORK_ERROR'
            ? 'Loading discovered accounts timed out. Try again.'
            : apiError.message || 'Could not load the discovered accounts.',
      }));
    } finally {
      untrack(controller);
      if (current(generation)) {
        setMappingsBusy((current) => ({ ...current, [id]: false }));
      }
    }
  }

  function toggleExpanded(connection: FinancialConnection) {
    const id = connection.id;
    const willOpen = !(expanded[id] ?? false);
    setExpanded((current) => ({ ...current, [id]: !current[id] }));
    if (willOpen && mappings[id] === undefined) {
      void loadMappings(connection);
    }
  }

  function toggleDraft(connectionId: string, mappingId: string) {
    if (pendingWrite) return;
    setDrafts((current) => {
      const existing = current[connectionId] ?? { ids: [], dirty: false };
      const selected = existing.ids.includes(mappingId);
      return {
        ...current,
        [connectionId]: {
          ids: selected
            ? existing.ids.filter((id) => id !== mappingId)
            : [...existing.ids, mappingId],
          dirty: true,
        },
      };
    });
  }

  async function saveSelection(
    connection: FinancialConnection,
    replay?: {
      accountMappingIds: string[];
      expectedVersion: number;
      key: string;
    },
  ) {
    const id = connection.id;
    if (
      selectionBusyRef.current.has(id) ||
      !authorityConfirmed ||
      (pendingWrite &&
        (replay !== pendingSelection ||
          pendingReconnect !== null ||
          pendingDisconnectRequest !== null ||
          completionRetryable))
    )
      return;
    const draft = drafts[id] ?? { ids: [], dirty: false };
    const generation = generationRef.current;
    const controller = new AbortController();
    track(controller);
    selectionBusyRef.current.add(id);
    setSelectionBusy((current) => ({ ...current, [id]: true }));
    setNotice(null);
    // Canonical order for the durable fingerprint: sorted unique IDs. The
    // key, version, and IDs are fixed before the request so an
    // unknown-outcome retry replays the exact same selection.
    const accountMappingIds =
      replay?.accountMappingIds ?? [...new Set(draft.ids)].sort();
    const expectedVersion = replay?.expectedVersion ?? connection.version;
    const key = replay?.key ?? crypto.randomUUID();
    setPendingSelection({
      connectionId: id,
      expectedVersion,
      accountMappingIds,
      key,
    });
    try {
      const outcome = await withCsrfRetry(generation, controller, (token) =>
        postAccountSelection(
          household.id,
          id,
          expectedVersion,
          accountMappingIds,
          key,
          token,
          controller.signal,
        ),
      );
      if (outcome === null) {
        if (current(generation) && !controller.signal.aborted)
          setPendingSelection(null);
        return;
      }
      if (!current(generation) || controller.signal.aborted) return;
      setPendingSelection(null);
      const result = outcome.value;
      setConnections((current) =>
        (current ?? []).map((entry) =>
          entry.id === id ? { ...entry, version: result.version } : entry,
        ),
      );
      // Adopt the server selection as the new clean draft; the admitted
      // CONNECTED accounts refresh the sibling selector through the commit
      // signal without remounting the transaction form.
      setDrafts((current) => ({
        ...current,
        [id]: { ids: [...accountMappingIds], dirty: false },
      }));
      setMappings((current) => {
        const rows = current[id];
        if (!rows) return current;
        const chosen = new Set(accountMappingIds);
        return {
          ...current,
          [id]: rows.map((row) => ({
            ...row,
            selected: chosen.has(row.mappingId),
          })),
        };
      });
      setNotice({
        kind: 'info',
        text:
          result.accounts.length === 0
            ? 'Account admission paused. Already recorded history is preserved.'
            : `Admitting ${result.accounts.length === 1 ? '1 account' : `${result.accounts.length} accounts`}. Already recorded history is preserved.`,
        focus: true,
      });
      onAccountListCommitted?.();
      // A committed selection changes the admitted account set the inbox can
      // attribute observations to, so the sibling inbox refetches too.
      onBankActivityChanged?.();
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError = toApiError(error, 'Could not reach the server.');
      if (
        apiError.timedOut ||
        apiError.code === 'NETWORK_ERROR' ||
        apiError.code === 'FINANCE_BUSY'
      ) {
        // Unknown outcome: retain the exact key, version, and IDs so the
        // retry replays the identical request instead of recording a
        // second one.
        setPendingSelection({
          connectionId: id,
          expectedVersion,
          accountMappingIds,
          key,
        });
        setNotice({
          kind: 'warning',
          text: 'Saving the selection has an unknown outcome. Retry the same selection safely, or refresh before retrying.',
          correlationId: apiError.correlationId,
          focus: true,
        });
        return;
      }
      setPendingSelection(null);
      if (apiError.code === 'RESOURCE_VERSION_CONFLICT') {
        // The connection changed elsewhere: refetch rows and version but
        // keep the dirty draft so the viewer reviews, not loses, their
        // choices.
        setNotice({
          kind: 'warning',
          text: 'The connection changed. Review your selection against the current list before saving again.',
          correlationId: apiError.correlationId,
          focus: true,
        });
        await refetchConnectionAndMappings(connection, generation);
        return;
      }
      if (
        apiError.code === 'CONNECTION_NOT_READY' ||
        apiError.code === 'CONNECTION_DISCONNECTED'
      ) {
        setNotice({
          kind: 'error',
          text:
            apiError.code === 'CONNECTION_DISCONNECTED'
              ? 'The connection is no longer active, so the selection cannot be saved. Link again from the start.'
              : 'The connection is not ready for selection right now. Refresh the connections list before retrying.',
          correlationId: apiError.correlationId,
          showRefresh: true,
          focus: true,
        });
        return;
      }
      setPendingSelection(null);
      setNotice({
        kind: 'error',
        text: apiError.message || 'Account selection could not be saved.',
        correlationId: apiError.correlationId,
        focus: true,
      });
    } finally {
      untrack(controller);
      selectionBusyRef.current.delete(id);
      if (current(generation)) {
        setSelectionBusy((current) => ({ ...current, [id]: false }));
      }
    }
  }

  function retrySelection() {
    if (!pendingSelection) return;
    const connection = connections?.find(
      (entry) => entry.id === pendingSelection.connectionId,
    );
    if (!connection) return;
    // Exact replay of the retained request: IDs, version, and key.
    void saveSelection(connection, pendingSelection);
  }

  async function refetchConnectionAndMappings(
    connection: FinancialConnection,
    generation: number,
  ) {
    const controller = new AbortController();
    track(controller);
    try {
      const [detail, page] = await Promise.all([
        fetchFinancialConnection(
          household.id,
          connection.id,
          controller.signal,
        ),
        fetchConnectionAccounts(household.id, connection.id, controller.signal),
      ]);
      if (!current(generation) || controller.signal.aborted) return;
      setConnections((current) =>
        (current ?? []).map((entry) =>
          entry.id === detail.id ? detail : entry,
        ),
      );
      setMappings((current) => ({ ...current, [detail.id]: page.items }));
      // Draft stays dirty by design: the viewer re-saves explicitly.
    } catch {
      // Silent: the version-conflict notice already offers the path forward.
    } finally {
      untrack(controller);
    }
  }

  /** Start an UPDATE (reconnect) attempt for an eligible connection. */
  function startReconnect(connection: FinancialConnection) {
    if (linkBusyRef.current || !authorityConfirmed || pendingWrite) return;
    if (!canReconnect(connection.state)) return;
    void submitReconnect(connection.id, connection.version);
  }

  /**
   * Submit the reconnect POST. The key, version, and connection ID are fixed
   * before the request; an unknown outcome retains them in
   * `pendingReconnect` so the retry replays the identical request rather
   * than minting a new key or reading a fresh version. An explicit key
   * replays a retained request exactly.
   */
  async function submitReconnect(
    connectionId: string,
    expectedVersion: number,
    explicitKey?: string,
  ) {
    if (
      linkBusyRef.current ||
      !authorityConfirmed ||
      (pendingWrite &&
        (!pendingReconnect ||
          explicitKey !== pendingReconnect.key ||
          connectionId !== pendingReconnect.connectionId ||
          expectedVersion !== pendingReconnect.expectedVersion ||
          pendingSelection !== null ||
          pendingDisconnectRequest !== null ||
          completionRetryable))
    )
      return;
    const generation = generationRef.current;
    const controller = new AbortController();
    track(controller);
    linkBusyRef.current = true;
    setLinkBusy(true);
    setNotice(null);
    const key = explicitKey ?? crypto.randomUUID();
    setPendingReconnect({ connectionId, expectedVersion, key });
    try {
      const outcome = await withCsrfRetry(generation, controller, (token) =>
        postConnectionReconnect(
          household.id,
          connectionId,
          expectedVersion,
          key,
          token,
          controller.signal,
        ),
      );
      if (outcome === null) {
        if (current(generation) && !controller.signal.aborted)
          setPendingReconnect(null);
        return;
      }
      if (!current(generation) || controller.signal.aborted) return;
      setPendingReconnect(null);
      const pending: PendingAttempt = {
        attempt: outcome.value,
        completeKey: crypto.randomUUID(),
      };
      setPendingAttempt(pending);
      setNotice({
        kind: 'info',
        text: 'Reconnection started. Complete the bank step to finish.',
        focus: true,
      });
      await openBankStep(pending, generation, controller);
      void refetchListQuietly(generation);
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError = toApiError(error, 'Could not reach the server.');
      if (
        apiError.timedOut ||
        apiError.code === 'NETWORK_ERROR' ||
        apiError.code === 'FINANCE_BUSY'
      ) {
        // Unknown outcome: retain the exact request for the durable retry
        // below instead of generating a new one.
        setPendingReconnect({ connectionId, expectedVersion, key });
        setNotice({
          kind: 'warning',
          text: 'Starting reconnection has an unknown outcome. Retry the same request safely — it cannot reconnect twice.',
          correlationId: apiError.correlationId,
          focus: true,
        });
        return;
      }
      setPendingReconnect(null);
      if (apiError.code === 'RESOURCE_VERSION_CONFLICT') {
        setNotice({
          kind: 'warning',
          text: 'The connection changed. Refresh the connections list before retrying.',
          correlationId: apiError.correlationId,
          showRefresh: true,
          focus: true,
        });
        return;
      }
      setNotice({
        kind: 'error',
        text: apiError.message || 'Bank reconnection could not be started.',
        correlationId: apiError.correlationId,
        focus: true,
      });
    } finally {
      untrack(controller);
      linkBusyRef.current = false;
      if (current(generation)) setLinkBusy(false);
    }
  }

  /** Retry the retained reconnect request with its original key and body. */
  function retryReconnect() {
    if (!pendingReconnect || linkBusyRef.current) return;
    void submitReconnect(
      pendingReconnect.connectionId,
      pendingReconnect.expectedVersion,
      pendingReconnect.key,
    );
  }

  function openDisconnectConfirm(
    connection: FinancialConnection,
    trigger: HTMLButtonElement,
  ) {
    if (
      pendingDisconnect !== null ||
      disconnectBusyRef.current ||
      linkBusyRef.current ||
      pendingWrite ||
      loading ||
      !authorityConfirmed
    ) {
      return;
    }
    disconnectTriggerRef.current = trigger;
    setPendingDisconnect({
      connectionId: connection.id,
      version: connection.version,
    });
  }

  function cancelDisconnectConfirm() {
    setPendingDisconnect(null);
    const trigger = disconnectTriggerRef.current;
    disconnectTriggerRef.current = null;
    trigger?.focus();
  }

  function handleDisconnectConfirmKeyDown(
    event: KeyboardEvent<HTMLDivElement>,
  ) {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelDisconnectConfirm();
    }
  }

  function confirmDisconnect() {
    const pending = pendingDisconnect;
    if (!pending || disconnectBusyRef.current || pendingWrite) return;
    setPendingDisconnect(null);
    disconnectTriggerRef.current = null;
    void submitDisconnect(pending.connectionId, pending.version);
  }

  /**
   * Submit the disconnect POST. The key, version, and connection ID are
   * fixed before the request; an unknown outcome retains them in
   * `pendingDisconnectRequest` so the retry replays the identical request.
   * An explicit key replays a retained request exactly.
   */
  async function submitDisconnect(
    connectionId: string,
    version: number,
    explicitKey?: string,
  ) {
    if (
      disconnectBusyRef.current ||
      !authorityConfirmed ||
      (pendingWrite &&
        (!pendingDisconnectRequest ||
          explicitKey !== pendingDisconnectRequest.key ||
          connectionId !== pendingDisconnectRequest.connectionId ||
          version !== pendingDisconnectRequest.expectedVersion ||
          pendingSelection !== null ||
          pendingReconnect !== null ||
          completionRetryable))
    )
      return;
    const generation = generationRef.current;
    const controller = new AbortController();
    track(controller);
    disconnectBusyRef.current = true;
    setDisconnectBusy(true);
    setNotice(null);
    const key = explicitKey ?? crypto.randomUUID();
    setPendingDisconnectRequest({
      connectionId,
      expectedVersion: version,
      key,
    });
    try {
      const outcome = await withCsrfRetry(generation, controller, (token) =>
        postConnectionDisconnect(
          household.id,
          connectionId,
          version,
          key,
          token,
          controller.signal,
        ),
      );
      if (outcome === null) {
        if (current(generation) && !controller.signal.aborted)
          setPendingDisconnectRequest(null);
        return;
      }
      if (!current(generation) || controller.signal.aborted) return;
      setPendingDisconnectRequest(null);
      // Capture the pre-optimistic state so a later failed confirmation can
      // restore it instead of stranding a DISCONNECTING label.
      const previous = connections?.find((entry) => entry.id === connectionId);
      if (previous) {
        disconnectPrevStateRef.current[connectionId] = previous.state;
      }
      // Disconnecting takes effect locally at once: show DISCONNECTING
      // immediately, then confirm through the durable operation poll.
      setConnections((current) =>
        (current ?? []).map((entry) =>
          entry.id === connectionId
            ? { ...entry, state: 'DISCONNECTING' as const }
            : entry,
        ),
      );
      const operation = outcome.value;
      setTracked({ kind: 'disconnect', operation });
      // The confirm dialog closed: land focus on the stable section heading
      // (the row trigger unmounts once DISCONNECTING renders). The status
      // notices below announce through the live region without focus.
      headingRef.current?.focus();
      if (isTerminalOperationState(operation.state)) {
        void handleTerminalOperation(
          'disconnect',
          operation,
          generation,
          false,
        );
      } else {
        setNotice({
          kind: 'info',
          text: 'Disconnecting. Bank imports stop at once; the bank removal is being confirmed.',
        });
        void pollOperation('disconnect', operation, 0, generation);
      }
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError = toApiError(error, 'Could not reach the server.');
      if (
        apiError.timedOut ||
        apiError.code === 'NETWORK_ERROR' ||
        apiError.code === 'FINANCE_BUSY'
      ) {
        // Unknown outcome: retain the exact request for the durable retry
        // below instead of generating a new one.
        setPendingDisconnectRequest({
          connectionId,
          expectedVersion: version,
          key,
        });
        setNotice({
          kind: 'warning',
          text: 'Disconnecting has an unknown outcome. Retry the same request safely, or refresh the connections list to check before retrying.',
          correlationId: apiError.correlationId,
          focus: true,
        });
        return;
      }
      setPendingDisconnectRequest(null);
      if (apiError.code === 'CONNECTION_DISCONNECTED') {
        setNotice({
          kind: 'info',
          text: 'This connection is already disconnected.',
          correlationId: apiError.correlationId,
          showRefresh: true,
          focus: true,
        });
        void refetchListQuietly(generation);
        return;
      }
      setNotice({
        kind: 'error',
        text: apiError.message || 'Bank disconnection could not be started.',
        correlationId: apiError.correlationId,
        focus: true,
      });
    } finally {
      untrack(controller);
      disconnectBusyRef.current = false;
      if (current(generation)) setDisconnectBusy(false);
    }
  }

  /** Retry the retained disconnect request with its original key and body. */
  function retryPendingDisconnect() {
    if (!pendingDisconnectRequest || disconnectBusyRef.current) return;
    void submitDisconnect(
      pendingDisconnectRequest.connectionId,
      pendingDisconnectRequest.expectedVersion,
      pendingDisconnectRequest.key,
    );
  }

  function retryDisconnect() {
    if (pendingWrite) return;
    const operation = tracked?.operation;
    if (tracked?.kind !== 'disconnect' || !operation?.connectionId) return;
    const connection = connections?.find(
      (entry) => entry.id === operation.connectionId,
    );
    if (!connection) {
      refresh();
      return;
    }
    void submitDisconnect(connection.id, connection.version);
  }

  const busy = loading || linkBusy || disconnectBusy;
  const resumable = pendingAttempt !== null && !linkBusy;
  const trackedActive =
    tracked !== null && !isTerminalOperationState(tracked.operation.state);

  if (!active) return null;
  return (
    <section
      className="finance-accounts"
      aria-labelledby={`finance-connections-${household.id}`}
    >
      <div className="finance-accounts-heading">
        <div>
          <p className="eyebrow">Private to you</p>
          <h4
            ref={headingRef}
            tabIndex={-1}
            id={`finance-connections-${household.id}`}
          >
            Bank connections
          </h4>
        </div>
        <span className="privacy-chip">Connection details private</span>
      </div>
      <p className="finance-helper">
        Only you can see these connections, including other household owners.
        Linking chooses which accounts to admit. Synced activity arrives in your
        private bank-activity inbox; nothing reaches the ledger until you
        confirm it, and no balance is inferred.
      </p>

      {!authorityConfirmed && (
        <p role="status" className="household-stale">
          Refresh the household before changing bank connections.
        </p>
      )}

      {loading && connections === null && (
        <p role="status" aria-live="polite">
          Loading your bank connections…
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
              Refresh connections
            </button>
          )}
        </div>
      )}

      {tracked && (
        <div
          role="status"
          aria-live="polite"
          className="finance-pending-request"
        >
          <p>
            {tracked.kind === 'disconnect'
              ? `Disconnection ${operationStatusText(tracked.operation)}.`
              : `Bank linking ${operationStatusText(tracked.operation)}.`}
            {tracked.operation.errorCode &&
              tracked.operation.state === 'OUTCOME_UNKNOWN' &&
              ' See the guidance above.'}
          </p>
          {trackedActive && (
            <div className="finance-account-actions">
              <button
                type="button"
                className="household-button household-button--secondary"
                disabled={!trackedActive}
                onClick={checkTrackedAgain}
              >
                Check again{pollCount > 0 ? ` (${pollCount})` : ''}
              </button>
            </div>
          )}
          {tracked.kind === 'disconnect' &&
            (tracked.operation.state === 'FAILED' ||
              tracked.operation.state === 'OUTCOME_UNKNOWN') && (
              <div className="finance-account-actions">
                <button
                  type="button"
                  className="household-button"
                  disabled={busy || pendingWrite || !authorityConfirmed}
                  onClick={retryDisconnect}
                >
                  Retry disconnect
                </button>
              </div>
            )}
        </div>
      )}

      {pendingAttempt && (
        <div className="finance-pending-request" role="status">
          <p>
            {pendingAttempt.attempt.flow === 'NEW'
              ? 'A bank-link attempt is waiting for the bank step. It lives in this tab only.'
              : 'A bank-reconnect attempt is waiting for the bank step. It lives in this tab only.'}
          </p>
          <div className="finance-account-actions">
            <button
              ref={resumeTriggerRef}
              type="button"
              className="household-button"
              disabled={!resumable || pendingWrite || !authorityConfirmed}
              onClick={resumeBankStep}
            >
              {pendingAttempt.attempt.flow === 'NEW'
                ? 'Resume bank step'
                : 'Resume reconnect step'}
            </button>
            {completionRetryable && (
              <button
                type="button"
                className="household-button household-button--secondary"
                disabled={!resumable || !authorityConfirmed}
                onClick={retryComplete}
                title="Retry only when completing left an unknown outcome"
              >
                Retry completion
              </button>
            )}
          </div>
        </div>
      )}

      {connections !== null && connections.length === 0 && !loading && (
        <p className="finance-empty">
          No bank connections yet. Linking is optional — manual accounts keep
          working either way.
        </p>
      )}

      {connections !== null && connections.length > 0 && (
        <ul className="finance-account-list" aria-label="Your bank connections">
          {connections.map((connection) => {
            const id = connection.id;
            const isOpen = expanded[id] ?? false;
            const rows = mappings[id];
            const draft = drafts[id] ?? { ids: [], dirty: false };
            const rowsBusy = mappingsBusy[id] ?? false;
            const rowsError = mappingsError[id];
            const saving = selectionBusy[id] ?? false;
            return (
              <li
                key={id}
                className={`finance-account-card${
                  connection.state === 'DISCONNECTED' ||
                  connection.state === 'SUSPENDED'
                    ? ' finance-account-card--archived'
                    : ''
                }`}
              >
                <div className="finance-account-summary">
                  <div>
                    <p className="finance-account-name">
                      {connection.environment === 'PRODUCTION'
                        ? 'Live bank connection'
                        : 'Test bank connection'}
                    </p>
                    <p className="household-meta">
                      {stateLabel(connection.state)} ·{' '}
                      {connection.environment === 'PRODUCTION'
                        ? 'Live'
                        : 'Sandbox'}
                    </p>
                  </div>
                  <span className="privacy-chip">Private</span>
                </div>

                <div className="finance-account-actions">
                  <button
                    type="button"
                    className="household-button household-button--secondary"
                    disabled={busy}
                    aria-expanded={isOpen}
                    onClick={() => toggleExpanded(connection)}
                  >
                    {isOpen ? 'Hide accounts' : 'Choose accounts'}
                  </button>
                  {canReconnect(connection.state) && (
                    <button
                      type="button"
                      className="household-button household-button--secondary"
                      disabled={busy || pendingWrite || !authorityConfirmed}
                      onClick={() => void startReconnect(connection)}
                    >
                      Reconnect
                    </button>
                  )}
                  {connection.state !== 'DISCONNECTED' &&
                    connection.state !== 'DISCONNECTING' && (
                      <button
                        type="button"
                        className="household-button household-button--secondary"
                        disabled={busy || pendingWrite || !authorityConfirmed}
                        onClick={(event) =>
                          openDisconnectConfirm(connection, event.currentTarget)
                        }
                      >
                        Disconnect
                      </button>
                    )}
                </div>

                {isOpen && (
                  <div className="finance-connection-accounts">
                    {rowsBusy && rows === undefined && (
                      <p role="status" aria-live="polite">
                        Loading discovered accounts…
                      </p>
                    )}
                    {rowsError && (
                      <div
                        role="alert"
                        className="household-notice household-notice--error"
                      >
                        <p>{rowsError}</p>
                        <button
                          type="button"
                          className="household-button household-button--secondary"
                          disabled={busy}
                          onClick={() => void loadMappings(connection)}
                        >
                          Try again
                        </button>
                      </div>
                    )}
                    {rows !== undefined && rows.length === 0 && (
                      <p className="finance-empty">
                        No accounts were discovered for this connection yet.
                      </p>
                    )}
                    {rows !== undefined && rows.length > 0 && (
                      <fieldset className="finance-account-options">
                        <legend>
                          Choose which accounts to admit. New accounts stay
                          paused until you select them.
                        </legend>
                        <ul className="finance-account-option-list">
                          {rows.map((row) => {
                            const checked = draft.ids.includes(row.mappingId);
                            const disabled =
                              saving ||
                              linkBusy ||
                              disconnectBusy ||
                              pendingWrite ||
                              !authorityConfirmed ||
                              !row.eligible;
                            return (
                              <li key={row.mappingId}>
                                <label
                                  className="finance-account-option"
                                  htmlFor={`connection-account-${row.mappingId}`}
                                >
                                  <input
                                    id={`connection-account-${row.mappingId}`}
                                    type="checkbox"
                                    checked={checked}
                                    disabled={disabled}
                                    onChange={() =>
                                      toggleDraft(id, row.mappingId)
                                    }
                                  />
                                  <span>
                                    <span className="finance-account-name">
                                      {row.name}
                                    </span>{' '}
                                    <span className="household-meta">
                                      {accountKindLabel(row.kind)} ·{' '}
                                      {accountCurrencyLabel(row.currency)}
                                      {row.localAccountId ? ' · Admitted' : ''}
                                      {!row.eligible && row.exclusionReason
                                        ? ` · Not eligible (${humanExclusionReason(row.exclusionReason)})`
                                        : ''}
                                      {!row.eligible && !row.exclusionReason
                                        ? ' · Not eligible'
                                        : ''}
                                    </span>
                                  </span>
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                        <div className="finance-account-actions">
                          <button
                            type="button"
                            className="household-button"
                            disabled={
                              saving ||
                              linkBusy ||
                              disconnectBusy ||
                              pendingWrite ||
                              !authorityConfirmed
                            }
                            onClick={() => void saveSelection(connection)}
                          >
                            {saving
                              ? 'Saving selection…'
                              : 'Save account selection'}
                          </button>
                        </div>
                        {draft.dirty && (
                          <p role="status" className="finance-helper">
                            Unsaved changes. Saving admits only the selected
                            accounts; pausing keeps already recorded history.
                          </p>
                        )}
                      </fieldset>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {pendingSelection && (
        <div className="finance-pending-request">
          <p>
            An earlier account selection still has an unknown result. Retry the
            exact same selection with its original key, or refresh the list
            first.
          </p>
          <div className="finance-account-actions">
            <button
              type="button"
              className="household-button"
              disabled={busy || !authorityConfirmed}
              onClick={retrySelection}
            >
              Retry same selection
            </button>
            <button
              type="button"
              className="household-button household-button--secondary"
              disabled={busy}
              onClick={refresh}
            >
              Refresh connections
            </button>
          </div>
        </div>
      )}

      {pendingReconnect && (
        <div className="finance-pending-request">
          <p>
            An earlier reconnection still has an unknown result. Retry the exact
            same request with its original key and version, or refresh the list
            first.
          </p>
          <div className="finance-account-actions">
            <button
              type="button"
              className="household-button"
              disabled={busy || !authorityConfirmed}
              onClick={retryReconnect}
            >
              Retry same reconnect request
            </button>
            <button
              type="button"
              className="household-button household-button--secondary"
              disabled={busy}
              onClick={refresh}
            >
              Refresh connections
            </button>
          </div>
        </div>
      )}

      {pendingDisconnectRequest && (
        <div className="finance-pending-request">
          <p>
            An earlier disconnection still has an unknown result. Retry the
            exact same request with its original key and version, or refresh the
            list first.
          </p>
          <div className="finance-account-actions">
            <button
              type="button"
              className="household-button"
              disabled={busy || !authorityConfirmed}
              onClick={retryPendingDisconnect}
            >
              Retry same disconnect request
            </button>
            <button
              type="button"
              className="household-button household-button--secondary"
              disabled={busy}
              onClick={refresh}
            >
              Refresh connections
            </button>
          </div>
        </div>
      )}

      {pendingDisconnect && (
        <div
          ref={disconnectConfirmRef}
          tabIndex={-1}
          role="group"
          aria-label="Confirm bank disconnection"
          className="household-notice household-notice--warning finance-status-confirm"
          onKeyDown={handleDisconnectConfirmKeyDown}
        >
          <p>
            Disconnect this bank connection? Imports stop at once. Already
            recorded history is preserved, and the bank removal is confirmed
            separately. This cannot be undone — reconnecting starts a new
            connection.
          </p>
          <div className="finance-account-actions">
            <button
              type="button"
              className="household-button"
              disabled={busy || pendingWrite}
              onClick={confirmDisconnect}
            >
              Disconnect bank
            </button>
            <button
              type="button"
              className="household-button household-button--secondary"
              disabled={busy}
              onClick={cancelDisconnectConfirm}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {connections !== null && (
        <div className="finance-create-form">
          <h5>Link a bank</h5>
          <p className="finance-helper">
            Opens the bank step in this tab. Bank credentials stay with the
            bank; HouseSync keeps only the connection needed to admit the
            accounts you choose.
          </p>
          <button
            type="button"
            className="household-button"
            disabled={
              busy ||
              pendingWrite ||
              pendingAttempt !== null ||
              !authorityConfirmed
            }
            onClick={() => void startLink()}
          >
            {linkBusy ? 'Starting bank link…' : 'Link a bank'}
          </button>
        </div>
      )}
    </section>
  );
}

function operationStatusText(operation: ConnectionOperation): string {
  switch (operation.state) {
    case 'PENDING':
      return 'is working';
    case 'SUCCEEDED':
      return 'is complete';
    case 'FAILED':
      return 'could not be completed';
    case 'OUTCOME_UNKNOWN':
      return 'has an unknown result';
  }
}

function accountKindLabel(kind: ConnectionAccountMapping['kind']): string {
  // A null kind marks an ineligible provider account; the row stays
  // disabled and the exclusion reason below explains why.
  if (kind === null) return 'Unknown account type';
  switch (kind) {
    case 'CHECKING':
      return 'Checking';
    case 'SAVINGS':
      return 'Savings';
    case 'CREDIT_CARD':
      return 'Credit card';
  }
}

function accountCurrencyLabel(
  currency: ConnectionAccountMapping['currency'],
): string {
  // Same null-classification contract as the account kind above.
  if (currency === null) return 'Unknown currency';
  return currency;
}

function humanExclusionReason(reason: string): string {
  switch (reason) {
    case 'UNSUPPORTED_KIND':
      return 'unsupported account type';
    case 'UNSUPPORTED_CURRENCY':
      return 'unsupported currency';
    default:
      return 'currently ineligible';
  }
}
