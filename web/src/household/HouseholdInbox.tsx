import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, fetchBankActivity, type Household } from '../auth/client';
import { householdPath } from '../navigation';
import { AppLink } from '../NavigationMenu';
import { Icon } from '../ui/Icon';

type Count =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; value: number };

export function HouseholdInbox({
  household,
  target,
  refreshSignal,
  page,
  onSessionExpired,
  onHouseholdAccessChanged,
}: {
  household: Household;
  target: HTMLElement;
  refreshSignal: number;
  page: string;
  onSessionExpired: () => void;
  onHouseholdAccessChanged: () => void;
}) {
  const [result, setResult] = useState<{ key: string; count: Count } | null>(
    null,
  );
  const handlers = useRef({ onSessionExpired, onHouseholdAccessChanged });
  useEffect(() => {
    handlers.current = { onSessionExpired, onHouseholdAccessChanged };
  }, [onSessionExpired, onHouseholdAccessChanged]);
  const requestKey = `${household.id}:${household.role}:${page}:${refreshSignal}`;
  const count =
    result?.key === requestKey ? result.count : { kind: 'loading' as const };
  useEffect(() => {
    const controller = new AbortController();
    void fetchBankActivity(
      household.id,
      { limit: 1, offset: 0 },
      controller.signal,
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        setResult({
          key: requestKey,
          count: {
            kind: 'ready',
            value: value.unreviewedCount + value.changedCount,
          },
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setResult({ key: requestKey, count: { kind: 'unavailable' } });
        if (error instanceof ApiError && error.status === 401)
          handlers.current.onSessionExpired();
        if (
          error instanceof ApiError &&
          (error.status === 403 || error.code === 'HOUSEHOLD_NOT_FOUND')
        )
          handlers.current.onHouseholdAccessChanged();
      });
    return () => controller.abort();
  }, [household.id, household.role, refreshSignal, page, requestKey]);

  const suffix =
    count.kind === 'ready'
      ? `, ${count.value} bank activity ${count.value === 1 ? 'item needs' : 'items need'} attention`
      : count.kind === 'unavailable'
        ? ', count unavailable'
        : ', count loading';
  return createPortal(
    <AppLink
      to={householdPath(household.id, 'bank-activity')}
      className="icon-button household-inbox"
      aria-label={`Bank activity inbox for ${household.name}${suffix}`}
      title={`Bank activity inbox${suffix}`}
    >
      <Icon name="inbox" />
      {count.kind === 'ready' && count.value > 0 && (
        <span className="household-inbox__badge" aria-hidden="true">
          {count.value > 99 ? '99+' : count.value}
        </span>
      )}
      {count.kind === 'unavailable' && (
        <span className="household-inbox__unavailable" aria-hidden="true">
          !
        </span>
      )}
    </AppLink>,
    target,
  );
}
