import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Household } from '../auth/client';
import { RepaymentsSection } from './RepaymentsSection';
import { SettlementSuggestionsSection } from './SettlementSuggestionsSection';
const H: Household = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  name: 'House',
  role: 'OWNER',
  createdAt: '2026-09-25T01:00:00Z',
};
const S = '11111111-1111-4111-8111-111111111111',
  R = '22222222-2222-4222-8222-222222222222',
  ID = '33333333-3333-4333-8333-333333333333';
const money = { amount: '3.00', currency: 'USD' };
const base = {
  id: ID,
  householdId: H.id,
  senderUserId: S,
  recipientUserId: R,
  money,
  occurredOn: '2026-09-25',
  status: 'PENDING',
  version: 0,
  createdAt: '2026-09-25T10:00:00Z',
  updatedAt: '2026-09-25T10:00:00Z',
  confirmedAt: null,
  voidedAt: null,
  pendingAmendment: null,
  allowedActions: ['CONFIRM', 'REJECT'],
};
const event = {
  version: 0,
  eventType: 'CREATED',
  actorUserId: S,
  recordedAt: base.createdAt,
  status: 'PENDING',
  money,
  occurredOn: base.occurredOn,
  pendingAmendment: null,
};
const page = (items: unknown[]) => ({
  items,
  limit: 50,
  offset: 0,
  hasMore: false,
});
const json = (value: unknown, status = 200) => Response.json(value, { status });
const props = {
  household: H,
  currentUserId: R,
  csrf: { token: 'token', headerName: 'X-CSRF-TOKEN' },
  onCsrfRefreshed: vi.fn(),
  onSessionExpired: vi.fn(),
  onHouseholdAccessChanged: vi.fn(),
  authorityConfirmed: true,
  reportingZone: 'Etc/UTC',
  refreshSignal: 0,
  onBalancesChanged: vi.fn(),
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe('external repayment activity', () => {
  it('keeps the same creation key after uncertain network outcome and never submits edited draft', async () => {
    let creates = 0;
    const sent: { key: string | null; body: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit) => {
        if (input.endsWith('/members'))
          return json({
            members: [
              {
                userId: S,
                email: 'sender@example.com',
                role: 'MEMBER',
                joinedAt: base.createdAt,
              },
              {
                userId: R,
                email: 'recipient@example.com',
                role: 'MEMBER',
                joinedAt: base.createdAt,
              },
            ],
          });
        if (input.includes('/repayments?')) return json(page([]));
        if (input.endsWith('/repayments') && init.method === 'POST') {
          sent.push({
            key: new Headers(init.headers).get('Idempotency-Key'),
            body: String(init.body),
          });
          if (creates++ === 0) throw new TypeError('offline');
          return json(
            {
              ...base,
              senderUserId: R,
              recipientUserId: S,
              allowedActions: ['CANCEL'],
            },
            200,
          );
        }
        if (input.endsWith(`/${ID}`))
          return json({
            ...base,
            senderUserId: R,
            recipientUserId: S,
            allowedActions: ['CANCEL'],
          });
        if (input.includes('/events')) return json(page([event]));
        throw new Error(`unexpected ${input}`);
      }),
    );
    render(<RepaymentsSection {...props} />);
    fireEvent.change(
      await screen.findByLabelText('Recipient (current household member)'),
      { target: { value: S } },
    );
    fireEvent.change(screen.getByLabelText('Positive exact amount'), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByLabelText('Date payment was completed'), {
      target: { value: '2026-09-25' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Record assertion/ }));
    expect(
      await screen.findByText(/creation outcome may be unknown/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Positive exact amount')).toBeDisabled();
    fireEvent.click(
      screen.getByRole('button', { name: /Retry same assertion key/ }),
    );
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0]).toEqual(sent[1]);
    expect(props.onBalancesChanged).toHaveBeenCalledTimes(1);
  });
  it('refetches a versioned decision after a conflict and requires explicit review before any new choice', async () => {
    let reads = 0;
    let posts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit) => {
        if (input.endsWith('/members'))
          return json({
            members: [
              {
                userId: S,
                email: 'sender@example.com',
                role: 'MEMBER',
                joinedAt: base.createdAt,
              },
              {
                userId: R,
                email: 'recipient@example.com',
                role: 'MEMBER',
                joinedAt: base.createdAt,
              },
            ],
          });
        if (input.includes('/repayments?')) return json(page([base]));
        if (input.endsWith(`/${ID}`))
          return json({ ...base, version: reads++ ? 1 : 0 });
        if (input.includes('/events')) return json(page([event]));
        if (input.endsWith('/decision')) {
          posts++;
          return json(
            { code: 'RESOURCE_VERSION_CONFLICT', message: 'Stale version' },
            409,
          );
        }
        throw new Error(`unexpected ${input} ${init?.method}`);
      }),
    );
    render(<RepaymentsSection {...props} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Review party-only record' }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Confirm payment received' }),
    );
    expect(
      await screen.findByText(/Fetch current details and review them/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Confirm payment received' }),
    ).toBeDisabled();
    expect(posts).toBe(1);
    await waitFor(() =>
      expect(screen.getByText(/Party record · version 1/)).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'I reviewed the current record' }),
    );
    expect(
      screen.getByRole('button', { name: 'Confirm payment received' }),
    ).toBeEnabled();
  });
  it('keeps the accepted amount visible during an amendment and requires the other party to confirm', async () => {
    const accepted = {
      ...base,
      status: 'CONFIRMED',
      version: 1,
      confirmedAt: base.createdAt,
      allowedActions: ['PROPOSE_REPLACEMENT', 'PROPOSE_VOID'],
    };
    const pending = {
      action: 'REPLACE',
      proposedByUserId: R,
      money: { amount: '4.00', currency: 'USD' },
      occurredOn: '2026-09-25',
      createdAt: base.createdAt,
    };
    let resource: Record<string, unknown> = accepted;
    const writes: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit) => {
        if (input.endsWith('/members'))
          return json({
            members: [
              {
                userId: S,
                email: 'sender@example.com',
                role: 'MEMBER',
                joinedAt: base.createdAt,
              },
              {
                userId: R,
                email: 'recipient@example.com',
                role: 'MEMBER',
                joinedAt: base.createdAt,
              },
            ],
          });
        if (input.includes('/repayments?')) return json(page([resource]));
        if (input.endsWith(`/${ID}`)) return json(resource);
        if (input.endsWith('/events')) return json(page([event]));
        if (input.endsWith('/amendment') && init.method === 'POST') {
          writes.push(JSON.parse(String(init.body)));
          resource = {
            ...accepted,
            version: 2,
            pendingAmendment: pending,
            allowedActions: ['CANCEL_AMENDMENT'],
          };
          return json(resource);
        }
        throw new Error(`unexpected ${input}`);
      }),
    );
    render(<RepaymentsSection {...props} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Review party-only record' }),
    );
    fireEvent.change(
      await screen.findByLabelText('Corrected positive amount'),
      { target: { value: '4' } },
    );
    fireEvent.change(screen.getByLabelText('Date completed'), {
      target: { value: '2026-09-25' },
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: /Propose replacement for other party/,
      }),
    );
    expect(
      await screen.findByText(/The current accepted amount stays effective/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Accepted\/asserted amount 3.00 USD/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: 'Confirm correction (changes household balances)',
      }),
    ).not.toBeInTheDocument();
    expect(writes).toEqual([
      {
        expectedVersion: 1,
        action: 'REPLACE',
        money: { amount: '4.00', currency: 'USD' },
        occurredOn: '2026-09-25',
      },
    ]);
  });
  it('clears party activity on lost household access even if an older list arrives late', async () => {
    let resolveList!: (response: Response) => void;
    const list = new Promise<Response>((resolve) => {
      resolveList = resolve;
    });
    const accessChanged = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.endsWith('/members'))
          return json(
            { code: 'HOUSEHOLD_NOT_FOUND', message: 'Not available' },
            404,
          );
        if (input.includes('/repayments?')) return list;
        throw new Error(`unexpected ${input}`);
      }),
    );
    render(
      <RepaymentsSection {...props} onHouseholdAccessChanged={accessChanged} />,
    );
    await waitFor(() => expect(accessChanged).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolveList(json(page([base])));
    });
    expect(
      screen.queryByRole('button', { name: 'Review party-only record' }),
    ).not.toBeInTheDocument();
  });
  it('latches two same-tick creation submissions to one request', async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const posts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit) => {
        if (input.endsWith('/members'))
          return json({
            members: [
              {
                userId: S,
                email: 'sender@example.com',
                role: 'MEMBER',
                joinedAt: base.createdAt,
              },
              {
                userId: R,
                email: 'recipient@example.com',
                role: 'MEMBER',
                joinedAt: base.createdAt,
              },
            ],
          });
        if (input.includes('/repayments?')) return json(page([]));
        if (input.endsWith('/repayments') && init.method === 'POST') {
          posts.push(new Headers(init.headers).get('Idempotency-Key') ?? '');
          return pending;
        }
        if (input.endsWith(`/${ID}`)) return json(base);
        if (input.includes('/events')) return json(page([event]));
        throw new Error(`unexpected ${input}`);
      }),
    );
    render(<RepaymentsSection {...props} currentUserId={S} />);
    await screen.findByRole('option', { name: /recipient@example.com/ });
    fireEvent.change(
      screen.getByLabelText('Recipient (current household member)'),
      { target: { value: R } },
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText('Recipient (current household member)'),
      ).toHaveValue(R),
    );
    fireEvent.change(screen.getByLabelText('Positive exact amount'), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByLabelText('Date payment was completed'), {
      target: { value: '2026-09-25' },
    });
    const form = screen
      .getByRole('button', { name: /Record assertion/ })
      .closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(posts).toHaveLength(1));
    await act(async () => release(json(base, 201)));
    expect(
      await screen.findByText(/Assertion recorded for recipient review/),
    ).toBeInTheDocument();
  });
  it('refreshes derived money once after an uncertain POST reveals confirmed detail', async () => {
    let detailReads = 0;
    let decisions = 0;
    const changed = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.endsWith('/members')) return json({ members: [] });
        if (input.includes('/repayments?')) return json(page([base]));
        if (input.endsWith(`/${ID}`))
          return json(
            detailReads++
              ? {
                  ...base,
                  status: 'CONFIRMED',
                  version: 1,
                  confirmedAt: base.createdAt,
                  allowedActions: ['PROPOSE_VOID'],
                }
              : base,
          );
        if (input.includes('/events')) return json(page([event]));
        if (input.endsWith('/decision')) {
          decisions++;
          throw new TypeError('response lost');
        }
        throw new Error(`unexpected ${input}`);
      }),
    );
    render(<RepaymentsSection {...props} onBalancesChanged={changed} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Review party-only record' }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Confirm payment received' }),
    );
    await waitFor(() =>
      expect(screen.getByText(/Party record · version 1/)).toBeInTheDocument(),
    );
    expect(changed).toHaveBeenCalledTimes(1);
    expect(decisions).toBe(1);
    expect(
      screen.getByRole('button', { name: 'I reviewed the current record' }),
    ).toBeEnabled();
  });
  it('discards an old event page and a late uncertain review when another detail opens', async () => {
    const B = '44444444-4444-4444-8444-444444444444';
    const other = {
      ...base,
      id: B,
      money: { amount: '8.00', currency: 'USD' },
    };
    let finishEvents!: (response: Response) => void;
    let finishReview!: (response: Response) => void;
    const oldEvents = new Promise<Response>((resolve) => {
      finishEvents = resolve;
    });
    const oldReview = new Promise<Response>((resolve) => {
      finishReview = resolve;
    });
    let finishOtherEvents!: (response: Response) => void;
    const laterOtherEvents = new Promise<Response>((resolve) => {
      finishOtherEvents = resolve;
    });
    let otherEventReads = 0;
    let aReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.endsWith('/members')) return json({ members: [] });
        if (input.includes('/repayments?')) return json(page([base, other]));
        if (input.endsWith(`/${ID}`)) return aReads++ ? oldReview : json(base);
        if (input.endsWith(`/${B}`)) return json(other);
        if (input.includes(`/${ID}/events?`))
          return input.includes('offset=50')
            ? oldEvents
            : json({ ...page([event]), hasMore: true });
        if (input.includes(`/${B}/events?`))
          return ++otherEventReads === 2
            ? laterOtherEvents
            : json(page([{ ...event, money: other.money }]));
        if (input.endsWith('/decision')) throw new TypeError('lost');
        throw new Error(`unexpected ${input}`);
      }),
    );
    render(<RepaymentsSection {...props} />);
    const buttons = await screen.findAllByRole('button', {
      name: 'Review party-only record',
    });
    fireEvent.click(buttons[0]!);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load older events' }),
    );
    fireEvent.click(buttons[1]!);
    await screen.findByText(/Accepted\/asserted amount 8.00 USD/);
    await act(async () => {
      finishEvents(
        json(
          page([
            {
              ...event,
              version: 7,
              money: { amount: '99.00', currency: 'USD' },
            },
          ]),
        ),
      );
    });
    expect(screen.queryByText(/99.00 USD/)).not.toBeInTheDocument();
    fireEvent.click(buttons[0]!);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Confirm payment received' }),
    );
    fireEvent.click(buttons[1]!);
    await screen.findByText(/Accepted\/asserted amount 8.00 USD/);
    await act(async () => {
      finishReview(
        json({
          ...base,
          status: 'CONFIRMED',
          version: 1,
          confirmedAt: base.createdAt,
          allowedActions: ['PROPOSE_VOID'],
        }),
      );
    });
    expect(
      screen.getByText(/Accepted\/asserted amount 8.00 USD/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'I reviewed the current record' }),
    ).toBeDisabled();
    await act(async () => {
      finishOtherEvents(json(page([{ ...event, money: other.money }])));
    });
    expect(
      screen.getByRole('button', { name: 'I reviewed the current record' }),
    ).toBeEnabled();
  });
  it('restores keyboard focus to the filter when its detail trigger was removed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.endsWith('/members')) return json({ members: [] });
        if (input.includes('/repayments?'))
          return json(page(input.includes('status=CONFIRMED') ? [] : [base]));
        if (input.endsWith(`/${ID}`)) return json(base);
        if (input.includes('/events')) return json(page([event]));
        throw new Error(`unexpected ${input}`);
      }),
    );
    render(<RepaymentsSection {...props} />);
    const trigger = await screen.findByRole('button', {
      name: 'Review party-only record',
    });
    fireEvent.click(trigger);
    await screen.findByText(/Party record · version 0/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Close private detail' }),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
    fireEvent.click(trigger);
    await screen.findByText(/Party record · version 0/);
    fireEvent.change(screen.getByLabelText('Status'), {
      target: { value: 'CONFIRMED' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Review party-only record' }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Close private detail' }),
    );
    await waitFor(() => expect(screen.getByLabelText('Status')).toHaveFocus());
  });
  it('invalidates derived money on an external confirmation found by filtered list refresh', async () => {
    let remote = false;
    const changed = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.endsWith('/members')) return json({ members: [] });
        if (input.includes('/repayments?'))
          return json(
            page(
              input.includes('status=PENDING') && remote
                ? []
                : [
                    {
                      ...base,
                      ...(remote
                        ? {
                            status: 'CONFIRMED',
                            version: 1,
                            confirmedAt: base.createdAt,
                            allowedActions: ['PROPOSE_VOID'],
                          }
                        : {}),
                    },
                  ],
            ),
          );
        throw new Error(`unexpected ${input}`);
      }),
    );
    render(<RepaymentsSection {...props} onBalancesChanged={changed} />);
    await screen.findByText(/You received 3.00 USD/);
    expect(changed).not.toHaveBeenCalled();
    remote = true;
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await screen.findByText(/You received 3.00 USD.*CONFIRMED/);
    expect(changed).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Status'), {
      target: { value: 'PENDING' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await screen.findByText(/No party-only repayments match these filters/);
    expect(changed).toHaveBeenCalledTimes(2);
  });
  it('refreshes derived money after a failed local list read and a later filtered external change', async () => {
    const local = {
      ...base,
      id: '44444444-4444-4444-8444-444444444444',
      senderUserId: R,
      recipientUserId: S,
      allowedActions: ['CANCEL'],
    };
    const changed = vi.fn();
    let listReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit) => {
        if (input.endsWith('/members'))
          return json({
            members: [
              {
                userId: S,
                email: 'sender@example.com',
                role: 'MEMBER',
                joinedAt: base.createdAt,
              },
              {
                userId: R,
                email: 'recipient@example.com',
                role: 'MEMBER',
                joinedAt: base.createdAt,
              },
            ],
          });
        if (input.includes('/repayments?')) {
          listReads++;
          return listReads === 2
            ? json({ code: 'NETWORK_ERROR', message: 'Unavailable' }, 503)
            : json(page(listReads === 1 ? [base] : [local]));
        }
        if (input.endsWith('/repayments') && init.method === 'POST')
          return json(local, 201);
        if (input.includes(`/${local.id}/events?`)) return json(page([event]));
        if (input.endsWith(`/${local.id}`)) return json(local);
        throw new Error(`unexpected ${input}`);
      }),
    );
    render(<RepaymentsSection {...props} onBalancesChanged={changed} />);
    await screen.findByText(/You received 3.00 USD/);
    fireEvent.change(
      screen.getByLabelText('Recipient (current household member)'),
      {
        target: { value: S },
      },
    );
    fireEvent.change(screen.getByLabelText('Positive exact amount'), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByLabelText('Date payment was completed'), {
      target: { value: '2026-09-25' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Record assertion/ }));
    await screen.findByText(/Could not refresh party activity/);
    expect(changed).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Status'), {
      target: { value: 'PENDING' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(listReads).toBe(3));
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
describe('read-only settlement plan', () => {
  it('removes a stale cursor plan and restarts explicitly at page one', async () => {
    let calls = 0;
    const first = {
      currency: 'USD',
      snapshot: 'a'.repeat(64),
      items: [{ senderUserId: S, recipientUserId: R, money }],
      nextCursor: 'opaque',
      residuals: {
        currentDebtAfterPlan: '0.00',
        currentCreditAfterPlan: '0.00',
        departedDebt: '4.00',
        departedCredit: '0.00',
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        calls++;
        return input.includes('cursor=')
          ? json({ code: 'SETTLEMENT_SNAPSHOT_STALE', message: 'Changed' }, 409)
          : json(first);
      }),
    );
    render(
      <SettlementSuggestionsSection
        household={H}
        refreshSignal={0}
        onSessionExpired={vi.fn()}
        onHouseholdAccessChanged={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show current plan' }));
    expect(
      await screen.findByText(/departed debt 4.00 USD/),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Load more suggestions' }),
    );
    expect(
      await screen.findByText(/Balances changed while reading this plan/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/departed debt 4.00 USD/),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restart plan' }));
    await waitFor(() => expect(calls).toBe(3));
  });
});
