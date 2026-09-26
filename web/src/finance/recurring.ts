import {
  isAggregateAmountString,
  isSupportedAmountString,
  type FinancialAccountCurrency,
} from './money';
import { isRegionShapedZone } from './reporting';
import type { InsightEvidenceItem } from './insights';

export type Cadence =
  'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
export type PlanKind = 'BILL' | 'SUBSCRIPTION' | 'RECURRING_EXPENSE';
export type CalendarAnchor = 'DAY_OF_MONTH' | 'END_OF_MONTH' | null;
export type Candidate = {
  merchantKey: string;
  label: string;
  cadence: Cadence;
  anchorOn: string;
  calendarAnchor: CalendarAnchor;
  occurrenceCount: string;
  firstOccurredOn: string;
  lastOccurredOn: string;
  minAmount: string;
  medianAmount: string;
  maxAmount: string;
  amountPattern: 'STABLE' | 'VARIABLE';
  suggestedKind: PlanKind;
  nextExpectedOn: string | null;
  expectationState: 'UPCOMING' | 'DUE_WINDOW' | 'NOT_OBSERVED' | 'DATE_LIMIT';
  candidateFingerprint: string;
  reviewStatus: 'OPEN' | 'DISMISSED';
  reviewVersion: number;
  activePlanId: string | null;
};
export type RecurringPlan = {
  id: string;
  householdId: string;
  label: string;
  kind: PlanKind;
  currency: FinancialAccountCurrency;
  matchDescription: string;
  merchantKey: string;
  cadence: Cadence;
  anchorOn: string;
  calendarAnchor: CalendarAnchor;
  expectedAmount: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
  createdAt: string;
  updatedAt: string;
};
export type PlanExpectation = {
  latestExpectedOn: string | null;
  latestState:
    'NOT_STARTED' | 'OBSERVED' | 'AMBIGUOUS' | 'AWAITING' | 'NOT_OBSERVED';
  nextExpectedOn: string | null;
  windowFrom: string | null;
  windowTo: string | null;
  matchedCount: string | null;
  observedAmount: string | null;
};
export type PlanProjection = {
  plan: RecurringPlan;
  expectation: PlanExpectation;
};
export type RecurringMetadata = {
  reportingTimeZone: string;
  asOfDate: string;
  currency: FinancialAccountCurrency;
  policyVersion: string;
  snapshot: string;
  evidenceFrom: string;
  evidenceTo: string;
};
export type CandidatePage = RecurringMetadata & {
  items: Candidate[];
  nextCursor: string | null;
};
export type CandidateEvidence = RecurringMetadata & {
  merchantKey: string;
  candidate: Candidate | null;
  items: InsightEvidenceItem[];
  nextCursor: string | null;
};
export type PlanPage = {
  items: RecurringPlan[];
  limit: number;
  offset: number;
  hasMore: boolean;
};
export type PlanProjectionPage = RecurringMetadata & {
  items: PlanProjection[];
  nextCursor: string | null;
};
export type PlanObservations = RecurringMetadata & {
  plan: RecurringPlan;
  expectation: PlanExpectation;
  items: InsightEvidenceItem[];
  nextCursor: string | null;
};
export type PlanContent = Pick<
  RecurringPlan,
  | 'label'
  | 'kind'
  | 'currency'
  | 'matchDescription'
  | 'cadence'
  | 'anchorOn'
  | 'calendarAnchor'
  | 'expectedAmount'
>;
export type CreatePlan = PlanContent & {
  acknowledgeHouseholdDisclosure: true;
  candidate?: { merchantKey: string; candidateFingerprint: string };
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const count = /^(0|[1-9][0-9]*)$/;
const datePattern = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const timestamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
const cadences: Cadence[] = [
  'WEEKLY',
  'BIWEEKLY',
  'MONTHLY',
  'QUARTERLY',
  'ANNUAL',
];
const kinds: PlanKind[] = ['BILL', 'SUBSCRIPTION', 'RECURRING_EXPENSE'];
export function calendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !datePattern.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}
function record(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function version(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function anchor(cadence: unknown, day: unknown, mode: unknown): boolean {
  return (
    cadences.includes(cadence as Cadence) &&
    calendarDate(day) &&
    day >= '1900-01-01' &&
    day <= '9999-12-30' &&
    (cadence === 'WEEKLY' || cadence === 'BIWEEKLY'
      ? mode === null
      : mode === 'DAY_OF_MONTH' ||
        (mode === 'END_OF_MONTH' &&
          new Date(`${day}T00:00:00Z`).getUTCDate() ===
            new Date(
              Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0),
            ).getUTCDate()))
  );
}
function amount(
  value: unknown,
  currency: FinancialAccountCurrency,
): value is string {
  return (
    typeof value === 'string' &&
    isSupportedAmountString(value, currency) &&
    !value.startsWith('-') &&
    !/^0(?:\.0+)?$/.test(value)
  );
}
function derivedAmount(
  value: unknown,
  currency: FinancialAccountCurrency,
): value is string {
  return (
    typeof value === 'string' &&
    isAggregateAmountString(value, currency) &&
    !value.startsWith('-') &&
    !/^0(?:\.0+)?$/.test(value)
  );
}
function cursor(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 2048 &&
      /^[A-Za-z0-9_-]+$/.test(value))
  );
}
function meta(
  value: Record<string, unknown>,
  currency: FinancialAccountCurrency,
): boolean {
  return (
    value.currency === currency &&
    value.policyVersion === 'RECURRENCE_V1/PUBLIC_DESCRIPTION_V1' &&
    typeof value.reportingTimeZone === 'string' &&
    isRegionShapedZone(value.reportingTimeZone) &&
    calendarDate(value.asOfDate) &&
    typeof value.snapshot === 'string' &&
    digest.test(value.snapshot) &&
    calendarDate(value.evidenceFrom) &&
    calendarDate(value.evidenceTo) &&
    value.evidenceFrom <= value.evidenceTo
  );
}
const metadataKeys = [
  'reportingTimeZone',
  'asOfDate',
  'currency',
  'policyVersion',
  'snapshot',
  'evidenceFrom',
  'evidenceTo',
];
const candidateKeys = [
  'merchantKey',
  'label',
  'cadence',
  'anchorOn',
  'calendarAnchor',
  'occurrenceCount',
  'firstOccurredOn',
  'lastOccurredOn',
  'minAmount',
  'medianAmount',
  'maxAmount',
  'amountPattern',
  'suggestedKind',
  'nextExpectedOn',
  'expectationState',
  'candidateFingerprint',
  'reviewStatus',
  'reviewVersion',
  'activePlanId',
];
function candidate(
  value: unknown,
  currency: FinancialAccountCurrency,
): value is Candidate {
  if (!record(value, candidateKeys)) return false;
  return (
    typeof value.merchantKey === 'string' &&
    digest.test(value.merchantKey) &&
    typeof value.label === 'string' &&
    value.label.length > 0 &&
    [...value.label].length <= 200 &&
    anchor(value.cadence, value.anchorOn, value.calendarAnchor) &&
    typeof value.occurrenceCount === 'string' &&
    count.test(value.occurrenceCount) &&
    BigInt(value.occurrenceCount) >= 3n &&
    calendarDate(value.firstOccurredOn) &&
    calendarDate(value.lastOccurredOn) &&
    value.firstOccurredOn === value.anchorOn &&
    value.firstOccurredOn <= value.lastOccurredOn &&
    derivedAmount(value.minAmount, currency) &&
    derivedAmount(value.medianAmount, currency) &&
    derivedAmount(value.maxAmount, currency) &&
    BigInt(value.minAmount.replace('.', '')) <=
      BigInt(value.medianAmount.replace('.', '')) &&
    BigInt(value.medianAmount.replace('.', '')) <=
      BigInt(value.maxAmount.replace('.', '')) &&
    (value.amountPattern === 'STABLE' || value.amountPattern === 'VARIABLE') &&
    kinds.includes(value.suggestedKind as PlanKind) &&
    (value.nextExpectedOn === null || calendarDate(value.nextExpectedOn)) &&
    ['UPCOMING', 'DUE_WINDOW', 'NOT_OBSERVED', 'DATE_LIMIT'].includes(
      String(value.expectationState),
    ) &&
    (value.nextExpectedOn === null) ===
      (value.expectationState === 'DATE_LIMIT') &&
    typeof value.candidateFingerprint === 'string' &&
    digest.test(value.candidateFingerprint) &&
    (value.reviewStatus === 'OPEN' || value.reviewStatus === 'DISMISSED') &&
    version(value.reviewVersion) &&
    (value.activePlanId === null ||
      (typeof value.activePlanId === 'string' && uuid.test(value.activePlanId)))
  );
}
const planKeys = [
  'id',
  'householdId',
  'label',
  'kind',
  'currency',
  'matchDescription',
  'merchantKey',
  'cadence',
  'anchorOn',
  'calendarAnchor',
  'expectedAmount',
  'status',
  'version',
  'createdAt',
  'updatedAt',
];
export function parseRecurringPlan(
  value: unknown,
  householdId?: string,
  currency?: FinancialAccountCurrency,
): RecurringPlan | undefined {
  if (
    !record(value, planKeys) ||
    typeof value.id !== 'string' ||
    !uuid.test(value.id) ||
    typeof value.householdId !== 'string' ||
    !uuid.test(value.householdId) ||
    (householdId !== undefined && value.householdId !== householdId) ||
    typeof value.currency !== 'string' ||
    !['BRL', 'USD', 'EUR', 'GBP', 'CAD', 'JPY', 'KWD'].includes(
      value.currency,
    ) ||
    (currency !== undefined && value.currency !== currency) ||
    typeof value.label !== 'string' ||
    !value.label.trim() ||
    value.label !== value.label.trim() ||
    [...value.label].length > 100 ||
    typeof value.matchDescription !== 'string' ||
    !value.matchDescription.trim() ||
    value.matchDescription !== value.matchDescription.trim() ||
    [...value.matchDescription].length > 200 ||
    typeof value.merchantKey !== 'string' ||
    !digest.test(value.merchantKey) ||
    !kinds.includes(value.kind as PlanKind) ||
    !anchor(value.cadence, value.anchorOn, value.calendarAnchor) ||
    (value.expectedAmount !== null &&
      !amount(
        value.expectedAmount,
        value.currency as FinancialAccountCurrency,
      )) ||
    (value.status !== 'ACTIVE' && value.status !== 'ARCHIVED') ||
    !version(value.version) ||
    typeof value.createdAt !== 'string' ||
    !timestamp.test(value.createdAt) ||
    typeof value.updatedAt !== 'string' ||
    !timestamp.test(value.updatedAt)
  )
    return;
  return value as RecurringPlan;
}
function expectation(
  value: unknown,
  currency: FinancialAccountCurrency,
): value is PlanExpectation {
  if (
    !record(value, [
      'latestExpectedOn',
      'latestState',
      'nextExpectedOn',
      'windowFrom',
      'windowTo',
      'matchedCount',
      'observedAmount',
    ])
  )
    return false;
  if (value.latestExpectedOn === null)
    return (
      value.latestState === 'NOT_STARTED' &&
      value.windowFrom === null &&
      value.windowTo === null &&
      value.matchedCount === null &&
      value.observedAmount === null &&
      (value.nextExpectedOn === null || calendarDate(value.nextExpectedOn))
    );
  return (
    calendarDate(value.latestExpectedOn) &&
    (value.nextExpectedOn === null ||
      (calendarDate(value.nextExpectedOn) &&
        value.nextExpectedOn > value.latestExpectedOn)) &&
    calendarDate(value.windowFrom) &&
    calendarDate(value.windowTo) &&
    value.windowFrom <= value.latestExpectedOn &&
    value.windowTo > value.latestExpectedOn &&
    ['OBSERVED', 'AMBIGUOUS', 'AWAITING', 'NOT_OBSERVED'].includes(
      String(value.latestState),
    ) &&
    typeof value.matchedCount === 'string' &&
    count.test(value.matchedCount) &&
    (value.latestState === 'OBSERVED'
      ? value.matchedCount === '1' &&
        derivedAmount(value.observedAmount, currency)
      : value.observedAmount === null &&
        (value.latestState === 'AMBIGUOUS'
          ? BigInt(value.matchedCount) > 1n
          : value.matchedCount === '0'))
  );
}
function evidence(
  value: unknown,
  currency: FinancialAccountCurrency,
  from: string,
  to: string,
): value is InsightEvidenceItem {
  if (
    !record(value, [
      'id',
      'version',
      'kind',
      'occurredOn',
      'money',
      'description',
      'category',
      'refundOfTransactionId',
    ]) ||
    typeof value.id !== 'string' ||
    !uuid.test(value.id) ||
    !version(value.version) ||
    value.kind !== 'EXPENSE' ||
    !calendarDate(value.occurredOn) ||
    value.occurredOn < from ||
    value.occurredOn >= to ||
    !record(value.money, ['amount', 'currency']) ||
    value.money.currency !== currency ||
    typeof value.money.amount !== 'string' ||
    !isSupportedAmountString(value.money.amount, currency) ||
    !value.money.amount.startsWith('-') ||
    typeof value.description !== 'string' ||
    !value.description ||
    (value.category !== null &&
      (typeof value.category !== 'string' ||
        ![
          'HOUSING',
          'GROCERIES',
          'DINING',
          'UTILITIES',
          'TRANSPORTATION',
          'SHOPPING',
          'ENTERTAINMENT',
          'HEALTHCARE',
          'TRAVEL',
          'EDUCATION',
          'PERSONAL',
          'HOUSEHOLD_SUPPLIES',
          'SUBSCRIPTIONS',
          'INCOME',
          'TRANSFERS',
          'MISCELLANEOUS',
        ].includes(value.category))) ||
    value.refundOfTransactionId !== null
  )
    return false;
  return true;
}
function pageItems<T>(
  value: Record<string, unknown>,
  limit: number,
  predicate: (item: unknown) => item is T,
  key: (item: T) => string,
): value is Record<string, unknown> & {
  items: T[];
  nextCursor: string | null;
} {
  if (
    !Array.isArray(value.items) ||
    value.items.length > limit ||
    !cursor(value.nextCursor) ||
    (value.nextCursor !== null && value.items.length !== limit)
  )
    return false;
  const seen = new Set<string>();
  for (const item of value.items) {
    if (!predicate(item) || seen.has(key(item))) return false;
    seen.add(key(item));
  }
  return true;
}
export function parseCandidatePage(
  value: unknown,
  currency: FinancialAccountCurrency,
  review: 'OPEN' | 'DISMISSED' | 'ALL',
  limit: number,
): CandidatePage | undefined {
  if (
    !record(value, [...metadataKeys, 'items', 'nextCursor']) ||
    !meta(value, currency) ||
    !pageItems(
      value,
      limit,
      (item): item is Candidate =>
        candidate(item, currency) &&
        (review === 'ALL' || item.reviewStatus === review),
      (item) => item.merchantKey,
    )
  )
    return;
  return value as CandidatePage;
}
export function parseCandidateEvidence(
  value: unknown,
  currency: FinancialAccountCurrency,
  merchantKey: string,
  limit: number,
): CandidateEvidence | undefined {
  if (
    !record(value, [
      ...metadataKeys,
      'merchantKey',
      'candidate',
      'items',
      'nextCursor',
    ]) ||
    !meta(value, currency) ||
    value.merchantKey !== merchantKey ||
    (value.candidate !== null &&
      (!candidate(value.candidate, currency) ||
        value.candidate.merchantKey !== merchantKey)) ||
    !pageItems(
      value,
      limit,
      (item): item is InsightEvidenceItem =>
        evidence(
          item,
          currency,
          value.evidenceFrom as string,
          value.evidenceTo as string,
        ),
      (item) => item.id,
    )
  )
    return;
  return value as CandidateEvidence;
}
export function parseReview(
  value: unknown,
  merchantKey: string,
  currency: FinancialAccountCurrency,
):
  | {
      merchantKey: string;
      currency: FinancialAccountCurrency;
      reviewStatus: 'OPEN' | 'DISMISSED';
      reviewVersion: number;
    }
  | undefined {
  if (
    !record(value, [
      'merchantKey',
      'currency',
      'reviewStatus',
      'reviewVersion',
    ]) ||
    value.merchantKey !== merchantKey ||
    value.currency !== currency ||
    !['OPEN', 'DISMISSED'].includes(String(value.reviewStatus)) ||
    !version(value.reviewVersion)
  )
    return;
  return value as {
    merchantKey: string;
    currency: FinancialAccountCurrency;
    reviewStatus: 'OPEN' | 'DISMISSED';
    reviewVersion: number;
  };
}
export function parsePlanPage(
  value: unknown,
  householdId: string,
  currency: FinancialAccountCurrency,
  limit: number,
  offset: number,
): PlanPage | undefined {
  if (
    !record(value, ['items', 'limit', 'offset', 'hasMore']) ||
    value.limit !== limit ||
    value.offset !== offset ||
    typeof value.hasMore !== 'boolean' ||
    !Array.isArray(value.items) ||
    value.items.length > limit ||
    !value.items.every((item) =>
      parseRecurringPlan(item, householdId, currency),
    )
  )
    return;
  return value as PlanPage;
}
function projection(
  value: unknown,
  householdId: string,
  currency: FinancialAccountCurrency,
): value is PlanProjection {
  if (!record(value, ['plan', 'expectation'])) return false;
  const plan = parseRecurringPlan(value.plan, householdId, currency);
  return (
    !!plan &&
    plan.status === 'ACTIVE' &&
    expectation(value.expectation, currency)
  );
}
export function parsePlanProjectionPage(
  value: unknown,
  householdId: string,
  currency: FinancialAccountCurrency,
  limit: number,
): PlanProjectionPage | undefined {
  if (
    !record(value, [...metadataKeys, 'items', 'nextCursor']) ||
    !meta(value, currency) ||
    !pageItems(
      value,
      limit,
      (item): item is PlanProjection => projection(item, householdId, currency),
      (item) => item.plan.id,
    )
  )
    return;
  return value as PlanProjectionPage;
}
export function parsePlanObservations(
  value: unknown,
  householdId: string,
  id: string,
  limit: number,
): PlanObservations | undefined {
  if (
    !record(value, [
      ...metadataKeys,
      'plan',
      'expectation',
      'items',
      'nextCursor',
    ])
  )
    return;
  const plan = parseRecurringPlan(value.plan, householdId);
  if (
    !plan ||
    plan.id !== id ||
    !meta(value, plan.currency) ||
    !expectation(value.expectation, plan.currency) ||
    !pageItems(
      value,
      limit,
      (item): item is InsightEvidenceItem =>
        evidence(
          item,
          plan.currency,
          value.evidenceFrom as string,
          value.evidenceTo as string,
        ),
      (item) => item.id,
    )
  )
    return;
  return value as PlanObservations;
}
