import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  fetchContributionSummary,
  type ContributionSummary,
  type FinancialAccountCurrency,
  type Household,
} from '../auth/client';
import { formatMoney } from './money';
import {
  currentMonthIntervalInZone,
  describeReportingPeriod,
  resolveCalculationZone,
  validateReportInterval,
} from './reporting';

interface Props {
  household: Household;
  reportingZone: string;
  refreshSignal: number;
  membershipRefreshSignal: number;
  onSessionExpired: () => void;
  onHouseholdAccessChanged: () => void;
  nowProvider?: (() => Date) | undefined;
}

type Selection = {
  from: string;
  to: string;
  currency: FinancialAccountCurrency;
};
const CURRENCIES: FinancialAccountCurrency[] = [
  'USD',
  'CAD',
  'BRL',
  'EUR',
  'GBP',
  'JPY',
  'KWD',
];
const PAGE_SIZE = 50;

export function ContributionSummarySection({
  household,
  reportingZone,
  refreshSignal,
  membershipRefreshSignal,
  onSessionExpired,
  onHouseholdAccessChanged,
  nowProvider,
}: Props) {
  const [draft, setDraft] = useState<Selection>(() => ({
    ...currentMonthIntervalInZone(
      resolveCalculationZone(reportingZone).zone,
      nowProvider?.() ?? new Date(),
    ),
    currency: 'USD',
  }));
  const [applied, setApplied] = useState<Selection>(draft);
  const [customized, setCustomized] = useState(false);
  const [summary, setSummary] = useState<ContributionSummary | null>(null);
  const [items, setItems] = useState<ContributionSummary['items']>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  const draftTouched = useRef(false);
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const lastSignal = useRef(refreshSignal);
  const lastMembership = useRef(membershipRefreshSignal);
  const lastZone = useRef(reportingZone);
  const nowRef = useRef(nowProvider);
  const noticeRef = useRef<HTMLDivElement>(null);
  const fromRef = useRef<HTMLInputElement>(null);
  const pageButtonRef = useRef<HTMLButtonElement>(null);
  const returnPageFocus = useRef(false);
  const periodRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    nowRef.current = nowProvider;
  }, [nowProvider]);

  function request(selection: Selection, continuation?: ContributionSummary) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const sequence = ++generation.current;
    setLoading(true);
    setError(null);
    if (!continuation) {
      setRestartRequired(false);
      returnPageFocus.current = false;
      setStale(summary !== null);
    }
    void fetchContributionSummary(
      household.id,
      selection.from,
      selection.to,
      selection.currency,
      {
        limit: PAGE_SIZE,
        offset: continuation ? items.length : 0,
        ...(continuation ? { snapshot: continuation.snapshot } : {}),
        signal: controller.signal,
      },
    )
      .then((result) => {
        if (controller.signal.aborted || generation.current !== sequence)
          return;
        if (
          continuation &&
          (result.snapshot !== continuation.snapshot ||
            result.from !== continuation.from ||
            result.to !== continuation.to ||
            result.currency !== continuation.currency ||
            JSON.stringify(result.totals) !==
              JSON.stringify(continuation.totals) ||
            (items.length > 0 &&
              result.items.length > 0 &&
              result.items[0]!.userId <= items[items.length - 1]!.userId))
        )
          throw new Error('Contribution pages disagree.');
        setSummary(result);
        setItems(continuation ? [...items, ...result.items] : result.items);
        setStale(false);
        setLoading(false);
        if (pending.current === controller) pending.current = null;
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || generation.current !== sequence)
          return;
        returnPageFocus.current = false;
        if (pending.current === controller) pending.current = null;
        if (cause instanceof ApiError && cause.status === 401) {
          setSummary(null);
          setItems([]);
          setStale(false);
          onSessionExpired();
          return;
        }
        if (
          cause instanceof ApiError &&
          cause.status === 404 &&
          cause.code === 'HOUSEHOLD_NOT_FOUND'
        ) {
          setSummary(null);
          setItems([]);
          setStale(false);
          onHouseholdAccessChanged();
          return;
        }
        if (
          continuation &&
          cause instanceof ApiError &&
          cause.status === 409 &&
          cause.code === 'CONTRIBUTION_SNAPSHOT_STALE'
        ) {
          setSummary(null);
          setItems([]);
          setStale(false);
          setRestartRequired(true);
          setError(
            'Contributions changed since this page was loaded. Previous pages were cleared; restart from the first page.',
          );
          return;
        }
        setStale(summary !== null);
        setError(
          cause instanceof ApiError && cause.timedOut
            ? 'Loading contributions timed out. Retry to get a current snapshot.'
            : 'Could not load current contributions. Retry to get a current snapshot.',
        );
      });
  }

  useEffect(() => {
    let cancelled = false;
    const scheduledAt = generation.current;
    void Promise.resolve().then(() => {
      if (!cancelled && generation.current === scheduledAt) request(applied);
    });
    const pendingRequest = pending;
    return () => {
      cancelled = true;
      pendingRequest.current?.abort();
    };
    // Each household is keyed by the parent; later inputs and signals are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [household.id]);

  useEffect(() => {
    if (
      lastSignal.current === refreshSignal &&
      lastMembership.current === membershipRefreshSignal
    )
      return;
    lastSignal.current = refreshSignal;
    lastMembership.current = membershipRefreshSignal;
    request(applied);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal, membershipRefreshSignal]);

  useEffect(() => {
    if (lastZone.current === reportingZone) return;
    lastZone.current = reportingZone;
    if (!customized) {
      const next = {
        ...currentMonthIntervalInZone(
          resolveCalculationZone(reportingZone).zone,
          nowRef.current?.() ?? new Date(),
        ),
        currency: applied.currency,
      };
      setApplied(next);
      if (!draftTouched.current) {
        setDraft((previous) => ({ ...previous, from: next.from, to: next.to }));
      }
      request(next);
    } else {
      request(applied);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportingZone]);

  useEffect(() => {
    if (error) noticeRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (!returnPageFocus.current) return;
    returnPageFocus.current = false;
    (pageButtonRef.current ?? periodRef.current)?.focus();
  }, [items, summary]);

  function apply(event: FormEvent) {
    event.preventDefault();
    const invalid = validateReportInterval(draft.from, draft.to);
    if (invalid) {
      setValidation(invalid);
      requestAnimationFrame(() => fromRef.current?.focus());
      return;
    }
    setValidation(null);
    setCustomized(true);
    setApplied(draft);
    request(draft);
  }
  function currentMonth() {
    const next = {
      ...currentMonthIntervalInZone(
        resolveCalculationZone(reportingZone).zone,
        nowRef.current?.() ?? new Date(),
      ),
      currency: draft.currency,
    };
    setCustomized(false);
    setDraft(next);
    draftTouched.current = false;
    setApplied(next);
    setValidation(null);
    request(next);
  }

  const incomplete = summary?.hasMore && items.length > 10000;
  return (
    <div
      className="contribution-section"
      role="region"
      aria-labelledby={`contribution-title-${household.id}`}
    >
      <h4 className="members-title" id={`contribution-title-${household.id}`}>
        Period contributions
      </h4>
      <p className="finance-helper">
        Who paid for household purchases versus who bears their currently
        assigned cost. These are posted, household-visible expenses and refunds,
        not all-time member balances or repayment activity. No money is sent
        here.
      </p>
      <p className="finance-helper">
        Corrections, sharing and allocations restate earlier periods under the
        current state, not what anyone owed at month end. For all-time balances
        and suggested repayments, see the separate panels above; your own
        external repayment activity is shown separately.
      </p>
      {resolveCalculationZone(reportingZone).fellBack && (
        <p role="status" className="household-stale">
          This browser cannot use {reportingZone} to select the default month;
          Etc/UTC was used for the default dates. The server-reported zone below
          is authoritative.
        </p>
      )}
      <form
        className="contribution-controls"
        aria-label="Contribution period and currency"
        onSubmit={apply}
        noValidate
      >
        <div className="household-field">
          <label htmlFor={`contribution-from-${household.id}`}>
            Contribution from date
          </label>
          <input
            ref={fromRef}
            id={`contribution-from-${household.id}`}
            type="date"
            min="1900-01-01"
            max="9999-12-31"
            required
            value={draft.from}
            onChange={(event) => {
              draftTouched.current = true;
              setDraft({ ...draft, from: event.target.value });
            }}
            aria-invalid={Boolean(validation)}
            aria-describedby={
              validation ? `contribution-error-${household.id}` : undefined
            }
          />
        </div>
        <div className="household-field">
          <label htmlFor={`contribution-to-${household.id}`}>
            Contribution to date (excluded)
          </label>
          <input
            id={`contribution-to-${household.id}`}
            type="date"
            min="1900-01-01"
            max="9999-12-31"
            required
            value={draft.to}
            onChange={(event) => {
              draftTouched.current = true;
              setDraft({ ...draft, to: event.target.value });
            }}
            aria-invalid={Boolean(validation)}
            aria-describedby={
              validation ? `contribution-error-${household.id}` : undefined
            }
          />
        </div>
        <div className="household-field">
          <label htmlFor={`contribution-currency-${household.id}`}>
            Contribution currency
          </label>
          <select
            id={`contribution-currency-${household.id}`}
            value={draft.currency}
            onChange={(event) => {
              draftTouched.current = true;
              setDraft({
                ...draft,
                currency: event.target.value as FinancialAccountCurrency,
              });
            }}
          >
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>
        {validation && (
          <p
            id={`contribution-error-${household.id}`}
            role="alert"
            className="household-error"
          >
            {validation}
          </p>
        )}
        <div className="contribution-actions">
          <button type="submit" className="household-button">
            Show contributions
          </button>
          <button
            type="button"
            className="household-button household-button--secondary"
            onClick={currentMonth}
          >
            Current contribution month
          </button>
        </div>
      </form>
      {loading && (
        <p role="status">
          {summary ? 'Refreshing contributions…' : 'Loading contributions…'}
        </p>
      )}
      {error && (
        <div
          ref={noticeRef}
          tabIndex={-1}
          role="alert"
          className="household-notice household-notice--warning"
        >
          <p>{error}</p>
          <button
            type="button"
            className="household-button household-button--secondary"
            onClick={() => request(applied)}
          >
            {restartRequired ? 'Restart contributions' : 'Retry contributions'}
          </button>
        </div>
      )}
      {stale && summary && (
        <p role="status" className="household-stale">
          The contribution amounts shown may be stale. Retry to load current
          amounts.
        </p>
      )}
      {summary && (
        <>
          <p ref={periodRef} tabIndex={-1} className="spending-period">
            {describeReportingPeriod(
              summary.from,
              summary.to,
              summary.reportingTimeZone,
            )}{' '}
            Currency: {summary.currency}.
          </p>
          <p className="finance-helper">
            Expense and refund totals match the household spending dashboard’s
            posted household expense/refund definitions for this period and
            currency. Refunds reduce the payer’s net paid and may make a period
            cost negative.
          </p>
          <dl className="contribution-totals">
            <div>
              <dt>Expense total</dt>
              <dd>
                {formatMoney(summary.totals.expenseTotal, summary.currency)}
              </dd>
            </div>
            <div>
              <dt>Refund total</dt>
              <dd>
                {formatMoney(summary.totals.refundTotal, summary.currency)}
              </dd>
            </div>
            <div>
              <dt>Net spending (expenses minus refunds)</dt>
              <dd>
                {formatMoney(summary.totals.netSpending, summary.currency)}
              </dd>
            </div>
            <div>
              <dt>Assigned cost total</dt>
              <dd>
                {formatMoney(
                  summary.totals.allocatedCostTotal,
                  summary.currency,
                )}
              </dd>
            </div>
            <div>
              <dt>Unallocated net</dt>
              <dd>
                {formatMoney(summary.totals.unallocatedNet, summary.currency)}
              </dd>
            </div>
          </dl>
          <p className="finance-helper">
            Unallocated net is household-visible spending without an active
            allocation; it is not assigned to a guessed debtor. Totals cover
            every contributor, even if more rows remain.
          </p>
          {items.length === 0 && !summary.hasMore && (
            <p role="status" className="finance-empty">
              No contributions in {summary.currency} for this period. Totals are
              exactly zero.
            </p>
          )}
          {items.length > 0 && (
            <>
              <p
                className="finance-helper"
                id={`contribution-scroll-help-${household.id}`}
              >
                Scroll the member table sideways to see every column. With a
                keyboard, focus the table and use the arrow keys.
              </p>
              <div
                className="contribution-table-wrap"
                role="region"
                aria-label="Scrollable member contributions table"
                aria-describedby={`contribution-scroll-help-${household.id}`}
                tabIndex={0}
              >
                <table className="contribution-table">
                  <caption>
                    Member contributions in {summary.currency}; {summary.from}{' '}
                    to {summary.to} (end excluded)
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Member</th>
                      <th scope="col">Expense paid</th>
                      <th scope="col">Refund received</th>
                      <th scope="col">Net paid</th>
                      <th scope="col">Assigned cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.userId}>
                        <th scope="row">
                          <span className="contribution-user">
                            {item.userId}
                          </span>
                          <small>
                            {item.membershipStatus === 'DEPARTED'
                              ? 'Departed member'
                              : 'Current member'}
                          </small>
                        </th>
                        <td>
                          {formatMoney(item.expensePaid, summary.currency)}
                        </td>
                        <td>
                          {formatMoney(item.refundReceived, summary.currency)}
                        </td>
                        <td>{formatMoney(item.netPaid, summary.currency)}</td>
                        <td>
                          {formatMoney(item.allocatedCost, summary.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {summary.hasMore && !incomplete && (
            <button
              ref={pageButtonRef}
              type="button"
              className="household-button household-button--secondary"
              disabled={loading}
              onClick={() => {
                returnPageFocus.current =
                  document.activeElement === pageButtonRef.current;
                request(applied, summary);
              }}
            >
              Load more contributors
            </button>
          )}
          {incomplete && (
            <p role="status" className="household-stale">
              Member rows are incomplete at the 10,000 offset limit. The totals
              still cover the full period; narrow the date range to see other
              rows.
            </p>
          )}
        </>
      )}
    </div>
  );
}
