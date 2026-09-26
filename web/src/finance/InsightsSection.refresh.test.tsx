import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Household } from '../auth/client';
import { InsightsSection } from './InsightsSection';

vi.mock('./BudgetSection', () => ({ BudgetSection: () => null }));

const comparison = vi.fn();
const series = vi.fn();
const summary = vi.fn();
const candidates = vi.fn();
const projections = vi.fn();
const plans = vi.fn();
const evidence = vi.fn();
vi.mock('../auth/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchInsightComparison: (...args: unknown[]) => comparison(...args),
    fetchInsightSeries: (...args: unknown[]) => series(...args),
    fetchInsightSummary: (...args: unknown[]) => summary(...args),
    fetchRecurringCandidates: (...args: unknown[]) => candidates(...args),
    fetchRecurringPlanProjections: (...args: unknown[]) => projections(...args),
    fetchRecurringPlans: (...args: unknown[]) => plans(...args),
    fetchRecurringEvidence: (...args: unknown[]) => evidence(...args),
  };
});

const household: Household = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  name: 'Home',
  role: 'MEMBER',
  createdAt: '2026-01-01T00:00:00Z',
};
const metadata = {
  reportingTimeZone: 'Etc/UTC',
  asOfDate: '2026-09-25',
  currency: 'USD',
  policyVersion: 'SPENDING_V1/PUBLIC_DESCRIPTION_V1',
  snapshot: 'a'.repeat(64),
};
const recurringMetadata = {
  ...metadata,
  policyVersion: 'RECURRENCE_V1/PUBLIC_DESCRIPTION_V1',
  evidenceFrom: '2023-09-25',
  evidenceTo: '2026-09-26',
};
const spend = {
  expenseTotal: '0.00',
  refundTotal: '0.00',
  netSpending: '0.00',
  expenseCount: '0',
  refundCount: '0',
};
const totals = { ...spend, incomeTotal: '0.00' };
const change = {
  delta: '0.00',
  direction: 'UNCHANGED',
  percentChange: null,
  percentUnavailableReason: 'BASELINE_ZERO',
};
const current = {
  month: '2026-09',
  from: '2026-09-01',
  to: '2026-10-01',
  state: 'IN_PROGRESS',
};
const baseline = {
  month: '2026-08',
  from: '2026-08-01',
  to: '2026-09-01',
  state: 'COMPLETED',
};
const candidate = {
  merchantKey: 'b'.repeat(64),
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
  candidateFingerprint: 'c'.repeat(64),
  reviewStatus: 'OPEN',
  reviewVersion: 0,
  activePlanId: null,
};

afterEach(() => vi.clearAllMocks());

it('removes displayed recurring evidence after a remote unshare and global Insights refresh', async () => {
  let shared = true;
  comparison.mockImplementation(async () => ({
    ...metadata,
    period: current,
    baselinePeriod: baseline,
    dimension: 'CATEGORY',
    current: totals,
    baseline: totals,
    change,
    items: [],
    nextCursor: null,
  }));
  series.mockImplementation(async () => ({
    ...metadata,
    fromMonth: '2026-01',
    toMonth: '2026-10',
    dimension: null,
    groupKey: null,
    items: [],
  }));
  summary.mockImplementation(async () => ({
    ...metadata,
    policyVersion:
      'SUMMARY_V1/SPENDING_V1/RECURRENCE_V1/BUDGETS_V1/PUBLIC_DESCRIPTION_V1',
    period: current,
    baselinePeriod: baseline,
    current: totals,
    baseline: totals,
    change,
    categoryDrivers: { increases: [], decreases: [], otherDelta: '0.00' },
    merchantDrivers: { increases: [], decreases: [], otherDelta: '0.00' },
    budget: { totals: spend, overall: null, categories: [], untargeted: spend },
    recurring: {
      evidenceFrom: recurringMetadata.evidenceFrom,
      evidenceTo: recurringMetadata.evidenceTo,
      openCandidateCount: shared ? '1' : '0',
      activePlanCount: '0',
      items: [],
      hasMore: false,
    },
  }));
  candidates.mockImplementation(async () => ({
    ...recurringMetadata,
    items: shared ? [candidate] : [],
    nextCursor: null,
  }));
  projections.mockImplementation(async () => ({
    ...recurringMetadata,
    items: [],
    nextCursor: null,
  }));
  plans.mockImplementation(async () => ({
    items: [],
    limit: 100,
    offset: 0,
    hasMore: false,
  }));
  evidence.mockImplementation(async () => ({
    ...recurringMetadata,
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
            description: candidate.label,
            category: 'UTILITIES',
            refundOfTransactionId: null,
          },
        ]
      : [],
    nextCursor: null,
  }));

  render(
    <InsightsSection
      household={household}
      reportingZone="Etc/UTC"
      csrf={null}
      onCsrfRefreshed={vi.fn()}
      refreshSignal={0}
      onSessionExpired={vi.fn()}
      onHouseholdAccessChanged={vi.fn()}
      onOpenTransaction={vi.fn()}
      budgetPending={null}
      setBudgetPending={vi.fn()}
      nowProvider={() => new Date('2026-09-25T12:00:00Z')}
    />,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'View current evidence' }),
  );
  expect(await screen.findByText('2026-08-01')).toBeInTheDocument();

  shared = false;
  fireEvent.click(
    screen.getByRole('button', { name: 'Refresh current records' }),
  );
  await screen.findByText(/No currently qualifying open recurring suggestions/);
  expect(screen.queryByText('2026-08-01')).not.toBeInTheDocument();
});
