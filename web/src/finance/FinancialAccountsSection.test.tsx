import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { StrictMode, act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { FinancialAccount, Household } from '../auth/client';
import { FinancialAccountsSection } from './FinancialAccountsSection';

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

const CASH_ACCOUNT = account({
  id: CASH_ID,
  name: 'Pocket cash',
  kind: 'CASH',
  currency: 'USD',
  status: 'ARCHIVED',
});

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

interface RouteHandlers {
  accountsGet?: () => Response | Promise<Response>;
  accountsPost?: () => Response | Promise<Response>;
  accountsPatch?: (accountId: string) => Response | Promise<Response>;
}

type Call = { url: string; init?: RequestInit | undefined };

function stubFetch(routes: RouteHandlers) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      const base = `/api/households/${HOUSEHOLD.id}/financial-accounts`;
      if (url === `${base}?limit=100&offset=0&status=ALL`) {
        if (!routes.accountsGet) throw new Error('unexpected GET accounts');
        return routes.accountsGet();
      }
      if (url === base && init?.method === 'POST') {
        if (!routes.accountsPost) throw new Error('unexpected POST accounts');
        return routes.accountsPost();
      }
      if (url.startsWith(`${base}/`) && init?.method === 'PATCH') {
        const accountId = decodeURIComponent(url.slice(base.length + 1));
        if (!routes.accountsPatch) {
          throw new Error('unexpected PATCH account');
        }
        return routes.accountsPatch(accountId);
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
  options: {
    authorityConfirmed?: boolean;
    onAccountListCommitted?: () => void;
    accountsRefreshSignal?: number;
  } = {},
) {
  const calls = stubFetch(routes);
  const onCsrfRefreshed = vi.fn();
  const onSessionExpired = vi.fn();
  const onHouseholdAccessChanged = vi.fn();
  const onAccountListCommitted = options.onAccountListCommitted ?? vi.fn();
  const rendered = render(
    <FinancialAccountsSection
      household={HOUSEHOLD}
      csrf={CSRF}
      onCsrfRefreshed={onCsrfRefreshed}
      onSessionExpired={onSessionExpired}
      onHouseholdAccessChanged={onHouseholdAccessChanged}
      authorityConfirmed={options.authorityConfirmed ?? true}
      onAccountListCommitted={onAccountListCommitted}
      accountsRefreshSignal={options.accountsRefreshSignal ?? 0}
    />,
  );
  function rerenderWithAccountSignal(accountsRefreshSignal: number) {
    rendered.rerender(
      <FinancialAccountsSection
        household={HOUSEHOLD}
        csrf={CSRF}
        onCsrfRefreshed={onCsrfRefreshed}
        onSessionExpired={onSessionExpired}
        onHouseholdAccessChanged={onHouseholdAccessChanged}
        authorityConfirmed={options.authorityConfirmed ?? true}
        onAccountListCommitted={onAccountListCommitted}
        accountsRefreshSignal={accountsRefreshSignal}
      />,
    );
  }
  return {
    ...rendered,
    calls,
    onCsrfRefreshed,
    onSessionExpired,
    onHouseholdAccessChanged,
    onAccountListCommitted,
    rerenderWithAccountSignal,
  };
}

function listPage(items: FinancialAccount[]) {
  return jsonResponse({ items, limit: 100, offset: 0, hasMore: false });
}

describe('private account list', () => {
  it('lists own accounts with exact kind, currency, and status labels', async () => {
    renderSection({ accountsGet: () => listPage([account(), CASH_ACCOUNT]) });

    await screen.findByText('Daily spending');
    expect(screen.getByText('Pocket cash')).toBeInTheDocument();
    expect(
      screen.getByText(/Checking · BRL · Manual · Active/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Cash · USD · Manual · Archived/),
    ).toBeInTheDocument();
    // Privacy and no-balance messaging is textual, never color-only.
    expect(screen.getByText('Account details private')).toBeInTheDocument();
    expect(screen.getByText('Private to you')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Other household members, including owners, cannot see these account names or details/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/No bank balance is inferred/)).toBeInTheDocument();
    expect(screen.getAllByText('Private')).toHaveLength(2);
    expect(screen.getByRole('list', { name: 'Your private accounts' }));
    expect(
      screen.getByRole('button', { name: 'Make Pocket cash active' }),
    ).toBeInTheDocument();
    expect(
      screen
        .getByText('Pocket cash')
        .closest('li')
        ?.classList.contains('finance-account-card--archived'),
    ).toBe(true);
  });

  it('labels admitted connected accounts without changing manual behavior', async () => {
    renderSection({
      accountsGet: () =>
        listPage([
          account(),
          account({
            id: '10000000-0000-4000-8000-000000000009',
            name: 'Everyday Chequing',
            kind: 'CHECKING',
            currency: 'CAD',
            source: 'CONNECTED',
          }),
        ]),
    });

    await screen.findByText('Daily spending');
    expect(screen.getByText('Everyday Chequing')).toBeInTheDocument();
    expect(
      screen.getByText(/Checking · CAD · Connected · Active/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Checking · BRL · Manual · Active/),
    ).toBeInTheDocument();
  });
});

describe('sibling account-list refresh', () => {
  const CONNECTED_ID = '10000000-0000-4000-8000-000000000009';
  const connectedAccount = () =>
    account({
      id: CONNECTED_ID,
      name: 'Everyday Chequing',
      kind: 'CHECKING',
      currency: 'CAD',
      source: 'CONNECTED',
    });

  const accountsUrl = `/api/households/${HOUSEHOLD.id}/financial-accounts?limit=100&offset=0&status=ALL`;
  const getCalls = (calls: Call[]) =>
    calls.filter(({ url }) => url === accountsUrl);

  it('shows a sibling-committed connected account without discarding the create draft', async () => {
    let visibleAccounts: FinancialAccount[] = [account()];
    const { calls, rerenderWithAccountSignal } = renderSection({
      accountsGet: () => listPage([...visibleAccounts]),
    });
    await screen.findByText('Daily spending');

    // An in-progress manual create draft.
    fireEvent.change(screen.getByLabelText('Account name'), {
      target: { value: 'Draft fund' },
    });

    // The connections section admits a bank account; the parent bumps the
    // signal once that selection commits.
    visibleAccounts = [account(), connectedAccount()];
    act(() => {
      rerenderWithAccountSignal(1);
    });

    expect(await screen.findByText('Everyday Chequing')).toBeInTheDocument();
    expect(
      screen.getByText(/Checking · CAD · Connected · Active/),
    ).toBeInTheDocument();
    // No remount and no draft reset: the entered name survives the refresh.
    expect(screen.getByLabelText('Account name')).toHaveValue('Draft fund');
    expect(getCalls(calls)).toHaveLength(2);
  });

  it('keeps an open rename across a sibling refresh', async () => {
    let visibleAccounts: FinancialAccount[] = [account()];
    const { rerenderWithAccountSignal } = renderSection({
      accountsGet: () => listPage([...visibleAccounts]),
    });
    await screen.findByText('Daily spending');
    fireEvent.click(
      screen.getByRole('button', { name: 'Rename Daily spending' }),
    );
    const renameInput = screen.getByLabelText('Account name', {
      selector: `#finance-name-${CHECKING_ID}`,
    });
    fireEvent.change(renameInput, { target: { value: 'Groceries card' } });

    visibleAccounts = [account(), connectedAccount()];
    act(() => {
      rerenderWithAccountSignal(1);
    });

    await screen.findByText('Everyday Chequing');
    // The rename interaction stays open with its edit intact.
    expect(
      screen.getByRole('button', { name: 'Save name' }),
    ).toBeInTheDocument();
    expect(renameInput).toHaveValue('Groceries card');
  });

  it('defers a sibling refresh while creating and converges after', async () => {
    let visibleAccounts: FinancialAccount[] = [account()];
    let resolvePost!: (response: Response) => void;
    const postGate = new Promise<Response>((resolve) => {
      resolvePost = resolve;
    });
    const { calls, rerenderWithAccountSignal } = renderSection({
      accountsGet: () => listPage([...visibleAccounts]),
      accountsPost: () => postGate,
    });
    await screen.findByText('Daily spending');
    fireEvent.change(screen.getByLabelText('Account name'), {
      target: { value: 'Pocket cash' },
    });
    fireEvent.change(screen.getByLabelText('Account type'), {
      target: { value: 'CASH' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Add private account' }),
    );

    // A sibling commits while the manual create is in flight: the signal
    // parks instead of racing the mutation's local rows.
    visibleAccounts = [account(), connectedAccount()];
    act(() => {
      rerenderWithAccountSignal(1);
    });
    expect(getCalls(calls)).toHaveLength(1);

    const created = account({
      id: CASH_ID,
      name: 'Pocket cash',
      kind: 'CASH',
      currency: 'USD',
    });
    visibleAccounts = [account(), created, connectedAccount()];
    await act(async () => {
      resolvePost(jsonResponse(created, 201));
    });
    expect(
      await screen.findByText('Private account “Pocket cash” is ready.'),
    ).toBeInTheDocument();
    // The parked signal serves after the mutation settles: both the created
    // manual account and the admitted connected account converge.
    await screen.findByText('Everyday Chequing');
    expect(screen.getByText('Pocket cash')).toBeInTheDocument();
    await waitFor(() => expect(getCalls(calls)).toHaveLength(2));
  });

  it('orders equal-instant accounts by identifier, not by locale', async () => {
    // Same createdAt, served in reverse identifier order: the display order
    // must be deterministic (bytewise UUID), never locale-sensitive.
    renderSection({ accountsGet: () => listPage([CASH_ACCOUNT, account()]) });

    await screen.findByText('Pocket cash');
    const list = screen.getByRole('list', { name: 'Your private accounts' });
    const names = within(list)
      .getAllByText(/Daily spending|Pocket cash/)
      .map((element) => element.textContent);
    expect(names).toEqual(['Daily spending', 'Pocket cash']);
  });

  it('keeps the empty state free of synthetic balances', async () => {
    renderSection({ accountsGet: () => listPage([]) });

    expect(await screen.findByText('No accounts yet.')).toBeInTheDocument();
    // No amount, no balance label, and no inferred number may appear.
    expect(document.body.textContent).not.toMatch(/\d+\.\d{2}/);
    expect(screen.queryByText(/balance:/i)).toBeNull();
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
    // Without a confirmed list, creation stays unavailable.
    expect(
      screen.queryByRole('button', { name: 'Add private account' }),
    ).toBeNull();
  });
});

describe('private account creation', () => {
  it('creates with an explicit type and currency and one fresh key', async () => {
    const { calls } = renderSection({
      accountsGet: () => listPage([]),
      accountsPost: () =>
        jsonResponse(account({ kind: 'CASH', currency: 'USD' }), 201),
    });
    await screen.findByText('No accounts yet.');

    fireEvent.change(screen.getByLabelText('Account name'), {
      target: { value: 'Daily spending' },
    });
    fireEvent.change(screen.getByLabelText('Account type'), {
      target: { value: 'CASH' },
    });
    fireEvent.change(screen.getByLabelText('Currency'), {
      target: { value: 'USD' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Add private account' }),
    );

    expect(
      await screen.findByText('Private account “Daily spending” is ready.'),
    ).toBeInTheDocument();
    const posts = postCalls(calls);
    expect(posts).toHaveLength(1);
    const key = posts[0]?.init?.headers as Record<string, string>;
    expect(key['Idempotency-Key']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(JSON.parse(String(posts[0]?.init?.body))).toEqual({
      name: 'Daily spending',
      kind: 'CASH',
      currency: 'USD',
    });
    expect(screen.getByLabelText('Account name')).toHaveValue('');
    expect(screen.getByText('Daily spending')).toBeInTheDocument();
  });

  it('reports a committed creation to the sibling selector signal', async () => {
    const onAccountListCommitted = vi.fn();
    renderSection(
      {
        accountsGet: () => listPage([]),
        accountsPost: () =>
          jsonResponse(account({ kind: 'CASH', currency: 'USD' }), 201),
      },
      { onAccountListCommitted },
    );
    await screen.findByText('No accounts yet.');

    fireEvent.change(screen.getByLabelText('Account name'), {
      target: { value: 'Daily spending' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Add private account' }),
    );

    expect(
      await screen.findByText('Private account “Daily spending” is ready.'),
    ).toBeInTheDocument();
    expect(onAccountListCommitted).toHaveBeenCalledTimes(1);
  });

  it('never signals on an unknown outcome, then signals on the committed retry', async () => {
    let attempts = 0;
    const onAccountListCommitted = vi.fn();
    renderSection(
      {
        accountsGet: () => listPage([]),
        accountsPost: () => {
          attempts += 1;
          if (attempts === 1) {
            return jsonResponse(
              {
                code: 'FINANCE_BUSY',
                message: 'The household is busy; outcome may be unknown.',
                correlationId: 'corr-busy',
              },
              503,
            );
          }
          return jsonResponse(account({ kind: 'CASH', currency: 'USD' }), 201);
        },
      },
      { onAccountListCommitted },
    );
    await screen.findByText('No accounts yet.');
    fireEvent.change(screen.getByLabelText('Account name'), {
      target: { value: 'Daily spending' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Add private account' }),
    );

    expect(await screen.findByText(/unknown outcome/i)).toBeInTheDocument();
    expect(onAccountListCommitted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
    expect(
      await screen.findByText('Private account “Daily spending” is ready.'),
    ).toBeInTheDocument();
    expect(onAccountListCommitted).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty name without any request', async () => {
    const { calls } = renderSection({ accountsGet: () => listPage([]) });
    await screen.findByText('No accounts yet.');

    fireEvent.click(
      screen.getByRole('button', { name: 'Add private account' }),
    );

    expect(await screen.findByText('Enter an account name.')).toBeVisible();
    expect(postCalls(calls)).toHaveLength(0);
  });

  it('preserves the entered name through a server field error', async () => {
    const { calls } = renderSection({
      accountsGet: () => listPage([]),
      accountsPost: () =>
        jsonResponse(
          {
            code: 'VALIDATION_FAILED',
            message: 'Check the highlighted fields.',
            correlationId: 'corr-field',
            fieldErrors: {
              name: 'That account name is not accepted.',
            },
          },
          400,
        ),
    });
    await screen.findByText('No accounts yet.');
    fireEvent.change(screen.getByLabelText('Account name'), {
      target: { value: 'Daily spending' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Add private account' }),
    );

    expect(
      await screen.findByText('That account name is not accepted.'),
    ).toBeVisible();
    expect(screen.getByLabelText('Account name')).toHaveValue('Daily spending');
    expect(screen.getByText('Reference: corr-field')).toBeInTheDocument();
    // A known rejection frees the form for an explicit new attempt.
    expect(screen.getByLabelText('Account name')).toBeEnabled();
    expect(postCalls(calls)).toHaveLength(1);
  });

  it('retries an unknown outcome with the exact same key', async () => {
    let attempts = 0;
    const { calls } = renderSection({
      accountsGet: () => listPage([]),
      accountsPost: () => {
        attempts += 1;
        if (attempts === 1) {
          return jsonResponse(
            {
              code: 'FINANCE_BUSY',
              message: 'The household is busy; outcome may be unknown.',
              correlationId: 'corr-busy',
            },
            503,
          );
        }
        return jsonResponse(account({ kind: 'CASH', currency: 'USD' }), 201);
      },
    });
    await screen.findByText('No accounts yet.');
    fireEvent.change(screen.getByLabelText('Account name'), {
      target: { value: 'Daily spending' },
    });
    fireEvent.change(screen.getByLabelText('Account type'), {
      target: { value: 'CASH' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Add private account' }),
    );

    expect(await screen.findByText(/unknown outcome/i)).toBeInTheDocument();
    // The failed attempt must not clear the retained request: the form
    // stays disabled so the payload cannot be edited under the live key.
    expect(screen.getByLabelText('Account name')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Retry same request' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
    expect(
      await screen.findByText('Private account “Daily spending” is ready.'),
    ).toBeInTheDocument();

    const posts = postCalls(calls);
    expect(posts).toHaveLength(2);
    const firstKey = (posts[0]?.init?.headers as Record<string, string>)[
      'Idempotency-Key'
    ];
    const secondKey = (posts[1]?.init?.headers as Record<string, string>)[
      'Idempotency-Key'
    ];
    expect(secondKey).toBe(firstKey);
    expect(JSON.parse(String(posts[1]?.init?.body))).toEqual(
      JSON.parse(String(posts[0]?.init?.body)),
    );
  });

  it('treats a network failure as an unknown outcome too', async () => {
    const { calls } = renderSection({
      accountsGet: () => listPage([]),
      accountsPost: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await screen.findByText('No accounts yet.');
    fireEvent.change(screen.getByLabelText('Account name'), {
      target: { value: 'Daily spending' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Add private account' }),
    );

    expect(await screen.findByText(/unknown outcome/i)).toBeInTheDocument();
    expect(postCalls(calls)).toHaveLength(1);
  });

  it('refreshes the token and requires an explicit same-key retry after CSRF rejection', async () => {
    let attempts = 0;
    const { calls, onCsrfRefreshed } = renderSection({
      accountsGet: () => listPage([]),
      accountsPost: () => {
        attempts += 1;
        if (attempts === 1) {
          return jsonResponse(
            { code: 'CSRF_INVALID', message: 'Security check failed.' },
            403,
          );
        }
        return jsonResponse(account(), 201);
      },
    });
    await screen.findByText('No accounts yet.');
    fireEvent.change(screen.getByLabelText('Account name'), {
      target: { value: 'Daily spending' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Add private account' }),
    );

    expect(
      await screen.findByText(
        'Your security token was refreshed. Retry the same account request.',
      ),
    ).toBeInTheDocument();
    expect(onCsrfRefreshed).toHaveBeenCalledWith({
      token: 'csrf-token-2',
      headerName: 'X-CSRF-TOKEN',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
    expect(
      await screen.findByText('Private account “Daily spending” is ready.'),
    ).toBeInTheDocument();

    const posts = postCalls(calls);
    expect(posts).toHaveLength(2);
    expect(
      (posts[0]?.init?.headers as Record<string, string>)['X-CSRF-TOKEN'],
    ).toBe('csrf-token-1');
    expect(
      (posts[1]?.init?.headers as Record<string, string>)['X-CSRF-TOKEN'],
    ).toBe('csrf-token-2');
    const firstKey = (posts[0]?.init?.headers as Record<string, string>)[
      'Idempotency-Key'
    ];
    const secondKey = (posts[1]?.init?.headers as Record<string, string>)[
      'Idempotency-Key'
    ];
    expect(secondKey).toBe(firstKey);
  });

  it('ends the session recovery on an expired session', async () => {
    const { onSessionExpired } = renderSection({
      accountsGet: () =>
        jsonResponse(
          { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
          401,
        ),
    });
    // No local error is offered: the parent owns the sign-in-again flow and
    // unmounts this section, so the retained account data is dropped first.
    await waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Daily spending')).toBeNull();
  });

  it('reconciles lost household access from a generic household 404', async () => {
    const { onHouseholdAccessChanged } = renderSection({
      accountsGet: () =>
        jsonResponse(
          { code: 'HOUSEHOLD_NOT_FOUND', message: 'Household unavailable.' },
          404,
        ),
    });
    await waitFor(() =>
      expect(onHouseholdAccessChanged).toHaveBeenCalledTimes(1),
    );
    expect(screen.queryByText('Daily spending')).toBeNull();
  });

  it('clears the retained request when a create ends in session expiry', async () => {
    const { onSessionExpired } = renderSection({
      accountsGet: () => listPage([]),
      accountsPost: () =>
        jsonResponse(
          { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
          401,
        ),
    });
    await screen.findByText('No accounts yet.');
    fireEvent.change(screen.getByLabelText('Account name'), {
      target: { value: 'Daily spending' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Add private account' }),
    );

    await waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
    // A known terminal outcome frees the retained key: no durable retry
    // block survives the handover to the sign-in-again recovery.
    expect(
      screen.queryByRole('button', { name: 'Retry same request' }),
    ).toBeNull();
    expect(screen.queryByText('No accounts yet.')).toBeNull();
  });

  it('clears the retained request and reconciles on access loss from a create', async () => {
    const { onHouseholdAccessChanged } = renderSection({
      accountsGet: () => listPage([]),
      accountsPost: () =>
        jsonResponse(
          { code: 'HOUSEHOLD_NOT_FOUND', message: 'Household unavailable.' },
          404,
        ),
    });
    await screen.findByText('No accounts yet.');
    fireEvent.change(screen.getByLabelText('Account name'), {
      target: { value: 'Daily spending' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Add private account' }),
    );

    await waitFor(() =>
      expect(onHouseholdAccessChanged).toHaveBeenCalledTimes(1),
    );
    expect(
      screen.queryByRole('button', { name: 'Retry same request' }),
    ).toBeNull();
    // The stale household's finance section drops its data entirely.
    expect(
      screen.queryByRole('button', { name: 'Add private account' }),
    ).toBeNull();
  });

  it('guards duplicate create submissions before state flushes', async () => {
    let resolvePost!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolvePost = resolve;
    });
    const { calls } = renderSection({
      accountsGet: () => listPage([]),
      accountsPost: () => gate,
    });
    await screen.findByText('No accounts yet.');
    fireEvent.change(screen.getByLabelText('Account name'), {
      target: { value: 'Daily spending' },
    });
    const submit = screen.getByRole('button', { name: 'Add private account' });
    fireEvent.click(submit);
    // A second trigger in the same batch must not start another request.
    fireEvent.click(submit);
    resolvePost(jsonResponse(account(), 201));
    expect(
      await screen.findByText('Private account “Daily spending” is ready.'),
    ).toBeInTheDocument();
    expect(postCalls(calls)).toHaveLength(1);
  });

  it('keeps the retained same-key retry available across a deliberate refresh', async () => {
    let attempts = 0;
    const { calls } = renderSection({
      accountsGet: () => listPage([]),
      accountsPost: () => {
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
          : jsonResponse(account({ kind: 'CASH', currency: 'USD' }), 201);
      },
    });
    await screen.findByText('No accounts yet.');
    fireEvent.change(screen.getByLabelText('Account name'), {
      target: { value: 'Daily spending' },
    });
    fireEvent.change(screen.getByLabelText('Account type'), {
      target: { value: 'CASH' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Add private account' }),
    );
    expect(await screen.findByText(/unknown outcome/i)).toBeInTheDocument();

    // A deliberate refresh reconciles the list but must not strand the
    // retained request: the durable block survives the transient notice.
    fireEvent.click(screen.getByRole('button', { name: 'Refresh accounts' }));
    expect(await screen.findByText(/unknown result/i)).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry same request' });
    await waitFor(() => expect(retry).toBeEnabled());

    fireEvent.click(retry);
    expect(
      await screen.findByText('Private account “Daily spending” is ready.'),
    ).toBeInTheDocument();
    const posts = postCalls(calls);
    expect(posts).toHaveLength(2);
    expect(
      (posts[1]?.init?.headers as Record<string, string>)['Idempotency-Key'],
    ).toBe(
      (posts[0]?.init?.headers as Record<string, string>)['Idempotency-Key'],
    );
    expect(screen.queryByText(/unknown result/i)).toBeNull();
  });

  it('keeps the retained retry reachable when a later notice replaces the outcome notice', async () => {
    let attempts = 0;
    const { calls } = renderSection({
      accountsGet: () => listPage([account()]),
      accountsPost: () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse(
              { code: 'FINANCE_BUSY', message: 'Busy.', correlationId: 'c' },
              503,
            )
          : jsonResponse(account({ kind: 'CASH', currency: 'USD' }), 201);
      },
      accountsPatch: () =>
        jsonResponse(account({ name: 'Groceries card', version: 1 })),
    });
    await screen.findByText('Daily spending');
    fireEvent.change(screen.getByLabelText('Account name'), {
      target: { value: 'Daily spending' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Add private account' }),
    );
    expect(await screen.findByText(/unknown outcome/i)).toBeInTheDocument();

    // A successful rename produces a fresh notice; the durable block must
    // survive it untouched.
    fireEvent.click(
      screen.getByRole('button', { name: 'Rename Daily spending' }),
    );
    const renameInput = screen.getByLabelText('Account name', {
      selector: '#finance-name-10000000-0000-4000-8000-000000000001',
    });
    fireEvent.change(renameInput, { target: { value: 'Groceries card' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(
      await screen.findByText('Account renamed to “Groceries card”.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Retry same request' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
    expect(
      await screen.findByText('Private account “Daily spending” is ready.'),
    ).toBeInTheDocument();
    const posts = postCalls(calls);
    expect(posts).toHaveLength(2);
    expect(
      (posts[1]?.init?.headers as Record<string, string>)['Idempotency-Key'],
    ).toBe(
      (posts[0]?.init?.headers as Record<string, string>)['Idempotency-Key'],
    );
  });

  it('starts a fresh instance without the retained key after a keyed remount', async () => {
    let attempts = 0;
    const first = renderSection({
      accountsGet: () => listPage([]),
      accountsPost: () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse({ code: 'FINANCE_BUSY', message: 'Busy.' }, 503)
          : jsonResponse(account(), 201);
      },
    });
    await screen.findByText('No accounts yet.');
    fireEvent.change(screen.getByLabelText('Account name'), {
      target: { value: 'Daily spending' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Add private account' }),
    );
    expect(await screen.findByText(/unknown outcome/i)).toBeInTheDocument();
    const retainedKey = (
      postCalls(first.calls)[0]?.init?.headers as Record<string, string>
    )['Idempotency-Key'];
    first.unmount();

    // A fresh keyed instance (household switch or page reload) owns no
    // memory of the lost key and must never fabricate a retry.
    const second = renderSection({
      accountsGet: () => listPage([account()]),
      accountsPost: () => jsonResponse(account({ kind: 'CASH' }), 201),
    });
    expect(await screen.findByText('Daily spending')).toBeInTheDocument();
    expect(screen.queryByText(/unknown result/i)).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Retry same request' }),
    ).toBeNull();
    fireEvent.change(screen.getByLabelText('Account name'), {
      target: { value: 'Daily spending' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Add private account' }),
    );
    expect(
      await screen.findByText('Private account “Daily spending” is ready.'),
    ).toBeInTheDocument();
    const freshKey = (
      postCalls(second.calls)[0]?.init?.headers as Record<string, string>
    )['Idempotency-Key'];
    expect(freshKey).not.toBe(retainedKey);
  });
});

describe('rename and lifecycle', () => {
  it('renames with the expected version and shows the result', async () => {
    const { calls } = renderSection({
      accountsGet: () => listPage([account()]),
      accountsPatch: (accountId) => {
        expect(accountId).toBe(CHECKING_ID);
        return jsonResponse(account({ name: 'Groceries card', version: 1 }));
      },
    });
    await screen.findByText('Daily spending');

    fireEvent.click(
      screen.getByRole('button', { name: 'Rename Daily spending' }),
    );
    const renameInput = screen.getByLabelText('Account name', {
      selector: '#finance-name-10000000-0000-4000-8000-000000000001',
    });
    fireEvent.change(renameInput, { target: { value: 'Groceries card' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));

    expect(
      await screen.findByText('Account renamed to “Groceries card”.'),
    ).toBeInTheDocument();
    const patches = patchCalls(calls);
    expect(patches).toHaveLength(1);
    expect(JSON.parse(String(patches[0]?.init?.body))).toEqual({
      expectedVersion: 0,
      name: 'Groceries card',
    });
    expect(screen.getByText('Groceries card')).toBeInTheDocument();
  });

  it('maps server rename field errors onto the open form without a refresh', async () => {
    const { calls } = renderSection({
      accountsGet: () => listPage([account()]),
      accountsPatch: (accountId) => {
        expect(accountId).toBe(CHECKING_ID);
        return jsonResponse(
          {
            code: 'VALIDATION_FAILED',
            message: 'Check the highlighted fields.',
            correlationId: 'corr-rename',
            fieldErrors: { name: 'That account name is not accepted.' },
          },
          400,
        );
      },
    });
    await screen.findByText('Daily spending');

    fireEvent.click(
      screen.getByRole('button', { name: 'Rename Daily spending' }),
    );
    const renameInput = screen.getByLabelText('Account name', {
      selector: '#finance-name-10000000-0000-4000-8000-000000000001',
    });
    fireEvent.change(renameInput, { target: { value: 'Groceries card' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));

    const form = renameInput.closest('form') as HTMLFormElement;
    const inlineError = await within(form).findByText(
      'That account name is not accepted.',
    );
    expect(inlineError).toBeVisible();
    // Safe input is preserved and associated with the error.
    expect(renameInput).toHaveValue('Groceries card');
    expect(renameInput).toHaveAttribute('aria-invalid', 'true');
    expect(renameInput.getAttribute('aria-describedby')).toBe(inlineError.id);
    // Pure validation: no refresh action, and the form stays open.
    expect(
      screen.queryByRole('button', { name: 'Refresh accounts' }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Save name' })).toBeEnabled();
    await waitFor(() => expect(renameInput).toHaveFocus());
    expect(patchCalls(calls)).toHaveLength(1);
  });

  it('drops a stale account row and offers refresh after a not-found patch', async () => {
    const { calls } = renderSection({
      accountsGet: () => listPage([account()]),
      accountsPatch: () =>
        jsonResponse(
          {
            code: 'FINANCIAL_ACCOUNT_NOT_FOUND',
            message: 'Account is unavailable.',
            correlationId: 'corr-404',
          },
          404,
        ),
    });
    await screen.findByText('Daily spending');

    fireEvent.click(
      screen.getByRole('button', { name: 'Archive Daily spending' }),
    );
    fireEvent.click(
      within(screen.getByRole('group')).getByRole('button', {
        name: 'Archive account',
      }),
    );

    expect(
      await screen.findByText(
        'This account is no longer available to you. Refresh accounts to see the current list.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Reference: corr-404')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Refresh accounts' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Daily spending')).toBeNull();
    expect(patchCalls(calls)).toHaveLength(1);
  });

  it('archives and unarchives through an explicit confirmation', async () => {
    let status: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE';
    const { calls } = renderSection({
      accountsGet: () =>
        listPage([
          account({ status: status === 'ACTIVE' ? 'ACTIVE' : 'ARCHIVED' }),
        ]),
      accountsPatch: (accountId) => {
        expect(accountId).toBe(CHECKING_ID);
        status = 'ARCHIVED';
        return jsonResponse(account({ status: 'ARCHIVED', version: 1 }));
      },
    });
    await screen.findByText('Daily spending');

    fireEvent.click(
      screen.getByRole('button', { name: 'Archive Daily spending' }),
    );
    const panel = screen.getByRole('group', {
      name: 'Confirm status change for Daily spending',
    });
    expect(panel).toHaveFocus();
    expect(
      within(panel).getByText(/keeps its recorded history/),
    ).toBeInTheDocument();

    fireEvent.click(
      within(panel).getByRole('button', { name: 'Archive account' }),
    );
    expect(
      await screen.findByText(
        '“Daily spending” archived. Its history is preserved.',
      ),
    ).toBeInTheDocument();
    const patches = patchCalls(calls);
    expect(patches).toHaveLength(1);
    expect(JSON.parse(String(patches[0]?.init?.body))).toEqual({
      expectedVersion: 0,
      status: 'ARCHIVED',
    });
  });

  it('reports a committed archive to the sibling selector signal', async () => {
    const onAccountListCommitted = vi.fn();
    renderSection(
      {
        accountsGet: () => listPage([account()]),
        accountsPatch: () =>
          jsonResponse(account({ status: 'ARCHIVED', version: 1 })),
      },
      { onAccountListCommitted },
    );
    await screen.findByText('Daily spending');

    fireEvent.click(
      screen.getByRole('button', { name: 'Archive Daily spending' }),
    );
    const panel = screen.getByRole('group', {
      name: 'Confirm status change for Daily spending',
    });
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Archive account' }),
    );

    expect(
      await screen.findByText(
        '“Daily spending” archived. Its history is preserved.',
      ),
    ).toBeInTheDocument();
    expect(onAccountListCommitted).toHaveBeenCalledTimes(1);
  });

  it('unarchives after the preserved-history explanation', async () => {
    renderSection({
      accountsGet: () => listPage([CASH_ACCOUNT]),
      accountsPatch: (accountId) => {
        expect(accountId).toBe(CASH_ID);
        return jsonResponse(
          account({
            id: CASH_ID,
            name: 'Pocket cash',
            kind: 'CASH',
            currency: 'USD',
            status: 'ACTIVE',
            version: 1,
          }),
        );
      },
    });
    await screen.findByText('Pocket cash');

    fireEvent.click(
      screen.getByRole('button', { name: 'Make Pocket cash active' }),
    );
    const panel = screen.getByRole('group', {
      name: 'Confirm status change for Pocket cash',
    });
    expect(within(panel).getByText(/recorded history stays untouched/));
    fireEvent.click(within(panel).getByRole('button', { name: 'Make active' }));

    expect(
      await screen.findByText('“Pocket cash” is active again.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Cash · USD · Manual · Active/),
    ).toBeInTheDocument();
  });

  it('cancels the confirmation with Escape and restores the trigger', async () => {
    const { calls } = renderSection({
      accountsGet: () => listPage([account()]),
    });
    await screen.findByText('Daily spending');

    const trigger = screen.getByRole('button', {
      name: 'Archive Daily spending',
    });
    fireEvent.click(trigger);
    const panel = screen.getByRole('group', {
      name: 'Confirm status change for Daily spending',
    });
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(
      screen.queryByRole('group', {
        name: 'Confirm status change for Daily spending',
      }),
    ).toBeNull();
    expect(trigger).toHaveFocus();
    expect(patchCalls(calls)).toHaveLength(0);
  });

  it('recovers from a stale version with a refresh suggestion', async () => {
    const { calls } = renderSection({
      accountsGet: () => listPage([account()]),
      accountsPatch: () =>
        jsonResponse(
          {
            code: 'RESOURCE_VERSION_CONFLICT',
            message: 'The account changed; refresh before retrying.',
            correlationId: 'corr-stale',
          },
          409,
        ),
    });
    await screen.findByText('Daily spending');

    fireEvent.click(
      screen.getByRole('button', { name: 'Archive Daily spending' }),
    );
    fireEvent.click(
      within(screen.getByRole('group')).getByRole('button', {
        name: 'Archive account',
      }),
    );
    expect(
      await screen.findByText(
        'The account may have changed. Refresh accounts before retrying.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Reference: corr-stale')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Refresh accounts' }),
    ).toBeInTheDocument();
    expect(patchCalls(calls)).toHaveLength(1);
  });

  it('keeps every financial control unavailable until authority is confirmed', async () => {
    renderSection(
      {
        accountsGet: () => listPage([account()]),
      },
      { authorityConfirmed: false },
    );
    expect(
      await screen.findByText(
        'Refresh the household before changing financial accounts.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Account name')).toBeDisabled();
    expect(screen.getByLabelText('Account type')).toBeDisabled();
    expect(screen.getByLabelText('Currency')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Add private account' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Rename Daily spending' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Archive Daily spending' }),
    ).toBeDisabled();
  });
});

describe('cancellation safety', () => {
  it('aborts the list request on unmount', async () => {
    stubFetch({
      accountsGet: () => new Promise<Response>(() => {}),
    });
    const { unmount } = render(
      <FinancialAccountsSection
        household={HOUSEHOLD}
        csrf={CSRF}
        onCsrfRefreshed={() => {}}
        onSessionExpired={() => {}}
        onHouseholdAccessChanged={() => {}}
        authorityConfirmed
      />,
    );
    await screen.findByText('Loading your financial accounts…');
    unmount();
    // No late-response state updates or crashes occur after unmount.
  });

  it('recovers from a canceled StrictMode setup request', async () => {
    stubFetch({ accountsGet: () => listPage([account()]) });
    render(
      <StrictMode>
        <FinancialAccountsSection
          household={HOUSEHOLD}
          csrf={CSRF}
          onCsrfRefreshed={() => {}}
          onSessionExpired={() => {}}
          onHouseholdAccessChanged={() => {}}
          authorityConfirmed
        />
      </StrictMode>,
    );
    expect(await screen.findByText('Daily spending')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Add private account' }),
    ).not.toBeDisabled();
  });
});
