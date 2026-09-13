import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  deleteInvitation,
  fetchInvitations,
  postInvitation,
  postInvitationAccept,
  postInvitationPreview,
} from '../auth/client';

const CSRF = { token: 'csrf-token-1', headerName: 'X-CSRF-TOKEN' };
const HOUSEHOLD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const INVITATION_ID = '11111111-2222-4333-8444-555555555555';
const SECRET = 'hGgem9rtrw2Z_PHXg76mXTNiof78wQArhcJVnsxQK6A';
const CREDENTIAL = { invitationId: INVITATION_ID, secret: SECRET };

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return headers === undefined
    ? Response.json(body, { status })
    : Response.json(body, { status, headers });
}

function validCapability() {
  return {
    id: INVITATION_ID,
    secret: SECRET,
    createdAt: '2026-09-13T04:00:00Z',
    expiresAt: '2026-09-20T04:00:00Z',
  };
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      return handler(url, init);
    }),
  );
  return calls;
}

describe('invitation typed client', () => {
  it('creates with an empty body, CSRF, credentials, and no-store', async () => {
    const calls = stubFetch((url) => {
      expect(url).toBe(`/api/households/${HOUSEHOLD_ID}/invitations`);
      return jsonResponse(
        {
          id: INVITATION_ID,
          secret: SECRET,
          createdAt: '2026-09-13T04:00:00Z',
          expiresAt: '2026-09-20T04:00:00Z',
        },
        201,
      );
    });
    const created = await postInvitation(HOUSEHOLD_ID, CSRF);
    expect(created).toEqual({
      id: INVITATION_ID,
      secret: SECRET,
      createdAt: '2026-09-13T04:00:00Z',
      expiresAt: '2026-09-20T04:00:00Z',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.credentials).toBe('include');
    expect(calls[0]?.init?.cache).toBe('no-store');
    expect(calls[0]?.init?.headers).toMatchObject({
      'X-CSRF-TOKEN': CSRF.token,
    });
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it('lists active invitations without exposing secret material', async () => {
    stubFetch(() =>
      jsonResponse({
        invitations: [
          {
            id: INVITATION_ID,
            createdAt: '2026-09-13T04:00:00Z',
            expiresAt: '2026-09-20T04:00:00Z',
            secret: 'must-be-ignored-if-present',
          },
        ],
      }),
    );
    const list = await fetchInvitations(HOUSEHOLD_ID);
    expect(list).toEqual([
      {
        id: INVITATION_ID,
        createdAt: '2026-09-13T04:00:00Z',
        expiresAt: '2026-09-20T04:00:00Z',
      },
    ]);
    expect('secret' in (list[0] as unknown as Record<string, unknown>)).toBe(
      false,
    );
  });

  it('revokes with a bodyless 204 and a scoped path', async () => {
    let textCalled = false;
    const calls = stubFetch(() => {
      return {
        status: 204,
        ok: true,
        headers: new Headers(),
        text: () => {
          textCalled = true;
          return Promise.resolve('');
        },
      } as unknown as Response;
    });
    await deleteInvitation(HOUSEHOLD_ID, INVITATION_ID, CSRF);
    expect(calls[0]?.url).toBe(
      `/api/households/${HOUSEHOLD_ID}/invitations/${INVITATION_ID}`,
    );
    expect(calls[0]?.init?.method).toBe('DELETE');
    expect(textCalled).toBe(false);
  });

  it('previews the minimal household name, member role, and expiry', async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        householdName: 'Elm Street home',
        role: 'MEMBER',
        expiresAt: '2026-09-20T04:00:00Z',
      }),
    );
    const preview = await postInvitationPreview(CREDENTIAL, CSRF);
    expect(preview).toEqual({
      householdName: 'Elm Street home',
      role: 'MEMBER',
      expiresAt: '2026-09-20T04:00:00Z',
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(CREDENTIAL);
    expect(calls[0]?.init?.cache).toBe('no-store');
  });

  it('rejects a preview with an unexpected role as malformed', async () => {
    stubFetch(() =>
      jsonResponse({
        householdName: 'Elm Street home',
        role: 'OWNER',
        expiresAt: '2026-09-20T04:00:00Z',
      }),
    );
    const failure = await postInvitationPreview(CREDENTIAL, CSRF).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure as ApiError).toMatchObject({ code: 'UNKNOWN_ERROR' });
  });

  it('accepts and returns the authorized household response', async () => {
    stubFetch(() =>
      jsonResponse({
        id: HOUSEHOLD_ID,
        name: 'Elm Street home',
        role: 'MEMBER',
        createdAt: '2026-09-13T01:30:00Z',
      }),
    );
    const household = await postInvitationAccept(CREDENTIAL, CSRF);
    expect(household).toEqual({
      id: HOUSEHOLD_ID,
      name: 'Elm Street home',
      role: 'MEMBER',
      createdAt: '2026-09-13T01:30:00Z',
    });
  });

  it('preserves INVITATION_NOT_FOUND with correlation and safe field errors', async () => {
    stubFetch(() =>
      jsonResponse(
        {
          code: 'INVITATION_NOT_FOUND',
          message: 'Invitation is invalid or no longer available.',
          correlationId: 'corr-invite',
          fieldErrors: {
            secret: 'Enter a valid invitation secret.',
            injected: 'must-be-dropped',
          },
        },
        404,
      ),
    );
    const failure = await postInvitationPreview(CREDENTIAL, CSRF).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    const apiError = failure as ApiError;
    expect(apiError.code).toBe('INVITATION_NOT_FOUND');
    expect(apiError.correlationId).toBe('corr-invite');
    expect(apiError.fieldErrors).toEqual({
      secret: 'Enter a valid invitation secret.',
    });
  });

  it('maps expired sessions to unauthenticated without leaking the secret', async () => {
    stubFetch(() =>
      jsonResponse(
        { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
        401,
      ),
    );
    const failure = await postInvitationAccept(CREDENTIAL, CSRF).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure as ApiError).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(String((failure as ApiError).message)).not.toContain(SECRET);
  });

  it('rejects a malformed create response as a safe unexpected response', async () => {
    const malformed = [
      // Non-UUID invitation id.
      { ...validCapability(), id: 'not-a-uuid' },
      // Short secret.
      { ...validCapability(), secret: 'too-short' },
      // Padded encoding.
      { ...validCapability(), secret: `${SECRET}=` },
      // Correct shape but nonzero spare bits: not canonical 32-byte form.
      {
        ...validCapability(),
        secret: 'hGgem9rtrw2Z_PHXg76mXTNiof78wQArhcJVnsxQK6B',
      },
      // Missing expiry.
      { id: INVITATION_ID, secret: SECRET, createdAt: '2026-09-13T04:00:00Z' },
    ];
    for (const body of malformed) {
      stubFetch(() => jsonResponse(body, 201));
      const failure = await postInvitation(HOUSEHOLD_ID, CSRF).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure as ApiError).toMatchObject({ code: 'UNKNOWN_ERROR' });
      expect(String((failure as ApiError).message)).not.toContain(SECRET);
    }
  });

  it('degrades unknown error codes to a safe fallback', async () => {
    stubFetch(() => jsonResponse({ code: 'MADE_UP', message: '' }, 500));
    const failure = await fetchInvitations(HOUSEHOLD_ID).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure as ApiError).toMatchObject({ code: 'UNKNOWN_ERROR' });
  });
});
