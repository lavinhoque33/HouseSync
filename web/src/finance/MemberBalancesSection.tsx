import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  fetchMemberBalances,
  type Household,
  type MemberBalances,
} from '../auth/client';
import { formatMoney } from './money';

interface BalancesNotice {
  kind: 'info' | 'error' | 'warning';
  text: string;
  correlationId?: string | undefined;
}

interface MemberBalancesSectionProps {
  household: Household;
  /** Signed-in account id, marking the viewer's own balance row. */
  currentUserId: string;
  /**
   * Bumped by the parent after every mutation that changes derived
   * balances (allocation create/revoke, refund create/correct/void,
   * expense void) so the derived view refreshes without a global reload.
   */
  refreshSignal: number;
  onSessionExpired: () => void;
  onHouseholdAccessChanged: () => void;
}

/**
 * Exact text for a signed balance amount: positive amounts mean the user
 * is owed, negative amounts mean the user owes. Direction is carried by
 * these words, never by color alone.
 */
function balanceDirectionText(amount: string): string {
  if (amount.startsWith('-')) return 'owes';
  return 'is owed';
}

export function MemberBalancesSection({
  household,
  currentUserId,
  refreshSignal,
  onSessionExpired,
  onHouseholdAccessChanged,
}: MemberBalancesSectionProps) {
  const [balances, setBalances] = useState<MemberBalances | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<BalancesNotice | null>(null);

  const genRef = useRef(0);
  const unmountedRef = useRef(false);
  const ownedRef = useRef<Set<AbortController>>(new Set());
  const noticeRef = useRef<HTMLDivElement>(null);
  const lastSignalRef = useRef(refreshSignal);

  function track(controller: AbortController) {
    ownedRef.current.add(controller);
  }

  function untrack(controller: AbortController) {
    ownedRef.current.delete(controller);
  }

  function isCurrent(generation: number): boolean {
    return !unmountedRef.current && genRef.current === generation;
  }

  async function load(signal: AbortSignal, generation: number): Promise<void> {
    setLoading(true);
    setNotice(null);
    try {
      const result = await fetchMemberBalances(household.id, signal);
      if (!isCurrent(generation) || signal.aborted) return;
      setBalances(result);
      setLoaded(true);
      setNotice(null);
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
                'Could not reach the server. Check your connection and retry.',
            });
      setLoading(false);
      if (apiError.status === 401) {
        // Derived household data about other people: drop it before the
        // parent unmounts this section during sign-in-again recovery.
        setBalances(null);
        setLoaded(false);
        onSessionExpired();
        return;
      }
      if (apiError.code === 'HOUSEHOLD_NOT_FOUND') {
        // Access to the household was lost: drop retained balances and
        // reconcile the household collection.
        setBalances(null);
        setLoaded(false);
        onHouseholdAccessChanged();
        return;
      }
      // A failed refresh keeps the last good balances visible with an
      // explicit stale warning; only a first load (nothing retained yet)
      // renders the error alone.
      const keepStale = loaded && balances !== null;
      if (apiError.timedOut) {
        setNotice({
          kind: keepStale ? 'warning' : 'error',
          text: keepStale
            ? 'Could not refresh member balances. The amounts shown may be stale. Refresh to try again.'
            : 'Loading balances timed out. Refresh to try again.',
        });
        return;
      }
      if (
        apiError.code === 'FINANCE_BUSY' ||
        apiError.code === 'NETWORK_ERROR'
      ) {
        setNotice({
          kind: keepStale ? 'warning' : 'error',
          text: keepStale
            ? 'Could not refresh member balances. The amounts shown may be stale. Refresh to try again.'
            : apiError.message || 'Could not load household member balances.',
        });
        return;
      }
      setNotice({
        kind: keepStale ? 'warning' : 'error',
        text: keepStale
          ? 'Could not refresh member balances. The amounts shown may be stale. Refresh to try again.'
          : apiError.message || 'Could not load household member balances.',
        correlationId: apiError.correlationId,
      });
    }
  }

  function startLoad(): void {
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

  useEffect(() => {
    unmountedRef.current = false;
    startLoad();
    const owned = ownedRef.current;
    return () => {
      unmountedRef.current = true;
      for (const tracked of owned) tracked.abort();
    };
    // Household identity is fixed for this keyed component instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every balance-affecting mutation bumps the parent's signal. A signal
  // arriving during a load is never dropped: the later value wins and one
  // fresh fetch follows the settled one.
  useEffect(() => {
    if (lastSignalRef.current === refreshSignal) return;
    lastSignalRef.current = refreshSignal;
    startLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  useEffect(() => {
    if (notice && noticeRef.current) noticeRef.current.focus();
  }, [notice]);

  // Retained balances stay rendered even while a stale-warning notice is
  // up, so a transient refresh failure never blanks the last good view;
  // only a first load (nothing retained) leaves the list empty.
  const readyBalances = loaded && balances !== null ? balances : null;

  return (
    <div
      className="member-balances"
      data-testid="member-balances-section"
      role="region"
      aria-labelledby={`member-balances-title-${household.id}`}
    >
      <h4
        className="members-title"
        id={`member-balances-title-${household.id}`}
      >
        Member balances
      </h4>
      <p className="finance-helper">
        Derived from active allocations of shared expenses in this household,
        grouped per currency. Positive amounts are owed to the member; negative
        amounts are owed by the member. There is no bank balance, combined sum
        across currencies, or settlement suggestion here.
      </p>

      {loading && !loaded && !notice && (
        <p role="status" aria-live="polite">
          Loading member balances…
        </p>
      )}
      {loading && loaded && (
        <p role="status" className="members-status">
          Refreshing member balances…
        </p>
      )}

      {notice && (
        <div
          ref={noticeRef}
          tabIndex={-1}
          role="alert"
          className={`household-notice household-notice--${notice.kind}`}
        >
          <p>{notice.text}</p>
          {notice.correlationId && (
            <p className="household-notice-detail">
              Reference: {notice.correlationId}
            </p>
          )}
          <button
            type="button"
            className="household-button household-button--secondary"
            onClick={startLoad}
            disabled={loading}
          >
            Refresh balances
          </button>
        </div>
      )}

      {readyBalances && readyBalances.currencies.length === 0 && (
        <p role="status" className="finance-empty">
          No member balances. Balances appear only after a household expense
          with an active allocation; nothing is invented for empty currencies.
        </p>
      )}

      {readyBalances && readyBalances.currencies.length > 0 && (
        <ul
          className="member-balances-groups"
          aria-label="Member balances by currency"
        >
          {readyBalances.currencies.map((group) => (
            <li key={group.currency} className="member-balances-group">
              <p className="member-balances-currency">
                Currency: {group.currency}
              </p>
              <ul
                className="member-balances-rows"
                aria-label={`Balances in ${group.currency}`}
              >
                {group.balances.map((entry) => {
                  const isSelf = entry.userId === currentUserId;
                  return (
                    <li
                      key={entry.userId}
                      className="member-balance-row"
                      data-membership-status={entry.membershipStatus}
                    >
                      <p className="member-balance-user">
                        {isSelf ? 'You' : 'Member'}{' '}
                        <span className="member-balance-uuid">
                          {entry.userId}
                        </span>
                      </p>
                      <p className="member-balance-amount">
                        {formatMoney(entry.amount, group.currency)}
                        <span className="finance-note-chip">
                          {balanceDirectionText(entry.amount)}
                        </span>
                      </p>
                      <p className="member-balance-status">
                        {entry.membershipStatus === 'CURRENT'
                          ? 'Current member'
                          : 'Departed member'}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
