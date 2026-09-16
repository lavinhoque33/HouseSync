import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  fetchFinancialAccounts,
  patchFinancialAccount,
  postFinancialAccount,
  type CreateFinancialAccountInput,
} from '../auth/client';

const CSRF = { token: 'csrf-token-1', headerName: 'X-CSRF-TOKEN' };
const HOUSEHOLD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ACCOUNT_ID = '10000000-0000-4000-8000-000000000001';

function validAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT_ID,
    householdId: HOUSEHOLD_ID,
    ownerUserId: '30000000-0000-4000-8000-000000000001',
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

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
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

describe('financial account typed client', () => {
  it('lists own accounts over the documented query and page shape', async () => {
    const calls = stubFetch((url) => {
      expect(url).toBe(
        `/api/households/${HOUSEHOLD_ID}/financial-accounts?limit=100&offset=0&status=ALL`,
      );
      return jsonResponse({
        items: [validAccount()],
        limit: 100,
        offset: 0,
        hasMore: false,
      });
    });
    const page = await fetchFinancialAccounts(HOUSEHOLD_ID);
    expect(page).toEqual({
      items: [validAccount()],
      limit: 100,
      offset: 0,
      hasMore: false,
    });
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.credentials).toBe('include');
    expect(calls[0]?.init?.cache).toBe('no-store');
    expect(calls[0]?.init?.headers).toMatchObject({
      Accept: 'application/json',
    });
  });

  it('rejects a list item outside the exact account contract', async () => {
    const malformed = [
      // Unsupported kind.
      validAccount({ kind: 'WALLET' }),
      // Unsupported status.
      validAccount({ status: 'FROZEN' }),
      // visibility HOUSEHOLD is not valid on an account.
      validAccount({ visibility: 'HOUSEHOLD' }),
      // Fractional version.
      validAccount({ version: 1.5 }),
      // Missing server timestamps.
      { ...validAccount(), updatedAt: undefined },
      // Not an object at all.
      'account',
    ];
    for (const item of malformed) {
      stubFetch(() =>
        jsonResponse({ items: [item], limit: 100, offset: 0, hasMore: false }),
      );
      const failure = await fetchFinancialAccounts(HOUSEHOLD_ID).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure as ApiError).toMatchObject({ code: 'UNKNOWN_ERROR' });
    }
  });

  it('creates with the exact fields, an idempotency key, and CSRF', async () => {
    const input: CreateFinancialAccountInput = {
      name: 'Daily spending',
      kind: 'CASH',
      currency: 'USD',
    };
    const calls = stubFetch((url) => {
      expect(url).toBe(`/api/households/${HOUSEHOLD_ID}/financial-accounts`);
      return jsonResponse(validAccount({ kind: 'CASH', currency: 'USD' }), 201);
    });
    const created = await postFinancialAccount(
      HOUSEHOLD_ID,
      input,
      '11111111-2222-4333-8444-555555555555',
      CSRF,
    );
    expect(created.name).toBe('Daily spending');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toMatchObject({
      'X-CSRF-TOKEN': CSRF.token,
      'Idempotency-Key': '11111111-2222-4333-8444-555555555555',
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(input);
  });

  it('accepts the 200 same-key replay like a new creation', async () => {
    stubFetch(() => jsonResponse(validAccount(), 200));
    const replayed = await postFinancialAccount(
      HOUSEHOLD_ID,
      { name: 'Daily spending', kind: 'CHECKING', currency: 'BRL' },
      '11111111-2222-4333-8444-555555555555',
      CSRF,
    );
    expect(replayed.id).toBe(ACCOUNT_ID);
  });

  it('preserves safe creation errors with correlation and field errors', async () => {
    stubFetch(() =>
      jsonResponse(
        {
          code: 'VALIDATION_FAILED',
          message: 'Check the highlighted fields.',
          correlationId: 'corr-create',
          fieldErrors: {
            name: 'Account name must be at most 100 characters.',
            injected: 'must-be-dropped',
          },
        },
        400,
      ),
    );
    const failure = await postFinancialAccount(
      HOUSEHOLD_ID,
      { name: 'x'.repeat(101), kind: 'CASH', currency: 'BRL' },
      '11111111-2222-4333-8444-555555555555',
      CSRF,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    const apiError = failure as ApiError;
    expect(apiError.code).toBe('VALIDATION_FAILED');
    expect(apiError.correlationId).toBe('corr-create');
    expect(apiError.fieldErrors).toEqual({
      name: 'Account name must be at most 100 characters.',
    });
  });

  it('surfaces an unknown create outcome as a network-timeout error', async () => {
    stubFetch(() => jsonResponse({ code: 'FINANCE_BUSY' }, 503));
    const failure = await postFinancialAccount(
      HOUSEHOLD_ID,
      { name: 'Daily spending', kind: 'CASH', currency: 'BRL' },
      '11111111-2222-4333-8444-555555555555',
      CSRF,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure as ApiError).toMatchObject({
      status: 503,
      code: 'FINANCE_BUSY',
    });
  });

  it('patches with expectedVersion and immutable fields untouched', async () => {
    const calls = stubFetch((url) => {
      expect(url).toBe(
        `/api/households/${HOUSEHOLD_ID}/financial-accounts/${ACCOUNT_ID}`,
      );
      return jsonResponse(validAccount({ name: 'Renamed', version: 1 }));
    });
    const updated = await patchFinancialAccount(
      HOUSEHOLD_ID,
      ACCOUNT_ID,
      { expectedVersion: 0, name: 'Renamed' },
      CSRF,
    );
    expect(updated).toEqual(validAccount({ name: 'Renamed', version: 1 }));
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      expectedVersion: 0,
      name: 'Renamed',
    });
  });

  it('maps stale updates to the version-conflict error', async () => {
    stubFetch(() =>
      jsonResponse(
        {
          code: 'RESOURCE_VERSION_CONFLICT',
          message: 'The account changed; refresh before retrying.',
          correlationId: 'corr-stale',
        },
        409,
      ),
    );
    const failure = await patchFinancialAccount(
      HOUSEHOLD_ID,
      ACCOUNT_ID,
      { expectedVersion: 0, status: 'ARCHIVED' },
      CSRF,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    const apiError = failure as ApiError;
    expect(apiError.status).toBe(409);
    expect(apiError.code).toBe('RESOURCE_VERSION_CONFLICT');
    expect(apiError.correlationId).toBe('corr-stale');
  });

  it('identifies foreign or hidden accounts with the safe not-found code', async () => {
    stubFetch(() =>
      jsonResponse(
        {
          code: 'FINANCIAL_ACCOUNT_NOT_FOUND',
          message: 'Account is unavailable.',
          correlationId: 'corr-404',
        },
        404,
      ),
    );
    const failure = await patchFinancialAccount(
      HOUSEHOLD_ID,
      ACCOUNT_ID,
      { expectedVersion: 0, status: 'ARCHIVED' },
      CSRF,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure as ApiError).toMatchObject({
      code: 'FINANCIAL_ACCOUNT_NOT_FOUND',
    });
  });

  it('bounds a stalled creation by the deadline with an unknown outcome', async () => {
    stubFetch(
      () =>
        ({
          status: 200,
          ok: true,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          text: () => new Promise<string>(() => {}),
        }) as unknown as Response,
    );
    const started = Date.now();
    const failure = await postFinancialAccount(
      HOUSEHOLD_ID,
      { name: 'Daily spending', kind: 'CASH', currency: 'BRL' },
      '11111111-2222-4333-8444-555555555555',
      CSRF,
      undefined,
      50,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure as ApiError).toMatchObject({
      code: 'NETWORK_ERROR',
      timedOut: true,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
