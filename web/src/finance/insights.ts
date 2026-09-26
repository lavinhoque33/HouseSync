import {
  CURRENCY_SCALES,
  isAggregateAmountString,
  isSupportedAmountString,
  type FinancialAccountCurrency,
} from './money';
import { isRegionShapedZone } from './reporting';

export type InsightDimension = 'CATEGORY' | 'MERCHANT';
export type InsightPeriod = {
  month: string;
  from: string;
  to: string;
  state: 'FUTURE' | 'IN_PROGRESS' | 'COMPLETED';
};
export type InsightSpend = {
  expenseTotal: string;
  refundTotal: string;
  netSpending: string;
  expenseCount: string;
  refundCount: string;
};
export type InsightTotals = InsightSpend & { incomeTotal: string };
export type InsightChange = {
  delta: string;
  direction: 'INCREASE' | 'DECREASE' | 'UNCHANGED';
  percentChange: string | null;
  percentUnavailableReason: 'BASELINE_ZERO' | 'BASELINE_NEGATIVE' | null;
};
export type InsightMetadata = {
  reportingTimeZone: string;
  asOfDate: string;
  currency: FinancialAccountCurrency;
  policyVersion: string;
  snapshot: string;
};
export type InsightSeries = InsightMetadata & {
  fromMonth: string;
  toMonth: string;
  dimension: InsightDimension | null;
  groupKey: string | null;
  items: { period: InsightPeriod; totals: InsightTotals }[];
};
export type InsightGroup = {
  key: string;
  label: string;
  current: InsightSpend;
  baseline: InsightSpend;
  change: InsightChange;
};
export type InsightComparison = InsightMetadata & {
  period: InsightPeriod;
  baselinePeriod: InsightPeriod;
  dimension: InsightDimension;
  current: InsightTotals;
  baseline: InsightTotals;
  change: InsightChange;
  items: InsightGroup[];
  nextCursor: string | null;
};
export type InsightEvidenceItem = {
  id: string;
  version: number;
  kind: 'EXPENSE' | 'REFUND';
  occurredOn: string;
  money: { amount: string; currency: FinancialAccountCurrency };
  description: string;
  category: string | null;
  refundOfTransactionId: string | null;
};
export type InsightEvidence = InsightMetadata & {
  period: InsightPeriod;
  dimension: InsightDimension;
  groupKey: string;
  totals: InsightSpend;
  items: InsightEvidenceItem[];
  nextCursor: string | null;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const date = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
function isCalendarDate(value: string): boolean {
  if (!date.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}
const categories: Record<string, true> = {
  HOUSING: true,
  GROCERIES: true,
  DINING: true,
  UTILITIES: true,
  TRANSPORTATION: true,
  SHOPPING: true,
  ENTERTAINMENT: true,
  HEALTHCARE: true,
  TRAVEL: true,
  EDUCATION: true,
  PERSONAL: true,
  HOUSEHOLD_SUPPLIES: true,
  SUBSCRIPTIONS: true,
  INCOME: true,
  TRANSFERS: true,
  MISCELLANEOUS: true,
  UNCATEGORIZED: true,
};
const count = /^(0|[1-9][0-9]*)$/;
const percentage = /^-?(0|[1-9][0-9]*)\.\d{2}$/;
function record(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
export function isInsightMonth(value: string, boundary = false): boolean {
  return (
    /^\d{4}-(0[1-9]|1[0-2])$/.test(value) &&
    value >= '1900-01' &&
    (boundary ? value <= '9999-12' : value <= '9999-11')
  );
}
export function nextInsightMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5));
  return m === 12
    ? `${String(year + 1).padStart(4, '0')}-01`
    : `${String(year).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}`;
}
export function isInsightGroupKey(
  dimension: InsightDimension,
  key: string,
): boolean {
  return dimension === 'CATEGORY'
    ? Object.hasOwn(categories, key)
    : key === 'UNGROUPED' || digest.test(key);
}
function money(
  value: unknown,
  currency: FinancialAccountCurrency,
  signed = false,
): value is string {
  return (
    typeof value === 'string' &&
    isAggregateAmountString(value, currency) &&
    (signed || !value.startsWith('-'))
  );
}
function units(value: string, currency: FinancialAccountCurrency): bigint {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const magnitude =
    BigInt(whole!) * 10n ** BigInt(CURRENCY_SCALES[currency]) +
    BigInt(fraction || '0');
  return negative ? -magnitude : magnitude;
}
export function period(value: unknown): value is InsightPeriod {
  if (!record(value, ['month', 'from', 'to', 'state'])) return false;
  return (
    typeof value.month === 'string' &&
    isInsightMonth(value.month) &&
    value.from === `${value.month}-01` &&
    value.to === `${nextInsightMonth(value.month)}-01` &&
    ['FUTURE', 'IN_PROGRESS', 'COMPLETED'].includes(String(value.state))
  );
}
export function spend(
  value: unknown,
  currency: FinancialAccountCurrency,
  total: true,
): value is InsightTotals;
export function spend(
  value: unknown,
  currency: FinancialAccountCurrency,
  total?: false,
): value is InsightSpend;
export function spend(
  value: unknown,
  currency: FinancialAccountCurrency,
  total = false,
): value is InsightSpend {
  const keys = [
    'expenseTotal',
    'refundTotal',
    'netSpending',
    'expenseCount',
    'refundCount',
  ];
  if (!record(value, total ? [...keys, 'incomeTotal'] : keys)) return false;
  return (
    money(value.expenseTotal, currency) &&
    money(value.refundTotal, currency) &&
    money(value.netSpending, currency, true) &&
    units(value.expenseTotal, currency) - units(value.refundTotal, currency) ===
      units(value.netSpending, currency) &&
    typeof value.expenseCount === 'string' &&
    count.test(value.expenseCount) &&
    typeof value.refundCount === 'string' &&
    count.test(value.refundCount) &&
    (!total || money(value.incomeTotal, currency))
  );
}
export function stateMatchesAsOf(
  periodValue: InsightPeriod,
  asOf: unknown,
): boolean {
  return (
    typeof asOf === 'string' &&
    isCalendarDate(asOf) &&
    periodValue.state ===
      (asOf < periodValue.from
        ? 'FUTURE'
        : asOf < periodValue.to
          ? 'IN_PROGRESS'
          : 'COMPLETED')
  );
}
export function change(
  value: unknown,
  currency: FinancialAccountCurrency,
  current: InsightSpend,
  baseline: InsightSpend,
): value is InsightChange {
  if (
    !record(value, [
      'delta',
      'direction',
      'percentChange',
      'percentUnavailableReason',
    ]) ||
    !money(value.delta, currency, true)
  )
    return false;
  const delta =
    units(current.netSpending, currency) -
    units(baseline.netSpending, currency);
  const base = units(baseline.netSpending, currency);
  if (
    units(value.delta, currency) !== delta ||
    value.direction !==
      (delta > 0n ? 'INCREASE' : delta < 0n ? 'DECREASE' : 'UNCHANGED')
  )
    return false;
  if (base <= 0n)
    return (
      value.percentChange === null &&
      value.percentUnavailableReason ===
        (base === 0n ? 'BASELINE_ZERO' : 'BASELINE_NEGATIVE')
    );
  if (
    typeof value.percentChange !== 'string' ||
    !percentage.test(value.percentChange) ||
    value.percentUnavailableReason !== null
  )
    return false;
  // Rounded percent with two decimal places, HALF_UP even for a negative tie.
  const magnitude = delta < 0n ? -delta : delta;
  const hundredths = (magnitude * 10000n + base / 2n) / base;
  const expected = `${delta < 0n && hundredths !== 0n ? '-' : ''}${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}`;
  return value.percentChange === expected;
}
function metadata(
  value: Record<string, unknown>,
  currency: FinancialAccountCurrency,
): boolean {
  return (
    value.currency === currency &&
    typeof value.reportingTimeZone === 'string' &&
    isRegionShapedZone(value.reportingTimeZone) &&
    typeof value.asOfDate === 'string' &&
    isCalendarDate(value.asOfDate) &&
    value.policyVersion === 'SPENDING_V1/PUBLIC_DESCRIPTION_V1' &&
    typeof value.snapshot === 'string' &&
    digest.test(value.snapshot)
  );
}
const meta = [
  'reportingTimeZone',
  'asOfDate',
  'currency',
  'policyVersion',
  'snapshot',
];
function cursor(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 2048 &&
      /^[A-Za-z0-9_-]+$/.test(value))
  );
}
export function parseInsightSeries(
  value: unknown,
  from: string,
  to: string,
  currency: FinancialAccountCurrency,
  dimension: InsightDimension | null = null,
  key: string | null = null,
): InsightSeries | undefined {
  if (
    (dimension === null) !== (key === null) ||
    (dimension !== null && key !== null && !isInsightGroupKey(dimension, key))
  )
    return;
  if (
    !record(value, [
      ...meta,
      'fromMonth',
      'toMonth',
      'dimension',
      'groupKey',
      'items',
    ]) ||
    !metadata(value, currency) ||
    value.fromMonth !== from ||
    value.toMonth !== to ||
    value.dimension !== dimension ||
    value.groupKey !== key ||
    !Array.isArray(value.items)
  )
    return;
  const months = insightMonthRange(from, to);
  if (!months || value.items.length !== months.length) return;
  for (let i = 0; i < months.length; i++) {
    const row = value.items[i];
    if (
      !record(row, ['period', 'totals']) ||
      !period(row.period) ||
      row.period.month !== months[i] ||
      !spend(row.totals, currency, true) ||
      (key !== null && units(row.totals.incomeTotal, currency) !== 0n)
    )
      return;
    if (!stateMatchesAsOf(row.period, value.asOfDate)) return;
  }
  return value as InsightSeries;
}
export function insightMonthRange(
  from: string,
  to: string,
): string[] | undefined {
  if (!isInsightMonth(from) || !isInsightMonth(to, true) || from >= to) return;
  const result: string[] = [];
  for (
    let month = from;
    month < to && result.length <= 24;
    month = nextInsightMonth(month)
  )
    result.push(month);
  return result.length >= 1 && result.length <= 24 ? result : undefined;
}
export function parseInsightComparison(
  value: unknown,
  month: string,
  baselineMonth: string,
  currency: FinancialAccountCurrency,
  dimension: InsightDimension,
  limit: number,
): InsightComparison | undefined {
  if (
    !record(value, [
      ...meta,
      'period',
      'baselinePeriod',
      'dimension',
      'current',
      'baseline',
      'change',
      'items',
      'nextCursor',
    ]) ||
    !metadata(value, currency) ||
    !period(value.period) ||
    value.period.month !== month ||
    !period(value.baselinePeriod) ||
    value.baselinePeriod.month !== baselineMonth ||
    value.dimension !== dimension ||
    !spend(value.current, currency, true) ||
    !spend(value.baseline, currency, true) ||
    !change(value.change, currency, value.current, value.baseline) ||
    !Array.isArray(value.items) ||
    value.items.length > limit ||
    !cursor(value.nextCursor) ||
    (value.nextCursor !== null && value.items.length !== limit)
  )
    return;
  if (
    !stateMatchesAsOf(value.period, value.asOfDate) ||
    !stateMatchesAsOf(value.baselinePeriod, value.asOfDate)
  )
    return;
  const seen = new Set<string>();
  for (const item of value.items) {
    if (
      !record(item, ['key', 'label', 'current', 'baseline', 'change']) ||
      typeof item.key !== 'string' ||
      !isInsightGroupKey(dimension, item.key) ||
      seen.has(item.key) ||
      typeof item.label !== 'string' ||
      !item.label ||
      !spend(item.current, currency) ||
      !spend(item.baseline, currency) ||
      !change(item.change, currency, item.current, item.baseline)
    )
      return;
    if (
      (dimension === 'MERCHANT' &&
        (item.key === 'UNGROUPED'
          ? item.label !== 'Ungrouped descriptions'
          : item.label.length > 200)) ||
      (dimension === 'CATEGORY' &&
        item.key === 'UNCATEGORIZED' &&
        item.label !== 'Uncategorized')
    )
      return;
    seen.add(item.key);
  }
  return value as InsightComparison;
}
export function parseInsightEvidence(
  value: unknown,
  month: string,
  currency: FinancialAccountCurrency,
  dimension: InsightDimension,
  key: string,
  limit: number,
): InsightEvidence | undefined {
  if (
    !record(value, [
      ...meta,
      'period',
      'dimension',
      'groupKey',
      'totals',
      'items',
      'nextCursor',
    ]) ||
    !metadata(value, currency) ||
    !period(value.period) ||
    value.period.month !== month ||
    value.dimension !== dimension ||
    value.groupKey !== key ||
    !spend(value.totals, currency) ||
    !Array.isArray(value.items) ||
    value.items.length > limit ||
    !cursor(value.nextCursor) ||
    (value.nextCursor !== null && value.items.length !== limit)
  )
    return;
  if (
    !isInsightGroupKey(dimension, key) ||
    !stateMatchesAsOf(value.period, value.asOfDate)
  )
    return;
  const seen = new Set<string>();
  for (const item of value.items) {
    if (
      !record(item, [
        'id',
        'version',
        'kind',
        'occurredOn',
        'money',
        'description',
        'category',
        'refundOfTransactionId',
      ]) ||
      typeof item.id !== 'string' ||
      !uuid.test(item.id) ||
      seen.has(item.id) ||
      !Number.isSafeInteger(item.version) ||
      (item.version as number) < 0 ||
      (item.kind !== 'EXPENSE' && item.kind !== 'REFUND') ||
      typeof item.occurredOn !== 'string' ||
      !isCalendarDate(item.occurredOn) ||
      item.occurredOn < value.period.from ||
      item.occurredOn >= value.period.to ||
      !record(item.money, ['amount', 'currency']) ||
      item.money.currency !== currency ||
      typeof item.money.amount !== 'string' ||
      !isSupportedAmountString(item.money.amount, currency) ||
      (item.kind === 'EXPENSE') !== item.money.amount.startsWith('-') ||
      typeof item.description !== 'string' ||
      item.description.length === 0 ||
      (item.category !== null &&
        (typeof item.category !== 'string' ||
          !Object.hasOwn(categories, item.category) ||
          item.category === 'UNCATEGORIZED')) ||
      (item.refundOfTransactionId !== null &&
        (typeof item.refundOfTransactionId !== 'string' ||
          !uuid.test(item.refundOfTransactionId))) ||
      (item.kind === 'REFUND') !== (item.refundOfTransactionId !== null)
    )
      return;
    seen.add(item.id);
  }
  return value as InsightEvidence;
}
