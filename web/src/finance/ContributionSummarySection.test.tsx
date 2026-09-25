import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Household } from '../auth/client';
import { ContributionSummarySection } from './ContributionSummarySection';

const household: Household = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  name: 'Home',
  role: 'MEMBER',
  createdAt: '2026-09-01T00:00:00Z',
};
const person = '11111111-2222-4333-8444-555555555555';
const snapshot = 'a'.repeat(64);
const item = {
  userId: person,
  membershipStatus: 'DEPARTED',
  expensePaid: '0.00',
  refundReceived: '1.00',
  netPaid: '-1.00',
  allocatedCost: '-0.70',
};
function body(overrides: Record<string, unknown> = {}) {
  return {
    from: '2026-09-01',
    to: '2026-10-01',
    reportingTimeZone: 'Etc/UTC',
    currency: 'USD',
    snapshot,
    totals: {
      expenseTotal: '0.00',
      refundTotal: '1.00',
      netSpending: '-1.00',
      allocatedCostTotal: '-0.70',
      unallocatedNet: '-0.30',
    },
    items: [item],
    limit: 50,
    offset: 0,
    hasMore: false,
    ...overrides,
  };
}
function renderView(handler: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | Request | URL) => handler(String(input))),
  );
  const onSessionExpired = vi.fn();
  const onHouseholdAccessChanged = vi.fn();
  const props = {
    household,
    reportingZone: 'Etc/UTC',
    refreshSignal: 0,
    membershipRefreshSignal: 0,
    onSessionExpired,
    onHouseholdAccessChanged,
    nowProvider: () => new Date('2026-09-17T12:00:00Z'),
  };
  const view = render(<ContributionSummarySection {...props} />);
  return { ...view, props, onSessionExpired, onHouseholdAccessChanged };
}

describe('period contributions', () => {
  it('renders signed refund-only amounts and assigned versus unallocated cost without repayment columns', async () => {
    renderView(() => Response.json(body()));
    expect(await screen.findByText('Departed member')).toBeInTheDocument();
    expect(screen.getAllByText('-0.70 USD')).toHaveLength(2);
    expect(screen.getByText('-0.30 USD')).toBeInTheDocument();
    expect(
      screen.getByText(/not all-time member balances or repayment activity/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('columnheader', {
        name: /repayment|account|category/i,
      }),
    ).not.toBeInTheDocument();
  });

  it('keeps the previous amount explicitly stale and preserves an unfinished date draft on an unknown refresh error', async () => {
    let fail = false;
    const fetcher = vi.fn(() =>
      fail
        ? Response.json(
            { code: 'FINANCE_BUSY', message: 'Busy' },
            { status: 503 },
          )
        : Response.json(body()),
    );
    const { rerender, props } = renderView(fetcher);
    await screen.findByText('Departed member');
    fireEvent.change(screen.getByLabelText('Contribution from date'), {
      target: { value: '2026-08-01' },
    });
    fail = true;
    rerender(<ContributionSummarySection {...props} refreshSignal={1} />);
    expect(
      await screen.findByText(/amounts shown may be stale/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Contribution from date')).toHaveValue(
      '2026-08-01',
    );
    expect(screen.getByText('Departed member')).toBeInTheDocument();
  });

  it('clears pages on stale continuation and offers explicit restart', async () => {
    let requests = 0;
    renderView(() => {
      requests++;
      if (requests === 1)
        return Response.json(
          body({
            items: Array.from({ length: 50 }, (_, index) => ({
              ...item,
              userId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
            })),
            hasMore: true,
          }),
        );
      return Response.json(
        { code: 'CONTRIBUTION_SNAPSHOT_STALE', message: 'Changed' },
        { status: 409 },
      );
    });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load more contributors' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Restart contributions' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(
      screen.getByText(/previous pages were cleared/i),
    ).toBeInTheDocument();
  });

  it('discards late responses after membership refresh and clears scoped data on confirmed access loss', async () => {
    let resolveFirst!: (value: Response) => void;
    let calls = 0;
    const { rerender, props, onHouseholdAccessChanged } = renderView(() => {
      calls++;
      if (calls === 1)
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      if (calls === 2)
        return Response.json(
          body({
            items: [],
            totals: {
              expenseTotal: '0.00',
              refundTotal: '0.00',
              netSpending: '0.00',
              allocatedCostTotal: '0.00',
              unallocatedNet: '0.00',
            },
          }),
        );
      return Response.json(
        { code: 'HOUSEHOLD_NOT_FOUND', message: 'Unavailable' },
        { status: 404 },
      );
    });
    // The first read must already be in flight before the membership signal
    // supersedes it; mounting schedules that read in a microtask.
    await waitFor(() => expect(resolveFirst).toBeDefined());
    rerender(
      <ContributionSummarySection {...props} membershipRefreshSignal={1} />,
    );
    expect(
      await screen.findByText(/No contributions in USD/),
    ).toBeInTheDocument();
    resolveFirst(Response.json(body()));
    await waitFor(() =>
      expect(screen.queryByText('Departed member')).not.toBeInTheDocument(),
    );
    rerender(
      <ContributionSummarySection {...props} membershipRefreshSignal={2} />,
    );
    await waitFor(() =>
      expect(onHouseholdAccessChanged).toHaveBeenCalledOnce(),
    );
    expect(
      screen.queryByText(/No contributions in USD/),
    ).not.toBeInTheDocument();
  });
});
