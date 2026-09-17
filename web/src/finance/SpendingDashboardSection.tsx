import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  fetchSpendingSummary,
  type Household,
  type SpendingSummary,
} from '../auth/client';
import { formatMoney } from './money';
import {
  currentMonthIntervalInZone,
  describeReportingPeriod,
  resolveCalculationZone,
  validateReportInterval,
} from './reporting';

interface DashboardNotice {
  kind: 'info' | 'error' | 'warning';
  text: string;
  correlationId?: string | undefined;
}

interface SpendingDashboardSectionProps {
  household: Household;
  /**
   * Authoritative reporting zone from the settings section. It seeds the
   * default month only; an explicit interval's results never depend on it.
   */
  reportingZone: string;
  /**
   * Bumped by the parent after every transaction/share/refund mutation so
   * the summary refetches for the currently shown period.
   */
  refreshSignal: number;
  onSessionExpired: () => void;
  onHouseholdAccessChanged: () => void;
  /** Injected clock for zone-month defaults; defaults to the current time. */
  nowProvider?: () => Date;
}

/** True for exact zero aggregates such as "0.00", "0", or "0.000". */
function isZeroAggregate(amount: string): boolean {
  const digits = amount.replace(/[^0-9]/g, '');
  return digits.length > 0 && /^0+$/.test(digits);
}

export function SpendingDashboardSection({
  household,
  reportingZone,
  refreshSignal,
  onSessionExpired,
  onHouseholdAccessChanged,
  nowProvider,
}: SpendingDashboardSectionProps) {
  const [summary, setSummary] = useState<SpendingSummary | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<DashboardNotice | null>(null);
  /**
   * Draft inputs versus the last applied interval. Typing never submits:
   * refreshes and mutation signals always resend the applied bounds, so an
   * intermediate or invalid draft can neither fetch nor clobber the view.
   */
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const [appliedFrom, setAppliedFrom] = useState('');
  const [appliedTo, setAppliedTo] = useState('');
  const [intervalError, setIntervalError] = useState<string | undefined>(
    undefined,
  );
  /**
   * False while the shown period is the zone-derived default month: a zone
   * change then recomputes the period. True once the viewer picks explicit
   * dates, which a zone change must never reinterpret.
   */
  const [customized, setCustomized] = useState(false);

  const genRef = useRef(0);
  const unmountedRef = useRef(false);
  const ownedRef = useRef<Set<AbortController>>(new Set());
  const noticeRef = useRef<HTMLDivElement>(null);
  const fromInputRef = useRef<HTMLInputElement>(null);
  const lastSignalRef = useRef(refreshSignal);
  const lastZoneRef = useRef(reportingZone);
  const nowProviderRef = useRef(nowProvider);
  useEffect(() => {
    nowProviderRef.current = nowProvider;
  }, [nowProvider]);

  function currentTime(): Date {
    return nowProviderRef.current ? nowProviderRef.current() : new Date();
  }

  function track(controller: AbortController) {
    ownedRef.current.add(controller);
  }

  function untrack(controller: AbortController) {
    ownedRef.current.delete(controller);
  }

  function isCurrent(generation: number): boolean {
    return !unmountedRef.current && genRef.current === generation;
  }

  function clearScopedState() {
    genRef.current += 1;
    setSummary(null);
    setLoaded(false);
    setDraftFrom('');
    setDraftTo('');
    setAppliedFrom('');
    setAppliedTo('');
    setIntervalError(undefined);
    setCustomized(false);
  }

  function handleSessionLost() {
    clearScopedState();
    onSessionExpired();
  }

  function handleAccessLost() {
    clearScopedState();
    onHouseholdAccessChanged();
  }

  function defaultInterval(zone: string): {
    from: string;
    to: string;
  } {
    // A stored zone the host browser cannot compute with falls back
    // explicitly to the documented initial zone — never silently to the
    // browser zone. The fallback warning below renders from the same
    // resolution, and the server-echoed period stays authoritative.
    const resolved = resolveCalculationZone(zone);
    return currentMonthIntervalInZone(resolved.zone, currentTime());
  }

  async function load(
    interval: { from: string; to: string },
    signal: AbortSignal,
    generation: number,
    clearNotice: boolean,
  ) {
    setLoading(true);
    if (clearNotice) {
      setNotice(null);
      setIntervalError(undefined);
    }
    try {
      const result = await fetchSpendingSummary(
        household.id,
        interval.from,
        interval.to,
        signal,
      );
      if (!isCurrent(generation) || signal.aborted) return;
      setSummary(result);
      setLoaded(true);
      // The applied interval follows the server echo, and the draft follows
      // it so the inputs always show what is actually displayed.
      setAppliedFrom(result.from);
      setAppliedTo(result.to);
      setDraftFrom(result.from);
      setDraftTo(result.to);
      setNotice(null);
      setIntervalError(undefined);
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
              message: 'Could not load the household spending summary.',
            });
      setLoading(false);
      if (apiError.status === 401) {
        handleSessionLost();
        return;
      }
      if (apiError.code === 'HOUSEHOLD_NOT_FOUND') {
        handleAccessLost();
        return;
      }
      // A failed refresh keeps the last good summary visible with an
      // explicit stale warning; only a first load renders the error alone.
      // The period inputs keep their values either way.
      const keepStale = loaded && summary !== null;
      if (apiError.timedOut) {
        setNotice({
          kind: keepStale ? 'warning' : 'error',
          text: keepStale
            ? 'Could not refresh the spending summary. The amounts shown may be stale. Refresh to try again.'
            : 'Loading the spending summary timed out. Refresh to try again.',
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
            ? 'Could not refresh the spending summary. The amounts shown may be stale. Refresh to try again.'
            : apiError.message ||
              'Could not load the household spending summary.',
        });
        return;
      }
      setNotice({
        kind: keepStale ? 'warning' : 'error',
        text: keepStale
          ? 'Could not refresh the spending summary. The amounts shown may be stale. Refresh to try again.'
          : apiError.message ||
            'Could not load the household spending summary.',
        correlationId: apiError.correlationId,
      });
    }
  }

  function startLoad(
    interval: { from: string; to: string },
    clearNotice: boolean,
  ): void {
    const generation = ++genRef.current;
    const controller = new AbortController();
    track(controller);
    void (async () => {
      try {
        await load(interval, controller.signal, generation, clearNotice);
      } finally {
        untrack(controller);
      }
    })();
  }

  useEffect(() => {
    unmountedRef.current = false;
    const initial = defaultInterval(lastZoneRef.current);
    const generation = ++genRef.current;
    const controller = new AbortController();
    ownedRef.current.add(controller);
    void (async () => {
      try {
        await load(initial, controller.signal, generation, true);
      } finally {
        ownedRef.current.delete(controller);
      }
    })();
    const owned = ownedRef.current;
    return () => {
      unmountedRef.current = true;
      genRef.current += 1;
      for (const tracked of owned) tracked.abort();
    };
    // Household identity and the initial zone are fixed for this keyed
    // instance; later zone/signal changes arrive through their effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every balance-affecting mutation bumps the parent's signal: resend the
  // last applied interval without touching the draft, so intermediate or
  // invalid typing is never submitted on refresh.
  useEffect(() => {
    if (lastSignalRef.current === refreshSignal) return;
    lastSignalRef.current = refreshSignal;
    if (appliedFrom === '' || appliedTo === '') return;
    startLoad({ from: appliedFrom, to: appliedTo }, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  // A zone change recomputes the default month only while the viewer has
  // not picked explicit dates; explicit intervals are never reinterpreted.
  useEffect(() => {
    if (lastZoneRef.current === reportingZone) return;
    lastZoneRef.current = reportingZone;
    if (customized) return;
    const next = defaultInterval(reportingZone);
    startLoad(next, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportingZone]);

  useEffect(() => {
    if (notice && noticeRef.current) noticeRef.current.focus();
  }, [notice]);

  function handleApply(event: FormEvent) {
    event.preventDefault();
    if (loading) return;
    const error = validateReportInterval(draftFrom, draftTo);
    if (error) {
      setIntervalError(error);
      requestAnimationFrame(() => fromInputRef.current?.focus());
      return;
    }
    setCustomized(true);
    setAppliedFrom(draftFrom);
    setAppliedTo(draftTo);
    startLoad({ from: draftFrom, to: draftTo }, true);
  }

  function handleCurrentMonth() {
    if (loading) return;
    setCustomized(false);
    const next = defaultInterval(reportingZone);
    setAppliedFrom(next.from);
    setAppliedTo(next.to);
    setDraftFrom(next.from);
    setDraftTo(next.to);
    startLoad(next, true);
  }

  function handleRefresh() {
    if (loading || appliedFrom === '' || appliedTo === '') return;
    startLoad({ from: appliedFrom, to: appliedTo }, true);
  }

  const readySummary = loaded && summary !== null ? summary : null;
  // Explicit, render-derived fallback: when the stored zone is
  // contract-valid but unsupported by this browser, monthly defaults use
  // Etc/UTC with this visible warning instead of throwing. The stored zone
  // and the server-echoed period below remain authoritative.
  const zoneResolution = resolveCalculationZone(reportingZone);

  return (
    <div
      className="spending-dashboard"
      data-testid="spending-dashboard-section"
      role="region"
      aria-labelledby={`spending-dashboard-title-${household.id}`}
    >
      <h4
        className="members-title"
        id={`spending-dashboard-title-${household.id}`}
      >
        Household spending
      </h4>
      <p className="finance-helper">
        Exact household spending for the chosen period, grouped per currency.
        This is spending — not member obligations, which appear separately under
        Member balances. Amounts are exact; there is no combined total across
        currencies.
      </p>
      {zoneResolution.fellBack && (
        <p role="status" className="household-stale">
          {`The stored reporting zone “${reportingZone}” is not supported by this browser for local date defaults, so monthly defaults use Etc/UTC. The stored zone and the period shown below remain authoritative.`}
        </p>
      )}

      {loading && !loaded && !notice && (
        <p role="status" aria-live="polite">
          Loading the spending summary…
        </p>
      )}
      {loading && loaded && (
        <p role="status" className="members-status">
          Refreshing the spending summary…
        </p>
      )}

      <form
        className="spending-controls"
        onSubmit={handleApply}
        noValidate
        aria-label="Spending period"
      >
        <div className="household-field">
          <label htmlFor={`spending-from-${household.id}`}>From date</label>
          <input
            id={`spending-from-${household.id}`}
            ref={fromInputRef}
            name="spending-from"
            type="date"
            required
            min="1900-01-01"
            max="9999-12-31"
            value={draftFrom}
            onChange={(event) => setDraftFrom(event.target.value)}
            aria-invalid={Boolean(intervalError)}
            aria-describedby={
              intervalError
                ? `spending-interval-error-${household.id}`
                : undefined
            }
            disabled={loading}
          />
        </div>
        <div className="household-field">
          <label htmlFor={`spending-to-${household.id}`}>To date</label>
          <input
            id={`spending-to-${household.id}`}
            name="spending-to"
            type="date"
            required
            min="1900-01-01"
            max="9999-12-31"
            value={draftTo}
            onChange={(event) => setDraftTo(event.target.value)}
            aria-invalid={Boolean(intervalError)}
            aria-describedby={
              intervalError
                ? `spending-interval-error-${household.id}`
                : undefined
            }
            disabled={loading}
          />
        </div>
        {intervalError && (
          <p
            id={`spending-interval-error-${household.id}`}
            role="alert"
            className="household-error"
          >
            {intervalError}
          </p>
        )}
        <div className="spending-actions">
          <button type="submit" className="household-button" disabled={loading}>
            Show period
          </button>
          <button
            type="button"
            className="household-button household-button--secondary"
            onClick={handleCurrentMonth}
            disabled={loading}
          >
            Current month
          </button>
        </div>
      </form>

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
          <button
            type="button"
            className="household-button household-button--secondary"
            onClick={handleRefresh}
            disabled={loading || appliedFrom === '' || appliedTo === ''}
          >
            Refresh summary
          </button>
        </div>
      )}

      {readySummary && (
        <p role="status" className="spending-period">
          {describeReportingPeriod(
            readySummary.from,
            readySummary.to,
            readySummary.reportingTimeZone,
          )}
        </p>
      )}

      {readySummary && readySummary.currencies.length === 0 && (
        <p role="status" className="finance-empty">
          No household spending in this period. Only household-visible posted
          entries count; private and voided entries are excluded, and nothing is
          invented for empty periods.
        </p>
      )}

      {readySummary && readySummary.currencies.length > 0 && (
        <ul
          className="spending-groups"
          aria-label="Household spending by currency"
        >
          {readySummary.currencies.map((group) => {
            const transferOnly =
              isZeroAggregate(group.expenseTotal) &&
              isZeroAggregate(group.refundTotal) &&
              isZeroAggregate(group.incomeTotal);
            const netNegative = group.netSpending.startsWith('-');
            return (
              <li key={group.currency} className="spending-group">
                <p className="spending-currency">Currency: {group.currency}</p>
                <dl className="spending-rows">
                  <div className="spending-row">
                    <dt>Expense total</dt>
                    <dd>{formatMoney(group.expenseTotal, group.currency)}</dd>
                  </div>
                  <div className="spending-row">
                    <dt>Refund total</dt>
                    <dd>{formatMoney(group.refundTotal, group.currency)}</dd>
                  </div>
                  <div className="spending-row">
                    <dt>
                      Net spending{' '}
                      <span className="finance-note-chip">
                        {netNegative ? 'net refund' : 'expenses minus refunds'}
                      </span>
                    </dt>
                    <dd>{formatMoney(group.netSpending, group.currency)}</dd>
                  </div>
                  <div className="spending-row">
                    <dt>
                      Income total{' '}
                      <span className="finance-note-chip">
                        separate from spending
                      </span>
                    </dt>
                    <dd>{formatMoney(group.incomeTotal, group.currency)}</dd>
                  </div>
                </dl>
                {transferOnly && (
                  <p className="finance-helper">
                    Only transfers in {group.currency} — no spending or income.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
