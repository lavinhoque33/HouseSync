import {
  isAggregateAmountString,
  isFinancialAccountCurrency,
  isSupportedAmountString,
  isSupportedTransactionDate,
  minorUnitsOfMagnitude,
  type FinancialAccountCurrency,
} from '../finance/money';
import {
  parseAccountSelectionResult,
  parseConnectionAccountMappingPage,
  parseConnectionOperation,
  parseFinancialConnection,
  parseFinancialConnectionPage,
  parseLinkAttempt,
  type AccountSelectionResult,
  type ConnectionAccountMappingPage,
  type ConnectionOperation,
  type FinancialConnection,
  type FinancialConnectionPage,
  type LinkAttempt,
} from '../finance/connections';
import {
  confirmBankActivityBody,
  dismissBankActivityBody,
  parseBankActivity,
  parseBankActivityDecision,
  parseBankActivityPage,
  replaceBankActivityBody,
  resolveBankActivityBody,
  type BankActivity,
  type BankActivityDecision,
  type BankActivityDismissReason,
  type BankActivityPage,
  type ConfirmBody,
  type ReplaceBody,
  type ResolveBody,
} from '../finance/bank-activity';
import { isRegionShapedZone } from '../finance/reporting';

export type { FinancialAccountCurrency } from '../finance/money';

export interface SafeUser {
  id: string;
  email: string;
}

export interface CsrfToken {
  token: string;
  headerName: string;
}

export interface ApiFieldErrors {
  [field: string]: string;
}

export type ApiErrorCode =
  | 'VALIDATION_FAILED'
  | 'INVALID_CREDENTIALS'
  | 'UNAUTHENTICATED'
  | 'CSRF_INVALID'
  | 'FORBIDDEN'
  | 'REGISTRATION_CONFLICT'
  | 'RATE_LIMITED'
  | 'HOUSEHOLD_NOT_FOUND'
  | 'INVITATION_NOT_FOUND'
  | 'MEMBERSHIP_NOT_FOUND'
  | 'LAST_OWNER_REQUIRED'
  | 'FINANCIAL_ACCOUNT_NOT_FOUND'
  | 'FINANCIAL_CONNECTION_NOT_FOUND'
  | 'LINK_ATTEMPT_EXPIRED'
  | 'CONNECTION_NOT_READY'
  | 'CONNECTION_DISCONNECTED'
  | 'CONNECTED_FINANCE_DISABLED'
  | 'TRANSACTION_NOT_FOUND'
  | 'ACCOUNT_ARCHIVED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RESOURCE_VERSION_CONFLICT'
  | 'RESOURCE_VERSION_EXHAUSTED'
  | 'REFUND_CONFLICT'
  | 'TRANSACTION_VOIDED'
  | 'CATEGORY_RULE_NOT_FOUND'
  | 'CATEGORY_RULE_CONFLICT'
  | 'ALLOCATION_NOT_FOUND'
  | 'ALLOCATION_CONFLICT'
  | 'FINANCE_BUSY'
  | 'BANK_ACTIVITY_NOT_FOUND'
  | 'OBSERVATION_NOT_POSTED'
  | 'OBSERVATION_ALREADY_CONFIRMED'
  | 'OBSERVATION_INVALID'
  | 'OBSERVATION_DISMISSED'
  | 'OBSERVATION_ADMITTED'
  | 'RECONCILIATION_REQUIRED'
  | 'MANUAL_SYNC_RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'NETWORK_ERROR'
  | 'UNKNOWN_ERROR';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly fieldErrors: ApiFieldErrors | undefined;
  readonly correlationId: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly timedOut: boolean;

  constructor(options: {
    status: number;
    code: ApiErrorCode;
    message: string;
    fieldErrors?: ApiFieldErrors | undefined;
    correlationId?: string | undefined;
    retryAfterSeconds?: number | undefined;
    timedOut?: boolean | undefined;
  }) {
    super(options.message);
    this.name = 'ApiError';
    this.status = options.status;
    this.code = options.code;
    this.fieldErrors = options.fieldErrors;
    this.correlationId = options.correlationId;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.timedOut = options.timedOut ?? false;
  }
}

interface ErrorBody {
  code?: unknown;
  message?: unknown;
  correlationId?: unknown;
  fieldErrors?: unknown;
}

function knownCode(value: unknown): ApiErrorCode | undefined {
  if (typeof value !== 'string') return undefined;
  const codes: ApiErrorCode[] = [
    'VALIDATION_FAILED',
    'INVALID_CREDENTIALS',
    'UNAUTHENTICATED',
    'CSRF_INVALID',
    'FORBIDDEN',
    'REGISTRATION_CONFLICT',
    'RATE_LIMITED',
    'HOUSEHOLD_NOT_FOUND',
    'INVITATION_NOT_FOUND',
    'MEMBERSHIP_NOT_FOUND',
    'LAST_OWNER_REQUIRED',
    'FINANCIAL_ACCOUNT_NOT_FOUND',
    'FINANCIAL_CONNECTION_NOT_FOUND',
    'LINK_ATTEMPT_EXPIRED',
    'CONNECTION_NOT_READY',
    'CONNECTION_DISCONNECTED',
    'CONNECTED_FINANCE_DISABLED',
    'TRANSACTION_NOT_FOUND',
    'ACCOUNT_ARCHIVED',
    'IDEMPOTENCY_CONFLICT',
    'RESOURCE_VERSION_CONFLICT',
    'RESOURCE_VERSION_EXHAUSTED',
    'REFUND_CONFLICT',
    'TRANSACTION_VOIDED',
    'CATEGORY_RULE_NOT_FOUND',
    'CATEGORY_RULE_CONFLICT',
    'ALLOCATION_NOT_FOUND',
    'ALLOCATION_CONFLICT',
    'FINANCE_BUSY',
    'BANK_ACTIVITY_NOT_FOUND',
    'OBSERVATION_NOT_POSTED',
    'OBSERVATION_ALREADY_CONFIRMED',
    'OBSERVATION_INVALID',
    'OBSERVATION_DISMISSED',
    'OBSERVATION_ADMITTED',
    'RECONCILIATION_REQUIRED',
    'MANUAL_SYNC_RATE_LIMITED',
    'INTERNAL_ERROR',
  ];
  return codes.includes(value as ApiErrorCode)
    ? (value as ApiErrorCode)
    : undefined;
}

function safeFieldErrors(value: unknown): ApiFieldErrors | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const result: ApiFieldErrors = {};
  for (const [key, message] of entries) {
    if (
      (key === 'email' ||
        key === 'password' ||
        key === 'confirmPassword' ||
        key === 'name' ||
        key === 'invitationId' ||
        key === 'secret' ||
        key === 'role' ||
        key === 'kind' ||
        key === 'currency' ||
        key === 'status' ||
        key === 'expectedVersion' ||
        key === 'expectedTransactionVersion' ||
        key === 'expectedLedgerVersion' ||
        key === 'action' ||
        key === 'fields' ||
        key === 'acknowledgeAllocationRemoval' ||
        key === 'idempotencyKey' ||
        key === 'limit' ||
        key === 'offset' ||
        key === 'query' ||
        key === 'account' ||
        key === 'accountId' ||
        key === 'occurredOn' ||
        key === 'description' ||
        key === 'visibility' ||
        key === 'category' ||
        key === 'view' ||
        key === 'refundOfTransactionId' ||
        key === 'participantUserIds' ||
        key === 'reportingTimeZone' ||
        key === 'from' ||
        key === 'to' ||
        key === 'money.amount' ||
        key === 'money.currency' ||
        key === 'acknowledgeDisclosure' ||
        key === 'reason' ||
        key === 'state' ||
        key === 'review' ||
        key === 'connectionId') &&
      typeof message === 'string'
    ) {
      result[key] = message;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export async function parseErrorResponse(
  response: BodySource,
  fallbackCode: ApiErrorCode,
  fallbackMessage: string,
): Promise<ApiError> {
  let body: ErrorBody = {};
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === 'object' && parsed !== null) {
      body = parsed as ErrorBody;
    }
  } catch {
    body = {};
  }
  const retryHeader = response.headers.get('Retry-After');
  const retryAfterSeconds =
    response.status === 429 && retryHeader !== null
      ? Number.parseInt(retryHeader, 10)
      : undefined;
  return new ApiError({
    status: response.status,
    code: knownCode(body.code) ?? fallbackCode,
    message:
      typeof body.message === 'string' && body.message.length > 0
        ? body.message
        : fallbackMessage,
    fieldErrors: safeFieldErrors(body.fieldErrors),
    correlationId:
      typeof body.correlationId === 'string' ? body.correlationId : undefined,
    retryAfterSeconds:
      typeof retryAfterSeconds === 'number' &&
      Number.isFinite(retryAfterSeconds) &&
      retryAfterSeconds >= 0
        ? retryAfterSeconds
        : undefined,
  });
}

export function toNetworkError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ApiError({
      status: 0,
      code: 'UNKNOWN_ERROR',
      message: 'Request was cancelled.',
    });
  }
  return new ApiError({
    status: 0,
    code: 'NETWORK_ERROR',
    message: 'Could not reach the server. Check your connection and retry.',
  });
}

const JSON_HEADERS = { Accept: 'application/json' } as const;

/** Bounded wait for any auth request so controls can never hang forever. */
export const AUTH_TIMEOUT_MS = 10_000;

function timeoutError(): ApiError {
  return new ApiError({
    status: 0,
    code: 'NETWORK_ERROR',
    message:
      'The request timed out before completing. Its outcome is unknown — wait a moment and retry.',
    timedOut: true,
  });
}

async function apiFetch(
  input: string,
  init: RequestInit,
  parentSignal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<BufferedBody> {
  const controller = new AbortController();
  const state = { timedOut: false };
  const onParentAbort = () => {
    controller.abort();
  };
  // The deadline starts with the request and stays armed through body
  // buffering, so a stalled body cannot outlive the bounded wait.
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (parentSignal) {
    if (parentSignal.aborted) {
      clearTimeout(timer);
      throw toNetworkError(new DOMException('Aborted.', 'AbortError'));
    }
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const finish = () => {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  };
  let response: Response;
  try {
    response = await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    finish();
    if (state.timedOut) throw timeoutError();
    throw toNetworkError(error);
  }
  try {
    // 204 responses are bodyless by contract; anything else is buffered as
    // text while the deadline and linked cancellation stay armed.
    const text =
      response.status === 204
        ? ''
        : await settleWhileArmed(response.text(), controller, state);
    finish();
    return bufferedBody(response, text);
  } catch (error) {
    finish();
    if (state.timedOut) throw timeoutError();
    if (error instanceof ApiError) throw error;
    throw toNetworkError(error);
  }
}

function abortRejection(state: { timedOut: boolean }): Error {
  if (state.timedOut) return timeoutError();
  return toNetworkError(new DOMException('Aborted.', 'AbortError'));
}

// Settles a body promise under the armed deadline: a body that never
// resolves on its own is still rejected when the linked controller aborts.
function settleWhileArmed<T>(
  promise: Promise<T>,
  controller: AbortController,
  state: { timedOut: boolean },
): Promise<T> {
  if (controller.signal.aborted) return Promise.reject(abortRejection(state));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortRejection(state));
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        controller.signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        controller.signal.removeEventListener('abort', onAbort);
        reject(state.timedOut ? timeoutError() : error);
      },
    );
  });
}

export interface BufferedBody {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

function bufferedBody(response: Response, text: string): BufferedBody {
  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    text: () => Promise.resolve(text),
    json: () =>
      (async () => {
        if (text.length === 0) {
          throw new SyntaxError('Empty response body.');
        }
        return JSON.parse(text) as unknown;
      })(),
  };
}

interface BodySource {
  readonly status: number;
  readonly headers: Headers;
  json(): Promise<unknown>;
}

async function readJson<T>(response: BodySource): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError({
      status: response.status,
      code: 'UNKNOWN_ERROR',
      message: 'The server returned an unexpected response.',
    });
  }
}

export async function fetchCsrf(
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<CsrfToken> {
  const response = await apiFetch(
    '/api/auth/csrf',
    {
      method: 'GET',
      credentials: 'include',
      headers: { ...JSON_HEADERS },
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (!response.ok) {
    throw await parseErrorResponse(
      response,
      'UNKNOWN_ERROR',
      'Could not prepare a secure request. Retry before signing in.',
    );
  }
  const body = await readJson<{ token?: unknown; headerName?: unknown }>(
    response,
  );
  if (typeof body.token !== 'string' || body.token.length === 0) {
    throw new ApiError({
      status: response.status,
      code: 'UNKNOWN_ERROR',
      message: 'The server returned an unexpected response.',
    });
  }
  return {
    token: body.token,
    headerName:
      typeof body.headerName === 'string' && body.headerName.length > 0
        ? body.headerName
        : 'X-CSRF-TOKEN',
  };
}

export async function fetchMe(
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<SafeUser> {
  const response = await apiFetch(
    '/api/auth/me',
    {
      method: 'GET',
      credentials: 'include',
      headers: { ...JSON_HEADERS },
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (response.status === 401) {
    throw await parseErrorResponse(
      response,
      'UNAUTHENTICATED',
      'You are not signed in.',
    );
  }
  if (!response.ok) {
    throw await parseErrorResponse(
      response,
      'UNKNOWN_ERROR',
      'Could not check your session. Retry.',
    );
  }
  const body = await readJson<{ id?: unknown; email?: unknown }>(response);
  if (typeof body.id !== 'string' || typeof body.email !== 'string') {
    throw new ApiError({
      status: response.status,
      code: 'UNKNOWN_ERROR',
      message: 'The server returned an unexpected response.',
    });
  }
  return { id: body.id, email: body.email };
}

export interface Credentials {
  email: string;
  password: string;
}

function unsafeHeaders(csrf: CsrfToken): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    [csrf.headerName]: csrf.token,
  };
}

export async function postRegister(
  credentials: Credentials,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<SafeUser> {
  const response = await apiFetch(
    '/api/auth/register',
    {
      method: 'POST',
      credentials: 'include',
      headers: unsafeHeaders(csrf),
      cache: 'no-store',
      body: JSON.stringify(credentials),
    },
    signal,
    timeoutMs,
  );
  if (response.status === 201) {
    const body = await readJson<{ id?: unknown; email?: unknown }>(response);
    if (typeof body.id !== 'string' || typeof body.email !== 'string') {
      throw new ApiError({
        status: response.status,
        code: 'UNKNOWN_ERROR',
        message: 'The server returned an unexpected response.',
      });
    }
    return { id: body.id, email: body.email };
  }
  if (response.status === 409) {
    throw await parseErrorResponse(
      response,
      'REGISTRATION_CONFLICT',
      'An account with that email already exists.',
    );
  }
  if (response.status === 429) {
    throw await parseErrorResponse(
      response,
      'RATE_LIMITED',
      'Too many attempts. Wait a moment and retry.',
    );
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'Registration could not be completed.',
  );
}

export async function postLogin(
  credentials: Credentials,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<SafeUser> {
  const response = await apiFetch(
    '/api/auth/login',
    {
      method: 'POST',
      credentials: 'include',
      headers: unsafeHeaders(csrf),
      cache: 'no-store',
      body: JSON.stringify(credentials),
    },
    signal,
    timeoutMs,
  );
  if (response.ok) {
    const body = await readJson<{ id?: unknown; email?: unknown }>(response);
    if (typeof body.id !== 'string' || typeof body.email !== 'string') {
      throw new ApiError({
        status: response.status,
        code: 'UNKNOWN_ERROR',
        message: 'The server returned an unexpected response.',
      });
    }
    return { id: body.id, email: body.email };
  }
  if (response.status === 401) {
    throw await parseErrorResponse(
      response,
      'INVALID_CREDENTIALS',
      'Check your email and password and try again.',
    );
  }
  if (response.status === 429) {
    throw await parseErrorResponse(
      response,
      'RATE_LIMITED',
      'Too many attempts. Wait a moment and retry.',
    );
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'Sign-in could not be completed.',
  );
}

export async function postLogout(
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<void> {
  const response = await apiFetch(
    '/api/auth/logout',
    {
      method: 'POST',
      credentials: 'include',
      headers: unsafeHeaders(csrf),
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (response.status === 204) return;
  throw await parseErrorResponse(
    response,
    'UNKNOWN_ERROR',
    'Sign-out could not be completed.',
  );
}

export type HouseholdRole = 'OWNER' | 'MEMBER';

export interface Household {
  id: string;
  name: string;
  role: HouseholdRole;
  createdAt: string;
}

function isHouseholdRole(value: unknown): value is HouseholdRole {
  return value === 'OWNER' || value === 'MEMBER';
}

function parseHousehold(value: unknown): Household | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    typeof record.name !== 'string' ||
    !isHouseholdRole(record.role) ||
    typeof record.createdAt !== 'string'
  ) {
    return undefined;
  }
  return {
    id: record.id,
    name: record.name,
    role: record.role,
    createdAt: record.createdAt,
  };
}

export async function fetchHouseholds(
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<Household[]> {
  const response = await apiFetch(
    '/api/households',
    {
      method: 'GET',
      credentials: 'include',
      headers: { ...JSON_HEADERS },
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (response.status === 401) {
    throw await parseErrorResponse(
      response,
      'UNAUTHENTICATED',
      'You are not signed in.',
    );
  }
  if (!response.ok) {
    throw await parseErrorResponse(
      response,
      'UNKNOWN_ERROR',
      'Could not load your households. Retry.',
    );
  }
  const body = await readJson<{ households?: unknown }>(response);
  if (!Array.isArray(body.households)) {
    throw new ApiError({
      status: response.status,
      code: 'UNKNOWN_ERROR',
      message: 'The server returned an unexpected response.',
    });
  }
  const households: Household[] = [];
  for (const entry of body.households) {
    const parsed = parseHousehold(entry);
    if (!parsed) {
      throw new ApiError({
        status: response.status,
        code: 'UNKNOWN_ERROR',
        message: 'The server returned an unexpected response.',
      });
    }
    households.push(parsed);
  }
  return households;
}

export async function postHousehold(
  name: string,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<Household> {
  const response = await apiFetch(
    '/api/households',
    {
      method: 'POST',
      credentials: 'include',
      headers: unsafeHeaders(csrf),
      cache: 'no-store',
      body: JSON.stringify({ name }),
    },
    signal,
    timeoutMs,
  );
  if (response.status === 201) {
    const body = await readJson<unknown>(response);
    const parsed = parseHousehold(body);
    if (!parsed) {
      throw new ApiError({
        status: response.status,
        code: 'UNKNOWN_ERROR',
        message: 'The server returned an unexpected response.',
      });
    }
    return parsed;
  }
  if (response.status === 401) {
    throw await parseErrorResponse(
      response,
      'UNAUTHENTICATED',
      'You are not signed in.',
    );
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'Household creation could not be completed.',
  );
}

export interface HouseholdMember {
  userId: string;
  email: string;
  role: HouseholdRole;
}

function parseHouseholdMember(value: unknown): HouseholdMember | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.userId !== 'string' ||
    record.userId.length === 0 ||
    typeof record.email !== 'string' ||
    record.email.length === 0 ||
    !isHouseholdRole(record.role)
  ) {
    return undefined;
  }
  return { userId: record.userId, email: record.email, role: record.role };
}

function memberPath(householdId: string, userId?: string): string {
  return userId === undefined
    ? `/api/households/${encodeURIComponent(householdId)}/members`
    : `/api/households/${encodeURIComponent(householdId)}/members/${encodeURIComponent(userId)}`;
}

function parseMemberList(
  response: BodySource,
  body: { members?: unknown },
): HouseholdMember[] {
  if (!Array.isArray(body.members)) {
    throw unexpectedLifecycleResponse(response.status);
  }
  const members: HouseholdMember[] = [];
  for (const entry of body.members) {
    const parsed = parseHouseholdMember(entry);
    if (!parsed) throw unexpectedLifecycleResponse(response.status);
    members.push(parsed);
  }
  return members;
}

function unexpectedLifecycleResponse(status: number): ApiError {
  return new ApiError({
    status,
    code: 'UNKNOWN_ERROR',
    message: 'The server returned an unexpected response.',
  });
}

export async function fetchHouseholdMembers(
  householdId: string,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<HouseholdMember[]> {
  const response = await apiFetch(
    memberPath(householdId),
    {
      method: 'GET',
      credentials: 'include',
      headers: { ...JSON_HEADERS },
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (response.status === 401) {
    throw await parseErrorResponse(
      response,
      'UNAUTHENTICATED',
      'You are not signed in.',
    );
  }
  if (!response.ok) {
    throw await parseErrorResponse(
      response,
      'UNKNOWN_ERROR',
      'Could not load members. Retry.',
    );
  }
  const body = await readJson<{ members?: unknown }>(response);
  return parseMemberList(response, body);
}

export async function patchHouseholdMemberRole(
  householdId: string,
  userId: string,
  role: HouseholdRole,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<HouseholdMember> {
  const response = await apiFetch(
    memberPath(householdId, userId),
    {
      method: 'PATCH',
      credentials: 'include',
      headers: unsafeHeaders(csrf),
      cache: 'no-store',
      body: JSON.stringify({ role }),
    },
    signal,
    timeoutMs,
  );
  if (response.status === 200) {
    const body = await readJson<unknown>(response);
    const parsed = parseHouseholdMember(body);
    if (!parsed) throw unexpectedLifecycleResponse(response.status);
    return parsed;
  }
  if (response.status === 401) {
    throw await parseErrorResponse(
      response,
      'UNAUTHENTICATED',
      'You are not signed in.',
    );
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'The role change could not be completed.',
  );
}

export async function deleteHouseholdMember(
  householdId: string,
  userId: string,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<void> {
  const response = await apiFetch(
    memberPath(householdId, userId),
    {
      method: 'DELETE',
      credentials: 'include',
      headers: unsafeHeaders(csrf),
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  // A bodyless 204 is the only success; nothing about the removed member
  // is carried in the response.
  if (response.status === 204) return;
  if (response.status === 401) {
    throw await parseErrorResponse(
      response,
      'UNAUTHENTICATED',
      'You are not signed in.',
    );
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'Member removal could not be completed.',
  );
}

export async function postLeaveHousehold(
  householdId: string,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<void> {
  const response = await apiFetch(
    `/api/households/${encodeURIComponent(householdId)}/leave`,
    {
      method: 'POST',
      credentials: 'include',
      headers: unsafeHeaders(csrf),
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (response.status === 204) return;
  if (response.status === 401) {
    throw await parseErrorResponse(
      response,
      'UNAUTHENTICATED',
      'You are not signed in.',
    );
  }
  throw await parseErrorResponse(
    response,
    'UNKNOWN_ERROR',
    'Leaving the household could not be completed.',
  );
}

export interface InvitationCapability {
  id: string;
  secret: string;
  createdAt: string;
  expiresAt: string;
}

export interface ActiveInvitation {
  id: string;
  createdAt: string;
  expiresAt: string;
}

export interface InvitationPreview {
  householdName: string;
  role: 'MEMBER';
  expiresAt: string;
}

export interface InvitationCredential {
  invitationId: string;
  secret: string;
}

const INVITATION_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const INVITATION_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Decode a 43-character unpadded base64url invitation secret to its raw
 * 32 bytes, rejecting non-canonical encodings (for example nonzero spare
 * bits). Returns null when the secret is not exactly the canonical
 * encoding of 32 random bytes.
 */
function decodeInvitationSecret(secret: string): Uint8Array | null {
  if (!INVITATION_SECRET_PATTERN.test(secret)) return null;
  let binary: string;
  try {
    const padded = `${secret.replace(/-/g, '+').replace(/_/g, '/')}=`;
    binary = atob(padded);
  } catch {
    return null;
  }
  if (binary.length !== 32) return null;
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  let encoded: string;
  try {
    encoded = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  } catch {
    return null;
  }
  return encoded === secret ? bytes : null;
}

function parseInvitationCapability(
  value: unknown,
): InvitationCapability | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    !INVITATION_ID_PATTERN.test(record.id) ||
    typeof record.secret !== 'string' ||
    decodeInvitationSecret(record.secret) === null ||
    typeof record.createdAt !== 'string' ||
    typeof record.expiresAt !== 'string'
  ) {
    return undefined;
  }
  return {
    id: record.id,
    secret: record.secret,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

function parseActiveInvitation(value: unknown): ActiveInvitation | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    record.id.length === 0 ||
    typeof record.createdAt !== 'string' ||
    typeof record.expiresAt !== 'string'
  ) {
    return undefined;
  }
  // The active list never carries secret material; the parser only reads the
  // documented fields and ignores any unexpected extras.
  return {
    id: record.id,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

function parseInvitationPreview(value: unknown): InvitationPreview | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.householdName !== 'string' ||
    record.householdName.length === 0 ||
    record.role !== 'MEMBER' ||
    typeof record.expiresAt !== 'string'
  ) {
    return undefined;
  }
  return {
    householdName: record.householdName,
    role: 'MEMBER',
    expiresAt: record.expiresAt,
  };
}

function unexpectedInvitationResponse(status: number): ApiError {
  return new ApiError({
    status,
    code: 'UNKNOWN_ERROR',
    message: 'The server returned an unexpected response.',
  });
}

function invitationPath(householdId: string): string {
  return `/api/households/${encodeURIComponent(householdId)}/invitations`;
}

export async function postInvitation(
  householdId: string,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<InvitationCapability> {
  const response = await apiFetch(
    invitationPath(householdId),
    {
      method: 'POST',
      credentials: 'include',
      headers: unsafeHeaders(csrf),
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (response.status === 201) {
    const body = await readJson<unknown>(response);
    const parsed = parseInvitationCapability(body);
    if (!parsed) throw unexpectedInvitationResponse(response.status);
    return parsed;
  }
  if (response.status === 401) {
    throw await parseErrorResponse(
      response,
      'UNAUTHENTICATED',
      'You are not signed in.',
    );
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'Invitation creation could not be completed.',
  );
}

export async function fetchInvitations(
  householdId: string,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<ActiveInvitation[]> {
  const response = await apiFetch(
    invitationPath(householdId),
    {
      method: 'GET',
      credentials: 'include',
      headers: { ...JSON_HEADERS },
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (response.status === 401) {
    throw await parseErrorResponse(
      response,
      'UNAUTHENTICATED',
      'You are not signed in.',
    );
  }
  if (!response.ok) {
    throw await parseErrorResponse(
      response,
      'UNKNOWN_ERROR',
      'Could not load invitations. Retry.',
    );
  }
  const body = await readJson<{ invitations?: unknown }>(response);
  if (!Array.isArray(body.invitations)) {
    throw unexpectedInvitationResponse(response.status);
  }
  const invitations: ActiveInvitation[] = [];
  for (const entry of body.invitations) {
    const parsed = parseActiveInvitation(entry);
    if (!parsed) throw unexpectedInvitationResponse(response.status);
    invitations.push(parsed);
  }
  return invitations;
}

export async function deleteInvitation(
  householdId: string,
  invitationId: string,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<void> {
  const response = await apiFetch(
    `${invitationPath(householdId)}/${encodeURIComponent(invitationId)}`,
    {
      method: 'DELETE',
      credentials: 'include',
      headers: unsafeHeaders(csrf),
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  // A repeated revoke of an already-revoked invitation is a successful
  // no-op by contract; 204 is bodyless and carries no secret material.
  if (response.status === 204) return;
  if (response.status === 401) {
    throw await parseErrorResponse(
      response,
      'UNAUTHENTICATED',
      'You are not signed in.',
    );
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'Invitation revocation could not be completed.',
  );
}

export async function postInvitationPreview(
  credential: InvitationCredential,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<InvitationPreview> {
  const response = await apiFetch(
    '/api/invitations/preview',
    {
      method: 'POST',
      credentials: 'include',
      headers: unsafeHeaders(csrf),
      cache: 'no-store',
      body: JSON.stringify({
        invitationId: credential.invitationId,
        secret: credential.secret,
      }),
    },
    signal,
    timeoutMs,
  );
  if (response.ok) {
    const body = await readJson<unknown>(response);
    const parsed = parseInvitationPreview(body);
    if (!parsed) throw unexpectedInvitationResponse(response.status);
    return parsed;
  }
  if (response.status === 401) {
    throw await parseErrorResponse(
      response,
      'UNAUTHENTICATED',
      'You are not signed in.',
    );
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'Invitation preview could not be loaded.',
  );
}

export async function postInvitationAccept(
  credential: InvitationCredential,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<Household> {
  const response = await apiFetch(
    '/api/invitations/accept',
    {
      method: 'POST',
      credentials: 'include',
      headers: unsafeHeaders(csrf),
      cache: 'no-store',
      body: JSON.stringify({
        invitationId: credential.invitationId,
        secret: credential.secret,
      }),
    },
    signal,
    timeoutMs,
  );
  if (response.ok) {
    const body = await readJson<unknown>(response);
    const parsed = parseHousehold(body);
    if (!parsed) throw unexpectedInvitationResponse(response.status);
    return parsed;
  }
  if (response.status === 401) {
    throw await parseErrorResponse(
      response,
      'UNAUTHENTICATED',
      'You are not signed in.',
    );
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'Joining the household could not be completed.',
  );
}

export type FinancialAccountKind =
  'CASH' | 'CHECKING' | 'SAVINGS' | 'CREDIT_CARD';
export type FinancialAccountStatus = 'ACTIVE' | 'ARCHIVED';
/**
 * Connected finance widens the persisted source from MANUAL-only to
 * MANUAL/CONNECTED. Manual transaction entry stays MANUAL-only (enforced
 * server-side and in the transaction form's account selector); CONNECTED
 * rows are admitted only through explicit account selection.
 */
export type FinancialAccountSource = 'MANUAL' | 'CONNECTED';

function isFinancialAccountSource(
  value: unknown,
): value is FinancialAccountSource {
  return value === 'MANUAL' || value === 'CONNECTED';
}

export interface FinancialAccount {
  id: string;
  householdId: string;
  ownerUserId: string;
  name: string;
  kind: FinancialAccountKind;
  currency: FinancialAccountCurrency;
  source: FinancialAccountSource;
  visibility: 'PRIVATE';
  status: FinancialAccountStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface FinancialAccountPage {
  items: FinancialAccount[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface CreateFinancialAccountInput {
  name: string;
  kind: FinancialAccountKind;
  currency: FinancialAccountCurrency;
}

function financialAccountPath(householdId: string, accountId?: string): string {
  const base = `/api/households/${encodeURIComponent(householdId)}/financial-accounts`;
  return accountId === undefined
    ? base
    : `${base}/${encodeURIComponent(accountId)}`;
}

function isFinancialAccountKind(value: unknown): value is FinancialAccountKind {
  return (
    value === 'CASH' ||
    value === 'CHECKING' ||
    value === 'SAVINGS' ||
    value === 'CREDIT_CARD'
  );
}

function parseFinancialAccount(value: unknown): FinancialAccount | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    typeof record.householdId !== 'string' ||
    typeof record.ownerUserId !== 'string' ||
    typeof record.name !== 'string' ||
    !isFinancialAccountKind(record.kind) ||
    !isFinancialAccountCurrency(record.currency) ||
    !isFinancialAccountSource(record.source) ||
    record.visibility !== 'PRIVATE' ||
    (record.status !== 'ACTIVE' && record.status !== 'ARCHIVED') ||
    typeof record.version !== 'number' ||
    !Number.isInteger(record.version) ||
    record.version < 0 ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string'
  ) {
    return undefined;
  }
  return record as unknown as FinancialAccount;
}

function unexpectedFinancialAccountResponse(status: number): ApiError {
  return new ApiError({
    status,
    code: 'UNKNOWN_ERROR',
    message: 'The server returned an unexpected financial account response.',
  });
}

export async function fetchFinancialAccounts(
  householdId: string,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<FinancialAccountPage> {
  const response = await apiFetch(
    `${financialAccountPath(householdId)}?limit=100&offset=0&status=ALL`,
    {
      method: 'GET',
      credentials: 'include',
      headers: { ...JSON_HEADERS },
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (!response.ok) {
    throw await parseErrorResponse(
      response,
      response.status === 401 ? 'UNAUTHENTICATED' : 'UNKNOWN_ERROR',
      'Could not load your financial accounts.',
    );
  }
  const body = await readJson<{
    items?: unknown;
    limit?: unknown;
    offset?: unknown;
    hasMore?: unknown;
  }>(response);
  if (
    !Array.isArray(body.items) ||
    typeof body.limit !== 'number' ||
    typeof body.offset !== 'number' ||
    typeof body.hasMore !== 'boolean'
  ) {
    throw unexpectedFinancialAccountResponse(response.status);
  }
  const items: FinancialAccount[] = [];
  for (const value of body.items) {
    const account = parseFinancialAccount(value);
    if (!account) throw unexpectedFinancialAccountResponse(response.status);
    items.push(account);
  }
  return {
    items,
    limit: body.limit,
    offset: body.offset,
    hasMore: body.hasMore,
  };
}

export async function postFinancialAccount(
  householdId: string,
  input: CreateFinancialAccountInput,
  idempotencyKey: string,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<FinancialAccount> {
  const response = await apiFetch(
    financialAccountPath(householdId),
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        ...unsafeHeaders(csrf),
        'Idempotency-Key': idempotencyKey,
      },
      cache: 'no-store',
      body: JSON.stringify(input),
    },
    signal,
    timeoutMs,
  );
  if (response.status === 200 || response.status === 201) {
    const account = parseFinancialAccount(await readJson<unknown>(response));
    if (!account) throw unexpectedFinancialAccountResponse(response.status);
    return account;
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'Financial account creation could not be completed.',
  );
}

export async function patchFinancialAccount(
  householdId: string,
  accountId: string,
  patch: {
    expectedVersion: number;
    name?: string;
    status?: FinancialAccountStatus;
  },
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<FinancialAccount> {
  const response = await apiFetch(
    financialAccountPath(householdId, accountId),
    {
      method: 'PATCH',
      credentials: 'include',
      headers: unsafeHeaders(csrf),
      cache: 'no-store',
      body: JSON.stringify(patch),
    },
    signal,
    timeoutMs,
  );
  if (response.status === 200) {
    const account = parseFinancialAccount(await readJson<unknown>(response));
    if (!account) throw unexpectedFinancialAccountResponse(response.status);
    return account;
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'Financial account update could not be completed.',
  );
}

export type {
  AccountSelectionResult,
  ConnectionAccountMapping,
  ConnectionAccountMappingPage,
  ConnectionOperation,
  ConnectionOperationState,
  ConnectionOperationType,
  FinancialConnection,
  FinancialConnectionPage,
  FinancialConnectionState,
  LinkAttempt,
  LinkFlow,
  SelectedConnectedAccount,
} from '../finance/connections';

/**
 * Connected-finance endpoints
 * (docs/architecture/connected-finance-contract.md, section 7). Every POST
 * carries an Idempotency-Key plus CSRF; versioned POSTs send the exact
 * backend body shape `{expectedVersion, ...}`. There is no `/sync` or
 * webhook surface on these routes.
 */

function connectionBase(householdId: string): string {
  return `/api/households/${encodeURIComponent(householdId)}`;
}

function unexpectedConnectionResponse(
  status: number,
  message: string,
): ApiError {
  return new ApiError({
    status,
    code: 'UNKNOWN_ERROR',
    message,
  });
}

async function postWithIdempotencyKey(
  url: string,
  body: unknown,
  idempotencyKey: string,
  csrf: CsrfToken,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<BufferedBody> {
  return apiFetch(
    url,
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        ...unsafeHeaders(csrf),
        'Idempotency-Key': idempotencyKey,
      },
      cache: 'no-store',
      body: JSON.stringify(body),
    },
    signal,
    timeoutMs,
  );
}

/**
 * Start a NEW link attempt. Body is exactly `{}`; unknown fields are
 * rejected server-side. 201 is a fresh attempt, 200 a same-key replay while
 * the token is valid.
 */
export async function startConnectionLink(
  householdId: string,
  idempotencyKey: string,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<LinkAttempt> {
  const response = await postWithIdempotencyKey(
    `${connectionBase(householdId)}/connection-link-attempts`,
    {},
    idempotencyKey,
    csrf,
    signal,
    timeoutMs,
  );
  if (response.status === 200 || response.status === 201) {
    const attempt = parseLinkAttempt(await readJson<unknown>(response));
    if (!attempt) {
      throw unexpectedConnectionResponse(
        response.status,
        'The server returned an unexpected link response.',
      );
    }
    return attempt;
  }
  if (response.status === 401) {
    throw await parseErrorResponse(
      response,
      'UNAUTHENTICATED',
      'You are not signed in.',
    );
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'Bank linking could not be started.',
  );
}

export type CompleteLinkBody = { publicToken: string } | Record<string, never>;

/**
 * Complete a link attempt and receive the durable operation behind the poll
 * URL. NEW links send `{publicToken}` exactly once; UPDATE (reconnect)
 * completions send `{}`. Always 202; the operation state carries the outcome,
 * including explicit OUTCOME_UNKNOWN.
 */
export async function completeConnectionLink(
  householdId: string,
  attemptId: string,
  body: CompleteLinkBody,
  idempotencyKey: string,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<ConnectionOperation> {
  const response = await postWithIdempotencyKey(
    `${connectionBase(householdId)}/connection-link-attempts/${encodeURIComponent(attemptId)}/complete`,
    body,
    idempotencyKey,
    csrf,
    signal,
    timeoutMs,
  );
  if (response.status === 202) {
    const operation = parseConnectionOperation(
      await readJson<unknown>(response),
    );
    if (!operation) {
      throw unexpectedConnectionResponse(
        response.status,
        'The server returned an unexpected link response.',
      );
    }
    return operation;
  }
  if (response.status === 401) {
    throw await parseErrorResponse(
      response,
      'UNAUTHENTICATED',
      'You are not signed in.',
    );
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'Bank linking could not be completed.',
  );
}

/** Owner-only durable-operation status poll behind the operation statusUrl. */
export async function fetchConnectionOperation(
  statusUrl: string,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<ConnectionOperation> {
  const response = await apiFetch(
    statusUrl,
    {
      method: 'GET',
      credentials: 'include',
      headers: { ...JSON_HEADERS },
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (response.status === 200) {
    const operation = parseConnectionOperation(
      await readJson<unknown>(response),
    );
    if (!operation) {
      throw unexpectedConnectionResponse(
        response.status,
        'The server returned an unexpected connection response.',
      );
    }
    return operation;
  }
  throw await parseErrorResponse(
    response,
    response.status === 401 ? 'UNAUTHENTICATED' : 'UNKNOWN_ERROR',
    'Could not check the connection request.',
  );
}

/** Owner-only private connection list; bounded page, deterministic order. */
export async function fetchFinancialConnections(
  householdId: string,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<FinancialConnectionPage> {
  const response = await apiFetch(
    `${connectionBase(householdId)}/financial-connections?limit=100&offset=0`,
    {
      method: 'GET',
      credentials: 'include',
      headers: { ...JSON_HEADERS },
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (response.status === 200) {
    const page = parseFinancialConnectionPage(
      await readJson<unknown>(response),
    );
    if (!page) {
      throw unexpectedConnectionResponse(
        response.status,
        'The server returned an unexpected connection response.',
      );
    }
    return page;
  }
  throw await parseErrorResponse(
    response,
    response.status === 401 ? 'UNAUTHENTICATED' : 'UNKNOWN_ERROR',
    'Could not load your bank connections.',
  );
}

/** Owner-only private connection detail. */
export async function fetchFinancialConnection(
  householdId: string,
  connectionId: string,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<FinancialConnection> {
  const response = await apiFetch(
    `${connectionBase(householdId)}/financial-connections/${encodeURIComponent(connectionId)}`,
    {
      method: 'GET',
      credentials: 'include',
      headers: { ...JSON_HEADERS },
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (response.status === 200) {
    const connection = parseFinancialConnection(
      await readJson<unknown>(response),
    );
    if (!connection) {
      throw unexpectedConnectionResponse(
        response.status,
        'The server returned an unexpected connection response.',
      );
    }
    return connection;
  }
  throw await parseErrorResponse(
    response,
    response.status === 401 ? 'UNAUTHENTICATED' : 'UNKNOWN_ERROR',
    'Could not load this bank connection.',
  );
}

/** Owner-only bounded page of discovered account mappings behind local IDs. */
export async function fetchConnectionAccounts(
  householdId: string,
  connectionId: string,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<ConnectionAccountMappingPage> {
  const response = await apiFetch(
    `${connectionBase(householdId)}/financial-connections/${encodeURIComponent(connectionId)}/accounts?limit=100&offset=0`,
    {
      method: 'GET',
      credentials: 'include',
      headers: { ...JSON_HEADERS },
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (response.status === 200) {
    const page = parseConnectionAccountMappingPage(
      await readJson<unknown>(response),
    );
    if (!page) {
      throw unexpectedConnectionResponse(
        response.status,
        'The server returned an unexpected connection response.',
      );
    }
    return page;
  }
  throw await parseErrorResponse(
    response,
    response.status === 401 ? 'UNAUTHENTICATED' : 'UNKNOWN_ERROR',
    'Could not load the discovered accounts.',
  );
}

/**
 * Save the explicit account selection. Body is exactly
 * `{expectedVersion, accountMappingIds}` with local mapping IDs; empty
 * selection is allowed. 200 carries the admitted CONNECTED accounts.
 */
export async function postAccountSelection(
  householdId: string,
  connectionId: string,
  expectedVersion: number,
  accountMappingIds: string[],
  idempotencyKey: string,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<AccountSelectionResult> {
  const response = await postWithIdempotencyKey(
    `${connectionBase(householdId)}/financial-connections/${encodeURIComponent(connectionId)}/account-selection`,
    { expectedVersion, accountMappingIds },
    idempotencyKey,
    csrf,
    signal,
    timeoutMs,
  );
  if (response.status === 200) {
    const result = parseAccountSelectionResult(
      await readJson<unknown>(response),
    );
    if (!result) {
      throw unexpectedConnectionResponse(
        response.status,
        'The server returned an unexpected connection response.',
      );
    }
    return result;
  }
  if (response.status === 401) {
    throw await parseErrorResponse(
      response,
      'UNAUTHENTICATED',
      'You are not signed in.',
    );
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'Account selection could not be saved.',
  );
}

/**
 * Start an UPDATE (reconnect) attempt. Body is exactly `{expectedVersion}`.
 * 201 is a fresh attempt, 200 a same-key replay. Completion goes through
 * `completeConnectionLink` with an empty body.
 */
export async function postConnectionReconnect(
  householdId: string,
  connectionId: string,
  expectedVersion: number,
  idempotencyKey: string,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<LinkAttempt> {
  const response = await postWithIdempotencyKey(
    `${connectionBase(householdId)}/financial-connections/${encodeURIComponent(connectionId)}/reconnect`,
    { expectedVersion },
    idempotencyKey,
    csrf,
    signal,
    timeoutMs,
  );
  if (response.status === 200 || response.status === 201) {
    const attempt = parseLinkAttempt(await readJson<unknown>(response));
    if (!attempt) {
      throw unexpectedConnectionResponse(
        response.status,
        'The server returned an unexpected link response.',
      );
    }
    return attempt;
  }
  if (response.status === 401) {
    throw await parseErrorResponse(
      response,
      'UNAUTHENTICATED',
      'You are not signed in.',
    );
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'Bank reconnection could not be started.',
  );
}

/**
 * Disconnect. Body is exactly `{expectedVersion}`. Always 202; the local
 * state moves to DISCONNECTING immediately and the operation poll confirms
 * the remote removal or a retryable state.
 */
export async function postConnectionDisconnect(
  householdId: string,
  connectionId: string,
  expectedVersion: number,
  idempotencyKey: string,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<ConnectionOperation> {
  const response = await postWithIdempotencyKey(
    `${connectionBase(householdId)}/financial-connections/${encodeURIComponent(connectionId)}/disconnect`,
    { expectedVersion },
    idempotencyKey,
    csrf,
    signal,
    timeoutMs,
  );
  if (response.status === 202) {
    const operation = parseConnectionOperation(
      await readJson<unknown>(response),
    );
    if (!operation) {
      throw unexpectedConnectionResponse(
        response.status,
        'The server returned an unexpected connection response.',
      );
    }
    return operation;
  }
  if (response.status === 401) {
    throw await parseErrorResponse(
      response,
      'UNAUTHENTICATED',
      'You are not signed in.',
    );
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'Bank disconnection could not be started.',
  );
}

export type {
  BankActivity,
  BankActivityDecision,
  BankActivityDismissReason,
  BankActivityPage,
  BankActivityReviewState,
  BankActivityState,
  ConfirmBody,
  ReplaceBody,
  ResolveAction,
  ResolveApplyField,
  ResolveBody,
} from '../finance/bank-activity';

/**
 * Bank-activity and manual-sync endpoints
 * (docs/architecture/connected-finance-contract.md, section 7). Reads are
 * owner-scoped; decisions carry a version plus an Idempotency-Key, and the
 * confirm body never includes derived account/money/date/source/visibility
 * fields.
 */

/**
 * Manual sync: a coalesced 202 operation behind the per-connection 60-second
 * interval. 429 means the client is asking too soon; the UI never promises
 * immediate new bank data.
 */
export async function postConnectionSync(
  householdId: string,
  connectionId: string,
  expectedVersion: number,
  idempotencyKey: string,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<ConnectionOperation> {
  const response = await postWithIdempotencyKey(
    `${connectionBase(householdId)}/financial-connections/${encodeURIComponent(connectionId)}/sync`,
    { expectedVersion },
    idempotencyKey,
    csrf,
    signal,
    timeoutMs,
  );
  if (response.status === 202) {
    const operation = parseConnectionOperation(
      await readJson<unknown>(response),
    );
    if (!operation) {
      throw unexpectedConnectionResponse(
        response.status,
        'The server returned an unexpected sync response.',
      );
    }
    return operation;
  }
  if (response.status === 401) {
    throw await parseErrorResponse(
      response,
      'UNAUTHENTICATED',
      'You are not signed in.',
    );
  }
  throw await parseErrorResponse(
    response,
    response.status === 400
      ? 'VALIDATION_FAILED'
      : response.status === 409
        ? 'RESOURCE_VERSION_CONFLICT'
        : response.status === 429
          ? 'MANUAL_SYNC_RATE_LIMITED'
          : 'UNKNOWN_ERROR',
    'Bank sync could not be started.',
  );
}

export interface BankActivityQuery {
  limit?: number | undefined;
  offset?: number | undefined;
  connectionId?: string | undefined;
  accountId?: string | undefined;
  state?: string | undefined;
  review?: string | undefined;
}

/** Owner-scoped private inbox page; bounded limit/offset like every finance feed. */
export async function fetchBankActivity(
  householdId: string,
  query: BankActivityQuery = {},
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<BankActivityPage> {
  const parameters = new URLSearchParams();
  parameters.set('limit', String(query.limit ?? 100));
  parameters.set('offset', String(query.offset ?? 0));
  if (query.connectionId) parameters.set('connectionId', query.connectionId);
  if (query.accountId) parameters.set('accountId', query.accountId);
  if (query.state) parameters.set('state', query.state);
  if (query.review) parameters.set('review', query.review);
  const response = await apiFetch(
    `${connectionBase(householdId)}/bank-activity?${parameters.toString()}`,
    {
      method: 'GET',
      credentials: 'include',
      headers: { ...JSON_HEADERS },
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (!response.ok) {
    throw await parseErrorResponse(
      response,
      response.status === 401 ? 'UNAUTHENTICATED' : 'UNKNOWN_ERROR',
      'Could not load bank activity.',
    );
  }
  const page = parseBankActivityPage(await readJson<unknown>(response));
  if (!page) {
    throw unexpectedConnectionResponse(
      response.status,
      'The server returned an unexpected bank activity response.',
    );
  }
  return page;
}

/**
 * Owner-scoped single observation; used for stale-version refetch-and-review
 * so a 409 never discards the open draft or resends blindly.
 */
export async function fetchBankActivityDetail(
  householdId: string,
  activityId: string,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<BankActivity> {
  const response = await apiFetch(
    `${connectionBase(householdId)}/bank-activity/${encodeURIComponent(activityId)}`,
    {
      method: 'GET',
      credentials: 'include',
      headers: { ...JSON_HEADERS },
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (!response.ok) {
    throw await parseErrorResponse(
      response,
      response.status === 401 ? 'UNAUTHENTICATED' : 'UNKNOWN_ERROR',
      'Could not load this bank activity.',
    );
  }
  const detail = parseBankActivity(await readJson<unknown>(response));
  if (!detail) {
    throw unexpectedConnectionResponse(
      response.status,
      'The server returned an unexpected bank activity response.',
    );
  }
  return detail;
}

/** Confirm one posted observation into the ledger; 201 admits, 200 replays. */
export async function confirmBankActivity(
  householdId: string,
  activityId: string,
  body: ConfirmBody,
  idempotencyKey: string,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<BankActivityDecision> {
  const response = await postWithIdempotencyKey(
    `${connectionBase(householdId)}/bank-activity/${encodeURIComponent(activityId)}/confirm`,
    confirmBankActivityBody(body),
    idempotencyKey,
    csrf,
    signal,
    timeoutMs,
  );
  if (response.status === 200 || response.status === 201) {
    const decision = parseBankActivityDecision(
      await readJson<unknown>(response),
    );
    if (!decision) {
      throw unexpectedConnectionResponse(
        response.status,
        'The server returned an unexpected bank activity response.',
      );
    }
    return decision;
  }
  if (response.status === 401) {
    throw await parseErrorResponse(
      response,
      'UNAUTHENTICATED',
      'You are not signed in.',
    );
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'Bank activity could not be confirmed.',
  );
}

/** Dismiss any unadmitted observation; never a ledger decision. */
export async function dismissBankActivity(
  householdId: string,
  activityId: string,
  expectedVersion: number,
  reason: BankActivityDismissReason,
  idempotencyKey: string,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<BankActivityDecision> {
  const response = await postWithIdempotencyKey(
    `${connectionBase(householdId)}/bank-activity/${encodeURIComponent(activityId)}/dismiss`,
    dismissBankActivityBody(expectedVersion, reason),
    idempotencyKey,
    csrf,
    signal,
    timeoutMs,
  );
  if (response.status === 200) {
    const decision = parseBankActivityDecision(
      await readJson<unknown>(response),
    );
    if (!decision) {
      throw unexpectedConnectionResponse(
        response.status,
        'The server returned an unexpected bank activity response.',
      );
    }
    return decision;
  }
  if (response.status === 401) {
    throw await parseErrorResponse(
      response,
      'UNAUTHENTICATED',
      'You are not signed in.',
    );
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'Bank activity could not be dismissed.',
  );
}

/**
 * Reconciliation (connected-finance contract sections 6-7). Both calls send the
 * current observation version plus the ledger `Transaction.version`; a
 * constraint failure leaves both unchanged. Resolve answers 200 with the
 * current review + ledger decision; replace answers 201 with the
 * replacement + retained association history (200 on same-key replay).
 * Either may answer 409 RECONCILIATION_REQUIRED when the bank revision
 * moved under the request: the caller refetches and reviews instead of
 * resending blindly.
 */
export async function resolveBankActivity(
  householdId: string,
  activityId: string,
  body: ResolveBody,
  idempotencyKey: string,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<BankActivityDecision> {
  const response = await postWithIdempotencyKey(
    `${connectionBase(householdId)}/bank-activity/${encodeURIComponent(activityId)}/resolve`,
    resolveBankActivityBody(body),
    idempotencyKey,
    csrf,
    signal,
    timeoutMs,
  );
  if (response.status === 200) {
    const decision = parseBankActivityDecision(
      await readJson<unknown>(response),
    );
    if (!decision) {
      throw unexpectedConnectionResponse(
        response.status,
        'The server returned an unexpected bank activity response.',
      );
    }
    return decision;
  }
  if (response.status === 401) {
    throw await parseErrorResponse(
      response,
      'UNAUTHENTICATED',
      'You are not signed in.',
    );
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'That bank revision could not be resolved.',
  );
}

/**
 * Atomic-replacement outcome: the current review (whose ledger
 * association already points at the replacement), the replacement entry
 * itself, and the retained superseded entry identity. Exactly these four
 * keys; anything else is contract drift.
 */
export interface BankActivityReplaceDecision {
  activity: BankActivity;
  transaction: Transaction;
  supersededTransactionId: string;
  supersededTransactionVersion: number;
}

function parseBankActivityReplace(
  value: unknown,
): BankActivityReplaceDecision | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 4) return undefined;
  const activity = parseBankActivity(record.activity);
  const transaction = parseTransaction(record.transaction);
  if (!activity || !transaction) return undefined;
  if (
    typeof record.supersededTransactionId !== 'string' ||
    !UUID_PATTERN.test(record.supersededTransactionId) ||
    typeof record.supersededTransactionVersion !== 'number' ||
    !Number.isInteger(record.supersededTransactionVersion) ||
    record.supersededTransactionVersion < 0 ||
    record.supersededTransactionVersion > 2147483647
  ) {
    return undefined;
  }
  return {
    activity,
    transaction,
    supersededTransactionId: record.supersededTransactionId,
    supersededTransactionVersion: record.supersededTransactionVersion,
  };
}

export async function replaceBankActivityLedger(
  householdId: string,
  activityId: string,
  body: ReplaceBody,
  idempotencyKey: string,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<BankActivityReplaceDecision> {
  const response = await postWithIdempotencyKey(
    `${connectionBase(householdId)}/bank-activity/${encodeURIComponent(activityId)}/replace-ledger`,
    replaceBankActivityBody(body),
    idempotencyKey,
    csrf,
    signal,
    timeoutMs,
  );
  if (response.status === 200 || response.status === 201) {
    const decision = parseBankActivityReplace(
      await readJson<unknown>(response),
    );
    if (!decision) {
      throw unexpectedConnectionResponse(
        response.status,
        'The server returned an unexpected bank activity response.',
      );
    }
    return decision;
  }
  if (response.status === 401) {
    throw await parseErrorResponse(
      response,
      'UNAUTHENTICATED',
      'You are not signed in.',
    );
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'That ledger entry could not be replaced.',
  );
}

export type TransactionKind = 'EXPENSE' | 'INCOME' | 'REFUND' | 'TRANSFER';
export type TransactionStatus = 'POSTED' | 'VOIDED';
export type TransactionVisibility = 'PRIVATE' | 'HOUSEHOLD';
/** The two documented feed projections of the transaction list. */
export type TransactionFeedView = 'OWN' | 'HOUSEHOLD';

export interface Money {
  readonly amount: string;
  readonly currency: FinancialAccountCurrency;
}

/**
 * The server-owned fixed taxonomy tokens, in the documented response order.
 * The list itself is always fetched from the API; this constant only
 * validates that responses carry exactly the documented bounded set.
 */
export const TRANSACTION_CATEGORY_CODES = [
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
] as const;

export type TransactionCategoryCode =
  (typeof TRANSACTION_CATEGORY_CODES)[number];

export interface TransactionCategory {
  code: string;
  label: string;
}

/**
 * Exactly the documented 16-field transaction DTO. `accountId` is the
 * owner's account reference for own reads and redacted to null when a
 * household member reads someone else's shared entry; `category` is the
 * server taxonomy token or null when uncategorized.
 */
export interface Transaction {
  id: string;
  householdId: string;
  ownerUserId: string;
  accountId: string | null;
  kind: TransactionKind;
  money: Money;
  occurredOn: string;
  description: string;
  category: string | null;
  visibility: TransactionVisibility;
  /**
   * Bank admission widens the persisted source: CONNECTED entries are admitted
   * only through bank-activity confirmation, and every correction, sharing,
   * and allocation action stays available to them.
   */
  source: FinancialAccountSource;
  status: TransactionStatus;
  refundOfTransactionId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionPage {
  items: Transaction[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Assignment provenance. `LEGACY` marks a category that existed
 * before HouseSync recorded decisions, so it is deliberately never presented
 * as the owner's own choice.
 */
export type CategorizationOrigin =
  'NONE' | 'LEGACY' | 'USER' | 'OWNER_RULE' | 'PROVIDER' | 'INHERITED';

/** `OPEN` only exists once review items are persisted; until then the state is `NONE`. */
export type CategorizationReviewState = 'NONE' | 'OPEN';

/**
 * Exactly the documented seven-field owner-only categorization resource. It is
 * a separate contract from the 16-field transaction DTO: no rule reference,
 * provider code, merchant key, confidence, reason, model, or evidence digest
 * ever appears here.
 *
 * `ruleEligible` is the server's sole authority for offering the
 * explicit "Use for future matches" action: true only for the current posted
 * non-refund whose decision is `USER`, whose category is non-null, that has a
 * safe server-derived match key and no active rule for that key. The browser
 * never derives, receives, or submits the private key.
 */
export interface CategorizationState {
  transactionId: string;
  transactionVersion: number;
  category: string | null;
  origin: CategorizationOrigin;
  assignedAt: string;
  reviewState: CategorizationReviewState;
  ruleEligible: boolean;
}

/**
 * Create inputs are a discriminated union: `refundOfTransactionId` is
 * required and non-null for REFUND creation and forbidden on every other
 * kind (even as null). Refund payloads omit `visibility` and `category` so
 * the source expense's disclosure and category are inherited; non-refunds
 * send PRIVATE explicitly and carry either a taxonomy token or explicit
 * null (uncategorized).
 */
export type CreateTransactionInput =
  | {
      accountId: string;
      kind: 'EXPENSE' | 'INCOME' | 'TRANSFER';
      money: Money;
      occurredOn: string;
      description: string;
      visibility: TransactionVisibility;
      category?: string | null;
    }
  | {
      accountId: string;
      kind: 'REFUND';
      money: Money;
      occurredOn: string;
      description: string;
      refundOfTransactionId: string;
    };

export type UpdateTransactionPatch = {
  expectedVersion: number;
  money?: Money;
  occurredOn?: string;
  description?: string;
  visibility?: TransactionVisibility;
  category?: string | null;
  status?: 'VOIDED';
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isTransactionKind(value: unknown): value is TransactionKind {
  return (
    value === 'EXPENSE' ||
    value === 'INCOME' ||
    value === 'REFUND' ||
    value === 'TRANSFER'
  );
}

function isMoney(value: unknown): value is Money {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 2 &&
    typeof record.amount === 'string' &&
    typeof record.currency === 'string' &&
    isFinancialAccountCurrency(record.currency) &&
    isSupportedAmountString(record.amount, record.currency)
  );
}

function isSupportedDate(value: string): boolean {
  return isSupportedTransactionDate(value);
}

function isCategoryToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (TRANSACTION_CATEGORY_CODES as readonly string[]).includes(value)
  );
}

function parseTransaction(value: unknown): Transaction | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  // The contract's response DTO has exactly these 16 fields; any extra or
  // missing key is a contract drift and must fail loudly rather than be
  // carried into the UI.
  if (
    Object.keys(record).length !== 16 ||
    typeof record.id !== 'string' ||
    !UUID_PATTERN.test(record.id) ||
    typeof record.householdId !== 'string' ||
    !UUID_PATTERN.test(record.householdId) ||
    typeof record.ownerUserId !== 'string' ||
    !UUID_PATTERN.test(record.ownerUserId) ||
    (record.accountId !== null &&
      (typeof record.accountId !== 'string' ||
        !UUID_PATTERN.test(record.accountId))) ||
    !isTransactionKind(record.kind) ||
    !isMoney(record.money) ||
    typeof record.occurredOn !== 'string' ||
    !isSupportedDate(record.occurredOn) ||
    typeof record.description !== 'string' ||
    (record.category !== null && !isCategoryToken(record.category)) ||
    (record.visibility !== 'PRIVATE' && record.visibility !== 'HOUSEHOLD') ||
    (record.source !== 'MANUAL' && record.source !== 'CONNECTED') ||
    (record.status !== 'POSTED' && record.status !== 'VOIDED') ||
    typeof record.version !== 'number' ||
    !Number.isInteger(record.version) ||
    record.version < 0 ||
    record.version > 2147483647 ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string'
  ) {
    return undefined;
  }
  const refundOf = record.refundOfTransactionId;
  if (record.kind === 'REFUND') {
    if (typeof refundOf !== 'string' || !UUID_PATTERN.test(refundOf)) {
      return undefined;
    }
  } else if (refundOf !== null) {
    return undefined;
  }
  return {
    id: record.id,
    householdId: record.householdId,
    ownerUserId: record.ownerUserId,
    // Sharing redaction: null only for another member's shared entry.
    accountId: typeof record.accountId === 'string' ? record.accountId : null,
    kind: record.kind,
    money: {
      amount: (record.money as Money).amount,
      currency: (record.money as Money).currency,
    },
    occurredOn: record.occurredOn,
    description: record.description,
    category: record.category === null ? null : (record.category as string),
    visibility: record.visibility,
    source: record.source,
    status: record.status,
    // The guard above proved the refund shape per kind.
    refundOfTransactionId:
      record.kind === 'REFUND' ? (refundOf as string) : null,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function unexpectedTransactionResponse(status: number): ApiError {
  return new ApiError({
    status,
    code: 'UNKNOWN_ERROR',
    message: 'The server returned an unexpected transaction response.',
  });
}

function transactionPath(householdId: string, transactionId?: string): string {
  const base = `/api/households/${encodeURIComponent(householdId)}/transactions`;
  return transactionId === undefined
    ? base
    : `${base}/${encodeURIComponent(transactionId)}`;
}

function parseTransactionPage(
  response: BodySource,
  body: {
    items?: unknown;
    limit?: unknown;
    offset?: unknown;
    hasMore?: unknown;
  },
): TransactionPage {
  if (
    !Array.isArray(body.items) ||
    typeof body.limit !== 'number' ||
    !Number.isInteger(body.limit) ||
    typeof body.offset !== 'number' ||
    !Number.isInteger(body.offset) ||
    typeof body.hasMore !== 'boolean'
  ) {
    throw unexpectedTransactionResponse(response.status);
  }
  const items: Transaction[] = [];
  for (const value of body.items) {
    const transaction = parseTransaction(value);
    if (!transaction) throw unexpectedTransactionResponse(response.status);
    items.push(transaction);
  }
  return {
    items,
    limit: body.limit,
    offset: body.offset,
    hasMore: body.hasMore,
  };
}

/**
 * Household feed query: the documented feed projection, all statuses so
 * retained voided entries stay visible, page 1 with the documented 1–100
 * limit bound.
 */
export async function fetchTransactions(
  householdId: string,
  view: TransactionFeedView,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<TransactionPage> {
  const response = await apiFetch(
    `${transactionPath(householdId)}?limit=100&offset=0&view=${view}&status=ALL`,
    {
      method: 'GET',
      credentials: 'include',
      headers: { ...JSON_HEADERS },
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (!response.ok) {
    throw await parseErrorResponse(
      response,
      response.status === 401 ? 'UNAUTHENTICATED' : 'UNKNOWN_ERROR',
      'Could not load your transactions.',
    );
  }
  return parseTransactionPage(
    response,
    await readJson<{
      items?: unknown;
      limit?: unknown;
      offset?: unknown;
      hasMore?: unknown;
    }>(response),
  );
}

/**
 * The bounded fixed taxonomy for the household. It is not a paginated
 * collection: the response is exactly the documented 16 items with their
 * server-returned display labels.
 */
export async function fetchTransactionCategories(
  householdId: string,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<{ items: TransactionCategory[] }> {
  const response = await apiFetch(
    `/api/households/${encodeURIComponent(householdId)}/transaction-categories`,
    {
      method: 'GET',
      credentials: 'include',
      headers: { ...JSON_HEADERS },
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (!response.ok) {
    throw await parseErrorResponse(
      response,
      response.status === 401 ? 'UNAUTHENTICATED' : 'UNKNOWN_ERROR',
      'Could not load transaction categories.',
    );
  }
  const body = await readJson<{ items?: unknown }>(response);
  if (
    !Array.isArray(body.items) ||
    body.items.length !== TRANSACTION_CATEGORY_CODES.length
  ) {
    throw unexpectedTransactionResponse(response.status);
  }
  const items: TransactionCategory[] = [];
  const seen = new Set<string>();
  for (const value of body.items) {
    if (typeof value !== 'object' || value === null) {
      throw unexpectedTransactionResponse(response.status);
    }
    const record = value as Record<string, unknown>;
    if (
      !isCategoryToken(record.code) ||
      typeof record.label !== 'string' ||
      record.label.length === 0
    ) {
      throw unexpectedTransactionResponse(response.status);
    }
    if (seen.has(record.code)) {
      throw unexpectedTransactionResponse(response.status);
    }
    seen.add(record.code);
    items.push({ code: record.code, label: record.label });
  }
  return { items };
}

export async function fetchTransaction(
  householdId: string,
  transactionId: string,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<Transaction> {
  const response = await apiFetch(
    transactionPath(householdId, transactionId),
    {
      method: 'GET',
      credentials: 'include',
      headers: { ...JSON_HEADERS },
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (!response.ok) {
    throw await parseErrorResponse(
      response,
      response.status === 401 ? 'UNAUTHENTICATED' : 'UNKNOWN_ERROR',
      'Could not load this transaction.',
    );
  }
  const transaction = parseTransaction(await readJson<unknown>(response));
  if (!transaction) throw unexpectedTransactionResponse(response.status);
  return transaction;
}

function isCategorizationOrigin(value: unknown): value is CategorizationOrigin {
  return (
    value === 'NONE' ||
    value === 'LEGACY' ||
    value === 'USER' ||
    value === 'OWNER_RULE' ||
    value === 'PROVIDER' ||
    value === 'INHERITED'
  );
}

const CATEGORIZATION_STATE_KEYS = 7;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
/**
 * Strict parser for the owner-only categorization resource: exactly the seven
 * documented fields, each validated. A missing or unknown field, an unknown
 * origin or review state, a category outside the fixed taxonomy, or a
 * non-boolean capability fails the whole response rather than reaching the
 * UI. The structural origin/category combinations stay server-enforced
 * invariants; the browser never invents a category for a state it cannot
 * interpret and never infers `ruleEligible` itself.
 */
function parseCategorizationState(
  value: unknown,
): CategorizationState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== CATEGORIZATION_STATE_KEYS ||
    typeof record.transactionId !== 'string' ||
    !UUID_PATTERN.test(record.transactionId) ||
    typeof record.transactionVersion !== 'number' ||
    !Number.isInteger(record.transactionVersion) ||
    record.transactionVersion < 0 ||
    record.transactionVersion > 2147483647 ||
    (record.category !== null && !isCategoryToken(record.category)) ||
    !isCategorizationOrigin(record.origin) ||
    typeof record.assignedAt !== 'string' ||
    !INSTANT_PATTERN.test(record.assignedAt) ||
    Number.isNaN(Date.parse(record.assignedAt)) ||
    (record.reviewState !== 'NONE' && record.reviewState !== 'OPEN') ||
    typeof record.ruleEligible !== 'boolean'
  ) {
    return undefined;
  }
  return {
    transactionId: record.transactionId,
    transactionVersion: record.transactionVersion,
    category: record.category === null ? null : (record.category as string),
    origin: record.origin,
    assignedAt: record.assignedAt,
    reviewState: record.reviewState,
    ruleEligible: record.ruleEligible,
  };
}

/**
 * Owner-only categorization provenance for one transaction. The
 * route is financial-owner-only, so another member reading a shared entry and
 * an outsider both receive the same generic transaction 404: a 404 here means
 * "no provenance for this viewer" and is never treated as a retryable
 * failure or as evidence about another owner's data.
 */
export async function fetchTransactionCategorization(
  householdId: string,
  transactionId: string,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<CategorizationState> {
  const response = await apiFetch(
    `${transactionPath(householdId, transactionId)}/categorization`,
    {
      method: 'GET',
      credentials: 'include',
      headers: { ...JSON_HEADERS },
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (!response.ok) {
    throw await parseErrorResponse(
      response,
      response.status === 401 ? 'UNAUTHENTICATED' : 'UNKNOWN_ERROR',
      'Could not load this category decision.',
    );
  }
  const state = parseCategorizationState(await readJson<unknown>(response));
  // A state that describes another entry is drift: rendering it would attach
  // someone else's decision to this transaction.
  if (!state || state.transactionId !== transactionId) {
    throw unexpectedTransactionResponse(response.status);
  }
  return state;
}

/**
 * How the server derived a rule's private match key. The browser only ever
 * sees this classification, the display label, and the assigned category:
 * the key itself stays server-side and is never sent, derived, or rendered.
 */
export type CategorizationRuleMatchType =
  'PROVIDER_MERCHANT' | 'NORMALIZED_TEXT';

/** Rules support one one-way transition: `ACTIVE` → `INACTIVE`. */
export type CategorizationRuleStatus = 'ACTIVE' | 'INACTIVE';

/**
 * Exactly the documented nine-field private rule projection. `matchLabel` is
 * a bounded server-provided display label, never the match key. A rule
 * belongs to one household and one financial owner: the list, create, and
 * update routes only ever return the current actor's own rules.
 */
export interface CategorizationRule {
  id: string;
  sourceTransactionId: string;
  matchType: CategorizationRuleMatchType;
  matchLabel: string;
  category: string;
  status: CategorizationRuleStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** Exactly `{items, limit, offset, hasMore}`; the contract has no total count. */
export interface CategorizationRulePage {
  items: CategorizationRule[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface CategorizationRuleQuery {
  /** Documented bound: 1-100. */
  limit: number;
  /** Documented bound: 0-10000. */
  offset: number;
  /** Omitted means every status. */
  status?: CategorizationRuleStatus | undefined;
}

/**
 * The two accepted rule updates. Exactly one of `category` and the one-way
 * `status` transition is sent, and `expectedVersion` always accompanies it:
 * the rule version is the concurrency token, so a lost response is
 * recoverable by reloading instead of resending a blind update.
 */
export type CategorizationRulePatch =
  | { expectedVersion: number; category: string }
  | { expectedVersion: number; status: 'INACTIVE' };

export interface CreateCategorizationRuleInput {
  expectedTransactionVersion: number;
}

function isCategorizationRuleStatus(
  value: unknown,
): value is CategorizationRuleStatus {
  return value === 'ACTIVE' || value === 'INACTIVE';
}

function parseCategorizationRule(
  value: unknown,
): CategorizationRule | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    // Exactly the nine documented fields: an extra key would be contract
    // drift and could carry private evidence into the UI.
    Object.keys(record).length !== 9 ||
    typeof record.id !== 'string' ||
    !UUID_PATTERN.test(record.id) ||
    typeof record.sourceTransactionId !== 'string' ||
    !UUID_PATTERN.test(record.sourceTransactionId) ||
    (record.matchType !== 'PROVIDER_MERCHANT' &&
      record.matchType !== 'NORMALIZED_TEXT') ||
    typeof record.matchLabel !== 'string' ||
    record.matchLabel.length === 0 ||
    !isCategoryToken(record.category) ||
    !isCategorizationRuleStatus(record.status) ||
    typeof record.version !== 'number' ||
    !Number.isInteger(record.version) ||
    record.version < 0 ||
    record.version > 2147483647 ||
    typeof record.createdAt !== 'string' ||
    !INSTANT_PATTERN.test(record.createdAt) ||
    Number.isNaN(Date.parse(record.createdAt)) ||
    typeof record.updatedAt !== 'string' ||
    !INSTANT_PATTERN.test(record.updatedAt) ||
    Number.isNaN(Date.parse(record.updatedAt))
  ) {
    return undefined;
  }
  return {
    id: record.id,
    sourceTransactionId: record.sourceTransactionId,
    matchType: record.matchType,
    matchLabel: record.matchLabel,
    category: record.category,
    status: record.status,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function unexpectedRuleResponse(status: number): ApiError {
  return new ApiError({
    status,
    code: 'UNKNOWN_ERROR',
    message: 'The server returned an unexpected categorization rule response.',
  });
}

function rulePath(householdId: string, ruleId?: string): string {
  const base = `/api/households/${encodeURIComponent(householdId)}/categorization-rules`;
  return ruleId === undefined ? base : `${base}/${encodeURIComponent(ruleId)}`;
}

/**
 * The current actor's own private rule page, ordered by the server
 * (`updatedAt DESC, id DESC`). `status` is optional; omitting it lists every
 * retained rule, including deactivated ones. No other owner's rule is ever
 * reachable through this route.
 */
export async function fetchCategorizationRules(
  householdId: string,
  query: CategorizationRuleQuery,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<CategorizationRulePage> {
  const parameters = new URLSearchParams();
  parameters.set('limit', String(query.limit));
  parameters.set('offset', String(query.offset));
  if (query.status) parameters.set('status', query.status);
  const response = await apiFetch(
    `${rulePath(householdId)}?${parameters.toString()}`,
    {
      method: 'GET',
      credentials: 'include',
      headers: { ...JSON_HEADERS },
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (!response.ok) {
    throw await parseErrorResponse(
      response,
      response.status === 401 ? 'UNAUTHENTICATED' : 'UNKNOWN_ERROR',
      'Could not load your categorization rules.',
    );
  }
  const body = await readJson<unknown>(response);
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 4
  ) {
    throw unexpectedRuleResponse(response.status);
  }
  const page = body as Record<string, unknown>;
  if (
    // Exactly the four documented page fields: there is no total count, and
    // an extra key would be contract drift rather than something to ignore.
    !Array.isArray(page.items) ||
    typeof page.limit !== 'number' ||
    !Number.isInteger(page.limit) ||
    typeof page.offset !== 'number' ||
    !Number.isInteger(page.offset) ||
    typeof page.hasMore !== 'boolean'
  ) {
    throw unexpectedRuleResponse(response.status);
  }
  const items: CategorizationRule[] = [];
  for (const value of page.items) {
    const rule = parseCategorizationRule(value);
    if (!rule) throw unexpectedRuleResponse(response.status);
    items.push(rule);
  }
  return {
    items,
    limit: page.limit,
    offset: page.offset,
    hasMore: page.hasMore,
  };
}

/**
 * Explicitly turns one of the owner's own category decisions into a private
 * future-match rule. The body carries only the transaction's current version:
 * household, owner, match type, and match key are all server-derived. The
 * durable `Idempotency-Key` makes an unknown outcome recoverable — the same
 * key with the same body is replayed as 200 with the already-created rule
 * instead of creating a second one.
 */
export async function postTransactionCategorizationRule(
  householdId: string,
  transactionId: string,
  input: CreateCategorizationRuleInput,
  idempotencyKey: string,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<CategorizationRule> {
  const response = await apiFetch(
    `${transactionPath(householdId, transactionId)}/categorization-rule`,
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        ...unsafeHeaders(csrf),
        'Idempotency-Key': idempotencyKey,
      },
      cache: 'no-store',
      body: JSON.stringify(input),
    },
    signal,
    timeoutMs,
  );
  if (response.status === 200 || response.status === 201) {
    const rule = parseCategorizationRule(await readJson<unknown>(response));
    if (!rule) throw unexpectedRuleResponse(response.status);
    return rule;
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'The future-match rule could not be created.',
  );
}

/**
 * Updates one of the owner's own rules: either its category (active rules
 * only) or the one-way deactivation. Deactivation is retained, never a
 * deletion, so an `INACTIVE` rule stays listed and keeps explaining any
 * assignment it already made.
 */
export async function patchCategorizationRule(
  householdId: string,
  ruleId: string,
  patch: CategorizationRulePatch,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<CategorizationRule> {
  const response = await apiFetch(
    rulePath(householdId, ruleId),
    {
      method: 'PATCH',
      credentials: 'include',
      headers: unsafeHeaders(csrf),
      cache: 'no-store',
      body: JSON.stringify(patch),
    },
    signal,
    timeoutMs,
  );
  if (response.status === 200) {
    const rule = parseCategorizationRule(await readJson<unknown>(response));
    if (!rule) throw unexpectedRuleResponse(response.status);
    return rule;
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'The rule could not be updated.',
  );
}

export async function postTransaction(
  householdId: string,
  input: CreateTransactionInput,
  idempotencyKey: string,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<Transaction> {
  const response = await apiFetch(
    transactionPath(householdId),
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        ...unsafeHeaders(csrf),
        'Idempotency-Key': idempotencyKey,
      },
      cache: 'no-store',
      body: JSON.stringify(input),
    },
    signal,
    timeoutMs,
  );
  if (response.status === 200 || response.status === 201) {
    const transaction = parseTransaction(await readJson<unknown>(response));
    if (!transaction) throw unexpectedTransactionResponse(response.status);
    return transaction;
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'Transaction creation could not be completed.',
  );
}

export async function patchTransaction(
  householdId: string,
  transactionId: string,
  patch: UpdateTransactionPatch,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<Transaction> {
  const response = await apiFetch(
    transactionPath(householdId, transactionId),
    {
      method: 'PATCH',
      credentials: 'include',
      headers: unsafeHeaders(csrf),
      cache: 'no-store',
      body: JSON.stringify(patch),
    },
    signal,
    timeoutMs,
  );
  if (response.status === 200) {
    const transaction = parseTransaction(await readJson<unknown>(response));
    if (!transaction) throw unexpectedTransactionResponse(response.status);
    return transaction;
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'Transaction update could not be completed.',
  );
}

export type AllocationStatus = 'ACTIVE' | 'REVOKED';
export type MembershipStatus = 'CURRENT' | 'DEPARTED';

export interface AllocationParticipantShare {
  userId: string;
  share: Money;
}

/**
 * The active allocation of one expense, exactly the 11 documented response
 * fields. Participants are frozen at creation in ascending canonical user
 * UUID order with their persisted exact shares, which always sum to the
 * original positive magnitude. Revoked allocations are never returned by
 * any route; this type is reached for ACTIVE allocations and, on same-key
 * replay, for a since-revoked creation.
 */
export interface TransactionAllocation {
  id: string;
  transactionId: string;
  householdId: string;
  payerUserId: string;
  currency: FinancialAccountCurrency;
  originalAmount: Money;
  participants: AllocationParticipantShare[];
  status: AllocationStatus;
  createdAt: string;
  revokedAt: string | null;
  transactionVersion: number;
}

export interface CreateAllocationInput {
  expectedVersion: number;
  participantUserIds: string[];
}

export interface MemberBalanceEntry {
  userId: string;
  membershipStatus: MembershipStatus;
  amount: string;
}

export interface MemberBalancesCurrencyGroup {
  currency: FinancialAccountCurrency;
  balances: MemberBalanceEntry[];
}

/**
 * Derived per-currency member balances from the household's active
 * allocations. Positive amounts mean the user is owed, negative amounts
 * mean the user owes, and each currency's balances sum to exactly zero.
 * Identity is the stable user UUID only; no email or profile data is
 * included, and there is no grand total or settlement in the contract.
 */
export interface MemberBalances {
  currencies: MemberBalancesCurrencyGroup[];
}

function unexpectedAllocationResponse(status: number): ApiError {
  return new ApiError({
    status,
    code: 'UNKNOWN_ERROR',
    message: 'The server returned an unexpected allocation response.',
  });
}

function allocationPath(householdId: string, transactionId: string): string {
  return `/api/households/${encodeURIComponent(householdId)}/transactions/${encodeURIComponent(transactionId)}/allocation`;
}

/**
 * A participant share is an unsigned aggregate amount at the exact scale
 * of the allocation's currency. Zero shares are legitimate (the remainder
 * rule can award no minor unit to the last participant), unlike stored
 * transaction amounts, so the aggregate grammar applies with a sign ban.
 */
function isShareMoney(
  value: unknown,
  currency: FinancialAccountCurrency,
): value is Money {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    typeof record.amount === 'string' &&
    typeof record.currency === 'string' &&
    record.currency === currency &&
    isAggregateAmountString(record.amount, currency) &&
    !record.amount.startsWith('-')
  );
}

function parseTransactionAllocation(
  value: unknown,
): TransactionAllocation | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  // Exactly the documented 11-field allocation DTO; any extra or missing
  // key is contract drift and must fail loudly rather than reach the UI.
  if (
    Object.keys(record).length !== 11 ||
    typeof record.id !== 'string' ||
    !UUID_PATTERN.test(record.id) ||
    typeof record.transactionId !== 'string' ||
    !UUID_PATTERN.test(record.transactionId) ||
    typeof record.householdId !== 'string' ||
    !UUID_PATTERN.test(record.householdId) ||
    typeof record.payerUserId !== 'string' ||
    !UUID_PATTERN.test(record.payerUserId) ||
    !isFinancialAccountCurrency(record.currency) ||
    !isMoney(record.originalAmount) ||
    !Array.isArray(record.participants) ||
    record.participants.length === 0 ||
    (record.status !== 'ACTIVE' && record.status !== 'REVOKED') ||
    (record.revokedAt !== null && typeof record.revokedAt !== 'string') ||
    (record.status === 'ACTIVE' && record.revokedAt !== null) ||
    (record.status === 'REVOKED' &&
      (typeof record.revokedAt !== 'string' ||
        record.revokedAt.length === 0)) ||
    typeof record.transactionVersion !== 'number' ||
    !Number.isInteger(record.transactionVersion) ||
    record.transactionVersion < 0 ||
    record.transactionVersion > 2147483647 ||
    typeof record.createdAt !== 'string' ||
    record.createdAt.length === 0
  ) {
    return undefined;
  }
  const currency = record.currency as FinancialAccountCurrency;
  const participants: AllocationParticipantShare[] = [];
  let previousUserId: string | undefined;
  for (const entry of record.participants) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    const participant = entry as Record<string, unknown>;
    if (
      Object.keys(participant).length !== 2 ||
      typeof participant.userId !== 'string' ||
      !UUID_PATTERN.test(participant.userId) ||
      !isShareMoney(participant.share, currency)
    ) {
      return undefined;
    }
    const userId = participant.userId;
    // The response is ordered ascending by canonical user UUID with no
    // duplicates; ordering is part of the contract, not presentation.
    const canonical = userId.toLowerCase();
    if (previousUserId !== undefined && canonical <= previousUserId) {
      return undefined;
    }
    previousUserId = canonical;
    participants.push({
      userId,
      share: {
        amount: (participant.share as Money).amount,
        currency: (participant.share as Money).currency,
      },
    });
  }
  // Shares sum exactly to the original positive magnitude.
  let sum = 0n;
  for (const participant of participants) {
    sum += minorUnitsOfMagnitude(participant.share.amount, currency);
  }
  const originalAmount = record.originalAmount as Money;
  if (originalAmount.amount.startsWith('-')) return undefined;
  if (sum !== minorUnitsOfMagnitude(originalAmount.amount, currency)) {
    return undefined;
  }
  return {
    id: record.id,
    transactionId: record.transactionId,
    householdId: record.householdId,
    payerUserId: record.payerUserId,
    currency,
    originalAmount: {
      amount: originalAmount.amount,
      currency: originalAmount.currency,
    },
    participants,
    status: record.status as AllocationStatus,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt === null ? null : (record.revokedAt as string),
    transactionVersion: record.transactionVersion,
  };
}

/**
 * The active allocation of an authorized expense. An authorized expense
 * without an active allocation — never-allocated or revoked — answers
 * `404 ALLOCATION_NOT_FOUND`, which callers read off the ApiError code; a
 * hidden, missing, or foreign expense answers the generic
 * `TRANSACTION_NOT_FOUND` 404 instead.
 */
export async function fetchTransactionAllocation(
  householdId: string,
  transactionId: string,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<TransactionAllocation> {
  const response = await apiFetch(
    allocationPath(householdId, transactionId),
    {
      method: 'GET',
      credentials: 'include',
      headers: { ...JSON_HEADERS },
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (!response.ok) {
    throw await parseErrorResponse(
      response,
      response.status === 401 ? 'UNAUTHENTICATED' : 'UNKNOWN_ERROR',
      'Could not load the allocation for this transaction.',
    );
  }
  const allocation = parseTransactionAllocation(
    await readJson<unknown>(response),
  );
  if (!allocation) throw unexpectedAllocationResponse(response.status);
  return allocation;
}

/**
 * Create the expense's allocation. One durable key per intent: a first
 * committed create returns 201 and a same-key replay returns 200 with the
 * current representation (possibly now revoked), so both statuses parse.
 */
export async function postTransactionAllocation(
  householdId: string,
  transactionId: string,
  input: CreateAllocationInput,
  idempotencyKey: string,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<TransactionAllocation> {
  const response = await apiFetch(
    allocationPath(householdId, transactionId),
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        ...unsafeHeaders(csrf),
        'Idempotency-Key': idempotencyKey,
      },
      cache: 'no-store',
      body: JSON.stringify(input),
    },
    signal,
    timeoutMs,
  );
  if (response.status === 200 || response.status === 201) {
    const allocation = parseTransactionAllocation(
      await readJson<unknown>(response),
    );
    if (!allocation) throw unexpectedAllocationResponse(response.status);
    return allocation;
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'Allocation creation could not be completed.',
  );
}

/**
 * Revoke the active allocation. PATCH carries no idempotency key: the
 * expectedVersion guard on the expense provides stale-retry protection,
 * and revocation bumps the expense version once.
 */
export async function patchAllocationRevoke(
  householdId: string,
  transactionId: string,
  expectedVersion: number,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<TransactionAllocation> {
  const response = await apiFetch(
    allocationPath(householdId, transactionId),
    {
      method: 'PATCH',
      credentials: 'include',
      headers: unsafeHeaders(csrf),
      cache: 'no-store',
      body: JSON.stringify({ expectedVersion, status: 'REVOKED' }),
    },
    signal,
    timeoutMs,
  );
  if (response.status === 200) {
    const allocation = parseTransactionAllocation(
      await readJson<unknown>(response),
    );
    if (!allocation) throw unexpectedAllocationResponse(response.status);
    return allocation;
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'Allocation revocation could not be completed.',
  );
}

function unexpectedBalancesResponse(status: number): ApiError {
  return new ApiError({
    status,
    code: 'UNKNOWN_ERROR',
    message: 'The server returned an unexpected member-balances response.',
  });
}

function parseMemberBalances(value: unknown): MemberBalances | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== 'currencies') return undefined;
  if (!Array.isArray(record.currencies)) return undefined;
  const groups: MemberBalancesCurrencyGroup[] = [];
  let previousCurrency: string | undefined;
  for (const entry of record.currencies) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    const group = entry as Record<string, unknown>;
    if (
      Object.keys(group).length !== 2 ||
      !isFinancialAccountCurrency(group.currency) ||
      !Array.isArray(group.balances)
    ) {
      return undefined;
    }
    // Currencies are ordered by code with no duplicates.
    if (previousCurrency !== undefined && group.currency <= previousCurrency) {
      return undefined;
    }
    previousCurrency = group.currency;
    const balances: MemberBalanceEntry[] = [];
    let previousUserId: string | undefined;
    for (const balanceValue of group.balances) {
      if (
        typeof balanceValue !== 'object' ||
        balanceValue === null ||
        Array.isArray(balanceValue)
      ) {
        return undefined;
      }
      const balance = balanceValue as Record<string, unknown>;
      if (
        Object.keys(balance).length !== 3 ||
        typeof balance.userId !== 'string' ||
        !UUID_PATTERN.test(balance.userId) ||
        (balance.membershipStatus !== 'CURRENT' &&
          balance.membershipStatus !== 'DEPARTED') ||
        typeof balance.amount !== 'string' ||
        !isAggregateAmountString(balance.amount, group.currency)
      ) {
        return undefined;
      }
      const canonical = balance.userId.toLowerCase();
      if (previousUserId !== undefined && canonical <= previousUserId) {
        return undefined;
      }
      previousUserId = canonical;
      balances.push({
        userId: balance.userId,
        membershipStatus: balance.membershipStatus as MembershipStatus,
        amount: balance.amount,
      });
    }
    groups.push({
      currency: group.currency,
      balances,
    });
  }
  return { currencies: groups };
}

/**
 * Derived member balances for the household, grouped by currency. A
 * household with no contributing allocations answers `currencies: []`;
 * the empty state invents no values.
 */
export async function fetchMemberBalances(
  householdId: string,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<MemberBalances> {
  const response = await apiFetch(
    `/api/households/${encodeURIComponent(householdId)}/member-balances`,
    {
      method: 'GET',
      credentials: 'include',
      headers: { ...JSON_HEADERS },
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (!response.ok) {
    throw await parseErrorResponse(
      response,
      response.status === 401 ? 'UNAUTHENTICATED' : 'UNKNOWN_ERROR',
      'Could not load household member balances.',
    );
  }
  const balances = parseMemberBalances(await readJson<unknown>(response));
  if (!balances) throw unexpectedBalancesResponse(response.status);
  return balances;
}

/**
 * Household reporting zone. Every current member may read it; only
 * the household OWNER may change it. The response carries exactly the stored
 * IANA zone and the optimistic-concurrency version, initially
 * `{"reportingTimeZone":"Etc/UTC","version":0}`.
 */
export interface FinanceSettings {
  reportingTimeZone: string;
  version: number;
}

export interface UpdateFinanceSettingsInput {
  reportingTimeZone: string;
  expectedVersion: number;
}

function parseFinanceSettings(value: unknown): FinanceSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  // Exactly the documented two-field DTO; any extra or missing key is
  // contract drift and must fail loudly rather than reach the UI.
  if (
    Object.keys(record).length !== 2 ||
    typeof record.reportingTimeZone !== 'string' ||
    !isRegionShapedZone(record.reportingTimeZone as string) ||
    typeof record.version !== 'number' ||
    !Number.isInteger(record.version) ||
    (record.version as number) < 0 ||
    (record.version as number) > 2147483647
  ) {
    return undefined;
  }
  return {
    reportingTimeZone: record.reportingTimeZone as string,
    version: record.version as number,
  };
}

function unexpectedFinanceSettingsResponse(status: number): ApiError {
  return new ApiError({
    status,
    code: 'UNKNOWN_ERROR',
    message: 'The server returned an unexpected reporting-settings response.',
  });
}

function financeSettingsPath(householdId: string): string {
  return `/api/households/${encodeURIComponent(householdId)}/finance-settings`;
}

export async function fetchFinanceSettings(
  householdId: string,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<FinanceSettings> {
  const response = await apiFetch(
    financeSettingsPath(householdId),
    {
      method: 'GET',
      credentials: 'include',
      headers: { ...JSON_HEADERS },
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (!response.ok) {
    throw await parseErrorResponse(
      response,
      response.status === 401 ? 'UNAUTHENTICATED' : 'UNKNOWN_ERROR',
      'Could not load household reporting settings.',
    );
  }
  const settings = parseFinanceSettings(await readJson<unknown>(response));
  if (!settings) throw unexpectedFinanceSettingsResponse(response.status);
  return settings;
}

/**
 * Change the household reporting zone. The request carries exactly the new
 * zone and the version the editor saw; a stale version answers
 * `409 RESOURCE_VERSION_CONFLICT` and the caller reloads before offering a
 * correction rather than resending blindly.
 */
export async function patchFinanceSettings(
  householdId: string,
  input: UpdateFinanceSettingsInput,
  csrf: CsrfToken,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<FinanceSettings> {
  const response = await apiFetch(
    financeSettingsPath(householdId),
    {
      method: 'PATCH',
      credentials: 'include',
      headers: unsafeHeaders(csrf),
      cache: 'no-store',
      body: JSON.stringify(input),
    },
    signal,
    timeoutMs,
  );
  if (response.status === 200) {
    const settings = parseFinanceSettings(await readJson<unknown>(response));
    if (!settings) throw unexpectedFinanceSettingsResponse(response.status);
    return settings;
  }
  throw await parseErrorResponse(
    response,
    response.status === 400 ? 'VALIDATION_FAILED' : 'UNKNOWN_ERROR',
    'The reporting zone change could not be completed.',
  );
}

export interface SpendingSummaryCurrencyGroup {
  currency: FinancialAccountCurrency;
  expenseTotal: string;
  refundTotal: string;
  netSpending: string;
  incomeTotal: string;
}

/**
 * Exact per-currency household spending for an explicit half-open
 * `[from, to)` date interval. Expense, refund, and income totals are
 * nonnegative magnitudes; `netSpending` is `expenseTotal - refundTotal` and
 * may be negative in a refund-heavy period. There is no all-currency grand
 * total and no member balance in this response; an interval with no
 * contributing entries answers `currencies: []` without inventing a
 * default-currency zero.
 */
export interface SpendingSummary {
  from: string;
  to: string;
  reportingTimeZone: string;
  currencies: SpendingSummaryCurrencyGroup[];
}

const REPORT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Report/filter boundary dates range from `1900-01-01` through `9999-12-31`
 * so the final supported transaction date stays queryable in a half-open
 * interval; transaction dates themselves stop at `9999-12-30`.
 */
function isReportBoundaryDate(value: string): boolean {
  if (!REPORT_DATE_PATTERN.test(value)) return false;
  if (value < '1900-01-01' || value > '9999-12-31') return false;
  const [year, month, day] = value.split('-').map((part) => Number(part));
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

/** Signed exact minor units for an aggregate amount at the currency scale. */
function signedMinorUnitsOfAggregate(
  amount: string,
  currency: FinancialAccountCurrency,
): bigint {
  const negative = amount.startsWith('-');
  const magnitude = negative ? amount.slice(1) : amount;
  const units = minorUnitsOfMagnitude(magnitude, currency);
  return negative ? -units : units;
}

function unexpectedSpendingSummaryResponse(status: number): ApiError {
  return new ApiError({
    status,
    code: 'UNKNOWN_ERROR',
    message: 'The server returned an unexpected spending-summary response.',
  });
}

function parseSpendingSummary(value: unknown): SpendingSummary | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  // Exactly the documented four-field summary DTO; any extra or missing key
  // is contract drift and must fail loudly rather than reach the UI.
  if (
    Object.keys(record).length !== 4 ||
    typeof record.from !== 'string' ||
    !isReportBoundaryDate(record.from) ||
    typeof record.to !== 'string' ||
    !isReportBoundaryDate(record.to) ||
    (record.from as string) >= (record.to as string) ||
    typeof record.reportingTimeZone !== 'string' ||
    !isRegionShapedZone(record.reportingTimeZone as string) ||
    !Array.isArray(record.currencies)
  ) {
    return undefined;
  }
  const groups: SpendingSummaryCurrencyGroup[] = [];
  let previousCurrency: string | undefined;
  for (const entry of record.currencies) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    const group = entry as Record<string, unknown>;
    if (
      Object.keys(group).length !== 5 ||
      !isFinancialAccountCurrency(group.currency) ||
      typeof group.expenseTotal !== 'string' ||
      typeof group.refundTotal !== 'string' ||
      typeof group.netSpending !== 'string' ||
      typeof group.incomeTotal !== 'string'
    ) {
      return undefined;
    }
    const currency = group.currency as FinancialAccountCurrency;
    // Currency groups are ordered by code with no duplicates.
    if (previousCurrency !== undefined && currency <= previousCurrency) {
      return undefined;
    }
    previousCurrency = currency;
    const expenseTotal = group.expenseTotal as string;
    const refundTotal = group.refundTotal as string;
    const netSpending = group.netSpending as string;
    const incomeTotal = group.incomeTotal as string;
    if (
      !isAggregateAmountString(expenseTotal, currency) ||
      expenseTotal.startsWith('-') ||
      !isAggregateAmountString(refundTotal, currency) ||
      refundTotal.startsWith('-') ||
      !isAggregateAmountString(netSpending, currency) ||
      !isAggregateAmountString(incomeTotal, currency) ||
      incomeTotal.startsWith('-')
    ) {
      return undefined;
    }
    // The contract's net identity holds exactly: a drifted net is a server
    // bug the UI must not silently display.
    const expectedNet =
      signedMinorUnitsOfAggregate(expenseTotal, currency) -
      signedMinorUnitsOfAggregate(refundTotal, currency);
    if (expectedNet !== signedMinorUnitsOfAggregate(netSpending, currency)) {
      return undefined;
    }
    groups.push({
      currency,
      expenseTotal,
      refundTotal,
      netSpending,
      incomeTotal,
    });
  }
  return {
    from: record.from as string,
    to: record.to as string,
    reportingTimeZone: record.reportingTimeZone as string,
    currencies: groups,
  };
}

/**
 * Exact spending for one explicit date interval. Both bounds are required
 * and travel as the only query parameters; the server applies the interval
 * to stored calendar dates without timestamp conversion.
 */
export async function fetchSpendingSummary(
  householdId: string,
  from: string,
  to: string,
  signal?: AbortSignal,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<SpendingSummary> {
  const response = await apiFetch(
    `/api/households/${encodeURIComponent(householdId)}/spending-summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    {
      method: 'GET',
      credentials: 'include',
      headers: { ...JSON_HEADERS },
      cache: 'no-store',
    },
    signal,
    timeoutMs,
  );
  if (!response.ok) {
    throw await parseErrorResponse(
      response,
      response.status === 401 ? 'UNAUTHENTICATED' : 'UNKNOWN_ERROR',
      'Could not load the household spending summary.',
    );
  }
  const summary = parseSpendingSummary(await readJson<unknown>(response));
  if (!summary) throw unexpectedSpendingSummaryResponse(response.status);
  return summary;
}
