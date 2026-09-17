import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { FinancialAccount, Household, Transaction } from '../auth/client';
import { TransactionsSection } from './TransactionsSection';

const CSRF = { token: 'csrf-token-1', headerName: 'X-CSRF-TOKEN' };
const HOUSEHOLD: Household = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  name: 'Elm Street home',
  role: 'MEMBER',
  createdAt: '2026-09-13T01:30:00Z',
};
const ACTOR_ID = '30000000-0000-4000-8000-000000000001';
const CHECKING_ID = '10000000-0000-4000-8000-000000000001';
const CASH_ID = '10000000-0000-4000-8000-000000000002';
const EXPENSE_ID = '40000000-0000-4000-8000-000000000001';
const REFUND_ID = '40000000-0000-4000-8000-000000000002';
// A fixed supported date used as the entry date; it is never assumed to
// equal the runtime "today".
const FIXED_DATE = '2026-09-16';

function account(overrides: Partial<FinancialAccount> = {}): FinancialAccount {
  return {
    id: CHECKING_ID,
    householdId: HOUSEHOLD.id,
    ownerUserId: ACTOR_ID,
    name: 'Daily spending',
    kind: 'CHECKING',
    currency: 'BRL',
    source: 'MANUAL',
    visibility: 'PRIVATE',
    status: 'ACTIVE',
    version: 0,
    createdAt: '2026-09-16T12:00:00Z',
    updatedAt: '2026-09-16T12:00:00Z',
    ...overrides,
  };
}

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: EXPENSE_ID,
    householdId: HOUSEHOLD.id,
    ownerUserId: ACTOR_ID,
    accountId: CHECKING_ID,
    kind: 'EXPENSE',
    money: { amount: '-12.34', currency: 'BRL' },
    occurredOn: FIXED_DATE,
    description: 'Groceries',
    visibility: 'PRIVATE',
    source: 'MANUAL',
    status: 'POSTED',
    refundOfTransactionId: null,
    version: 0,
    createdAt: '2026-09-16T12:00:00Z',
    updatedAt: '2026-09-16T12:00:00Z',
    ...overrides,
  };
}

const CASH_ACCOUNT = account({
  id: CASH_ID,
  name: 'Pocket cash',
  kind: 'CASH',
  currency: 'JPY',
  status: 'ACTIVE',
});

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

interface RouteHandlers {
  accountsGet?: () => Response | Promise<Response>;
  transactionsGet?: () => Response | Promise<Response>;
  transactionsPost?: () => Response | Promise<Response>;
  transactionGet?: (transactionId: string) => Response | Promise<Response>;
  transactionsPatch?: (transactionId: string) => Response | Promise<Response>;
}

type Call = { url: string; init?: RequestInit | undefined };

function stubFetch(routes: RouteHandlers) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      const accountBase = `/api/households/${HOUSEHOLD.id}/financial-accounts`;
      const transactionBase = `/api/households/${HOUSEHOLD.id}/transactions`;
      if (url === `${accountBase}?limit=100&offset=0&status=ALL`) {
        return (
          routes.accountsGet?.() ??
          jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false })
        );
      }
      if (url === `${transactionBase}?limit=100&offset=0&view=OWN&status=ALL`) {
        return (
          routes.transactionsGet?.() ??
          jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false })
        );
      }
      if (url === transactionBase && init?.method === 'POST') {
        if (!routes.transactionsPost) {
          throw new Error('unexpected POST transactions');
        }
        return routes.transactionsPost();
      }
      if (url.startsWith(`${transactionBase}/`) && init?.method === 'PATCH') {
        const transactionId = decodeURIComponent(
          url.slice(transactionBase.length + 1),
        );
        if (!routes.transactionsPatch) {
          throw new Error('unexpected PATCH transaction');
        }
        return routes.transactionsPatch(transactionId);
      }
      if (url.startsWith(`${transactionBase}/`)) {
        const transactionId = decodeURIComponent(
          url.slice(transactionBase.length + 1),
        );
        if (!routes.transactionGet) {
          throw new Error('unexpected GET transaction detail');
        }
        return routes.transactionGet(transactionId);
      }
      if (url === '/api/auth/csrf') {
        return jsonResponse({
          token: 'csrf-token-2',
          headerName: 'X-CSRF-TOKEN',
        });
      }
      throw new Error(`unexpected fetch ${url} ${init?.method ?? ''}`);
    }),
  );
  return calls;
}

const postCalls = (calls: Call[]) =>
  calls.filter(({ init }) => init?.method === 'POST');
const patchCalls = (calls: Call[]) =>
  calls.filter(({ init }) => init?.method === 'PATCH');

function renderSection(
  routes: RouteHandlers = {},
  options: { authorityConfirmed?: boolean } = {},
) {
  const calls = stubFetch(routes);
  const onCsrfRefreshed = vi.fn();
  const onSessionExpired = vi.fn();
  const onHouseholdAccessChanged = vi.fn();
  const rendered = render(
    <TransactionsSection
      household={HOUSEHOLD}
      csrf={CSRF}
      onCsrfRefreshed={onCsrfRefreshed}
      onSessionExpired={onSessionExpired}
      onHouseholdAccessChanged={onHouseholdAccessChanged}
      authorityConfirmed={options.authorityConfirmed ?? true}
    />,
  );
  return {
    ...rendered,
    calls,
    onCsrfRefreshed,
    onSessionExpired,
    onHouseholdAccessChanged,
  };
}

const accountPage = (items: FinancialAccount[]) =>
  jsonResponse({ items, limit: 100, offset: 0, hasMore: false });
const transactionPage = (items: Transaction[]) =>
  jsonResponse({ items, limit: 100, offset: 0, hasMore: false });

const TRANSACTION_GET_URL = `/api/households/${HOUSEHOLD.id}/transactions?limit=100&offset=0&view=OWN&status=ALL`;

async function fillAndSubmit(
  overrides: { amount?: string; description?: string; date?: string } = {},
) {
  fireEvent.change(screen.getByLabelText('Account'), {
    target: { value: CHECKING_ID },
  });
  fireEvent.change(screen.getByLabelText('Amount'), {
    target: { value: overrides.amount ?? '12.34' },
  });
  if (overrides.date !== undefined) {
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: overrides.date },
    });
  }
  fireEvent.change(screen.getByLabelText('Description'), {
    target: { value: overrides.description ?? 'Groceries' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Record transaction' }));
}

describe('transaction list', () => {
  it('renders entries with exact amounts, kinds, dates, and privacy text', async () => {
    renderSection({
      accountsGet: () => accountPage([account(), CASH_ACCOUNT]),
      transactionsGet: () =>
        transactionPage([
          transaction(),
          transaction({
            id: '40000000-0000-4000-8000-000000000003',
            kind: 'INCOME',
            money: { amount: '200.00', currency: 'BRL' },
            description: 'Salary',
            occurredOn: '2026-09-15',
          }),
          transaction({
            id: '40000000-0000-4000-8000-000000000004',
            kind: 'TRANSFER',
            money: { amount: '20', currency: 'JPY' },
            description: 'Card payment',
            occurredOn: '2026-09-14',
            accountId: CASH_ID,
          }),
          transaction({
            id: '40000000-0000-4000-8000-000000000005',
            status: 'VOIDED',
            description: 'Cancelled entry',
            money: { amount: '-5.00', currency: 'BRL' },
          }),
        ]),
    });

    await screen.findByText('Groceries');
    const card = (description: string) =>
      screen.getByText(description).closest('li') as HTMLLIElement;
    // Amount strings are exact and currency codes explicit.
    expect(
      within(card('Groceries')).getByText('-12.34 BRL'),
    ).toBeInTheDocument();
    expect(within(card('Salary')).getByText('200.00 BRL')).toBeInTheDocument();
    expect(
      within(card('Card payment')).getByText('20 JPY'),
    ).toBeInTheDocument();
    expect(
      within(card('Cancelled entry')).getByText('-5.00 BRL'),
    ).toBeInTheDocument();
    // Meta text combines kind, date, account, and status in order.
    expect(card('Groceries').textContent).toMatch(
      /Expense · 2026-09-16 · Daily spending · Posted/,
    );
    expect(card('Salary').textContent).toMatch(
      /Income · 2026-09-15 · Daily spending · Posted/,
    );
    expect(card('Card payment').textContent).toMatch(
      /Transfer · 2026-09-14 · Pocket cash · Posted/,
    );
    expect(card('Cancelled entry').textContent).toMatch(
      /Expense · 2026-09-16 · Daily spending · Voided/,
    );

    // Privacy and void state are textual, never color-only.
    expect(screen.getAllByText('Private')).toHaveLength(4);
    expect(
      screen.getByText(
        /Every entry starts private to you. There is no sharing yet/,
      ),
    ).toBeInTheDocument();
    const voidedCard = card('Cancelled entry');
    expect(
      voidedCard.classList.contains('finance-transaction-card--voided'),
    ).toBe(true);
    expect(within(voidedCard).getByText('Voided')).toBeInTheDocument();
    expect(
      within(voidedCard)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Details']);
  });

  it('labels a refund with its linked expense from the loaded page', async () => {
    renderSection({
      transactionsGet: () =>
        transactionPage([
          transaction({
            id: REFUND_ID,
            kind: 'REFUND',
            money: { amount: '5.00', currency: 'BRL' },
            description: 'Returned one item',
            occurredOn: '2026-09-17',
            refundOfTransactionId: EXPENSE_ID,
          }),
          transaction(),
        ]),
    });
    await screen.findByText('Returned one item');
    expect(
      screen.getByText('Refund of an expense recorded on 2026-09-16'),
    ).toBeInTheDocument();
  });

  it('keeps the empty state free of synthetic totals', async () => {
    renderSection({
      transactionsGet: () => transactionPage([]),
    });
    expect(await screen.findByText('No transactions yet.')).toBeInTheDocument();
    expect(screen.queryByText(/total/i)).toBeNull();
    expect(screen.queryByText(/balance/i)).toBeNull();
    // No recorded money line (amount followed by a currency code) exists.
    expect(
      document.body.textContent?.match(
        /-?\d+\.\d{2,3}\s(BRL|USD|EUR|GBP|JPY|KWD)/,
      ),
    ).toBeNull();
  });

  it('reports a failed list with a refresh recovery path', async () => {
    renderSection({
      accountsGet: () =>
        jsonResponse(
          {
            code: 'NETWORK_ERROR',
            message: 'Could not reach the server.',
            correlationId: 'corr-list',
          },
          500,
        ),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not reach the server.',
    );
    expect(screen.getByText('Reference: corr-list')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Record transaction' }),
    ).toBeNull();
  });

  it('ends the session recovery on a 401 list', async () => {
    const { onSessionExpired } = renderSection({
      transactionsGet: () =>
        jsonResponse(
          { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
          401,
        ),
    });
    await waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reconciles lost household access from a generic household 404', async () => {
    const { onHouseholdAccessChanged } = renderSection({
      transactionsGet: () =>
        jsonResponse(
          { code: 'HOUSEHOLD_NOT_FOUND', message: 'Household unavailable.' },
          404,
        ),
    });
    await waitFor(() =>
      expect(onHouseholdAccessChanged).toHaveBeenCalledTimes(1),
    );
    expect(
      screen.queryByRole('button', { name: 'Record transaction' }),
    ).toBeNull();
  });

  it('defaults the date to the household-zone today, not the browser zone', async () => {
    renderSection({});
    await screen.findByText('No transactions yet.');
    const dateInput = screen.getByLabelText('Date') as HTMLInputElement;
    expect(dateInput.value).toBe(new Date().toISOString().slice(0, 10));
    expect(dateInput).toHaveAttribute('min', '1900-01-01');
    expect(dateInput).toHaveAttribute('max', '9999-12-30');
  });
});

describe('transaction creation', () => {
  it('sends the exact documented body with visibility, CSRF, and one fresh key', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () => jsonResponse(transaction(), 201),
    });
    await screen.findByText('No transactions yet.');
    await fillAndSubmit({ date: FIXED_DATE });

    expect(
      await screen.findByText(`Expense recorded: -12.34 BRL on ${FIXED_DATE}.`),
    ).toBeInTheDocument();
    const posts = postCalls(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.init?.headers).toMatchObject({
      'X-CSRF-TOKEN': CSRF.token,
    });
    const key = (posts[0]?.init?.headers as Record<string, string>)[
      'Idempotency-Key'
    ];
    expect(key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(JSON.parse(String(posts[0]?.init?.body))).toEqual({
      accountId: CHECKING_ID,
      kind: 'EXPENSE',
      money: { amount: '-12.34', currency: 'BRL' },
      occurredOn: FIXED_DATE,
      description: 'Groceries',
      visibility: 'PRIVATE',
    });
  });

  it('encodes income and transfer signs from the kind and direction', async () => {
    let postCount = 0;
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () => {
        postCount += 1;
        const responses: Record<
          number,
          { amount: string; kind: 'INCOME' | 'TRANSFER' }
        > = {
          1: { amount: '200.00', kind: 'INCOME' },
          2: { amount: '-50.00', kind: 'TRANSFER' },
          3: { amount: '30.00', kind: 'TRANSFER' },
        };
        const entry = responses[postCount] ?? {
          amount: '1.00',
          kind: 'TRANSFER',
        };
        return jsonResponse(
          transaction({
            id: `40000000-0000-4000-8000-00000000000${postCount + 3}`,
            kind: entry.kind,
            money: { amount: entry.amount, currency: 'BRL' },
            description: `Entry ${postCount}`,
          }),
          201,
        );
      },
    });
    await screen.findByText('No transactions yet.');

    // Income: positive magnitude, positive wire amount.
    fireEvent.change(screen.getByLabelText('Account'), {
      target: { value: CHECKING_ID },
    });
    fireEvent.change(screen.getByLabelText('Entry type'), {
      target: { value: 'INCOME' },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '200' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Salary' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record transaction' }));
    expect(
      await screen.findByText(`Income recorded: 200.00 BRL on ${FIXED_DATE}.`),
    ).toBeInTheDocument();

    // Transfer out: negative wire amount.
    fireEvent.change(screen.getByLabelText('Entry type'), {
      target: { value: 'TRANSFER' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Money out (−)' }));
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '50' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Card payment' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record transaction' }));
    expect(
      await screen.findByText(
        `Transfer recorded: -50.00 BRL on ${FIXED_DATE}.`,
      ),
    ).toBeInTheDocument();

    // Transfer in: positive wire amount.
    fireEvent.click(screen.getByRole('radio', { name: 'Money in (+)' }));
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '30.0' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'ATM deposit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record transaction' }));
    expect(
      await screen.findByText(`Transfer recorded: 30.00 BRL on ${FIXED_DATE}.`),
    ).toBeInTheDocument();

    const bodies = postCalls(calls).map(
      (call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>,
    );
    expect(bodies).toHaveLength(3);
    expect(bodies[0]?.kind).toBe('INCOME');
    expect(bodies[0]?.money).toEqual({ amount: '200.00', currency: 'BRL' });
    expect(bodies[1]?.kind).toBe('TRANSFER');
    expect(bodies[1]?.money).toEqual({ amount: '-50.00', currency: 'BRL' });
    expect(bodies[2]?.money).toEqual({ amount: '30.00', currency: 'BRL' });
  });

  it('rejects invalid amounts locally without any request', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([CASH_ACCOUNT]),
      transactionsGet: () => transactionPage([]),
    });
    await screen.findByText('No transactions yet.');
    fireEvent.change(screen.getByLabelText('Account'), {
      target: { value: CASH_ID },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Test entry' },
    });
    const expectError = async (amount: string, message: string | RegExp) => {
      fireEvent.change(screen.getByLabelText('Amount'), {
        target: { value: amount },
      });
      fireEvent.click(
        screen.getByRole('button', { name: 'Record transaction' }),
      );
      expect(await screen.findByText(message)).toBeInTheDocument();
    };

    await expectError('12,50', /Enter the amount as plain digits/);
    await expectError('12.345', 'JPY amounts have no decimal places.');
    await expectError('1.0', 'JPY amounts have no decimal places.');
    await expectError('0', 'Enter a nonzero amount.');
    await expectError('01.5', /Enter the amount as plain digits/);
    await expectError('1000000000000', 'The amount is too large.');
    await expectError('12 ', 'Remove spaces from the amount.');
    expect(postCalls(calls)).toHaveLength(0);
    expect(patchCalls(calls)).toHaveLength(0);
  });

  it('requires an account before any request is sent', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
    });
    await screen.findByText('No transactions yet.');
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '12.34' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Groceries' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record transaction' }));
    expect(await screen.findByText('Choose an account.')).toBeInTheDocument();
    expect(postCalls(calls)).toHaveLength(0);
    // The announced value preview never invents a currency.
    expect(
      screen.getByText('Choose an account to see the recorded value.'),
    ).toBeInTheDocument();
  });

  it('rejects an impossible or out-of-range date locally', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
    });
    await screen.findByText('No transactions yet.');
    fireEvent.change(screen.getByLabelText('Account'), {
      target: { value: CHECKING_ID },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '12.34' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Groceries' },
    });
    for (const bad of [
      '2026-02-30',
      '1899-12-31',
      '9999-12-31',
      'not-a-date',
    ]) {
      fireEvent.change(screen.getByLabelText('Date'), {
        target: { value: bad },
      });
      fireEvent.click(
        screen.getByRole('button', { name: 'Record transaction' }),
      );
      expect(
        await screen.findByText(
          'Enter a calendar date between 1900-01-01 and 9999-12-30.',
        ),
      ).toBeInTheDocument();
    }
    expect(postCalls(calls)).toHaveLength(0);
  });

  it('warns about a future date but records it when confirmed', async () => {
    const future = '2099-01-01';
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () =>
        jsonResponse(transaction({ occurredOn: future }), 201),
    });
    await screen.findByText('No transactions yet.');
    fireEvent.change(screen.getByLabelText('Account'), {
      target: { value: CHECKING_ID },
    });
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: future },
    });
    expect(
      await screen.findByText(
        /This date is in the future. It stays a recorded fact/,
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '12.34' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Prepaid rent' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record transaction' }));
    expect(
      await screen.findByText(`Expense recorded: -12.34 BRL on ${future}.`),
    ).toBeInTheDocument();
    expect(postCalls(calls)).toHaveLength(1);
  });

  it('describes the encoded value before submission with the currency code', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
    });
    await screen.findByText('No transactions yet.');
    fireEvent.change(screen.getByLabelText('Account'), {
      target: { value: CHECKING_ID },
    });
    expect(screen.getByText('Records nothing yet in BRL.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '12.3' },
    });
    expect(screen.getByText('Records -12.30 BRL.')).toBeInTheDocument();
  });
});

describe('refund creation', () => {
  it('originates from a posted expense and locks account, currency, and source', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      transactionsPost: () =>
        jsonResponse(
          transaction({
            id: REFUND_ID,
            kind: 'REFUND',
            money: { amount: '5.00', currency: 'BRL' },
            description: 'Returned one item',
            refundOfTransactionId: EXPENSE_ID,
          }),
          201,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Record a refund for Groceries' }),
    );
    expect(
      await screen.findByText(
        /Refund of the expense “Groceries” recorded on 2026-09-16/,
      ),
    ).toBeInTheDocument();
    // No account or entry-type select is offered in refund mode.
    expect(screen.queryByLabelText('Account')).toBeNull();
    expect(screen.queryByLabelText('Entry type')).toBeNull();

    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '5' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Returned one item' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record transaction' }));
    expect(
      await screen.findByText(`Refund recorded: 5.00 BRL on ${FIXED_DATE}.`),
    ).toBeInTheDocument();
    const body = JSON.parse(String(postCalls(calls)[0]?.init?.body)) as Record<
      string,
      unknown
    >;
    expect(body.refundOfTransactionId).toBe(EXPENSE_ID);
    expect(body.kind).toBe('REFUND');
    expect(body.money).toEqual({ amount: '5.00', currency: 'BRL' });
    // Visibility is inherited by omission, never sent explicitly.
    expect(body.visibility).toBeUndefined();
  });

  it('rejects a refund dated before its expense locally', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      transactionsPost: () =>
        jsonResponse(
          transaction({
            id: REFUND_ID,
            kind: 'REFUND',
            money: { amount: '5.00', currency: 'BRL' },
            description: 'Same-day return',
            refundOfTransactionId: EXPENSE_ID,
          }),
          201,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Record a refund for Groceries' }),
    );
    await screen.findByText(/Refund of the expense/);
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '5.00' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Too early' },
    });
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: '2026-09-15' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record transaction' }));
    expect(
      await screen.findByText(
        `The refund date cannot be before the expense date (${FIXED_DATE}).`,
      ),
    ).toBeInTheDocument();
    expect(postCalls(calls)).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: FIXED_DATE },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record transaction' }));
    expect(
      await screen.findByText(`Refund recorded: 5.00 BRL on ${FIXED_DATE}.`),
    ).toBeInTheDocument();
    expect(postCalls(calls)).toHaveLength(1);
  });

  it('maps refund conflicts to a refresh-and-check message', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      transactionsPost: () =>
        jsonResponse(
          {
            code: 'REFUND_CONFLICT',
            message: 'The expense was fully refunded.',
          },
          409,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Record a refund for Groceries' }),
    );
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '5.00' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Returned one item' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record transaction' }));
    expect(
      await screen.findByText(
        'The refund no longer matches its expense. Refresh the list and check the expense.',
      ),
    ).toBeInTheDocument();
  });
});

describe('durable creation retries', () => {
  it('retries an unknown outcome with the exact same key and payload', async () => {
    let attempts = 0;
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse(
              {
                code: 'FINANCE_BUSY',
                message: 'The household is busy; outcome may be unknown.',
                correlationId: 'corr-busy',
              },
              503,
            )
          : jsonResponse(transaction(), 201);
      },
    });
    await screen.findByText('No transactions yet.');
    await fillAndSubmit({ date: FIXED_DATE });

    expect(await screen.findByText(/unknown outcome/i)).toBeInTheDocument();
    // The failed attempt must not clear the retained request: the form
    // stays disabled so the payload cannot be edited under the live key.
    expect(screen.getByLabelText('Amount')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Retry same request' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
    expect(
      await screen.findByText(`Expense recorded: -12.34 BRL on ${FIXED_DATE}.`),
    ).toBeInTheDocument();
    const posts = postCalls(calls);
    expect(posts).toHaveLength(2);
    const firstKey = (posts[0]?.init?.headers as Record<string, string>)[
      'Idempotency-Key'
    ];
    expect(
      (posts[1]?.init?.headers as Record<string, string>)['Idempotency-Key'],
    ).toBe(firstKey);
    expect(JSON.parse(String(posts[1]?.init?.body))).toEqual(
      JSON.parse(String(posts[0]?.init?.body)),
    );
  });

  it('treats a network failure as an unknown outcome too', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await screen.findByText('No transactions yet.');
    await fillAndSubmit({ date: FIXED_DATE });
    expect(await screen.findByText(/unknown outcome/i)).toBeInTheDocument();
    expect(postCalls(calls)).toHaveLength(1);
  });

  it('refreshes the token and requires an explicit same-key retry after CSRF rejection', async () => {
    let attempts = 0;
    const { calls, onCsrfRefreshed } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse(
              { code: 'CSRF_INVALID', message: 'Security check failed.' },
              403,
            )
          : jsonResponse(transaction(), 201);
      },
    });
    await screen.findByText('No transactions yet.');
    await fillAndSubmit({ date: FIXED_DATE });
    expect(
      await screen.findByText(
        'Your security token was refreshed. Retry the same transaction request.',
      ),
    ).toBeInTheDocument();
    expect(onCsrfRefreshed).toHaveBeenCalledWith({
      token: 'csrf-token-2',
      headerName: 'X-CSRF-TOKEN',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
    expect(
      await screen.findByText(`Expense recorded: -12.34 BRL on ${FIXED_DATE}.`),
    ).toBeInTheDocument();
    const posts = postCalls(calls);
    expect(posts).toHaveLength(2);
    expect(
      (posts[0]?.init?.headers as Record<string, string>)['X-CSRF-TOKEN'],
    ).toBe('csrf-token-1');
    expect(
      (posts[1]?.init?.headers as Record<string, string>)['X-CSRF-TOKEN'],
    ).toBe('csrf-token-2');
    expect(
      (posts[1]?.init?.headers as Record<string, string>)['Idempotency-Key'],
    ).toBe(
      (posts[0]?.init?.headers as Record<string, string>)['Idempotency-Key'],
    );
  });

  it('keeps the retained same-key retry available across a deliberate refresh', async () => {
    let attempts = 0;
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse({ code: 'FINANCE_BUSY', message: 'Busy.' }, 503)
          : jsonResponse(transaction(), 201);
      },
    });
    await screen.findByText('No transactions yet.');
    await fillAndSubmit({ date: FIXED_DATE });
    expect(await screen.findByText(/unknown outcome/i)).toBeInTheDocument();

    fireEvent.click(
      screen.getAllByRole('button', { name: 'Refresh transactions' })[0]!,
    );
    expect(await screen.findByText(/unknown result/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Retry same request' }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
    expect(
      await screen.findByText(`Expense recorded: -12.34 BRL on ${FIXED_DATE}.`),
    ).toBeInTheDocument();
    const posts = postCalls(calls);
    expect(
      (posts[1]?.init?.headers as Record<string, string>)['Idempotency-Key'],
    ).toBe(
      (posts[0]?.init?.headers as Record<string, string>)['Idempotency-Key'],
    );
    expect(screen.queryByText(/unknown result/i)).toBeNull();
  });

  it('clears the retained request when a create ends in session expiry', async () => {
    const { onSessionExpired } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () =>
        jsonResponse(
          { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
          401,
        ),
    });
    await screen.findByText('No transactions yet.');
    await fillAndSubmit({ date: FIXED_DATE });
    await waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole('button', { name: 'Retry same request' }),
    ).toBeNull();
  });

  it('clears the retained request and reconciles on access loss from a create', async () => {
    const { onHouseholdAccessChanged } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () =>
        jsonResponse(
          { code: 'HOUSEHOLD_NOT_FOUND', message: 'Household unavailable.' },
          404,
        ),
    });
    await screen.findByText('No transactions yet.');
    await fillAndSubmit({ date: FIXED_DATE });
    await waitFor(() =>
      expect(onHouseholdAccessChanged).toHaveBeenCalledTimes(1),
    );
    expect(
      screen.queryByRole('button', { name: 'Retry same request' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Record transaction' }),
    ).toBeNull();
  });

  it('guards duplicate create submissions before state flushes', async () => {
    let resolvePost!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolvePost = resolve;
    });
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () => gate,
    });
    await screen.findByText('No transactions yet.');
    fireEvent.change(screen.getByLabelText('Account'), {
      target: { value: CHECKING_ID },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '12.34' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Groceries' },
    });
    const submit = screen.getByRole('button', { name: 'Record transaction' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    resolvePost(jsonResponse(transaction(), 201));
    expect(
      await screen.findByText(`Expense recorded: -12.34 BRL on ${FIXED_DATE}.`),
    ).toBeInTheDocument();
    expect(postCalls(calls)).toHaveLength(1);
  });

  it('maps a server amount error onto the field and preserves the input', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () =>
        jsonResponse(
          {
            code: 'VALIDATION_FAILED',
            message: 'Check the highlighted fields.',
            correlationId: 'corr-field',
            fieldErrors: {
              'money.amount': 'That amount is not accepted.',
            },
          },
          400,
        ),
    });
    await screen.findByText('No transactions yet.');
    await fillAndSubmit({ date: FIXED_DATE });
    expect(
      await screen.findByText('That amount is not accepted.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toHaveValue('12.34');
    expect(screen.getByLabelText('Amount')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByText('Reference: corr-field')).toBeInTheDocument();
  });

  it('explains an archived-account rejection without a durable retry', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () =>
        jsonResponse(
          { code: 'ACCOUNT_ARCHIVED', message: 'Account is archived.' },
          409,
        ),
    });
    await screen.findByText('No transactions yet.');
    await fillAndSubmit({ date: FIXED_DATE });
    expect(
      await screen.findByText(
        'That account is archived now. Refresh accounts before recording here.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry same request' }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Record transaction' }),
    ).toBeEnabled();
  });

  it('starts a fresh instance without the retained key after a keyed remount', async () => {
    let attempts = 0;
    const first = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse({ code: 'FINANCE_BUSY', message: 'Busy.' }, 503)
          : jsonResponse(transaction(), 201);
      },
    });
    await screen.findByText('No transactions yet.');
    await fillAndSubmit({ date: FIXED_DATE });
    expect(await screen.findByText(/unknown outcome/i)).toBeInTheDocument();
    const retainedKey = (
      postCalls(first.calls)[0]?.init?.headers as Record<string, string>
    )['Idempotency-Key'];
    first.unmount();

    const second = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () => jsonResponse(transaction(), 201),
    });
    expect(await screen.findByText('No transactions yet.')).toBeInTheDocument();
    expect(screen.queryByText(/unknown result/i)).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Retry same request' }),
    ).toBeNull();
    await fillAndSubmit({ date: FIXED_DATE });
    expect(
      await screen.findByText(`Expense recorded: -12.34 BRL on ${FIXED_DATE}.`),
    ).toBeInTheDocument();
    const freshKey = (
      postCalls(second.calls)[0]?.init?.headers as Record<string, string>
    )['Idempotency-Key'];
    expect(freshKey).not.toBe(retainedKey);
  });
});

describe('corrections', () => {
  const EDIT_AMOUNT =
    '#edit-transaction-amount-40000000-0000-4000-8000-000000000001';

  it('edits amount and description with the expected version', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      transactionsPatch: () =>
        jsonResponse(
          transaction({
            money: { amount: '-20.00', currency: 'BRL' },
            description: 'Weekly groceries',
            version: 1,
          }),
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Groceries' }));
    const amountInput = await screen.findByLabelText('Amount', {
      selector: '#edit-transaction-amount-40000000-0000-4000-8000-000000000001',
    });
    // The magnitude is seeded without the sign; the sign follows the kind.
    expect(amountInput).toHaveValue('12.34');
    fireEvent.change(amountInput, { target: { value: '20' } });
    fireEvent.change(
      screen.getByLabelText('Description', {
        selector:
          '#edit-transaction-description-40000000-0000-4000-8000-000000000001',
      }),
      { target: { value: 'Weekly groceries' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));

    expect(
      await screen.findByText(
        `Transaction corrected: -20.00 BRL on ${FIXED_DATE}.`,
      ),
    ).toBeInTheDocument();
    const patches = patchCalls(calls);
    expect(patches).toHaveLength(1);
    expect(JSON.parse(String(patches[0]?.init?.body))).toEqual({
      expectedVersion: 0,
      money: { amount: '-20.00', currency: 'BRL' },
      description: 'Weekly groceries',
    });
  });

  it('recovers from a stale version by closing the editor and reloading first', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      transactionsPatch: () =>
        jsonResponse(
          {
            code: 'RESOURCE_VERSION_CONFLICT',
            message: 'Stale update.',
            correlationId: 'corr-stale',
          },
          409,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Groceries' }));
    fireEvent.change(
      await screen.findByLabelText('Amount', { selector: EDIT_AMOUNT }),
      { target: { value: '20' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));

    expect(
      await screen.findByText(
        'This transaction changed on the server. The list was refreshed; review before retrying.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Reference: corr-stale')).toBeInTheDocument();
    // The stale editor is closed; a reload ran before any correction.
    expect(
      screen.queryByRole('button', { name: 'Save correction' }),
    ).toBeNull();
    const transactionGets = calls.filter(
      ({ url }) => url === TRANSACTION_GET_URL,
    );
    expect(transactionGets.length).toBeGreaterThanOrEqual(2);
  });

  it('excludes voided records from edit and void controls', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () =>
        transactionPage([transaction({ status: 'VOIDED' })]),
    });
    await screen.findByText('Groceries');
    expect(screen.queryByRole('button', { name: 'Edit Groceries' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Void Groceries' })).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: 'Record a refund for Groceries',
      }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    ).toBeEnabled();
  });

  it('maps voided-edit and refund-bound rejections to their guidance', async () => {
    const cases: Array<[Response, RegExp]> = [
      [
        jsonResponse({ code: 'TRANSACTION_VOIDED' }, 409),
        /This transaction changed on the server/,
      ],
      [
        jsonResponse({ code: 'REFUND_CONFLICT' }, 409),
        /The correction conflicts with this expense's refunds/,
      ],
    ];
    for (const [response, text] of cases) {
      const { unmount } = renderSection({
        accountsGet: () => accountPage([account()]),
        transactionsGet: () => transactionPage([transaction()]),
        transactionsPatch: () => response,
      });
      await screen.findByText('Groceries');
      fireEvent.click(screen.getByRole('button', { name: 'Edit Groceries' }));
      fireEvent.change(
        await screen.findByLabelText('Amount', { selector: EDIT_AMOUNT }),
        { target: { value: '20' } },
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
      expect(await screen.findByText(text)).toBeInTheDocument();
      unmount();
    }
  });

  it('drops a stale row and offers refresh after a not-found correction', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      transactionsPatch: () =>
        jsonResponse(
          {
            code: 'TRANSACTION_NOT_FOUND',
            message: 'Transaction is unavailable.',
            correlationId: 'corr-404',
          },
          404,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Groceries' }));
    fireEvent.change(
      await screen.findByLabelText('Amount', { selector: EDIT_AMOUNT }),
      { target: { value: '20' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    expect(
      await screen.findByText(
        'This transaction is no longer available to you. Refresh to see the current list.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Groceries')).toBeNull();
  });

  it('keeps an expense date at or before its live refunds', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () =>
        transactionPage([
          transaction(),
          transaction({
            id: REFUND_ID,
            kind: 'REFUND',
            money: { amount: '5.00', currency: 'BRL' },
            description: 'Partial return',
            occurredOn: '2026-09-18',
            refundOfTransactionId: EXPENSE_ID,
          }),
        ]),
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Groceries' }));
    fireEvent.change(
      await screen.findByLabelText('Date', {
        selector: '#edit-transaction-date-40000000-0000-4000-8000-000000000001',
      }),
      { target: { value: '2026-09-20' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    expect(
      await screen.findByText(
        'This expense has refunds on 2026-09-18; its date cannot be later.',
      ),
    ).toBeInTheDocument();
  });

  it('closes locally without a request when the correction changes nothing', async () => {
    const { calls } = renderSection({
      transactionsGet: () => transactionPage([transaction()]),
      transactionsPatch: () => {
        throw new Error('unexpected PATCH transaction');
      },
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Groceries' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));

    // The unchanged correction resolves locally: a status, a closed editor,
    // no `{expectedVersion}`-only request.
    expect(
      await screen.findByText(
        'The correction matches the recorded entry. Nothing to save.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Save correction' }),
    ).toBeNull();
    await waitFor(() =>
      expect(
        document.getElementById(`edit-trigger-${EXPENSE_ID}`),
      ).toHaveFocus(),
    );
    expect(patchCalls(calls)).toHaveLength(0);
  });

  it('warns about a future date in the correction form', async () => {
    renderSection({
      transactionsGet: () => transactionPage([transaction()]),
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Groceries' }));
    fireEvent.change(
      await screen.findByLabelText('Date', {
        selector: '#edit-transaction-date-40000000-0000-4000-8000-000000000001',
      }),
      { target: { value: '2099-01-01' } },
    );
    expect(
      await screen.findByText(
        /This date is in the future. It stays a recorded fact/,
      ),
    ).toBeInTheDocument();
  });

  it('restores focus to the Edit trigger after cancelling the correction', async () => {
    renderSection({
      transactionsGet: () => transactionPage([transaction()]),
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Groceries' }));
    await screen.findByLabelText('Amount', { selector: EDIT_AMOUNT });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(
        document.getElementById(`edit-trigger-${EXPENSE_ID}`),
      ).toHaveFocus(),
    );
    expect(
      screen.queryByRole('button', { name: 'Save correction' }),
    ).toBeNull();
  });
});

describe('voiding', () => {
  it('voids through an explicit keyboard-cancellable confirmation', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      transactionsPatch: () =>
        jsonResponse(transaction({ status: 'VOIDED', version: 1 })),
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Void Groceries' }));
    const panel = screen.getByRole('group', {
      name: 'Confirm void for Groceries',
    });
    expect(panel).toHaveFocus();
    expect(
      within(panel).getByText(/stays listed as voided/),
    ).toBeInTheDocument();

    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(
      screen.queryByRole('group', { name: 'Confirm void for Groceries' }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Void Groceries' }),
    ).toHaveFocus();
    expect(patchCalls(calls)).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Void Groceries' }));
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Confirm void for Groceries' }),
      ).getByRole('button', { name: 'Void transaction' }),
    );
    expect(
      await screen.findByText(
        'Transaction voided. It stays listed as voided and stops counting toward spending.',
      ),
    ).toBeInTheDocument();
    const patches = patchCalls(calls);
    expect(patches).toHaveLength(1);
    expect(JSON.parse(String(patches[0]?.init?.body))).toEqual({
      expectedVersion: 0,
      status: 'VOIDED',
    });
  });

  it('requires voiding live refunds before voiding the expense', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      transactionsPatch: () =>
        jsonResponse(
          { code: 'REFUND_CONFLICT', message: 'Live refunds exist.' },
          409,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Void Groceries' }));
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Confirm void for Groceries' }),
      ).getByRole('button', { name: 'Void transaction' }),
    );
    expect(
      await screen.findByText(
        'Void its refunds before voiding this expense. Refresh the list to see them.',
      ),
    ).toBeInTheDocument();
  });

  it('never lets a second trigger replace an open void confirmation', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () =>
        transactionPage([
          transaction(),
          transaction({
            id: '40000000-0000-4000-8000-000000000003',
            kind: 'INCOME',
            money: { amount: '200.00', currency: 'BRL' },
            description: 'Salary',
            occurredOn: '2026-09-15',
          }),
        ]),
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Void Groceries' }));
    const panel = screen.getByRole('group', {
      name: 'Confirm void for Groceries',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Void Salary' }));
    expect(
      screen.queryByRole('group', { name: 'Confirm void for Salary' }),
    ).toBeNull();
    expect(panel).toBeInTheDocument();
  });
});

describe('detail', () => {
  it('fetches and shows the exact documented fields', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      transactionGet: (transactionId) => {
        expect(transactionId).toBe(EXPENSE_ID);
        return jsonResponse(transaction());
      },
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Details for Groceries',
    });
    expect(panel).toHaveFocus();
    expect(within(panel).getByText('-12.34 BRL')).toBeInTheDocument();
    expect(within(panel).getByText(FIXED_DATE)).toBeInTheDocument();
    expect(within(panel).getByText('Groceries')).toBeInTheDocument();
    expect(within(panel).getByText('Posted')).toBeInTheDocument();
    expect(within(panel).getByText('None — not a refund')).toBeInTheDocument();
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Close details' }),
    );
    expect(
      screen.queryByRole('group', { name: 'Details for Groceries' }),
    ).toBeNull();
  });

  it('drops the stale row when the detail is no longer authorized', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      transactionGet: () =>
        jsonResponse(
          {
            code: 'TRANSACTION_NOT_FOUND',
            message: 'Transaction is unavailable.',
            correlationId: 'corr-detail-404',
          },
          404,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    expect(
      await screen.findByText(
        'This transaction is no longer available to you. Refresh to see the current list.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Groceries')).toBeNull();
    expect(screen.getByText('Reference: corr-detail-404')).toBeInTheDocument();
  });

  it('aborts the detail request on unmount', async () => {
    let capturedSignal: AbortSignal | null | undefined;
    const { calls, unmount } = renderSection({
      transactionsGet: () => transactionPage([transaction()]),
      transactionGet: () =>
        new Promise<Response>(() => {
          // Never resolves; the tracked controller must be aborted by the
          // unmount cleanup exactly like every other owned request.
        }),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    // The `calls` array is mutated in place by the stub, so re-reading it
    // inside waitFor observes the request once it starts.
    await waitFor(() => {
      const detailCall = calls.find(
        (call) =>
          call.url ===
          `/api/households/${HOUSEHOLD.id}/transactions/${EXPENSE_ID}`,
      );
      capturedSignal = detailCall?.init?.signal;
      expect(capturedSignal).toBeDefined();
    });
    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('ignores a late detail response after unmount', async () => {
    let resolveDetail!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveDetail = resolve;
    });
    const { unmount, onSessionExpired } = renderSection({
      transactionsGet: () => transactionPage([transaction()]),
      transactionGet: () => gate,
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    unmount();
    // A post-unmount session-loss response must not fire parent callbacks
    // or touch state: the generation guard drops the continuation.
    resolveDetail(
      jsonResponse(
        { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
        401,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it('refuses duplicate detail activation in the same flush', async () => {
    const { calls } = renderSection({
      transactionsGet: () => transactionPage([transaction()]),
      transactionGet: () => jsonResponse(transaction()),
    });
    await screen.findByText('Groceries');
    const trigger = screen.getByRole('button', {
      name: 'Details for Groceries',
    });
    // Two activations before any state flush: the synchronous ref guard
    // must keep exactly one request in flight.
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(
      await screen.findByRole('group', { name: 'Details for Groceries' }),
    ).toBeInTheDocument();
    const detailCalls = calls.filter(
      (call) =>
        call.url ===
        `/api/households/${HOUSEHOLD.id}/transactions/${EXPENSE_ID}`,
    );
    expect(detailCalls).toHaveLength(1);
  });

  it('restores focus to the Details trigger after closing the panel', async () => {
    renderSection({
      transactionsGet: () => transactionPage([transaction()]),
      transactionGet: () => jsonResponse(transaction()),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Details for Groceries',
    });
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Close details' }),
    );
    await waitFor(() =>
      expect(
        document.getElementById(`details-trigger-${EXPENSE_ID}`),
      ).toHaveFocus(),
    );
    expect(
      screen.queryByRole('group', { name: 'Details for Groceries' }),
    ).toBeNull();
  });
});

describe('authority and lifecycle', () => {
  it('keeps every transaction control unavailable until authority is confirmed', async () => {
    renderSection(
      {
        accountsGet: () => accountPage([account()]),
        transactionsGet: () => transactionPage([transaction()]),
      },
      { authorityConfirmed: false },
    );
    expect(
      await screen.findByText(
        'Refresh the household before changing transactions.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toBeDisabled();
    expect(screen.getByLabelText('Description')).toBeDisabled();
    expect(screen.getByLabelText('Entry type')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Record transaction' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Edit Groceries' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Void Groceries' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Record a refund for Groceries' }),
    ).toBeDisabled();
  });

  it('aborts the load on unmount without late updates', async () => {
    stubFetch({
      accountsGet: () => new Promise<Response>(() => {}),
      transactionsGet: () => new Promise<Response>(() => {}),
    });
    const { unmount } = render(
      <TransactionsSection
        household={HOUSEHOLD}
        csrf={CSRF}
        onCsrfRefreshed={() => {}}
        onSessionExpired={() => {}}
        onHouseholdAccessChanged={() => {}}
        authorityConfirmed
      />,
    );
    await screen.findByText('Loading your transactions…');
    unmount();
  });

  it('recovers from a canceled StrictMode setup request', async () => {
    stubFetch({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
    });
    render(
      <StrictMode>
        <TransactionsSection
          household={HOUSEHOLD}
          csrf={CSRF}
          onCsrfRefreshed={() => {}}
          onSessionExpired={() => {}}
          onHouseholdAccessChanged={() => {}}
          authorityConfirmed
        />
      </StrictMode>,
    );
    expect(await screen.findByText('Groceries')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Record transaction' }),
    ).not.toBeDisabled();
  });
});
