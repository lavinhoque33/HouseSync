import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  confirmBankActivity,
  dismissBankActivity,
  fetchBankActivity,
  fetchBankActivityDetail,
  postConnectionSync,
  replaceBankActivityLedger,
  resolveBankActivity,
} from '../auth/client';

const CSRF = { token: 'csrf-token-1', headerName: 'X-CSRF-TOKEN' };
const HOUSEHOLD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ACTIVITY_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222';

function activity(overrides: Record<string, unknown> = {}) {
  return {
    id: ACTIVITY_ID,
    connectionId: CONNECTION_ID,
    accountMappingId: '33333333-3333-4333-8333-333333333333',
    localAccountId: '44444444-4444-4444-8444-444444444444',
    state: 'POSTED',
    reviewState: 'UNREVIEWED',
    changeState: null,
    money: { amount: '-12.34', currency: 'USD' },
    occurredOn: '2026-09-10',
    authorizedOn: null,
    providerDescription: 'Coffee Shop',
    descriptionValid: true,
    pendingPredecessorId: null,
    invalidReason: null,
    dismissedReason: null,
    version: 0,
    ledgerTransactionId: null,
    createdAt: '2026-09-18T10:00:00Z',
    updatedAt: '2026-09-18T10:00:00Z',
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

describe('bank activity client', () => {
  it('loads the owner inbox with bounded query parameters', async () => {
    const calls = stubFetch((url) => {
      expect(url).toBe(
        `/api/households/${HOUSEHOLD_ID}/bank-activity?limit=100&offset=0&state=POSTED&review=UNREVIEWED`,
      );
      return jsonResponse({
        items: [activity()],
        limit: 100,
        offset: 0,
        hasMore: false,
        unreviewedCount: 1,
        changedCount: 0,
      });
    });
    const page = await fetchBankActivity(HOUSEHOLD_ID, {
      state: 'POSTED',
      review: 'UNREVIEWED',
    });
    expect(page.items[0]?.money).toEqual({ amount: '-12.34', currency: 'USD' });
    expect(page.unreviewedCount).toBe(1);
    expect(calls[0]?.init?.cache).toBe('no-store');
  });

  it('confirms with the exact body, key, and CSRF header', async () => {
    const calls = stubFetch(() =>
      jsonResponse(
        {
          activity: activity({
            reviewState: 'CONFIRMED',
            ledgerTransactionId: '55555555-5555-4555-8555-555555555555',
          }),
          transactionId: '55555555-5555-4555-8555-555555555555',
          transactionVersion: 0,
        },
        201,
      ),
    );
    const decision = await confirmBankActivity(
      HOUSEHOLD_ID,
      ACTIVITY_ID,
      { expectedVersion: 0, kind: 'EXPENSE', description: 'Coffee Shop' },
      '99999999-9999-4999-8999-999999999999',
      CSRF,
    );
    expect(decision.transactionId).toBe('55555555-5555-4555-8555-555555555555');
    expect(calls[0]?.url).toBe(
      `/api/households/${HOUSEHOLD_ID}/bank-activity/${ACTIVITY_ID}/confirm`,
    );
    expect(calls[0]?.init?.headers).toMatchObject({
      'X-CSRF-TOKEN': 'csrf-token-1',
      'Idempotency-Key': '99999999-9999-4999-8999-999999999999',
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      expectedVersion: 0,
      kind: 'EXPENSE',
      description: 'Coffee Shop',
    });
  });

  it('dismisses with a closed reason and maps the observation conflict', async () => {
    stubFetch(() =>
      jsonResponse({
        activity: activity({
          reviewState: 'DISMISSED',
          dismissedReason: 'NOT_NEEDED',
          version: 1,
        }),
        transactionId: null,
        transactionVersion: null,
      }),
    );
    const decision = await dismissBankActivity(
      HOUSEHOLD_ID,
      ACTIVITY_ID,
      0,
      'NOT_NEEDED',
      '99999999-9999-4999-8999-999999999999',
      CSRF,
    );
    expect(decision.activity.reviewState).toBe('DISMISSED');

    stubFetch(() =>
      jsonResponse(
        { code: 'OBSERVATION_ALREADY_CONFIRMED', message: 'Already added.' },
        409,
      ),
    );
    await expect(
      dismissBankActivity(
        HOUSEHOLD_ID,
        ACTIVITY_ID,
        0,
        'NOT_NEEDED',
        '99999999-9999-4999-8999-999999999998',
        CSRF,
      ),
    ).rejects.toMatchObject({ code: 'OBSERVATION_ALREADY_CONFIRMED' });
  });

  it('requests a manual sync and maps the per-connection rate limit', async () => {
    stubFetch(() =>
      jsonResponse(
        {
          id: '77777777-7777-4777-8777-777777777777',
          operationType: 'SYNC',
          state: 'PENDING',
          connectionId: CONNECTION_ID,
          errorCode: null,
          statusUrl: `/api/households/${HOUSEHOLD_ID}/connection-operations/77777777-7777-4777-8777-777777777777`,
          createdAt: '2026-09-18T10:00:00Z',
          updatedAt: '2026-09-18T10:00:00Z',
        },
        202,
      ),
    );
    const operation = await postConnectionSync(
      HOUSEHOLD_ID,
      CONNECTION_ID,
      1,
      '99999999-9999-4999-8999-999999999999',
      CSRF,
    );
    expect(operation.operationType).toBe('SYNC');

    stubFetch(() =>
      jsonResponse(
        { code: 'MANUAL_SYNC_RATE_LIMITED', message: 'Wait a minute.' },
        429,
      ),
    );
    const failure = await postConnectionSync(
      HOUSEHOLD_ID,
      CONNECTION_ID,
      1,
      '99999999-9999-4999-8999-999999999998',
      CSRF,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('MANUAL_SYNC_RATE_LIMITED');
    expect((failure as ApiError).status).toBe(429);
  });

  it('resolves with both versions and surfaces reconciliation conflicts', async () => {
    const calls = stubFetch(() =>
      jsonResponse(
        {
          activity: activity({
            reviewState: 'CONFIRMED',
            changeState: null,
            ledgerTransactionId: '55555555-5555-4555-8555-555555555555',
            version: 4,
          }),
          transactionId: '55555555-5555-4555-8555-555555555555',
          transactionVersion: 2,
        },
        200,
      ),
    );
    const decision = await resolveBankActivity(
      HOUSEHOLD_ID,
      ACTIVITY_ID,
      {
        expectedVersion: 3,
        expectedLedgerVersion: 1,
        action: 'KEEP_LEDGER',
      },
      '99999999-9999-4999-8999-999999999999',
      CSRF,
    );
    expect(decision.transactionVersion).toBe(2);
    expect(calls[0]?.url).toBe(
      `/api/households/${HOUSEHOLD_ID}/bank-activity/${ACTIVITY_ID}/resolve`,
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      expectedVersion: 3,
      expectedLedgerVersion: 1,
      action: 'KEEP_LEDGER',
    });

    stubFetch(() =>
      jsonResponse(
        { code: 'RECONCILIATION_REQUIRED', message: 'Bank moved on.' },
        409,
      ),
    );
    await expect(
      resolveBankActivity(
        HOUSEHOLD_ID,
        ACTIVITY_ID,
        {
          expectedVersion: 3,
          expectedLedgerVersion: 1,
          action: 'APPLY_BANK',
          fields: ['amount'],
        },
        '99999999-9999-4999-8999-999999999998',
        CSRF,
      ),
    ).rejects.toMatchObject({ code: 'RECONCILIATION_REQUIRED' });
  });

  it('replaces the ledger with both versions and canonical acknowledgements', async () => {
    const replacement = {
      id: '55555555-5555-4555-8555-555555555555',
      householdId: HOUSEHOLD_ID,
      ownerUserId: '30000000-0000-4000-8000-000000000001',
      accountId: '44444444-4444-4444-8444-444444444444',
      kind: 'EXPENSE',
      money: { amount: '-13.00', currency: 'USD' },
      occurredOn: '2026-09-12',
      description: 'Corrected',
      category: null,
      visibility: 'PRIVATE',
      source: 'CONNECTED',
      status: 'POSTED',
      refundOfTransactionId: null,
      version: 0,
      createdAt: '2026-09-18T10:00:00Z',
      updatedAt: '2026-09-18T10:00:00Z',
    };
    const calls = stubFetch(() =>
      jsonResponse(
        {
          activity: activity({
            reviewState: 'CONFIRMED',
            changeState: null,
            ledgerTransactionId: '55555555-5555-4555-8555-555555555555',
            version: 5,
          }),
          transaction: replacement,
          supersededTransactionId: '66666666-6666-4666-8666-666666666666',
          supersededTransactionVersion: 2,
        },
        201,
      ),
    );
    const decision = await replaceBankActivityLedger(
      HOUSEHOLD_ID,
      ACTIVITY_ID,
      {
        expectedVersion: 4,
        expectedLedgerVersion: 2,
        kind: 'EXPENSE',
        description: 'Corrected',
        category: null,
        acknowledgeAllocationRemoval: false,
      },
      '99999999-9999-4999-8999-999999999999',
      CSRF,
    );
    expect(decision.activity.version).toBe(5);
    expect(decision.transaction.id).toBe(
      '55555555-5555-4555-8555-555555555555',
    );
    expect(decision.supersededTransactionId).toBe(
      '66666666-6666-4666-8666-666666666666',
    );
    expect(decision.supersededTransactionVersion).toBe(2);
    expect(calls[0]?.url).toBe(
      `/api/households/${HOUSEHOLD_ID}/bank-activity/${ACTIVITY_ID}/replace-ledger`,
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      expectedVersion: 4,
      expectedLedgerVersion: 2,
      kind: 'EXPENSE',
      description: 'Corrected',
      category: null,
      acknowledgeAllocationRemoval: false,
    });

    // A same-key replay answers 200 with the identical 4-key shape.
    stubFetch(() =>
      jsonResponse({
        activity: activity({
          reviewState: 'CONFIRMED',
          changeState: null,
          ledgerTransactionId: '55555555-5555-4555-8555-555555555555',
          version: 5,
        }),
        transaction: replacement,
        supersededTransactionId: '66666666-6666-4666-8666-666666666666',
        supersededTransactionVersion: 2,
      }),
    );
    const replay = await replaceBankActivityLedger(
      HOUSEHOLD_ID,
      ACTIVITY_ID,
      {
        expectedVersion: 4,
        expectedLedgerVersion: 2,
        kind: 'EXPENSE',
        description: 'Corrected',
        category: null,
        acknowledgeAllocationRemoval: false,
      },
      '99999999-9999-4999-8999-999999999999',
      CSRF,
    );
    expect(replay.transaction.version).toBe(0);
    expect(replay.supersededTransactionVersion).toBe(2);
  });

  it('loads one observation for stale-version refetch-and-review', async () => {
    stubFetch(() =>
      jsonResponse(
        activity({
          reviewState: 'CONFIRMED',
          changeState: 'MODIFIED',
          ledgerTransactionId: '55555555-5555-4555-8555-555555555555',
          version: 4,
        }),
      ),
    );
    const detail = await fetchBankActivityDetail(HOUSEHOLD_ID, ACTIVITY_ID);
    expect(detail.version).toBe(4);
    expect(detail.changeState).toBe('MODIFIED');
  });
});
