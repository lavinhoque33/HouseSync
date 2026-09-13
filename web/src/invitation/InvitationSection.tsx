import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  deleteInvitation,
  fetchCsrf,
  fetchInvitations,
  postInvitation,
  type ActiveInvitation,
  type CsrfToken,
  type Household,
} from '../auth/client';
import { buildJoinLink } from './route';

interface InvitationNotice {
  kind: 'info' | 'error' | 'warning';
  text: string;
  correlationId?: string | undefined;
  showRefresh?: boolean | undefined;
  showHouseholdRefresh?: boolean | undefined;
}

interface OneTimeLink {
  link: string;
  createdAt: string;
  expiresAt: string;
}

interface InvitationSectionProps {
  household: Household;
  csrf: CsrfToken | null;
  onCsrfRefreshed: (token: CsrfToken) => void;
  onSessionExpired: () => void;
  /**
   * Reloads the parent household collection when an owner write reports
   * changed access (non-owner role or unknown household), so stale owner
   * controls are replaced by the current membership state.
   */
  onHouseholdAccessChanged?: (() => void) | undefined;
}

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

function sortInvitations(values: ActiveInvitation[]): ActiveInvitation[] {
  return [...values].sort((a, b) => {
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

export function InvitationSection({
  household,
  csrf,
  onCsrfRefreshed,
  onSessionExpired,
  onHouseholdAccessChanged = () => {},
}: InvitationSectionProps) {
  const [invitations, setInvitations] = useState<ActiveInvitation[] | null>(
    null,
  );
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<InvitationNotice | null>(null);
  const [creating, setCreating] = useState(false);
  const [oneTime, setOneTime] = useState<OneTimeLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [revoking, setRevoking] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<InvitationNotice | null>(null);

  const csrfRef = useRef<CsrfToken | null>(csrf);
  // Synchronous source of truth for in-flight revocations: state updates
  // are async, so guards that run right after a flag change read this ref.
  const revokeSetRef = useRef<Set<string>>(new Set());
  const revokePending = Object.values(revoking).some((pending) => pending);
  const genRef = useRef(0);
  const unmountedRef = useRef(false);
  const ownedRef = useRef<Set<AbortController>>(new Set());
  const noticeRef = useRef<HTMLDivElement>(null);
  const oneTimeRef = useRef<HTMLDivElement>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    csrfRef.current = csrf;
  }, [csrf]);

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
    setListLoading(true);
    setListError(null);
    try {
      const result = await fetchInvitations(household.id, signal);
      if (!isCurrent(generation) || signal.aborted) return;
      setInvitations(sortInvitations(result));
      setListError(null);
      setNotice((current) => (current?.showRefresh ? null : current));
      setListLoading(false);
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
                'Could not load invitations. Check your connection and refresh.',
            });
      if (apiError.status === 401) {
        setInvitations(null);
        setListLoading(false);
        onSessionExpired();
        return;
      }
      setListLoading(false);
      if (apiError.timedOut) {
        setListError({
          kind: 'error',
          text: 'Loading invitations timed out. Refresh to try again.',
        });
        return;
      }
      if (
        apiError.code === 'FORBIDDEN' ||
        apiError.code === 'HOUSEHOLD_NOT_FOUND'
      ) {
        // The displayed owner role is stale: offer a household-list refresh
        // so current membership replaces these controls.
        setListError({
          kind: 'error',
          text: 'Your access to this household may have changed. Refresh the household list to confirm your current role.',
          correlationId: apiError.correlationId,
          showHouseholdRefresh: true,
        });
        return;
      }
      if (apiError.code === 'NETWORK_ERROR') {
        setListError({ kind: 'error', text: apiError.message });
        return;
      }
      setListError({
        kind: 'error',
        text: apiError.message || 'Could not load invitations.',
        correlationId: apiError.correlationId,
      });
    }
  }

  // The owner guard sits after every hook so the hook order stays stable
  // when the role changes; this effect guards internally instead. The load
  // runs once per household identity.
  useEffect(() => {
    if (household.role !== 'OWNER') return;
    unmountedRef.current = false;
    const generation = ++genRef.current;
    const controller = new AbortController();
    ownedRef.current.add(controller);
    void (async () => {
      try {
        await load(controller.signal, generation);
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
  }, [household.id, household.role]);

  useEffect(() => {
    if (notice && noticeRef.current) {
      noticeRef.current.focus();
    }
  }, [notice]);

  useEffect(() => {
    if (oneTime && oneTimeRef.current) {
      oneTimeRef.current.focus();
    }
  }, [oneTime]);

  function reloadInvitations(): void {
    const generation = ++genRef.current;
    const controller = new AbortController();
    track(controller);
    void (async () => {
      try {
        await load(controller.signal, generation);
      } finally {
        untrack(controller);
      }
    })();
  }

  function handleRefresh() {
    // A refresh supersedes the load generation, so it must not run while a
    // write owns a busy flag: the write's settle handler could no longer
    // clear it. Creation/revocation buttons stay disabled meanwhile. The
    // ref (not state) is read because state updates are async.
    if (listLoading || creating || revokeSetRef.current.size > 0) {
      return;
    }
    reloadInvitations();
  }

  async function refreshCsrf(
    signal: AbortSignal,
    generation: number,
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

  function csrfRejectionNotice(
    generation: number,
    signal: AbortSignal,
    done: (refreshed: boolean) => void,
  ) {
    void (async () => {
      const refreshed = await refreshCsrf(signal, generation);
      if (!isCurrent(generation) || signal.aborted) return;
      done(refreshed);
    })();
  }

  async function handleCreate() {
    if (creating || listLoading) return;
    const generation = genRef.current;
    const controller = new AbortController();
    track(controller);
    setCreating(true);
    setNotice(null);
    setCopied(false);
    setCopyFailed(false);
    try {
      let requestCsrf = csrfRef.current;
      if (requestCsrf === null) {
        try {
          const fresh = await fetchCsrf(controller.signal);
          if (!isCurrent(generation) || controller.signal.aborted) return;
          csrfRef.current = fresh;
          onCsrfRefreshed(fresh);
          requestCsrf = fresh;
        } catch {
          if (!isCurrent(generation) || controller.signal.aborted) return;
          setNotice({
            kind: 'error',
            text: 'Security setup is still loading. Wait a moment and retry.',
          });
          return;
        }
      }
      const created = await postInvitation(
        household.id,
        requestCsrf,
        controller.signal,
      );
      if (!isCurrent(generation) || controller.signal.aborted) return;
      setInvitations((current) =>
        sortInvitations([
          ...(current ?? []),
          {
            id: created.id,
            createdAt: created.createdAt,
            expiresAt: created.expiresAt,
          },
        ]),
      );
      // The raw secret exists only in this response. Build the link from
      // the current origin and show it once; reloading never reveals it.
      setOneTime({
        link: buildJoinLink(window.location.origin, {
          invitationId: created.id,
          secret: created.secret,
        }),
        createdAt: created.createdAt,
        expiresAt: created.expiresAt,
      });
      setNotice({
        kind: 'info',
        text: 'Invitation created. Copy the one-time link below.',
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
        setInvitations(null);
        onSessionExpired();
        return;
      }
      if (apiError.timedOut) {
        // A timed-out create may still have completed server-side: never
        // claim failure and never replay automatically. Refresh the active
        // list; revoke any unshareable invitation that appeared and create
        // a replacement explicitly.
        setNotice({
          kind: 'error',
          text: 'Invitation creation timed out. Its outcome is unknown — refresh the list to check before creating another.',
          showRefresh: true,
        });
        return;
      }
      if (apiError.code === 'CSRF_INVALID') {
        csrfRejectionNotice(generation, controller.signal, (refreshed) => {
          setNotice({
            kind: 'error',
            text: refreshed
              ? 'Your security token was refreshed. Try creating the invitation again.'
              : 'Your session request was rejected. Reload and try again.',
            correlationId: apiError.correlationId,
          });
        });
        return;
      }
      if (
        apiError.code === 'FORBIDDEN' ||
        apiError.code === 'HOUSEHOLD_NOT_FOUND'
      ) {
        setNotice({
          kind: 'error',
          text: 'Your access to this household may have changed. Refresh the household list to confirm your current role before retrying.',
          correlationId: apiError.correlationId,
          showHouseholdRefresh: true,
        });
        return;
      }
      if (apiError.code === 'NETWORK_ERROR') {
        setNotice({ kind: 'error', text: apiError.message });
        return;
      }
      setNotice({
        kind: 'error',
        text: apiError.message || 'Invitation creation could not be completed.',
        correlationId: apiError.correlationId,
      });
    } finally {
      untrack(controller);
      // Busy flags reset whenever this mount settles: invitation writes own
      // their flags (no background check shares them), and a superseding
      // refresh is blocked above, so the flag can never belong to a newer
      // operation. Response data above stays generation-gated.
      if (!unmountedRef.current) {
        setCreating(false);
      }
    }
  }

  async function handleRevoke(invitationId: string) {
    if (revoking[invitationId] || creating || listLoading) return;
    const generation = genRef.current;
    const controller = new AbortController();
    track(controller);
    setRevoking((current) => ({ ...current, [invitationId]: true }));
    revokeSetRef.current.add(invitationId);
    setNotice(null);
    try {
      let requestCsrf = csrfRef.current;
      if (requestCsrf === null) {
        try {
          const fresh = await fetchCsrf(controller.signal);
          if (!isCurrent(generation) || controller.signal.aborted) return;
          csrfRef.current = fresh;
          onCsrfRefreshed(fresh);
          requestCsrf = fresh;
        } catch {
          if (!isCurrent(generation) || controller.signal.aborted) return;
          setNotice({
            kind: 'error',
            text: 'Security setup is still loading. Wait a moment and retry.',
          });
          return;
        }
      }
      await deleteInvitation(
        household.id,
        invitationId,
        requestCsrf,
        controller.signal,
      );
      if (!isCurrent(generation) || controller.signal.aborted) return;
      setInvitations((current) =>
        (current ?? []).filter((entry) => entry.id !== invitationId),
      );
      // A revoked invitation whose one-time panel is still open can no
      // longer be shared; hide the panel so the dead link cannot be copied.
      setOneTime((current) =>
        current && current.link.includes(invitationId) ? null : current,
      );
      setNotice({ kind: 'info', text: 'Invitation revoked.' });
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
        setInvitations(null);
        onSessionExpired();
        return;
      }
      if (apiError.timedOut) {
        setNotice({
          kind: 'error',
          text: 'Revocation timed out. Its outcome is unknown — refresh the list to check before retrying.',
          showRefresh: true,
        });
        return;
      }
      if (apiError.code === 'CSRF_INVALID') {
        csrfRejectionNotice(generation, controller.signal, (refreshed) => {
          setNotice({
            kind: 'error',
            text: refreshed
              ? 'Your security token was refreshed. Try revoking the invitation again.'
              : 'Your session request was rejected. Reload and try again.',
            correlationId: apiError.correlationId,
          });
        });
        return;
      }
      if (apiError.code === 'INVITATION_NOT_FOUND') {
        // The row is terminal server-side: drop the dead entry locally so
        // it cannot be acted on again, then reconcile the remainder. The
        // revoke flag clears synchronously first so the reload is never
        // blocked by the write that just finished.
        revokeSetRef.current.delete(invitationId);
        setRevoking((current) => {
          const next = { ...current };
          delete next[invitationId];
          return next;
        });
        setInvitations((current) =>
          (current ?? []).filter((entry) => entry.id !== invitationId),
        );
        reloadInvitations();
        setNotice({
          kind: 'warning',
          text: 'That invitation is already unavailable. It was removed and the list is being refreshed.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      if (
        apiError.code === 'FORBIDDEN' ||
        apiError.code === 'HOUSEHOLD_NOT_FOUND'
      ) {
        setNotice({
          kind: 'error',
          text: 'Your access to this household may have changed. Refresh the household list to confirm your current role before retrying.',
          correlationId: apiError.correlationId,
          showHouseholdRefresh: true,
        });
        return;
      }
      if (apiError.code === 'NETWORK_ERROR') {
        setNotice({ kind: 'error', text: apiError.message });
        return;
      }
      setNotice({
        kind: 'error',
        text:
          apiError.message || 'Invitation revocation could not be completed.',
        correlationId: apiError.correlationId,
      });
    } finally {
      untrack(controller);
      revokeSetRef.current.delete(invitationId);
      if (!unmountedRef.current) {
        setRevoking((current) => {
          const next = { ...current };
          delete next[invitationId];
          return next;
        });
      }
    }
  }

  async function handleCopy() {
    if (!oneTime) return;
    setCopied(false);
    setCopyFailed(false);
    try {
      if (
        typeof navigator === 'undefined' ||
        !navigator.clipboard ||
        typeof navigator.clipboard.writeText !== 'function'
      ) {
        throw new Error('Clipboard unavailable.');
      }
      await navigator.clipboard.writeText(oneTime.link);
      setCopied(true);
    } catch {
      // Copy failure must leave the manual-copy path: the read-only link
      // field below stays available for selecting and copying by hand.
      setCopyFailed(true);
      requestAnimationFrame(() => linkInputRef.current?.select());
    }
  }

  // Only current owners may manage invitations. The parent renders this
  // section for owner households after a confirmed list; the guard keeps a
  // stale member view from offering owner controls. It sits after every
  // hook so the hook order stays stable when the role changes.
  if (household.role !== 'OWNER') {
    return null;
  }

  return (
    <div className="invite">
      <h4 className="invite-title">Invitations</h4>

      {listLoading && invitations === null && !listError && (
        <div role="status" aria-live="polite" aria-atomic="true">
          <p>Loading invitations…</p>
        </div>
      )}

      {listError && (
        <div role="alert" className="invite-notice invite-notice--error">
          <p>{listError.text}</p>
          {listError.correlationId && (
            <p className="invite-notice-detail">
              Reference: {listError.correlationId}
            </p>
          )}
          <button
            type="button"
            className="household-button household-button--secondary"
            onClick={handleRefresh}
            disabled={listLoading || creating || revokePending}
          >
            Refresh invitations
          </button>
          {listError.showHouseholdRefresh && (
            <button
              type="button"
              className="household-button household-button--secondary"
              onClick={onHouseholdAccessChanged}
            >
              Refresh household list
            </button>
          )}
        </div>
      )}

      {invitations !== null && !listLoading && !listError && (
        <p role="status" className="invite-count">
          {invitations.length === 0
            ? 'No active invitations. Create one below to invite someone.'
            : `${invitations.length} active ${invitations.length === 1 ? 'invitation' : 'invitations'}.`}
        </p>
      )}

      {invitations !== null && invitations.length > 0 && (
        <ul className="invite-list" aria-label="Active invitations">
          {invitations.map((invitation, index) => (
            <li key={invitation.id} className="invite-card">
              <p className="invite-meta">
                Created:{' '}
                <time dateTime={invitation.createdAt}>
                  {formatInstant(invitation.createdAt)}
                </time>
              </p>
              <p className="invite-meta">
                Expires:{' '}
                <time dateTime={invitation.expiresAt}>
                  {formatInstant(invitation.expiresAt)}
                </time>
              </p>
              <button
                type="button"
                className="household-button household-button--secondary"
                aria-label={`Revoke invitation ${index + 1} of ${invitations.length}, expiring ${formatInstant(invitation.expiresAt)}`}
                onClick={() => void handleRevoke(invitation.id)}
                disabled={Boolean(revoking[invitation.id]) || creating}
              >
                {revoking[invitation.id] ? 'Revoking…' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {invitations !== null && !listError && (
        <button
          type="button"
          className="household-button"
          onClick={() => void handleCreate()}
          disabled={creating || listLoading}
        >
          {creating ? 'Creating…' : 'Create invitation'}
        </button>
      )}

      {oneTime && (
        <div
          ref={oneTimeRef}
          tabIndex={-1}
          role="status"
          aria-live="polite"
          className="invite-notice invite-notice--warning"
        >
          <p className="invite-warning">
            Anyone with this link can join “{household.name}” as a member until
            it expires, is used, or is revoked. Share it privately. This link is
            shown once — copy it now. It cannot be recovered after this panel is
            closed.
          </p>
          <p className="invite-meta">
            Expires:{' '}
            <time dateTime={oneTime.expiresAt}>
              {formatInstant(oneTime.expiresAt)}
            </time>
          </p>
          <label htmlFor={`invite-link-${household.id}`}>
            Invitation link (shown once)
          </label>
          <input
            id={`invite-link-${household.id}`}
            ref={linkInputRef}
            className="invite-link-field"
            type="text"
            readOnly
            autoComplete="off"
            spellCheck={false}
            value={oneTime.link}
            onFocus={(event) => event.target.select()}
          />
          <div className="invite-actions">
            <button
              type="button"
              className="household-button"
              onClick={() => void handleCopy()}
            >
              Copy invitation link
            </button>
            <button
              type="button"
              className="household-button household-button--secondary"
              onClick={() => setOneTime(null)}
            >
              Discard link display
            </button>
          </div>
          {copied && (
            <p role="status" className="invite-copied">
              Link copied. It remains active below until it expires, is used, or
              is revoked.
            </p>
          )}
          {copyFailed && (
            <p role="alert" className="invite-error">
              Automatic copy failed. Select the link above and copy it manually.
            </p>
          )}
          <p className="invite-meta">
            Discarding only hides the link; the invitation stays active above
            until revoked.
          </p>
        </div>
      )}

      {notice && (
        <div
          ref={noticeRef}
          tabIndex={-1}
          role={notice.kind === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          className={`invite-notice invite-notice--${notice.kind}`}
        >
          <p>{notice.text}</p>
          {notice.correlationId && (
            <p className="invite-notice-detail">
              Reference: {notice.correlationId}
            </p>
          )}
          {notice.showRefresh && (
            <button
              type="button"
              className="household-button household-button--secondary"
              onClick={handleRefresh}
              disabled={listLoading || creating || revokePending}
            >
              Refresh invitations
            </button>
          )}
          {notice.showHouseholdRefresh && (
            <button
              type="button"
              className="household-button household-button--secondary"
              onClick={onHouseholdAccessChanged}
            >
              Refresh household list
            </button>
          )}
        </div>
      )}
    </div>
  );
}
