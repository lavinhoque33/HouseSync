import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  fetchInsightComparison,
  fetchInsightEvidence,
  fetchInsightSeries,
} from '../auth/client';

const household = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const metadata = {
  reportingTimeZone: 'Etc/UTC',
  asOfDate: '2026-09-25',
  currency: 'USD',
  policyVersion: 'SPENDING_V1/PUBLIC_DESCRIPTION_V1',
  snapshot: 'a'.repeat(64),
};
const empty = {
  expenseTotal: '0.00',
  refundTotal: '0.00',
  netSpending: '0.00',
  expenseCount: '0',
  refundCount: '0',
};
const totals = { ...empty, incomeTotal: '0.00' };
const period = {
  month: '2026-09',
  from: '2026-09-01',
  to: '2026-10-01',
  state: 'IN_PROGRESS',
};
const baselinePeriod = {
  month: '2026-08',
  from: '2026-08-01',
  to: '2026-09-01',
  state: 'COMPLETED',
};
const change = {
  delta: '0.00',
  direction: 'UNCHANGED',
  percentChange: null,
  percentUnavailableReason: 'BASELINE_ZERO',
};
afterEach(() => vi.unstubAllGlobals());

describe('Insights A wire client', () => {
  it('sends only allowed selectors, checks exact DTO, and does not parse money as numbers', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes('spending-series'))
          return Response.json({
            ...metadata,
            fromMonth: '2026-09',
            toMonth: '2026-10',
            dimension: 'CATEGORY',
            groupKey: 'GROCERIES',
            items: [{ period, totals }],
          });
        if (url.includes('spending-evidence'))
          return Response.json({
            ...metadata,
            period,
            dimension: 'CATEGORY',
            groupKey: 'GROCERIES',
            totals: empty,
            items: [],
            nextCursor: null,
          });
        return Response.json({
          ...metadata,
          period,
          baselinePeriod,
          dimension: 'CATEGORY',
          current: totals,
          baseline: totals,
          change,
          items: [],
          nextCursor: null,
        });
      }),
    );
    const comparison = await fetchInsightComparison(
      household,
      '2026-09',
      '2026-08',
      'USD',
      'CATEGORY',
      100,
      'cursor',
    );
    expect(comparison.current.netSpending).toBe('0.00');
    await fetchInsightEvidence(
      household,
      '2026-09',
      'USD',
      'CATEGORY',
      'GROCERIES',
      100,
      'cursor',
    );
    await fetchInsightSeries(
      household,
      '2026-09',
      '2026-10',
      'USD',
      undefined,
      'CATEGORY',
      'GROCERIES',
    );
    expect(calls[0]).toContain(
      'spending-comparison?month=2026-09&baselineMonth=2026-08&currency=USD&dimension=CATEGORY&limit=100&cursor=cursor',
    );
    expect(calls[1]).toContain(
      'spending-evidence?month=2026-09&currency=USD&dimension=CATEGORY&groupKey=GROCERIES&limit=100&cursor=cursor',
    );
    expect(calls[2]).toContain(
      'spending-series?fromMonth=2026-09&toMonth=2026-10&currency=USD&dimension=CATEGORY&groupKey=GROCERIES',
    );
  });

  it('propagates stale cursor errors without displaying stale financial records', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { code: 'INSIGHT_SNAPSHOT_STALE', message: 'Changed' },
          { status: 409 },
        ),
      ),
    );
    await expect(
      fetchInsightComparison(
        household,
        '2026-09',
        '2026-08',
        'USD',
        'CATEGORY',
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: 'INSIGHT_SNAPSHOT_STALE',
    } satisfies Partial<ApiError>);
  });
});
