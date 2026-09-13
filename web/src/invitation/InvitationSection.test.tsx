import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InvitationSection } from './InvitationSection';

const CSRF = { token: 'csrf-token-1', headerName: 'X-CSRF-TOKEN' };
const CSRF_FRESH = { token: 'csrf-token-2', headerName: 'X-CSRF-TOKEN' };
const HOUSEHOLD = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  name: 'Elm Street home',
  role: 'OWNER' as const,
  createdAt: '2026-09-13T01:30:00Z',
};
const MEMBER_HOUSEHOLD = { ...HOUSEHOLD, role: 'MEMBER' as const };
const INVITATION_ID = '11111111-2222-4333-8444-555555555555';
const SECRET = 'hGgem9rtrw2Z_PHXg76mXTNiof78wQArhcJVnsxQK6A';
const CREATED = {
  id: INVITATION_ID,
  secret: SECRET,
  createdAt: '2026-09-13T04:00:00Z',
  expiresAt: '2026-09-20T04:00:00Z',
};

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

interface RouteHandlers {
  invitationsGet?: () => Response | Promise<Response>;
  invitationsPost?: () => Response | Promise<Response>;
  invitationsDelete?: (invitationId?: string) => Response | Promise<Response>;
  csrf?: () => Response | Promise<Response>;
}

function stubFetch(routes: RouteHandlers) {
  const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
  const mock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      if (url === '/api/auth/csrf') {
        return (routes.csrf?.() ?? jsonResponse(CSRF)) as Response;
      }
      const base = `/api/households/${HOUSEHOLD.id}/invitations`;
      if (url === base && (init?.method ?? 'GET') === 'GET') {
        return (routes.invitationsGet?.() ??
          jsonResponse({ invitations: [] })) as Response;
      }
      if (url === base && init?.method === 'POST') {
        if (!routes.invitationsPost) throw new Error('unexpected POST');
        return routes.invitationsPost() as Response;
      }
      if (url.startsWith(`${base}/`) && init?.method === 'DELETE') {
        if (!routes.invitationsDelete) throw new Error('unexpected DELETE');
        const invitationId = decodeURIComponent(url.slice(base.length + 1));
        return routes.invitationsDelete(invitationId) as Response;
      }
      throw new Error(`unexpected fetch ${url} ${init?.method ?? ''}`);
    },
  );
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

function renderOwner(
  routes: RouteHandlers = {},
  onHouseholdAccessChanged: () => void = () => {},
) {
  const { calls } = stubFetch(routes);
  const onSessionExpired = vi.fn();
  const onCsrfRefreshed = vi.fn();
  render(
    <InvitationSection
      household={HOUSEHOLD}
      csrf={CSRF}
      onCsrfRefreshed={onCsrfRefreshed}
      onSessionExpired={onSessionExpired}
      onHouseholdAccessChanged={onHouseholdAccessChanged}
    />,
  );
  return { calls, onSessionExpired, onCsrfRefreshed, onHouseholdAccessChanged };
}

describe('owner gating', () => {
  it('renders no owner controls for the current member role', async () => {
    const { calls } = stubFetch({});
    const { container } = render(
      <InvitationSection
        household={MEMBER_HOUSEHOLD}
        csrf={CSRF}
        onCsrfRefreshed={() => {}}
        onSessionExpired={() => {}}
      />,
    );
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(
      calls.filter(({ url }) => url.includes('/invitations')),
    ).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /invitation/i })).toBeNull();
  });
});

describe('owner list and create', () => {
  it('shows the empty state and offers creation after a confirmed list', async () => {
    renderOwner();
    expect(
      await screen.findByText(/No active invitations/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create invitation' }),
    ).toBeInTheDocument();
  });

  it('creates once, shows the one-time link with a warning, and lists it', async () => {
    const { calls } = renderOwner({
      invitationsPost: () => jsonResponse(CREATED, 201),
    });
    await screen.findByRole('button', { name: 'Create invitation' });
    fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    const field = (await screen.findByLabelText(
      'Invitation link (shown once)',
    )) as HTMLInputElement;
    expect(field.value).toBe(
      `${window.location.origin}/join/${INVITATION_ID}#invite=${SECRET}`,
    );
    expect(screen.getByText(/shown once — copy it now/i)).toBeInTheDocument();
    expect(screen.getByText(/Share it privately/i)).toBeInTheDocument();
    expect(screen.getByText(/1 active invitation\./)).toBeInTheDocument();
    const posts = calls.filter(
      ({ url, init }) =>
        url === `/api/households/${HOUSEHOLD.id}/invitations` &&
        init?.method === 'POST',
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]?.init?.body).toBeUndefined();
  });

  it('discards the one-time display locally without revoking', async () => {
    const { calls } = renderOwner({
      invitationsPost: () => jsonResponse(CREATED, 201),
    });
    await screen.findByRole('button', { name: 'Create invitation' });
    fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    await screen.findByLabelText('Invitation link (shown once)');
    fireEvent.click(
      screen.getByRole('button', { name: 'Discard link display' }),
    );
    await waitFor(() =>
      expect(
        screen.queryByLabelText('Invitation link (shown once)'),
      ).not.toBeInTheDocument(),
    );
    // The invitation stays active; nothing was revoked server-side.
    expect(screen.getByText(/1 active invitation\./)).toBeInTheDocument();
    expect(calls.filter(({ init }) => init?.method === 'DELETE')).toHaveLength(
      0,
    );
  });

  it('copies through the clipboard when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const saved = (navigator as unknown as Record<string, unknown>).clipboard;
    (navigator as unknown as Record<string, unknown>).clipboard = {
      writeText,
    };
    try {
      renderOwner({ invitationsPost: () => jsonResponse(CREATED, 201) });
      await screen.findByRole('button', { name: 'Create invitation' });
      fireEvent.click(
        screen.getByRole('button', { name: 'Create invitation' }),
      );
      await screen.findByLabelText('Invitation link (shown once)');
      fireEvent.click(
        screen.getByRole('button', { name: 'Copy invitation link' }),
      );
      expect(await screen.findByText(/Link copied\./)).toBeInTheDocument();
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(String(writeText.mock.calls[0]?.[0])).toContain(
        `#invite=${SECRET}`,
      );
    } finally {
      if (saved === undefined) {
        delete (navigator as unknown as Record<string, unknown>).clipboard;
      } else {
        (navigator as unknown as Record<string, unknown>).clipboard = saved;
      }
    }
  });

  it('leaves a manual-copy path when automatic copy fails', async () => {
    const saved = (navigator as unknown as Record<string, unknown>).clipboard;
    delete (navigator as unknown as Record<string, unknown>).clipboard;
    try {
      renderOwner({ invitationsPost: () => jsonResponse(CREATED, 201) });
      await screen.findByRole('button', { name: 'Create invitation' });
      fireEvent.click(
        screen.getByRole('button', { name: 'Create invitation' }),
      );
      const field = (await screen.findByLabelText(
        'Invitation link (shown once)',
      )) as HTMLInputElement;
      fireEvent.click(
        screen.getByRole('button', { name: 'Copy invitation link' }),
      );
      expect(
        await screen.findByText(/Select the link above and copy it manually/i),
      ).toBeInTheDocument();
      // The full link stays available for manual copying.
      expect(field.value).toContain(`#invite=${SECRET}`);
    } finally {
      if (saved !== undefined) {
        (navigator as unknown as Record<string, unknown>).clipboard = saved;
      }
    }
  });
});

describe('owner revocation', () => {
  it('revokes an active invitation and removes it from the list', async () => {
    const { calls } = renderOwner({
      invitationsGet: () =>
        jsonResponse({
          invitations: [
            {
              id: INVITATION_ID,
              createdAt: CREATED.createdAt,
              expiresAt: CREATED.expiresAt,
            },
          ],
        }),
      invitationsDelete: () => new Response(null, { status: 204 }),
    });
    await screen.findByRole('button', { name: /Revoke invitation/ });
    fireEvent.click(screen.getByRole('button', { name: /Revoke invitation/ }));
    expect(await screen.findByText('Invitation revoked.')).toBeInTheDocument();
    expect(screen.getByText(/No active invitations/)).toBeInTheDocument();
    const deletes = calls.filter(({ init }) => init?.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.url).toBe(
      `/api/households/${HOUSEHOLD.id}/invitations/${INVITATION_ID}`,
    );
    expect(deletes[0]?.init?.headers).toMatchObject({
      'X-CSRF-TOKEN': CSRF.token,
    });
  });

  it('removes the dead row and refreshes after a terminal revoke', async () => {
    let getCalls = 0;
    let resolveReload!: (response: Response) => void;
    const reloadGate = new Promise<Response>((resolve) => {
      resolveReload = resolve;
    });
    renderOwner({
      invitationsGet: () => {
        getCalls += 1;
        if (getCalls === 1) {
          return jsonResponse({
            invitations: [
              {
                id: INVITATION_ID,
                createdAt: CREATED.createdAt,
                expiresAt: CREATED.expiresAt,
              },
            ],
          });
        }
        return reloadGate;
      },
      invitationsDelete: () =>
        jsonResponse(
          {
            code: 'INVITATION_NOT_FOUND',
            message: 'Invitation is invalid or no longer available.',
            correlationId: 'corr-gone',
          },
          404,
        ),
    });
    await screen.findByRole('button', { name: /Revoke invitation/ });
    fireEvent.click(screen.getByRole('button', { name: /Revoke invitation/ }));
    // The dead row is removed locally even while the confirming reload is
    // still gated: the reload must not be blocked by the finished revoke.
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /Revoke invitation/ }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByText(/already unavailable\. It was removed/i),
    ).toBeInTheDocument();
    await waitFor(() => expect(getCalls).toBe(2));
    resolveReload(jsonResponse({ invitations: [] }));
    expect(
      await screen.findByText(/No active invitations/),
    ).toBeInTheDocument();
  });

  it('names each revoke control with its stable list position', async () => {
    const secondId = '33333333-4444-4555-8666-777777777777';
    const deleted: string[] = [];
    renderOwner({
      invitationsGet: () =>
        jsonResponse({
          invitations: [
            {
              id: INVITATION_ID,
              createdAt: CREATED.createdAt,
              expiresAt: CREATED.expiresAt,
            },
            {
              id: secondId,
              createdAt: CREATED.createdAt,
              expiresAt: CREATED.expiresAt,
            },
          ],
        }),
      invitationsDelete: (invitationId) => {
        if (invitationId) deleted.push(invitationId);
        return new Response(null, { status: 204 });
      },
    });
    const first = await screen.findByRole('button', {
      name: /Revoke invitation 1 of 2, expiring /,
    });
    expect(first.getAttribute('aria-label')).toMatch(
      /^Revoke invitation 1 of 2, expiring /,
    );
    const second = await screen.findByRole('button', {
      name: /Revoke invitation 2 of 2, expiring /,
    });
    // The accessible names carry no secret material.
    expect(document.body.textContent).not.toContain(SECRET);
    fireEvent.click(second);
    expect(await screen.findByText('Invitation revoked.')).toBeInTheDocument();
    expect(deleted).toEqual([secondId]);
    expect(
      screen.getByRole('button', { name: /Revoke invitation 1 of 1/ }),
    ).toBeInTheDocument();
  });
});

describe('owner recovery', () => {
  it('runs sign-in-again recovery and clears invitations on 401', async () => {
    const { onSessionExpired } = renderOwner({
      invitationsGet: () =>
        jsonResponse(
          { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
          401,
        ),
    });
    await waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole('button', { name: 'Create invitation' }),
    ).toBeNull();
  });

  it('refreshes CSRF on rejection and requires an explicit retry without replay', async () => {
    let postCalls = 0;
    renderOwner({
      csrf: () => jsonResponse(CSRF_FRESH),
      invitationsPost: () => {
        postCalls += 1;
        if (postCalls === 1) {
          return jsonResponse(
            {
              code: 'CSRF_INVALID',
              message: 'Invalid CSRF token.',
              correlationId: 'corr-csrf',
            },
            403,
          );
        }
        return jsonResponse(CREATED, 201);
      },
    });
    await screen.findByRole('button', { name: 'Create invitation' });
    fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    expect(
      await screen.findByText(/security token was refreshed/i),
    ).toBeInTheDocument();
    expect(postCalls).toBe(1);
    expect(
      screen.queryByLabelText('Invitation link (shown once)'),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    expect(
      await screen.findByLabelText('Invitation link (shown once)'),
    ).toBeInTheDocument();
    expect(postCalls).toBe(2);
  });

  it('offers household-list recovery when creation reports changed access', async () => {
    const onHouseholdAccessChanged = vi.fn();
    renderOwner(
      {
        invitationsPost: () =>
          jsonResponse(
            {
              code: 'FORBIDDEN',
              message: 'Only owners may invite.',
              correlationId: 'corr-role',
            },
            403,
          ),
      },
      onHouseholdAccessChanged,
    );
    await screen.findByRole('button', { name: 'Create invitation' });
    fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    expect(
      await screen.findByText(/access to this household may have changed/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Invitation link (shown once)'),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh household list' }),
    );
    expect(onHouseholdAccessChanged).toHaveBeenCalledTimes(1);
  });

  it('offers household-list recovery when revocation reports a missing household', async () => {
    const onHouseholdAccessChanged = vi.fn();
    renderOwner(
      {
        invitationsGet: () =>
          jsonResponse({
            invitations: [
              {
                id: INVITATION_ID,
                createdAt: CREATED.createdAt,
                expiresAt: CREATED.expiresAt,
              },
            ],
          }),
        invitationsDelete: () =>
          jsonResponse(
            {
              code: 'HOUSEHOLD_NOT_FOUND',
              message: 'Household not found.',
              correlationId: 'corr-hh',
            },
            404,
          ),
      },
      onHouseholdAccessChanged,
    );
    await screen.findByRole('button', { name: /Revoke invitation/ });
    fireEvent.click(screen.getByRole('button', { name: /Revoke invitation/ }));
    expect(
      await screen.findByText(/access to this household may have changed/i),
    ).toBeInTheDocument();
    // The row stays until the household refresh confirms the new access.
    expect(
      screen.getByRole('button', { name: /Revoke invitation/ }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh household list' }),
    );
    expect(onHouseholdAccessChanged).toHaveBeenCalledTimes(1);
  });

  it('offers household-list recovery when the invitation list reports changed access', async () => {
    const onHouseholdAccessChanged = vi.fn();
    renderOwner(
      {
        invitationsGet: () =>
          jsonResponse(
            {
              code: 'FORBIDDEN',
              message: 'Only owners may invite.',
              correlationId: 'corr-list',
            },
            403,
          ),
      },
      onHouseholdAccessChanged,
    );
    expect(
      await screen.findByText(/access to this household may have changed/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Create invitation' }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh household list' }),
    );
    expect(onHouseholdAccessChanged).toHaveBeenCalledTimes(1);
  });

  it('reports an unknown create outcome and offers refresh without resubmitting', async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/auth/csrf') return jsonResponse(CSRF);
        const base = `/api/households/${HOUSEHOLD.id}/invitations`;
        if (url === base && (init?.method ?? 'GET') === 'GET') {
          return jsonResponse({ invitations: [] });
        }
        if (url === base && init?.method === 'POST') {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted.', 'AbortError'));
            });
          });
        }
        throw new Error(`unexpected ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    render(
      <InvitationSection
        household={HOUSEHOLD}
        csrf={CSRF}
        onCsrfRefreshed={() => {}}
        onSessionExpired={() => {}}
      />,
    );
    await screen.findByRole('button', { name: 'Create invitation' });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(
      screen.getByText(/outcome is unknown — refresh the list/i),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url) === `/api/households/${HOUSEHOLD.id}/invitations` &&
          (init as RequestInit | undefined)?.method === 'POST',
      ),
    ).toHaveLength(1);
    vi.useRealTimers();
    const refreshButtons = screen.getAllByRole('button', {
      name: 'Refresh invitations',
    });
    fireEvent.click(refreshButtons[refreshButtons.length - 1]!);
    await waitFor(() =>
      expect(screen.queryByText(/outcome is unknown/i)).not.toBeInTheDocument(),
    );
  });

  it('reports an unknown revoke outcome and offers refresh without resubmitting', async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/auth/csrf') return jsonResponse(CSRF);
        const base = `/api/households/${HOUSEHOLD.id}/invitations`;
        if (url === base && (init?.method ?? 'GET') === 'GET') {
          return jsonResponse({
            invitations: [
              {
                id: INVITATION_ID,
                createdAt: CREATED.createdAt,
                expiresAt: CREATED.expiresAt,
              },
            ],
          });
        }
        if (url === `${base}/${INVITATION_ID}` && init?.method === 'DELETE') {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted.', 'AbortError'));
            });
          });
        }
        throw new Error(`unexpected ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    render(
      <InvitationSection
        household={HOUSEHOLD}
        csrf={CSRF}
        onCsrfRefreshed={() => {}}
        onSessionExpired={() => {}}
      />,
    );
    await screen.findByRole('button', { name: /Revoke invitation/ });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: /Revoke invitation/ }));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(
      screen.getByText(/Revocation timed out\. Its outcome is unknown/i),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
      ),
    ).toHaveLength(1);
    vi.useRealTimers();
  });
});
