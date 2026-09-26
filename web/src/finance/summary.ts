import { CURRENCY_SCALES, type FinancialAccountCurrency } from './money';
import {
  change,
  isInsightMonth,
  parseInsightComparison,
  period,
  spend,
  stateMatchesAsOf,
  type InsightChange,
  type InsightGroup,
  type InsightMetadata,
  type InsightPeriod,
  type InsightTotals,
} from './insights';
import { parseBudgetProgress, type BudgetProgress } from './budgets';
import { calendarDate, projection, type PlanProjection } from './recurring';
import { isRegionShapedZone } from './reporting';

export type SummaryDrivers = {
  increases: InsightGroup[];
  decreases: InsightGroup[];
  otherDelta: string;
};
export type InsightSummary = InsightMetadata & {
  period: InsightPeriod;
  baselinePeriod: InsightPeriod;
  current: InsightTotals;
  baseline: InsightTotals;
  change: InsightChange;
  categoryDrivers: SummaryDrivers;
  merchantDrivers: SummaryDrivers;
  budget: Pick<
    BudgetProgress,
    'totals' | 'overall' | 'categories' | 'untargeted'
  >;
  recurring: {
    evidenceFrom: string;
    evidenceTo: string;
    openCandidateCount: string;
    activePlanCount: string;
    items: PlanProjection[];
    hasMore: boolean;
  };
};
const policy =
  'SUMMARY_V1/SPENDING_V1/RECURRENCE_V1/BUDGETS_V1/PUBLIC_DESCRIPTION_V1';
const count = /^(0|[1-9][0-9]*)$/;
const digest = /^[a-f0-9]{64}$/;
function exact(
  value: unknown,
  names: string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name))
  );
}
function units(value: string): bigint {
  return BigInt(value.replace('.', ''));
}
function signed(value: string): bigint {
  return value.startsWith('-') ? -units(value.slice(1)) : units(value);
}
function amount(value: bigint, currency: FinancialAccountCurrency): string {
  const scale = CURRENCY_SCALES[currency];
  const digits = (value < 0n ? -value : value)
    .toString()
    .padStart(scale + 1, '0');
  return `${value < 0n ? '-' : ''}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`;
}
function drivers(
  value: unknown,
  dimension: 'CATEGORY' | 'MERCHANT',
  meta: InsightMetadata,
  current: InsightTotals,
  baseline: InsightTotals,
  periodValue: InsightPeriod,
  baselinePeriod: InsightPeriod,
  overallChange: InsightChange,
): value is SummaryDrivers {
  if (
    !exact(value, ['increases', 'decreases', 'otherDelta']) ||
    !Array.isArray(value.increases) ||
    !Array.isArray(value.decreases) ||
    value.increases.length > 5 ||
    value.decreases.length > 5 ||
    typeof value.otherDelta !== 'string'
  )
    return false;
  const all = [...value.increases, ...value.decreases];
  // The A decoder validates each group's exact fields, key, amounts, change and policy.
  const comparison = parseInsightComparison(
    {
      ...meta,
      policyVersion: 'SPENDING_V1/PUBLIC_DESCRIPTION_V1',
      period: periodValue,
      baselinePeriod,
      dimension,
      current,
      baseline,
      change: overallChange,
      items: all,
      nextCursor: null,
    },
    periodValue.month,
    baselinePeriod.month,
    meta.currency,
    dimension,
    10,
  );
  // The A decoder validates every group and the overall change.
  if (!comparison) return false;
  for (const [index, list] of [value.increases, value.decreases].entries()) {
    for (let i = 0; i < list.length; i++) {
      const row = list[i] as InsightGroup;
      const delta = signed(row.change.delta);
      if (index === 0 ? delta <= 0n : delta >= 0n) return false;
      if (i > 0) {
        const prior = list[i - 1] as InsightGroup;
        const magnitude = delta < 0n ? -delta : delta;
        const previous =
          signed(prior.change.delta) < 0n
            ? -signed(prior.change.delta)
            : signed(prior.change.delta);
        if (
          previous < magnitude ||
          (previous === magnitude && prior.key >= row.key)
        )
          return false;
      }
    }
  }
  const residual =
    signed(overallChange.delta) -
    all.reduce(
      (sum, row) => sum + signed((row as InsightGroup).change.delta),
      0n,
    );
  return value.otherDelta === amount(residual, meta.currency);
}
export function parseInsightSummary(
  value: unknown,
  householdId: string,
  month: string,
  baselineMonth: string,
  currency: FinancialAccountCurrency,
): InsightSummary | undefined {
  if (
    !isInsightMonth(month) ||
    !isInsightMonth(baselineMonth) ||
    month === baselineMonth ||
    !exact(value, [
      'reportingTimeZone',
      'asOfDate',
      'currency',
      'policyVersion',
      'snapshot',
      'period',
      'baselinePeriod',
      'current',
      'baseline',
      'change',
      'categoryDrivers',
      'merchantDrivers',
      'budget',
      'recurring',
    ]) ||
    value.currency !== currency ||
    value.policyVersion !== policy ||
    typeof value.reportingTimeZone !== 'string' ||
    !isRegionShapedZone(value.reportingTimeZone) ||
    !calendarDate(value.asOfDate) ||
    typeof value.snapshot !== 'string' ||
    !digest.test(value.snapshot) ||
    !period(value.period) ||
    value.period.month !== month ||
    !period(value.baselinePeriod) ||
    value.baselinePeriod.month !== baselineMonth ||
    !stateMatchesAsOf(value.period, value.asOfDate) ||
    !stateMatchesAsOf(value.baselinePeriod, value.asOfDate) ||
    !spend(value.current, currency, true) ||
    !spend(value.baseline, currency, true) ||
    !change(value.change, currency, value.current, value.baseline)
  )
    return;
  const meta: InsightMetadata = {
    reportingTimeZone: value.reportingTimeZone,
    asOfDate: value.asOfDate,
    currency,
    policyVersion: value.policyVersion,
    snapshot: value.snapshot,
  };
  if (
    !drivers(
      value.categoryDrivers,
      'CATEGORY',
      meta,
      value.current,
      value.baseline,
      value.period,
      value.baselinePeriod,
      value.change,
    ) ||
    !drivers(
      value.merchantDrivers,
      'MERCHANT',
      meta,
      value.current,
      value.baseline,
      value.period,
      value.baselinePeriod,
      value.change,
    ) ||
    !exact(value.budget, ['totals', 'overall', 'categories', 'untargeted'])
  )
    return;
  const budget = parseBudgetProgress(
    {
      ...meta,
      policyVersion: 'BUDGETS_V1',
      period: value.period,
      ...value.budget,
    },
    householdId,
    month,
    currency,
  );
  if (!budget || !sameSpend(budget.totals, value.current)) return;
  const recurring = value.recurring;
  if (
    !exact(recurring, [
      'evidenceFrom',
      'evidenceTo',
      'openCandidateCount',
      'activePlanCount',
      'items',
      'hasMore',
    ]) ||
    !calendarDate(recurring.evidenceFrom) ||
    !calendarDate(recurring.evidenceTo) ||
    recurring.evidenceFrom > recurring.evidenceTo ||
    recurring.evidenceTo !==
      (value.asOfDate < '1900-01-01'
        ? '1900-01-01'
        : value.asOfDate >= '9999-12-30'
          ? '9999-12-31'
          : nextDay(value.asOfDate)) ||
    typeof recurring.openCandidateCount !== 'string' ||
    !count.test(recurring.openCandidateCount) ||
    typeof recurring.activePlanCount !== 'string' ||
    !count.test(recurring.activePlanCount) ||
    !Array.isArray(recurring.items) ||
    recurring.items.length > 5 ||
    typeof recurring.hasMore !== 'boolean' ||
    BigInt(recurring.activePlanCount) < BigInt(recurring.items.length) ||
    recurring.hasMore !==
      BigInt(recurring.activePlanCount) > BigInt(recurring.items.length)
  )
    return;
  const ids = new Set<string>();
  for (const item of recurring.items) {
    if (!projection(item, householdId, currency) || ids.has(item.plan.id))
      return;
    ids.add(item.plan.id);
  }
  if (
    recurring.items.length !==
    Number(
      BigInt(recurring.activePlanCount) < 5n
        ? BigInt(recurring.activePlanCount)
        : 5n,
    )
  )
    return;
  for (let i = 1; i < recurring.items.length; i++) {
    const before = recurring.items[i - 1] as PlanProjection;
    const after = recurring.items[i] as PlanProjection;
    const first = before.expectation.nextExpectedOn ?? '9999-99-99';
    const second = after.expectation.nextExpectedOn ?? '9999-99-99';
    if (first > second || (first === second && before.plan.id >= after.plan.id))
      return;
  }
  return value as InsightSummary;
}
function sameSpend(a: BudgetProgress['totals'], b: InsightTotals): boolean {
  return (
    a.expenseTotal === b.expenseTotal &&
    a.refundTotal === b.refundTotal &&
    a.netSpending === b.netSpending &&
    a.expenseCount === b.expenseCount &&
    a.refundCount === b.refundCount
  );
}
function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
