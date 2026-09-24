import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  fetchCategorizationReview,
  fetchCategorizationReviews,
  resolveCategorizationReview,
  type CategorizationReview,
  type ResolveCategorizationReviewInput,
} from '../auth/client';

const CSRF = { token: 'csrf-token-1', headerName: 'X-CSRF-TOKEN' };
const HOUSEHOLD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TRANSACTION_ID = '40000000-0000-4000-8000-000000000001';
const ACCOUNT_ID = '10000000-0000-4000-8000-000000000001';
const REVIEW_ID = '80000000-0000-4000-8000-000000000001';
const OTHER_REVIEW_ID = '80000000-0000-4000-8000-000000000002';
const REVIEWS_URL = `/api/households/${HOUSEHOLD_ID}/categorization-reviews`;
const RESOLVE_URL = `${REVIEWS_URL}/${REVIEW_ID}/resolve`;
const UNEXPECTED_MESSAGE =
  'The server returned an unexpected categorization review response.';

function validTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: TRANSACTION_ID,
    householdId: HOUSEHOLD_ID,
    ownerUserId: '30000000-0000-4000-8000-000000000001',
    accountId: ACCOUNT_ID,
    kind: 'EXPENSE',
    money: { amount: '-12.34', currency: 'BRL' },
    occurredOn: '2026-09-16',
    description: 'Corner Market',
    category: null,
    visibility: 'PRIVATE',
    source: 'CONNECTED',
    status: 'POSTED',
    refundOfTransactionId: null,
    version: 0,
    createdAt: '2026-09-22T11:00:00Z',
    updatedAt: '2026-09-22T11:00:00Z',
    ...overrides,
  };
}

function validReview(overrides: Record<string, unknown> = {}) {
  return {
    id: REVIEW_ID,
    transaction: validTransaction(),
    evaluatedTransactionVersion: 0,
    suggestedCategory: 'GROCERIES',
    source: 'HEURISTIC',
    confidence: 'HIGH',
    reasonLabel: 'Merchant pattern matched',
    status: 'OPEN',
    version: 0,
    createdAt: '2026-09-22T12:00:00Z',
    updatedAt: '2026-09-22T12:00:00Z',
    ...overrides,
  };
}

function validPage(overrides: Record<string, unknown> = {}) {
  return {
    items: [validReview()],
    limit: 50,
    offset: 0,
    hasMore: false,
    openCount: 1,
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

function stubFetchFailure(error: unknown = new TypeError('Failed to fetch')) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      calls.push(typeof input === 'string' ? input : input.toString());
      throw error;
    }),
  );
  return calls;
}

/** Asserts the call rejected with an ApiError and returns it. */
async function rejectionOf(action: () => Promise<unknown>): Promise<ApiError> {
  const failure = await action().then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(ApiError);
  return failure as ApiError;
}

const SIMPLE_INPUT: ResolveCategorizationReviewInput = {
  expectedVersion: 3,
  expectedTransactionVersion: 4,
  action: 'ACCEPT_SUGGESTION',
};

describe('owner-private categorization review client', () => {
  it('loads the owner page over the documented query with the open backlog count', async () => {
    const calls = stubFetch((url) => {
      expect(url).toBe(`${REVIEWS_URL}?limit=50&offset=0&view=OPEN`);
      return jsonResponse(validPage());
    });
    const page = await fetchCategorizationReviews(HOUSEHOLD_ID, {
      limit: 50,
      offset: 0,
      view: 'OPEN',
    });
    expect(calls[0]?.url).toBe(`${REVIEWS_URL}?limit=50&offset=0&view=OPEN`);
    expect(page.limit).toBe(50);
    expect(page.offset).toBe(0);
    expect(page.hasMore).toBe(false);
    // The backlog count is a real number, never a guess or a string.
    expect(page.openCount).toBe(1);
    expect(page.items[0]).toMatchObject({
      id: REVIEW_ID,
      status: 'OPEN',
      suggestedCategory: 'GROCERIES',
      source: 'HEURISTIC',
      confidence: 'HIGH',
    });
    expect(page.items[0]?.transaction.id).toBe(TRANSACTION_ID);
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.credentials).toBe('include');
    expect(calls[0]?.init?.cache).toBe('no-store');
    expect(calls[0]?.init?.headers).toMatchObject({
      Accept: 'application/json',
    });
  });

  it('keeps the open backlog count independent of the history view', async () => {
    const calls = stubFetch((url) => {
      expect(url).toBe(`${REVIEWS_URL}?limit=10&offset=20&view=HISTORY`);
      return jsonResponse(
        validPage({
          items: [validReview({ status: 'SUPERSEDED', version: 2 })],
          limit: 10,
          offset: 20,
          hasMore: true,
          openCount: 3,
        }),
      );
    });
    const page = await fetchCategorizationReviews(HOUSEHOLD_ID, {
      limit: 10,
      offset: 20,
      view: 'HISTORY',
    });
    expect(calls[0]?.url).toBe(
      `${REVIEWS_URL}?limit=10&offset=20&view=HISTORY`,
    );
    // A history page still reports the owner's real open backlog.
    expect(page.openCount).toBe(3);
    expect(page.hasMore).toBe(true);
    expect(page.items[0]?.status).toBe('SUPERSEDED');
  });

  it('omits the view parameter when the caller leaves it undefined', async () => {
    const calls = stubFetch((url) => {
      expect(url).toBe(`${REVIEWS_URL}?limit=100&offset=25`);
      return jsonResponse(
        validPage({
          items: [],
          limit: 100,
          offset: 25,
          hasMore: false,
          openCount: 0,
        }),
      );
    });
    const page = await fetchCategorizationReviews(HOUSEHOLD_ID, {
      limit: 100,
      offset: 25,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${REVIEWS_URL}?limit=100&offset=25`);
    expect(calls[0]?.url).not.toContain('view=');
    expect(page.items).toEqual([]);
    expect(page.openCount).toBe(0);
  });

  it('rejects a page that drops openCount, adds a key, or drifts in any item', async () => {
    const malformedPages: unknown[] = [
      // A missing openCount would force the UI to guess the backlog.
      { items: [validReview()], limit: 50, offset: 0, hasMore: false },
      // Any extra page key carries unvalidated server data.
      { ...validPage(), total: 1 },
      { ...validPage(), ownerUserId: HOUSEHOLD_ID },
      // openCount is a bounded non-negative integer, never coerced.
      validPage({ openCount: '1' }),
      validPage({ openCount: 1.5 }),
      validPage({ openCount: -1 }),
      validPage({ openCount: null }),
      validPage({ items: {} }),
      validPage({ items: [null] }),
      validPage({ items: ['review'] }),
      validPage({ limit: 50.5 }),
      validPage({ hasMore: 'no' }),
      // Unknown lifecycle, source, and confidence tokens are never rendered.
      validPage({ items: [validReview({ status: 'PENDING' })] }),
      validPage({ items: [validReview({ source: 'MODEL' })] }),
      validPage({ items: [validReview({ confidence: 'CERTAIN' })] }),
      // The suggestion is a fixed-taxonomy token, never free text.
      validPage({ items: [validReview({ suggestedCategory: 'OTHER' })] }),
      validPage({ items: [validReview({ suggestedCategory: '' })] }),
      validPage({ items: [validReview({ suggestedCategory: null })] }),
      // Exactly eleven item fields: extra keys and missing ones are drift.
      validPage({
        items: [validReview({ evidenceFingerprint: 'digest' })],
      }),
      validPage({ items: [validReview({ reasonLabel: undefined })] }),
      validPage({ items: [validReview({ version: undefined })] }),
      validPage({ items: [validReview({ reasonLabel: '' })] }),
      validPage({ items: [validReview({ id: 'not-a-uuid' })] }),
      validPage({ items: [validReview({ version: 2147483648 })] }),
      validPage({
        items: [validReview({ evaluatedTransactionVersion: -1 })],
      }),
      validPage({ items: [validReview({ createdAt: '2026-09-22' })] }),
      // The nested transaction stays the unchanged exact 16-field DTO.
      validPage({
        items: [
          validReview({
            transaction: validTransaction({ evidenceFingerprint: 'digest' }),
          }),
        ],
      }),
      validPage({
        items: [
          validReview({
            transaction: validTransaction({ updatedAt: undefined }),
          }),
        ],
      }),
      validPage({
        items: [
          validReview({ transaction: validTransaction({ category: 'OTHER' }) }),
        ],
      }),
      validPage({
        items: [
          validReview({
            transaction: validTransaction({
              money: { amount: -12.34, currency: 'BRL' },
            }),
          }),
        ],
      }),
      null,
      [],
      'page',
    ];
    for (const body of malformedPages) {
      stubFetch(() => jsonResponse(body));
      const failure = await rejectionOf(() =>
        fetchCategorizationReviews(HOUSEHOLD_ID, { limit: 50, offset: 0 }),
      );
      expect(failure).toMatchObject({
        code: 'UNKNOWN_ERROR',
        message: UNEXPECTED_MESSAGE,
      });
    }
  });

  it('parses an item whose nested transaction has a redacted null accountId', async () => {
    stubFetch(() =>
      jsonResponse(
        validPage({
          items: [
            validReview({
              transaction: validTransaction({ accountId: null }),
            }),
          ],
        }),
      ),
    );
    const page = await fetchCategorizationReviews(HOUSEHOLD_ID, {
      limit: 50,
      offset: 0,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.transaction.accountId).toBeNull();
    expect(page.items[0]?.id).toBe(REVIEW_ID);
    expect(page.items[0]?.transaction.householdId).toBe(HOUSEHOLD_ID);
  });

  it('loads one review by id over its own private path', async () => {
    const calls = stubFetch((url) => {
      expect(url).toBe(`${REVIEWS_URL}/${REVIEW_ID}`);
      return jsonResponse(validReview({ status: 'ACCEPTED', version: 1 }));
    });
    const review = await fetchCategorizationReview(HOUSEHOLD_ID, REVIEW_ID);
    expect(calls[0]?.url).toBe(`${REVIEWS_URL}/${REVIEW_ID}`);
    expect(review.id).toBe(REVIEW_ID);
    expect(review.status).toBe('ACCEPTED');
    expect(review.version).toBe(1);
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.credentials).toBe('include');
    expect(calls[0]?.init?.cache).toBe('no-store');
  });

  it('maps a missing, hidden, or other owner review to the generic not-found code', async () => {
    stubFetch(() =>
      jsonResponse(
        {
          code: 'CATEGORY_REVIEW_NOT_FOUND',
          message: 'That suggestion is unavailable.',
          correlationId: 'corr-review-404',
        },
        404,
      ),
    );
    const failure = await rejectionOf(() =>
      fetchCategorizationReview(HOUSEHOLD_ID, REVIEW_ID),
    );
    expect(failure).toMatchObject({
      status: 404,
      code: 'CATEGORY_REVIEW_NOT_FOUND',
      message: 'That suggestion is unavailable.',
      correlationId: 'corr-review-404',
    });
  });

  it('rejects a single review that describes another id or drifts', async () => {
    const drifted: unknown[] = [
      // An item describing a different review is drift, not a success.
      validReview({ id: OTHER_REVIEW_ID }),
      validReview({ evidenceFingerprint: 'digest' }),
      validReview({ status: 'PENDING' }),
      validReview({ confidence: 'CERTAIN' }),
      validReview({ suggestedCategory: 'OTHER' }),
      validReview({
        transaction: validTransaction({ accountId: 'not-a-uuid' }),
      }),
      validReview({ transaction: validTransaction({ category: 'OTHER' }) }),
      null,
      [],
      'review',
    ];
    for (const body of drifted) {
      stubFetch(() => jsonResponse(body));
      const failure = await rejectionOf(() =>
        fetchCategorizationReview(HOUSEHOLD_ID, REVIEW_ID),
      );
      expect(failure).toMatchObject({
        code: 'UNKNOWN_ERROR',
        message: UNEXPECTED_MESSAGE,
      });
    }
  });

  it('resolves with the exact body, durable key, and CSRF token per action', async () => {
    const outcomes: Array<{
      action: 'ACCEPT_SUGGESTION' | 'KEEP_CURRENT' | 'KEEP_UNCATEGORIZED';
      status: CategorizationReview['status'];
      committed: string | null;
    }> = [
      {
        action: 'ACCEPT_SUGGESTION',
        status: 'ACCEPTED',
        committed: 'GROCERIES',
      },
      { action: 'KEEP_CURRENT', status: 'KEPT', committed: 'DINING' },
      { action: 'KEEP_UNCATEGORIZED', status: 'KEPT', committed: null },
    ];
    for (const { action, status, committed } of outcomes) {
      const calls = stubFetch((url) => {
        expect(url).toBe(RESOLVE_URL);
        return jsonResponse(
          validReview({
            status,
            version: 1,
            transaction: validTransaction({ category: committed, version: 5 }),
          }),
        );
      });
      const input: ResolveCategorizationReviewInput = {
        expectedVersion: 3,
        expectedTransactionVersion: 4,
        action,
      };
      const review = await resolveCategorizationReview(
        HOUSEHOLD_ID,
        REVIEW_ID,
        input,
        'review-key-1',
        CSRF,
      );
      expect(review.status).toBe(status);
      expect(review.transaction.category).toBe(committed);
      expect(calls[0]?.url).toBe(RESOLVE_URL);
      expect(calls[0]?.init?.method).toBe('POST');
      expect(calls[0]?.init?.credentials).toBe('include');
      expect(calls[0]?.init?.cache).toBe('no-store');
      // The two keep actions and the acceptance carry no category at all.
      expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
        expectedVersion: 3,
        expectedTransactionVersion: 4,
        action,
      });
      expect(calls[0]?.init?.headers).toMatchObject({
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': 'csrf-token-1',
        'Idempotency-Key': 'review-key-1',
      });
    }
  });

  it('sends the chosen category and the caller token header only for CHOOSE_CATEGORY', async () => {
    const otherCsrf = { token: 'csrf-token-2', headerName: 'X-HOUSEHOLD-CSRF' };
    const calls = stubFetch((url) => {
      expect(url).toBe(RESOLVE_URL);
      return jsonResponse(
        validReview({
          status: 'CHOSEN',
          version: 1,
          transaction: validTransaction({ category: 'DINING', version: 5 }),
        }),
      );
    });
    const review = await resolveCategorizationReview(
      HOUSEHOLD_ID,
      REVIEW_ID,
      {
        expectedVersion: 3,
        expectedTransactionVersion: 4,
        action: 'CHOOSE_CATEGORY',
        category: 'DINING',
      },
      'review-key-choice',
      otherCsrf,
    );
    expect(review.status).toBe('CHOSEN');
    expect(review.transaction.category).toBe('DINING');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      expectedVersion: 3,
      expectedTransactionVersion: 4,
      action: 'CHOOSE_CATEGORY',
      category: 'DINING',
    });
    expect(calls[0]?.init?.headers).toMatchObject({
      'X-HOUSEHOLD-CSRF': 'csrf-token-2',
      'Idempotency-Key': 'review-key-choice',
      'Content-Type': 'application/json',
    });
  });

  it('answers a same-key replay with the already-committed representation', async () => {
    const calls = stubFetch(() =>
      jsonResponse(
        validReview({
          status: 'ACCEPTED',
          version: 1,
          transaction: validTransaction({ category: 'GROCERIES', version: 5 }),
        }),
      ),
    );
    const first = await resolveCategorizationReview(
      HOUSEHOLD_ID,
      REVIEW_ID,
      SIMPLE_INPUT,
      'review-key-1',
      CSRF,
    );
    const replay = await resolveCategorizationReview(
      HOUSEHOLD_ID,
      REVIEW_ID,
      SIMPLE_INPUT,
      'review-key-1',
      CSRF,
    );
    expect(calls).toHaveLength(2);
    expect(replay.status).toBe('ACCEPTED');
    expect(replay.version).toBe(1);
    expect(replay.transaction.category).toBe('GROCERIES');
    expect(replay).toEqual(first);
    expect(
      calls.map(
        (call) =>
          (call.init?.headers as Record<string, string>)['Idempotency-Key'],
      ),
    ).toEqual(['review-key-1', 'review-key-1']);
  });

  it('keeps the returned suggestion advisory and the committed category a fact', async () => {
    stubFetch(() =>
      jsonResponse(
        validReview({
          status: 'CHOSEN',
          version: 2,
          suggestedCategory: 'GROCERIES',
          transaction: validTransaction({ category: 'DINING', version: 6 }),
        }),
      ),
    );
    const review = await resolveCategorizationReview(
      HOUSEHOLD_ID,
      REVIEW_ID,
      {
        expectedVersion: 3,
        expectedTransactionVersion: 4,
        action: 'CHOOSE_CATEGORY',
        category: 'DINING',
      },
      'review-key-choice',
      CSRF,
    );
    expect(review.suggestedCategory).toBe('GROCERIES');
    expect(review.transaction.category).toBe('DINING');
    expect(review.transaction.version).toBe(6);
    expect(review.evaluatedTransactionVersion).toBe(0);
  });

  it('maps resolve failures to the documented codes without inventing success', async () => {
    const cases: Array<[Response, number, ApiError['code']]> = [
      [
        jsonResponse(
          { code: 'VALIDATION_FAILED', message: 'Choose one action.' },
          400,
        ),
        400,
        'VALIDATION_FAILED',
      ],
      [
        jsonResponse(
          {
            code: 'RESOURCE_VERSION_CONFLICT',
            message: 'That suggestion changed.',
          },
          409,
        ),
        409,
        'RESOURCE_VERSION_CONFLICT',
      ],
      [
        jsonResponse(
          { code: 'CATEGORY_REVIEW_NOT_FOUND', message: 'Unavailable.' },
          404,
        ),
        404,
        'CATEGORY_REVIEW_NOT_FOUND',
      ],
      [
        jsonResponse(
          { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
          401,
        ),
        401,
        'UNAUTHENTICATED',
      ],
      // An empty or unparsable body never becomes a claimed success.
      [new Response('', { status: 500 }), 500, 'UNKNOWN_ERROR'],
      [
        new Response('<html>bad gateway</html>', { status: 502 }),
        502,
        'UNKNOWN_ERROR',
      ],
      [jsonResponse({ code: 'SOMETHING_NEW' }, 500), 500, 'UNKNOWN_ERROR'],
    ];
    for (const [response, status, code] of cases) {
      stubFetch(() => response);
      const failure = await rejectionOf(() =>
        resolveCategorizationReview(
          HOUSEHOLD_ID,
          REVIEW_ID,
          SIMPLE_INPUT,
          'review-key-1',
          CSRF,
        ),
      );
      expect(failure).toMatchObject({ status, code });
    }
  });

  it('rejects a resolve response that drifts or answers for another id', async () => {
    const drifted: unknown[] = [
      validReview({ id: OTHER_REVIEW_ID }),
      validReview({ evidenceFingerprint: 'digest' }),
      validReview({ status: 'PENDING' }),
      validReview({
        transaction: validTransaction({ accountId: 'not-a-uuid' }),
      }),
      null,
      [],
    ];
    for (const body of drifted) {
      stubFetch(() => jsonResponse(body));
      const failure = await rejectionOf(() =>
        resolveCategorizationReview(
          HOUSEHOLD_ID,
          REVIEW_ID,
          SIMPLE_INPUT,
          'review-key-1',
          CSRF,
        ),
      );
      expect(failure).toMatchObject({
        code: 'UNKNOWN_ERROR',
        message: UNEXPECTED_MESSAGE,
      });
    }
  });

  it('never claims a success when the transport itself fails', async () => {
    const attempted: Array<() => Promise<unknown>> = [
      () => fetchCategorizationReviews(HOUSEHOLD_ID, { limit: 50, offset: 0 }),
      () => fetchCategorizationReview(HOUSEHOLD_ID, REVIEW_ID),
      () =>
        resolveCategorizationReview(
          HOUSEHOLD_ID,
          REVIEW_ID,
          SIMPLE_INPUT,
          'review-key-1',
          CSRF,
        ),
    ];
    for (const call of attempted) {
      const calls = stubFetchFailure();
      const failure = await rejectionOf(call);
      expect(failure).toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
      expect(calls).toHaveLength(1);
    }
  });
});
