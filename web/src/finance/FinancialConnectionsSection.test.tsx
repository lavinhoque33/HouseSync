import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CsrfToken, Household, LinkAttempt } from '../auth/client';
import { FinancialConnectionsSection } from './FinancialConnectionsSection';
import { isLinkAttemptExpired } from './connections';
import {
  resetPlaidLoaderForTests,
  type PlaidLinkExitError,
} from './plaid-link';

const CSRF: CsrfToken = { token: 'csrf-token-1', headerName: 'X-CSRF-TOKEN' };
const HOUSEHOLD: Household = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  name: 'Elm Street home',
  role: 'MEMBER',
  createdAt: '2026-09-13T01:30:00Z',
};
const CONNECTION_ID = '10000000-0000-4000-8000-000000000001';
const ATTEMPT_ID = '20000000-0000-4000-8000-000000000002';
const OPERATION_ID = '30000000-0000-4000-8000-000000000003';
const MAPPING_CHECKING = '40000000-0000-4000-8000-000000000004';
const MAPPING_SAVINGS = '40000000-0000-4000-8000-000000000005';

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    householdId: HOUSEHOLD.id,
    provider: 'PLAID',
    environment: 'SANDBOX',
    state: 'ACTIVE',
    generation: 0,
    version: 2,
    syncState: 'IDLE',
    historyReady: false,
    lastSuccessfulSyncAt: null,
    createdAt: '2026-09-17T00:00:00Z',
    updatedAt: '2026-09-17T00:00:00Z',
    ...overrides,
  };
}

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    id: ATTEMPT_ID,
    flow: 'NEW',
    provider: 'PLAID',
    connectionId: null,
    linkToken: 'link-sandbox-memory-only',
    // Far-future expiry so the suite never depends on the wall clock; the
    // expiry tests below override this per case.
    expiresAt: '2099-01-01T00:00:00Z',
    ...overrides,
  };
}

function operation(overrides: Record<string, unknown> = {}) {
  return {
    id: OPERATION_ID,
    operationType: 'LINK_COMPLETE',
    state: 'PENDING',
    connectionId: CONNECTION_ID,
    errorCode: null,
    statusUrl: `/api/households/${HOUSEHOLD.id}/connection-operations/${OPERATION_ID}`,
    createdAt: '2026-09-17T00:00:00Z',
    updatedAt: '2026-09-17T00:00:00Z',
    ...overrides,
  };
}

function mapping(overrides: Record<string, unknown> = {}) {
  return {
    mappingId: MAPPING_CHECKING,
    localAccountId: null,
    name: 'Everyday Chequing',
    kind: 'CHECKING',
    currency: 'CAD',
    selected: false,
    eligible: true,
    exclusionReason: null,
    ...overrides,
  };
}

const SAVINGS_MAPPING = mapping({
  mappingId: MAPPING_SAVINGS,
  name: 'Rainy-day Savings',
  kind: 'SAVINGS',
  currency: 'USD',
});

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function errorResponse(code: string, status: number) {
  return Response.json(
    { code, message: 'Safe message.', correlationId: 'corr-9' },
    { status },
  );
}

type Call = {
  url: string;
  init?: RequestInit | undefined;
  body: unknown;
};

interface Routes {
  connectionsGet?: () => Response | Promise<Response>;
  startPost?: () => Response | Promise<Response>;
  completePost?: () => Response | Promise<Response>;
  operationGet?: () => Response | Promise<Response>;
  accountsGet?: () => Response | Promise<Response>;
  selectPost?: () => Response | Promise<Response>;
  reconnectPost?: () => Response | Promise<Response>;
  disconnectPost?: () => Response | Promise<Response>;
}

function stubFetch(routes: Routes) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      let body: unknown = null;
      if (typeof init?.body === 'string' && init.body.length > 0) {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      calls.push({ url, init, body });
      const base = `/api/households/${HOUSEHOLD.id}`;
      if (url === `${base}/financial-connections?limit=100&offset=0`) {
        if (!routes.connectionsGet)
          throw new Error('unexpected connections GET');
        return routes.connectionsGet();
      }
      if (
        url === `${base}/connection-link-attempts` &&
        init?.method === 'POST'
      ) {
        if (!routes.startPost) throw new Error('unexpected start POST');
        return routes.startPost();
      }
      if (
        url === `${base}/connection-link-attempts/${ATTEMPT_ID}/complete` &&
        init?.method === 'POST'
      ) {
        if (!routes.completePost) throw new Error('unexpected complete POST');
        return routes.completePost();
      }
      if (
        url === `${base}/connection-operations/${OPERATION_ID}` &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        if (!routes.operationGet) throw new Error('unexpected operation GET');
        return routes.operationGet();
      }
      if (
        url ===
          `${base}/financial-connections/${CONNECTION_ID}/accounts?limit=100&offset=0` &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        if (!routes.accountsGet) throw new Error('unexpected accounts GET');
        return routes.accountsGet();
      }
      if (
        url ===
          `${base}/financial-connections/${CONNECTION_ID}/account-selection` &&
        init?.method === 'POST'
      ) {
        if (!routes.selectPost) throw new Error('unexpected selection POST');
        return routes.selectPost();
      }
      if (
        url === `${base}/financial-connections/${CONNECTION_ID}/reconnect` &&
        init?.method === 'POST'
      ) {
        if (!routes.reconnectPost) throw new Error('unexpected reconnect POST');
        return routes.reconnectPost();
      }
      if (
        url === `${base}/financial-connections/${CONNECTION_ID}/disconnect` &&
        init?.method === 'POST'
      ) {
        if (!routes.disconnectPost)
          throw new Error('unexpected disconnect POST');
        return routes.disconnectPost();
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

interface PlaidControl {
  options: {
    token: string;
    onSuccess: (publicToken: string, metadata: object) => void;
    onExit: (error: PlaidLinkExitError | null, metadata: object) => void;
  } | null;
  open: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  succeed: (publicToken?: string) => void;
  exit: (error?: PlaidLinkExitError | null) => void;
}

function installFakePlaid(): PlaidControl {
  const control: PlaidControl = {
    options: null,
    open: vi.fn(),
    destroy: vi.fn(),
    succeed: (publicToken = 'public-sandbox-1') => {
      control.options?.onSuccess(publicToken, {});
    },
    exit: (error = null) => {
      control.options?.onExit(error, {});
    },
  };
  Object.defineProperty(window, 'Plaid', {
    value: {
      create: (options: PlaidControl['options']) => {
        control.options = options;
        return { open: control.open, destroy: control.destroy };
      },
    },
    configurable: true,
    writable: true,
  });
  return control;
}

afterEach(() => {
  resetPlaidLoaderForTests();
  window.Plaid = undefined;
  window.localStorage.clear();
  window.sessionStorage.clear();
});

function renderSection(routes: Routes = {}) {
  const calls = stubFetch(routes);
  const onCsrfRefreshed = vi.fn();
  const onSessionExpired = vi.fn();
  const onHouseholdAccessChanged = vi.fn();
  const onAccountListCommitted = vi.fn();
  const onBankActivityChanged = vi.fn();
  const rendered = render(
    <FinancialConnectionsSection
      household={HOUSEHOLD}
      csrf={CSRF}
      onCsrfRefreshed={onCsrfRefreshed}
      onSessionExpired={onSessionExpired}
      onHouseholdAccessChanged={onHouseholdAccessChanged}
      authorityConfirmed
      onAccountListCommitted={onAccountListCommitted}
      onBankActivityChanged={onBankActivityChanged}
    />,
  );
  return {
    calls,
    onCsrfRefreshed,
    onSessionExpired,
    onHouseholdAccessChanged,
    onAccountListCommitted,
    onBankActivityChanged,
    rerenderActive: (active: boolean) =>
      rendered.rerender(
        <FinancialConnectionsSection
          household={HOUSEHOLD}
          active={active}
          csrf={CSRF}
          onCsrfRefreshed={onCsrfRefreshed}
          onSessionExpired={onSessionExpired}
          onHouseholdAccessChanged={onHouseholdAccessChanged}
          authorityConfirmed
          onAccountListCommitted={onAccountListCommitted}
          onBankActivityChanged={onBankActivityChanged}
        />,
      ),
  };
}

function postsTo(calls: Call[], suffix: string) {
  return calls.filter(
    ({ url, init }) => url.endsWith(suffix) && init?.method === 'POST',
  );
}

function idempotencyKeyOf(call: Call | undefined): string | undefined {
  const headers = call?.init?.headers as Record<string, string> | undefined;
  return headers?.['Idempotency-Key'];
}

function csrfOf(call: Call | undefined): string | undefined {
  const headers = call?.init?.headers as Record<string, string> | undefined;
  return headers?.['X-CSRF-TOKEN'];
}

describe('connection list', () => {
  it('shows the private empty state with accurate Sync B inbox copy', async () => {
    renderSection({
      connectionsGet: () =>
        jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false }),
    });
    await screen.findByText(/No bank connections yet/);
    expect(
      screen.getByText(
        /Synced activity arrives in\s+your private bank-activity inbox/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/nothing reaches the ledger until you\s+confirm it/),
    ).toBeInTheDocument();
    expect(screen.getByText(/no balance is inferred/i)).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(
      /auto-import|refresh balance|statement import/i,
    );
  });

  it('lists connections with honest state labels and scoped reconnect', async () => {
    renderSection({
      connectionsGet: () =>
        jsonResponse({
          items: [
            connection(),
            connection({
              id: '60000000-0000-4000-8000-000000000006',
              state: 'SUSPENDED',
            }),
          ],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
    });
    await screen.findAllByText('Test bank connection');
    expect(screen.getByText(/Active/)).toBeInTheDocument();
    expect(screen.getByText(/Suspended/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Reconnect' })).toHaveLength(
      1,
    );
  });

  it('recovers from sign-out by clearing private state', async () => {
    const { onSessionExpired } = renderSection({
      connectionsGet: () => errorResponse('UNAUTHENTICATED', 401),
    });
    await waitFor(() => expect(onSessionExpired).toHaveBeenCalled());
    expect(screen.queryByText('Bank connections')).toBeInTheDocument();
    expect(screen.queryByLabelText('Your bank connections')).toBeNull();
  });
});

describe('new link flow', () => {
  it('creates, opens, completes, and polls to a ready connection', async () => {
    const plaid = installFakePlaid();
    let polled = 0;
    let linked = false;
    const { calls } = renderSection({
      connectionsGet: () =>
        jsonResponse({
          items: linked ? [connection({ state: 'ACTIVE', version: 0 })] : [],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
      startPost: () => jsonResponse(attempt(), 201),
      completePost: () => {
        linked = true;
        return jsonResponse(operation({ state: 'PENDING' }), 202);
      },
      operationGet: () => {
        polled += 1;
        return jsonResponse(operation({ state: 'SUCCEEDED' }), 200);
      },
    });
    await screen.findByText(/No bank connections yet/);
    const hrefBefore = window.location.href;

    fireEvent.click(screen.getByRole('button', { name: 'Link a bank' }));
    await waitFor(() => expect(plaid.open).toHaveBeenCalledTimes(1));
    expect(plaid.options?.token).toBe('link-sandbox-memory-only');

    await waitFor(() =>
      expect(postsTo(calls, '/connection-link-attempts')).toHaveLength(1),
    );
    const starts = postsTo(calls, '/connection-link-attempts');
    expect(starts[0]?.body).toEqual({});
    expect(starts[0]?.init?.headers).toMatchObject({
      'Idempotency-Key': expect.any(String),
      'X-CSRF-TOKEN': 'csrf-token-1',
    });

    plaid.succeed('public-sandbox-1');
    await waitFor(() =>
      expect(
        postsTo(calls, `/connection-link-attempts/${ATTEMPT_ID}/complete`),
      ).toHaveLength(1),
    );
    expect(
      postsTo(calls, `/connection-link-attempts/${ATTEMPT_ID}/complete`)[0]
        ?.body,
    ).toEqual({ publicToken: 'public-sandbox-1' });

    await screen.findByText(/The bank connection is ready/, undefined, {
      timeout: 6000,
    });
    expect(polled).toBeGreaterThanOrEqual(1);

    // Privacy: tokens never reach the DOM, storage, or the URL.
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('link-sandbox-memory-only');
    expect(text).not.toContain('public-sandbox-1');
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(window.location.href).toBe(hrefBefore);
  }, 15000);

  it('leaves a resumable attempt when the bank step closes', async () => {
    const plaid = installFakePlaid();
    renderSection({
      connectionsGet: () =>
        jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false }),
      startPost: () => jsonResponse(attempt(), 201),
    });
    await screen.findByText(/No bank connections yet/);
    fireEvent.click(screen.getByRole('button', { name: 'Link a bank' }));
    await waitFor(() => expect(plaid.open).toHaveBeenCalledTimes(1));

    plaid.exit(null);
    const resume = await screen.findByRole('button', {
      name: 'Resume bank step',
    });
    expect(screen.getByText(/closed before finishing/)).toBeInTheDocument();

    fireEvent.click(resume);
    await waitFor(() => expect(plaid.open).toHaveBeenCalledTimes(2));
  });

  it('reports a script failure with a retry path', async () => {
    renderSection({
      connectionsGet: () =>
        jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false }),
      startPost: () => jsonResponse(attempt(), 201),
    });
    await screen.findByText(/No bank connections yet/);
    fireEvent.click(screen.getByRole('button', { name: 'Link a bank' }));
    await waitFor(() =>
      expect(document.getElementById('housesync-plaid-link')).not.toBeNull(),
    );
    document
      .getElementById('housesync-plaid-link')
      ?.dispatchEvent(new Event('error'));
    await screen.findByText(/could not be loaded/);
    expect(
      screen.getByRole('button', { name: 'Resume bank step' }),
    ).toBeInTheDocument();
  });

  it('preserves unknown completion outcomes with the same key', async () => {
    const plaid = installFakePlaid();
    let attempts = 0;
    const { calls } = renderSection({
      connectionsGet: () =>
        jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false }),
      startPost: () => jsonResponse(attempt(), 201),
      completePost: () => {
        attempts += 1;
        if (attempts === 1) {
          // A retryable provider-side stall: the outcome is unknown, the
          // same completion key is retained, and no second exchange happens.
          return errorResponse('FINANCE_BUSY', 503);
        }
        return jsonResponse(operation({ state: 'SUCCEEDED' }), 202);
      },
      operationGet: () => jsonResponse(operation({ state: 'SUCCEEDED' })),
    });
    await screen.findByText(/No bank connections yet/);
    fireEvent.click(screen.getByRole('button', { name: 'Link a bank' }));
    await waitFor(() => expect(plaid.open).toHaveBeenCalledTimes(1));
    plaid.succeed('public-sandbox-1');
    await screen.findByText(/unknown outcome/);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Retry completion' }),
    );
    await screen.findByText(/The bank connection is ready/);
    const completeCalls = postsTo(
      calls,
      `/connection-link-attempts/${ATTEMPT_ID}/complete`,
    );
    expect(completeCalls.length).toBeGreaterThanOrEqual(2);
    expect(idempotencyKeyOf(completeCalls[0])).toBeTruthy();
    expect(idempotencyKeyOf(completeCalls[1])).toBe(
      idempotencyKeyOf(completeCalls[0]),
    );
    // The retry reuses the retained in-memory token, not an empty body.
    expect(completeCalls[1]?.body).toEqual({
      publicToken: 'public-sandbox-1',
    });
  });
  it('retains completion key and memory-only token while navigating during POST', async () => {
    const plaid = installFakePlaid();
    let settle: ((response: Response) => void) | undefined;
    let submissions = 0;
    const { calls, rerenderActive } = renderSection({
      connectionsGet: () =>
        jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false }),
      startPost: () => jsonResponse(attempt(), 201),
      completePost: () =>
        ++submissions === 1
          ? new Promise<Response>((resolve) => {
              settle = resolve;
            })
          : jsonResponse(operation({ state: 'SUCCEEDED' }), 202),
    });
    await screen.findByText(/No bank connections yet/);
    fireEvent.click(screen.getByRole('button', { name: 'Link a bank' }));
    await waitFor(() => expect(plaid.open).toHaveBeenCalledTimes(1));
    plaid.succeed('public-sandbox-1');
    const suffix = `/connection-link-attempts/${ATTEMPT_ID}/complete`;
    await waitFor(() => expect(postsTo(calls, suffix)).toHaveLength(1));
    rerenderActive(false);
    settle?.(errorResponse('FINANCE_BUSY', 503));
    rerenderActive(true);
    expect(
      screen.getByRole('button', { name: 'Resume bank step' }),
    ).toBeDisabled();
    plaid.succeed('different-public-token');
    expect(postsTo(calls, suffix)).toHaveLength(1);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Retry completion' }),
    );
    await screen.findByText(/The bank connection is ready/);
    const posts = postsTo(calls, suffix);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.body).toEqual(posts[0]?.body);
    expect(idempotencyKeyOf(posts[1])).toBe(idempotencyKeyOf(posts[0]));
    expect(document.body.textContent).not.toContain('public-sandbox-1');
  });
});

describe('reconnect flow', () => {
  it('completes update mode with an empty body', async () => {
    const plaid = installFakePlaid();
    const { calls } = renderSection({
      connectionsGet: () =>
        jsonResponse({
          items: [connection({ state: 'REAUTH_REQUIRED' })],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
      reconnectPost: () =>
        jsonResponse(
          attempt({ flow: 'UPDATE', connectionId: CONNECTION_ID }),
          201,
        ),
      completePost: () => jsonResponse(operation({ state: 'SUCCEEDED' }), 202),
    });
    await screen.findByText(/Needs reconnection/);
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(plaid.open).toHaveBeenCalledTimes(1));
    plaid.succeed('public-should-be-ignored');
    await screen.findByText(/The bank connection is active again/);
    const completeCalls = postsTo(
      calls,
      `/connection-link-attempts/${ATTEMPT_ID}/complete`,
    );
    expect(completeCalls).toHaveLength(1);
    expect(completeCalls[0]?.body).toEqual({});
  }, 15000);
});

describe('account selection', () => {
  function selectionRoutes(): Routes {
    return {
      connectionsGet: () =>
        jsonResponse({
          items: [connection()],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
      accountsGet: () =>
        jsonResponse({
          items: [mapping(), SAVINGS_MAPPING],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
      selectPost: () =>
        jsonResponse({
          connectionId: CONNECTION_ID,
          version: 3,
          accounts: [
            {
              id: '50000000-0000-4000-8000-000000000005',
              name: 'Everyday Chequing',
              kind: 'CHECKING',
              currency: 'CAD',
              source: 'CONNECTED',
              status: 'ACTIVE',
              version: 0,
            },
          ],
        }),
    };
  }

  it('discovers, drafts, and saves the explicit selection', async () => {
    const { calls, onAccountListCommitted, onBankActivityChanged } =
      renderSection(selectionRoutes());
    await screen.findByText('Test bank connection');
    fireEvent.click(screen.getByRole('button', { name: 'Choose accounts' }));
    await screen.findByText('Everyday Chequing');

    fireEvent.click(screen.getByLabelText(/Everyday Chequing/));
    fireEvent.click(screen.getByLabelText(/Rainy-day Savings/));
    fireEvent.click(
      screen.getByRole('button', { name: 'Save account selection' }),
    );
    await screen.findByText(/Admitting 1 account/);
    expect(onAccountListCommitted).toHaveBeenCalledTimes(1);
    // A committed selection also refreshes the sibling bank-activity inbox.
    expect(onBankActivityChanged).toHaveBeenCalledTimes(1);

    const selects = postsTo(calls, '/account-selection');
    expect(selects).toHaveLength(1);
    expect(selects[0]?.body).toEqual({
      expectedVersion: 2,
      accountMappingIds: [MAPPING_CHECKING, MAPPING_SAVINGS].sort(),
    });
    expect(idempotencyKeyOf(selects[0])).toBeTruthy();
  });

  it('keeps dirty drafts across background list refetches', async () => {
    let selects = 0;
    renderSection({
      ...selectionRoutes(),
      selectPost: () => {
        selects += 1;
        return errorResponse('CONNECTION_NOT_READY', 409);
      },
    });
    await screen.findByText('Test bank connection');
    fireEvent.click(screen.getByRole('button', { name: 'Choose accounts' }));
    await screen.findByText('Everyday Chequing');
    fireEvent.click(screen.getByLabelText(/Everyday Chequing/));
    fireEvent.click(
      screen.getByRole('button', { name: 'Save account selection' }),
    );
    await screen.findByText(/not ready for selection/);
    expect(selects).toBe(1);

    // The recovery notice offers a background list refetch: the dirty
    // checkbox draft must survive it.
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh connections' }),
    );
    await waitFor(() =>
      expect(
        (screen.getByLabelText(/Everyday Chequing/) as HTMLInputElement)
          .checked,
      ).toBe(true),
    );
    expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument();
  });

  it('preserves the draft through a stale-version conflict', async () => {
    let selects = 0;
    renderSection({
      ...selectionRoutes(),
      selectPost: () => {
        selects += 1;
        return errorResponse('RESOURCE_VERSION_CONFLICT', 409);
      },
    });
    await screen.findByText('Test bank connection');
    fireEvent.click(screen.getByRole('button', { name: 'Choose accounts' }));
    await screen.findByText('Everyday Chequing');
    fireEvent.click(screen.getByLabelText(/Everyday Chequing/));
    fireEvent.click(
      screen.getByRole('button', { name: 'Save account selection' }),
    );
    await screen.findByText(/Review your selection/);
    expect(selects).toBe(1);
    expect(
      (screen.getByLabelText(/Everyday Chequing/) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('disables ineligible mappings with a human reason', async () => {
    renderSection({
      connectionsGet: () =>
        jsonResponse({
          items: [connection()],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
      accountsGet: () =>
        jsonResponse({
          items: [
            mapping({
              eligible: false,
              currency: null,
              exclusionReason: 'UNSUPPORTED_CURRENCY',
            }),
          ],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
    });
    await screen.findByText('Test bank connection');
    fireEvent.click(screen.getByRole('button', { name: 'Choose accounts' }));
    await screen.findByText(/unsupported currency/);
    expect(
      screen.getByLabelText(/Everyday Chequing/) as HTMLInputElement,
    ).toBeDisabled();
  });

  it('keeps eligible rows selectable beside null-classified ineligible rows', async () => {
    const { calls } = renderSection({
      connectionsGet: () =>
        jsonResponse({
          items: [connection()],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
      accountsGet: () =>
        jsonResponse({
          items: [
            mapping(),
            mapping({
              mappingId: '40000000-0000-4000-8000-000000000007',
              localAccountId: null,
              name: 'Old Auto Loan',
              kind: null,
              currency: 'USD',
              selected: false,
              eligible: false,
              exclusionReason: 'UNSUPPORTED_KIND',
            }),
            mapping({
              mappingId: '40000000-0000-4000-8000-000000000008',
              localAccountId: null,
              name: 'Foreign Bills',
              kind: 'CHECKING',
              currency: null,
              selected: false,
              eligible: false,
              exclusionReason: 'UNSUPPORTED_CURRENCY',
            }),
          ],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
      selectPost: () =>
        jsonResponse({
          connectionId: CONNECTION_ID,
          version: 3,
          accounts: [],
        }),
    });
    await screen.findByText('Test bank connection');
    fireEvent.click(screen.getByRole('button', { name: 'Choose accounts' }));

    // One unsupported loan/currency row must not hide the eligible page:
    // fallbacks render, rows stay disabled with their explanations.
    await screen.findByText('Old Auto Loan');
    expect(screen.getByText('Foreign Bills')).toBeInTheDocument();
    expect(screen.getByText(/Unknown account type/)).toBeInTheDocument();
    expect(screen.getByText(/Unknown currency/)).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Old Auto Loan/) as HTMLInputElement,
    ).toBeDisabled();
    expect(
      screen.getByLabelText(/Foreign Bills/) as HTMLInputElement,
    ).toBeDisabled();

    // The eligible row stays fully selectable and saves by itself.
    const eligible = screen.getByLabelText(
      /Everyday Chequing/,
    ) as HTMLInputElement;
    expect(eligible).toBeEnabled();
    fireEvent.click(eligible);
    fireEvent.click(
      screen.getByRole('button', { name: 'Save account selection' }),
    );
    await screen.findByText(/Account admission paused/);
    const selects = postsTo(calls, '/account-selection');
    expect(selects).toHaveLength(1);
    expect(selects[0]?.body).toEqual({
      expectedVersion: 2,
      accountMappingIds: [MAPPING_CHECKING],
    });
  });
});

describe('disconnect flow', () => {
  it('confirms, shows disconnecting at once, and polls to disconnected', async () => {
    let polled = 0;
    let listed = 0;
    renderSection({
      connectionsGet: () => {
        listed += 1;
        return jsonResponse({
          items: [
            connection({ state: listed <= 1 ? 'ACTIVE' : 'DISCONNECTED' }),
          ],
          limit: 100,
          offset: 0,
          hasMore: false,
        });
      },
      disconnectPost: () =>
        jsonResponse(
          operation({ operationType: 'DISCONNECT', state: 'PENDING' }),
          202,
        ),
      operationGet: () => {
        polled += 1;
        return jsonResponse(
          operation({ operationType: 'DISCONNECT', state: 'SUCCEEDED' }),
          200,
        );
      },
    });
    await screen.findByText(/Active/);

    const trigger = screen.getByRole('button', { name: 'Disconnect' });
    fireEvent.click(trigger);
    const confirm = await screen.findByRole('group', {
      name: 'Confirm bank disconnection',
    });
    expect(
      within(confirm).getByRole('button', { name: 'Disconnect bank' }),
    ).toBeInTheDocument();

    fireEvent.click(
      within(confirm).getByRole('button', { name: 'Disconnect bank' }),
    );
    await screen.findAllByText(/Disconnecting/);
    await screen.findByText(/Disconnected/, undefined, { timeout: 6000 });
    expect(polled).toBeGreaterThanOrEqual(1);
    await screen.findByText(/admitted history stays/);
  }, 15000);

  it('cancels the confirmation with Escape and returns focus', async () => {
    renderSection({
      connectionsGet: () =>
        jsonResponse({
          items: [connection()],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
    });
    await screen.findByText(/Active/);
    const trigger = screen.getByRole('button', { name: 'Disconnect' });
    fireEvent.click(trigger);
    const confirm = await screen.findByRole('group', {
      name: 'Confirm bank disconnection',
    });
    fireEvent.keyDown(confirm, { key: 'Escape' });
    await waitFor(() =>
      expect(
        screen.queryByRole('group', { name: 'Confirm bank disconnection' }),
      ).toBeNull(),
    );
    expect(document.activeElement).toBe(trigger);
  });

  it('offers retry after a failed disconnect', async () => {
    renderSection({
      connectionsGet: () =>
        jsonResponse({
          items: [connection()],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
      disconnectPost: () =>
        jsonResponse(
          operation({ operationType: 'DISCONNECT', state: 'FAILED' }),
          202,
        ),
    });
    await screen.findByText(/Active/);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    const confirm = await screen.findByRole('group', {
      name: 'Confirm bank disconnection',
    });
    fireEvent.click(
      within(confirm).getByRole('button', { name: 'Disconnect bank' }),
    );
    await screen.findByRole('button', { name: 'Retry disconnect' });
  });
});

describe('unknown outcomes', () => {
  it('preserves OUTCOME_UNKNOWN with recovery guidance and stops polling', async () => {
    const plaid = installFakePlaid();
    let polls = 0;
    renderSection({
      connectionsGet: () =>
        jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false }),
      startPost: () => jsonResponse(attempt(), 201),
      completePost: () =>
        jsonResponse(
          operation({
            state: 'OUTCOME_UNKNOWN',
            errorCode: 'EXCHANGE_UNKNOWN',
          }),
          202,
        ),
      operationGet: () => {
        polls += 1;
        return jsonResponse(
          operation({
            state: 'OUTCOME_UNKNOWN',
            errorCode: 'EXCHANGE_UNKNOWN',
          }),
        );
      },
    });
    await screen.findByText(/No bank connections yet/);
    fireEvent.click(screen.getByRole('button', { name: 'Link a bank' }));
    await waitFor(() => expect(plaid.open).toHaveBeenCalledTimes(1));
    plaid.succeed('public-sandbox-1');
    await screen.findAllByText(/unknown result/);
    expect(
      screen.getByText(/remove it in the bank’s own tools/),
    ).toBeInTheDocument();
    const seen = polls;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(polls).toBe(seen);
  }, 15000);
});

describe('attempt expiry', () => {
  it('judges expiry against a fixed clock without opening anything', () => {
    const at = (expiresAt: string): LinkAttempt =>
      ({ ...attempt(), expiresAt }) as LinkAttempt;
    expect(
      isLinkAttemptExpired(
        at('2026-09-17T00:30:00Z'),
        Date.parse('2026-09-17T00:30:00Z'),
      ),
    ).toBe(true);
    expect(
      isLinkAttemptExpired(
        at('2026-09-17T00:30:00Z'),
        Date.parse('2026-09-17T00:29:59.999Z'),
      ),
    ).toBe(false);
    expect(isLinkAttemptExpired(at('not-a-date'), 0)).toBe(true);
  });

  it('never opens the provider step with an already-expired attempt', async () => {
    const plaid = installFakePlaid();
    renderSection({
      connectionsGet: () =>
        jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false }),
      startPost: () =>
        jsonResponse(attempt({ expiresAt: '2000-01-01T00:00:00Z' }), 201),
    });
    await screen.findByText(/No bank connections yet/);
    fireEvent.click(screen.getByRole('button', { name: 'Link a bank' }));
    await screen.findByText(/attempt expired\. Start a new one/);
    expect(plaid.open).not.toHaveBeenCalled();
    // The expired attempt is erased, so there is nothing to resume.
    expect(
      screen.queryByRole('button', { name: 'Resume bank step' }),
    ).toBeNull();
  });

  it('blocks resume once the attempt expires after opening', async () => {
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-09-17T00:00:00Z'));
    const plaid = installFakePlaid();
    renderSection({
      connectionsGet: () =>
        jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false }),
      startPost: () =>
        jsonResponse(attempt({ expiresAt: '2026-09-17T00:30:00Z' }), 201),
    });
    await screen.findByText(/No bank connections yet/);
    fireEvent.click(screen.getByRole('button', { name: 'Link a bank' }));
    await waitFor(() => expect(plaid.open).toHaveBeenCalledTimes(1));

    nowSpy.mockReturnValue(Date.parse('2026-09-17T01:00:01Z'));
    plaid.exit(null);
    const resume = await screen.findByRole('button', {
      name: 'Resume bank step',
    });
    fireEvent.click(resume);
    await screen.findByText(/attempt expired\. Start a new one/);
    expect(plaid.open).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: 'Resume bank step' }),
    ).toBeNull();
  });
});

describe('incomplete bank responses', () => {
  it('blocks NEW completion without a token and sends no request', async () => {
    const plaid = installFakePlaid();
    const { calls } = renderSection({
      connectionsGet: () =>
        jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false }),
      startPost: () => jsonResponse(attempt(), 201),
    });
    await screen.findByText(/No bank connections yet/);
    fireEvent.click(screen.getByRole('button', { name: 'Link a bank' }));
    await waitFor(() => expect(plaid.open).toHaveBeenCalledTimes(1));

    plaid.succeed('');
    await screen.findByText(/incomplete response/);
    expect(
      postsTo(calls, `/connection-link-attempts/${ATTEMPT_ID}/complete`),
    ).toHaveLength(0);
    // The attempt stays resumable so the bank step can run again.
    expect(
      screen.getByRole('button', { name: 'Resume bank step' }),
    ).toBeInTheDocument();
  });
});

describe('CSRF recovery', () => {
  it('retries the identical request once with a refreshed token', async () => {
    const plaid = installFakePlaid();
    let starts = 0;
    const { calls } = renderSection({
      connectionsGet: () =>
        jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false }),
      startPost: () => {
        starts += 1;
        return starts === 1
          ? errorResponse('CSRF_INVALID', 403)
          : jsonResponse(attempt(), 201);
      },
      completePost: () => jsonResponse(operation({ state: 'SUCCEEDED' }), 202),
    });
    await screen.findByText(/No bank connections yet/);
    fireEvent.click(screen.getByRole('button', { name: 'Link a bank' }));

    // One gesture drives the retry: the provider opens exactly once and the
    // flow completes without a manual second attempt.
    await waitFor(() => expect(plaid.open).toHaveBeenCalledTimes(1));
    const startCalls = postsTo(calls, '/connection-link-attempts');
    expect(startCalls).toHaveLength(2);
    expect(startCalls[0]?.body).toEqual({});
    expect(startCalls[1]?.body).toEqual({});
    expect(idempotencyKeyOf(startCalls[1])).toBe(
      idempotencyKeyOf(startCalls[0]),
    );
    expect(csrfOf(startCalls[0])).toBe('csrf-token-1');
    expect(csrfOf(startCalls[1])).toBe('csrf-token-2');

    plaid.succeed('public-sandbox-1');
    await screen.findByText(/The bank connection is ready/);
    expect(plaid.open).toHaveBeenCalledTimes(1);
  }, 15000);
});

describe('durable reconnect requests', () => {
  it('replays the identical reconnect after an unknown outcome', async () => {
    const plaid = installFakePlaid();
    let attempts = 0;
    const { calls } = renderSection({
      connectionsGet: () =>
        jsonResponse({
          items: [connection()],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
      reconnectPost: () => {
        attempts += 1;
        return attempts === 1
          ? errorResponse('FINANCE_BUSY', 503)
          : jsonResponse(
              attempt({ flow: 'UPDATE', connectionId: CONNECTION_ID }),
              201,
            );
      },
      completePost: () => jsonResponse(operation({ state: 'SUCCEEDED' }), 202),
    });
    await screen.findByText(/Active/);
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await screen.findByText(/unknown outcome/);
    expect(
      screen.getByRole('button', { name: 'Retry same reconnect request' }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Retry same reconnect request' }),
    );
    await waitFor(() => expect(plaid.open).toHaveBeenCalledTimes(1));
    const posts = postsTo(calls, '/reconnect');
    expect(posts).toHaveLength(2);
    expect(posts[0]?.body).toEqual({ expectedVersion: 2 });
    expect(posts[1]?.body).toEqual({ expectedVersion: 2 });
    expect(idempotencyKeyOf(posts[1])).toBe(idempotencyKeyOf(posts[0]));

    plaid.succeed('public-should-be-ignored');
    await screen.findByText(/The bank connection is active again/);
    expect(
      postsTo(calls, `/connection-link-attempts/${ATTEMPT_ID}/complete`)[0]
        ?.body,
    ).toEqual({});
  }, 15000);
  it('retains the reconnect request when navigating during its POST', async () => {
    const plaid = installFakePlaid();
    let settle: ((response: Response) => void) | undefined;
    let submissions = 0;
    const { calls, rerenderActive } = renderSection({
      connectionsGet: () =>
        jsonResponse({
          items: [connection()],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
      reconnectPost: () =>
        ++submissions === 1
          ? new Promise<Response>((resolve) => {
              settle = resolve;
            })
          : jsonResponse(
              attempt({ flow: 'UPDATE', connectionId: CONNECTION_ID }),
              201,
            ),
    });
    await screen.findByText(/Active/);
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(postsTo(calls, '/reconnect')).toHaveLength(1));
    rerenderActive(false);
    settle?.(errorResponse('FINANCE_BUSY', 503));
    rerenderActive(true);
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Link a bank' })).toBeDisabled();
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Retry same reconnect request',
      }),
    );
    await waitFor(() => expect(plaid.open).toHaveBeenCalledTimes(1));
    const posts = postsTo(calls, '/reconnect');
    expect(posts).toHaveLength(2);
    expect(posts[1]?.body).toEqual(posts[0]?.body);
    expect(idempotencyKeyOf(posts[1])).toBe(idempotencyKeyOf(posts[0]));
  });
});

describe('durable disconnect requests', () => {
  it('replays the identical disconnect after an unknown outcome', async () => {
    let attempts = 0;
    let lists = 0;
    const { calls } = renderSection({
      connectionsGet: () => {
        lists += 1;
        return jsonResponse({
          items: [
            connection({ state: lists <= 1 ? 'ACTIVE' : 'DISCONNECTED' }),
          ],
          limit: 100,
          offset: 0,
          hasMore: false,
        });
      },
      disconnectPost: () => {
        attempts += 1;
        return attempts === 1
          ? errorResponse('FINANCE_BUSY', 503)
          : jsonResponse(
              operation({ operationType: 'DISCONNECT', state: 'PENDING' }),
              202,
            );
      },
      operationGet: () =>
        jsonResponse(
          operation({ operationType: 'DISCONNECT', state: 'SUCCEEDED' }),
          200,
        ),
    });
    await screen.findByText(/Active/);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    const confirm = await screen.findByRole('group', {
      name: 'Confirm bank disconnection',
    });
    fireEvent.click(
      within(confirm).getByRole('button', { name: 'Disconnect bank' }),
    );

    await screen.findByText(/unknown outcome/);
    // An unknown outcome applies nothing locally: no DISCONNECTING claim.
    expect(screen.queryByText(/Disconnecting…/)).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Retry same disconnect request' }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Retry same disconnect request' }),
    );
    await screen.findAllByText(/Disconnecting/);
    await screen.findByText(/Disconnected/, undefined, { timeout: 6000 });
    const posts = postsTo(calls, '/disconnect');
    expect(posts).toHaveLength(2);
    expect(posts[0]?.body).toEqual({ expectedVersion: 2 });
    expect(posts[1]?.body).toEqual({ expectedVersion: 2 });
    expect(idempotencyKeyOf(posts[1])).toBe(idempotencyKeyOf(posts[0]));
  }, 15000);

  it('restores state and offers refresh when confirmation fails after a failed disconnect', async () => {
    let lists = 0;
    renderSection({
      connectionsGet: () => {
        lists += 1;
        // Initial load, then a failed confirming refetch, then a manual
        // refresh that reports the server truth.
        if (lists === 1) {
          return jsonResponse({
            items: [connection()],
            limit: 100,
            offset: 0,
            hasMore: false,
          });
        }
        if (lists === 2) {
          return errorResponse('UNKNOWN_ERROR', 500);
        }
        return jsonResponse({
          items: [connection({ state: 'DISCONNECTING' })],
          limit: 100,
          offset: 0,
          hasMore: false,
        });
      },
      disconnectPost: () =>
        jsonResponse(
          operation({ operationType: 'DISCONNECT', state: 'PENDING' }),
          202,
        ),
      operationGet: () =>
        jsonResponse(
          operation({ operationType: 'DISCONNECT', state: 'FAILED' }),
          200,
        ),
    });
    await screen.findByText(/Active/);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    const confirm = await screen.findByRole('group', {
      name: 'Confirm bank disconnection',
    });
    fireEvent.click(
      within(confirm).getByRole('button', { name: 'Disconnect bank' }),
    );

    await screen.findAllByText(/Disconnecting/);
    // Terminal failure plus a failed confirming refetch: the optimistic
    // label is withdrawn and a visible refresh path is offered.
    await screen.findByRole(
      'button',
      { name: 'Refresh connections' },
      { timeout: 6000 },
    );
    expect(screen.getByText(/Active/)).toBeInTheDocument();
    expect(screen.queryByText(/Disconnecting…/)).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh connections' }),
    );
    await screen.findAllByText(/Disconnecting/);
  }, 15000);
  it('retains the disconnect request when navigating during its POST', async () => {
    let settle: ((response: Response) => void) | undefined;
    let submissions = 0;
    const { calls, rerenderActive } = renderSection({
      connectionsGet: () =>
        jsonResponse({
          items: [connection()],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
      disconnectPost: () =>
        ++submissions === 1
          ? new Promise<Response>((resolve) => {
              settle = resolve;
            })
          : jsonResponse(
              operation({ operationType: 'DISCONNECT', state: 'SUCCEEDED' }),
              202,
            ),
    });
    await screen.findByText(/Active/);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    const confirm = await screen.findByRole('group', {
      name: 'Confirm bank disconnection',
    });
    fireEvent.click(
      within(confirm).getByRole('button', { name: 'Disconnect bank' }),
    );
    await waitFor(() => expect(postsTo(calls, '/disconnect')).toHaveLength(1));
    rerenderActive(false);
    settle?.(errorResponse('FINANCE_BUSY', 503));
    rerenderActive(true);
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Link a bank' })).toBeDisabled();
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Retry same disconnect request',
      }),
    );
    await waitFor(() => expect(postsTo(calls, '/disconnect')).toHaveLength(2));
    const posts = postsTo(calls, '/disconnect');
    expect(posts[1]?.body).toEqual(posts[0]?.body);
    expect(idempotencyKeyOf(posts[1])).toBe(idempotencyKeyOf(posts[0]));
  });
});

describe('selection replay', () => {
  it('replays the identical selection after an unknown outcome', async () => {
    let selects = 0;
    const { calls, rerenderActive } = renderSection({
      connectionsGet: () =>
        jsonResponse({
          items: [connection()],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
      accountsGet: () =>
        jsonResponse({
          items: [
            {
              mappingId: MAPPING_CHECKING,
              localAccountId: null,
              name: 'Everyday Chequing',
              kind: 'CHECKING',
              currency: 'CAD',
              selected: false,
              eligible: true,
              exclusionReason: null,
            },
          ],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
      selectPost: () => {
        selects += 1;
        return selects === 1
          ? errorResponse('FINANCE_BUSY', 503)
          : jsonResponse({
              connectionId: CONNECTION_ID,
              version: 3,
              accounts: [],
            });
      },
    });
    await screen.findByText(/Active/);
    fireEvent.click(screen.getByRole('button', { name: 'Choose accounts' }));
    await screen.findByText('Everyday Chequing');
    fireEvent.click(screen.getByLabelText(/Everyday Chequing/));
    fireEvent.click(
      screen.getByRole('button', { name: 'Save account selection' }),
    );
    await screen.findByText(/unknown outcome/);
    rerenderActive(false);
    expect(
      screen.queryByRole('button', { name: 'Retry same selection' }),
    ).not.toBeInTheDocument();
    rerenderActive(true);
    expect(
      await screen.findByRole('button', { name: 'Retry same selection' }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry same selection' }),
    );
    await screen.findByText(/Account admission paused/);
    const selectCalls = postsTo(calls, '/account-selection');
    expect(selectCalls).toHaveLength(2);
    expect(selectCalls[0]?.body).toEqual({
      expectedVersion: 2,
      accountMappingIds: [MAPPING_CHECKING],
    });
    expect(selectCalls[1]?.body).toEqual(selectCalls[0]?.body);
    expect(idempotencyKeyOf(selectCalls[1])).toBe(
      idempotencyKeyOf(selectCalls[0]),
    );
  });
  it('replays the original selection key after navigating during its request', async () => {
    let settle: ((response: Response) => void) | undefined;
    let submissions = 0;
    const { calls, rerenderActive } = renderSection({
      connectionsGet: () =>
        jsonResponse({
          items: [connection()],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
      accountsGet: () =>
        jsonResponse({
          items: [mapping()],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
      selectPost: () => {
        submissions += 1;
        return submissions === 1
          ? new Promise<Response>((resolve) => {
              settle = resolve;
            })
          : jsonResponse({
              connectionId: CONNECTION_ID,
              version: 3,
              accounts: [],
            });
      },
    });
    await screen.findByText(/Active/);
    fireEvent.click(screen.getByRole('button', { name: 'Choose accounts' }));
    await screen.findByText('Everyday Chequing');
    fireEvent.click(screen.getByLabelText(/Everyday Chequing/));
    fireEvent.click(
      screen.getByRole('button', { name: 'Save account selection' }),
    );
    await waitFor(() =>
      expect(postsTo(calls, '/account-selection')).toHaveLength(1),
    );
    rerenderActive(false);
    settle?.(errorResponse('FINANCE_BUSY', 503));
    rerenderActive(true);
    expect(screen.getByLabelText(/Everyday Chequing/)).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Save account selection' }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeDisabled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Save account selection' }),
    );
    expect(postsTo(calls, '/account-selection')).toHaveLength(1);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Retry same selection' }),
    );
    await screen.findByText(/Account admission paused/);
    const posts = postsTo(calls, '/account-selection');
    expect(posts).toHaveLength(2);
    expect(posts[1]?.body).toEqual(posts[0]?.body);
    expect(idempotencyKeyOf(posts[1])).toBe(idempotencyKeyOf(posts[0]));
  });
});

describe('connection focus management', () => {
  it('lands focus on the section heading after disconnect starts', async () => {
    let lists = 0;
    renderSection({
      connectionsGet: () => {
        lists += 1;
        return jsonResponse({
          items: [
            connection({ state: lists <= 1 ? 'ACTIVE' : 'DISCONNECTED' }),
          ],
          limit: 100,
          offset: 0,
          hasMore: false,
        });
      },
      disconnectPost: () =>
        jsonResponse(
          operation({ operationType: 'DISCONNECT', state: 'PENDING' }),
          202,
        ),
      operationGet: () =>
        jsonResponse(
          operation({ operationType: 'DISCONNECT', state: 'SUCCEEDED' }),
          200,
        ),
    });
    await screen.findByText(/Active/);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    const confirm = await screen.findByRole('group', {
      name: 'Confirm bank disconnection',
    });
    fireEvent.click(
      within(confirm).getByRole('button', { name: 'Disconnect bank' }),
    );
    // The row trigger unmounts once DISCONNECTING renders, so focus lands
    // on the stable section heading instead of being lost.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: 'Bank connections' }),
      ),
    );
    await screen.findByText(/Disconnected/, undefined, { timeout: 6000 });
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Bank connections' }),
    );
  }, 15000);

  it('leaves focus alone for background poll outcomes', async () => {
    const plaid = installFakePlaid();
    let polled = 0;
    renderSection({
      connectionsGet: () =>
        jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false }),
      startPost: () => jsonResponse(attempt(), 201),
      completePost: () => jsonResponse(operation({ state: 'PENDING' }), 202),
      operationGet: () => {
        polled += 1;
        return jsonResponse(operation({ state: 'SUCCEEDED' }), 200);
      },
    });
    await screen.findByText(/No bank connections yet/);
    const heading = screen.getByRole('heading', { name: 'Bank connections' });
    heading.focus();
    fireEvent.click(screen.getByRole('button', { name: 'Link a bank' }));
    await waitFor(() => expect(plaid.open).toHaveBeenCalledTimes(1));
    plaid.succeed('public-sandbox-1');
    await screen.findByText(/The bank connection is ready/, undefined, {
      timeout: 6000,
    });
    expect(polled).toBeGreaterThanOrEqual(1);
    expect(document.activeElement).toBe(heading);
  }, 15000);

  it('focuses user-triggered error notices', async () => {
    renderSection({
      connectionsGet: () =>
        jsonResponse({
          items: [connection()],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
      accountsGet: () =>
        jsonResponse({
          items: [
            {
              mappingId: MAPPING_CHECKING,
              localAccountId: null,
              name: 'Everyday Chequing',
              kind: 'CHECKING',
              currency: 'CAD',
              selected: false,
              eligible: true,
              exclusionReason: null,
            },
          ],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
      selectPost: () => errorResponse('RESOURCE_VERSION_CONFLICT', 409),
    });
    await screen.findByText(/Active/);
    fireEvent.click(screen.getByRole('button', { name: 'Choose accounts' }));
    await screen.findByText('Everyday Chequing');
    fireEvent.click(screen.getByLabelText(/Everyday Chequing/));
    fireEvent.click(
      screen.getByRole('button', { name: 'Save account selection' }),
    );
    await screen.findByText(/Review your selection/);
    expect(document.activeElement?.textContent).toMatch(
      /Review your selection/,
    );
  });

  it('announces the resumable attempt as a live status', async () => {
    const plaid = installFakePlaid();
    renderSection({
      connectionsGet: () =>
        jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false }),
      startPost: () => jsonResponse(attempt(), 201),
    });
    await screen.findByText(/No bank connections yet/);
    fireEvent.click(screen.getByRole('button', { name: 'Link a bank' }));
    await waitFor(() => expect(plaid.open).toHaveBeenCalledTimes(1));
    plaid.exit(null);
    await screen.findByRole('button', { name: 'Resume bank step' });
    const block = screen.getByText(/lives in this tab only/).closest('div');
    expect(block).toHaveAttribute('role', 'status');
  });
});

describe('successful outcomes with failed confirmation', () => {
  it('keeps a confirmed disconnect honest with a refresh path when confirmation fails', async () => {
    let lists = 0;
    const { calls } = renderSection({
      connectionsGet: () => {
        lists += 1;
        // Initial load, then a failed confirming refetch, then a manual
        // refresh that reports the server truth.
        if (lists === 1) {
          return jsonResponse({
            items: [connection()],
            limit: 100,
            offset: 0,
            hasMore: false,
          });
        }
        if (lists === 2) {
          return errorResponse('UNKNOWN_ERROR', 500);
        }
        return jsonResponse({
          items: [connection({ state: 'DISCONNECTED' })],
          limit: 100,
          offset: 0,
          hasMore: false,
        });
      },
      disconnectPost: () =>
        jsonResponse(
          operation({ operationType: 'DISCONNECT', state: 'PENDING' }),
          202,
        ),
      operationGet: () =>
        jsonResponse(
          operation({ operationType: 'DISCONNECT', state: 'SUCCEEDED' }),
          200,
        ),
    });
    await screen.findByText(/Active/);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    const confirm = await screen.findByRole('group', {
      name: 'Confirm bank disconnection',
    });
    fireEvent.click(
      within(confirm).getByRole('button', { name: 'Disconnect bank' }),
    );

    await screen.findAllByText(/Disconnecting/);
    // The durable success stands, but the confirming read failed: success
    // copy stays with a visible refresh path instead of a stale row alone.
    await screen.findByRole(
      'button',
      { name: 'Refresh connections' },
      { timeout: 6000 },
    );
    expect(
      screen.getByText(/admitted history stays in your private accounts/),
    ).toBeInTheDocument();
    expect(screen.getByText(/confirm the current state/)).toBeInTheDocument();
    // Not turned into failure and never repeated.
    expect(screen.queryByText(/could not be confirmed/)).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Retry disconnect' }),
    ).toBeNull();
    expect(postsTo(calls, '/disconnect')).toHaveLength(1);

    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh connections' }),
    );
    await screen.findByText(/Disconnected/);
  }, 15000);

  it('offers refresh without repeating when link confirmation fails after success', async () => {
    const plaid = installFakePlaid();
    let lists = 0;
    const { calls } = renderSection({
      connectionsGet: () => {
        lists += 1;
        if (lists === 1) {
          return jsonResponse({
            items: [],
            limit: 100,
            offset: 0,
            hasMore: false,
          });
        }
        if (lists === 2) {
          return errorResponse('UNKNOWN_ERROR', 500);
        }
        return jsonResponse({
          items: [connection({ state: 'ACTIVE', version: 0 })],
          limit: 100,
          offset: 0,
          hasMore: false,
        });
      },
      startPost: () => jsonResponse(attempt(), 201),
      completePost: () => jsonResponse(operation({ state: 'SUCCEEDED' }), 202),
    });
    await screen.findByText(/No bank connections yet/);
    fireEvent.click(screen.getByRole('button', { name: 'Link a bank' }));
    await waitFor(() => expect(plaid.open).toHaveBeenCalledTimes(1));
    plaid.succeed('public-sandbox-1');

    // Immediate terminal success with a failed confirming read: success
    // copy stays, a refresh path appears, and the completion is not sent
    // a second time.
    await screen.findByRole(
      'button',
      { name: 'Refresh connections' },
      { timeout: 6000 },
    );
    expect(
      screen.getByText(/The bank connection is ready/),
    ).toBeInTheDocument();
    expect(screen.getByText(/confirm the current state/)).toBeInTheDocument();
    expect(
      postsTo(calls, `/connection-link-attempts/${ATTEMPT_ID}/complete`),
    ).toHaveLength(1);

    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh connections' }),
    );
    await screen.findByText('Test bank connection');
  }, 15000);
});
