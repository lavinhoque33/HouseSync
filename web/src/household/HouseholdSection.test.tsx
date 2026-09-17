import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AuthSection } from '../auth/AuthSection';
import { HouseholdSection } from './HouseholdSection';
import { validateHouseholdName } from '../auth/validation';

const CSRF = { token: 'csrf-token-1', headerName: 'X-CSRF-TOKEN' };
const CSRF_FRESH = { token: 'csrf-token-2', headerName: 'X-CSRF-TOKEN' };
const USER = {
  id: '11111111-2222-4333-8444-555555555555',
  email: 'person@example.test',
};
const LONG_PASSWORD = 'correct horse battery staple extra';
const HOUSEHOLD_1 = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  name: 'Elm Street home',
  role: 'OWNER',
  createdAt: '2026-09-13T01:30:00Z',
};
const HOUSEHOLD_2 = {
  id: 'ffffffff-1111-4222-8333-444444444444',
  name: 'Lake cabin',
  role: 'MEMBER',
  createdAt: '2026-09-13T02:30:00Z',
};
const USER_MEMBER = {
  userId: USER.id,
  email: USER.email,
  role: 'OWNER' as const,
};
const OTHER_MEMBER = {
  userId: '22222222-3333-4444-8555-666666666666',
  email: 'member@example.test',
  role: 'MEMBER' as const,
};

const CATEGORY_ITEMS = [
  { code: 'HOUSING', label: 'Housing' },
  { code: 'GROCERIES', label: 'Food shopping' },
  { code: 'DINING', label: 'Dining' },
  { code: 'UTILITIES', label: 'Utilities' },
  { code: 'TRANSPORTATION', label: 'Transportation' },
  { code: 'SHOPPING', label: 'Shopping' },
  { code: 'ENTERTAINMENT', label: 'Entertainment' },
  { code: 'HEALTHCARE', label: 'Healthcare' },
  { code: 'TRAVEL', label: 'Travel' },
  { code: 'EDUCATION', label: 'Education' },
  { code: 'PERSONAL', label: 'Personal' },
  { code: 'HOUSEHOLD_SUPPLIES', label: 'Household supplies' },
  { code: 'SUBSCRIPTIONS', label: 'Subscriptions' },
  { code: 'INCOME', label: 'Income' },
  { code: 'TRANSFERS', label: 'Transfers' },
  { code: 'MISCELLANEOUS', label: 'Miscellaneous' },
];

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return headers === undefined
    ? Response.json(body, { status })
    : Response.json(body, { status, headers });
}

function csrfOk() {
  return jsonResponse(CSRF);
}

function meAnonymous() {
  return jsonResponse(
    { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
    401,
  );
}

function meAuthenticated() {
  return jsonResponse(USER);
}

function householdsOk(list: unknown[] = []) {
  return jsonResponse({ households: list });
}

interface RouteHandlers {
  csrf?: () => Response | Promise<Response>;
  me?: () => Response | Promise<Response>;
  login?: (body?: unknown) => Response | Promise<Response>;
  logout?: () => Response | Promise<Response>;
  householdsGet?: () => Response | Promise<Response>;
  householdsPost?: (body?: unknown) => Response | Promise<Response>;
  membersGet?: (householdId?: string) => Response | Promise<Response>;
  membersPatch?: (
    householdId?: string,
    userId?: string,
    body?: unknown,
  ) => Response | Promise<Response>;
  membersDelete?: (
    householdId?: string,
    userId?: string,
  ) => Response | Promise<Response>;
  leavePost?: (householdId?: string) => Response | Promise<Response>;
  invitationsGet?: (householdId?: string) => Response | Promise<Response>;
  invitationsPost?: (householdId?: string) => Response | Promise<Response>;
  invitationsDelete?: (
    householdId?: string,
    invitationId?: string,
  ) => Response | Promise<Response>;
  financialAccountsGet?: (householdId?: string) => Response | Promise<Response>;
  financialAccountsPost?: (
    householdId?: string,
  ) => Response | Promise<Response>;
  financialConnectionsGet?: (
    householdId?: string,
  ) => Response | Promise<Response>;
  transactionsGet?: (householdId?: string) => Response | Promise<Response>;
  categoriesGet?: () => Response | Promise<Response>;
  settingsGet?: (householdId?: string) => Response | Promise<Response>;
  summaryGet?: (householdId?: string) => Response | Promise<Response>;
}

function stubFetch(routes: RouteHandlers) {
  const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
  const mock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      if (url === '/api/auth/csrf') return routes.csrf?.() ?? csrfOk();
      if (url === '/api/auth/me') return routes.me?.() ?? meAnonymous();
      if (url === '/api/auth/login') {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        return (routes.login?.(body) ?? jsonResponse(USER)) as Response;
      }
      if (url === '/api/auth/logout') {
        return (routes.logout?.() ??
          new Response(null, { status: 204 })) as Response;
      }
      if (url === '/api/households' && (init?.method ?? 'GET') === 'GET') {
        if (!routes.householdsGet) {
          throw new Error('unexpected GET /api/households');
        }
        return routes.householdsGet();
      }
      if (url === '/api/households' && init?.method === 'POST') {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (!routes.householdsPost) {
          throw new Error('unexpected POST /api/households');
        }
        return routes.householdsPost(body);
      }
      const invitationMatch =
        /^\/api\/households\/([^/]+)\/invitations(?:\/([^/]+))?$/.exec(url);
      if (invitationMatch) {
        const householdId = decodeURIComponent(invitationMatch[1] ?? '');
        const invitationId =
          invitationMatch[2] === undefined
            ? undefined
            : decodeURIComponent(invitationMatch[2] ?? '');
        if ((init?.method ?? 'GET') === 'GET' && invitationId === undefined) {
          return (
            routes.invitationsGet?.(householdId) ??
            jsonResponse({ invitations: [] })
          );
        }
        if (init?.method === 'POST' && invitationId === undefined) {
          if (!routes.invitationsPost) {
            throw new Error('unexpected POST invitation');
          }
          return routes.invitationsPost(householdId);
        }
        if (init?.method === 'DELETE' && invitationId !== undefined) {
          if (!routes.invitationsDelete) {
            throw new Error('unexpected DELETE invitation');
          }
          return routes.invitationsDelete(householdId, invitationId);
        }
      }
      const membersMatch =
        /^\/api\/households\/([^/]+)\/members(?:\/([^/]+))?$/.exec(url);
      if (membersMatch) {
        const householdId = decodeURIComponent(membersMatch[1] ?? '');
        const userId =
          membersMatch[2] === undefined
            ? undefined
            : decodeURIComponent(membersMatch[2] ?? '');
        if ((init?.method ?? 'GET') === 'GET' && userId === undefined) {
          return (
            routes.membersGet?.(householdId) ?? jsonResponse({ members: [] })
          );
        }
        if (init?.method === 'PATCH' && userId !== undefined) {
          if (!routes.membersPatch) throw new Error('unexpected PATCH member');
          const body = init?.body ? JSON.parse(String(init.body)) : undefined;
          return routes.membersPatch(householdId, userId, body);
        }
        if (init?.method === 'DELETE' && userId !== undefined) {
          if (!routes.membersDelete) {
            throw new Error('unexpected DELETE member');
          }
          return routes.membersDelete(householdId, userId);
        }
      }
      const leaveMatch = /^\/api\/households\/([^/]+)\/leave$/.exec(url);
      if (leaveMatch && init?.method === 'POST') {
        if (!routes.leavePost) throw new Error('unexpected POST leave');
        return routes.leavePost(decodeURIComponent(leaveMatch[1] ?? ''));
      }
      const financeMatch =
        /^\/api\/households\/([^/]+)\/financial-accounts(?:\/([^/?]+))?(?:\?.*)?$/.exec(
          url,
        );
      if (financeMatch) {
        const householdId = decodeURIComponent(financeMatch[1] ?? '');
        if (init?.method === 'POST' && financeMatch[2] === undefined) {
          if (!routes.financialAccountsPost) {
            throw new Error('unexpected POST financial-accounts');
          }
          return routes.financialAccountsPost(householdId);
        }
        if (
          (init?.method ?? 'GET') === 'GET' &&
          financeMatch[2] === undefined
        ) {
          return (
            routes.financialAccountsGet?.(householdId) ??
            jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false })
          );
        }
      }
      const connectionsMatch =
        /^\/api\/households\/([^/]+)\/financial-connections(?:\/([^/?]+))?(?:\?.*)?$/.exec(
          url,
        );
      if (connectionsMatch && (init?.method ?? 'GET') === 'GET') {
        return (
          routes.financialConnectionsGet?.(
            decodeURIComponent(connectionsMatch[1] ?? ''),
          ) ??
          jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false })
        );
      }
      const transactionsMatch =
        /^\/api\/households\/([^/]+)\/transactions/.exec(url);
      if (transactionsMatch) {
        return (
          routes.transactionsGet?.(
            decodeURIComponent(transactionsMatch[1] ?? ''),
          ) ??
          jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false })
        );
      }
      if (/\/transaction-categories$/.test(url)) {
        return routes.categoriesGet?.() ?? jsonResponse({ items: [] });
      }
      const settingsMatch =
        /^\/api\/households\/([^/]+)\/finance-settings$/.exec(url);
      if (settingsMatch) {
        return (
          routes.settingsGet?.(decodeURIComponent(settingsMatch[1] ?? '')) ??
          jsonResponse({ reportingTimeZone: 'Etc/UTC', version: 0 })
        );
      }
      const summaryMatch =
        /^\/api\/households\/([^/]+)\/spending-summary\?from=([^&]*)&to=([^&]*)$/.exec(
          url,
        );
      if (summaryMatch) {
        const householdId = decodeURIComponent(summaryMatch[1] ?? '');
        const from = decodeURIComponent(summaryMatch[2] ?? '');
        const to = decodeURIComponent(summaryMatch[3] ?? '');
        return (
          routes.summaryGet?.(householdId) ??
          jsonResponse({
            from,
            to,
            reportingTimeZone: 'Etc/UTC',
            currencies: [],
          })
        );
      }
      throw new Error(`unexpected fetch ${url} ${init?.method ?? ''}`);
    },
  );
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

function householdCalls(
  calls: Array<{ url: string; init?: RequestInit | undefined }>,
  method?: string,
) {
  return calls.filter(
    ({ url, init }) =>
      url === '/api/households' &&
      (method === undefined || (init?.method ?? 'GET') === method),
  );
}

function typeInto(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function clickLastButton(name: string | RegExp) {
  const buttons = screen.getAllByRole('button', { name });
  const target = buttons[buttons.length - 1];
  if (!target) throw new Error('button not found');
  fireEvent.click(target);
}

async function signIn(
  email: string = USER.email,
  password: string = LONG_PASSWORD,
) {
  typeInto('Email', email);
  typeInto('Password', password);
  clickLastButton('Sign in');
}

describe('transaction section integration', () => {
  it('mounts a keyed private-transaction section inside each household card', async () => {
    stubFetch({
      csrf: csrfOk,
      me: meAuthenticated,
      householdsGet: () => householdsOk([HOUSEHOLD_1]),
      financialAccountsGet: () =>
        jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false }),
      transactionsGet: () =>
        jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false }),
      categoriesGet: () => jsonResponse({ items: CATEGORY_ITEMS }),
    });
    render(<AuthSection />);
    expect(await screen.findByText('Elm Street home')).toBeInTheDocument();
    expect(await screen.findByText('No transactions yet.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Transactions' })).toBeVisible();
    expect(
      screen.getByRole('radio', { name: 'My transactions' }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Record transaction' }),
    ).toBeEnabled();
  });
});

describe('manual account to transaction selector propagation', () => {
  function financeSection(signal: number) {
    return (
      <HouseholdSection
        csrf={CSRF}
        onCsrfRefreshed={() => {}}
        onSessionExpired={() => {}}
        refreshSignal={signal}
        currentUserId={USER.id}
      />
    );
  }

  it('shows a committed manual account in the selector without losing the draft', async () => {
    const checking = {
      id: '10000000-0000-4000-8000-000000000001',
      householdId: HOUSEHOLD_1.id,
      ownerUserId: USER.id,
      name: 'Daily spending',
      kind: 'CHECKING',
      currency: 'BRL',
      source: 'MANUAL',
      visibility: 'PRIVATE',
      status: 'ACTIVE',
      version: 0,
      createdAt: '2026-09-16T12:00:00Z',
      updatedAt: '2026-09-16T12:00:00Z',
    };
    const created = {
      ...checking,
      id: '10000000-0000-4000-8000-000000000002',
      name: 'Holiday fund',
    };
    let committed = false;
    stubFetch({
      householdsGet: () => householdsOk([HOUSEHOLD_1]),
      financialAccountsGet: () =>
        jsonResponse({
          items: committed ? [checking, created] : [checking],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
      financialAccountsPost: () => {
        committed = true;
        return jsonResponse(created, 201);
      },
      transactionsGet: () =>
        jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false }),
      categoriesGet: () => jsonResponse({ items: CATEGORY_ITEMS }),
    });
    render(financeSection(0));

    expect(await screen.findByText('Daily spending')).toBeInTheDocument();
    expect(await screen.findByText('No transactions yet.')).toBeInTheDocument();

    // Start an in-progress transaction draft against the known account.
    fireEvent.change(screen.getByLabelText('Account'), {
      target: { value: checking.id },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '12.34' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Draft groceries' },
    });

    // Commit a manual account in the sibling section.
    fireEvent.change(screen.getByLabelText('Account name'), {
      target: { value: 'Holiday fund' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Add private account' }),
    );

    // The selector lists the new account with no manual refresh...
    expect(
      await screen.findByRole('option', { name: 'Holiday fund · BRL' }),
    ).toBeInTheDocument();
    // ...and the in-progress draft survives the background refresh.
    expect(screen.getByLabelText('Account')).toHaveValue(checking.id);
    expect(screen.getByLabelText('Amount')).toHaveValue('12.34');
    expect(screen.getByLabelText('Description')).toHaveValue('Draft groceries');
  });
});

describe('transaction section authority gating', () => {
  function transactionSection(signal: number) {
    return (
      <HouseholdSection
        csrf={CSRF}
        onCsrfRefreshed={() => {}}
        onSessionExpired={() => {}}
        refreshSignal={signal}
        currentUserId={USER.id}
      />
    );
  }

  it('gates transaction controls while the household list is stale', async () => {
    let gets = 0;
    stubFetch({
      csrf: csrfOk,
      householdsGet: () => {
        gets += 1;
        return gets === 1
          ? householdsOk([HOUSEHOLD_1])
          : jsonResponse(
              { code: 'NETWORK_ERROR', message: 'Could not reach the server.' },
              500,
            );
      },
      transactionsGet: () =>
        jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false }),
      categoriesGet: () => jsonResponse({ items: CATEGORY_ITEMS }),
    });
    const { rerender } = render(transactionSection(0));
    expect(
      await screen.findByRole('button', { name: 'Record transaction' }),
    ).toBeEnabled();

    rerender(transactionSection(1));
    expect(
      await screen.findByText(/Showing previously loaded households/),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Refresh the household before changing transactions.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Record transaction' }),
    ).toBeDisabled();
  });
});

describe('household name validation', () => {
  it('trims outer space but keeps interior content and bounds', () => {
    expect(validateHouseholdName('   ')).toBeDefined();
    expect(validateHouseholdName('Elm  Street home')).toBeUndefined();
    expect(validateHouseholdName(`  ${'a'.repeat(100)}  `)).toBeUndefined();
    expect(validateHouseholdName('a'.repeat(101))).toBeDefined();
    expect(validateHouseholdName('🙂'.repeat(100))).toBeUndefined();
    expect(validateHouseholdName('🙂'.repeat(101))).toBeDefined();
    expect(
      validateHouseholdName(`Home${String.fromCharCode(7)}bell`),
    ).toBeDefined();
    expect(validateHouseholdName('Lake cabin')).toBeUndefined();
  });
});

describe('signed-out suppression', () => {
  it('never requests households while signed out', async () => {
    const { calls } = stubFetch({ me: meAnonymous, csrf: csrfOk });
    render(<AuthSection />);
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Household name')).not.toBeInTheDocument();
    expect(householdCalls(calls)).toHaveLength(0);
  });
});

describe('household bootstrap', () => {
  it('shows a distinct loading state then the empty state', async () => {
    let resolveGet!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveGet = resolve;
    });
    stubFetch({
      csrf: csrfOk,
      me: meAuthenticated,
      householdsGet: () => gate,
    });
    render(<AuthSection />);
    expect(
      await screen.findByText('Loading your households…'),
    ).toBeInTheDocument();
    resolveGet(householdsOk([]));
    expect(
      await screen.findByText(/You do not belong to a household yet/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Household name')).toBeInTheDocument();
  });

  it('renders multiple authorized households with safe fields only', async () => {
    stubFetch({
      csrf: csrfOk,
      me: meAuthenticated,
      householdsGet: () => householdsOk([HOUSEHOLD_1, HOUSEHOLD_2]),
    });
    render(<AuthSection />);
    expect(await screen.findByText('Elm Street home')).toBeInTheDocument();
    expect(screen.getByText('Lake cabin')).toBeInTheDocument();
    expect(screen.getByText('Role: OWNER')).toBeInTheDocument();
    expect(screen.getByText('Role: MEMBER')).toBeInTheDocument();
    const times = screen.getAllByText('Created:');
    expect(times).toHaveLength(2);
    const rendered = document.querySelectorAll('time');
    expect(rendered).toHaveLength(2);
    expect(rendered[0]?.getAttribute('dateTime')).toBe(HOUSEHOLD_1.createdAt);
    expect(rendered[1]?.getAttribute('dateTime')).toBe(HOUSEHOLD_2.createdAt);
  });
});

describe('household creation', () => {
  it('sends a trimmed name-only body with CSRF and renders the result immediately', async () => {
    const { calls } = stubFetch({
      csrf: csrfOk,
      me: meAuthenticated,
      householdsGet: () => householdsOk([]),
      householdsPost: () => jsonResponse(HOUSEHOLD_1, 201),
    });
    render(<AuthSection />);
    expect(
      await screen.findByText(/You do not belong to a household yet/),
    ).toBeInTheDocument();
    typeInto('Household name', '  Elm Street home  ');
    clickLastButton('Create household');
    expect(await screen.findByText('Elm Street home')).toBeInTheDocument();
    const post = householdCalls(calls, 'POST');
    expect(post).toHaveLength(1);
    expect(post[0]?.init?.credentials).toBe('include');
    expect(post[0]?.init?.headers).toMatchObject({
      'X-CSRF-TOKEN': CSRF.token,
    });
    expect(JSON.parse(String(post[0]?.init?.body))).toEqual({
      name: 'Elm Street home',
    });
    expect(screen.getByLabelText('Household name')).toHaveValue('');
    expect(
      screen.getByText(/Household “Elm Street home” created/),
    ).toBeInTheDocument();
  });

  it('rejects a blank name locally without a request and keeps focus semantics', async () => {
    const { calls } = stubFetch({
      csrf: csrfOk,
      me: meAuthenticated,
      householdsGet: () => householdsOk([]),
    });
    render(<AuthSection />);
    await screen.findByLabelText('Household name');
    typeInto('Household name', '   ');
    clickLastButton('Create household');
    expect(
      await screen.findByText('Enter a household name.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Household name')).toHaveValue('   ');
    expect(screen.getByLabelText('Household name')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(householdCalls(calls, 'POST')).toHaveLength(0);
  });

  it('rejects a 101-code-point name locally without a request', async () => {
    const { calls } = stubFetch({
      csrf: csrfOk,
      me: meAuthenticated,
      householdsGet: () => householdsOk([]),
    });
    render(<AuthSection />);
    await screen.findByLabelText('Household name');
    const longName = 'a'.repeat(101);
    typeInto('Household name', longName);
    clickLastButton('Create household');
    expect(
      await screen.findByText(
        'Household name must be 100 characters or fewer.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Household name')).toHaveValue(longName);
    expect(householdCalls(calls, 'POST')).toHaveLength(0);
  });

  it('rejects control characters locally without a request', async () => {
    const { calls } = stubFetch({
      csrf: csrfOk,
      me: meAuthenticated,
      householdsGet: () => householdsOk([]),
    });
    render(<AuthSection />);
    await screen.findByLabelText('Household name');
    typeInto('Household name', `Home${String.fromCharCode(7)}bell`);
    clickLastButton('Create household');
    expect(
      await screen.findByText(
        'Household name must not contain control characters.',
      ),
    ).toBeInTheDocument();
    expect(householdCalls(calls, 'POST')).toHaveLength(0);
  });

  it('associates server field errors and preserves the safe input', async () => {
    stubFetch({
      csrf: csrfOk,
      me: meAuthenticated,
      householdsGet: () => householdsOk([]),
      householdsPost: () =>
        jsonResponse(
          {
            code: 'VALIDATION_FAILED',
            message: 'Check the supplied details.',
            correlationId: 'corr-1',
            fieldErrors: { name: 'Enter a household name.' },
          },
          400,
        ),
    });
    render(<AuthSection />);
    await screen.findByLabelText('Household name');
    typeInto('Household name', 'Elm Street home');
    clickLastButton('Create household');
    expect(
      await screen.findByText('Enter a household name.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Household name')).toHaveValue(
      'Elm Street home',
    );
    expect(document.querySelector('.household-list')).toBeNull();
  });

  it('guards duplicate submissions while creation is pending', async () => {
    let resolvePost!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolvePost = resolve;
    });
    const { calls } = stubFetch({
      csrf: csrfOk,
      me: meAuthenticated,
      householdsGet: () => householdsOk([]),
      householdsPost: () => gate,
    });
    render(<AuthSection />);
    await screen.findByLabelText('Household name');
    typeInto('Household name', 'Elm Street home');
    const button = screen.getByRole('button', { name: 'Create household' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled(),
    );
    expect(householdCalls(calls, 'POST')).toHaveLength(1);
    resolvePost(jsonResponse(HOUSEHOLD_1, 201));
    expect(await screen.findByText('Elm Street home')).toBeInTheDocument();
  });
});

describe('household recovery', () => {
  it('runs sign-in-again recovery and clears household UI on 401', async () => {
    stubFetch({
      csrf: csrfOk,
      me: meAuthenticated,
      householdsGet: () =>
        jsonResponse(
          { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
          401,
        ),
    });
    render(<AuthSection />);
    expect(
      await screen.findByText('Your session ended. Sign in again.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Households')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Household name')).not.toBeInTheDocument();
  });

  it('refreshes CSRF on rejection and requires an explicit retry without replay', async () => {
    let postCalls = 0;
    let csrfCalls = 0;
    const { calls } = stubFetch({
      csrf: () => {
        csrfCalls += 1;
        return jsonResponse(csrfCalls === 1 ? CSRF : CSRF_FRESH);
      },
      me: meAuthenticated,
      householdsGet: () => householdsOk([]),
      householdsPost: () => {
        postCalls += 1;
        if (postCalls === 1) {
          return jsonResponse(
            {
              code: 'CSRF_INVALID',
              message: 'Invalid CSRF token.',
              correlationId: 'corr-csrf',
            },
            403,
          );
        }
        return jsonResponse(HOUSEHOLD_1, 201);
      },
    });
    render(<AuthSection />);
    await screen.findByLabelText('Household name');
    typeInto('Household name', 'Elm Street home');
    clickLastButton('Create household');
    expect(
      await screen.findByText(/security token was refreshed/i),
    ).toBeInTheDocument();
    expect(postCalls).toBe(1);
    // The safe input is preserved for the explicit retry.
    expect(screen.getByLabelText('Household name')).toHaveValue(
      'Elm Street home',
    );
    clickLastButton('Create household');
    expect(await screen.findByText('Elm Street home')).toBeInTheDocument();
    expect(postCalls).toBe(2);
    const posts = householdCalls(calls, 'POST');
    expect(posts[1]?.init?.headers).toMatchObject({
      'X-CSRF-TOKEN': CSRF_FRESH.token,
    });
  });

  it('shows safe 500 errors with a correlation reference and list refresh', async () => {
    let getCalls = 0;
    stubFetch({
      csrf: csrfOk,
      me: meAuthenticated,
      householdsGet: () => {
        getCalls += 1;
        if (getCalls === 1) {
          return jsonResponse(
            {
              code: 'INTERNAL_ERROR',
              message: 'Something went wrong. Retry.',
              correlationId: 'corr-500',
            },
            500,
          );
        }
        return householdsOk([]);
      },
    });
    render(<AuthSection />);
    expect(
      await screen.findByText('Something went wrong. Retry.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Reference: corr-500')).toBeInTheDocument();
    // A network failure must not masquerade as signed-out.
    expect(screen.queryByText('Your session ended. Sign in again.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }));
    expect(
      await screen.findByText(/You do not belong to a household yet/),
    ).toBeInTheDocument();
  });

  it('reports an unknown outcome on create timeout and offers refresh without resubmitting', async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/auth/csrf') return csrfOk();
        if (url === '/api/auth/me') return meAuthenticated();
        if (url === '/api/households' && (init?.method ?? 'GET') === 'GET') {
          return householdsOk([HOUSEHOLD_1]);
        }
        if (url === '/api/households' && init?.method === 'POST') {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted.', 'AbortError'));
            });
          });
        }
        throw new Error(`unexpected ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<AuthSection />);
    await screen.findByLabelText('Household name');
    typeInto('Household name', 'Elm Street home');
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Create household' }));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(
      screen.getByText(/outcome is unknown — refresh the list/i),
    ).toBeInTheDocument();
    // The safe input is preserved and nothing was silently resubmitted.
    expect(screen.getByLabelText('Household name')).toHaveValue(
      'Elm Street home',
    );
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url) === '/api/households' &&
          (init as RequestInit | undefined)?.method === 'POST',
      ),
    ).toHaveLength(1);
    vi.useRealTimers();
    const refreshButtons = screen.getAllByRole('button', {
      name: 'Refresh list',
    });
    fireEvent.click(refreshButtons[refreshButtons.length - 1]!);
    // The refreshed list answers the unknown-outcome check: its notice is
    // cleared, while the safe name stays available for deliberate action.
    await waitFor(() =>
      expect(screen.queryByText(/outcome is unknown/i)).not.toBeInTheDocument(),
    );
    expect(screen.getByText('Elm Street home')).toBeInTheDocument();
    expect(screen.getByLabelText('Household name')).toHaveValue(
      'Elm Street home',
    );
  });
});

describe('household logout and lifecycle', () => {
  it('clears household state on logout and ignores a late list response', async () => {
    let resolveGet!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveGet = resolve;
    });
    stubFetch({
      csrf: csrfOk,
      me: meAuthenticated,
      householdsGet: () => gate,
      logout: () => new Response(null, { status: 204 }),
    });
    render(<AuthSection />);
    expect(
      await screen.findByText('Loading your households…'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Signed out.')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    resolveGet(householdsOk([HOUSEHOLD_1]));
    await act(async () => {});
    // The late household response cannot overwrite the signed-out state.
    expect(screen.queryByText('Elm Street home')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Household name')).not.toBeInTheDocument();
  });

  it('loads households after a confirmed sign-in without an earlier request', async () => {
    const { calls } = stubFetch({
      csrf: csrfOk,
      me: meAnonymous,
      householdsGet: () => householdsOk([HOUSEHOLD_1]),
    });
    render(<AuthSection />);
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    expect(householdCalls(calls)).toHaveLength(0);
    await signIn();
    expect(await screen.findByText('Elm Street home')).toBeInTheDocument();
    expect(screen.getByText('Role: OWNER')).toBeInTheDocument();
    expect(householdCalls(calls, 'GET').length).toBeGreaterThanOrEqual(1);
  });

  it('exits bootstrap and creates after a canceled StrictMode setup request', async () => {
    let csrfCalls = 0;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/auth/csrf') {
          csrfCalls += 1;
          if (csrfCalls === 1) {
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('Aborted.', 'AbortError'));
              });
            });
          }
          return csrfOk();
        }
        if (url === '/api/auth/me') return meAuthenticated();
        if (url === '/api/households' && (init?.method ?? 'GET') === 'GET') {
          return householdsOk([]);
        }
        if (url === '/api/households' && init?.method === 'POST') {
          return jsonResponse(HOUSEHOLD_1, 201);
        }
        throw new Error(`unexpected ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    render(
      <StrictMode>
        <AuthSection />
      </StrictMode>,
    );
    expect(
      await screen.findByText(/You do not belong to a household yet/),
    ).toBeInTheDocument();
    typeInto('Household name', 'Elm Street home');
    clickLastButton('Create household');
    expect(await screen.findByText('Elm Street home')).toBeInTheDocument();
  });

  it('applies no household updates after a true unmount', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let resolvePost!: (response: Response) => void;
      const gate = new Promise<Response>((resolve) => {
        resolvePost = resolve;
      });
      stubFetch({
        csrf: csrfOk,
        me: meAuthenticated,
        householdsGet: () => householdsOk([]),
        householdsPost: () => gate,
      });
      const { unmount } = render(<AuthSection />);
      await screen.findByLabelText('Household name');
      typeInto('Household name', 'Elm Street home');
      clickLastButton('Create household');
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Creating…' }),
        ).toBeInTheDocument(),
      );
      unmount();
      resolvePost(jsonResponse(HOUSEHOLD_1, 201));
      await act(async () => {});
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('household list gating', () => {
  it('hides creation until the initial list loads successfully', async () => {
    let getCalls = 0;
    stubFetch({
      csrf: csrfOk,
      me: meAuthenticated,
      householdsGet: () => {
        getCalls += 1;
        if (getCalls === 1) {
          return jsonResponse(
            {
              code: 'INTERNAL_ERROR',
              message: 'Something went wrong. Retry.',
              correlationId: 'corr-gate',
            },
            500,
          );
        }
        return householdsOk([]);
      },
    });
    render(<AuthSection />);
    expect(
      await screen.findByText('Something went wrong. Retry.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Household name')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Refresh list' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }));
    expect(
      await screen.findByText(/You do not belong to a household yet/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Household name')).toBeInTheDocument();
  });

  it('keeps a failed refresh stale with creation unavailable until recovery', async () => {
    let getCalls = 0;
    let postCalls = 0;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/auth/csrf') return csrfOk();
        if (url === '/api/auth/me') return meAuthenticated();
        if (url === '/api/households' && (init?.method ?? 'GET') === 'GET') {
          getCalls += 1;
          if (getCalls === 1) return householdsOk([HOUSEHOLD_1]);
          if (getCalls === 2) {
            return jsonResponse(
              {
                code: 'INTERNAL_ERROR',
                message: 'Something went wrong. Retry.',
                correlationId: 'corr-stale',
              },
              500,
            );
          }
          return householdsOk([HOUSEHOLD_1]);
        }
        if (url === '/api/households' && init?.method === 'POST') {
          postCalls += 1;
          if (postCalls === 1) {
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('Aborted.', 'AbortError'));
              });
            });
          }
          return jsonResponse(HOUSEHOLD_2, 201);
        }
        throw new Error(`unexpected ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<AuthSection />);
    expect(await screen.findByText('Elm Street home')).toBeInTheDocument();
    typeInto('Household name', 'Lake cabin');
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Create household' }));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(
      screen.getByText(/outcome is unknown — refresh the list/i),
    ).toBeInTheDocument();
    vi.useRealTimers();
    // Refresh through the timeout notice; the refresh fails.
    const staleRefresh = screen.getAllByRole('button', {
      name: 'Refresh list',
    });
    fireEvent.click(staleRefresh[staleRefresh.length - 1]!);
    expect(
      await screen.findByText('Something went wrong. Retry.'),
    ).toBeInTheDocument();
    // The previously loaded household stays visible but stale, and creation
    // is unavailable until the list recovers.
    expect(screen.getByText('Elm Street home')).toBeInTheDocument();
    expect(
      screen.getByText(
        /previously loaded households, which may be out of date/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Household name')).not.toBeInTheDocument();
    // Recover: the next refresh succeeds and creation returns.
    const recoverRefresh = screen.getAllByRole('button', {
      name: 'Refresh list',
    });
    fireEvent.click(recoverRefresh[recoverRefresh.length - 1]!);
    expect(await screen.findByLabelText('Household name')).toBeInTheDocument();
    expect(
      screen.queryByText(/previously loaded households/),
    ).not.toBeInTheDocument();
    typeInto('Household name', 'Lake cabin');
    clickLastButton('Create household');
    expect(await screen.findByText('Lake cabin')).toBeInTheDocument();
  });

  it('submits a 100-emoji name unchanged with no input length cap', async () => {
    const emojiName = '🙂'.repeat(100);
    const created = { ...HOUSEHOLD_1, name: emojiName };
    const { calls } = stubFetch({
      csrf: csrfOk,
      me: meAuthenticated,
      householdsGet: () => householdsOk([]),
      householdsPost: () => jsonResponse(created, 201),
    });
    render(<AuthSection />);
    const input = await screen.findByLabelText('Household name');
    expect(input).not.toHaveAttribute('maxlength');
    typeInto('Household name', emojiName);
    clickLastButton('Create household');
    expect(await screen.findByText(emojiName)).toBeInTheDocument();
    const posts = householdCalls(calls, 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]?.init?.body))).toEqual({
      name: emojiName,
    });
  });
});

describe('household ordering', () => {
  it('keeps an exact second before a later fractional second chronologically', async () => {
    const exact = {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1',
      name: 'Exact second',
      role: 'OWNER',
      createdAt: '2026-09-13T01:30:00Z',
    };
    const fractional = {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2',
      name: 'Fractional second',
      role: 'OWNER',
      createdAt: '2026-09-13T01:30:00.900Z',
    };
    stubFetch({
      csrf: csrfOk,
      me: meAuthenticated,
      householdsGet: () => householdsOk([exact, fractional]),
    });
    render(<AuthSection />);
    expect(await screen.findByText('Exact second')).toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Exact second');
    expect(items[1]).toHaveTextContent('Fractional second');
  });

  it('uses the household id to break equal timestamp ties', async () => {
    const earlierId = {
      ...HOUSEHOLD_1,
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1',
      name: 'Earlier id',
    };
    const laterId = {
      ...HOUSEHOLD_1,
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2',
      name: 'Later id',
    };
    stubFetch({
      csrf: csrfOk,
      me: meAuthenticated,
      householdsGet: () => householdsOk([laterId, earlierId]),
    });
    render(<AuthSection />);
    expect(await screen.findByText('Earlier id')).toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Earlier id');
    expect(items[1]).toHaveTextContent('Later id');
  });
});

describe('refresh signal queuing', () => {
  function renderSection(
    routes: {
      get: () => Promise<Response>;
      post?: () => Promise<Response>;
    },
    refreshSignal: number,
    onRefreshSettled: (signal: number) => void,
  ) {
    let getCalls = 0;
    const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        calls.push({ url, init });
        if (url === '/api/auth/csrf') return csrfOk();
        if (url === '/api/households' && (init?.method ?? 'GET') === 'GET') {
          getCalls += 1;
          return routes.get();
        }
        if (url === '/api/households' && init?.method === 'POST') {
          if (!routes.post) throw new Error('unexpected POST');
          return routes.post();
        }
        if (/\/members$/.test(url)) {
          return jsonResponse({ members: [] });
        }
        if (url.startsWith('/api/households/')) {
          return jsonResponse({ invitations: [] });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const rendered = render(
      <HouseholdSection
        csrf={CSRF}
        onCsrfRefreshed={() => {}}
        onSessionExpired={() => {}}
        refreshSignal={refreshSignal}
        onRefreshSettled={onRefreshSettled}
        currentUserId={USER.id}
      />,
    );
    const householdGets = () =>
      calls.filter(
        ({ url, init }) =>
          url === '/api/households' && (init?.method ?? 'GET') === 'GET',
      );
    return { ...rendered, householdGets, getCallCount: () => getCalls };
  }

  it('queues a signal arriving during the initial load and fetches again after it settles', async () => {
    let resolveFirst!: (response: Response) => void;
    const firstGate = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    let resolveSecond!: (response: Response) => void;
    const secondGate = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });
    let gateCalls = 0;
    const settled = vi.fn();
    const { rerender, householdGets } = renderSection(
      {
        get: () => {
          gateCalls += 1;
          return gateCalls === 1 ? firstGate : secondGate;
        },
      },
      0,
      settled,
    );
    expect(
      await screen.findByText('Loading your households…'),
    ).toBeInTheDocument();
    // The signal arrives while the pre-membership load is busy: it must be
    // queued, not consumed, so no second fetch starts yet.
    rerender(
      <HouseholdSection
        csrf={CSRF}
        onCsrfRefreshed={() => {}}
        onSessionExpired={() => {}}
        refreshSignal={1}
        onRefreshSettled={settled}
        currentUserId={USER.id}
      />,
    );
    await act(async () => {});
    expect(householdGets()).toHaveLength(1);
    expect(settled).not.toHaveBeenCalled();
    resolveFirst(householdsOk([HOUSEHOLD_1]));
    // The queued signal drains into a second fetch after the busy load
    // settles; the initial load never reported a settle.
    await waitFor(() => expect(householdGets()).toHaveLength(2));
    expect(settled).not.toHaveBeenCalled();
    resolveSecond(householdsOk([HOUSEHOLD_1, HOUSEHOLD_2]));
    expect(await screen.findByText('Lake cabin')).toBeInTheDocument();
    expect(screen.getByText('Elm Street home')).toBeInTheDocument();
    await waitFor(() => expect(settled).toHaveBeenCalledWith(1));
  });

  it('queues a signal arriving during creation and reloads after the write settles', async () => {
    let resolvePost!: (response: Response) => void;
    const postGate = new Promise<Response>((resolve) => {
      resolvePost = resolve;
    });
    let resolveReload!: (response: Response) => void;
    const reloadGate = new Promise<Response>((resolve) => {
      resolveReload = resolve;
    });
    let getCalls = 0;
    const settled = vi.fn();
    const sectionProps = (signal: number) => (
      <HouseholdSection
        csrf={CSRF}
        onCsrfRefreshed={() => {}}
        onSessionExpired={() => {}}
        refreshSignal={signal}
        onRefreshSettled={settled}
        currentUserId={USER.id}
      />
    );
    const { rerender, householdGets } = renderSection(
      {
        get: () => {
          getCalls += 1;
          return getCalls === 1
            ? Promise.resolve(householdsOk([HOUSEHOLD_1]))
            : reloadGate;
        },
        post: () => postGate,
      },
      0,
      settled,
    );
    await screen.findByText('Elm Street home');
    fireEvent.change(screen.getByLabelText('Household name'), {
      target: { value: 'Lake cabin' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create household' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled(),
    );
    // The join acceptance lands while creation is busy.
    rerender(sectionProps(1));
    await act(async () => {});
    expect(householdGets()).toHaveLength(1);
    resolvePost(jsonResponse(HOUSEHOLD_2, 201));
    // Creation settles, then the queued signal triggers the reload.
    await waitFor(() => expect(householdGets()).toHaveLength(2));
    resolveReload(householdsOk([HOUSEHOLD_1, HOUSEHOLD_2]));
    expect(await screen.findByText('Lake cabin')).toBeInTheDocument();
    await waitFor(() => expect(settled).toHaveBeenCalledWith(1));
  });
});

describe('invitation access recovery', () => {
  it('replaces stale owner controls after the household refresh confirms a member role', async () => {
    let householdGets = 0;
    stubFetch({
      csrf: csrfOk,
      me: meAuthenticated,
      householdsGet: () => {
        householdGets += 1;
        return householdsOk([
          householdGets === 1
            ? HOUSEHOLD_1
            : { ...HOUSEHOLD_1, role: 'MEMBER' },
        ]);
      },
      invitationsPost: () =>
        jsonResponse(
          {
            code: 'FORBIDDEN',
            message: 'Only owners may invite.',
            correlationId: 'corr-role',
          },
          403,
        ),
    });
    render(<AuthSection />);
    await screen.findByRole('button', { name: 'Create invitation' });
    fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    expect(
      await screen.findByText(/access to this household may have changed/i),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh household list' }),
    );
    // The refreshed membership is MEMBER: stale owner controls disappear
    // instead of lingering with a denied role.
    await waitFor(() =>
      expect(screen.getByText('Role: MEMBER')).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('button', { name: 'Create invitation' }),
    ).not.toBeInTheDocument();
    expect(householdGets).toBe(2);
  });
});

describe('membership roster identity', () => {
  it('marks the signed-in user and offers no self-target owner controls', async () => {
    stubFetch({
      csrf: csrfOk,
      me: meAuthenticated,
      householdsGet: () => householdsOk([HOUSEHOLD_1]),
      membersGet: (householdId) =>
        householdId === HOUSEHOLD_1.id
          ? jsonResponse({ members: [USER_MEMBER, OTHER_MEMBER] })
          : jsonResponse({ members: [] }),
    });
    render(<AuthSection />);
    // AuthSection supplies the actual signed-in user ID: the actor's row is
    // marked and offers no mutation controls for themself.
    expect(
      await screen.findByText('person@example.test (you)'),
    ).toBeInTheDocument();
    expect(screen.getByText('member@example.test')).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Make member@example.test an owner of Elm Street home',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Remove member@example.test from Elm Street home',
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: 'Make person@example.test an owner of Elm Street home',
      }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: 'Remove person@example.test from Elm Street home',
      }),
    ).toBeNull();
  });
});

describe('membership reconciliation wiring', () => {
  function ReconcileHarness({ settled }: { settled: (value: number) => void }) {
    // Mirrors the AuthSection wiring: the membership reconcile callback
    // bumps the queued refresh signal and reports each settled reload.
    const [signal, setSignal] = useState(0);
    return (
      <HouseholdSection
        csrf={CSRF}
        onCsrfRefreshed={() => {}}
        onSessionExpired={() => {}}
        refreshSignal={signal}
        onRefreshSettled={settled}
        currentUserId={USER.id}
        onHouseholdReconcile={() => setSignal((version) => version + 1)}
      />
    );
  }

  function memberCalls(
    calls: Array<{ url: string; init?: RequestInit | undefined }>,
    method?: string,
  ) {
    return calls.filter(
      ({ url, init }) =>
        url.includes('/members') &&
        (method === undefined || (init?.method ?? 'GET') === method),
    );
  }

  it('reconciles a membership write through the queued household refresh signal', async () => {
    let removed = false;
    const settledSignals: number[] = [];
    const { calls } = stubFetch({
      csrf: csrfOk,
      householdsGet: () => householdsOk([HOUSEHOLD_1]),
      membersGet: (householdId) =>
        householdId === HOUSEHOLD_1.id
          ? jsonResponse({
              members: removed ? [USER_MEMBER] : [USER_MEMBER, OTHER_MEMBER],
            })
          : jsonResponse({ members: [] }),
      membersDelete: () => {
        removed = true;
        return new Response(null, { status: 204 });
      },
    });
    render(
      <ReconcileHarness settled={(value) => settledSignals.push(value)} />,
    );
    await screen.findByRole('button', {
      name: 'Remove member@example.test from Elm Street home',
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove member@example.test from Elm Street home',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove member' }));
    expect(
      await screen.findByText(/was removed from the household/),
    ).toBeInTheDocument();
    // The membership reconcile callback drove an authoritative collection
    // reload through the queued signal, and that reload settled and was
    // reported.
    await waitFor(() => expect(settledSignals).toEqual([1]));
    expect(householdCalls(calls, 'GET')).toHaveLength(2);
    expect(memberCalls(calls, 'GET')).toHaveLength(2);
  });

  it('queues the membership reconcile while the household collection is busy', async () => {
    const settledSignals: number[] = [];
    let householdsGets = 0;
    let resolveCreate!: (response: Response) => void;
    const createGate = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    const { calls } = stubFetch({
      csrf: csrfOk,
      householdsGet: () => {
        householdsGets += 1;
        return householdsGets === 1
          ? householdsOk([HOUSEHOLD_1])
          : householdsOk([HOUSEHOLD_1, HOUSEHOLD_2]);
      },
      householdsPost: () => createGate,
      membersGet: (householdId) =>
        householdId === HOUSEHOLD_1.id
          ? jsonResponse({ members: [USER_MEMBER, OTHER_MEMBER] })
          : jsonResponse({ members: [USER_MEMBER] }),
      membersDelete: () => new Response(null, { status: 204 }),
    });
    render(
      <ReconcileHarness settled={(value) => settledSignals.push(value)} />,
    );
    await screen.findByRole('button', {
      name: 'Remove member@example.test from Elm Street home',
    });
    // A creation is in flight, so the collection is busy.
    typeInto('Household name', 'Lake cabin');
    fireEvent.click(screen.getByRole('button', { name: 'Create household' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled(),
    );
    // The membership write starts and settles while the collection is busy.
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove member@example.test from Elm Street home',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove member' }));
    expect(
      await screen.findByText(/was removed from the household/),
    ).toBeInTheDocument();
    await act(async () => {});
    // The reconcile bump entered the queue instead of being dropped.
    expect(householdCalls(calls, 'GET')).toHaveLength(1);
    expect(settledSignals).toHaveLength(0);
    resolveCreate(jsonResponse(HOUSEHOLD_2, 201));
    expect(await screen.findByText('Lake cabin')).toBeInTheDocument();
    // The queued signal drains into a second collection fetch that settles.
    await waitFor(() => expect(settledSignals).toEqual([1]));
    expect(householdCalls(calls, 'GET')).toHaveLength(2);
  });

  it('queues the invitation access reconcile while the household collection is busy', async () => {
    const settledSignals: number[] = [];
    let householdsGets = 0;
    let resolveCreate!: (response: Response) => void;
    const createGate = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    const { calls } = stubFetch({
      csrf: csrfOk,
      householdsGet: () => {
        householdsGets += 1;
        return householdsGets === 1
          ? householdsOk([HOUSEHOLD_1])
          : householdsOk([HOUSEHOLD_1, HOUSEHOLD_2]);
      },
      householdsPost: () => createGate,
      invitationsPost: () =>
        jsonResponse(
          {
            code: 'FORBIDDEN',
            message: 'Only owners may invite.',
            correlationId: 'corr-role',
          },
          403,
        ),
    });
    render(
      <ReconcileHarness settled={(value) => settledSignals.push(value)} />,
    );
    await screen.findByRole('button', { name: 'Create invitation' });
    // A creation is in flight, so the collection is busy.
    typeInto('Household name', 'Lake cabin');
    fireEvent.click(screen.getByRole('button', { name: 'Create household' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled(),
    );
    // The owner invitation write reports changed access while busy.
    fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    expect(
      await screen.findByText(/access to this household may have changed/i),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh household list' }),
    );
    await act(async () => {});
    // The invitation reconcile entered the queue instead of being dropped.
    expect(householdCalls(calls, 'GET')).toHaveLength(1);
    resolveCreate(jsonResponse(HOUSEHOLD_2, 201));
    expect(await screen.findByText('Lake cabin')).toBeInTheDocument();
    await waitFor(() => expect(householdCalls(calls, 'GET')).toHaveLength(2));
  });
});

describe('financial section authority gating', () => {
  function financeSection(signal: number) {
    return (
      <HouseholdSection
        csrf={CSRF}
        onCsrfRefreshed={() => {}}
        onSessionExpired={() => {}}
        refreshSignal={signal}
        currentUserId={USER.id}
      />
    );
  }

  it('gates financial mutation controls while the household list is stale', async () => {
    let gets = 0;
    stubFetch({
      csrf: csrfOk,
      householdsGet: () => {
        gets += 1;
        return gets === 1
          ? householdsOk([HOUSEHOLD_1])
          : jsonResponse(
              { code: 'NETWORK_ERROR', message: 'Could not reach the server.' },
              500,
            );
      },
      financialAccountsGet: () =>
        jsonResponse({
          items: [
            {
              id: '10000000-0000-4000-8000-000000000001',
              householdId: HOUSEHOLD_1.id,
              ownerUserId: USER.id,
              name: 'Daily spending',
              kind: 'CHECKING',
              currency: 'BRL',
              source: 'MANUAL',
              visibility: 'PRIVATE',
              status: 'ACTIVE',
              version: 0,
              createdAt: '2026-09-16T12:00:00Z',
              updatedAt: '2026-09-16T12:00:00Z',
            },
          ],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
    });
    const { rerender } = render(financeSection(0));

    // With a confirmed list, the finance mutations are available.
    await screen.findByText('Daily spending');
    expect(
      screen.getByRole('button', { name: 'Rename Daily spending' }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Add private account' }),
    ).toBeEnabled();

    // A failed reload leaves the card (and finance section) rendered but
    // stale: the list stays visible while every mutation is gated.
    rerender(financeSection(1));
    expect(
      await screen.findByText(/Showing previously loaded households/),
    ).toBeInTheDocument();
    expect(screen.getByText('Daily spending')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Refresh the household before changing financial accounts.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Rename Daily spending' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Archive Daily spending' }),
    ).toBeDisabled();
    expect(screen.getByLabelText('Account name')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Add private account' }),
    ).toBeDisabled();
  });
});
