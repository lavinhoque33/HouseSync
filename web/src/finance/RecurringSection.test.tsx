import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Household } from '../auth/client';
import { RecurringSection } from './RecurringSection';
import type {
  Candidate,
  CandidatePage,
  PlanProjectionPage,
  RecurringPlan,
} from './recurring';

const household: Household = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  name: 'Home',
  role: 'MEMBER',
  createdAt: '2026-01-01T00:00:00Z',
};
const candidate: Candidate = {
  merchantKey: 'a'.repeat(64),
  label: 'Electric supplier',
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
  currency: 'USD' as const,
  policyVersion: 'RECURRENCE_V1/PUBLIC_DESCRIPTION_V1',
  snapshot: 'c'.repeat(64),
  evidenceFrom: '2023-09-25',
  evidenceTo: '2026-09-26',
};
const plan: RecurringPlan = {
  id: '11111111-2222-4333-8444-555555555555',
  householdId: household.id,
  label: 'Electric',
  kind: 'BILL',
  currency: 'USD',
  matchDescription: 'Electric supplier',
  merchantKey: candidate.merchantKey,
  cadence: 'MONTHLY',
  anchorOn: '2026-06-01',
  calendarAnchor: 'DAY_OF_MONTH',
  expectedAmount: null,
  status: 'ACTIVE',
  version: 1,
  createdAt: '2026-09-01T12:00:00Z',
  updatedAt: '2026-09-01T12:00:00Z',
};
const expectation = {
  latestExpectedOn: '2026-09-01',
  latestState: 'NOT_OBSERVED',
  nextExpectedOn: '2026-10-01',
  windowFrom: '2026-08-29',
  windowTo: '2026-09-05',
  matchedCount: '0',
  observedAmount: null,
} as const;
const fetchCandidates = vi.fn();
const fetchProjections = vi.fn();
const fetchPlans = vi.fn();
const review = vi.fn();
const create = vi.fn();
const patch = vi.fn();
const observations = vi.fn();
const candidateEvidence = vi.fn();
vi.mock('../auth/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchRecurringCandidates: (...args: unknown[]) => fetchCandidates(...args),
    fetchRecurringEvidence: (...args: unknown[]) => candidateEvidence(...args),
    fetchRecurringPlanProjections: (...args: unknown[]) =>
      fetchProjections(...args),
    fetchRecurringPlans: (...args: unknown[]) => fetchPlans(...args),
    putRecurringReview: (...args: unknown[]) => review(...args),
    createRecurringPlan: (...args: unknown[]) => create(...args),
    patchRecurringPlan: (...args: unknown[]) => patch(...args),
    fetchRecurringPlanObservations: (...args: unknown[]) =>
      observations(...args),
  };
});
function setup(role: Household['role'] = 'MEMBER') {
  return render(
    <RecurringSection
      household={{ ...household, role }}
      currency="USD"
      reportingZone="Etc/UTC"
      refreshSignal={0}
      csrf={{ token: 'csrf', headerName: 'X-CSRF-TOKEN' }}
      onCsrfRefreshed={vi.fn()}
      onSessionExpired={vi.fn()}
      onHouseholdAccessChanged={vi.fn()}
      onOpenTransaction={vi.fn()}
    />,
  );
}
function seed(items: Candidate[] = [candidate], tracked: RecurringPlan[] = []) {
  fetchCandidates.mockImplementation(
    async (_id: string, _currency: string, filter: string) =>
      ({
        ...metadata,
        items: items.filter((row) => row.reviewStatus === filter),
        nextCursor: null,
      }) as CandidatePage,
  );
  fetchProjections.mockImplementation(
    async () =>
      ({
        ...metadata,
        items: tracked.map((item) => ({ plan: item, expectation })),
        nextCursor: null,
      }) as PlanProjectionPage,
  );
  fetchPlans.mockImplementation(async () => ({
    items: [],
    limit: 100,
    offset: 0,
    hasMore: false,
  }));
}
afterEach(() => vi.clearAllMocks());
describe('recurring household review and retained plans', () => {
  it('lets a member dismiss and restore only their own candidate, without creating a plan', async () => {
    let status: Candidate['reviewStatus'] = 'OPEN';
    let version = 0;
    seed();
    fetchCandidates.mockImplementation(
      async (_id: string, _currency: string, filter: string) => ({
        ...metadata,
        items:
          status === filter
            ? [{ ...candidate, reviewStatus: status, reviewVersion: version }]
            : [],
        nextCursor: null,
      }),
    );
    review.mockImplementation(
      async (
        _id: string,
        _currency: string,
        _key: string,
        _fingerprint: string,
        expected: number,
        next: Candidate['reviewStatus'],
      ) => {
        expect(expected).toBe(version);
        status = next;
        version++;
        return {
          merchantKey: candidate.merchantKey,
          currency: 'USD',
          reviewStatus: status,
          reviewVersion: version,
        };
      },
    );
    setup();
    await screen.findByRole('button', { name: 'Dismiss for me' });
    expect(
      screen.queryByRole('button', { name: 'Create manual household plan' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss for me' }));
    await waitFor(() => expect(review).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));
    fireEvent.change(screen.getByLabelText('Review filter'), {
      target: { value: 'DISMISSED' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await screen.findByRole('button', { name: 'Restore for me' });
    fireEvent.click(screen.getByRole('button', { name: 'Restore for me' }));
    await waitFor(() => expect(review).toHaveBeenCalledTimes(2));
    expect(create).not.toHaveBeenCalled();
    expect(review.mock.calls[0]?.slice(1, 6)).toEqual([
      'USD',
      candidate.merchantKey,
      candidate.candidateFingerprint,
      0,
      'DISMISSED',
    ]);
  });
  it('distinguishes manual creation with no candidate from assisted editable household intent', async () => {
    seed();
    create.mockResolvedValue(plan);
    setup('OWNER');
    await screen.findByRole('button', { name: 'Create manual household plan' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Create manual household plan' }),
    );
    const form = screen.getByRole('form', { name: 'Create household plan' });
    fireEvent.change(within(form).getByLabelText('Plan label'), {
      target: { value: 'Independent Internet' },
    });
    fireEvent.change(within(form).getByLabelText('Matching description'), {
      target: { value: 'Internet provider' },
    });
    fireEvent.change(within(form).getByLabelText('Anchor date'), {
      target: { value: '2026-09-01' },
    });
    fireEvent.click(within(form).getByLabelText(/I understand and authorize/));
    fireEvent.click(
      within(form).getByRole('button', { name: 'Create shared plan' }),
    );
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByText('Household plan created.')).toHaveFocus(),
    );
    expect(create.mock.calls[0]?.[1]).toMatchObject({
      label: 'Independent Internet',
      matchDescription: 'Internet provider',
      expectedAmount: null,
      acknowledgeHouseholdDisclosure: true,
    });
    expect(create.mock.calls[0]?.[1]).not.toHaveProperty('candidate');
    await screen.findByRole('button', {
      name: 'Use current suggestion to draft shared plan',
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Use current suggestion to draft shared plan',
      }),
    );
    const assisted = screen.getByRole('form', {
      name: 'Create household plan',
    });
    expect(within(assisted).getByLabelText('Matching description')).toHaveValue(
      'Electric supplier',
    );
    fireEvent.change(within(assisted).getByLabelText('Plan label'), {
      target: { value: 'Our power bill' },
    });
    fireEvent.click(
      within(assisted).getByLabelText(/I understand and authorize/),
    );
    fireEvent.click(
      within(assisted).getByRole('button', { name: 'Create shared plan' }),
    );
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByText('Household plan created.')).toHaveFocus(),
    );
    expect(create.mock.calls[1]?.[1]).toMatchObject({
      label: 'Our power bill',
      candidate: {
        merchantKey: candidate.merchantKey,
        candidateFingerprint: candidate.candidateFingerprint,
      },
    });
  });
  it('retains keyboard focus on the success status after a plan edit', async () => {
    let current = plan;
    seed([], [plan]);
    fetchProjections.mockImplementation(async () => ({
      ...metadata,
      items: [{ plan: current, expectation }],
      nextCursor: null,
    }));
    patch.mockImplementation(async () => {
      current = { ...plan, expectedAmount: '125.00', version: 2 };
      return current;
    });
    setup('OWNER');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit shared plan' }),
    );
    const form = screen.getByRole('form', { name: 'Edit household plan' });
    fireEvent.change(within(form).getByLabelText(/Expected amount in USD/), {
      target: { value: '125.00' },
    });
    fireEvent.click(within(form).getByLabelText(/I understand and authorize/));
    fireEvent.click(
      within(form).getByRole('button', { name: 'Save shared plan' }),
    );
    await screen.findByText(/Expected amount: 125.00 USD/);
    await waitFor(() =>
      expect(screen.getByText('Household plan updated.')).toHaveFocus(),
    );
  });
  it('archives explicit intent while revoked evidence disappears and keeps role-gained editing separate', async () => {
    seed([], [plan]);
    observations.mockResolvedValue({
      ...metadata,
      plan,
      expectation,
      items: [],
      nextCursor: null,
    });
    patch.mockResolvedValue({ ...plan, status: 'ARCHIVED', version: 2 });
    const member = setup();
    await screen.findByRole('button', { name: 'View evidence' });
    fireEvent.click(screen.getByRole('button', { name: 'View evidence' }));
    expect(
      await screen.findByText('No currently disclosed matching expenses.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive plan' })).toBeNull();
    member.unmount();
    setup('OWNER');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Archive plan' }),
    );
    expect(patch).not.toHaveBeenCalled();
    expect(
      await screen.findByRole('group', {
        name: 'Archive Electric confirmation',
      }),
    ).toHaveTextContent(/cannot be restored or edited/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel archive' }));
    expect(patch).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Confirm archive' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Archive plan' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Confirm archive' }),
    );
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        household.id,
        plan.id,
        { expectedVersion: 1, status: 'ARCHIVED' },
        expect.anything(),
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByText(
          'Household plan archived; retained intent remains readable.',
        ),
      ).toHaveFocus(),
    );
  });
  it('drops a previously shared candidate and evidence on refresh while independently authored plan remains', async () => {
    let shared = true;
    seed([candidate], [plan]);
    fetchCandidates.mockImplementation(async () => ({
      ...metadata,
      items: shared ? [candidate] : [],
      nextCursor: null,
    }));
    candidateEvidence.mockImplementation(async () => ({
      ...metadata,
      merchantKey: candidate.merchantKey,
      candidate: shared ? candidate : null,
      items: shared
        ? [
            {
              id: '22222222-2222-4333-8444-555555555555',
              version: 1,
              kind: 'EXPENSE',
              occurredOn: '2026-08-01',
              money: { amount: '-95.40', currency: 'USD' },
              description: 'Electric supplier',
              category: 'UTILITIES',
              refundOfTransactionId: null,
            },
          ]
        : [],
      nextCursor: null,
    }));
    const props = {
      household,
      currency: 'USD' as const,
      reportingZone: 'Etc/UTC',
      csrf: { token: 'csrf', headerName: 'X-CSRF-TOKEN' },
      onCsrfRefreshed: vi.fn(),
      onSessionExpired: vi.fn(),
      onHouseholdAccessChanged: vi.fn(),
      onOpenTransaction: vi.fn(),
    };
    const view = render(<RecurringSection {...props} refreshSignal={0} />);
    await screen.findByRole('button', { name: 'View current evidence' });
    fireEvent.click(
      screen.getByRole('button', { name: 'View current evidence' }),
    );
    expect(await screen.findByText('2026-08-01')).toBeInTheDocument();
    shared = false;
    view.rerender(<RecurringSection {...props} refreshSignal={1} />);
    await screen.findByText(
      /No currently qualifying open recurring suggestions/,
    );
    expect(screen.queryByText('2026-08-01')).toBeNull();
    expect(
      screen.getByText(
        /Matching text \(household-shared intent\): Electric supplier/,
      ),
    ).toBeInTheDocument();
  });
  it('does not keep an older active plan card after current observations reveal a remote archive', async () => {
    seed([], [plan]);
    observations.mockResolvedValue({
      ...metadata,
      plan: { ...plan, status: 'ARCHIVED', version: 2 },
      expectation: {
        ...expectation,
        latestState: 'OBSERVED',
        matchedCount: '1',
        observedAmount: '95.40',
      },
      items: [
        {
          id: '22222222-2222-4333-8444-555555555555',
          version: 1,
          kind: 'EXPENSE',
          occurredOn: '2026-09-01',
          money: { amount: '-95.40', currency: 'USD' },
          description: 'Electric supplier',
          category: 'UTILITIES',
          refundOfTransactionId: null,
        },
      ],
      nextCursor: null,
    });
    setup('OWNER');
    fireEvent.click(
      await screen.findByRole('button', { name: 'View evidence' }),
    );
    await screen.findByText(/Current plan: Electric · archived/);
    expect(screen.queryByRole('button', { name: 'Archive plan' })).toBeNull();
    expect(screen.getByText('2026-09-01')).toBeInTheDocument();
    expect(
      screen.getByText(/Tracked plans changed since loading/),
    ).toBeInTheDocument();
  });
  it('retains exactly the same keyed create request after a genuinely unknown outcome', async () => {
    seed([]);
    create
      .mockRejectedValueOnce(
        new ApiError({
          status: 0,
          code: 'NETWORK_ERROR',
          message: 'Connection lost',
        }),
      )
      .mockResolvedValueOnce(plan);
    setup('OWNER');
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Create manual household plan',
      }),
    );
    const form = screen.getByRole('form', { name: 'Create household plan' });
    fireEvent.change(within(form).getByLabelText('Plan label'), {
      target: { value: 'Independent service' },
    });
    fireEvent.change(within(form).getByLabelText('Matching description'), {
      target: { value: 'Explicit service' },
    });
    fireEvent.change(within(form).getByLabelText('Anchor date'), {
      target: { value: '2026-09-01' },
    });
    fireEvent.click(within(form).getByLabelText(/I understand and authorize/));
    fireEvent.click(
      within(form).getByRole('button', { name: 'Create shared plan' }),
    );
    await screen.findByRole('button', { name: 'Retry same create request' });
    expect(within(form).getByLabelText('Plan label')).toBeDisabled();
    expect(
      within(form).getByRole('button', { name: 'Create shared plan' }),
    ).toBeDisabled();
    fireEvent.click(
      within(form).getByRole('button', { name: 'Retry same create request' }),
    );
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]?.[1]).toEqual(create.mock.calls[0]?.[1]);
    expect(create.mock.calls[1]?.[2]).toBe(create.mock.calls[0]?.[2]);
  });
  it('clears old evidence and rows on snapshot conflict rather than merging next page', async () => {
    const many = Array.from({ length: 100 }, (_, index) => ({
      ...candidate,
      merchantKey: index.toString(16).padStart(64, '0'),
      label: `Visible ${index}`,
    }));
    seed();
    fetchCandidates.mockImplementation(
      async (
        _id: string,
        _currency: string,
        _filter: string,
        _limit: number,
        cursor?: string,
      ) => {
        if (cursor)
          throw new ApiError({
            status: 409,
            code: 'INSIGHT_SNAPSHOT_STALE',
            message: 'Changed',
          });
        return { ...metadata, items: many, nextCursor: 'opaque' };
      },
    );
    setup();
    await screen.findByText('Visible 0');
    fireEvent.click(
      screen.getByRole('button', { name: 'Load more candidates' }),
    );
    await screen.findByRole('alert');
    expect(screen.queryByText('Visible 0')).toBeNull();
    expect(
      screen.getByText(/Old pages and evidence were cleared/),
    ).toBeInTheDocument();
  });
});
