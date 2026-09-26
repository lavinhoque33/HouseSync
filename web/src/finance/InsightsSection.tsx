import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from 'react';
import {
  ApiError,
  fetchInsightComparison,
  fetchInsightEvidence,
  fetchInsightSeries,
  fetchInsightSummary,
  type Household,
  type CsrfToken,
} from '../auth/client';
import { RecurringSection } from './RecurringSection';
import { BudgetSection, type PendingBudgetCreate } from './BudgetSection';
import { formatMoney, type FinancialAccountCurrency } from './money';
import {
  insightMonthRange,
  isInsightMonth,
  nextInsightMonth,
  type InsightComparison,
  type InsightDimension,
  type InsightEvidence,
  type InsightGroup,
  type InsightSeries,
  type InsightSpend,
} from './insights';
import { SummaryView } from './SummaryView';
import type { InsightSummary } from './summary';
import { resolveCalculationZone, todayInZone } from './reporting';

const currencies: FinancialAccountCurrency[] = [
  'BRL',
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'JPY',
  'KWD',
];
type Choice = {
  month: string;
  baseline: string;
  currency: FinancialAccountCurrency;
  dimension: InsightDimension;
};
type Page = {
  data: InsightEvidence;
  items: InsightEvidence['items'];
  cursor: string | null;
};
function previousMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const number = Number(month.slice(5));
  return number === 1
    ? `${String(year - 1).padStart(4, '0')}-12`
    : `${String(year).padStart(4, '0')}-${String(number - 1).padStart(2, '0')}`;
}
function defaultChoice(zone: string, now: Date): Choice {
  const month = todayInZone(resolveCalculationZone(zone).zone, now).slice(0, 7);
  const supported = isInsightMonth(month)
    ? month
    : month > '9999-11'
      ? '9999-11'
      : '1900-02';
  return {
    month: supported,
    baseline: previousMonth(supported),
    currency: 'USD',
    dimension: 'CATEGORY',
  };
}
function seriesFrom(month: string): string {
  let start = month;
  for (let index = 1; index < 12 && start > '1900-01'; index++)
    start = previousMonth(start);
  return start;
}
function amount(value: string, currency: FinancialAccountCurrency) {
  return formatMoney(value, currency);
}
/**
 * Canonical series amounts all have the same currency scale. Stripping the
 * decimal point preserves exact relative magnitudes without any JS Number
 * conversion of money; this is visual geometry only, never reported totals.
 */
function signedChartUnits(value: string): bigint {
  const negative = value.startsWith('-');
  const digits = (negative ? value.slice(1) : value).replace('.', '');
  const magnitude = BigInt(digits);
  return negative ? -magnitude : magnitude;
}

function MonthlyNetChart({
  series,
  currency,
}: {
  series: InsightSeries;
  currency: FinancialAccountCurrency;
}) {
  const values = series.items.map(({ totals }) =>
    signedChartUnits(totals.netSpending),
  );
  const maximum = values.reduce((largest, value) => {
    const magnitude = value < 0n ? -value : value;
    return magnitude > largest ? magnitude : largest;
  }, 0n);
  return (
    <figure className="insights-chart" aria-hidden="true">
      <figcaption>Monthly net spending · {currency}</figcaption>
      <div className="insights-chart-legend">
        Refund-heavy net ← zero → positive net
      </div>
      <ol>
        {series.items.map((item, index) => {
          const value = values[index]!;
          const magnitude = value < 0n ? -value : value;
          const rounded =
            maximum === 0n ? 0n : (magnitude * 100n + maximum / 2n) / maximum;
          const width = magnitude !== 0n && rounded === 0n ? 1n : rounded;
          return (
            <li key={item.period.month}>
              <span className="insights-chart-month">{item.period.month}</span>
              <div className="insights-chart-axis">
                {value < 0n && (
                  <span
                    className="insights-chart-bar insights-chart-bar--refund"
                    style={{ width: `${width}%` }}
                  />
                )}
                {value === 0n && (
                  <span className="insights-chart-zero">zero</span>
                )}
                {value > 0n && (
                  <span
                    className="insights-chart-bar insights-chart-bar--positive"
                    style={{ width: `${width}%` }}
                  />
                )}
              </div>
              <span className="insights-chart-amount">
                {formatMoney(item.totals.netSpending, currency)}
              </span>
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
function SpendCells({
  spend,
  currency,
}: {
  spend: InsightSpend;
  currency: FinancialAccountCurrency;
}) {
  return (
    <>
      <td>
        {amount(spend.expenseTotal, currency)} ({spend.expenseCount} expenses)
      </td>
      <td>
        {amount(spend.refundTotal, currency)} ({spend.refundCount} refunds)
      </td>
      <td>{amount(spend.netSpending, currency)}</td>
    </>
  );
}
function readableError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'INSIGHT_SNAPSHOT_STALE')
      return 'Shared records changed while paging. Previous pages were cleared; reload the current view.';
    if (error.timedOut)
      return 'Insights timed out. Retry to load current shared records.';
    return error.message || 'Could not load insights. Retry.';
  }
  return 'Could not load insights. Check your connection and retry.';
}

export function InsightsSection({
  household,
  reportingZone,
  refreshSignal,
  onSessionExpired,
  csrf,
  onCsrfRefreshed,
  onHouseholdAccessChanged,
  onOpenTransaction,
  nowProvider,
  budgetPending,
  setBudgetPending,
}: {
  household: Household;
  reportingZone: string;
  csrf: CsrfToken | null;
  onCsrfRefreshed: (token: CsrfToken) => void;
  refreshSignal: number;
  onSessionExpired: () => void;
  onHouseholdAccessChanged: () => void;
  onOpenTransaction: (id: string) => void;
  nowProvider?: (() => Date) | undefined;
  budgetPending: PendingBudgetCreate | null;
  setBudgetPending: Dispatch<SetStateAction<PendingBudgetCreate | null>>;
}) {
  const [draft, setDraft] = useState<Choice>(() =>
    defaultChoice(reportingZone, nowProvider?.() ?? new Date()),
  );
  const [applied, setApplied] = useState<Choice>(() =>
    defaultChoice(reportingZone, nowProvider?.() ?? new Date()),
  );
  const [custom, setCustom] = useState(false);
  const [validation, setValidation] = useState('');
  const [comparison, setComparison] = useState<InsightComparison | null>(null);
  const [summary, setSummary] = useState<InsightSummary | null>(null);
  const [series, setSeries] = useState<InsightSeries | null>(null);
  const [groups, setGroups] = useState<InsightGroup[]>([]);
  const [groupCursor, setGroupCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<InsightGroup | null>(null);
  const [groupSeries, setGroupSeries] = useState<InsightSeries | null>(null);
  const [evidence, setEvidence] = useState<Record<string, Page>>({});
  const [busy, setBusy] = useState(false);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const controllers = useRef(new Set<AbortController>());
  const detailControllers = useRef(new Set<AbortController>());
  const generation = useRef(0);
  const detailGeneration = useRef(0);
  const pendingDriver = useRef<{
    dimension: InsightDimension;
    group: InsightGroup;
  } | null>(null);
  const initializedZone = useRef(reportingZone);
  const noticeRef = useRef<HTMLDivElement>(null);
  const monthRef = useRef<HTMLInputElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const latestRefresh = useRef(refreshSignal);
  const [revision, setRevision] = useState(0);
  const abortAll = () => {
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
  };
  const newController = () => {
    const controller = new AbortController();
    controllers.current.add(controller);
    return controller;
  };
  const newDetailController = () => {
    const controller = newController();
    detailControllers.current.add(controller);
    return controller;
  };
  function scopeFailure(failure: unknown) {
    if (failure instanceof ApiError && failure.status === 401) {
      abortAll();
      pendingDriver.current = null;
      clearDetails();
      setComparison(null);
      setSeries(null);
      setGroups([]);
      setEvidence({});
      setSummary(null);
      onSessionExpired();
      return true;
    }
    if (
      failure instanceof ApiError &&
      (failure.status === 404 || failure.code === 'HOUSEHOLD_NOT_FOUND')
    ) {
      abortAll();
      pendingDriver.current = null;
      clearDetails();
      setComparison(null);
      setSeries(null);
      setGroups([]);
      setEvidence({});
      setSummary(null);
      onHouseholdAccessChanged();
      return true;
    }
    return false;
  }
  function clearDetails() {
    detailGeneration.current++;
    for (const controller of detailControllers.current) controller.abort();
    detailControllers.current.clear();
    setSelected(null);
    setGroupSeries(null);
    setEvidence({});
    setDetailError('');
    setPaging(false);
  }
  useEffect(
    () => () => {
      generation.current++;
      detailGeneration.current++;
      abortAll();
      pendingDriver.current = null;
      detailControllers.current.clear();
    },
    [],
  );
  useEffect(() => {
    if (initializedZone.current === reportingZone) return;
    initializedZone.current = reportingZone;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      if (!custom) {
        const choice = defaultChoice(
          reportingZone,
          nowProvider?.() ?? new Date(),
        );
        setDraft(choice);
        setApplied(choice);
      } else setRevision((value) => value + 1);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportingZone]);
  useEffect(() => {
    if (latestRefresh.current === refreshSignal) return;
    latestRefresh.current = refreshSignal;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) setRevision((value) => value + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshSignal]);
  useEffect(() => {
    const current = ++generation.current;
    abortAll();
    // Defer reset to the next microtask so an effect never synchronously
    // chains a render. The generation guard prevents stale resets after a
    // household switch, StrictMode cleanup or a newer selection.
    void Promise.resolve().then(() => {
      if (generation.current !== current) return;
      setBusy(true);
      setPaging(false);
      setError('');
      setComparison(null);
      setSeries(null);
      setGroups([]);
      setSummary(null);
      setGroupCursor(null);
      clearDetails();
      if (
        !isInsightMonth(applied.month) ||
        !isInsightMonth(applied.baseline) ||
        applied.month === applied.baseline
      ) {
        setBusy(false);
        setError(
          'No supported default baseline is available. Select two distinct complete months between 1900-01 and 9999-11.',
        );
      }
    });
    if (
      !isInsightMonth(applied.month) ||
      !isInsightMonth(applied.baseline) ||
      applied.month === applied.baseline
    )
      return;
    const controller = newController();
    const from = seriesFrom(applied.month);
    void Promise.all([
      fetchInsightComparison(
        household.id,
        applied.month,
        applied.baseline,
        applied.currency,
        applied.dimension,
        100,
        undefined,
        controller.signal,
      ),
      fetchInsightSeries(
        household.id,
        from,
        nextInsightMonth(applied.month),
        applied.currency,
        controller.signal,
      ),
      fetchInsightSummary(
        household.id,
        applied.month,
        applied.baseline,
        applied.currency,
        controller.signal,
      ),
    ])
      .then(([comp, trend, snapshot]) => {
        if (controller.signal.aborted || generation.current !== current) return;
        setComparison(comp);
        setSeries(trend);
        setSummary(snapshot);
        setGroups(comp.items);
        setGroupCursor(comp.nextCursor);
        const queued = pendingDriver.current;
        if (queued && queued.dimension === applied.dimension) {
          pendingDriver.current = null;
          selectGroup(queued.group);
        }
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted || generation.current !== current) return;
        if (!scopeFailure(failure)) setError(readableError(failure));
      })
      .finally(() => {
        controllers.current.delete(controller);
        if (generation.current === current && !controller.signal.aborted)
          setBusy(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied, revision]);
  useEffect(() => {
    if (error || detailError || validation) noticeRef.current?.focus();
  }, [error, detailError, validation]);
  useEffect(() => {
    if (selected) detailHeadingRef.current?.focus();
  }, [selected]);
  function apply(event: FormEvent) {
    event.preventDefault();
    const months = insightMonthRange(
      seriesFrom(draft.month),
      nextInsightMonth(draft.month),
    );
    if (
      !isInsightMonth(draft.month) ||
      !isInsightMonth(draft.baseline) ||
      draft.month === draft.baseline ||
      !months
    ) {
      setValidation(
        'Choose distinct complete months between 1900-01 and 9999-11.',
      );
      monthRef.current?.focus();
      return;
    }
    setValidation('');
    pendingDriver.current = null;
    setCustom(true);
    setApplied({ ...draft });
    if (JSON.stringify(applied) === JSON.stringify(draft))
      setRevision((value) => value + 1);
  }
  function openDriver(dimension: InsightDimension, group: InsightGroup) {
    setDraft((choice) => ({ ...choice, dimension }));
    if (applied.dimension === dimension && comparison) selectGroup(group);
    else {
      pendingDriver.current = { dimension, group };
      setApplied((choice) => ({ ...choice, dimension }));
    }
  }
  function focusSection(id: string) {
    const destination = id.startsWith('insights-plan-')
      ? id
      : `${id}-${household.id}`;
    const node = document.getElementById(destination);
    if (node) {
      node.scrollIntoView({ block: 'start' });
      node.focus();
    } else if (id.startsWith('insights-plan-')) {
      document.getElementById(`insights-recurring-${household.id}`)?.focus();
    }
  }
  async function nextGroups() {
    if (!groupCursor || paging || busy || !comparison) return;
    const cursor = groupCursor;
    const generationAtStart = generation.current;
    const controller = newController();
    setPaging(true);
    setError('');
    try {
      const next = await fetchInsightComparison(
        household.id,
        applied.month,
        applied.baseline,
        applied.currency,
        applied.dimension,
        100,
        cursor,
        controller.signal,
      );
      if (controller.signal.aborted || generation.current !== generationAtStart)
        return;
      if (
        next.snapshot !== comparison.snapshot ||
        next.asOfDate !== comparison.asOfDate ||
        next.reportingTimeZone !== comparison.reportingTimeZone ||
        next.current.netSpending !== comparison.current.netSpending
      ) {
        setGroups([]);
        setComparison(null);
        setSummary(null);
        setGroupCursor(null);
        clearDetails();
        setError(
          'Shared records changed while paging. Previous pages were cleared; reload the current view.',
        );
        return;
      }
      if (
        next.items.some((item) =>
          groups.some((existing) => existing.key === item.key),
        )
      ) {
        setGroups([]);
        setComparison(null);
        setSummary(null);
        setGroupCursor(null);
        clearDetails();
        setError('The group pages overlapped. Reload current shared records.');
        return;
      }
      setGroups((before) => [...before, ...next.items]);
      setGroupCursor(next.nextCursor);
    } catch (failure) {
      if (controller.signal.aborted || generation.current !== generationAtStart)
        return;
      if (
        failure instanceof ApiError &&
        failure.code === 'INSIGHT_SNAPSHOT_STALE'
      ) {
        setGroups([]);
        setComparison(null);
        setSummary(null);
        setGroupCursor(null);
        clearDetails();
      }
      if (!scopeFailure(failure)) setError(readableError(failure));
    } finally {
      controllers.current.delete(controller);
      if (
        generation.current === generationAtStart &&
        !controller.signal.aborted
      )
        setPaging(false);
    }
  }
  function selectGroup(group: InsightGroup) {
    clearDetails();
    setSelected(group);
    const detailAtStart = detailGeneration.current;
    const controller = newDetailController();
    const from = seriesFrom(applied.month);
    void Promise.all([
      fetchInsightSeries(
        household.id,
        from,
        nextInsightMonth(applied.month),
        applied.currency,
        controller.signal,
        applied.dimension,
        group.key,
      ),
      fetchInsightEvidence(
        household.id,
        applied.month,
        applied.currency,
        applied.dimension,
        group.key,
        100,
        undefined,
        controller.signal,
      ),
      fetchInsightEvidence(
        household.id,
        applied.baseline,
        applied.currency,
        applied.dimension,
        group.key,
        100,
        undefined,
        controller.signal,
      ),
    ])
      .then(([trend, current, baseline]) => {
        if (
          controller.signal.aborted ||
          detailGeneration.current !== detailAtStart
        )
          return;
        setGroupSeries(trend);
        setEvidence({
          [applied.month]: {
            data: current,
            items: current.items,
            cursor: current.nextCursor,
          },
          [applied.baseline]: {
            data: baseline,
            items: baseline.items,
            cursor: baseline.nextCursor,
          },
        });
      })
      .catch((failure: unknown) => {
        if (
          controller.signal.aborted ||
          detailGeneration.current !== detailAtStart
        )
          return;
        if (
          failure instanceof ApiError &&
          failure.code === 'INSIGHT_SNAPSHOT_STALE'
        ) {
          setComparison(null);
          setSummary(null);
          setSeries(null);
          setGroups([]);
          setGroupCursor(null);
          clearDetails();
          setError(
            'Shared records changed while loading evidence. Reload current insights.',
          );
        } else if (!scopeFailure(failure))
          setDetailError(readableError(failure));
      })
      .finally(() => {
        controllers.current.delete(controller);
        detailControllers.current.delete(controller);
      });
  }
  async function nextEvidence(month: string) {
    const page = evidence[month];
    if (!selected || !page?.cursor || paging) return;
    const cursor = page.cursor,
      key = selected.key,
      detailAtStart = detailGeneration.current;
    const controller = newDetailController();
    setPaging(true);
    setDetailError('');
    try {
      const next = await fetchInsightEvidence(
        household.id,
        month,
        applied.currency,
        applied.dimension,
        key,
        100,
        cursor,
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        detailGeneration.current !== detailAtStart
      )
        return;
      if (
        next.snapshot !== page.data.snapshot ||
        next.asOfDate !== page.data.asOfDate ||
        next.reportingTimeZone !== page.data.reportingTimeZone ||
        next.items.some((item) =>
          page.items.some((prior) => prior.id === item.id),
        )
      ) {
        setComparison(null);
        setSummary(null);
        setSeries(null);
        setGroups([]);
        setGroupCursor(null);
        clearDetails();
        setError(
          'Shared records changed while paging. All previous groups and evidence were cleared. Reload current insights.',
        );
        return;
      }
      setEvidence((before) => ({
        ...before,
        [month]: {
          data: page.data,
          items: [...page.items, ...next.items],
          cursor: next.nextCursor,
        },
      }));
    } catch (failure) {
      if (
        controller.signal.aborted ||
        detailGeneration.current !== detailAtStart
      )
        return;
      if (
        failure instanceof ApiError &&
        failure.code === 'INSIGHT_SNAPSHOT_STALE'
      ) {
        setComparison(null);
        setSummary(null);
        setSeries(null);
        setGroups([]);
        setGroupCursor(null);
        clearDetails();
        setError(
          'Shared records changed while paging. All previous groups and evidence were cleared. Reload current insights.',
        );
      } else if (!scopeFailure(failure)) setDetailError(readableError(failure));
    } finally {
      controllers.current.delete(controller);
      detailControllers.current.delete(controller);
      if (
        !controller.signal.aborted &&
        detailGeneration.current === detailAtStart
      )
        setPaging(false);
    }
  }
  const stateLabel = (state: string) =>
    state === 'FUTURE'
      ? 'Future full month; posted future-dated facts can appear.'
      : state === 'IN_PROGRESS'
        ? 'Month in progress; full-month values so far, not a forecast.'
        : 'Calendar month ended; bank coverage is not guaranteed.';
  const money = (value: string) => amount(value, applied.currency);
  return (
    <section
      className="insights-section"
      aria-label="Household Insights"
      data-testid="insights-section"
    >
      <h4>Insights · shared spending</h4>
      <p>
        Current shared records only: HOUSEHOLD, POSTED expenses and refunds.
        Private entries, pending bank activity, transfers, allocations and
        repayments are excluded. Corrections and disclosure changes restate past
        months; figures do not indicate complete bank coverage. Merchant /
        description groups are not verified businesses.
      </p>
      {resolveCalculationZone(reportingZone).fellBack && (
        <p role="status">
          Your browser cannot calculate defaults in {reportingZone}; defaults
          use Etc/UTC. Server reporting zone below is authoritative.
        </p>
      )}
      <form
        className="insights-controls"
        aria-label="Insights selection"
        onSubmit={apply}
      >
        <label>
          Month{' '}
          <input
            ref={monthRef}
            type="month"
            min="1900-01"
            max="9999-11"
            value={draft.month}
            onChange={(event) =>
              setDraft({ ...draft, month: event.target.value })
            }
          />
        </label>
        <label>
          Baseline month{' '}
          <input
            type="month"
            min="1900-01"
            max="9999-11"
            value={draft.baseline}
            onChange={(event) =>
              setDraft({ ...draft, baseline: event.target.value })
            }
          />
        </label>
        <label>
          Currency{' '}
          <select
            value={draft.currency}
            onChange={(event) =>
              setDraft({
                ...draft,
                currency: event.target.value as FinancialAccountCurrency,
              })
            }
          >
            {currencies.map((currency) => (
              <option key={currency}>{currency}</option>
            ))}
          </select>
        </label>
        <label>
          Breakdown{' '}
          <select
            value={draft.dimension}
            onChange={(event) =>
              setDraft({
                ...draft,
                dimension: event.target.value as InsightDimension,
              })
            }
          >
            <option value="CATEGORY">Categories</option>
            <option value="MERCHANT">Merchant / description groups</option>
          </select>
        </label>
        <button className="household-button" type="submit">
          Show insights
        </button>
        <button
          className="household-button household-button--secondary"
          type="button"
          onClick={() => {
            pendingDriver.current = null;
            const choice = defaultChoice(
              reportingZone,
              nowProvider?.() ?? new Date(),
            );
            setDraft(choice);
            setApplied(choice);
            setCustom(false);
            setRevision((value) => value + 1);
          }}
        >
          Current month
        </button>
        <button
          className="household-button household-button--secondary"
          type="button"
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh current records
        </button>
      </form>
      {(validation || error || detailError) && (
        <div
          role="alert"
          ref={noticeRef}
          tabIndex={-1}
          className="household-notice household-notice--error"
        >
          {validation || error || detailError}{' '}
          {error && (
            <button
              type="button"
              className="household-button"
              onClick={() => setRevision((value) => value + 1)}
            >
              Reload insights
            </button>
          )}
          {detailError && selected && (
            <button
              type="button"
              className="household-button"
              onClick={() => selectGroup(selected)}
            >
              Reload group
            </button>
          )}
        </div>
      )}
      {busy && (
        <p role="status">
          Loading insights for {applied.month} versus {applied.baseline}…
        </p>
      )}
      {summary && (
        <SummaryView
          summary={summary}
          onOpenDriver={openDriver}
          onFocusSection={focusSection}
        />
      )}
      {comparison && series && (
        <>
          <p>
            Showing {applied.currency}, {comparison.reportingTimeZone}; as of{' '}
            {comparison.asOfDate}. Selected {comparison.period.from} to{' '}
            {comparison.period.to} (exclusive),{' '}
            {stateLabel(comparison.period.state)} Baseline{' '}
            {comparison.baselinePeriod.from} to {comparison.baselinePeriod.to}{' '}
            (exclusive), {stateLabel(comparison.baselinePeriod.state)}
          </p>
          <p>
            Net spending {money(comparison.current.netSpending)} vs{' '}
            {money(comparison.baseline.netSpending)}.{' '}
            {comparison.change.direction === 'UNCHANGED'
              ? 'Unchanged'
              : comparison.change.direction === 'INCREASE'
                ? 'Increase'
                : 'Decrease'}{' '}
            of {money(comparison.change.delta)} (expenses minus refunds).{' '}
            {comparison.change.percentChange === null
              ? `Percent unavailable: ${comparison.change.percentUnavailableReason === 'BASELINE_ZERO' ? 'zero baseline' : 'negative baseline'}.`
              : `${comparison.change.percentChange}% relative to positive baseline.`}{' '}
            Income separately: {money(comparison.current.incomeTotal)} vs{' '}
            {money(comparison.baseline.incomeTotal)}.
          </p>
          <p>
            Net change = (current expenses{' '}
            {money(comparison.current.expenseTotal)}
            {' − '}baseline expenses {money(comparison.baseline.expenseTotal)})
            {' − '}(current refunds {money(comparison.current.refundTotal)}
            {' − '}baseline refunds {money(comparison.baseline.refundTotal)})
            {' = '}
            {money(comparison.change.delta)}. This is arithmetic, not a claim
            about why spending changed.
          </p>
          <h5>Monthly trend · exact values</h5>
          <p>
            Each row is a full calendar month. Expenses less refunds may make
            net spending negative.
          </p>
          <MonthlyNetChart series={series} currency={applied.currency} />
          <p>
            Bars compare signed net spending across these months, not expense
            volume or bank coverage. Left means refunds exceeded expenses; right
            means expenses exceeded refunds. Exact expenses, refunds, net and
            income are in the table below.
          </p>
          <p>Focus a table and use the arrow keys to scroll horizontally.</p>
          <div
            className="insights-scroll"
            role="region"
            aria-label="Monthly spending table"
            tabIndex={0}
          >
            <table>
              <caption>
                Monthly spending in {applied.currency} from {series.fromMonth}{' '}
                to {series.toMonth} (exclusive)
              </caption>
              <thead>
                <tr>
                  <th scope="col">Month and state</th>
                  <th scope="col">Expenses</th>
                  <th scope="col">Refunds</th>
                  <th scope="col">Net spending</th>
                  <th scope="col">Income separately</th>
                </tr>
              </thead>
              <tbody>
                {series.items.map((item) => (
                  <tr key={item.period.month}>
                    <th scope="row">
                      {item.period.month} ·{' '}
                      {item.period.state.toLowerCase().replace('_', ' ')}
                    </th>
                    <SpendCells
                      spend={item.totals}
                      currency={applied.currency}
                    />
                    <td>{money(item.totals.incomeTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h5>
            {applied.dimension === 'CATEGORY'
              ? 'Categories'
              : 'Merchant / description groups'}{' '}
            · comparison
          </h5>
          <p>
            Ranked by absolute exact net change. Current and baseline totals
            above cover all groups;{' '}
            {groupCursor
              ? 'this table is partial — load more to see every group.'
              : 'all groups are shown.'}{' '}
            A zero net group can still contain expenses and refunds.
          </p>
          <div
            className="insights-scroll"
            role="region"
            aria-label="Group comparison table"
            tabIndex={0}
          >
            <table>
              <caption>
                Group differences for {applied.month} versus {applied.baseline},{' '}
                {applied.currency}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Group</th>
                  <th scope="col">Current expenses</th>
                  <th scope="col">Current refunds</th>
                  <th scope="col">Current net</th>
                  <th scope="col">Baseline expenses</th>
                  <th scope="col">Baseline refunds</th>
                  <th scope="col">Baseline net</th>
                  <th scope="col">Change</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.key}>
                    <th scope="row">
                      <button
                        type="button"
                        className="household-button household-button--secondary"
                        onClick={() => selectGroup(group)}
                        aria-label={`View trend and evidence for ${group.label}`}
                      >
                        {group.label}
                      </button>
                    </th>
                    <SpendCells
                      spend={group.current}
                      currency={applied.currency}
                    />
                    <SpendCells
                      spend={group.baseline}
                      currency={applied.currency}
                    />
                    <td>
                      {group.change.direction}: {money(group.change.delta)};{' '}
                      {group.change.percentChange === null
                        ? `percentage unavailable (${group.change.percentUnavailableReason === 'BASELINE_ZERO' ? 'zero' : 'negative'} baseline)`
                        : `${group.change.percentChange}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {groups.length === 0 && !groupCursor && (
            <p>
              No disclosed expenses or refunds in either compared month. Income
              is separate.
            </p>
          )}
          {groupCursor && (
            <button
              type="button"
              className="household-button"
              disabled={paging}
              onClick={() => void nextGroups()}
            >
              {paging ? 'Loading groups…' : 'Load more groups'}
            </button>
          )}
        </>
      )}
      {selected && (
        <div className="insights-detail">
          <h5 ref={detailHeadingRef} tabIndex={-1}>
            {selected.label} · disclosed evidence
          </h5>
          <p>
            Descriptions are public ledger text. Each transaction detail is
            reauthorized before opening. A refund follows its source expense’s
            current group even if its own description differs.
          </p>
          {groupSeries && (
            <div
              className="insights-scroll"
              role="region"
              aria-label={`Trend table for ${selected.label}`}
              tabIndex={0}
            >
              <table>
                <caption>
                  Selected group trend · {selected.label}, {applied.currency}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Month</th>
                    <th scope="col">Expenses</th>
                    <th scope="col">Refunds</th>
                    <th scope="col">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {groupSeries.items.map((item) => (
                    <tr key={item.period.month}>
                      <th scope="row">
                        {item.period.month} · {item.period.state}
                      </th>
                      <SpendCells
                        spend={item.totals}
                        currency={applied.currency}
                      />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {[applied.month, applied.baseline].map((month) => {
            const page = evidence[month];
            return (
              <div key={month}>
                <h6>
                  {month === applied.month
                    ? 'Selected month'
                    : 'Baseline month'}{' '}
                  · {month}
                </h6>
                {page ? (
                  <>
                    <p>
                      All matching records: {page.data.totals.expenseCount}{' '}
                      expenses, {page.data.totals.refundCount} refunds; net{' '}
                      {money(page.data.totals.netSpending)}.{' '}
                      {page.cursor
                        ? 'Evidence list is partial.'
                        : 'All evidence shown.'}
                    </p>
                    <div
                      className="insights-scroll"
                      role="region"
                      aria-label={`Evidence table for ${selected.label} in ${month}`}
                      tabIndex={0}
                    >
                      <table>
                        <caption>
                          Disclosed transactions for {selected.label} in {month}
                        </caption>
                        <thead>
                          <tr>
                            <th scope="col">Date</th>
                            <th scope="col">Kind</th>
                            <th scope="col">Public description</th>
                            <th scope="col">Signed amount</th>
                            <th scope="col">Category</th>
                            <th scope="col">Detail</th>
                          </tr>
                        </thead>
                        <tbody>
                          {page.items.map((item) => (
                            <tr key={item.id}>
                              <td>{item.occurredOn}</td>
                              <td>{item.kind}</td>
                              <td>{item.description}</td>
                              <td>{money(item.money.amount)}</td>
                              <td>{item.category ?? 'Uncategorized'}</td>
                              <td>
                                <button
                                  className="household-button household-button--secondary"
                                  type="button"
                                  onClick={() => onOpenTransaction(item.id)}
                                >
                                  Open authorized detail for {item.description}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {page.items.length === 0 && (
                      <p>No currently disclosed transactions in this month.</p>
                    )}
                    {page.cursor && (
                      <button
                        type="button"
                        disabled={paging}
                        className="household-button"
                        onClick={() => void nextEvidence(month)}
                      >
                        {paging
                          ? 'Loading evidence…'
                          : `Load more ${month} evidence`}
                      </button>
                    )}
                  </>
                ) : (
                  <p role="status">
                    {detailError
                      ? 'Evidence cleared; reload this group.'
                      : 'Loading evidence…'}
                  </p>
                )}
              </div>
            );
          })}
          <button
            type="button"
            className="household-button household-button--secondary"
            onClick={clearDetails}
          >
            Close group
          </button>
        </div>
      )}
      <BudgetSection
        key={`${household.id}:${household.role}:${applied.month}:${applied.currency}`}
        household={household}
        month={applied.month}
        currency={applied.currency}
        reportingZone={reportingZone}
        refreshSignal={refreshSignal + revision}
        csrf={csrf}
        onCsrfRefreshed={onCsrfRefreshed}
        onSessionExpired={onSessionExpired}
        onHouseholdAccessChanged={onHouseholdAccessChanged}
        pending={budgetPending}
        setPending={setBudgetPending}
        onChanged={() => setRevision((value) => value + 1)}
      />
      <RecurringSection
        key={`${household.id}:${household.role}:${applied.currency}:${reportingZone}`}
        household={household}
        currency={applied.currency}
        reportingZone={reportingZone}
        refreshSignal={refreshSignal + revision}
        csrf={csrf}
        onCsrfRefreshed={onCsrfRefreshed}
        onSessionExpired={onSessionExpired}
        onHouseholdAccessChanged={onHouseholdAccessChanged}
        onOpenTransaction={onOpenTransaction}
        onChanged={() => setRevision((value) => value + 1)}
      />
    </section>
  );
}
