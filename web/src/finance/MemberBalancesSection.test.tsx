import { act, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Household } from '../auth/client';
import { MemberBalancesSection } from './MemberBalancesSection';

const HOUSEHOLD: Household = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  name: 'Elm Street home',
  role: 'MEMBER',
  createdAt: '2026-09-13T01:30:00Z',
};
const PAYER_ID = '30000000-0000-4000-8000-000000000001';
const PARTICIPANT_B = '30000000-0000-4000-8000-000000000002';
const PARTICIPANT_C = '30000000-0000-4000-8000-000000000003';

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

interface RouteHandlers {
  balancesGet?: () => Response | Promise<Response>;
}

function stubFetch(routes: RouteHandlers) {
  const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      const balancesUrl = `/api/households/${HOUSEHOLD.id}/member-balances`;
      if (url === balancesUrl) {
        if (!routes.balancesGet) throw new Error('unexpected GET balances');
        return routes.balancesGet();
      }
      throw new Error(`unexpected fetch ${url} ${init?.method ?? ''}`);
    }),
  );
  return calls;
}

function renderSection(routes: RouteHandlers = {}) {
  const calls = stubFetch(routes);
  const onSessionExpired = vi.fn();
  const onHouseholdAccessChanged = vi.fn();
  const rendered = render(
    <StrictMode>
      <MemberBalancesSection
        household={HOUSEHOLD}
        currentUserId={PAYER_ID}
        refreshSignal={0}
        onSessionExpired={onSessionExpired}
        onHouseholdAccessChanged={onHouseholdAccessChanged}
      />
    </StrictMode>,
  );
  return { ...rendered, calls, onSessionExpired, onHouseholdAccessChanged };
}

const balancesCalls = (
  calls: Array<{ url: string; init?: RequestInit | undefined }>,
) => calls.filter(({ url }) => url.endsWith('/member-balances'));

const NO_REFUND_BALANCES = () =>
  jsonResponse({
    currencies: [
      {
        currency: 'JPY',
        balances: [
          {
            userId: PAYER_ID,
            membershipStatus: 'CURRENT',
            amount: '1000',
          },
        ],
      },
      {
        currency: 'USD',
        balances: [
          {
            userId: PAYER_ID,
            membershipStatus: 'CURRENT',
            amount: '6.66',
          },
          {
            userId: PARTICIPANT_B,
            membershipStatus: 'CURRENT',
            amount: '-3.33',
          },
          {
            userId: PARTICIPANT_C,
            membershipStatus: 'DEPARTED',
            amount: '-3.33',
          },
        ],
      },
    ],
  });

describe('member balances section', () => {
  it('labels the section region with its heading', async () => {
    renderSection({ balancesGet: NO_REFUND_BALANCES });
    const region = screen.getByRole('region', { name: 'Member balances' });
    expect(region).toHaveAttribute(
      'aria-labelledby',
      `member-balances-title-${HOUSEHOLD.id}`,
    );
    expect(await within(region).findByText('6.66 USD')).toBeInTheDocument();
  });

  it('groups balances per currency with exact amounts and owed/owes text', async () => {
    const { calls } = renderSection({ balancesGet: NO_REFUND_BALANCES });
    const section = await screen.findByTestId('member-balances-section');
    expect(await within(section).findByText('6.66 USD')).toBeInTheDocument();
    // Direction is stated in words, never color alone.
    expect(within(section).getAllByText('is owed')).toHaveLength(2);
    expect(within(section).getAllByText('owes')).toHaveLength(2);
    // Exact negative amounts, not rounded or re-signed displays.
    expect(within(section).getAllByText('-3.33 USD')).toHaveLength(2);
    // Scale-0 currency without a decimal point.
    expect(within(section).getByText('1000 JPY')).toBeInTheDocument();
    // The fetch went to the documented route.
    expect(
      balancesCalls(calls).some(
        ({ url }) => url === `/api/households/${HOUSEHOLD.id}/member-balances`,
      ),
    ).toBe(true);
  });

  it('labels CURRENT and DEPARTED members with stable UUID identity only', async () => {
    renderSection({ balancesGet: NO_REFUND_BALANCES });
    const section = await screen.findByTestId('member-balances-section');
    await within(section).findByText('6.66 USD');
    expect(within(section).getAllByText('Current member')).toHaveLength(3);
    expect(within(section).getByText('Departed member')).toBeInTheDocument();
    // The departed participant keeps their recorded UUID.
    expect(section.textContent).toContain(PARTICIPANT_C);
    // No email or profile data is shown for any member.
    expect(section.textContent).not.toMatch(/@/);
    // The signed-in actor's row is marked as self.
    const ownRow = within(section)
      .getAllByText(/You/)
      .find((node) => node.textContent?.includes(PAYER_ID));
    expect(ownRow).toBeTruthy();
  });

  it('renders the empty authorized state without inventing values', async () => {
    renderSection({ balancesGet: () => jsonResponse({ currencies: [] }) });
    const section = await screen.findByTestId('member-balances-section');
    expect(await within(section).findByRole('status')).toBeInTheDocument();
    expect(within(section).queryByRole('list')).not.toBeInTheDocument();
    expect(
      section.textContent?.match(/-?\d+(\.\d+)?\s(BRL|USD|EUR|GBP|JPY|KWD)/),
    ).toBeNull();
  });

  it('refreshes balances when the parent bump drives a new signal', async () => {
    let balanceResponses = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        const balancesUrl = `/api/households/${HOUSEHOLD.id}/member-balances`;
        if (url === balancesUrl) {
          balanceResponses += 1;
          return jsonResponse({ currencies: [] });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const rendered = render(
      <StrictMode>
        <MemberBalancesSection
          household={HOUSEHOLD}
          currentUserId={PAYER_ID}
          refreshSignal={0}
          onSessionExpired={vi.fn()}
          onHouseholdAccessChanged={vi.fn()}
        />
      </StrictMode>,
    );
    await screen.findByTestId('member-balances-section');
    await waitFor(() => expect(balanceResponses).toBeGreaterThan(0));
    const settled = balanceResponses;
    rendered.rerender(
      <StrictMode>
        <MemberBalancesSection
          household={HOUSEHOLD}
          currentUserId={PAYER_ID}
          refreshSignal={1}
          onSessionExpired={vi.fn()}
          onHouseholdAccessChanged={vi.fn()}
        />
      </StrictMode>,
    );
    await waitFor(() => expect(balanceResponses).toBeGreaterThan(settled));
  });

  it('keeps last good balances visible with a stale warning when a refresh fails', async () => {
    let failing = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        const balancesUrl = `/api/households/${HOUSEHOLD.id}/member-balances`;
        if (url === balancesUrl) {
          if (failing) {
            return jsonResponse(
              { code: 'FINANCE_BUSY', message: 'Busy.' },
              503,
            );
          }
          return NO_REFUND_BALANCES();
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const rendered = render(
      <StrictMode>
        <MemberBalancesSection
          household={HOUSEHOLD}
          currentUserId={PAYER_ID}
          refreshSignal={0}
          onSessionExpired={vi.fn()}
          onHouseholdAccessChanged={vi.fn()}
        />
      </StrictMode>,
    );
    const section = await screen.findByTestId('member-balances-section');
    await within(section).findByText('6.66 USD');
    // A mutation bump drives a refresh that now fails.
    failing = true;
    rendered.rerender(
      <StrictMode>
        <MemberBalancesSection
          household={HOUSEHOLD}
          currentUserId={PAYER_ID}
          refreshSignal={1}
          onSessionExpired={vi.fn()}
          onHouseholdAccessChanged={vi.fn()}
        />
      </StrictMode>,
    );
    const notice = await within(section).findByRole('alert');
    expect(notice).toHaveTextContent(
      /Could not refresh member balances. The amounts shown may be stale/,
    );
    expect(
      within(notice).getByRole('button', { name: 'Refresh balances' }),
    ).toBeInTheDocument();
    // The last good amounts stay presented, marked as potentially stale.
    expect(within(section).getByText('6.66 USD')).toBeInTheDocument();
    expect(within(section).getByText('1000 JPY')).toBeInTheDocument();
  });

  it('reconciles a 401 balances fetch with the session recovery', async () => {
    const { onSessionExpired } = renderSection({
      balancesGet: () =>
        jsonResponse(
          { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
          401,
        ),
    });
    await waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
    // Derived household data about other people is dropped.
    expect(screen.queryByText(/is owed/)).toBeNull();
  });

  it('reconciles lost household access on the balances 404', async () => {
    const { onHouseholdAccessChanged } = renderSection({
      balancesGet: () =>
        jsonResponse(
          {
            code: 'HOUSEHOLD_NOT_FOUND',
            message: 'Household is unavailable.',
          },
          404,
        ),
    });
    await waitFor(() =>
      expect(onHouseholdAccessChanged).toHaveBeenCalledTimes(1),
    );
    expect(screen.queryByText(/is owed/)).toBeNull();
  });

  it('surfaces lock contention with an explicit refresh action', async () => {
    renderSection({
      balancesGet: () => jsonResponse({ code: 'FINANCE_BUSY' }, 503),
    });
    const section = await screen.findByTestId('member-balances-section');
    const notice = await within(section).findByRole('alert');
    expect(notice).toHaveTextContent(
      /Could not load household member balances/,
    );
    expect(
      within(notice).getByRole('button', { name: 'Refresh balances' }),
    ).toBeInTheDocument();
  });

  it('recovers from a timed-out balances load with a refresh notice', async () => {
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
        <MemberBalancesSection
          household={HOUSEHOLD}
          currentUserId={PAYER_ID}
          refreshSignal={0}
          onSessionExpired={vi.fn()}
          onHouseholdAccessChanged={vi.fn()}
        />,
      );
      // The bounded client wait fires the timeout error.
      await act(() => vi.advanceTimersByTimeAsync(11_000));
      const section = screen.getByTestId('member-balances-section');
      expect(
        within(section).getByText(
          'Loading balances timed out. Refresh to try again.',
        ),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
