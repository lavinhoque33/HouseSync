import {
  CURRENCY_SCALES,
  isAggregateAmountString,
  type FinancialAccountCurrency,
} from './money';
import {
  isInsightGroupKey,
  isInsightMonth,
  nextInsightMonth,
  type InsightPeriod,
  type InsightSpend,
} from './insights';
import { isRegionShapedZone } from './reporting';
import { calendarDate } from './recurring';

export type BudgetBucket = 'OVERALL' | 'UNCATEGORIZED' | string;
export type BudgetTarget = {
  id: string;
  householdId: string;
  month: string;
  bucket: BudgetBucket;
  money: { amount: string; currency: FinancialAccountCurrency };
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
  createdAt: string;
  updatedAt: string;
};
export type BudgetPage = {
  items: BudgetTarget[];
  limit: number;
  offset: number;
  hasMore: boolean;
};
export type BudgetProgressItem = {
  target: BudgetTarget;
  actual: InsightSpend;
  remaining: string;
  overBy: string;
  percentUsed: string | null;
  status: 'UNDER' | 'AT' | 'OVER';
};
export type BudgetProgress = {
  reportingTimeZone: string;
  asOfDate: string;
  currency: FinancialAccountCurrency;
  policyVersion: 'BUDGETS_V1';
  snapshot: string;
  period: InsightPeriod;
  totals: InsightSpend;
  overall: BudgetProgressItem | null;
  categories: BudgetProgressItem[];
  untargeted: InsightSpend;
};
export type CreateBudgetTarget = Pick<
  BudgetTarget,
  'month' | 'bucket' | 'money'
>;
export type BudgetPatch =
  | { expectedVersion: number; amount: string }
  | { expectedVersion: number; status: 'ARCHIVED' };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const digest = /^[0-9a-f]{64}$/;
const count = /^(0|[1-9][0-9]*)$/;
const percent = /^-?(0|[1-9][0-9]*)\.\d{2}$/;
const keys = (
  value: unknown,
  names: string[],
): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === names.length &&
  names.every((name) => Object.hasOwn(value, name));
export const isBudgetBucket = (value: unknown): value is BudgetBucket =>
  typeof value === 'string' &&
  (value === 'OVERALL' || isInsightGroupKey('CATEGORY', value));
export function validTargetAmount(
  value: unknown,
  currency: FinancialAccountCurrency,
): value is string {
  if (
    typeof value !== 'string' ||
    value.startsWith('-') ||
    value.startsWith('+')
  )
    return false;
  const scale = CURRENCY_SCALES[currency];
  return new RegExp(
    `^(0|[1-9][0-9]{0,11})${scale ? `\\.[0-9]{${scale}}` : ''}$`,
  ).test(value);
}
export function normalizeTargetAmount(
  raw: string,
  currency: FinancialAccountCurrency,
): string | null {
  if (!/^(0|[1-9][0-9]{0,11})(\.[0-9]+)?$/.test(raw)) return null;
  const scale = CURRENCY_SCALES[currency];
  const [whole, fraction = ''] = raw.split('.');
  if (fraction.length > scale || (raw.includes('.') && scale === 0))
    return null;
  return scale ? `${whole}.${fraction.padEnd(scale, '0')}` : whole!;
}
const units = (value: string): bigint => BigInt(value.replace('.', ''));
const signedUnits = (value: string): bigint =>
  value.startsWith('-') ? -units(value.slice(1)) : units(value);
function text(value: bigint, currency: FinancialAccountCurrency): string {
  const scale = CURRENCY_SCALES[currency];
  const digits = (value < 0n ? -value : value)
    .toString()
    .padStart(scale + 1, '0');
  return `${value < 0n ? '-' : ''}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`;
}
function validSpend(
  value: unknown,
  currency: FinancialAccountCurrency,
): value is InsightSpend {
  if (
    !keys(value, [
      'expenseTotal',
      'refundTotal',
      'netSpending',
      'expenseCount',
      'refundCount',
    ])
  )
    return false;
  return (
    typeof value.expenseTotal === 'string' &&
    isAggregateAmountString(value.expenseTotal, currency) &&
    !value.expenseTotal.startsWith('-') &&
    typeof value.refundTotal === 'string' &&
    isAggregateAmountString(value.refundTotal, currency) &&
    !value.refundTotal.startsWith('-') &&
    typeof value.netSpending === 'string' &&
    isAggregateAmountString(value.netSpending, currency) &&
    signedUnits(value.expenseTotal) - signedUnits(value.refundTotal) ===
      signedUnits(value.netSpending) &&
    typeof value.expenseCount === 'string' &&
    count.test(value.expenseCount) &&
    typeof value.refundCount === 'string' &&
    count.test(value.refundCount)
  );
}
export function parseBudgetTarget(
  value: unknown,
  householdId: string,
  currency?: FinancialAccountCurrency,
): BudgetTarget | undefined {
  if (
    !keys(value, [
      'id',
      'householdId',
      'month',
      'bucket',
      'money',
      'status',
      'version',
      'createdAt',
      'updatedAt',
    ]) ||
    typeof value.id !== 'string' ||
    !uuid.test(value.id) ||
    value.householdId !== householdId ||
    typeof value.month !== 'string' ||
    !isInsightMonth(value.month) ||
    !isBudgetBucket(value.bucket) ||
    !keys(value.money, ['amount', 'currency'])
  )
    return;
  const money = value.money;
  if (
    !['BRL', 'USD', 'EUR', 'GBP', 'CAD', 'JPY', 'KWD'].includes(
      String(money.currency),
    ) ||
    (currency !== undefined && money.currency !== currency) ||
    !validTargetAmount(
      money.amount,
      money.currency as FinancialAccountCurrency,
    ) ||
    (value.status !== 'ACTIVE' && value.status !== 'ARCHIVED') ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 0 ||
    typeof value.createdAt !== 'string' ||
    !instant.test(value.createdAt) ||
    typeof value.updatedAt !== 'string' ||
    !instant.test(value.updatedAt) ||
    value.updatedAt < value.createdAt
  )
    return;
  return value as BudgetTarget;
}
export function parseBudgetPage(
  value: unknown,
  householdId: string,
  month: string,
  currency: FinancialAccountCurrency,
  status: 'ACTIVE' | 'ARCHIVED' | 'ALL',
  limit: number,
  offset: number,
): BudgetPage | undefined {
  if (
    !keys(value, ['items', 'limit', 'offset', 'hasMore']) ||
    value.limit !== limit ||
    value.offset !== offset ||
    typeof value.hasMore !== 'boolean' ||
    !Array.isArray(value.items) ||
    value.items.length > limit ||
    (value.hasMore && value.items.length !== limit)
  )
    return;
  const items = value.items.map((item: unknown) =>
    parseBudgetTarget(item, householdId, currency),
  );
  if (
    !items.every(
      (item): item is BudgetTarget =>
        item !== undefined &&
        item.month === month &&
        (status === 'ALL' || item.status === status),
    ) ||
    new Set(items.map((item) => item.id)).size !== items.length
  )
    return;
  return value as BudgetPage;
}
function parsedProgress(
  value: unknown,
  householdId: string,
  month: string,
  currency: FinancialAccountCurrency,
  bucket: string,
  actual?: InsightSpend,
): BudgetProgressItem | undefined {
  if (
    !keys(value, [
      'target',
      'actual',
      'remaining',
      'overBy',
      'percentUsed',
      'status',
    ])
  )
    return;
  const target = parseBudgetTarget(value.target, householdId, currency);
  if (
    !target ||
    target.month !== month ||
    target.bucket !== bucket ||
    target.status !== 'ACTIVE' ||
    !validSpend(value.actual, currency)
  )
    return;
  const spent = value.actual;
  const remaining = units(target.money.amount) - signedUnits(spent.netSpending);
  const over = remaining < 0n ? -remaining : 0n;
  const ratio =
    units(target.money.amount) === 0n
      ? null
      : (() => {
          const numerator = signedUnits(spent.netSpending) * 10000n;
          const denominator = units(target.money.amount);
          const rounded =
            ((numerator < 0n ? -1n : 1n) *
              (((numerator < 0n ? -numerator : numerator) * 2n) / denominator +
                1n)) /
            2n;
          return text(rounded, 'USD');
        })();
  if (
    value.remaining !== text(remaining, currency) ||
    value.overBy !== text(over, currency) ||
    value.percentUsed !== ratio ||
    (value.percentUsed !== null &&
      (typeof value.percentUsed !== 'string' ||
        !percent.test(value.percentUsed))) ||
    value.status !==
      (remaining > 0n ? 'UNDER' : remaining < 0n ? 'OVER' : 'AT') ||
    (actual && !sameSpend(spent, actual))
  )
    return;
  return value as BudgetProgressItem;
}
function sameSpend(a: InsightSpend, b: InsightSpend): boolean {
  return (
    a.expenseTotal === b.expenseTotal &&
    a.refundTotal === b.refundTotal &&
    a.netSpending === b.netSpending &&
    a.expenseCount === b.expenseCount &&
    a.refundCount === b.refundCount
  );
}
export function parseBudgetProgress(
  value: unknown,
  householdId: string,
  month: string,
  currency: FinancialAccountCurrency,
): BudgetProgress | undefined {
  if (
    !keys(value, [
      'reportingTimeZone',
      'asOfDate',
      'currency',
      'policyVersion',
      'snapshot',
      'period',
      'totals',
      'overall',
      'categories',
      'untargeted',
    ]) ||
    value.currency !== currency ||
    value.policyVersion !== 'BUDGETS_V1' ||
    typeof value.reportingTimeZone !== 'string' ||
    !isRegionShapedZone(value.reportingTimeZone) ||
    !calendarDate(value.asOfDate) ||
    typeof value.snapshot !== 'string' ||
    !digest.test(value.snapshot) ||
    !keys(value.period, ['month', 'from', 'to', 'state']) ||
    value.period.month !== month ||
    value.period.from !== `${month}-01` ||
    value.period.to !== `${nextInsightMonth(month)}-01` ||
    value.period.state !==
      (value.asOfDate < value.period.from
        ? 'FUTURE'
        : value.asOfDate >= value.period.to
          ? 'COMPLETED'
          : 'IN_PROGRESS') ||
    !validSpend(value.totals, currency) ||
    !validSpend(value.untargeted, currency) ||
    !Array.isArray(value.categories)
  )
    return;
  const overall =
    value.overall === null
      ? null
      : parsedProgress(
          value.overall,
          householdId,
          month,
          currency,
          'OVERALL',
          value.totals,
        );
  if (value.overall !== null && !overall) return;
  const categories = value.categories.map((item: unknown) => {
    if (
      !keys(item, [
        'target',
        'actual',
        'remaining',
        'overBy',
        'percentUsed',
        'status',
      ]) ||
      !keys(item.target, [
        'id',
        'householdId',
        'month',
        'bucket',
        'money',
        'status',
        'version',
        'createdAt',
        'updatedAt',
      ]) ||
      typeof item.target.bucket !== 'string' ||
      item.target.bucket === 'OVERALL'
    )
      return undefined;
    return parsedProgress(
      item,
      householdId,
      month,
      currency,
      item.target.bucket,
    );
  });
  if (
    !categories.every(
      (item): item is BudgetProgressItem => item !== undefined,
    ) ||
    categories.some(
      (item, index) =>
        index > 0 && categories[index - 1]!.target.bucket >= item.target.bucket,
    )
  )
    return;
  const parts = [...categories.map((item) => item.actual), value.untargeted];
  for (const key of [
    'expenseTotal',
    'refundTotal',
    'netSpending',
    'expenseCount',
    'refundCount',
  ] as const) {
    const sum = parts.reduce(
      (acc, item) =>
        acc +
        (key.endsWith('Count') ? BigInt(item[key]) : signedUnits(item[key])),
      0n,
    );
    if (
      sum !==
      (key.endsWith('Count')
        ? BigInt(value.totals[key])
        : signedUnits(value.totals[key]))
    )
      return;
  }
  return value as BudgetProgress;
}
