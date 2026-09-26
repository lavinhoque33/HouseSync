import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Household } from '../auth/client';
import { nextInsightMonth } from './insights';
import { InsightsSection } from './InsightsSection';
vi.mock('./RecurringSection', () => ({
  RecurringSection: () => null,
}));
vi.mock('./BudgetSection', () => ({
  BudgetSection: () => null,
}));

const household: Household = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  name: 'Home',
  role: 'MEMBER',
  createdAt: '2026-01-01T00:00:00Z',
};
const fetchComparison = vi.fn();
const fetchSeries = vi.fn();
const fetchEvidence = vi.fn();
const fetchSummary = vi.fn();
vi.mock('../auth/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchInsightComparison: (...args: unknown[]) => fetchComparison(...args),
    fetchInsightSeries: (...args: unknown[]) => fetchSeries(...args),
    fetchInsightEvidence: (...args: unknown[]) => fetchEvidence(...args),
    fetchInsightSummary: (...args: unknown[]) => fetchSummary(...args),
  };
});
const zero = {
  expenseTotal: '0.00',
  refundTotal: '0.00',
  netSpending: '0.00',
  expenseCount: '0',
  refundCount: '0',
};
const totals = { ...zero, incomeTotal: '0.00' };
const unchanged = {
  delta: '0.00',
  direction: 'UNCHANGED',
  percentChange: null,
  percentUnavailableReason: 'BASELINE_ZERO',
};
const meta = {
  reportingTimeZone: 'Etc/UTC',
  asOfDate: '2026-09-25',
  currency: 'USD',
  policyVersion: 'SPENDING_V1/PUBLIC_DESCRIPTION_V1',
  snapshot: 'a'.repeat(64),
};
const period = (month: string) => ({
  month,
  from: `${month}-01`,
  to: `${month === '2026-09' ? '2026-10' : '2026-09'}-01`,
  state: 'COMPLETED',
});
const group = (index: number) => ({
  key: 'GROCERIES',
  label: `Groceries ${index}`,
  current: zero,
  baseline: zero,
  change: unchanged,
});
const comparison = (items: unknown[], nextCursor: string | null) => ({
  ...meta,
  period: period('2026-09'),
  baselinePeriod: period('2026-08'),
  dimension: 'CATEGORY',
  current: totals,
  baseline: totals,
  change: unchanged,
  items,
  nextCursor,
});
const series = () => ({
  ...meta,
  fromMonth: '2026-01',
  toMonth: '2026-10',
  dimension: null,
  groupKey: null,
  items: [],
});
const summary = () => ({
  ...meta,
  policyVersion:
    'SUMMARY_V1/SPENDING_V1/RECURRENCE_V1/BUDGETS_V1/PUBLIC_DESCRIPTION_V1',
  period: { ...period('2026-09'), state: 'IN_PROGRESS' },
  baselinePeriod: period('2026-08'),
  current: totals,
  baseline: totals,
  change: unchanged,
  categoryDrivers: { increases: [], decreases: [], otherDelta: '0.00' },
  merchantDrivers: { increases: [], decreases: [], otherDelta: '0.00' },
  budget: { totals: zero, overall: null, categories: [], untargeted: zero },
  recurring: {
    evidenceFrom: '2023-09-25',
    evidenceTo: '2026-09-26',
    openCandidateCount: '0',
    activePlanCount: '0',
    items: [],
    hasMore: false,
  },
});
function mount(
  refreshSignal = 0,
  onSessionExpired = vi.fn(),
  onHouseholdAccessChanged = vi.fn(),
) {
  return render(
    <InsightsSection
      household={household}
      reportingZone="Etc/UTC"
      csrf={null}
      onCsrfRefreshed={vi.fn()}
      refreshSignal={refreshSignal}
      onSessionExpired={onSessionExpired}
      onHouseholdAccessChanged={onHouseholdAccessChanged}
      onOpenTransaction={vi.fn()}
      budgetPending={null}
      setBudgetPending={vi.fn()}
      nowProvider={() => new Date('2026-09-25T12:00:00Z')}
    />,
  );
}
fetchSummary.mockImplementation(async () => summary());
afterEach(() => {
  vi.clearAllMocks();
});

describe('household insights interactions', () => {
  it('keeps unapplied month drafts out of remote-disclosure refreshes and reports baseline-zero honestly', async () => {
    fetchComparison.mockImplementation(async () => comparison([], null));
    fetchSeries.mockImplementation(async () => series());
    const view = mount();
    await screen.findByText(/Percent unavailable: zero baseline/);
    fireEvent.change(screen.getByLabelText('Month'), {
      target: { value: '2026-07' },
    });
    view.rerender(
      <InsightsSection
        household={household}
        reportingZone="Etc/UTC"
        csrf={null}
        onCsrfRefreshed={vi.fn()}
        refreshSignal={1}
        onSessionExpired={vi.fn()}
        onHouseholdAccessChanged={vi.fn()}
        onOpenTransaction={vi.fn()}
        budgetPending={null}
        setBudgetPending={vi.fn()}
        nowProvider={() => new Date('2026-09-25T12:00:00Z')}
      />,
    );
    await waitFor(() => expect(fetchComparison).toHaveBeenCalledTimes(2));
    expect(fetchComparison.mock.calls[1]?.[1]).toBe('2026-09');
    fireEvent.click(screen.getByRole('button', { name: 'Show insights' }));
    await waitFor(() =>
      expect(fetchComparison.mock.calls.at(-1)?.[1]).toBe('2026-07'),
    );
  });

  it('plots exact large positive, refund-heavy negative and zero months without losing the equivalent table', async () => {
    fetchComparison.mockImplementation(async () => comparison([], null));
    const amounts = [
      {
        month: '2026-06',
        expenseTotal: '100000000000000000000.00',
        refundTotal: '0.00',
        netSpending: '100000000000000000000.00',
      },
      {
        month: '2026-07',
        expenseTotal: '0.00',
        refundTotal: '50000000000000000000.00',
        netSpending: '-50000000000000000000.00',
      },
      {
        month: '2026-08',
        expenseTotal: '120.00',
        refundTotal: '120.00',
        netSpending: '0.00',
      },
      {
        month: '2026-09',
        expenseTotal: '1.00',
        refundTotal: '0.00',
        netSpending: '1.00',
      },
    ];
    fetchSeries.mockImplementation(async () => ({
      ...series(),
      items: amounts.map(
        ({ month, expenseTotal, refundTotal, netSpending }) => ({
          period: {
            month,
            from: `${month}-01`,
            to: `${nextInsightMonth(month)}-01`,
            state: month === '2026-09' ? 'IN_PROGRESS' : 'COMPLETED',
          },
          totals: { ...totals, expenseTotal, refundTotal, netSpending },
        }),
      ),
    }));
    const view = mount();
    await screen.findByRole('table', { name: /Monthly spending in USD/ });
    const chartRows = view.container.querySelectorAll('.insights-chart li');
    expect(chartRows).toHaveLength(4);
    expect(
      chartRows[0]?.querySelector('.insights-chart-bar--positive'),
    ).toHaveStyle({ width: '100%' });
    expect(
      chartRows[1]?.querySelector('.insights-chart-bar--refund'),
    ).toHaveStyle({ width: '50%' });
    expect(
      chartRows[2]?.querySelector('.insights-chart-zero'),
    ).toHaveTextContent('zero');
    expect(
      chartRows[3]?.querySelector('.insights-chart-bar--positive'),
    ).toHaveStyle({ width: '1%' });
    const table = screen.getByRole('table', {
      name: /Monthly spending in USD/,
    });
    expect(
      within(table).getByText('-50000000000000000000.00 USD'),
    ).toBeInTheDocument();
    expect(
      within(table).getByText('100000000000000000000.00 USD'),
    ).toBeInTheDocument();
  });

  it('paginates evidence past 100 records, retaining totals and direct detail actions', async () => {
    fetchComparison.mockImplementation(async () =>
      comparison([group(0)], null),
    );
    fetchSeries.mockImplementation(async () => series());
    const row = (index: number) => ({
      id: `${String(index).padStart(8, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`,
      version: 1,
      kind: 'EXPENSE',
      occurredOn: '2026-09-12',
      money: { amount: '-1.00', currency: 'USD' },
      description: `Public ${index}`,
      category: 'GROCERIES',
      refundOfTransactionId: null,
    });
    fetchEvidence.mockImplementation(
      async (_id, month, _currency, _dimension, _key, _limit, cursor) => ({
        ...meta,
        period: period(month),
        dimension: 'CATEGORY',
        groupKey: 'GROCERIES',
        totals: {
          expenseTotal: '101.00',
          refundTotal: '0.00',
          netSpending: '101.00',
          expenseCount: '101',
          refundCount: '0',
        },
        items:
          month === '2026-08'
            ? []
            : cursor
              ? [row(100)]
              : Array.from({ length: 100 }, (_, index) => row(index)),
        nextCursor: month === '2026-08' || cursor ? null : 'next',
      }),
    );
    mount();
    fireEvent.click(
      await screen.findByRole('button', {
        name: /View trend and evidence for Groceries 0/,
      }),
    );
    const next = await screen.findByRole('button', {
      name: 'Load more 2026-09 evidence',
    });
    expect(screen.getByText(/Evidence list is partial/)).toBeInTheDocument();
    fireEvent.click(next);
    await screen.findByText('Public 100');
    expect(fetchEvidence.mock.calls.at(-1)?.[6]).toBe('next');
    expect(
      within(
        screen.getByRole('table', {
          name: /Disclosed transactions for Groceries 0 in 2026-09/,
        }),
      ).getAllByRole('row'),
    ).toHaveLength(102);
  });

  it('loads more than 100 description groups without dropping whole-population totals', async () => {
    fetchComparison.mockImplementation(
      async (_id, _month, _base, _currency, dimension, _limit, cursor) => ({
        ...comparison(
          cursor
            ? [{ ...group(101), key: 'b'.repeat(64) }]
            : Array.from({ length: 100 }, (_, index) => ({
                ...group(index),
                key: index.toString(16).padStart(64, '0'),
              })),
          cursor ? null : 'next',
        ),
        dimension,
      }),
    );
    fetchSeries.mockImplementation(async () => series());
    mount();
    fireEvent.change(screen.getByLabelText('Breakdown'), {
      target: { value: 'MERCHANT' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Show insights' }));
    const load = await screen.findByRole('button', {
      name: 'Load more groups',
    });
    expect(screen.getByText(/table is partial/)).toBeInTheDocument();
    fireEvent.click(load);
    await screen.findByRole('button', {
      name: /View trend and evidence for Groceries 101/,
    });
    expect(
      screen.getAllByRole('button', { name: /View trend and evidence/ }),
    ).toHaveLength(101);
    expect(
      screen.getByText(/Net spending 0.00 USD vs 0.00 USD/),
    ).toBeInTheDocument();
  });

  it('removes retained money and delegates session loss instead of retrying under old authority', async () => {
    fetchComparison
      .mockImplementationOnce(async () => comparison([group(0)], null))
      .mockImplementationOnce(async () => {
        throw new ApiError({
          status: 401,
          code: 'UNAUTHENTICATED',
          message: 'Sign in',
        });
      });
    fetchSeries.mockImplementation(async () => series());
    const onExpired = vi.fn();
    mount(0, onExpired);
    await screen.findByRole('button', {
      name: /View trend and evidence for Groceries 0/,
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh current records' }),
    );
    await waitFor(() => expect(onExpired).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole('button', { name: /View trend and evidence/ }),
    ).not.toBeInTheDocument();
  });

  it('clears a disclosed group when its evidence continuation becomes stale', async () => {
    fetchComparison.mockImplementation(async () =>
      comparison([group(0)], null),
    );
    fetchSeries.mockImplementation(async () => series());
    fetchEvidence.mockImplementation(
      async (_id, month, _currency, _dimension, _key, _limit, cursor) => {
        if (cursor)
          throw new ApiError({
            status: 409,
            code: 'INSIGHT_SNAPSHOT_STALE',
            message: 'Changed',
          });
        return {
          ...meta,
          period: period(month),
          dimension: 'CATEGORY',
          groupKey: 'GROCERIES',
          totals: zero,
          items: [],
          nextCursor: month === '2026-09' ? 'next' : null,
        };
      },
    );
    mount();
    fireEvent.click(
      await screen.findByRole('button', {
        name: /View trend and evidence for Groceries 0/,
      }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load more 2026-09 evidence' }),
    );
    await screen.findByText(/All previous groups and evidence were cleared/);
    expect(screen.queryByText('Groceries 0')).not.toBeInTheDocument();
  });

  it('clears stale pages and allows explicit recovery without retaining private rows', async () => {
    fetchComparison.mockImplementation(
      async (_id, _month, _base, _currency, _dimension, _limit, cursor) =>
        cursor
          ? Promise.reject(
              new ApiError({
                status: 409,
                code: 'INSIGHT_SNAPSHOT_STALE',
                message: 'Snapshot changed',
              }),
            )
          : comparison([group(0)], 'next'),
    );
    fetchSeries.mockImplementation(async () => series());
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load more groups' }),
    );
    await screen.findByRole('alert');
    expect(
      screen.queryByRole('button', { name: /View trend and evidence/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reload insights' }));
    expect(
      await screen.findByRole('button', { name: /View trend and evidence/ }),
    ).toBeInTheDocument();
  });
  it('shows the applied merchant breakdown after opening its summary evidence', async () => {
    const actual = {
      expenseTotal: '2.00',
      refundTotal: '0.00',
      netSpending: '2.00',
      expenseCount: '1',
      refundCount: '0',
    };
    const increase = {
      delta: '2.00',
      direction: 'INCREASE',
      percentChange: null,
      percentUnavailableReason: 'BASELINE_ZERO',
    };
    const merchant = {
      key: 'b'.repeat(64),
      label: 'Public grocer',
      current: actual,
      baseline: zero,
      change: increase,
    };
    fetchSummary.mockImplementation(async () => ({
      ...summary(),
      current: { ...actual, incomeTotal: '0.00' },
      change: increase,
      categoryDrivers: {
        increases: [{ ...merchant, key: 'GROCERIES' }],
        decreases: [],
        otherDelta: '0.00',
      },
      merchantDrivers: {
        increases: [merchant],
        decreases: [],
        otherDelta: '0.00',
      },
      budget: {
        totals: actual,
        overall: null,
        categories: [],
        untargeted: actual,
      },
    }));
    fetchComparison.mockImplementation(
      async (_id, _month, _baseline, _currency, dimension) => ({
        ...comparison(
          [
            dimension === 'MERCHANT'
              ? merchant
              : { ...merchant, key: 'GROCERIES' },
          ],
          null,
        ),
        dimension,
        current: { ...actual, incomeTotal: '0.00' },
        change: increase,
      }),
    );
    fetchSeries.mockImplementation(async () => series());
    fetchEvidence.mockImplementation(
      async (_id, month, _currency, dimension, key) => ({
        ...meta,
        period: period(month),
        dimension,
        groupKey: key,
        totals: month === '2026-09' ? actual : zero,
        items:
          month === '2026-09'
            ? [
                {
                  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3',
                  version: 0,
                  kind: 'EXPENSE',
                  occurredOn: '2026-09-12',
                  money: { amount: '-2.00', currency: 'USD' },
                  description: 'Public grocer',
                  category: 'GROCERIES',
                  refundOfTransactionId: null,
                },
              ]
            : [],
        nextCursor: null,
      }),
    );
    mount();
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Open Public description-group changes comparison, trend and both months' evidence for Public grocer/,
      }),
    );
    await screen.findByRole('heading', {
      name: 'Merchant / description groups · comparison',
    });
    expect(screen.getByLabelText('Breakdown')).toHaveValue('MERCHANT');
  });

  it('opens a summary driver in the matching A evidence and removes it after remote unshare refresh without applying draft month', async () => {
    const refund = {
      expenseTotal: '0.00',
      refundTotal: '2.00',
      netSpending: '-2.00',
      expenseCount: '0',
      refundCount: '1',
    };
    const delta = {
      delta: '-2.00',
      direction: 'DECREASE',
      percentChange: null,
      percentUnavailableReason: 'BASELINE_ZERO',
    };
    const driver = {
      key: 'GROCERIES',
      label: 'Shared groceries',
      current: refund,
      baseline: zero,
      change: delta,
    };
    let shared = true;
    fetchSummary.mockImplementation(async () =>
      shared
        ? {
            ...summary(),
            current: { ...refund, incomeTotal: '0.00' },
            change: delta,
            categoryDrivers: {
              increases: [],
              decreases: [driver],
              otherDelta: '0.00',
            },
            merchantDrivers: {
              increases: [],
              decreases: [],
              otherDelta: '-2.00',
            },
            budget: {
              totals: refund,
              overall: null,
              categories: [],
              untargeted: refund,
            },
          }
        : summary(),
    );
    fetchComparison.mockImplementation(async () => comparison([], null));
    fetchSeries.mockImplementation(async () => series());
    fetchEvidence.mockImplementation(async (_id, month) => ({
      ...meta,
      period: period(month),
      dimension: 'CATEGORY',
      groupKey: 'GROCERIES',
      totals: shared && month === '2026-09' ? refund : zero,
      items:
        shared && month === '2026-09'
          ? [
              {
                id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1',
                version: 1,
                kind: 'REFUND',
                occurredOn: '2026-09-12',
                money: { amount: '2.00', currency: 'USD' },
                description: 'Shared groceries refund',
                category: 'GROCERIES',
                refundOfTransactionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2',
              },
            ]
          : [],
      nextCursor: null,
    }));
    mount();
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Open Category changes comparison, trend and both months' evidence for Shared groceries/,
      }),
    );
    expect(
      await screen.findByText('Shared groceries refund'),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Month'), {
      target: { value: '2026-07' },
    });
    shared = false;
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh current records' }),
    );
    await waitFor(() => expect(fetchSummary).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.queryByText('Shared groceries refund'),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('button', { name: /Shared groceries/ }),
    ).not.toBeInTheDocument();
    expect(fetchSummary.mock.calls[1]?.[1]).toBe('2026-09');
    expect(screen.getByLabelText('Month')).toHaveValue('2026-07');
  });
});
