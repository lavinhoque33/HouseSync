import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  fetchTransaction,
  fetchTransactions,
  patchTransaction,
  postTransaction,
  type CreateTransactionInput,
} from '../auth/client';

const CSRF = { token: 'csrf-token-1', headerName: 'X-CSRF-TOKEN' };
const HOUSEHOLD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TRANSACTION_ID = '40000000-0000-4000-8000-000000000001';
const ACCOUNT_ID = '10000000-0000-4000-8000-000000000001';

function validTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: TRANSACTION_ID,
    householdId: HOUSEHOLD_ID,
    ownerUserId: '30000000-0000-4000-8000-000000000001',
    accountId: ACCOUNT_ID,
    kind: 'EXPENSE',
    money: { amount: '-12.34', currency: 'BRL' },
    occurredOn: '2026-09-16',
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

const EXPENSE_INPUT: CreateTransactionInput = {
  accountId: ACCOUNT_ID,
  kind: 'EXPENSE',
  money: { amount: '-12.34', currency: 'BRL' },
  occurredOn: '2026-09-16',
  description: 'Groceries',
  visibility: 'PRIVATE',
};

describe('transaction typed client', () => {
  it('lists own transactions over the documented query and page shape', async () => {
    const calls = stubFetch((url) => {
      expect(url).toBe(
        `/api/households/${HOUSEHOLD_ID}/transactions?limit=100&offset=0&view=OWN&status=ALL`,
      );
      return jsonResponse({
        items: [validTransaction()],
        limit: 100,
        offset: 0,
        hasMore: false,
      });
    });
    const page = await fetchTransactions(HOUSEHOLD_ID);
    expect(page).toEqual({
      items: [validTransaction()],
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

  it('rejects an item outside the exact 15-field transaction contract', async () => {
    const malformed: Array<Record<string, unknown>> = [
      // Unsupported kind.
      validTransaction({ kind: 'FEE' }),
      // Unsupported status.
      validTransaction({ status: 'PENDING' }),
      // Household disclosure is not parsed here.
      validTransaction({ visibility: 'HOUSEHOLD' }),
      // Non-manual source.
      validTransaction({ source: 'PROVIDER' }),
      // Money as a JSON number is never coerced.
      validTransaction({ money: { amount: -12.34, currency: 'BRL' } }),
      // Wrong currency scale on a stored amount.
      validTransaction({ money: { amount: '-12.3', currency: 'BRL' } }),
      // Scale-0 currency with a decimal point.
      validTransaction({ money: { amount: '12.0', currency: 'JPY' } }),
      // Zero transactions are not representable.
      validTransaction({ money: { amount: '0.00', currency: 'BRL' } }),
      // Negative zero.
      validTransaction({ money: { amount: '-0.00', currency: 'BRL' } }),
      // Exponent notation.
      validTransaction({ money: { amount: '1e5', currency: 'BRL' } }),
      // Leading zero.
      validTransaction({ money: { amount: '012.00', currency: 'BRL' } }),
      // Unsupported currency code.
      validTransaction({ money: { amount: '-12.34', currency: 'CHF' } }),
      // Impossible calendar date.
      validTransaction({ occurredOn: '2026-02-30' }),
      // Leap-day misuse.
      validTransaction({ occurredOn: '2025-02-29' }),
      // Outside the supported range.
      validTransaction({ occurredOn: '1899-12-31' }),
      // The reserved exclusive reporting boundary.
      validTransaction({ occurredOn: '9999-12-31' }),
      // Fractional version.
      validTransaction({ version: 1.5 }),
      // Beyond the documented nonnegative 32-bit integer bound.
      validTransaction({ version: 2147483648 }),
      // Refund marker on a non-refund.
      validTransaction({ refundOfTransactionId: TRANSACTION_ID }),
      // Missing refund source on a refund.
      validTransaction({ kind: 'REFUND', refundOfTransactionId: null }),
      // A null accountId belongs to household-feed redaction only.
      validTransaction({ accountId: null }),
      // Missing server timestamps.
      { ...validTransaction(), updatedAt: undefined },
      // Extra top-level field: the DTO is exactly 15 fields.
      {
        ...validTransaction(),
        accountName: 'Daily spending',
      } as unknown as Record<string, unknown>,
      // Not an object at all.
      'transaction' as unknown as Record<string, unknown>,
    ];
    for (const item of malformed) {
      stubFetch(() =>
        jsonResponse({ items: [item], limit: 100, offset: 0, hasMore: false }),
      );
      const failure = await fetchTransactions(HOUSEHOLD_ID).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure as ApiError).toMatchObject({
        code: 'UNKNOWN_ERROR',
        message: 'The server returned an unexpected transaction response.',
      });
    }
  });

  it('accepts documented scale padding, refund shapes, and the version bound', async () => {
    stubFetch(() =>
      jsonResponse({
        items: [
          validTransaction({
            kind: 'REFUND',
            money: { amount: '1.000', currency: 'KWD' },
            refundOfTransactionId: '40000000-0000-4000-8000-000000000002',
          }),
          validTransaction({
            kind: 'TRANSFER',
            money: { amount: '20', currency: 'JPY' },
          }),
          validTransaction({
            money: { amount: '999999999999.99', currency: 'BRL' },
          }),
          validTransaction({
            kind: 'INCOME',
            money: { amount: '0.01', currency: 'USD' },
          }),
          validTransaction({
            money: { amount: '999999999999.999', currency: 'KWD' },
          }),
          // The exact documented maximum version stays parseable.
          validTransaction({ version: 2147483647 }),
        ],
        limit: 100,
        offset: 0,
        hasMore: true,
      }),
    );
    const page = await fetchTransactions(HOUSEHOLD_ID);
    expect(page.items).toHaveLength(6);
    expect(page.hasMore).toBe(true);
  });

  it('creates with the exact body, one idempotency key, and CSRF', async () => {
    const calls = stubFetch((url) => {
      expect(url).toBe(`/api/households/${HOUSEHOLD_ID}/transactions`);
      return jsonResponse(validTransaction(), 201);
    });
    const created = await postTransaction(
      HOUSEHOLD_ID,
      EXPENSE_INPUT,
      '11111111-2222-4333-8444-555555555555',
      CSRF,
    );
    expect(created.description).toBe('Groceries');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toMatchObject({
      'X-CSRF-TOKEN': CSRF.token,
      'Idempotency-Key': '11111111-2222-4333-8444-555555555555',
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(EXPENSE_INPUT);
  });

  it('sends a refund payload with its source and inherited visibility omitted', async () => {
    const refundInput: CreateTransactionInput = {
      accountId: ACCOUNT_ID,
      kind: 'REFUND',
      money: { amount: '5.00', currency: 'BRL' },
      occurredOn: '2026-09-17',
      description: 'Returned one item',
      refundOfTransactionId: TRANSACTION_ID,
    };
    const calls = stubFetch(() =>
      jsonResponse(
        validTransaction({
          kind: 'REFUND',
          money: { amount: '5.00', currency: 'BRL' },
          refundOfTransactionId: TRANSACTION_ID,
        }),
        201,
      ),
    );
    await postTransaction(
      HOUSEHOLD_ID,
      refundInput,
      '11111111-2222-4333-8444-555555555555',
      CSRF,
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(refundInput);
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<
      string,
      unknown
    >;
    expect(body.visibility).toBeUndefined();
    expect(body.refundOfTransactionId).toBe(TRANSACTION_ID);
  });

  it('accepts the 200 same-key replay like a new creation', async () => {
    stubFetch(() => jsonResponse(validTransaction({ version: 2 }), 200));
    const replayed = await postTransaction(
      HOUSEHOLD_ID,
      EXPENSE_INPUT,
      '11111111-2222-4333-8444-555555555555',
      CSRF,
    );
    expect(replayed.version).toBe(2);
  });

  it('preserves safe creation errors with correlation and nested field errors', async () => {
    stubFetch(() =>
      jsonResponse(
        {
          code: 'VALIDATION_FAILED',
          message: 'Check the highlighted fields.',
          correlationId: 'corr-create',
          fieldErrors: {
            'money.amount': 'That amount is not accepted.',
            injected: 'must-be-dropped',
          },
        },
        400,
      ),
    );
    const failure = await postTransaction(
      HOUSEHOLD_ID,
      EXPENSE_INPUT,
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
      'money.amount': 'That amount is not accepted.',
    });
  });

  it('surfaces finance lock contention and key conflicts with their codes', async () => {
    const cases: Array<[Response, string, number]> = [
      [jsonResponse({ code: 'FINANCE_BUSY' }, 503), 'FINANCE_BUSY', 503],
      [
        jsonResponse(
          { code: 'IDEMPOTENCY_CONFLICT', message: 'Key reused.' },
          409,
        ),
        'IDEMPOTENCY_CONFLICT',
        409,
      ],
      [
        jsonResponse({ code: 'ACCOUNT_ARCHIVED' }, 409),
        'ACCOUNT_ARCHIVED',
        409,
      ],
      [jsonResponse({ code: 'REFUND_CONFLICT' }, 409), 'REFUND_CONFLICT', 409],
    ];
    for (const [response, code, status] of cases) {
      stubFetch(() => response);
      const failure = await postTransaction(
        HOUSEHOLD_ID,
        EXPENSE_INPUT,
        '11111111-2222-4333-8444-555555555555',
        CSRF,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure as ApiError).toMatchObject({ status, code });
    }
  });

  it('fetches a single authorized entry', async () => {
    stubFetch((url) => {
      expect(url).toBe(
        `/api/households/${HOUSEHOLD_ID}/transactions/${TRANSACTION_ID}`,
      );
      return jsonResponse(validTransaction());
    });
    const detail = await fetchTransaction(HOUSEHOLD_ID, TRANSACTION_ID);
    expect(detail.id).toBe(TRANSACTION_ID);
  });

  it('maps a hidden or stale detail to the safe not-found code', async () => {
    stubFetch(() =>
      jsonResponse(
        {
          code: 'TRANSACTION_NOT_FOUND',
          message: 'Transaction is unavailable.',
          correlationId: 'corr-404',
        },
        404,
      ),
    );
    const failure = await fetchTransaction(HOUSEHOLD_ID, TRANSACTION_ID).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure as ApiError).toMatchObject({
      status: 404,
      code: 'TRANSACTION_NOT_FOUND',
      correlationId: 'corr-404',
    });
  });

  it('patches with expectedVersion and exact mutable fields', async () => {
    const calls = stubFetch((url) => {
      expect(url).toBe(
        `/api/households/${HOUSEHOLD_ID}/transactions/${TRANSACTION_ID}`,
      );
      return jsonResponse(
        validTransaction({
          money: { amount: '-20.00', currency: 'BRL' },
          version: 1,
        }),
      );
    });
    const updated = await patchTransaction(
      HOUSEHOLD_ID,
      TRANSACTION_ID,
      {
        expectedVersion: 0,
        money: { amount: '-20.00', currency: 'BRL' },
        description: 'Weekly groceries',
      },
      CSRF,
    );
    expect(updated.version).toBe(1);
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      expectedVersion: 0,
      money: { amount: '-20.00', currency: 'BRL' },
      description: 'Weekly groceries',
    });
  });

  it('sends a void as expectedVersion plus status only', async () => {
    const calls = stubFetch(() =>
      jsonResponse(validTransaction({ status: 'VOIDED', version: 3 })),
    );
    const voided = await patchTransaction(
      HOUSEHOLD_ID,
      TRANSACTION_ID,
      { expectedVersion: 2, status: 'VOIDED' },
      CSRF,
    );
    expect(voided.status).toBe('VOIDED');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      expectedVersion: 2,
      status: 'VOIDED',
    });
  });

  it('maps stale updates and voided edits to their documented codes', async () => {
    const cases: Array<[Response, string]> = [
      [
        jsonResponse(
          { code: 'RESOURCE_VERSION_CONFLICT', message: 'Stale.' },
          409,
        ),
        'RESOURCE_VERSION_CONFLICT',
      ],
      [jsonResponse({ code: 'TRANSACTION_VOIDED' }, 409), 'TRANSACTION_VOIDED'],
      [
        jsonResponse({ code: 'RESOURCE_VERSION_EXHAUSTED' }, 409),
        'RESOURCE_VERSION_EXHAUSTED',
      ],
    ];
    for (const [response, code] of cases) {
      stubFetch(() => response);
      const failure = await patchTransaction(
        HOUSEHOLD_ID,
        TRANSACTION_ID,
        { expectedVersion: 0, status: 'VOIDED' },
        CSRF,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure as ApiError).toMatchObject({ status: 409, code });
    }
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
    const failure = await postTransaction(
      HOUSEHOLD_ID,
      EXPENSE_INPUT,
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

  it('maps a session loss on any call to the unauthenticated error', async () => {
    stubFetch(() =>
      jsonResponse(
        { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
        401,
      ),
    );
    const failure = await fetchTransactions(HOUSEHOLD_ID).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure as ApiError).toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    });
  });
});
