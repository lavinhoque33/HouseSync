import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  fetchCategorizationAiWorkStatus,
  type CategorizationAiWorkStatus,
} from '../auth/client';

const HOUSEHOLD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const STATUS_URL = `/api/households/${HOUSEHOLD_ID}/categorization-ai-work/status`;
const UNEXPECTED_MESSAGE =
  'The server returned an unexpected category automation response.';

function validStatus(overrides: Record<string, unknown> = {}) {
  return { enabled: true, pendingCount: 2, failedCount: 1, ...overrides };
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

describe('owner-private categorization AI work status client', () => {
  it('reads the exact documented counters from the exact private path', async () => {
    const calls = stubFetch((url) => {
      expect(url).toBe(STATUS_URL);
      return jsonResponse(validStatus());
    });
    const status = await fetchCategorizationAiWorkStatus(HOUSEHOLD_ID);
    expect(status).toEqual<CategorizationAiWorkStatus>({
      enabled: true,
      pendingCount: 2,
      failedCount: 1,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(STATUS_URL);
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.credentials).toBe('include');
    expect(calls[0]?.init?.cache).toBe('no-store');
    expect(calls[0]?.init?.headers).toMatchObject({
      Accept: 'application/json',
    });
    // The status read is a read: it never sends a body or a CSRF token.
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it('accepts the documented disabled shape and zero counters', async () => {
    stubFetch(() =>
      jsonResponse({ enabled: false, pendingCount: 0, failedCount: 0 }),
    );
    const status = await fetchCategorizationAiWorkStatus(HOUSEHOLD_ID);
    expect(status).toEqual({ enabled: false, pendingCount: 0, failedCount: 0 });
  });

  it('accepts the largest exactly representable count', async () => {
    // The server owns these counters as 64-bit counts; a count JavaScript can
    // still represent exactly is progress, never drift.
    stubFetch(() =>
      jsonResponse({
        enabled: true,
        pendingCount: Number.MAX_SAFE_INTEGER,
        failedCount: 0,
      }),
    );
    const status = await fetchCategorizationAiWorkStatus(HOUSEHOLD_ID);
    expect(status.pendingCount).toBe(Number.MAX_SAFE_INTEGER);
    expect(status.failedCount).toBe(0);
  });

  it('rejects a status whose shape drifts in any field', async () => {
    const malformed: unknown[] = [
      // Missing, extra, and unknown keys are drift, never half-read counters.
      { enabled: true, pendingCount: 1 },
      { enabled: true, failedCount: 0 },
      { pendingCount: 1, failedCount: 0 },
      { ...validStatus(), workId: '90000000-0000-4000-8000-000000000001' },
      {
        ...validStatus(),
        transactionId: '40000000-0000-4000-8000-000000000001',
      },
      { ...validStatus(), providerError: 'rate limited' },
      // enabled is a real boolean, never a truthy coercion.
      validStatus({ enabled: 'true' }),
      validStatus({ enabled: 1 }),
      validStatus({ enabled: null }),
      // Counts are non-negative integers, never strings or fractions.
      validStatus({ pendingCount: '1' }),
      validStatus({ pendingCount: -1 }),
      validStatus({ pendingCount: 1.5 }),
      validStatus({ pendingCount: null }),
      validStatus({ failedCount: '1' }),
      validStatus({ failedCount: -1 }),
      validStatus({ failedCount: 0.5 }),
      // A 64-bit count this browser cannot represent exactly is drift: it is
      // never rendered as an imprecise or rounded backlog number.
      validStatus({ pendingCount: Number.MAX_SAFE_INTEGER + 1 }),
      validStatus({ failedCount: Number.MAX_SAFE_INTEGER + 1 }),
      validStatus({ pendingCount: 9_007_199_254_740_992 }),
      // Not an object at all.
      null,
      [],
      'enabled',
      7,
    ];
    for (const body of malformed) {
      stubFetch(() => jsonResponse(body));
      const failure = await rejectionOf(() =>
        fetchCategorizationAiWorkStatus(HOUSEHOLD_ID),
      );
      expect(failure.code).toBe('UNKNOWN_ERROR');
      // The fixed rejection text can never echo the drifted payload back.
      expect(failure.message).toBe(UNEXPECTED_MESSAGE);
    }
  });

  it('rejects a drifted body with the documented status code and no invented counters', async () => {
    stubFetch(() => jsonResponse({ enabled: true, pendingCount: 1 }, 200));
    const failure = await rejectionOf(() =>
      fetchCategorizationAiWorkStatus(HOUSEHOLD_ID),
    );
    expect(failure.status).toBe(200);
    expect(failure.code).toBe('UNKNOWN_ERROR');
  });

  it('reports an expired session and a hidden household as their own errors', async () => {
    stubFetch(() =>
      jsonResponse({ code: 'UNAUTHENTICATED', message: 'Sign in.' }, 401),
    );
    const unauthenticated = await rejectionOf(() =>
      fetchCategorizationAiWorkStatus(HOUSEHOLD_ID),
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.code).toBe('UNAUTHENTICATED');

    // Another member and an outsider both receive the same privacy-preserving
    // 404, so the caller can treat it as lost access without probing further.
    stubFetch(() =>
      jsonResponse({ code: 'HOUSEHOLD_NOT_FOUND', message: 'Not found.' }, 404),
    );
    const hidden = await rejectionOf(() =>
      fetchCategorizationAiWorkStatus(HOUSEHOLD_ID),
    );
    expect(hidden.status).toBe(404);
    expect(hidden.code).toBe('HOUSEHOLD_NOT_FOUND');
  });

  it('reports an unreachable server as a network error rather than a status', async () => {
    const calls = stubFetchFailure();
    const failure = await rejectionOf(() =>
      fetchCategorizationAiWorkStatus(HOUSEHOLD_ID),
    );
    expect(calls).toEqual([STATUS_URL]);
    expect(failure.status).toBe(0);
    expect(failure.code).toBe('NETWORK_ERROR');
  });

  it('aborts with the caller signal without inventing a status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted.', 'AbortError')),
            );
          }),
      ),
    );
    const controller = new AbortController();
    const pending = fetchCategorizationAiWorkStatus(
      HOUSEHOLD_ID,
      controller.signal,
    );
    controller.abort();
    const failure = await rejectionOf(() => pending);
    expect(failure.code).toBe('UNKNOWN_ERROR');
    expect(failure.message).toBe('Request was cancelled.');
  });
});
