import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  fetchFinancialAccounts,
  fetchHouseholdMembers,
  type FinancialAccountPage,
  type Household,
} from '../auth/client';
import { Icon } from '../ui/Icon';
import { householdPath } from '../navigation';
import { AppLink } from '../NavigationMenu';

interface Summary {
  members: number | null;
  accounts: FinancialAccountPage | null;
  memberError: boolean;
  accountError: boolean;
}

const KINDS = [
  ['CASH', 'Cash'],
  ['CHECKING', 'Checking'],
  ['SAVINGS', 'Savings'],
  ['CREDIT_CARD', 'Credit cards'],
] as const;
const COLORS = ['#4f46e5', '#0e7490', '#b45309', '#be185d'];

export function HouseholdCard({
  household,
  currentUserId,
  enabled,
  accessUnavailable,
  onRetryAccess,
  onSessionExpired,
  onHouseholdAccessChanged,
  refreshSignal,
}: {
  household: Household;
  currentUserId: string;
  enabled: boolean;
  accessUnavailable: boolean;
  onRetryAccess: () => void;
  onSessionExpired: () => void;
  onHouseholdAccessChanged: () => void;
  refreshSignal: number;
}) {
  const cardRef = useRef<HTMLLIElement>(null);
  const [visible, setVisible] = useState(
    () => typeof IntersectionObserver === 'undefined',
  );
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    summary: Summary;
  } | null>(null);
  const handlers = useRef({ onSessionExpired, onHouseholdAccessChanged });
  useEffect(() => {
    handlers.current = { onSessionExpired, onHouseholdAccessChanged };
  }, [onSessionExpired, onHouseholdAccessChanged]);
  const requestKey = `${household.id}:${household.role}:${enabled}:${visible}:${refreshSignal}:${retry}`;
  const summary =
    enabled && visible && result?.key === requestKey ? result.summary : null;

  useEffect(() => {
    if (!enabled || visible) return;
    const node = cardRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '160px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, visible]);

  useEffect(() => {
    if (!enabled || !visible) return;
    const controller = new AbortController();
    const handleError = (error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) {
        controller.abort();
        handlers.current.onSessionExpired();
      } else if (
        error instanceof ApiError &&
        (error.status === 403 || error.code === 'HOUSEHOLD_NOT_FOUND')
      ) {
        controller.abort();
        handlers.current.onHouseholdAccessChanged();
      }
    };
    void Promise.allSettled([
      fetchHouseholdMembers(household.id, controller.signal),
      fetchFinancialAccounts(household.id, controller.signal),
    ]).then(([members, accounts]) => {
      if (controller.signal.aborted) return;
      if (members.status === 'rejected') handleError(members.reason);
      if (accounts.status === 'rejected') handleError(accounts.reason);
      if (controller.signal.aborted) return;
      setResult({
        key: requestKey,
        summary: {
          members: members.status === 'fulfilled' ? members.value.length : null,
          accounts: accounts.status === 'fulfilled' ? accounts.value : null,
          memberError: members.status === 'rejected',
          accountError: accounts.status === 'rejected',
        },
      });
    });
    return () => controller.abort();
  }, [
    enabled,
    visible,
    household.id,
    household.role,
    retry,
    refreshSignal,
    requestKey,
  ]);

  const accounts = enabled ? summary?.accounts : null;
  const own =
    accounts?.items.filter(
      (account) => account.ownerUserId === currentUserId,
    ) ?? [];
  // When the bounded page has a continuation, even the number of own accounts
  // is a lower bound: later pages may contain more of the viewer's records.
  const counts = KINDS.map(
    ([kind]) => own.filter((account) => account.kind === kind).length,
  );
  const total = own.length;
  let used = 0;
  const segments: string[] = [];
  for (let index = 0; index < counts.length; index += 1) {
    const count = counts[index] ?? 0;
    if (!count || !total) continue;
    const start = (used / total) * 100;
    used += count;
    segments.push(`${COLORS[index]} ${start}% ${(used / total) * 100}%`);
  }
  const totalLabel = accounts?.hasMore
    ? `${total} of your private accounts in this page; more accounts may exist`
    : `${total} of your private accounts`;

  return (
    <li ref={cardRef} className="household-card">
      <div className="household-card__heading">
        <span className="household-card__icon" aria-hidden="true">
          <Icon name="home" />
        </span>
        <div>
          <h4 className="household-name">{household.name}</h4>
          <p className="household-meta">
            {household.role.toLowerCase()} · Created{' '}
            <time dateTime={household.createdAt}>
              {new Date(household.createdAt).toLocaleDateString()}
            </time>
          </p>
        </div>
      </div>
      <div className="household-card__summary">
        <p className="household-card__member-count">
          <Icon name="users" />{' '}
          {accessUnavailable
            ? 'Member count unavailable'
            : !enabled
              ? 'Refresh the directory for member count'
              : summary === null
                ? 'Loading members…'
                : summary.members === null
                  ? 'Members unavailable'
                  : `${summary.members} ${summary.members === 1 ? 'member' : 'members'}`}
        </p>
        {accounts ? (
          <div
            className="household-card__accounts"
            role="group"
            aria-label="Your private account types"
          >
            <div
              className="household-card__donut"
              role="img"
              aria-label={`${totalLabel}; ${KINDS.map(([, label], index) => `${counts[index]} ${label}`).join(', ')}`}
              style={{
                background: segments.length
                  ? `conic-gradient(${segments.join(', ')})`
                  : undefined,
              }}
            >
              <span>{accounts.hasMore ? `${total} shown` : total}</span>
            </div>
            <div className="household-card__account-detail">
              <strong>{totalLabel}</strong>
              <span>
                {own.filter((account) => account.status === 'ACTIVE').length}{' '}
                active ·{' '}
                {own.filter((account) => account.status === 'ARCHIVED').length}{' '}
                archived{accounts.hasMore ? ' in this page' : ''}
              </span>
              <span className="household-card__legend">
                {KINDS.map(([, label], index) => (
                  <span key={label}>
                    <i style={{ backgroundColor: COLORS[index] }} />
                    {label}: {counts[index]}
                    {accounts.hasMore ? ' shown' : ''}
                  </span>
                ))}
              </span>
            </div>
          </div>
        ) : (
          <p className="household-card__unavailable">
            {accessUnavailable
              ? 'Private account summary unavailable.'
              : !enabled
                ? 'Refresh the directory for your account summary.'
                : summary?.accountError
                  ? 'Private accounts unavailable.'
                  : 'Loading your private accounts…'}
          </p>
        )}
        {accessUnavailable && (
          <button
            type="button"
            className="household-button household-button--secondary"
            onClick={onRetryAccess}
          >
            Retry household access
          </button>
        )}
        {(summary?.memberError || summary?.accountError) && enabled && (
          <button
            type="button"
            className="household-button household-button--secondary"
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry summary
          </button>
        )}
      </div>
      <AppLink
        to={householdPath(household.id, 'overview')}
        className="household-card__open"
        aria-label={`Open ${household.name}`}
      >
        <span>Open household</span>
        <Icon name="arrow-right" />
      </AppLink>
    </li>
  );
}
