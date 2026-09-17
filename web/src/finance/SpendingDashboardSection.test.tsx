import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Household } from '../auth/client';
import { SpendingDashboardSection } from './SpendingDashboardSection';

const HOUSEHOLD: Household = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  name: 'Elm Street home',
  role: 'MEMBER',
  createdAt: '2026-09-13T01:30:00Z',
};

// Fixed clock: 2026-09-17T12:00Z, so the default month is September 2026 in
// zones west of the date line and wherever the host runs.
const FIXED_NOW = () => new Date('2026-09-17T12:00:00Z');

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

interface RouteHandlers {
  summaryGet?: (from: string, to: string) => Response | Promise<Response>;
}

function stubFetch(routes: RouteHandlers) {
  const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      const summaryBase = `/api/households/${HOUSEHOLD.id}/spending-summary`;
      if (url.startsWith(`${summaryBase}?`)) {
        const query = new URLSearchParams(url.slice(summaryBase.length + 1));
        const from = query.get('from') ?? '';
        const to = query.get('to') ?? '';
        if (!routes.summaryGet) throw new Error('unexpected GET summary');
        return routes.summaryGet(from, to);
      }
      throw new Error(`unexpected fetch ${url} ${init?.method ?? ''}`);
    }),
  );
  return calls;
}

function summaryResponse(
  from: string,
  to: string,
  zone: string,
  currencies: unknown[],
) {
  return jsonResponse({ from, to, reportingTimeZone: zone, currencies });
}

const MULTI_CURRENCY = () =>
  summaryResponse('2026-09-01', '2026-10-01', 'America/Sao_Paulo', [
    {
      currency: 'EUR',
      expenseTotal: '0.00',
      refundTotal: '0.00',
      netSpending: '0.00',
      incomeTotal: '0.00',
    },
    {
      currency: 'USD',
      expenseTotal: '100.00',
      refundTotal: '20.00',
      netSpending: '80.00',
      incomeTotal: '200.00',
    },
  ]);

const NEGATIVE_NET = () =>
  summaryResponse('2026-09-01', '2026-10-01', 'Etc/UTC', [
    {
      currency: 'USD',
      expenseTotal: '10.00',
      refundTotal: '25.00',
      netSpending: '-15.00',
      incomeTotal: '0.00',
    },
  ]);

function renderSection(
  routes: RouteHandlers,
  options: {
    reportingZone?: string;
    refreshSignal?: number;
    nowProvider?: () => Date;
  } = {},
) {
  const calls = stubFetch(routes);
  const onSessionExpired = vi.fn();
  const onHouseholdAccessChanged = vi.fn();
  const rendered = render(
    <StrictMode>
      <SpendingDashboardSection
        household={HOUSEHOLD}
        reportingZone={options.reportingZone ?? 'America/Sao_Paulo'}
        refreshSignal={options.refreshSignal ?? 0}
        onSessionExpired={onSessionExpired}
        onHouseholdAccessChanged={onHouseholdAccessChanged}
        nowProvider={options.nowProvider ?? FIXED_NOW}
      />
    </StrictMode>,
  );
  return { ...rendered, calls, onSessionExpired, onHouseholdAccessChanged };
}

const summaryUrls = (
  calls: Array<{ url: string; init?: RequestInit | undefined }>,
) => calls.map(({ url }) => url);

describe('spending dashboard section', () => {
  it('defaults to the current household-zone month with an injected clock', async () => {
    const { calls } = renderSection({
      summaryGet: (from, to) => summaryResponse(from, to, 'Etc/UTC', []),
    });
    await screen.findByTestId('spending-dashboard-section');
    await waitFor(() =>
      expect(
        summaryUrls(calls).some(
          (url) =>
            url ===
            `/api/households/${HOUSEHOLD.id}/spending-summary?from=2026-09-01&to=2026-10-01`,
        ),
      ).toBe(true),
    );
  });

  it('derives the default month from the zone, not the host zone', async () => {
    // 2026-09-30T23:30Z is October in Kiritimati (UTC+14): the default must
    // be October there even if the test host runs anywhere else.
    const { calls } = renderSection(
      {
        summaryGet: (from, to) => summaryResponse(from, to, 'Etc/UTC', []),
      },
      {
        reportingZone: 'Pacific/Kiritimati',
        nowProvider: () => new Date('2026-09-30T23:30:00Z'),
      },
    );
    await screen.findByTestId('spending-dashboard-section');
    await waitFor(() =>
      expect(
        summaryUrls(calls).some(
          (url) =>
            url ===
            `/api/households/${HOUSEHOLD.id}/spending-summary?from=2026-10-01&to=2026-11-01`,
        ),
      ).toBe(true),
    );
  });

  it('always shows the actual applied period and zone', async () => {
    renderSection({ summaryGet: () => MULTI_CURRENCY() });
    const section = await screen.findByTestId('spending-dashboard-section');
    expect(
      await within(section).findByText(
        'Showing 2026-09-01 to 2026-10-01 (end date excluded) in America/Sao_Paulo.',
      ),
    ).toBeInTheDocument();
  });

  it('renders ordered per-currency exact values with no grand total', async () => {
    renderSection({ summaryGet: () => MULTI_CURRENCY() });
    const section = await screen.findByTestId('spending-dashboard-section');
    await within(section).findByText('100.00 USD');
    const groups = within(section).getByRole('list', {
      name: 'Household spending by currency',
    });
    const items = within(groups).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Currency: EUR');
    expect(items[1]).toHaveTextContent('Currency: USD');
    expect(within(section).getByText('80.00 USD')).toBeInTheDocument();
    expect(within(section).getByText('200.00 USD')).toBeInTheDocument();
    // Transfer-only currency keeps its exact zeros with an honest note.
    expect(within(section).getAllByText('0.00 EUR')).toHaveLength(4);
    expect(
      within(section).getByText(
        'Only transfers in EUR — no spending or income.',
      ),
    ).toBeInTheDocument();
    // No invented all-currency total anywhere.
    expect(section.textContent).not.toMatch(/grand total/i);
    // Spending stays distinct from member obligations.
    expect(section.textContent).toMatch(/not member obligations/);
    expect(section.textContent).not.toMatch(/is owed|owes/);
  });

  it('states a valid negative net spending in words', async () => {
    renderSection({ summaryGet: () => NEGATIVE_NET() });
    const section = await screen.findByTestId('spending-dashboard-section');
    expect(await within(section).findByText('-15.00 USD')).toBeInTheDocument();
    expect(within(section).getByText('net refund')).toBeInTheDocument();
  });

  it('renders an honest empty state without inventing values', async () => {
    renderSection({
      summaryGet: (from, to) => summaryResponse(from, to, 'Etc/UTC', []),
    });
    const section = await screen.findByTestId('spending-dashboard-section');
    expect(
      await within(section).findByText(/No household spending in this period/),
    ).toBeInTheDocument();
    expect(
      section.textContent?.match(/-?\d+(\.\d+)?\s(BRL|USD|EUR|GBP|JPY|KWD)/),
    ).toBeNull();
  });

  it('applies an explicit period and rejects an unordered interval', async () => {
    const { calls } = renderSection({
      summaryGet: (from, to) => summaryResponse(from, to, 'Etc/UTC', []),
    });
    const section = await screen.findByTestId('spending-dashboard-section');
    await within(section).findByText(/Showing 2026-09-01/);
    const settled = calls.length;
    fireEvent.change(within(section).getByLabelText('From date'), {
      target: { value: '2026-08-01' },
    });
    fireEvent.change(within(section).getByLabelText('To date'), {
      target: { value: '2026-09-01' },
    });
    fireEvent.click(
      within(section).getByRole('button', { name: 'Show period' }),
    );
    await waitFor(() =>
      expect(
        summaryUrls(calls).some((url) =>
          url.endsWith('spending-summary?from=2026-08-01&to=2026-09-01'),
        ),
      ).toBe(true),
    );
    expect(
      await within(section).findByText(/Showing 2026-08-01 to 2026-09-01/),
    ).toBeInTheDocument();

    // An unordered interval never reaches the server.
    const beforeInvalid = calls.length;
    fireEvent.change(within(section).getByLabelText('From date'), {
      target: { value: '2026-09-01' },
    });
    fireEvent.click(
      within(section).getByRole('button', { name: 'Show period' }),
    );
    expect(
      await within(section).findByText(
        'The start date must be before the end date.',
      ),
    ).toBeInTheDocument();
    expect(calls.length).toBe(beforeInvalid);
    expect(settled).toBeGreaterThan(0);
  });

  it('resets an explicit period back to the zone-derived current month', async () => {
    const { calls } = renderSection({
      summaryGet: (from, to) => summaryResponse(from, to, 'Etc/UTC', []),
    });
    const section = await screen.findByTestId('spending-dashboard-section');
    await within(section).findByText(/Showing 2026-09-01/);
    fireEvent.change(within(section).getByLabelText('From date'), {
      target: { value: '2026-08-01' },
    });
    fireEvent.change(within(section).getByLabelText('To date'), {
      target: { value: '2026-09-01' },
    });
    fireEvent.click(
      within(section).getByRole('button', { name: 'Show period' }),
    );
    await within(section).findByText(/Showing 2026-08-01 to 2026-09-01/);
    fireEvent.click(
      within(section).getByRole('button', { name: 'Current month' }),
    );
    expect(
      await within(section).findByText(/Showing 2026-09-01 to 2026-10-01/),
    ).toBeInTheDocument();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('refetches the shown period when the parent signals a mutation', async () => {
    let summaryCalls = 0;
    stubFetch({
      summaryGet: (from, to) => {
        summaryCalls += 1;
        return summaryResponse(from, to, 'Etc/UTC', []);
      },
    });
    const rendered = render(
      <StrictMode>
        <SpendingDashboardSection
          household={HOUSEHOLD}
          reportingZone="Etc/UTC"
          refreshSignal={0}
          onSessionExpired={vi.fn()}
          onHouseholdAccessChanged={vi.fn()}
          nowProvider={FIXED_NOW}
        />
      </StrictMode>,
    );
    const section = await screen.findByTestId('spending-dashboard-section');
    await within(section).findByText(/Showing 2026-09-01/);
    const settled = summaryCalls;
    expect(settled).toBeGreaterThan(0);
    rendered.rerender(
      <StrictMode>
        <SpendingDashboardSection
          household={HOUSEHOLD}
          reportingZone="Etc/UTC"
          refreshSignal={1}
          onSessionExpired={vi.fn()}
          onHouseholdAccessChanged={vi.fn()}
          nowProvider={FIXED_NOW}
        />
      </StrictMode>,
    );
    await waitFor(() => expect(summaryCalls).toBeGreaterThan(settled));
  });

  it('keeps an explicit interval across zone changes without reinterpretation', async () => {
    const { calls, rerender } = renderSection(
      {
        summaryGet: (from, to) => summaryResponse(from, to, 'Etc/UTC', []),
      },
      { reportingZone: 'Etc/UTC' },
    );
    const section = await screen.findByTestId('spending-dashboard-section');
    await within(section).findByText(/Showing 2026-09-01/);
    fireEvent.change(within(section).getByLabelText('From date'), {
      target: { value: '2026-08-01' },
    });
    fireEvent.change(within(section).getByLabelText('To date'), {
      target: { value: '2026-09-01' },
    });
    fireEvent.click(
      within(section).getByRole('button', { name: 'Show period' }),
    );
    await within(section).findByText(/Showing 2026-08-01 to 2026-09-01/);
    const settled = calls.length;
    rerender(
      <StrictMode>
        <SpendingDashboardSection
          household={HOUSEHOLD}
          reportingZone="America/Sao_Paulo"
          refreshSignal={0}
          onSessionExpired={vi.fn()}
          onHouseholdAccessChanged={vi.fn()}
          nowProvider={FIXED_NOW}
        />
      </StrictMode>,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    // No refetch: the explicit interval's results do not depend on the zone.
    expect(calls.length).toBe(settled);
    expect(
      within(section).getByText(/Showing 2026-08-01 to 2026-09-01/),
    ).toBeInTheDocument();
  });

  it('recomputes the default month when the zone changes before customizing', async () => {
    const { rerender } = renderSection(
      {
        summaryGet: (from, to) => summaryResponse(from, to, 'Etc/UTC', []),
      },
      {
        reportingZone: 'Etc/UTC',
        nowProvider: () => new Date('2026-09-30T23:30:00Z'),
      },
    );
    const section = await screen.findByTestId('spending-dashboard-section');
    await within(section).findByText(/Showing 2026-09-01 to 2026-10-01/);
    rerender(
      <StrictMode>
        <SpendingDashboardSection
          household={HOUSEHOLD}
          reportingZone="Pacific/Kiritimati"
          refreshSignal={0}
          onSessionExpired={vi.fn()}
          onHouseholdAccessChanged={vi.fn()}
          nowProvider={() => new Date('2026-09-30T23:30:00Z')}
        />
      </StrictMode>,
    );
    expect(
      await within(section).findByText(/Showing 2026-10-01 to 2026-11-01/),
    ).toBeInTheDocument();
  });

  it('preserves last good amounts with a stale warning when a refresh fails', async () => {
    let failing = false;
    stubFetch({
      summaryGet: (from, to) => {
        if (failing) {
          return jsonResponse({ code: 'FINANCE_BUSY', message: 'Busy.' }, 503);
        }
        return summaryResponse(from, to, 'Etc/UTC', [
          {
            currency: 'USD',
            expenseTotal: '100.00',
            refundTotal: '20.00',
            netSpending: '80.00',
            incomeTotal: '200.00',
          },
        ]);
      },
    });
    const rendered = render(
      <StrictMode>
        <SpendingDashboardSection
          household={HOUSEHOLD}
          reportingZone="Etc/UTC"
          refreshSignal={0}
          onSessionExpired={vi.fn()}
          onHouseholdAccessChanged={vi.fn()}
          nowProvider={FIXED_NOW}
        />
      </StrictMode>,
    );
    const section = await screen.findByTestId('spending-dashboard-section');
    await within(section).findByText('80.00 USD');
    failing = true;
    rendered.rerender(
      <StrictMode>
        <SpendingDashboardSection
          household={HOUSEHOLD}
          reportingZone="Etc/UTC"
          refreshSignal={1}
          onSessionExpired={vi.fn()}
          onHouseholdAccessChanged={vi.fn()}
          nowProvider={FIXED_NOW}
        />
      </StrictMode>,
    );
    // A non-error notice uses role=status, never alert.
    const warningText = await within(section).findByText(
      /Could not refresh the spending summary. The amounts shown may be stale/,
    );
    expect(warningText.closest('[role]')?.getAttribute('role')).toBe('status');
    expect(
      within(section).getByRole('button', { name: 'Refresh summary' }),
    ).toBeInTheDocument();
    expect(within(section).getByText('80.00 USD')).toBeInTheDocument();
  });

  it('never submits an intermediate or invalid draft on refresh', async () => {
    const seen: string[] = [];
    stubFetch({
      summaryGet: (from, to) => {
        seen.push(`from=${from}&to=${to}`);
        return summaryResponse(from, to, 'Etc/UTC', []);
      },
    });
    const rendered = render(
      <StrictMode>
        <SpendingDashboardSection
          household={HOUSEHOLD}
          reportingZone="Etc/UTC"
          refreshSignal={0}
          onSessionExpired={vi.fn()}
          onHouseholdAccessChanged={vi.fn()}
          nowProvider={FIXED_NOW}
        />
      </StrictMode>,
    );
    const section = await screen.findByTestId('spending-dashboard-section');
    await within(section).findByText(/Showing 2026-09-01 to 2026-10-01/);
    // Type an intermediate draft without applying it.
    fireEvent.change(within(section).getByLabelText('From date'), {
      target: { value: '2026-08-01' },
    });
    const beforeRefresh = seen.length;
    rendered.rerender(
      <StrictMode>
        <SpendingDashboardSection
          household={HOUSEHOLD}
          reportingZone="Etc/UTC"
          refreshSignal={1}
          onSessionExpired={vi.fn()}
          onHouseholdAccessChanged={vi.fn()}
          nowProvider={FIXED_NOW}
        />
      </StrictMode>,
    );
    await waitFor(() => expect(seen.length).toBeGreaterThan(beforeRefresh));
    // The refresh resent the last applied interval, not the draft.
    expect(seen.slice(beforeRefresh)).toEqual([
      'from=2026-09-01&to=2026-10-01',
    ]);
    expect(
      within(section).getByText(/Showing 2026-09-01 to 2026-10-01/),
    ).toBeInTheDocument();

    // An invalid draft is equally never submitted: clearing the input and
    // refreshing resends the applied interval.
    fireEvent.change(within(section).getByLabelText('From date'), {
      target: { value: '' },
    });
    const beforeInvalid = seen.length;
    rendered.rerender(
      <StrictMode>
        <SpendingDashboardSection
          household={HOUSEHOLD}
          reportingZone="Etc/UTC"
          refreshSignal={2}
          onSessionExpired={vi.fn()}
          onHouseholdAccessChanged={vi.fn()}
          nowProvider={FIXED_NOW}
        />
      </StrictMode>,
    );
    await waitFor(() => expect(seen.length).toBeGreaterThan(beforeInvalid));
    expect(seen.slice(beforeInvalid)).toEqual([
      'from=2026-09-01&to=2026-10-01',
    ]);
  });

  it('falls back explicitly when the host cannot compute with the zone', async () => {
    renderSection(
      {
        summaryGet: (from, to) => summaryResponse(from, to, 'Mars/Olympus', []),
      },
      { reportingZone: 'Mars/Olympus' },
    );
    const section = await screen.findByTestId('spending-dashboard-section');
    // Monthly defaults use the explicit fallback for the fixed clock.
    expect(
      await within(section).findByText(/Showing 2026-09-01 to 2026-10-01/),
    ).toBeInTheDocument();
    const warning = await within(section).findByText(
      /not supported by this browser/,
    );
    expect(warning.closest('[role]')?.getAttribute('role')).toBe('status');
    // The server-echoed zone stays authoritative in the period line.
    expect(within(section).getByText(/in Mars\/Olympus\./)).toBeInTheDocument();
  });

  it('reconciles session expiry and lost access by clearing scoped state', async () => {
    const expired = renderSection({
      summaryGet: () =>
        jsonResponse(
          { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
          401,
        ),
    });
    await waitFor(() =>
      expect(expired.onSessionExpired).toHaveBeenCalledTimes(1),
    );

    const removed = renderSection({
      summaryGet: () =>
        jsonResponse(
          { code: 'HOUSEHOLD_NOT_FOUND', message: 'Household is unavailable.' },
          404,
        ),
    });
    await waitFor(() =>
      expect(removed.onHouseholdAccessChanged).toHaveBeenCalledTimes(1),
    );
    expect(screen.queryByText('80.00 USD')).toBeNull();
  });

  it('recovers from a timed-out load with a refresh action', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_input: string | URL | Request, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('Aborted.', 'AbortError'));
              });
            }),
        ),
      );
      render(
        <SpendingDashboardSection
          household={HOUSEHOLD}
          reportingZone="Etc/UTC"
          refreshSignal={0}
          onSessionExpired={vi.fn()}
          onHouseholdAccessChanged={vi.fn()}
          nowProvider={FIXED_NOW}
        />,
      );
      await act(() => vi.advanceTimersByTimeAsync(11_000));
      const section = screen.getByTestId('spending-dashboard-section');
      // Genuine errors keep role=alert; only non-errors use status.
      const notice = within(section).getByRole('alert');
      expect(notice).toHaveTextContent(
        'Loading the spending summary timed out. Refresh to try again.',
      );
      expect(
        within(section).getByRole('button', { name: 'Refresh summary' }),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
