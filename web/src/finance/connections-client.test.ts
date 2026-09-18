import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  completeConnectionLink,
  fetchConnectionAccounts,
  fetchConnectionOperation,
  fetchFinancialConnection,
  fetchFinancialConnections,
  postAccountSelection,
  postConnectionDisconnect,
  postConnectionReconnect,
  startConnectionLink,
} from '../auth/client';

const CSRF = { token: 'csrf-token-1', headerName: 'X-CSRF-TOKEN' };
const HOUSEHOLD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CONNECTION_ID = '10000000-0000-4000-8000-000000000001';
const ATTEMPT_ID = '20000000-0000-4000-8000-000000000002';
const OPERATION_ID = '30000000-0000-4000-8000-000000000003';
const MAPPING_ID = '40000000-0000-4000-8000-000000000004';
const KEY = '11111111-2222-4333-8444-555555555555';

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    id: ATTEMPT_ID,
    flow: 'NEW',
    provider: 'PLAID',
    connectionId: null,
    linkToken: 'link-sandbox-memory-only',
    expiresAt: '2026-09-17T01:00:00Z',
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
    statusUrl: `/api/households/${HOUSEHOLD_ID}/connection-operations/${OPERATION_ID}`,
    createdAt: '2026-09-17T00:00:00Z',
    updatedAt: '2026-09-17T00:00:00Z',
    ...overrides,
  };
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    householdId: HOUSEHOLD_ID,
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

function mapping(overrides: Record<string, unknown> = {}) {
  return {
    mappingId: MAPPING_ID,
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

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

type Call = { url: string; init?: RequestInit | undefined };

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      return handler(url, init);
    }),
  );
  return calls;
}

function errorBody(code: string, status: number) {
  return jsonResponse(
    { code, message: 'Safe message.', correlationId: 'corr-1' },
    status,
  );
}

describe('connection link client', () => {
  it('starts with an empty body, CSRF, and an idempotency key', async () => {
    const calls = stubFetch((url, init) => {
      expect(url).toBe(
        `/api/households/${HOUSEHOLD_ID}/connection-link-attempts`,
      );
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe('{}');
      return jsonResponse(attempt(), 201);
    });
    const started = await startConnectionLink(HOUSEHOLD_ID, KEY, CSRF);
    expect(started.id).toBe(ATTEMPT_ID);
    expect(calls[0]?.init?.headers).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-CSRF-TOKEN': 'csrf-token-1',
      'Idempotency-Key': KEY,
    });
    expect(calls[0]?.init?.credentials).toBe('include');
    expect(calls[0]?.init?.cache).toBe('no-store');
  });

  it('accepts a same-key start replay with 200', async () => {
    stubFetch(() => jsonResponse(attempt(), 200));
    const replayed = await startConnectionLink(HOUSEHOLD_ID, KEY, CSRF);
    expect(replayed.linkToken).toBe('link-sandbox-memory-only');
  });

  it('surfaces link expiry and unknown attempts with exact codes', async () => {
    stubFetch(() => errorBody('LINK_ATTEMPT_EXPIRED', 409));
    const expired = await startConnectionLink(HOUSEHOLD_ID, KEY, CSRF).then(
      () => null,
      (error: unknown) => error,
    );
    expect(expired).toMatchObject({
      code: 'LINK_ATTEMPT_EXPIRED',
      status: 409,
    });

    stubFetch(() => errorBody('FINANCIAL_CONNECTION_NOT_FOUND', 404));
    const missing = await fetchFinancialConnection(
      HOUSEHOLD_ID,
      CONNECTION_ID,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(missing).toMatchObject({
      code: 'FINANCIAL_CONNECTION_NOT_FOUND',
      status: 404,
    });
  });

  it('completes NEW links with the public token and UPDATE with an empty body', async () => {
    const bodies: string[] = [];
    stubFetch((_url, init) => {
      bodies.push(String(init?.body));
      return jsonResponse(operation({ state: 'SUCCEEDED' }), 202);
    });
    await completeConnectionLink(
      HOUSEHOLD_ID,
      ATTEMPT_ID,
      { publicToken: 'public-sandbox-x' },
      KEY,
      CSRF,
    );
    await completeConnectionLink(HOUSEHOLD_ID, ATTEMPT_ID, {}, KEY, CSRF);
    expect(bodies).toEqual(['{"publicToken":"public-sandbox-x"}', '{}']);
  });

  it('rejects a completion outside the operation contract', async () => {
    stubFetch(() => jsonResponse({ id: OPERATION_ID }, 202));
    const failure = await completeConnectionLink(
      HOUSEHOLD_ID,
      ATTEMPT_ID,
      {},
      KEY,
      CSRF,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 'UNKNOWN_ERROR' });
  });

  it('maps unauthenticated completions to sign-in recovery', async () => {
    stubFetch(() => errorBody('UNAUTHENTICATED', 401));
    const failure = await completeConnectionLink(
      HOUSEHOLD_ID,
      ATTEMPT_ID,
      {},
      KEY,
      CSRF,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
  });
});

describe('operation polling client', () => {
  it('polls behind the exact status URL and parses terminal states', async () => {
    const calls = stubFetch((url) => {
      expect(url).toBe(
        `/api/households/${HOUSEHOLD_ID}/connection-operations/${OPERATION_ID}`,
      );
      return jsonResponse(
        operation({ state: 'OUTCOME_UNKNOWN', errorCode: 'EXCHANGE_UNKNOWN' }),
      );
    });
    const polled = await fetchConnectionOperation(
      `/api/households/${HOUSEHOLD_ID}/connection-operations/${OPERATION_ID}`,
    );
    expect(polled.state).toBe('OUTCOME_UNKNOWN');
    expect(polled.errorCode).toBe('EXCHANGE_UNKNOWN');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('bounds the wait so a hung poll reports an unknown outcome', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            // Settles only through cancellation, like a stalled body: the
            // client deadline must win and report an unknown outcome.
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted.', 'AbortError'));
            });
          }),
      ),
    );
    const failure = await fetchConnectionOperation(
      `/api/households/${HOUSEHOLD_ID}/connection-operations/${OPERATION_ID}`,
      undefined,
      20,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure as ApiError).toMatchObject({
      code: 'NETWORK_ERROR',
      timedOut: true,
    });
  });
});

describe('connection read client', () => {
  it('lists private connections over the bounded query', async () => {
    const calls = stubFetch((url) => {
      expect(url).toBe(
        `/api/households/${HOUSEHOLD_ID}/financial-connections?limit=100&offset=0`,
      );
      return jsonResponse({
        items: [connection()],
        limit: 100,
        offset: 0,
        hasMore: false,
      });
    });
    const page = await fetchFinancialConnections(HOUSEHOLD_ID);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.state).toBe('ACTIVE');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('loads discovered mappings behind local IDs', async () => {
    stubFetch((url) => {
      expect(url).toBe(
        `/api/households/${HOUSEHOLD_ID}/financial-connections/${CONNECTION_ID}/accounts?limit=100&offset=0`,
      );
      return jsonResponse({
        items: [mapping()],
        limit: 100,
        offset: 0,
        hasMore: false,
      });
    });
    const page = await fetchConnectionAccounts(HOUSEHOLD_ID, CONNECTION_ID);
    expect(page.items[0]).toMatchObject({
      mappingId: MAPPING_ID,
      currency: 'CAD',
      selected: false,
      eligible: true,
    });
  });

  it('passes the disabled-deployment code through without provider detail', async () => {
    stubFetch(() => errorBody('CONNECTED_FINANCE_DISABLED', 503));
    const failure = await fetchFinancialConnections(HOUSEHOLD_ID).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      code: 'CONNECTED_FINANCE_DISABLED',
      status: 503,
    });
  });
});

describe('connection mutation client', () => {
  it('saves selection with the exact versioned body', async () => {
    const calls = stubFetch((url, init) => {
      expect(url).toBe(
        `/api/households/${HOUSEHOLD_ID}/financial-connections/${CONNECTION_ID}/account-selection`,
      );
      expect(init?.body).toBe(
        `{"expectedVersion":0,"accountMappingIds":["${MAPPING_ID}"]}`,
      );
      return jsonResponse({
        connectionId: CONNECTION_ID,
        version: 1,
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
      });
    });
    const result = await postAccountSelection(
      HOUSEHOLD_ID,
      CONNECTION_ID,
      0,
      [MAPPING_ID],
      KEY,
      CSRF,
    );
    expect(result.version).toBe(1);
    expect(result.accounts[0]?.source).toBe('CONNECTED');
    expect(calls[0]?.init?.headers).toMatchObject({ 'Idempotency-Key': KEY });
  });

  it('surfaces stale versions and not-ready connections distinctly', async () => {
    stubFetch(() => errorBody('RESOURCE_VERSION_CONFLICT', 409));
    const stale = await postAccountSelection(
      HOUSEHOLD_ID,
      CONNECTION_ID,
      99,
      [MAPPING_ID],
      KEY,
      CSRF,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(stale).toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT' });

    stubFetch(() => errorBody('CONNECTION_NOT_READY', 409));
    const notReady = await postAccountSelection(
      HOUSEHOLD_ID,
      CONNECTION_ID,
      0,
      [MAPPING_ID],
      KEY,
      CSRF,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(notReady).toMatchObject({ code: 'CONNECTION_NOT_READY' });

    stubFetch(() => errorBody('IDEMPOTENCY_CONFLICT', 409));
    const conflict = await postAccountSelection(
      HOUSEHOLD_ID,
      CONNECTION_ID,
      0,
      [MAPPING_ID],
      KEY,
      CSRF,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(conflict).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('starts reconnect with the expected version and disconnects with 202', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/reconnect')) {
        expect(init?.body).toBe('{"expectedVersion":2}');
        return jsonResponse(
          attempt({ flow: 'UPDATE', connectionId: CONNECTION_ID }),
          201,
        );
      }
      expect(url.endsWith('/disconnect')).toBe(true);
      expect(init?.body).toBe('{"expectedVersion":3}');
      return jsonResponse(
        operation({ operationType: 'DISCONNECT', state: 'PENDING' }),
        202,
      );
    });
    const update = await postConnectionReconnect(
      HOUSEHOLD_ID,
      CONNECTION_ID,
      2,
      KEY,
      CSRF,
    );
    expect(update.flow).toBe('UPDATE');
    const removal = await postConnectionDisconnect(
      HOUSEHOLD_ID,
      CONNECTION_ID,
      3,
      KEY,
      CSRF,
    );
    expect(removal.operationType).toBe('DISCONNECT');
  });

  it('reports disconnected connections with the exact terminal code', async () => {
    stubFetch(() => errorBody('CONNECTION_DISCONNECTED', 409));
    const failure = await postConnectionDisconnect(
      HOUSEHOLD_ID,
      CONNECTION_ID,
      4,
      KEY,
      CSRF,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 'CONNECTION_DISCONNECTED' });
  });
});

describe('widened account source', () => {
  it('still parses manual accounts and now admits connected ones', async () => {
    const { fetchFinancialAccounts } = await import('../auth/client');
    const connected = {
      id: '50000000-0000-4000-8000-000000000005',
      householdId: HOUSEHOLD_ID,
      ownerUserId: '30000000-0000-4000-8000-000000000001',
      name: 'Everyday Chequing',
      kind: 'CHECKING',
      currency: 'CAD',
      source: 'CONNECTED',
      visibility: 'PRIVATE',
      status: 'ACTIVE',
      version: 0,
      createdAt: '2026-09-17T00:00:00Z',
      updatedAt: '2026-09-17T00:00:00Z',
    };
    stubFetch(() =>
      jsonResponse({
        items: [connected],
        limit: 100,
        offset: 0,
        hasMore: false,
      }),
    );
    const page = await fetchFinancialAccounts(HOUSEHOLD_ID);
    expect(page.items[0]?.source).toBe('CONNECTED');

    stubFetch(() =>
      jsonResponse({
        items: [{ ...connected, source: 'BANK' }],
        limit: 100,
        offset: 0,
        hasMore: false,
      }),
    );
    const failure = await fetchFinancialAccounts(HOUSEHOLD_ID).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 'UNKNOWN_ERROR' });
  });
});
