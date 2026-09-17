import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  fetchMemberBalances,
  fetchTransactionAllocation,
  patchAllocationRevoke,
  postTransactionAllocation,
  type CreateAllocationInput,
} from '../auth/client';

const CSRF = { token: 'csrf-token-1', headerName: 'X-CSRF-TOKEN' };
const HOUSEHOLD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TRANSACTION_ID = '40000000-0000-4000-8000-000000000001';
const ALLOCATION_ID = '50000000-0000-4000-8000-000000000001';
const PAYER_ID = '30000000-0000-4000-8000-000000000001';
const PARTICIPANT_B = '30000000-0000-4000-8000-000000000002';
const PARTICIPANT_C = '30000000-0000-4000-8000-000000000003';

function validAllocation(overrides: Record<string, unknown> = {}) {
  return {
    id: ALLOCATION_ID,
    transactionId: TRANSACTION_ID,
    householdId: HOUSEHOLD_ID,
    payerUserId: PAYER_ID,
    currency: 'USD',
    originalAmount: { amount: '10.00', currency: 'USD' },
    participants: [
      {
        userId: PAYER_ID,
        share: { amount: '3.34', currency: 'USD' },
      },
      {
        userId: PARTICIPANT_B,
        share: { amount: '3.33', currency: 'USD' },
      },
      {
        userId: PARTICIPANT_C,
        share: { amount: '3.33', currency: 'USD' },
      },
    ],
    status: 'ACTIVE',
    createdAt: '2026-09-16T12:00:00Z',
    revokedAt: null,
    transactionVersion: 1,
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

const ALLOCATION_URL = `/api/households/${HOUSEHOLD_ID}/transactions/${TRANSACTION_ID}/allocation`;
const BALANCES_URL = `/api/households/${HOUSEHOLD_ID}/member-balances`;

const CREATE_INPUT: CreateAllocationInput = {
  expectedVersion: 0,
  participantUserIds: [PAYER_ID, PARTICIPANT_B, PARTICIPANT_C],
};

describe('allocation typed client', () => {
  it('fetches the active allocation over the documented route and headers', async () => {
    const calls = stubFetch((url) => {
      expect(url).toBe(ALLOCATION_URL);
      return jsonResponse(validAllocation());
    });
    const allocation = await fetchTransactionAllocation(
      HOUSEHOLD_ID,
      TRANSACTION_ID,
    );
    expect(allocation).toEqual(validAllocation());
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.credentials).toBe('include');
    expect(calls[0]?.init?.cache).toBe('no-store');
    expect(calls[0]?.init?.headers).toMatchObject({
      Accept: 'application/json',
    });
  });

  it('rejects a response outside the exact 11-field allocation contract', async () => {
    const malformed: Array<Record<string, unknown>> = [
      // Unsupported status.
      validAllocation({ status: 'PENDING' }),
      // ACTIVE must never carry a revokedAt timestamp.
      validAllocation({ revokedAt: '2026-09-17T00:00:00Z' }),
      // REVOKED must carry a revokedAt timestamp.
      validAllocation({ status: 'REVOKED' }),
      // Shares are never negative.
      validAllocation({
        participants: [
          { userId: PAYER_ID, share: { amount: '-3.34', currency: 'USD' } },
          { userId: PARTICIPANT_B, share: { amount: '3.33', currency: 'USD' } },
          { userId: PARTICIPANT_C, share: { amount: '3.33', currency: 'USD' } },
        ],
      }),
      // A negative-zero share is a signed artifact, never a valid zero.
      validAllocation({
        participants: [
          { userId: PAYER_ID, share: { amount: '3.34', currency: 'USD' } },
          { userId: PARTICIPANT_B, share: { amount: '3.33', currency: 'USD' } },
          {
            userId: PARTICIPANT_C,
            share: { amount: '-0.00', currency: 'USD' },
          },
        ],
      }),
      // Shares must sum exactly to the original magnitude.
      validAllocation({
        participants: [
          { userId: PAYER_ID, share: { amount: '3.00', currency: 'USD' } },
          { userId: PARTICIPANT_B, share: { amount: '3.33', currency: 'USD' } },
          { userId: PARTICIPANT_C, share: { amount: '3.33', currency: 'USD' } },
        ],
      }),
      // Wrong scale on a stored share.
      validAllocation({
        participants: [
          { userId: PAYER_ID, share: { amount: '3.3', currency: 'USD' } },
          { userId: PARTICIPANT_B, share: { amount: '3.33', currency: 'USD' } },
          { userId: PARTICIPANT_C, share: { amount: '3.33', currency: 'USD' } },
        ],
      }),
      // Money as a JSON number is never coerced.
      validAllocation({
        originalAmount: { amount: 10.0, currency: 'USD' },
      }),
      // Zero shares are representable; negative original magnitudes are not.
      validAllocation({
        originalAmount: { amount: '-10.00', currency: 'USD' },
      }),
      // Participants must be distinct.
      validAllocation({
        participants: [
          { userId: PAYER_ID, share: { amount: '3.34', currency: 'USD' } },
          { userId: PAYER_ID, share: { amount: '3.33', currency: 'USD' } },
          { userId: PARTICIPANT_C, share: { amount: '3.33', currency: 'USD' } },
        ],
      }),
      // Participants are ordered ascending by canonical UUID.
      validAllocation({
        participants: [
          { userId: PARTICIPANT_B, share: { amount: '3.34', currency: 'USD' } },
          { userId: PAYER_ID, share: { amount: '3.33', currency: 'USD' } },
          { userId: PARTICIPANT_C, share: { amount: '3.33', currency: 'USD' } },
        ],
      }),
      // An empty participant set is invalid.
      validAllocation({ participants: [] }),
      // Unsupported currency.
      validAllocation({ currency: 'CHF' }),
      // Fractional transaction version.
      validAllocation({ transactionVersion: 1.5 }),
      // Beyond the documented version bound.
      validAllocation({ transactionVersion: 2147483648 }),
      // Missing recorded timestamp.
      { ...validAllocation(), createdAt: undefined },
      // Extra top-level field: the DTO is exactly 11 fields.
      {
        ...validAllocation(),
        roster: [],
      } as unknown as Record<string, unknown>,
      // Not an object at all.
      'allocation' as unknown as Record<string, unknown>,
    ];
    for (const item of malformed) {
      stubFetch(() => jsonResponse(item));
      const failure = await fetchTransactionAllocation(
        HOUSEHOLD_ID,
        TRANSACTION_ID,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure as ApiError).toMatchObject({
        code: 'UNKNOWN_ERROR',
        message: 'The server returned an unexpected allocation response.',
      });
    }
  });

  it('preserves the documented zero-share remainder case', async () => {
    // USD 0.01 across two participants: the last participant holds a
    // zero share by the remainder rule, and the sum still matches.
    stubFetch(() =>
      jsonResponse(
        validAllocation({
          originalAmount: { amount: '0.01', currency: 'USD' },
          participants: [
            { userId: PAYER_ID, share: { amount: '0.01', currency: 'USD' } },
            {
              userId: PARTICIPANT_B,
              share: { amount: '0.00', currency: 'USD' },
            },
          ],
        }),
      ),
    );
    const allocation = await fetchTransactionAllocation(
      HOUSEHOLD_ID,
      TRANSACTION_ID,
    );
    expect(allocation.participants[1]?.share).toEqual({
      amount: '0.00',
      currency: 'USD',
    });
  });

  it('creates with the exact body, one idempotency key, and CSRF', async () => {
    const calls = stubFetch((url) => {
      expect(url).toBe(ALLOCATION_URL);
      return jsonResponse(validAllocation(), 201);
    });
    const created = await postTransactionAllocation(
      HOUSEHOLD_ID,
      TRANSACTION_ID,
      CREATE_INPUT,
      '11111111-2222-4333-8444-555555555555',
      CSRF,
    );
    expect(created.status).toBe('ACTIVE');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toMatchObject({
      'X-CSRF-TOKEN': CSRF.token,
      'Idempotency-Key': '11111111-2222-4333-8444-555555555555',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(CREATE_INPUT);
  });

  it('accepts the 200 same-key replay with a current representation', async () => {
    stubFetch(() =>
      jsonResponse(validAllocation({ transactionVersion: 2 }), 200),
    );
    const replayed = await postTransactionAllocation(
      HOUSEHOLD_ID,
      TRANSACTION_ID,
      CREATE_INPUT,
      '11111111-2222-4333-8444-555555555555',
      CSRF,
    );
    expect(replayed.transactionVersion).toBe(2);
  });

  it('preserves safe creation errors including allocation conflicts', async () => {
    const cases: Array<[Response, string, number]> = [
      [jsonResponse({ code: 'FINANCE_BUSY' }, 503), 'FINANCE_BUSY', 503],
      [
        jsonResponse(
          { code: 'ALLOCATION_CONFLICT', message: 'Already allocated.' },
          409,
        ),
        'ALLOCATION_CONFLICT',
        409,
      ],
      [
        jsonResponse(
          { code: 'RESOURCE_VERSION_CONFLICT', message: 'Stale.' },
          409,
        ),
        'RESOURCE_VERSION_CONFLICT',
        409,
      ],
      [
        jsonResponse(
          {
            code: 'VALIDATION_FAILED',
            message: 'Check the highlighted fields.',
            correlationId: 'corr-participants',
            fieldErrors: {
              participantUserIds: 'Every participant must be a current member.',
              injected: 'must-be-dropped',
            },
          },
          400,
        ),
        'VALIDATION_FAILED',
        400,
      ],
      [
        jsonResponse({ code: 'FORBIDDEN', message: 'Owner only.' }, 403),
        'FORBIDDEN',
        403,
      ],
    ];
    for (const [response, code, status] of cases) {
      stubFetch(() => response);
      const failure = await postTransactionAllocation(
        HOUSEHOLD_ID,
        TRANSACTION_ID,
        CREATE_INPUT,
        '11111111-2222-4333-8444-555555555555',
        CSRF,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure as ApiError).toMatchObject({ status, code });
    }
  });

  it('keeps only the allowlisted participant field error', async () => {
    stubFetch(() =>
      jsonResponse(
        {
          code: 'VALIDATION_FAILED',
          message: 'Check the highlighted fields.',
          fieldErrors: {
            participantUserIds: 'Duplicates are not accepted.',
          },
        },
        400,
      ),
    );
    const failure = await postTransactionAllocation(
      HOUSEHOLD_ID,
      TRANSACTION_ID,
      CREATE_INPUT,
      '11111111-2222-4333-8444-555555555555',
      CSRF,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure as ApiError).toMatchObject({
      fieldErrors: { participantUserIds: 'Duplicates are not accepted.' },
    });
  });

  it('patches a revoke with only expectedVersion and REVOKED, no key header', async () => {
    const calls = stubFetch((url) => {
      expect(url).toBe(ALLOCATION_URL);
      return jsonResponse(validAllocation({ transactionVersion: 3 }), 200);
    });
    const revoked = await patchAllocationRevoke(
      HOUSEHOLD_ID,
      TRANSACTION_ID,
      2,
      CSRF,
    );
    expect(revoked.transactionVersion).toBe(3);
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.init?.headers).toMatchObject({
      'X-CSRF-TOKEN': CSRF.token,
    });
    expect(
      calls[0]?.init?.headers && 'Idempotency-Key' in calls[0].init.headers,
    ).toBe(false);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      expectedVersion: 2,
      status: 'REVOKED',
    });
  });

  it('answers a missing active allocation with the safe not-found code', async () => {
    stubFetch(() =>
      jsonResponse(
        {
          code: 'ALLOCATION_NOT_FOUND',
          message: 'No active allocation for this transaction.',
          correlationId: 'corr-alloc-404',
        },
        404,
      ),
    );
    const failure = await fetchTransactionAllocation(
      HOUSEHOLD_ID,
      TRANSACTION_ID,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure as ApiError).toMatchObject({
      status: 404,
      code: 'ALLOCATION_NOT_FOUND',
      correlationId: 'corr-alloc-404',
    });
  });
});

describe('member balances typed client', () => {
  it('fetches the grouped balances over the documented route', async () => {
    const calls = stubFetch((url) => {
      expect(url).toBe(BALANCES_URL);
      return jsonResponse({
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
    });
    const balances = await fetchMemberBalances(HOUSEHOLD_ID);
    expect(balances.currencies).toHaveLength(2);
    expect(balances.currencies[0]).toMatchObject({
      currency: 'JPY',
      balances: [
        { userId: PAYER_ID, membershipStatus: 'CURRENT', amount: '1000' },
      ],
    });
    expect(balances.currencies[1]).toMatchObject({
      currency: 'USD',
      balances: [
        { userId: PAYER_ID, membershipStatus: 'CURRENT', amount: '6.66' },
        { userId: PARTICIPANT_B, membershipStatus: 'CURRENT', amount: '-3.33' },
        {
          userId: PARTICIPANT_C,
          membershipStatus: 'DEPARTED',
          amount: '-3.33',
        },
      ],
    });
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.cache).toBe('no-store');
  });

  it('accepts an empty authorized household without inventing values', async () => {
    stubFetch(() => jsonResponse({ currencies: [] }));
    const balances = await fetchMemberBalances(HOUSEHOLD_ID);
    expect(balances.currencies).toEqual([]);
  });

  it('rejects a response outside the grouped balance contract', async () => {
    const malformed: Array<Record<string, unknown>> = [
      // Unknown top-level field.
      { currencies: [], generatedAt: '2026-09-16T12:00:00Z' },
      // Wrong type for currencies.
      { currencies: {} },
      // Unsupported currency group.
      {
        currencies: [
          {
            currency: 'CHF',
            balances: [
              {
                userId: PAYER_ID,
                membershipStatus: 'CURRENT',
                amount: '1.00',
              },
            ],
          },
        ],
      },
      // Amounts outside the currency scale.
      {
        currencies: [
          {
            currency: 'JPY',
            balances: [
              {
                userId: PAYER_ID,
                membershipStatus: 'CURRENT',
                amount: '10.00',
              },
            ],
          },
        ],
      },
      {
        currencies: [
          {
            currency: 'USD',
            balances: [
              {
                userId: PAYER_ID,
                membershipStatus: 'CURRENT',
                amount: '1.2',
              },
            ],
          },
        ],
      },
      // Exponent and leading-zero amounts.
      {
        currencies: [
          {
            currency: 'USD',
            balances: [
              {
                userId: PAYER_ID,
                membershipStatus: 'CURRENT',
                amount: '1e3',
              },
            ],
          },
        ],
      },
      {
        currencies: [
          {
            currency: 'USD',
            balances: [
              {
                userId: PAYER_ID,
                membershipStatus: 'CURRENT',
                amount: '06.66',
              },
            ],
          },
        ],
      },
      // Negative zero is a signed artifact, never a stored balance.
      {
        currencies: [
          {
            currency: 'USD',
            balances: [
              {
                userId: PAYER_ID,
                membershipStatus: 'CURRENT',
                amount: '-0.00',
              },
            ],
          },
        ],
      },
      // Membership status token outside the documented pair.
      {
        currencies: [
          {
            currency: 'USD',
            balances: [
              { userId: PAYER_ID, membershipStatus: 'JOINED', amount: '6.66' },
            ],
          },
        ],
      },
      // Extra fields on a balance entry.
      {
        currencies: [
          {
            currency: 'USD',
            balances: [
              {
                userId: PAYER_ID,
                membershipStatus: 'CURRENT',
                amount: '6.66',
                email: 'payer@example.com',
              },
            ],
          },
        ],
      },
      // Balances are ordered ascending by user UUID.
      {
        currencies: [
          {
            currency: 'USD',
            balances: [
              {
                userId: PARTICIPANT_B,
                membershipStatus: 'CURRENT',
                amount: '-3.33',
              },
              {
                userId: PAYER_ID,
                membershipStatus: 'CURRENT',
                amount: '6.66',
              },
            ],
          },
        ],
      },
      // Currencies are ordered by code.
      {
        currencies: [
          {
            currency: 'USD',
            balances: [
              {
                userId: PAYER_ID,
                membershipStatus: 'CURRENT',
                amount: '6.66',
              },
            ],
          },
          {
            currency: 'BRL',
            balances: [
              {
                userId: PAYER_ID,
                membershipStatus: 'CURRENT',
                amount: '10.00',
              },
            ],
          },
        ],
      },
      // Not an object at all.
      [] as unknown as Record<string, unknown>,
    ];
    for (const item of malformed) {
      stubFetch(() => jsonResponse(item));
      const failure = await fetchMemberBalances(HOUSEHOLD_ID).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure as ApiError).toMatchObject({
        code: 'UNKNOWN_ERROR',
        message: 'The server returned an unexpected member-balances response.',
      });
    }
  });

  it('preserves large aggregate balances beyond the per-record bound', async () => {
    stubFetch(() =>
      jsonResponse({
        currencies: [
          {
            currency: 'USD',
            balances: [
              {
                userId: PAYER_ID,
                membershipStatus: 'CURRENT',
                amount: '10000000000000.00',
              },
            ],
          },
        ],
      }),
    );
    const balances = await fetchMemberBalances(HOUSEHOLD_ID);
    expect(balances.currencies[0]?.balances[0]?.amount).toBe(
      '10000000000000.00',
    );
  });

  it('rejects balances beyond the aggregate length bound', async () => {
    stubFetch(() =>
      jsonResponse({
        currencies: [
          {
            currency: 'USD',
            balances: [
              {
                userId: PAYER_ID,
                membershipStatus: 'CURRENT',
                amount: '9'.repeat(61) + '.999',
              },
            ],
          },
        ],
      }),
    );
    const failure = await fetchMemberBalances(HOUSEHOLD_ID).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure as ApiError).toMatchObject({
      code: 'UNKNOWN_ERROR',
      message: 'The server returned an unexpected member-balances response.',
    });
  });

  it('surfaces a failed balances fetch with the safe error code', async () => {
    stubFetch(() =>
      jsonResponse(
        {
          code: 'HOUSEHOLD_NOT_FOUND',
          message: 'Household is unavailable.',
          correlationId: 'corr-balances',
        },
        404,
      ),
    );
    const failure = await fetchMemberBalances(HOUSEHOLD_ID).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure as ApiError).toMatchObject({
      status: 404,
      code: 'HOUSEHOLD_NOT_FOUND',
      correlationId: 'corr-balances',
    });
  });
});
