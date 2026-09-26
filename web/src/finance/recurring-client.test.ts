import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRecurringPlan,
  fetchRecurringCandidates,
  fetchRecurringPlanProjections,
  putRecurringReview,
} from '../auth/client';
import {
  parseCandidatePage,
  parsePlanObservations,
  type Candidate,
} from './recurring';
const household = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const key = 'a'.repeat(64);
const candidate: Candidate = {
  merchantKey: key,
  label: 'Shared utility',
  cadence: 'MONTHLY',
  anchorOn: '2026-06-01',
  calendarAnchor: 'DAY_OF_MONTH',
  occurrenceCount: '3',
  firstOccurredOn: '2026-06-01',
  lastOccurredOn: '2026-08-01',
  minAmount: '80.12',
  medianAmount: '95.40',
  maxAmount: '210.00',
  amountPattern: 'VARIABLE',
  suggestedKind: 'BILL',
  nextExpectedOn: '2026-09-01',
  expectationState: 'NOT_OBSERVED',
  candidateFingerprint: 'b'.repeat(64),
  reviewStatus: 'OPEN',
  reviewVersion: 0,
  activePlanId: null,
};
const metadata = {
  reportingTimeZone: 'Etc/UTC',
  asOfDate: '2026-09-25',
  currency: 'USD',
  policyVersion: 'RECURRENCE_V1/PUBLIC_DESCRIPTION_V1',
  snapshot: 'c'.repeat(64),
  evidenceFrom: '2023-09-25',
  evidenceTo: '2026-09-26',
};
const plan = {
  id: '11111111-2222-4333-8444-555555555555',
  householdId: household,
  label: 'Shared utility',
  kind: 'BILL',
  currency: 'USD',
  matchDescription: 'Shared utility',
  merchantKey: key,
  cadence: 'MONTHLY',
  anchorOn: '2026-06-01',
  calendarAnchor: 'DAY_OF_MONTH',
  expectedAmount: null,
  status: 'ACTIVE',
  version: 1,
  createdAt: '2026-09-25T12:00:00Z',
  updatedAt: '2026-09-25T12:00:00Z',
};
const expense = {
  id: '22222222-2222-4333-8444-555555555555',
  version: 1,
  kind: 'EXPENSE',
  occurredOn: '2026-09-01',
  money: { amount: '-80.12', currency: 'USD' },
  description: 'Shared utility',
  category: 'UTILITIES',
  refundOfTransactionId: null,
};
afterEach(() => vi.unstubAllGlobals());
describe('recurring strict client contract', () => {
  it('accepts exact current evidence and rejects hidden additions, wrong signs and mismatched selected currency', () => {
    const page = { ...metadata, items: [candidate], nextCursor: null };
    expect(
      parseCandidatePage(page, 'USD', 'OPEN', 100)?.items[0]?.minAmount,
    ).toBe('80.12');
    expect(
      parseCandidatePage(
        { ...page, privateAmount: '5.00' },
        'USD',
        'OPEN',
        100,
      ),
    ).toBeUndefined();
    expect(
      parseCandidatePage(
        { ...page, items: [{ ...candidate, minAmount: 80.12 }] },
        'USD',
        'OPEN',
        100,
      ),
    ).toBeUndefined();
    expect(
      parseCandidatePage(
        { ...page, items: [{ ...candidate, reviewStatus: 'DISMISSED' }] },
        'USD',
        'OPEN',
        100,
      ),
    ).toBeUndefined();
    expect(parseCandidatePage(page, 'JPY', 'OPEN', 100)).toBeUndefined();
    const observation = {
      ...metadata,
      plan,
      expectation: {
        latestExpectedOn: '2026-09-01',
        latestState: 'OBSERVED',
        nextExpectedOn: '2026-10-01',
        windowFrom: '2026-08-29',
        windowTo: '2026-09-05',
        matchedCount: '1',
        observedAmount: '80.12',
      },
      items: [expense],
      nextCursor: null,
    };
    expect(
      parsePlanObservations(observation, household, plan.id, 100)?.items,
    ).toHaveLength(1);
    expect(
      parsePlanObservations(
        { ...observation, plan: { ...plan, anchorOn: '9999-12-31' } },
        household,
        plan.id,
        100,
      ),
    ).toBeUndefined();
    expect(
      parsePlanObservations(
        { ...observation, plan: { ...plan, anchorOn: '9999-12-30' } },
        household,
        plan.id,
        100,
      )?.plan.anchorOn,
    ).toBe('9999-12-30');
    expect(
      parsePlanObservations(
        {
          ...observation,
          items: [{ ...expense, money: { amount: '80.12', currency: 'USD' } }],
        },
        household,
        plan.id,
        100,
      ),
    ).toBeUndefined();
  });
  it('uses scoped routes, CSRF and exactly one keyed create body; never submits the candidate evidence as plan content', async () => {
    const calls: { path: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init: RequestInit) => {
        calls.push({ path, init });
        if (path.includes('recurring-candidates'))
          return new Response(
            JSON.stringify({
              ...metadata,
              items: [candidate],
              nextCursor: null,
            }),
            { status: 200 },
          );
        if (path.includes('recurring-review'))
          return new Response(
            JSON.stringify({
              merchantKey: key,
              currency: 'USD',
              reviewStatus: 'DISMISSED',
              reviewVersion: 1,
            }),
            { status: 200 },
          );
        if (path.includes('insights/recurring-plans'))
          return new Response(
            JSON.stringify({ ...metadata, items: [], nextCursor: null }),
            { status: 200 },
          );
        return new Response(JSON.stringify(plan), { status: 201 });
      }),
    );
    await fetchRecurringCandidates(household, 'USD', 'OPEN', 100);
    await fetchRecurringPlanProjections(household, 'USD');
    await putRecurringReview(
      household,
      'USD',
      key,
      candidate.candidateFingerprint,
      0,
      'DISMISSED',
      { token: 'secret', headerName: 'X-CSRF-TOKEN' },
    );
    await createRecurringPlan(
      household,
      {
        label: 'Shared utility',
        kind: 'BILL',
        currency: 'USD',
        matchDescription: 'Shared utility',
        cadence: 'MONTHLY',
        anchorOn: '2026-06-01',
        calendarAnchor: 'DAY_OF_MONTH',
        expectedAmount: null,
        acknowledgeHouseholdDisclosure: true,
        candidate: {
          merchantKey: key,
          candidateFingerprint: candidate.candidateFingerprint,
        },
      },
      '33333333-2222-4333-8444-555555555555',
      { token: 'secret', headerName: 'X-CSRF-TOKEN' },
    );
    expect(calls[0]?.path).toContain(
      `/api/households/${household}/insights/recurring-candidates?currency=USD&review=OPEN&limit=100`,
    );
    expect(calls[1]?.path).toContain(
      '/insights/recurring-plans?currency=USD&limit=100',
    );
    expect(calls[2]?.init.method).toBe('PUT');
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({
      currency: 'USD',
      merchantKey: key,
      candidateFingerprint: candidate.candidateFingerprint,
      expectedVersion: 0,
      status: 'DISMISSED',
    });
    expect(calls[3]?.init.headers).toMatchObject({
      'X-CSRF-TOKEN': 'secret',
      'Idempotency-Key': '33333333-2222-4333-8444-555555555555',
    });
    expect(JSON.parse(String(calls[3]?.init.body))).not.toHaveProperty('items');
  });
});
