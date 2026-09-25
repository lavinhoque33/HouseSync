import {
  isAggregateAmountString,
  isFinancialAccountCurrency,
  isSupportedAmountString,
  isSupportedTransactionDate,
  type FinancialAccountCurrency,
} from './money';

export type RepaymentStatus =
  'PENDING' | 'CONFIRMED' | 'REJECTED' | 'CANCELLED' | 'VOIDED';
export type RepaymentDecision = 'CONFIRM' | 'REJECT' | 'CANCEL';
export type RepaymentAction =
  | 'CONFIRM'
  | 'REJECT'
  | 'CANCEL'
  | 'PROPOSE_REPLACEMENT'
  | 'PROPOSE_VOID'
  | 'CONFIRM_AMENDMENT'
  | 'REJECT_AMENDMENT'
  | 'CANCEL_AMENDMENT';
export interface RepaymentMoney {
  amount: string;
  currency: FinancialAccountCurrency;
}
export interface RepaymentAmendment {
  action: 'REPLACE' | 'VOID';
  proposedByUserId: string;
  money: RepaymentMoney | null;
  occurredOn: string | null;
  createdAt: string;
}
export interface Repayment {
  id: string;
  householdId: string;
  senderUserId: string;
  recipientUserId: string;
  money: RepaymentMoney;
  occurredOn: string;
  status: RepaymentStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  voidedAt: string | null;
  pendingAmendment: RepaymentAmendment | null;
  allowedActions: RepaymentAction[];
}
export interface RepaymentEvent {
  version: number;
  eventType:
    | 'CREATED'
    | 'CONFIRMED'
    | 'REJECTED'
    | 'CANCELLED'
    | 'AMENDMENT_PROPOSED'
    | 'AMENDMENT_CONFIRMED'
    | 'AMENDMENT_REJECTED'
    | 'AMENDMENT_CANCELLED';
  actorUserId: string;
  recordedAt: string;
  status: RepaymentStatus;
  money: RepaymentMoney;
  occurredOn: string;
  pendingAmendment: RepaymentAmendment | null;
}
export interface RepaymentPage<T> {
  items: T[];
  limit: number;
  offset: number;
  hasMore: boolean;
}
export interface SettlementSuggestion {
  senderUserId: string;
  recipientUserId: string;
  money: RepaymentMoney;
}
export interface SettlementSuggestions {
  currency: FinancialAccountCurrency;
  snapshot: string;
  items: SettlementSuggestion[];
  nextCursor: string | null;
  residuals: {
    currentDebtAfterPlan: string;
    currentCreditAfterPlan: string;
    departedDebt: string;
    departedCredit: string;
  };
}
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const ACTIONS: RepaymentAction[] = [
  'CONFIRM',
  'REJECT',
  'CANCEL',
  'PROPOSE_REPLACEMENT',
  'PROPOSE_VOID',
  'CONFIRM_AMENDMENT',
  'REJECT_AMENDMENT',
  'CANCEL_AMENDMENT',
];
const STATUSES: RepaymentStatus[] = [
  'PENDING',
  'CONFIRMED',
  'REJECTED',
  'CANCELLED',
  'VOIDED',
];
const EVENTS: RepaymentEvent['eventType'][] = [
  'CREATED',
  'CONFIRMED',
  'REJECTED',
  'CANCELLED',
  'AMENDMENT_PROPOSED',
  'AMENDMENT_CONFIRMED',
  'AMENDMENT_REJECTED',
  'AMENDMENT_CANCELLED',
];
function object(
  value: unknown,
  keys: string[],
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === keys.length &&
    keys.every((key) => Object.hasOwn(record, key))
    ? record
    : null;
}
function id(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
function instant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    INSTANT.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}
function date(value: unknown): value is string {
  return typeof value === 'string' && isSupportedTransactionDate(value);
}
function status(value: unknown): value is RepaymentStatus {
  return STATUSES.includes(value as RepaymentStatus);
}
function money(value: unknown, aggregate = false): RepaymentMoney | null {
  const r = object(value, ['amount', 'currency']);
  if (
    !r ||
    !isFinancialAccountCurrency(r.currency) ||
    typeof r.amount !== 'string' ||
    !(aggregate
      ? isAggregateAmountString(r.amount, r.currency) &&
        !r.amount.startsWith('-')
      : isSupportedAmountString(r.amount, r.currency) &&
        !r.amount.startsWith('-'))
  )
    return null;
  return { amount: r.amount, currency: r.currency };
}
function amendment(
  value: unknown,
  currency: FinancialAccountCurrency,
): RepaymentAmendment | null | undefined {
  if (value === null) return null;
  const r = object(value, [
    'action',
    'proposedByUserId',
    'money',
    'occurredOn',
    'createdAt',
  ]);
  if (
    !r ||
    (r.action !== 'VOID' && r.action !== 'REPLACE') ||
    !id(r.proposedByUserId) ||
    !instant(r.createdAt)
  )
    return undefined;
  const proposed = r.action === 'VOID' ? null : money(r.money);
  if (
    r.action === 'VOID'
      ? r.money !== null || r.occurredOn !== null
      : !proposed || proposed.currency !== currency || !date(r.occurredOn)
  )
    return undefined;
  return {
    action: r.action,
    proposedByUserId: r.proposedByUserId,
    money: proposed,
    occurredOn: r.action === 'VOID' ? null : (r.occurredOn as string),
    createdAt: r.createdAt,
  };
}
export function parseRepayment(value: unknown): Repayment | null {
  const r = object(value, [
    'id',
    'householdId',
    'senderUserId',
    'recipientUserId',
    'money',
    'occurredOn',
    'status',
    'version',
    'createdAt',
    'updatedAt',
    'confirmedAt',
    'voidedAt',
    'pendingAmendment',
    'allowedActions',
  ]);
  if (
    !r ||
    !id(r.id) ||
    !id(r.householdId) ||
    !id(r.senderUserId) ||
    !id(r.recipientUserId) ||
    r.senderUserId === r.recipientUserId ||
    !date(r.occurredOn) ||
    !status(r.status) ||
    !Number.isInteger(r.version) ||
    (r.version as number) < 0 ||
    (r.version as number) > 2147483647 ||
    !instant(r.createdAt) ||
    !instant(r.updatedAt) ||
    !(r.confirmedAt === null || instant(r.confirmedAt)) ||
    !(r.voidedAt === null || instant(r.voidedAt)) ||
    !Array.isArray(r.allowedActions)
  )
    return null;
  const amount = money(r.money);
  if (!amount) return null;
  const pending = amendment(r.pendingAmendment, amount.currency);
  if (
    pending === undefined ||
    (pending !== null && r.status !== 'CONFIRMED') ||
    (r.status === 'PENDING' &&
      (r.confirmedAt !== null || r.voidedAt !== null)) ||
    ((r.status === 'REJECTED' || r.status === 'CANCELLED') &&
      (r.confirmedAt !== null || r.voidedAt !== null)) ||
    ((r.status === 'CONFIRMED' || r.status === 'VOIDED') &&
      r.confirmedAt === null) ||
    (r.status === 'VOIDED' ? r.voidedAt === null : r.voidedAt !== null)
  )
    return null;
  let previous = -1;
  for (const action of r.allowedActions) {
    const index = ACTIONS.indexOf(action);
    if (index <= previous) return null;
    previous = index;
  }
  return {
    id: r.id,
    householdId: r.householdId,
    senderUserId: r.senderUserId,
    recipientUserId: r.recipientUserId,
    money: amount,
    occurredOn: r.occurredOn,
    status: r.status,
    version: r.version as number,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    confirmedAt: r.confirmedAt as string | null,
    voidedAt: r.voidedAt as string | null,
    pendingAmendment: pending,
    allowedActions: r.allowedActions as RepaymentAction[],
  };
}
export function parseRepaymentEvent(value: unknown): RepaymentEvent | null {
  const r = object(value, [
    'version',
    'eventType',
    'actorUserId',
    'recordedAt',
    'status',
    'money',
    'occurredOn',
    'pendingAmendment',
  ]);
  if (
    !r ||
    !Number.isInteger(r.version) ||
    (r.version as number) < 0 ||
    (r.version as number) > 2147483647 ||
    !EVENTS.includes(r.eventType as RepaymentEvent['eventType']) ||
    !id(r.actorUserId) ||
    !instant(r.recordedAt) ||
    !status(r.status) ||
    !date(r.occurredOn)
  )
    return null;
  const amount = money(r.money);
  if (!amount) return null;
  const pending = amendment(r.pendingAmendment, amount.currency);
  if (pending === undefined) return null;
  if (
    r.eventType === 'CREATED' &&
    (r.version !== 0 || r.status !== 'PENDING' || pending !== null)
  )
    return null;
  if (
    (r.eventType === 'CONFIRMED' ||
      r.eventType === 'AMENDMENT_PROPOSED' ||
      r.eventType === 'AMENDMENT_REJECTED' ||
      r.eventType === 'AMENDMENT_CANCELLED') &&
    r.status !== 'CONFIRMED'
  )
    return null;
  if (r.eventType === 'REJECTED' && r.status !== 'REJECTED') return null;
  if (r.eventType === 'CANCELLED' && r.status !== 'CANCELLED') return null;
  if (
    r.eventType === 'AMENDMENT_CONFIRMED' &&
    r.status !== 'CONFIRMED' &&
    r.status !== 'VOIDED'
  )
    return null;
  if (
    r.eventType === 'AMENDMENT_PROPOSED' ? pending === null : pending !== null
  )
    return null;
  return {
    version: r.version as number,
    eventType: r.eventType as RepaymentEvent['eventType'],
    actorUserId: r.actorUserId,
    recordedAt: r.recordedAt,
    status: r.status,
    money: amount,
    occurredOn: r.occurredOn,
    pendingAmendment: pending,
  };
}
export function parseRepaymentPage<T>(
  value: unknown,
  parse: (item: unknown) => T | null,
): RepaymentPage<T> | null {
  const r = object(value, ['items', 'limit', 'offset', 'hasMore']);
  if (
    !r ||
    !Array.isArray(r.items) ||
    !Number.isInteger(r.limit) ||
    (r.limit as number) < 1 ||
    (r.limit as number) > 100 ||
    !Number.isInteger(r.offset) ||
    (r.offset as number) < 0 ||
    (r.offset as number) > 10000 ||
    typeof r.hasMore !== 'boolean' ||
    r.items.length > (r.limit as number)
  )
    return null;
  const items = r.items.map(parse);
  return items.some((item) => item === null)
    ? null
    : {
        items: items as T[],
        limit: r.limit as number,
        offset: r.offset as number,
        hasMore: r.hasMore,
      };
}
export function parseSettlementSuggestions(
  value: unknown,
  currency: FinancialAccountCurrency,
): SettlementSuggestions | null {
  const r = object(value, [
    'currency',
    'snapshot',
    'items',
    'nextCursor',
    'residuals',
  ]);
  if (
    !r ||
    r.currency !== currency ||
    typeof r.snapshot !== 'string' ||
    !/^[0-9a-f]{64}$/.test(r.snapshot) ||
    !Array.isArray(r.items) ||
    r.items.length > 100 ||
    !(
      r.nextCursor === null ||
      (typeof r.nextCursor === 'string' &&
        r.nextCursor.length > 0 &&
        r.nextCursor.length <= 1024)
    )
  )
    return null;
  const residuals = object(r.residuals, [
    'currentDebtAfterPlan',
    'currentCreditAfterPlan',
    'departedDebt',
    'departedCredit',
  ]);
  if (
    !residuals ||
    Object.values(residuals).some(
      (v) =>
        typeof v !== 'string' ||
        !isAggregateAmountString(v, currency) ||
        v.startsWith('-'),
    )
  )
    return null;
  const items: SettlementSuggestion[] = [];
  for (const item of r.items) {
    const edge = object(item, ['senderUserId', 'recipientUserId', 'money']);
    const amount = edge && money(edge.money, true);
    if (
      !edge ||
      !id(edge.senderUserId) ||
      !id(edge.recipientUserId) ||
      edge.senderUserId === edge.recipientUserId ||
      !amount ||
      amount.currency !== currency ||
      /^0(?:\.0+)?$/.test(amount.amount)
    )
      return null;
    items.push({
      senderUserId: edge.senderUserId,
      recipientUserId: edge.recipientUserId,
      money: amount,
    });
  }
  return {
    currency,
    snapshot: r.snapshot,
    items,
    nextCursor: r.nextCursor as string | null,
    residuals: residuals as unknown as SettlementSuggestions['residuals'],
  };
}
