import { describe, expect, it } from 'vitest';
import {
  parseInsightComparison,
  parseInsightEvidence,
  parseInsightSeries,
} from './insights';

const metadata = {
  reportingTimeZone: 'Etc/UTC',
  asOfDate: '2026-09-25',
  currency: 'USD',
  policyVersion: 'SPENDING_V1/PUBLIC_DESCRIPTION_V1',
  snapshot: 'a'.repeat(64),
};
const spend = {
  expenseTotal: '3.00',
  refundTotal: '5.00',
  netSpending: '-2.00',
  expenseCount: '1',
  refundCount: '1',
};
const totals = { ...spend, incomeTotal: '0.00' };
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
const change = {
  delta: '0.00',
  direction: 'UNCHANGED',
  percentChange: null,
  percentUnavailableReason: 'BASELINE_NEGATIVE',
};

describe('strict insight response boundaries', () => {
  it('keeps exact negative/refund totals and distinct metadata while rejecting unknown/private fields', () => {
    const response = {
      ...metadata,
      period: current,
      baselinePeriod: baseline,
      dimension: 'CATEGORY',
      current: totals,
      baseline: totals,
      change,
      items: [
        {
          key: 'GROCERIES',
          label: 'Groceries',
          current: spend,
          baseline: spend,
          change,
        },
      ],
      nextCursor: null,
    };
    expect(
      parseInsightComparison(
        response,
        '2026-09',
        '2026-08',
        'USD',
        'CATEGORY',
        100,
      ),
    ).toBeDefined();
    expect(
      parseInsightComparison(
        { ...response, accountId: 'private' },
        '2026-09',
        '2026-08',
        'USD',
        'CATEGORY',
        100,
      ),
    ).toBeUndefined();
    expect(
      parseInsightComparison(
        { ...response, change: { ...change, percentChange: '0.00' } },
        '2026-09',
        '2026-08',
        'USD',
        'CATEGORY',
        100,
      ),
    ).toBeUndefined();
    expect(
      parseInsightComparison(
        {
          ...response,
          items: [
            {
              ...response.items[0],
              current: { ...spend, netSpending: '3.00' },
            },
          ],
        },
        '2026-09',
        '2026-08',
        'USD',
        'CATEGORY',
        100,
      ),
    ).toBeUndefined();
  });

  it('rejects evidence carrying account identity and accepts ledger-signed refund with inherited category', () => {
    const entry = {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      version: 2,
      kind: 'REFUND',
      occurredOn: '2026-09-02',
      money: { amount: '5.00', currency: 'USD' },
      description: 'Refund receipt',
      category: 'GROCERIES',
      refundOfTransactionId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    };
    const evidence = {
      ...metadata,
      period: current,
      dimension: 'CATEGORY',
      groupKey: 'GROCERIES',
      totals: spend,
      items: [entry],
      nextCursor: null,
    };
    expect(
      parseInsightEvidence(
        evidence,
        '2026-09',
        'USD',
        'CATEGORY',
        'GROCERIES',
        100,
      ),
    ).toBeDefined();
    expect(
      parseInsightEvidence(
        { ...evidence, items: [{ ...entry, accountId: entry.id }] },
        '2026-09',
        'USD',
        'CATEGORY',
        'GROCERIES',
        100,
      ),
    ).toBeUndefined();
    expect(
      parseInsightEvidence(
        { ...evidence, items: [{ ...entry, category: 'PRIVATE' }] },
        '2026-09',
        'USD',
        'CATEGORY',
        'GROCERIES',
        100,
      ),
    ).toBeUndefined();
    expect(
      parseInsightEvidence(
        { ...evidence, items: [{ ...entry, occurredOn: '2026-09-31' }] },
        '2026-09',
        'USD',
        'CATEGORY',
        'GROCERIES',
        100,
      ),
    ).toBeUndefined();
  });

  it('requires every month bucket, checks exclusive bounds and permits zero group-only income', () => {
    const response = {
      ...metadata,
      fromMonth: '2026-08',
      toMonth: '2026-10',
      dimension: 'CATEGORY',
      groupKey: 'GROCERIES',
      items: [
        { period: baseline, totals },
        { period: current, totals },
      ],
    };
    expect(
      parseInsightSeries(
        response,
        '2026-08',
        '2026-10',
        'USD',
        'CATEGORY',
        'GROCERIES',
      ),
    ).toBeDefined();
    expect(
      parseInsightSeries(
        { ...response, items: [response.items[1]] },
        '2026-08',
        '2026-10',
        'USD',
        'CATEGORY',
        'GROCERIES',
      ),
    ).toBeUndefined();
    expect(
      parseInsightSeries(
        {
          ...response,
          items: [
            { period: baseline, totals: { ...totals, incomeTotal: '1.00' } },
            response.items[1],
          ],
        },
        '2026-08',
        '2026-10',
        'USD',
        'CATEGORY',
        'GROCERIES',
      ),
    ).toBeUndefined();
  });
});
