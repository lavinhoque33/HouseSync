import {
  isFinancialAccountCurrency,
  isSupportedAmountString,
  isSupportedTransactionDate,
  type FinancialAccountCurrency,
} from './money';

/**
 * Owner-private bank-activity DTOs and exact parsers
 * (docs/architecture/connected-finance-contract.md, section 7). This module
 * is a pure leaf: parsers and request shapes only, no fetch, logging, or
 * storage. Provider identities never cross this boundary; the only IDs here
 * are local HouseSync UUIDs.
 *
 * Reporting rules encoded here:
 * - Only POSTED and UNREVIEWED activity is confirmable; pending, invalid, and
 *   removed rows are private evidence that can never reach the confirmed
 *   ledger.
 * - Amounts stay exact decimal strings at the currency scale, validated with
 *   the shared money rules; no number or parseFloat ever touches them.
 */

export type BankActivityState = 'PENDING' | 'POSTED' | 'REMOVED' | 'INVALID';

export type BankActivityReviewState = 'UNREVIEWED' | 'CONFIRMED' | 'DISMISSED';

export type BankActivityChangeState = 'MODIFIED' | 'REMOVED';

export type BankActivityDismissReason = 'ALREADY_RECORDED' | 'NOT_NEEDED';

export interface BankActivityMoney {
  amount: string;
  currency: FinancialAccountCurrency;
}

export interface BankActivity {
  id: string;
  connectionId: string;
  accountMappingId: string | null;
  localAccountId: string | null;
  state: BankActivityState;
  reviewState: BankActivityReviewState;
  changeState: BankActivityChangeState | null;
  /** Null for removed/invalid rows that never carried usable money facts. */
  money: BankActivityMoney | null;
  occurredOn: string | null;
  authorizedOn: string | null;
  /** Private provider evidence; may be invalid for ledger admission. */
  providerDescription: string | null;
  descriptionValid: boolean;
  pendingPredecessorId: string | null;
  invalidReason: string | null;
  dismissedReason: BankActivityDismissReason | null;
  version: number;
  ledgerTransactionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BankActivityPage {
  items: BankActivity[];
  limit: number;
  offset: number;
  hasMore: boolean;
  /** Owner-only counts; never part of household aggregates. */
  unreviewedCount: number;
  changedCount: number;
}

export interface BankActivityDecision {
  activity: BankActivity;
  transactionId: string | null;
  transactionVersion: number | null;
}

/** Staleness is an application UX threshold, not a provider freshness claim. */
export const SYNC_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BANK_ACTIVITY_KEYS = 19;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isVersion(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 2147483647
  );
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isNullableUuid(value: unknown): value is string | null {
  return value === null || isUuid(value);
}

function isNullableDate(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' && isSupportedTransactionDate(value))
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isState(value: unknown): value is BankActivityState {
  return (
    value === 'PENDING' ||
    value === 'POSTED' ||
    value === 'REMOVED' ||
    value === 'INVALID'
  );
}

function isReviewState(value: unknown): value is BankActivityReviewState {
  return (
    value === 'UNREVIEWED' || value === 'CONFIRMED' || value === 'DISMISSED'
  );
}

function isDismissReason(value: unknown): value is BankActivityDismissReason {
  return value === 'ALREADY_RECORDED' || value === 'NOT_NEEDED';
}

/** Exact money for a confirmable row; null is only legal when facts are absent. */
function parseMoney(value: unknown): BankActivityMoney | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (
    Object.keys(value).length !== 2 ||
    typeof value.amount !== 'string' ||
    !isFinancialAccountCurrency(value.currency)
  ) {
    return undefined;
  }
  if (!isSupportedAmountString(value.amount, value.currency)) {
    return undefined;
  }
  return { amount: value.amount, currency: value.currency };
}

export function parseBankActivity(value: unknown): BankActivity | undefined {
  if (!isRecord(value)) return undefined;
  // The response DTO has exactly these fields; extra or missing keys are
  // contract drift and must fail loudly rather than reach the UI.
  if (
    Object.keys(value).length !== BANK_ACTIVITY_KEYS ||
    !isUuid(value.id) ||
    !isUuid(value.connectionId) ||
    !isNullableUuid(value.accountMappingId) ||
    !isNullableUuid(value.localAccountId) ||
    !isState(value.state) ||
    !isReviewState(value.reviewState) ||
    (value.changeState !== null &&
      value.changeState !== 'MODIFIED' &&
      value.changeState !== 'REMOVED') ||
    !isNullableDate(value.occurredOn) ||
    !isNullableDate(value.authorizedOn) ||
    !isNullableString(value.providerDescription) ||
    typeof value.descriptionValid !== 'boolean' ||
    !isNullableUuid(value.pendingPredecessorId) ||
    !isNullableString(value.invalidReason) ||
    (value.dismissedReason !== null &&
      !isDismissReason(value.dismissedReason)) ||
    !isVersion(value.version) ||
    !isNullableUuid(value.ledgerTransactionId) ||
    !isInstant(value.createdAt) ||
    !isInstant(value.updatedAt)
  ) {
    return undefined;
  }
  const money = parseMoney(value.money);
  if (money === undefined) return undefined;

  // State-dependent invariants: confirmable candidates carry complete facts;
  // change markers only exist on confirmed rows and match their state.
  if (
    (value.state === 'PENDING' || value.state === 'POSTED') &&
    (money === null || value.occurredOn === null)
  ) {
    return undefined;
  }
  if (value.changeState !== null && value.reviewState !== 'CONFIRMED') {
    return undefined;
  }
  if (value.changeState === 'REMOVED' && value.state !== 'REMOVED') {
    return undefined;
  }
  if (value.changeState === 'MODIFIED' && value.state !== 'POSTED') {
    return undefined;
  }
  if (value.reviewState === 'CONFIRMED' && value.ledgerTransactionId === null) {
    return undefined;
  }
  if (value.state === 'INVALID' && value.invalidReason === null) {
    return undefined;
  }
  if (value.reviewState === 'DISMISSED' && value.dismissedReason === null) {
    return undefined;
  }

  return {
    id: value.id,
    connectionId: value.connectionId,
    accountMappingId: value.accountMappingId,
    localAccountId: value.localAccountId,
    state: value.state,
    reviewState: value.reviewState,
    changeState: value.changeState,
    money,
    occurredOn: value.occurredOn,
    authorizedOn: value.authorizedOn,
    providerDescription: value.providerDescription,
    descriptionValid: value.descriptionValid,
    pendingPredecessorId: value.pendingPredecessorId,
    invalidReason: value.invalidReason,
    dismissedReason: value.dismissedReason,
    version: value.version,
    ledgerTransactionId: value.ledgerTransactionId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function parseBankActivityPage(
  value: unknown,
): BankActivityPage | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !Array.isArray(value.items) ||
    typeof value.limit !== 'number' ||
    !Number.isInteger(value.limit) ||
    typeof value.offset !== 'number' ||
    !Number.isInteger(value.offset) ||
    typeof value.hasMore !== 'boolean' ||
    typeof value.unreviewedCount !== 'number' ||
    !Number.isInteger(value.unreviewedCount) ||
    value.unreviewedCount < 0 ||
    typeof value.changedCount !== 'number' ||
    !Number.isInteger(value.changedCount) ||
    value.changedCount < 0
  ) {
    return undefined;
  }
  const items: BankActivity[] = [];
  for (const entry of value.items) {
    const parsed = parseBankActivity(entry);
    if (!parsed) return undefined;
    items.push(parsed);
  }
  return {
    items,
    limit: value.limit,
    offset: value.offset,
    hasMore: value.hasMore,
    unreviewedCount: value.unreviewedCount,
    changedCount: value.changedCount,
  };
}

export function parseBankActivityDecision(
  value: unknown,
): BankActivityDecision | undefined {
  if (!isRecord(value)) return undefined;
  if (
    Object.keys(value).length !== 3 ||
    (value.transactionId !== null && !isUuid(value.transactionId)) ||
    (value.transactionVersion !== null && !isVersion(value.transactionVersion))
  ) {
    return undefined;
  }
  const activity = parseBankActivity(value.activity);
  if (!activity) return undefined;
  return {
    activity,
    transactionId: value.transactionId,
    transactionVersion: value.transactionVersion,
  };
}

/** True when the owner can turn this observation into a ledger entry now. */
export function isConfirmable(activity: BankActivity): boolean {
  return activity.state === 'POSTED' && activity.reviewState === 'UNREVIEWED';
}

/** Any unadmitted observation can be dismissed, including pending rows. */
export function isDismissable(activity: BankActivity): boolean {
  return activity.reviewState !== 'CONFIRMED';
}

/** True when the provider description cannot be used as ledger text. */
export function requiresOwnerDescription(activity: BankActivity): boolean {
  return !activity.descriptionValid || activity.providerDescription === null;
}

/**
 * Client-side staleness from the last successful sync; a never-synced or
 * older-than-24h connection shows the stale indicator. Accepts an injected
 * clock for tests.
 */
export function isSyncStale(
  lastSuccessfulSyncAt: string | null,
  nowMs: number = Date.now(),
): boolean {
  if (lastSuccessfulSyncAt === null) return true;
  const syncedAt = Date.parse(lastSuccessfulSyncAt);
  if (Number.isNaN(syncedAt)) return true;
  return nowMs - syncedAt > SYNC_STALE_AFTER_MS;
}

export interface ConfirmBody {
  expectedVersion: number;
  kind: 'EXPENSE' | 'INCOME' | 'REFUND' | 'TRANSFER';
  description?: string | undefined;
  category?: string | null | undefined;
  refundOfTransactionId?: string | undefined;
  acknowledgeDisclosure?: boolean | undefined;
}

/**
 * Exact confirm body: derived fields (account, money, date, source,
 * visibility) are never sent. The refund source and disclosure
 * acknowledgement only appear for refunds. A refund with no explicit
 * category omits the field entirely so the server inherits the expense's
 * category; an explicit null is never sent for the default state because the
 * backend distinguishes omission (INHERIT) from an explicit value.
 */
export function confirmBankActivityBody(
  body: ConfirmBody,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    expectedVersion: body.expectedVersion,
    kind: body.kind,
  };
  if (body.description !== undefined && body.description.length > 0) {
    payload.description = body.description;
  }
  if (body.kind === 'REFUND') {
    payload.refundOfTransactionId = body.refundOfTransactionId ?? null;
    payload.acknowledgeDisclosure = body.acknowledgeDisclosure === true;
    if (typeof body.category === 'string' && body.category.length > 0) {
      payload.category = body.category;
    }
  } else if (body.category !== undefined) {
    payload.category = body.category;
  }
  return payload;
}

export function dismissBankActivityBody(
  expectedVersion: number,
  reason: BankActivityDismissReason,
): { expectedVersion: number; reason: BankActivityDismissReason } {
  return { expectedVersion, reason };
}

/**
 * In-memory confirm draft. It is keyed by observation id in the component so
 * a background refresh never discards typed text, and it carries one
 * idempotency key for the lifetime of the draft so a retry after a transport
 * failure replays the identical request.
 */
export interface ConfirmDraft {
  activityId: string;
  version: number;
  localAccountId: string | null;
  currency: FinancialAccountCurrency;
  descriptionValid: boolean;
  kind: 'EXPENSE' | 'INCOME' | 'REFUND' | 'TRANSFER';
  description: string;
  category: string;
  refundOfTransactionId: string;
  acknowledgeDisclosure: boolean;
  idempotencyKey: string;
}

export function draftFor(activity: BankActivity): ConfirmDraft {
  return {
    activityId: activity.id,
    version: activity.version,
    localAccountId: activity.localAccountId,
    // Confirmable rows always carry money; the fallback only satisfies typing.
    currency: activity.money?.currency ?? 'USD',
    descriptionValid: activity.descriptionValid,
    kind: 'EXPENSE',
    description: activity.descriptionValid
      ? (activity.providerDescription ?? '')
      : '',
    category: '',
    refundOfTransactionId: '',
    acknowledgeDisclosure: false,
    idempotencyKey: crypto.randomUUID(),
  };
}

export type { FinancialAccountCurrency };
