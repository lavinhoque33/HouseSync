import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  fetchFinanceSettings,
  fetchSpendingSummary,
  fetchContributionSummary,
  patchFinanceSettings,
} from '../auth/client';

const CSRF = { token: 'csrf-token-1', headerName: 'X-CSRF-TOKEN' };
const HOUSEHOLD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

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

function validSettings(overrides: Record<string, unknown> = {}) {
  return { reportingTimeZone: 'Etc/UTC', version: 0, ...overrides };
}

function validGroup(overrides: Record<string, unknown> = {}) {
  return {
    currency: 'USD',
    expenseTotal: '100.00',
    refundTotal: '20.00',
    netSpending: '80.00',
    incomeTotal: '200.00',
    ...overrides,
  };
}

function validSummary(overrides: Record<string, unknown> = {}) {
  return {
    from: '2026-09-01',
    to: '2026-10-01',
    reportingTimeZone: 'Etc/UTC',
    currencies: [validGroup()],
    ...overrides,
  };
}

describe('finance settings typed client', () => {
  it('reads settings over the documented route with no-store semantics', async () => {
    const calls = stubFetch((url) => {
      expect(url).toBe(`/api/households/${HOUSEHOLD_ID}/finance-settings`);
      return jsonResponse(validSettings());
    });
    const settings = await fetchFinanceSettings(HOUSEHOLD_ID);
    expect(settings).toEqual(validSettings());
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.credentials).toBe('include');
    expect(calls[0]?.init?.cache).toBe('no-store');
  });

  it('rejects settings outside the exact two-field contract', async () => {
    const malformed = [
      validSettings({ extra: true }),
      validSettings({ version: undefined }),
      { reportingTimeZone: 'Etc/UTC' },
      validSettings({ reportingTimeZone: '' }),
      // Drifted zones fail as unexpected contract data: short aliases,
      // bare offsets, and malformed region names are never passed to Intl
      // or rendered as authoritative.
      validSettings({ reportingTimeZone: 'EST' }),
      validSettings({ reportingTimeZone: 'UTC' }),
      validSettings({ reportingTimeZone: '+03:00' }),
      validSettings({ reportingTimeZone: 'Etc /UTC' }),
      validSettings({ reportingTimeZone: 42 }),
      validSettings({ version: 1.5 }),
      validSettings({ version: -1 }),
      validSettings({ version: 2147483648 }),
      'settings',
    ];
    for (const body of malformed) {
      stubFetch(() => jsonResponse(body));
      const failure = await fetchFinanceSettings(HOUSEHOLD_ID).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure as ApiError).toMatchObject({ code: 'UNKNOWN_ERROR' });
    }
  });

  it('patches with exactly the zone plus expected version and CSRF', async () => {
    const calls = stubFetch((url) => {
      expect(url).toBe(`/api/households/${HOUSEHOLD_ID}/finance-settings`);
      return jsonResponse(
        validSettings({ reportingTimeZone: 'America/Sao_Paulo', version: 1 }),
      );
    });
    const updated = await patchFinanceSettings(
      HOUSEHOLD_ID,
      { reportingTimeZone: 'America/Sao_Paulo', expectedVersion: 0 },
      CSRF,
    );
    expect(updated).toEqual(
      validSettings({ reportingTimeZone: 'America/Sao_Paulo', version: 1 }),
    );
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.init?.headers).toMatchObject({
      'X-CSRF-TOKEN': CSRF.token,
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      reportingTimeZone: 'America/Sao_Paulo',
      expectedVersion: 0,
    });
  });

  it('surfaces stale versions, forbidden edits, and zone field errors', async () => {
    stubFetch(() =>
      jsonResponse(
        {
          code: 'RESOURCE_VERSION_CONFLICT',
          message: 'The settings changed; reload before retrying.',
          correlationId: 'corr-stale',
        },
        409,
      ),
    );
    const stale = await patchFinanceSettings(
      HOUSEHOLD_ID,
      { reportingTimeZone: 'Etc/UTC', expectedVersion: 0 },
      CSRF,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(stale as ApiError).toMatchObject({
      status: 409,
      code: 'RESOURCE_VERSION_CONFLICT',
      correlationId: 'corr-stale',
    });

    stubFetch(() =>
      jsonResponse({ code: 'FORBIDDEN', message: 'Owners only.' }, 403),
    );
    const forbidden = await patchFinanceSettings(
      HOUSEHOLD_ID,
      { reportingTimeZone: 'Etc/UTC', expectedVersion: 0 },
      CSRF,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(forbidden as ApiError).toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });

    stubFetch(() =>
      jsonResponse(
        {
          code: 'VALIDATION_FAILED',
          message: 'Check the highlighted fields.',
          fieldErrors: {
            reportingTimeZone: 'Unknown time zone.',
            injected: 'must-be-dropped',
          },
        },
        400,
      ),
    );
    const invalid = await patchFinanceSettings(
      HOUSEHOLD_ID,
      { reportingTimeZone: 'EST', expectedVersion: 0 },
      CSRF,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(invalid as ApiError).toMatchObject({
      code: 'VALIDATION_FAILED',
      fieldErrors: { reportingTimeZone: 'Unknown time zone.' },
    });
  });
});

describe('spending summary typed client', () => {
  it('fetches one explicit interval with both bounds and no-store semantics', async () => {
    const calls = stubFetch((url) => {
      expect(url).toBe(
        `/api/households/${HOUSEHOLD_ID}/spending-summary?from=2026-09-01&to=2026-10-01`,
      );
      return jsonResponse(validSummary());
    });
    const summary = await fetchSpendingSummary(
      HOUSEHOLD_ID,
      '2026-09-01',
      '2026-10-01',
    );
    expect(summary).toEqual(validSummary());
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.credentials).toBe('include');
    expect(calls[0]?.init?.cache).toBe('no-store');
  });

  it('preserves exact strings: ordering, negative nets, and zero groups', async () => {
    stubFetch(() =>
      jsonResponse(
        validSummary({
          reportingTimeZone: 'America/Sao_Paulo',
          currencies: [
            // Transfer-only currency: exact zeros, never an invented value.
            validGroup({
              currency: 'EUR',
              expenseTotal: '0.00',
              refundTotal: '0.00',
              netSpending: '0.00',
              incomeTotal: '0.00',
            }),
            // Scale-0 currency without a decimal point.
            validGroup({
              currency: 'JPY',
              expenseTotal: '1000',
              refundTotal: '0',
              netSpending: '1000',
              incomeTotal: '0',
            }),
            // Scale-3 currency with a valid negative net.
            validGroup({
              currency: 'KWD',
              expenseTotal: '10.000',
              refundTotal: '25.000',
              netSpending: '-15.000',
              incomeTotal: '0.000',
            }),
            validGroup(),
          ],
        }),
      ),
    );
    const summary = await fetchSpendingSummary(
      HOUSEHOLD_ID,
      '2026-09-01',
      '2026-10-01',
    );
    expect(summary.currencies.map((group) => group.currency)).toEqual([
      'EUR',
      'JPY',
      'KWD',
      'USD',
    ]);
    expect(summary.currencies[0]).toMatchObject({
      expenseTotal: '0.00',
      netSpending: '0.00',
    });
    expect(summary.currencies[1]).toMatchObject({
      expenseTotal: '1000',
      netSpending: '1000',
    });
    expect(summary.currencies[2]).toMatchObject({ netSpending: '-15.000' });
    expect(summary.reportingTimeZone).toBe('America/Sao_Paulo');
  });

  it('renders the honest empty state without inventing a zero', async () => {
    stubFetch(() => jsonResponse(validSummary({ currencies: [] })));
    const summary = await fetchSpendingSummary(
      HOUSEHOLD_ID,
      '2026-09-01',
      '2026-10-01',
    );
    expect(summary.currencies).toEqual([]);
  });

  it('rejects summaries outside the exact contract', async () => {
    const malformed = [
      // Unordered currency groups.
      validSummary({
        currencies: [
          validGroup(),
          validGroup({
            currency: 'EUR',
            expenseTotal: '0.00',
            refundTotal: '0.00',
            netSpending: '0.00',
            incomeTotal: '0.00',
          }),
        ],
      }),
      // Duplicate currency.
      validSummary({ currencies: [validGroup(), validGroup()] }),
      // Negative expense magnitude.
      validSummary({
        currencies: [
          validGroup({ expenseTotal: '-100.00', netSpending: '-120.00' }),
        ],
      }),
      // Negative refund magnitude.
      validSummary({
        currencies: [
          validGroup({ refundTotal: '-20.00', netSpending: '120.00' }),
        ],
      }),
      // Negative income magnitude.
      validSummary({ currencies: [validGroup({ incomeTotal: '-1.00' })] }),
      // Net identity drift: 100 - 20 is not 79.
      validSummary({ currencies: [validGroup({ netSpending: '79.00' })] }),
      // Wrong scale on a scale-2 currency.
      validSummary({
        currencies: [
          validGroup({ expenseTotal: '100.0', netSpending: '80.0' }),
        ],
      }),
      // Decimal point on a scale-0 currency.
      validSummary({
        currencies: [
          validGroup({
            currency: 'JPY',
            expenseTotal: '1000.0',
            refundTotal: '0.0',
            netSpending: '1000.0',
            incomeTotal: '0.0',
          }),
        ],
      }),
      // Extra key in a group.
      validSummary({ currencies: [{ ...validGroup(), extra: 1 }] }),
      // Extra top-level key.
      { ...validSummary(), grandTotal: '80.00' },
      // Drifted reporting zones fail like any other contract drift.
      validSummary({ reportingTimeZone: 'EST' }),
      validSummary({ reportingTimeZone: '+03:00' }),
      validSummary({ reportingTimeZone: '' }),
      // Missing top-level key.
      { from: '2026-09-01', to: '2026-10-01', reportingTimeZone: 'Etc/UTC' },
      // Unordered interval.
      validSummary({ from: '2026-10-01', to: '2026-10-01' }),
      validSummary({ from: '2026-11-01', to: '2026-10-01' }),
      // Unsupported transaction-range boundary is still rejected.
      validSummary({ from: '1899-12-31', to: '2026-10-01' }),
      // Malformed date.
      validSummary({ from: '2026-9-1', to: '2026-10-01' }),
      'summary',
    ];
    for (const body of malformed) {
      stubFetch(() => jsonResponse(body));
      const failure = await fetchSpendingSummary(
        HOUSEHOLD_ID,
        '2026-09-01',
        '2026-10-01',
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure as ApiError).toMatchObject({ code: 'UNKNOWN_ERROR' });
    }
  });

  it('maps access loss and session expiry to their safe codes', async () => {
    stubFetch(() =>
      jsonResponse(
        { code: 'HOUSEHOLD_NOT_FOUND', message: 'Household is unavailable.' },
        404,
      ),
    );
    const missing = await fetchSpendingSummary(
      HOUSEHOLD_ID,
      '2026-09-01',
      '2026-10-01',
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(missing as ApiError).toMatchObject({
      status: 404,
      code: 'HOUSEHOLD_NOT_FOUND',
    });

    stubFetch(() =>
      jsonResponse(
        { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
        401,
      ),
    );
    const expired = await fetchSpendingSummary(
      HOUSEHOLD_ID,
      '2026-09-01',
      '2026-10-01',
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(expired as ApiError).toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    });
  });

  it('bounds a stalled summary by the deadline with an unknown outcome', async () => {
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
    const failure = await fetchSpendingSummary(
      HOUSEHOLD_ID,
      '2026-09-01',
      '2026-10-01',
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

describe('contribution summary strict client', () => {
  const snapshot = 'a'.repeat(64);
  const item = {
    userId: '11111111-2222-4333-8444-555555555555',
    membershipStatus: 'DEPARTED',
    expensePaid: '0.00',
    refundReceived: '1.00',
    netPaid: '-1.00',
    allocatedCost: '-0.70',
  };
  function response(overrides: Record<string, unknown> = {}) {
    return {
      from: '2026-09-01',
      to: '2026-10-01',
      reportingTimeZone: 'Etc/UTC',
      currency: 'USD',
      snapshot,
      totals: {
        expenseTotal: '0.00',
        refundTotal: '1.00',
        netSpending: '-1.00',
        allocatedCostTotal: '-0.70',
        unallocatedNet: '-0.30',
      },
      items: [item],
      limit: 50,
      offset: 0,
      hasMore: false,
      ...overrides,
    };
  }
  it('accepts refund-only signed costs and requests a no-store snapshot-bound page', async () => {
    const calls = stubFetch(() =>
      jsonResponse(response({ offset: 1, items: [] })),
    );
    const page = await fetchContributionSummary(
      HOUSEHOLD_ID,
      '2026-09-01',
      '2026-10-01',
      'USD',
      { offset: 1, snapshot },
    );
    expect(page.totals.unallocatedNet).toBe('-0.30');
    expect(calls[0]?.url).toContain(`offset=1&snapshot=${snapshot}`);
    expect(calls[0]?.init?.cache).toBe('no-store');
  });
  it('rejects extra/private columns, mismatched arithmetic, malformed pages and snapshot drift', async () => {
    const malformed = [
      response({ repaymentCount: 1 }),
      response({ items: [{ ...item, repaymentSent: '2.70' }] }),
      response({ items: [{ ...item, netPaid: '1.00' }] }),
      response({ items: [{ ...item, expensePaid: '-0.00' }] }),
      response({ items: [{ ...item, allocatedCost: '-0.7' }] }),
      response({ items: [{ ...item, membershipStatus: 'UNKNOWN' }] }),
      response({ items: [item, item] }),
      response({ items: [{ ...item, userId: 'BAD' }] }),
      response({
        items: [
          {
            ...item,
            expensePaid: '0.00',
            refundReceived: '0.00',
            netPaid: '0.00',
            allocatedCost: '0.00',
          },
        ],
      }),
      response({ totals: { ...response().totals, unallocatedNet: '-0.20' } }),
      response({ snapshot: 'B'.repeat(64) }),
      response({ hasMore: true }),
      response({ limit: 100 }),
      response({ offset: 1 }),
      response({ reportingTimeZone: 'EST' }),
      response({ from: '2026-08-01' }),
    ];
    for (const body of malformed) {
      stubFetch(() => jsonResponse(body));
      await expect(
        fetchContributionSummary(
          HOUSEHOLD_ID,
          '2026-09-01',
          '2026-10-01',
          'USD',
        ),
      ).rejects.toMatchObject({
        status: 200,
        code: 'UNKNOWN_ERROR',
        message:
          'The server returned an unexpected contribution-summary response.',
      });
    }
  });
  it('preserves the safe 409 code for an invalidated continuation', async () => {
    stubFetch(() =>
      jsonResponse(
        {
          code: 'CONTRIBUTION_SNAPSHOT_STALE',
          message: 'Snapshot changed.',
        },
        409,
      ),
    );
    await expect(
      fetchContributionSummary(
        HOUSEHOLD_ID,
        '2026-09-01',
        '2026-10-01',
        'USD',
        { offset: 50, snapshot },
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: 'CONTRIBUTION_SNAPSHOT_STALE',
    });
  });
});
