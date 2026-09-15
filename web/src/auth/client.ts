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
        key === 'role') &&
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
