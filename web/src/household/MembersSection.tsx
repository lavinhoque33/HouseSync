import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  ApiError,
  deleteHouseholdMember,
  fetchCsrf,
  fetchHouseholdMembers,
  patchHouseholdMemberRole,
  postLeaveHousehold,
  type CsrfToken,
  type Household,
  type HouseholdMember,
} from '../auth/client';

interface MemberNotice {
  kind: 'info' | 'error' | 'warning';
  text: string;
  correlationId?: string | undefined;
  showRefresh?: boolean | undefined;
  showHouseholdRefresh?: boolean | undefined;
}

type MemberAction = 'promote' | 'demote' | 'remove' | 'leave';

interface PendingAction {
  kind: MemberAction;
  member: HouseholdMember | null;
}

interface MembersSectionProps {
  household: Household;
  /** Signed-in account id separating self and other-member controls. */
  currentUserId: string;
  csrf: CsrfToken | null;
  onCsrfRefreshed: (token: CsrfToken) => void;
  onSessionExpired: () => void;
  /**
   * Reloads the parent household collection so authority is reconciled from
   * the backend after writes, lost access, or stale roles. The parent runs
   * this through its queued refresh signal, so a call landing while the
   * collection is busy is never dropped.
   */
  onHouseholdAccessChanged: () => void;
}

const ACTION_LABELS: Record<MemberAction, string> = {
  promote: 'Role change',
  demote: 'Role change',
  remove: 'Removal',
  leave: 'Leaving',
};

function timeoutNotice(kind: MemberAction): string {
  if (kind === 'leave') {
    return 'Leaving timed out. Its outcome is unknown — the members list and household list are being refreshed to confirm before you can retry.';
  }
  if (kind === 'remove') {
    return 'Removal timed out. Its outcome is unknown — the members list is being refreshed to confirm before you can retry.';
  }
  return 'The role change timed out. Its outcome is unknown — the members list is being refreshed to confirm before you can retry.';
}

function confirmationText(
  kind: MemberAction,
  member: HouseholdMember | null,
  householdName: string,
): string {
  const email = member?.email ?? '';
  if (kind === 'promote') {
    return `Make ${email} an owner of “${householdName}”? Owners can manage invitations and members.`;
  }
  if (kind === 'demote') {
    return `Change ${email} to a member of “${householdName}”? They will no longer manage invitations or members.`;
  }
  if (kind === 'remove') {
    return `Remove ${email} from “${householdName}”? They will immediately lose access. This cannot be undone from here.`;
  }
  return `Leave “${householdName}”? You will immediately lose access. An owner must invite you back.`;
}

export function MembersSection({
  household,
  currentUserId,
  csrf,
  onCsrfRefreshed,
  onSessionExpired,
  onHouseholdAccessChanged,
}: MembersSectionProps) {
  const [members, setMembers] = useState<HouseholdMember[] | null>(null);
  const [rosterLoading, setRosterLoading] = useState(true);
  const [rosterError, setRosterError] = useState<MemberNotice | null>(null);
  const [notice, setNotice] = useState<MemberNotice | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null,
  );
  const [writing, setWriting] = useState<string | null>(null);
  const [left, setLeft] = useState(false);

  const csrfRef = useRef<CsrfToken | null>(csrf);
  const genRef = useRef(0);
  const unmountedRef = useRef(false);
  const ownedRef = useRef<Set<AbortController>>(new Set());
  const noticeRef = useRef<HTMLDivElement>(null);
  const rosterNoticeRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // Synchronous source of truth for in-flight writes: state updates are
  // async, so guards that run right after a flag change read this ref.
  const writingRef = useRef<string | null>(null);

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

  async function loadRoster(signal: AbortSignal, generation: number) {
    setRosterLoading(true);
    setRosterError(null);
    try {
      const roster = await fetchHouseholdMembers(household.id, signal);
      if (!isCurrent(generation) || signal.aborted) return;
      setMembers(roster);
      setNotice((current) => (current?.showRefresh ? null : current));
      setRosterLoading(false);
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
                'Could not load members. Check your connection and refresh.',
            });
      if (apiError.status === 401) {
        // The roster is other people's data: drop it before the parent
        // unmounts this section during sign-in-again recovery.
        setMembers(null);
        setRosterLoading(false);
        onSessionExpired();
        return;
      }
      setRosterLoading(false);
      if (apiError.timedOut) {
        setRosterError({
          kind: 'error',
          text: 'Loading members timed out. Refresh to try again.',
        });
        return;
      }
      if (apiError.code === 'HOUSEHOLD_NOT_FOUND') {
        // The roster endpoint no longer recognizes this membership, so the
        // card itself is stale: drop the retained roster and reconcile the
        // household collection so lost access disappears.
        setMembers(null);
        setRosterError({
          kind: 'warning',
          text: 'This household is no longer available to you. The household list is being refreshed.',
          correlationId: apiError.correlationId,
          showHouseholdRefresh: true,
        });
        onHouseholdAccessChanged();
        return;
      }
      if (apiError.code === 'NETWORK_ERROR') {
        setRosterError({ kind: 'error', text: apiError.message });
        return;
      }
      setRosterError({
        kind: 'error',
        text: apiError.message || 'Could not load members.',
        correlationId: apiError.correlationId,
      });
    }
  }

  // One load per household identity. The roster mounts for every confirmed
  // visible household; unmount aborts its requests so a lost household
  // (collection refresh removing the card) ignores late responses.
  useEffect(() => {
    unmountedRef.current = false;
    const generation = ++genRef.current;
    const controller = new AbortController();
    ownedRef.current.add(controller);
    void (async () => {
      try {
        await loadRoster(controller.signal, generation);
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
  }, [household.id]);

  useEffect(() => {
    if (notice && noticeRef.current) {
      noticeRef.current.focus();
    }
  }, [notice]);

  useEffect(() => {
    if (rosterError && rosterNoticeRef.current) {
      rosterNoticeRef.current.focus();
    }
  }, [rosterError]);

  useEffect(() => {
    if (pendingAction && confirmRef.current) {
      confirmRef.current.focus();
    }
  }, [pendingAction]);

  function reloadRoster(): void {
    const generation = ++genRef.current;
    const controller = new AbortController();
    track(controller);
    void (async () => {
      try {
        await loadRoster(controller.signal, generation);
      } finally {
        untrack(controller);
      }
    })();
  }

  function writesAllowed(): boolean {
    return (
      members !== null &&
      rosterError === null &&
      !rosterLoading &&
      writingRef.current === null
    );
  }

  // Owner controls are presentation only: the displayed collection role AND
  // the loaded roster's row for the actor must both say OWNER, so a stale
  // collection cannot keep mutation controls alive against a reconciled
  // roster that says otherwise. The backend remains the authority.
  function actorIsOwner(): boolean {
    return (
      household.role === 'OWNER' &&
      (members ?? []).some(
        (member) => member.userId === currentUserId && member.role === 'OWNER',
      )
    );
  }

  function openConfirm(
    kind: MemberAction,
    member: HouseholdMember | null,
    trigger: HTMLButtonElement,
  ) {
    // One confirmation at a time: a second trigger must not replace the
    // open panel or steal its focus origin.
    if (pendingAction !== null || !writesAllowed()) return;
    triggerRef.current = trigger;
    setPendingAction({ kind, member });
  }

  function cancelConfirm() {
    setPendingAction(null);
    const trigger = triggerRef.current;
    triggerRef.current = null;
    trigger?.focus();
  }

  function handleConfirmKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelConfirm();
    }
  }

  async function runWrite(action: PendingAction) {
    if (writingRef.current !== null || !writesAllowed()) return;
    const kind = action.kind;
    const member = action.member;
    const writeKey = member ? `${kind}:${member.userId}` : kind;
    const generation = genRef.current;
    const controller = new AbortController();
    track(controller);
    setPendingAction(null);
    triggerRef.current = null;
    writingRef.current = writeKey;
    setWriting(writeKey);
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
      if (kind === 'leave') {
        await postLeaveHousehold(household.id, requestCsrf, controller.signal);
        if (!isCurrent(generation) || controller.signal.aborted) return;
        // The actor no longer belongs: drop the roster locally and let the
        // collection reload remove the card. No roster retry runs here —
        // the leave endpoint itself is the authoritative self-removal.
        setLeft(true);
        setMembers(null);
        setNotice({ kind: 'info', text: `You left “${household.name}”.` });
        onHouseholdAccessChanged();
        return;
      }
      if (!member) return;
      if (kind === 'remove') {
        await deleteHouseholdMember(
          household.id,
          member.userId,
          requestCsrf,
          controller.signal,
        );
        if (!isCurrent(generation) || controller.signal.aborted) return;
        setMembers((current) =>
          (current ?? []).filter((entry) => entry.userId !== member.userId),
        );
        setNotice({
          kind: 'info',
          text: `${member.email} was removed from the household.`,
        });
      } else {
        const updated = await patchHouseholdMemberRole(
          household.id,
          member.userId,
          kind === 'promote' ? 'OWNER' : 'MEMBER',
          requestCsrf,
          controller.signal,
        );
        if (!isCurrent(generation) || controller.signal.aborted) return;
        setMembers((current) =>
          (current ?? []).map((entry) =>
            entry.userId === member.userId ? updated : entry,
          ),
        );
        setNotice({
          kind: 'info',
          text:
            kind === 'promote'
              ? `${member.email} is now an owner.`
              : `${member.email} is now a member.`,
        });
      }
      // The optimistic row above is display data only: reload the roster
      // and the household collection so authority comes from the backend
      // before further writes.
      reloadRoster();
      onHouseholdAccessChanged();
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
        setMembers(null);
        onSessionExpired();
        return;
      }
      if (apiError.timedOut) {
        // Unknown outcome: never claim failure and never replay. Both
        // reconciliations run now, and writes stay gated until the roster
        // reload settles.
        reloadRoster();
        onHouseholdAccessChanged();
        setNotice({
          kind: 'error',
          text: timeoutNotice(kind),
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
        setNotice({
          kind: 'error',
          text: refreshed
            ? 'Your security token was refreshed. Confirm the change again to retry.'
            : 'Your session request was rejected. Reload and try again.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      if (apiError.code === 'FORBIDDEN') {
        // The actor's authority changed (e.g. demoted by a co-owner):
        // reconcile roster and collection so stale owner controls
        // disappear. A successful roster reload clears this notice.
        reloadRoster();
        onHouseholdAccessChanged();
        setNotice({
          kind: 'error',
          text: 'Your access to this household may have changed. The household list and members list are being refreshed to confirm your current role.',
          correlationId: apiError.correlationId,
          showRefresh: true,
          showHouseholdRefresh: true,
        });
        return;
      }
      if (apiError.code === 'HOUSEHOLD_NOT_FOUND') {
        // Lost access or a missing household: drop the retained roster and
        // reconcile so the card disappears.
        setMembers(null);
        onHouseholdAccessChanged();
        setNotice({
          kind: 'error',
          text: 'Your access to this household may have changed. The household list is being refreshed to confirm.',
          correlationId: apiError.correlationId,
          showHouseholdRefresh: true,
        });
        return;
      }
      if (apiError.code === 'MEMBERSHIP_NOT_FOUND' && member) {
        // The target is no longer a member: drop the dead row locally and
        // reconcile the remainder. The write flag clears synchronously
        // first so the reload is never blocked by the finished write. The
        // outcome notice stays readable after the automatic reload settles
        // and never claims a refresh is still occurring.
        writingRef.current = null;
        setWriting(null);
        setMembers((current) =>
          (current ?? []).filter((entry) => entry.userId !== member.userId),
        );
        reloadRoster();
        setNotice({
          kind: 'warning',
          text: 'That member is no longer in this household. They were removed from the list.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      if (apiError.code === 'LAST_OWNER_REQUIRED') {
        // The invariant stands after reconciliation: the outcome notice
        // stays readable with the remedy, without a present-tense refresh
        // claim. The automatic roster and collection reloads still run.
        if (kind === 'leave') {
          setNotice({
            kind: 'warning',
            text: "You are this household's only owner, so you cannot leave. Promote another member to owner first.",
            correlationId: apiError.correlationId,
          });
        } else if (member) {
          setNotice({
            kind: 'warning',
            text: `${member.email} is this household's only owner, so the role cannot change.`,
            correlationId: apiError.correlationId,
          });
        }
        reloadRoster();
        onHouseholdAccessChanged();
        return;
      }
      if (apiError.code === 'NETWORK_ERROR') {
        setNotice({ kind: 'error', text: apiError.message });
        return;
      }
      const fallback =
        kind === 'leave'
          ? 'Leaving the household could not be completed.'
          : kind === 'remove'
            ? 'Member removal could not be completed.'
            : 'The role change could not be completed.';
      setNotice({
        kind: 'error',
        text: apiError.message || fallback,
        correlationId: apiError.correlationId,
      });
    } finally {
      untrack(controller);
      // Member writes own their flag (no shared background work): it resets
      // whenever the mount settles, and the response handling above stays
      // generation-gated.
      writingRef.current = null;
      if (!unmountedRef.current) {
        setWriting(null);
      }
    }
  }

  const showRoster = !left && members !== null && members.length > 0;
  // Every write — including leave — stays gated until a fresh roster has
  // settled: a failed or pending refresh must not leave controls active
  // against stale data.
  const actionable =
    !left &&
    members !== null &&
    rosterError === null &&
    !rosterLoading &&
    writing === null;
  const showOwnerControls = actionable && actorIsOwner();

  return (
    <div className="members">
      <h4 className="members-title">Members</h4>

      {!left && rosterLoading && members === null && !rosterError && (
        <div role="status" aria-live="polite" aria-atomic="true">
          <p>Loading members…</p>
        </div>
      )}

      {!left && rosterLoading && members !== null && (
        <p role="status" className="members-status">
          Refreshing members…
        </p>
      )}

      {!left && rosterError && (
        <div
          ref={rosterNoticeRef}
          tabIndex={-1}
          role="alert"
          className={`household-notice household-notice--${rosterError.kind}`}
        >
          <p>{rosterError.text}</p>
          {rosterError.correlationId && (
            <p className="household-notice-detail">
              Reference: {rosterError.correlationId}
            </p>
          )}
          <button
            type="button"
            className="household-button household-button--secondary"
            onClick={reloadRoster}
            disabled={rosterLoading || writing !== null}
          >
            Refresh members
          </button>
          {rosterError.showHouseholdRefresh && (
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

      {!left && rosterError && members !== null && members.length > 0 && (
        <p role="status" className="members-stale">
          Showing previously loaded members, which may be out of date. Refresh
          the members list to continue.
        </p>
      )}

      {showRoster && (
        <ul className="members-list" aria-label="Household members">
          {members?.map((member) => {
            const isSelf = member.userId === currentUserId;
            return (
              <li key={member.userId} className="member-card">
                <p className="member-email">
                  {member.email}
                  {isSelf ? ' (you)' : ''}
                </p>
                <p className="member-role">Role: {member.role}</p>
                {showOwnerControls && !isSelf && (
                  <div className="member-actions">
                    {member.role === 'MEMBER' ? (
                      <button
                        type="button"
                        className="household-button"
                        aria-label={`Make ${member.email} an owner of ${household.name}`}
                        onClick={(event) =>
                          openConfirm('promote', member, event.currentTarget)
                        }
                      >
                        Make owner
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="household-button"
                        aria-label={`Change ${member.email} to a member of ${household.name}`}
                        onClick={(event) =>
                          openConfirm('demote', member, event.currentTarget)
                        }
                      >
                        Change to member
                      </button>
                    )}
                    <button
                      type="button"
                      className="household-button household-button--secondary"
                      aria-label={`Remove ${member.email} from ${household.name}`}
                      onClick={(event) =>
                        openConfirm('remove', member, event.currentTarget)
                      }
                    >
                      Remove
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!left && members !== null && members.length === 0 && !rosterError && (
        <p role="status" className="members-status">
          No members to show.
        </p>
      )}

      {pendingAction && (
        <div
          ref={confirmRef}
          tabIndex={-1}
          role="group"
          aria-label={`Confirm ${ACTION_LABELS[pendingAction.kind].toLowerCase()} in ${household.name}`}
          className="household-notice household-notice--warning members-confirm"
          onKeyDown={handleConfirmKeyDown}
        >
          <p>
            {confirmationText(
              pendingAction.kind,
              pendingAction.member,
              household.name,
            )}
          </p>
          <div className="member-actions">
            <button
              type="button"
              className="household-button"
              onClick={() =>
                void runWrite({
                  kind: pendingAction.kind,
                  member: pendingAction.member,
                })
              }
              disabled={writing !== null}
            >
              {pendingAction.kind === 'promote' && 'Make owner'}
              {pendingAction.kind === 'demote' && 'Change to member'}
              {pendingAction.kind === 'remove' && 'Remove member'}
              {pendingAction.kind === 'leave' && 'Leave household'}
            </button>
            <button
              type="button"
              className="household-button household-button--secondary"
              onClick={cancelConfirm}
              disabled={writing !== null}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {!left && (
        <button
          type="button"
          className="household-button household-button--secondary"
          aria-label={`Leave ${household.name}`}
          onClick={(event) => openConfirm('leave', null, event.currentTarget)}
          disabled={!actionable}
        >
          Leave household
        </button>
      )}

      {notice && (
        <div
          ref={noticeRef}
          tabIndex={-1}
          role={notice.kind === 'error' ? 'alert' : 'status'}
          aria-live="polite"
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
              onClick={reloadRoster}
              disabled={rosterLoading || writing !== null}
            >
              Refresh members
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
