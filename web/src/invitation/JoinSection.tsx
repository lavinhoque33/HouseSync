import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ApiError,
  fetchCsrf,
  postInvitationAccept,
  postInvitationPreview,
  type CsrfToken,
  type Household,
  type InvitationPreview,
} from '../auth/client';
import type { PendingInvite } from './route';

interface JoinNotice {
  kind: 'info' | 'error' | 'warning';
  text: string;
  correlationId?: string | undefined;
}

export interface JoinSectionProps {
  invite: PendingInvite | null;
  joinActive: boolean;
  joinInvalid: boolean;
  csrf: CsrfToken | null;
  user: SafeUserLite | null;
  onCsrfRefreshed: (token: CsrfToken) => void;
  onSessionExpired: () => void;
  onInviteCleared: () => void;
  onLeaveJoin: () => void;
  onHouseholdsChanged: () => void;
  /**
   * Ordered-reconciliation contract with the household collection.
   * `reconcileVersion` is the latest requested reload; `reconcileSettled`
   * is the latest version whose reload settled. After an accept timeout
   * the flow requests reconciliation and enables the explicit idempotent
   * retry only once the requested version settles.
   */
  reconcileVersion?: number | undefined;
  reconcileSettled?: number | undefined;
  onRequestReconcile?: (() => void) | undefined;
  authenticatedRequestsReady?: boolean | undefined;
}

interface SafeUserLite {
  id: string;
  email: string;
}

type PreviewState = 'idle' | 'loading' | 'ready' | 'terminal' | 'error';

function formatInstant(value: string): string {
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

function credential(invite: PendingInvite) {
  return { invitationId: invite.invitationId, secret: invite.secret };
}

export function JoinSection({
  invite,
  joinActive,
  joinInvalid,
  csrf,
  user,
  onCsrfRefreshed,
  onSessionExpired,
  onInviteCleared,
  onLeaveJoin,
  onHouseholdsChanged,
  reconcileVersion = 0,
  reconcileSettled = 0,
  onRequestReconcile = () => {},
  authenticatedRequestsReady = true,
}: JoinSectionProps) {
  const [previewState, setPreviewState] = useState<PreviewState>('idle');
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [previewNotice, setPreviewNotice] = useState<JoinNotice | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [acceptUnknown, setAcceptUnknown] = useState(false);
  // The latest requested reconciliation version. The explicit retry
  // unlocks when the settled version catches up; the unlock below is
  // derived, so no effect needs to clear this state.
  const [requestedReconcile, setRequestedReconcile] = useState<number | null>(
    null,
  );
  const [accepted, setAccepted] = useState<Household | null>(null);
  const [terminal, setTerminal] = useState(false);

  const csrfRef = useRef<CsrfToken | null>(csrf);
  const genRef = useRef(0);
  const unmountedRef = useRef(false);
  const ownedRef = useRef<Set<AbortController>>(new Set());
  const noticeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    csrfRef.current = csrf;
  }, [csrf]);

  const reconcileVersionRef = useRef(reconcileVersion);
  useEffect(() => {
    reconcileVersionRef.current = reconcileVersion;
  });

  const inviteKey = invite ? `${invite.invitationId}:${invite.secret}` : null;
  const userId = user?.id ?? null;
  const flowContextKey =
    inviteKey && userId ? `${inviteKey}:${userId}` : inviteKey;
  const previousFlowContextRef = useRef(flowContextKey);

  // A history navigation can replace a completed or terminal invitation
  // without unmounting this component. Reset local outcome state before paint
  // for the new capability/user, while preserving success when the parent only
  // discards the just-consumed secret.
  useLayoutEffect(() => {
    if (
      flowContextKey !== null &&
      previousFlowContextRef.current !== flowContextKey
    ) {
      genRef.current += 1;
      for (const tracked of ownedRef.current) tracked.abort();
      ownedRef.current.clear();
      setPreviewState('idle');
      setPreview(null);
      setPreviewNotice(null);
      setAccepting(false);
      setAcceptUnknown(false);
      setRequestedReconcile(null);
      setAccepted(null);
      setTerminal(false);
    }
    previousFlowContextRef.current = flowContextKey;
  }, [flowContextKey]);

  function track(controller: AbortController) {
    ownedRef.current.add(controller);
  }

  function untrack(controller: AbortController) {
    ownedRef.current.delete(controller);
  }

  function isCurrent(generation: number): boolean {
    return !unmountedRef.current && genRef.current === generation;
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

  async function loadPreview(
    target: PendingInvite,
    signal: AbortSignal,
    generation: number,
  ) {
    setPreviewState('loading');
    setPreviewNotice(null);
    try {
      const requestCsrf = await ensureCsrf(signal, generation);
      if (!isCurrent(generation) || signal.aborted) return;
      if (requestCsrf === null) {
        setPreviewState('error');
        setPreviewNotice({
          kind: 'error',
          text: 'Security setup is still loading. Wait a moment and retry.',
        });
        return;
      }
      const result = await postInvitationPreview(
        credential(target),
        requestCsrf,
        signal,
      );
      if (!isCurrent(generation) || signal.aborted) return;
      setPreview(result);
      setPreviewState('ready');
      setPreviewNotice(null);
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
                'Could not reach the server. Check your connection and retry.',
            });
      if (apiError.status === 401) {
        // The capability stays in root memory; signing in again retries.
        setPreviewState('idle');
        onSessionExpired();
        return;
      }
      if (
        apiError.code === 'INVITATION_NOT_FOUND' ||
        apiError.fieldErrors?.invitationId ||
        apiError.fieldErrors?.secret
      ) {
        // Every terminal capability state shares one generic message that
        // reveals nothing about the household or the failure reason.
        setTerminal(true);
        setPreviewState('terminal');
        onInviteCleared();
        return;
      }
      if (apiError.timedOut) {
        setPreviewState('error');
        setPreviewNotice({
          kind: 'error',
          text: 'Loading the invitation timed out. Retry — a timeout never means the link expired.',
        });
        return;
      }
      if (apiError.code === 'CSRF_INVALID') {
        let refreshed: boolean;
        try {
          const fresh = await fetchCsrf(signal);
          if (!isCurrent(generation) || signal.aborted) return;
          csrfRef.current = fresh;
          onCsrfRefreshed(fresh);
          refreshed = true;
        } catch {
          refreshed = false;
        }
        if (!isCurrent(generation) || signal.aborted) return;
        setPreviewState('error');
        setPreviewNotice({
          kind: 'error',
          text: refreshed
            ? 'Your security token was refreshed. Retry loading the invitation.'
            : 'Your session request was rejected. Reload and try again.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      setPreviewState('error');
      if (apiError.code === 'NETWORK_ERROR') {
        setPreviewNotice({ kind: 'error', text: apiError.message });
        return;
      }
      setPreviewNotice({
        kind: 'error',
        text: apiError.message || 'Invitation preview could not be loaded.',
        correlationId: apiError.correlationId,
      });
    }
  }

  // Preview only runs for an authenticated user with a live capability.
  // Signed-out holders keep the capability in root memory and see the
  // generic prompt below; no preview request leaves the browser.
  useEffect(() => {
    unmountedRef.current = false;
    if (
      !joinActive ||
      joinInvalid ||
      !invite ||
      !user ||
      !authenticatedRequestsReady
    ) {
      return () => {
        unmountedRef.current = true;
      };
    }
    const generation = ++genRef.current;
    const controller = new AbortController();
    ownedRef.current.add(controller);
    const target = invite;
    void (async () => {
      try {
        await loadPreview(target, controller.signal, generation);
      } finally {
        ownedRef.current.delete(controller);
      }
    })();
    const owned = ownedRef.current;
    return () => {
      unmountedRef.current = true;
      controller.abort();
      for (const tracked of owned) tracked.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinActive, joinInvalid, inviteKey, userId, authenticatedRequestsReady]);

  useEffect(() => {
    if ((previewNotice || acceptUnknown) && noticeRef.current) {
      noticeRef.current.focus();
    }
  }, [previewNotice, acceptUnknown]);

  async function handleAccept() {
    if (!invite || accepting) return;
    const generation = genRef.current;
    const controller = new AbortController();
    track(controller);
    setAccepting(true);
    setAcceptUnknown(false);
    try {
      const requestCsrf = await ensureCsrf(controller.signal, generation);
      if (!isCurrent(generation) || controller.signal.aborted) return;
      if (requestCsrf === null) {
        setPreviewNotice({
          kind: 'error',
          text: 'Security setup is still loading. Wait a moment and retry.',
        });
        return;
      }
      const household = await postInvitationAccept(
        credential(invite),
        requestCsrf,
        controller.signal,
      );
      if (!isCurrent(generation) || controller.signal.aborted) return;
      // Success discards the secret from root memory; the joined household
      // below is display data from the accept response, not a secret.
      setAccepted(household);
      onInviteCleared();
      onHouseholdsChanged();
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
        onSessionExpired();
        return;
      }
      if (
        apiError.code === 'INVITATION_NOT_FOUND' ||
        apiError.fieldErrors?.invitationId ||
        apiError.fieldErrors?.secret
      ) {
        setTerminal(true);
        setPreviewState('terminal');
        onInviteCleared();
        return;
      }
      if (apiError.timedOut) {
        // Unknown outcome: request household-list reconciliation first and
        // unlock the explicit idempotent retry only after the requested
        // reload settles (see the settle effect below). Same-actor replay
        // is safe by contract and is never triggered automatically.
        // The callback prop is read fresh so a remount-then-timeout keeps
        // working even if the render closure is stale.
        setRequestedReconcile(reconcileVersionRef.current + 1);
        onRequestReconcile();
        setAcceptUnknown(true);
        return;
      }
      if (apiError.code === 'CSRF_INVALID') {
        let refreshed: boolean;
        try {
          const fresh = await fetchCsrf(controller.signal);
          if (!isCurrent(generation) || controller.signal.aborted) return;
          csrfRef.current = fresh;
          onCsrfRefreshed(fresh);
          refreshed = true;
        } catch {
          refreshed = false;
        }
        if (!isCurrent(generation) || controller.signal.aborted) return;
        setPreviewNotice({
          kind: 'error',
          text: refreshed
            ? 'Your security token was refreshed. Review the invitation and try joining again.'
            : 'Your session request was rejected. Reload and try again.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      setPreviewNotice(
        apiError.code === 'NETWORK_ERROR'
          ? { kind: 'error', text: apiError.message }
          : {
              kind: 'error',
              text:
                apiError.message ||
                'Joining the household could not be completed.',
              correlationId: apiError.correlationId,
            },
      );
    } finally {
      untrack(controller);
      // The accept flag belongs to this write alone (focus rechecks only
      // read the session), so it resets whenever the mount settles; the
      // accept response handling above stays generation-gated.
      if (!unmountedRef.current) {
        setAccepting(false);
      }
    }
  }

  if (!joinActive) {
    return null;
  }

  if (joinInvalid || terminal || previewState === 'terminal') {
    return (
      <section className="join" aria-labelledby="join-title">
        <h2 id="join-title">Household invitation</h2>
        <div role="alert" className="join-notice join-notice--error">
          <p>
            This invitation link is invalid or no longer available. Ask the
            household owner for a new link.
          </p>
        </div>
        <button
          type="button"
          className="household-button household-button--secondary"
          onClick={onLeaveJoin}
        >
          Back to households
        </button>
      </section>
    );
  }

  if (accepted) {
    return (
      <section className="join" aria-labelledby="join-title">
        <h2 id="join-title">Household invitation</h2>
        <div
          role="status"
          aria-live="polite"
          className="join-notice join-notice--info"
        >
          <p>
            You joined “{accepted.name}” as {accepted.role}. Your household list
            has been refreshed.
          </p>
        </div>
        <button
          type="button"
          className="household-button"
          onClick={onLeaveJoin}
        >
          Back to households
        </button>
      </section>
    );
  }

  if (!invite) {
    return (
      <section className="join" aria-labelledby="join-title">
        <h2 id="join-title">Household invitation</h2>
        <div role="alert" className="join-notice join-notice--warning">
          <p>
            The invitation could not be kept in this tab — it may have been
            reloaded or opened without the full link. Reopen the original
            invitation link to continue.
          </p>
        </div>
        <button
          type="button"
          className="household-button household-button--secondary"
          onClick={onLeaveJoin}
        >
          Back to households
        </button>
      </section>
    );
  }

  if (!user) {
    return (
      <section className="join" aria-labelledby="join-title">
        <h2 id="join-title">Household invitation</h2>
        <div role="status" aria-live="polite" className="join-notice">
          <p>
            You have been invited to join a household on HouseSync. Sign in or
            create an account in this tab to continue — your invitation is kept
            in this tab while you do. No household details are shown until you
            sign in.
          </p>
        </div>
        <button
          type="button"
          className="household-button household-button--secondary"
          onClick={onLeaveJoin}
        >
          Dismiss invitation
        </button>
      </section>
    );
  }

  // The explicit retry unlocks only after the requested household-list
  // reconciliation settles, enforcing the contract order. Derived directly
  // so no state-clearing effect is needed.
  const reconciling =
    requestedReconcile !== null && reconcileSettled < requestedReconcile;

  return (
    <section className="join" aria-labelledby="join-title">
      <h2 id="join-title">Household invitation</h2>

      {previewState === 'loading' && (
        <div role="status" aria-live="polite" aria-atomic="true">
          <p>Loading the invitation…</p>
        </div>
      )}

      {previewNotice && (
        <div
          ref={noticeRef}
          tabIndex={-1}
          role={previewNotice.kind === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          className={`join-notice join-notice--${previewNotice.kind}`}
        >
          <p>{previewNotice.text}</p>
          {previewNotice.correlationId && (
            <p className="join-notice-detail">
              Reference: {previewNotice.correlationId}
            </p>
          )}
          {previewState === 'error' && !acceptUnknown && (
            <button
              type="button"
              className="household-button household-button--secondary"
              onClick={() => {
                const generation = ++genRef.current;
                const controller = new AbortController();
                track(controller);
                const target = invite;
                void (async () => {
                  try {
                    await loadPreview(target, controller.signal, generation);
                  } finally {
                    untrack(controller);
                  }
                })();
              }}
              disabled={accepting}
            >
              Retry
            </button>
          )}
        </div>
      )}

      {previewState === 'ready' && preview && (
        <div className="join-card">
          <p className="eyebrow">You are invited to join</p>
          <p className="join-name">{preview.householdName}</p>
          <p className="join-meta">Your role will be: MEMBER</p>
          <p className="join-meta">
            Expires:{' '}
            <time dateTime={preview.expiresAt}>
              {formatInstant(preview.expiresAt)}
            </time>
          </p>
          <div className="invite-actions">
            <button
              type="button"
              className="household-button"
              onClick={() => void handleAccept()}
              disabled={accepting}
            >
              {accepting ? 'Joining…' : 'Join household'}
            </button>
            <button
              type="button"
              className="household-button household-button--secondary"
              onClick={onLeaveJoin}
              disabled={accepting}
            >
              Dismiss invitation
            </button>
          </div>
        </div>
      )}

      {acceptUnknown && (
        <div
          ref={acceptUnknown && !previewNotice ? noticeRef : undefined}
          tabIndex={-1}
          role="alert"
          className="join-notice join-notice--error"
        >
          <p>
            Joining timed out and its outcome is unknown. Your household list is
            being refreshed — check whether the household appeared before
            retrying. Retrying is safe: repeating this invitation as the same
            account never creates a duplicate membership.
          </p>
          {reconciling && (
            <p role="status" className="join-meta">
              Checking your households…
            </p>
          )}
          <div className="invite-actions">
            <button
              type="button"
              className="household-button"
              onClick={() => void handleAccept()}
              disabled={accepting || reconciling}
            >
              {accepting ? 'Joining…' : 'Retry join'}
            </button>
            <button
              type="button"
              className="household-button household-button--secondary"
              onClick={onLeaveJoin}
              disabled={accepting}
            >
              Back to households
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
