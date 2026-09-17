import {
  isFinancialAccountCurrency,
  type FinancialAccountCurrency,
} from './money';

/**
 * Owner-scoped connected-finance DTOs
 * (docs/architecture/connected-finance-contract.md, section 7). This module
 * is a pure leaf: exact response parsers and request shapes with no fetch,
 * logging, or storage. The typed fetch functions live in
 * `../auth/client.ts`, which reuses its bounded `apiFetch`, CSRF, and
 * idempotency plumbing.
 *
 * Privacy rules enforced here:
 * - Link and public tokens are ephemeral response values. They are held in
 *   component memory only, never rendered, logged, stored, or placed in a
 *   URL. Parsers validate their shape without retaining them.
 * - Responses carry only local HouseSync IDs. Provider Item, account, and
 *   credential identities never cross this boundary; there is nothing to
 *   parse for them.
 */

export type LinkFlow = 'NEW' | 'UPDATE';

export interface LinkAttempt {
  id: string;
  flow: LinkFlow;
  provider: 'PLAID';
  connectionId: string | null;
  /** Ephemeral browser token: memory only, never rendered or stored. */
  linkToken: string;
  expiresAt: string;
}

export type ConnectionOperationType = 'LINK_COMPLETE' | 'DISCONNECT';

export type ConnectionOperationState =
  'PENDING' | 'SUCCEEDED' | 'FAILED' | 'OUTCOME_UNKNOWN';

export interface ConnectionOperation {
  id: string;
  operationType: ConnectionOperationType;
  state: ConnectionOperationState;
  connectionId: string | null;
  /** Opaque safe backend code (e.g. EXCHANGE_UNKNOWN); never a provider message. */
  errorCode: string | null;
  statusUrl: string;
  createdAt: string;
  updatedAt: string;
}

/** Terminal polling outcomes. OUTCOME_UNKNOWN stays terminal: the UI must
 * preserve it with recovery guidance rather than keep polling or claim
 * failure. */
export const TERMINAL_OPERATION_STATES: readonly ConnectionOperationState[] = [
  'SUCCEEDED',
  'FAILED',
  'OUTCOME_UNKNOWN',
];

export function isTerminalOperationState(
  state: ConnectionOperationState,
): boolean {
  return (
    state === 'SUCCEEDED' || state === 'FAILED' || state === 'OUTCOME_UNKNOWN'
  );
}

/**
 * True once a link attempt can no longer be opened or resumed. The backend
 * also rejects expired attempts, but the web client must never open the
 * provider step with one: expiry clears the in-memory attempt and directs
 * the viewer to start over. Accepts an injected clock for tests.
 */
export function isLinkAttemptExpired(
  attempt: LinkAttempt,
  nowMs: number = Date.now(),
): boolean {
  const expires = Date.parse(attempt.expiresAt);
  return Number.isNaN(expires) || expires <= nowMs;
}

export type FinancialConnectionState =
  | 'LINKING'
  | 'ACTIVE'
  | 'REAUTH_REQUIRED'
  | 'SUSPENDED'
  | 'DISCONNECTING'
  | 'DISCONNECTED'
  | 'ERROR';

export interface FinancialConnection {
  id: string;
  householdId: string;
  provider: 'PLAID';
  environment: 'SANDBOX' | 'PRODUCTION';
  state: FinancialConnectionState;
  generation: number;
  version: number;
  lastSuccessfulSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FinancialConnectionPage {
  items: FinancialConnection[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

/** Only ACTIVE and REAUTH_REQUIRED connections may start update-mode
 * reconnect; every other state needs cleanup and a fresh link. */
export function canReconnect(state: FinancialConnectionState): boolean {
  return state === 'ACTIVE' || state === 'REAUTH_REQUIRED';
}

export type ConnectedAccountKind = 'CHECKING' | 'SAVINGS' | 'CREDIT_CARD';

export interface ConnectionAccountMapping {
  mappingId: string;
  localAccountId: string | null;
  name: string;
  /**
   * Null exactly when the provider account is ineligible (see `eligible`
   * and `exclusionReason`): the backend keeps a null classification with
   * an explicit reason instead of a fabricated fallback.
   */
  kind: ConnectedAccountKind | null;
  /** Null under the same ineligibility contract as `kind`. */
  currency: FinancialAccountCurrency | null;
  selected: boolean;
  eligible: boolean;
  exclusionReason: string | null;
}

export interface ConnectionAccountMappingPage {
  items: ConnectionAccountMapping[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface SelectedConnectedAccount {
  id: string;
  name: string;
  kind: ConnectedAccountKind;
  currency: FinancialAccountCurrency;
  source: 'CONNECTED';
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
}

export interface AccountSelectionResult {
  connectionId: string;
  version: number;
  accounts: SelectedConnectedAccount[];
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInstantString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isVersionNumber(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 2147483647
  );
}

function isLinkFlow(value: unknown): value is LinkFlow {
  return value === 'NEW' || value === 'UPDATE';
}

function isOperationType(value: unknown): value is ConnectionOperationType {
  return value === 'LINK_COMPLETE' || value === 'DISCONNECT';
}

function isOperationState(value: unknown): value is ConnectionOperationState {
  return (
    value === 'PENDING' ||
    value === 'SUCCEEDED' ||
    value === 'FAILED' ||
    value === 'OUTCOME_UNKNOWN'
  );
}

function isConnectionState(value: unknown): value is FinancialConnectionState {
  return (
    value === 'LINKING' ||
    value === 'ACTIVE' ||
    value === 'REAUTH_REQUIRED' ||
    value === 'SUSPENDED' ||
    value === 'DISCONNECTING' ||
    value === 'DISCONNECTED' ||
    value === 'ERROR'
  );
}

function isConnectedAccountKind(value: unknown): value is ConnectedAccountKind {
  // Cash has no provider representation: the backend never admits it, so a
  // CASH row is a contract drift and must fail parsing loudly.
  return value === 'CHECKING' || value === 'SAVINGS' || value === 'CREDIT_CARD';
}

export function parseLinkAttempt(value: unknown): LinkAttempt | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isUuid(value.id) ||
    !isLinkFlow(value.flow) ||
    value.provider !== 'PLAID' ||
    (value.connectionId !== null && !isUuid(value.connectionId)) ||
    typeof value.linkToken !== 'string' ||
    value.linkToken.length === 0 ||
    !isInstantString(value.expiresAt)
  ) {
    return undefined;
  }
  return {
    id: value.id,
    flow: value.flow,
    provider: 'PLAID',
    connectionId: value.connectionId,
    linkToken: value.linkToken,
    expiresAt: value.expiresAt,
  };
}

export function parseConnectionOperation(
  value: unknown,
): ConnectionOperation | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isUuid(value.id) ||
    !isOperationType(value.operationType) ||
    !isOperationState(value.state) ||
    (value.connectionId !== null && !isUuid(value.connectionId)) ||
    (value.errorCode !== null && typeof value.errorCode !== 'string') ||
    typeof value.statusUrl !== 'string' ||
    !value.statusUrl.startsWith('/api/households/') ||
    !isInstantString(value.createdAt) ||
    !isInstantString(value.updatedAt)
  ) {
    return undefined;
  }
  return {
    id: value.id,
    operationType: value.operationType,
    state: value.state,
    connectionId: value.connectionId,
    errorCode: value.errorCode,
    statusUrl: value.statusUrl,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function parseFinancialConnection(
  value: unknown,
): FinancialConnection | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isUuid(value.id) ||
    !isUuid(value.householdId) ||
    value.provider !== 'PLAID' ||
    (value.environment !== 'SANDBOX' && value.environment !== 'PRODUCTION') ||
    !isConnectionState(value.state) ||
    typeof value.generation !== 'number' ||
    !Number.isInteger(value.generation) ||
    value.generation < 0 ||
    !isVersionNumber(value.version) ||
    (value.lastSuccessfulSyncAt !== null &&
      !isInstantString(value.lastSuccessfulSyncAt)) ||
    !isInstantString(value.createdAt) ||
    !isInstantString(value.updatedAt)
  ) {
    return undefined;
  }
  return {
    id: value.id,
    householdId: value.householdId,
    provider: 'PLAID',
    environment: value.environment,
    state: value.state,
    generation: value.generation,
    version: value.version,
    lastSuccessfulSyncAt: value.lastSuccessfulSyncAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function parseFinancialConnectionPage(
  value: unknown,
): FinancialConnectionPage | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !Array.isArray(value.items) ||
    typeof value.limit !== 'number' ||
    !Number.isInteger(value.limit) ||
    typeof value.offset !== 'number' ||
    !Number.isInteger(value.offset) ||
    typeof value.hasMore !== 'boolean'
  ) {
    return undefined;
  }
  const items: FinancialConnection[] = [];
  for (const entry of value.items) {
    const parsed = parseFinancialConnection(entry);
    if (!parsed) return undefined;
    items.push(parsed);
  }
  return {
    items,
    limit: value.limit,
    offset: value.offset,
    hasMore: value.hasMore,
  };
}

export function parseConnectionAccountMapping(
  value: unknown,
): ConnectionAccountMapping | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isUuid(value.mappingId) ||
    (value.localAccountId !== null && !isUuid(value.localAccountId)) ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    (value.kind !== null && !isConnectedAccountKind(value.kind)) ||
    (value.currency !== null && !isFinancialAccountCurrency(value.currency)) ||
    typeof value.selected !== 'boolean' ||
    typeof value.eligible !== 'boolean' ||
    (value.exclusionReason !== null &&
      typeof value.exclusionReason !== 'string')
  ) {
    return undefined;
  }
  if (value.eligible) {
    // Eligible rows carry a complete classification and no reason; anything
    // else contradicts the backend contract and fails loudly.
    if (
      !isConnectedAccountKind(value.kind) ||
      !isFinancialAccountCurrency(value.currency) ||
      value.exclusionReason !== null
    ) {
      return undefined;
    }
  } else {
    // Ineligible rows keep a null classification with an explicit reason:
    // at least one of kind/currency is null and the reason is non-blank.
    // A fully classified row claiming ineligibility is equally invalid.
    if (
      (value.kind !== null && value.currency !== null) ||
      typeof value.exclusionReason !== 'string' ||
      value.exclusionReason.trim().length === 0
    ) {
      return undefined;
    }
  }
  return {
    mappingId: value.mappingId,
    localAccountId: value.localAccountId,
    name: value.name,
    kind: value.kind,
    currency: value.currency,
    selected: value.selected,
    eligible: value.eligible,
    exclusionReason: value.exclusionReason,
  };
}

export function parseConnectionAccountMappingPage(
  value: unknown,
): ConnectionAccountMappingPage | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !Array.isArray(value.items) ||
    typeof value.limit !== 'number' ||
    !Number.isInteger(value.limit) ||
    typeof value.offset !== 'number' ||
    !Number.isInteger(value.offset) ||
    typeof value.hasMore !== 'boolean'
  ) {
    return undefined;
  }
  const items: ConnectionAccountMapping[] = [];
  for (const entry of value.items) {
    const parsed = parseConnectionAccountMapping(entry);
    if (!parsed) return undefined;
    items.push(parsed);
  }
  return {
    items,
    limit: value.limit,
    offset: value.offset,
    hasMore: value.hasMore,
  };
}

export function parseAccountSelectionResult(
  value: unknown,
): AccountSelectionResult | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isUuid(value.connectionId) ||
    !isVersionNumber(value.version) ||
    !Array.isArray(value.accounts)
  ) {
    return undefined;
  }
  const accounts: SelectedConnectedAccount[] = [];
  for (const entry of value.accounts) {
    if (!isRecord(entry)) return undefined;
    if (
      !isUuid(entry.id) ||
      typeof entry.name !== 'string' ||
      entry.name.length === 0 ||
      !isConnectedAccountKind(entry.kind) ||
      !isFinancialAccountCurrency(entry.currency) ||
      entry.source !== 'CONNECTED' ||
      (entry.status !== 'ACTIVE' && entry.status !== 'ARCHIVED') ||
      !isVersionNumber(entry.version)
    ) {
      return undefined;
    }
    accounts.push({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      currency: entry.currency,
      source: 'CONNECTED',
      status: entry.status,
      version: entry.version,
    });
  }
  return {
    connectionId: value.connectionId,
    version: value.version,
    accounts,
  };
}

/** Exact request bodies for the versioned connection POSTs. */
export function accountSelectionBody(
  expectedVersion: number,
  accountMappingIds: string[],
): { expectedVersion: number; accountMappingIds: string[] } {
  return { expectedVersion, accountMappingIds };
}

export function expectedVersionBody(expectedVersion: number): {
  expectedVersion: number;
} {
  return { expectedVersion };
}

export function completeNewLinkBody(publicToken: string): {
  publicToken: string;
} {
  return { publicToken };
}
