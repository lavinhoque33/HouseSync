import { describe, expect, it } from 'vitest';
import { parseInsightSummary } from './summary';

const home = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const zero = {
  expenseTotal: '0.00',
  refundTotal: '0.00',
  netSpending: '0.00',
  expenseCount: '0',
  refundCount: '0',
};
const refund = {
  expenseTotal: '0.00',
  refundTotal: '2.00',
  netSpending: '-2.00',
  expenseCount: '0',
  refundCount: '1',
};
const change = {
  delta: '-2.00',
  direction: 'DECREASE',
  percentChange: null,
  percentUnavailableReason: 'BASELINE_ZERO',
};
const current = {
  month: '2026-09',
  from: '2026-09-01',
  to: '2026-10-01',
  state: 'IN_PROGRESS',
};
const baseline = {
  month: '2026-08',
  from: '2026-08-01',
  to: '2026-09-01',
  state: 'COMPLETED',
};
const group = {
  key: 'GROCERIES',
  label: 'Groceries',
  current: refund,
  baseline: zero,
  change,
};
const target = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1',
  householdId: home,
  month: '2026-09',
  bucket: 'OVERALL',
  money: { amount: '0.00', currency: 'USD' },
  status: 'ACTIVE',
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const summary = () => ({
  reportingTimeZone: 'Etc/UTC',
  asOfDate: '2026-09-25',
  currency: 'USD',
  policyVersion:
    'SUMMARY_V1/SPENDING_V1/RECURRENCE_V1/BUDGETS_V1/PUBLIC_DESCRIPTION_V1',
  snapshot: 'a'.repeat(64),
  period: current,
  baselinePeriod: baseline,
  current: { ...refund, incomeTotal: '0.00' },
  baseline: { ...zero, incomeTotal: '0.00' },
  change,
  categoryDrivers: { increases: [], decreases: [group], otherDelta: '0.00' },
  merchantDrivers: { increases: [], decreases: [], otherDelta: '-2.00' },
  budget: {
    totals: refund,
    overall: {
      target,
      actual: refund,
      remaining: '2.00',
      overBy: '0.00',
      percentUsed: null,
      status: 'UNDER',
    },
    categories: [],
    untargeted: refund,
  },
  recurring: {
    evidenceFrom: '2023-09-25',
    evidenceTo: '2026-09-26',
    openCandidateCount: '0',
    activePlanCount: '0',
    items: [],
    hasMore: false,
  },
});
const parse = (value: unknown) =>
  parseInsightSummary(value, home, '2026-09', '2026-08', 'USD');
describe('one coherent summary transport', () => {
  it('keeps refund-heavy negative net, separate driver conservation and an explicit zero budget target', () => {
    const body = summary();
    expect(parse(body)?.budget.overall?.target.money.amount).toBe('0.00');
    expect(
      parse({
        ...body,
        categoryDrivers: { ...body.categoryDrivers, otherDelta: '-2.00' },
      }),
    ).toBeUndefined();
    expect(
      parse({
        ...body,
        merchantDrivers: { ...body.merchantDrivers, otherDelta: '0.00' },
      }),
    ).toBeUndefined();
    expect(
      parse({ ...body, budget: { ...body.budget, overall: null } })?.budget
        .overall,
    ).toBeNull();
    expect(
      parse({ ...body, current: { ...body.current, accountId: 'private' } }),
    ).toBeUndefined();
    expect(
      parse({ ...body, budget: { ...body.budget, untargeted: zero } }),
    ).toBeUndefined();
  });
  it('rejects hidden fields, invalid group signs, future period mistakes and invented continuation counts', () => {
    const body = summary();
    expect(parse({ ...body, privateAccount: home })).toBeUndefined();
    expect(
      parse({
        ...body,
        categoryDrivers: {
          ...body.categoryDrivers,
          increases: [group],
          decreases: [],
        },
      }),
    ).toBeUndefined();
    expect(
      parse({ ...body, period: { ...current, state: 'FUTURE' } }),
    ).toBeUndefined();
    expect(
      parse({
        ...body,
        recurring: { ...body.recurring, activePlanCount: '1', hasMore: true },
      }),
    ).toBeUndefined();
    expect(
      parse({
        ...body,
        recurring: { ...body.recurring, evidenceTo: '2026-10-01' },
      }),
    ).toBeUndefined();
  });
});
