import { describe, expect, it } from 'vitest';
import {
  normalizeTargetAmount,
  parseBudgetProgress,
  parseBudgetTarget,
} from './budgets';
import type { InsightSpend } from './insights';

const home = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const target = (
  bucket: string,
  amount: string,
  id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1',
) => ({
  id,
  householdId: home,
  month: '2026-09',
  bucket,
  money: { amount, currency: 'USD' },
  status: 'ACTIVE',
  version: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});
const spend = (
  expenses: string,
  refunds: string,
  net: string,
  expenseCount = '1',
  refundCount = '1',
) => ({
  expenseTotal: expenses,
  refundTotal: refunds,
  netSpending: net,
  expenseCount,
  refundCount,
});
const row = (
  bucket: string,
  amount: string,
  actual: InsightSpend,
  remaining: string,
  overBy: string,
  percentUsed: string | null,
  status: string,
) => ({
  target: target(bucket, amount),
  actual,
  remaining,
  overBy,
  percentUsed,
  status,
});
const base = {
  reportingTimeZone: 'Etc/UTC',
  asOfDate: '2026-09-25',
  currency: 'USD',
  policyVersion: 'BUDGETS_V1',
  snapshot: 'a'.repeat(64),
  period: {
    month: '2026-09',
    from: '2026-09-01',
    to: '2026-10-01',
    state: 'IN_PROGRESS',
  },
};
const parse = (value: unknown) =>
  parseBudgetProgress(value, home, '2026-09', 'USD');
describe('exact budget transport', () => {
  it('distinguishes an absent overall from an intentionally zero overall, including undefined ratio and signed overage', () => {
    const actual = spend('5.00', '0.00', '5.00', '1', '0');
    const empty = {
      ...base,
      totals: actual,
      overall: null,
      categories: [],
      untargeted: actual,
    };
    expect(parse(empty)?.overall).toBeNull();
    const explicit = row(
      'OVERALL',
      '0.00',
      actual,
      '-5.00',
      '5.00',
      null,
      'OVER',
    );
    expect(
      parse({ ...empty, overall: explicit })?.overall?.target.money.amount,
    ).toBe('0.00');
    expect(
      parse({ ...empty, overall: { ...explicit, percentUsed: '0.00' } }),
    ).toBeUndefined();
    expect(
      parse({ ...empty, overall: { ...explicit, remaining: '0.00' } }),
    ).toBeUndefined();
  });
  it('validates negative refund-heavy and over-100 percentages without number conversion', () => {
    const negative = spend('0.00', '50.00', '-50.00', '0', '1');
    const refund = row(
      'OVERALL',
      '200.00',
      negative,
      '250.00',
      '0.00',
      '-25.00',
      'UNDER',
    );
    expect(
      parse({
        ...base,
        totals: negative,
        overall: refund,
        categories: [],
        untargeted: negative,
      }),
    ).toBeDefined();
    const over = spend('120.00', '0.00', '120.00', '1', '0');
    const exceeded = row(
      'OVERALL',
      '100.00',
      over,
      '-20.00',
      '20.00',
      '120.00',
      'OVER',
    );
    expect(
      parse({
        ...base,
        totals: over,
        overall: exceeded,
        categories: [],
        untargeted: over,
      }),
    ).toBeDefined();
    expect(
      parse({
        ...base,
        totals: over,
        overall: { ...exceeded, percentUsed: '100.00' },
        categories: [],
        untargeted: over,
      }),
    ).toBeUndefined();
  });
  it('requires categories and untargeted to conserve all exact amounts and counts, without adding overall twice', () => {
    const grocery = spend('10.00', '3.00', '7.00');
    const untargeted = spend('2.00', '5.00', '-3.00');
    const totals = spend('12.00', '8.00', '4.00', '2', '2');
    const category = row(
      'GROCERIES',
      '7.00',
      grocery,
      '0.00',
      '0.00',
      '100.00',
      'AT',
    );
    const full = {
      ...base,
      totals,
      overall: row('OVERALL', '4.00', totals, '0.00', '0.00', '100.00', 'AT'),
      categories: [category],
      untargeted,
    };
    expect(parse(full)).toBeDefined();
    expect(
      parse({ ...full, untargeted: { ...untargeted, refundCount: '2' } }),
    ).toBeUndefined();
    expect(
      parse({
        ...full,
        categories: [
          { ...category, target: { ...category.target, status: 'ARCHIVED' } },
        ],
      }),
    ).toBeUndefined();
  });
  it('accepts zero across all seven currency scales but rejects negative zero, overprecision and excessive magnitude', () => {
    for (const currency of [
      'BRL',
      'USD',
      'EUR',
      'GBP',
      'CAD',
      'JPY',
      'KWD',
    ] as const) {
      const zero = normalizeTargetAmount('0', currency)!;
      const item = {
        ...target('UNCATEGORIZED', zero),
        money: { currency, amount: zero },
      };
      expect(parseBudgetTarget(item, home, currency)).toBeDefined();
      expect(
        parseBudgetTarget(
          { ...item, money: { currency, amount: `-${zero}` } },
          home,
          currency,
        ),
      ).toBeUndefined();
      expect(normalizeTargetAmount('1000000000000', currency)).toBeNull();
      expect(
        normalizeTargetAmount(
          currency === 'JPY' ? '1.0' : currency === 'KWD' ? '1.0001' : '1.001',
          currency,
        ),
      ).toBeNull();
    }
  });
});
