import {
  isAggregateAmountString,
  isFinancialAccountCurrency,
  isSupportedAmountString,
  isSupportedTransactionDate,
  minorUnitsOfMagnitude,
  type FinancialAccountCurrency,
} from '../finance/money';

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
  | 'TRANSACTION_NOT_FOUND'
  | 'ACCOUNT_ARCHIVED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RESOURCE_VERSION_CONFLICT'
  | 'RESOURCE_VERSION_EXHAUSTED'
  | 'REFUND_CONFLICT'
  | 'TRANSACTION_VOIDED'
  | 'ALLOCATION_NOT_FOUND'
  | 'ALLOCATION_CONFLICT'
  | 'FINANCE_BUSY'
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
    'TRANSACTION_NOT_FOUND',
    'ACCOUNT_ARCHIVED',
    'IDEMPOTENCY_CONFLICT',
    'RESOURCE_VERSION_CONFLICT',
    'RESOURCE_VERSION_EXHAUSTED',
    'REFUND_CONFLICT',
    'TRANSACTION_VOIDED',
    'ALLOCATION_NOT_FOUND',
    'ALLOCATION_CONFLICT',
    'FINANCE_BUSY',
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
        key === 'money.amount' ||
        key === 'money.currency') &&
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

export interface FinancialAccount {
  id: string;
  householdId: string;
  ownerUserId: string;
  name: string;
  kind: FinancialAccountKind;
  currency: FinancialAccountCurrency;
  source: 'MANUAL';
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
    record.source !== 'MANUAL' ||
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
  source: 'MANUAL';
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
    record.source !== 'MANUAL' ||
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
    source: 'MANUAL',
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
