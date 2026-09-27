import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AuthSection } from '../auth/AuthSection';
import { JoinSection, type JoinSectionProps } from './JoinSection';

const CSRF = { token: 'csrf-token-1', headerName: 'X-CSRF-TOKEN' };
const CSRF_FRESH = { token: 'csrf-token-2', headerName: 'X-CSRF-TOKEN' };
const USER = {
  id: '11111111-2222-4333-8444-555555555555',
  email: 'person@example.test',
};
const LONG_PASSWORD = 'correct horse battery staple extra';
const INVITATION_ID = '22222222-3333-4444-8555-666666666666';
const SECRET = 'hGgem9rtrw2Z_PHXg76mXTNiof78wQArhcJVnsxQK6A';
const INVITE = { invitationId: INVITATION_ID, secret: SECRET };
const HOUSEHOLD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PREVIEW = {
  householdName: 'Elm Street home',
  role: 'MEMBER',
  expiresAt: '2026-09-20T04:00:00Z',
};
const JOINED = {
  id: HOUSEHOLD_ID,
  name: 'Elm Street home',
  role: 'MEMBER',
  createdAt: '2026-09-13T01:30:00Z',
};

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function terminalResponse() {
  return jsonResponse(
    {
      code: 'INVITATION_NOT_FOUND',
      message: 'Invitation is invalid or no longer available.',
      correlationId: 'corr-gone',
    },
    404,
  );
}

interface JoinRoutes {
  preview?: (body?: unknown) => Response | Promise<Response>;
  accept?: (body?: unknown) => Response | Promise<Response>;
  csrf?: () => Response | Promise<Response>;
}

function stubJoin(routes: JoinRoutes) {
  const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
  const mock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      if (url === '/api/auth/csrf') {
        return (routes.csrf?.() ?? jsonResponse(CSRF)) as Response;
      }
      if (url === '/api/invitations/preview' && init?.method === 'POST') {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        return (routes.preview?.(body) ?? jsonResponse(PREVIEW)) as Response;
      }
      if (url === '/api/invitations/accept' && init?.method === 'POST') {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        return (routes.accept?.(body) ?? jsonResponse(JOINED)) as Response;
      }
      throw new Error(`unexpected fetch ${url} ${init?.method ?? ''}`);
    },
  );
  vi.stubGlobal('fetch', mock);
  return calls;
}

function renderJoin(overrides: Partial<JoinSectionProps> = {}) {
  const props: JoinSectionProps = {
    invite: INVITE,
    joinActive: true,
    joinInvalid: false,
    csrf: CSRF,
    user: USER,
    onCsrfRefreshed: vi.fn(),
    onSessionExpired: vi.fn(),
    onInviteCleared: vi.fn(),
    onLeaveJoin: vi.fn(),
    onHouseholdsChanged: vi.fn(),
    ...overrides,
  };
  const result = render(<JoinSection {...props} />);
  return { ...result, props };
}

function invitationCalls(
  calls: Array<{ url: string; init?: RequestInit | undefined }>,
  url: string,
) {
  return calls.filter(({ url: callUrl }) => callUrl === url);
}

describe('signed-out join', () => {
  it('shows a generic prompt and never calls preview', async () => {
    const calls = stubJoin({});
    renderJoin({ user: null });
    expect(await screen.findByText(/Sign in in this tab/i)).toBeInTheDocument();
    expect(screen.queryByText('Elm Street home')).not.toBeInTheDocument();
    await act(async () => {});
    expect(invitationCalls(calls, '/api/invitations/preview')).toHaveLength(0);
    expect(invitationCalls(calls, '/api/invitations/accept')).toHaveLength(0);
  });

  it('dismisses locally without any invitation request', async () => {
    const calls = stubJoin({});
    const { props } = renderJoin({ user: null });
    await screen.findByText(/Sign in in this tab/i);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss invitation' }));
    expect(props.onLeaveJoin).toHaveBeenCalledTimes(1);
    expect(
      calls.filter(({ url }) => url.startsWith('/api/invitations/')),
    ).toHaveLength(0);
  });
});

describe('preview', () => {
  it('shows the minimal preview without secret or household id', async () => {
    const calls = stubJoin({});
    renderJoin({});
    expect(await screen.findByText('Elm Street home')).toBeInTheDocument();
    expect(screen.getByText('Your role will be: MEMBER')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SECRET);
    expect(document.body.textContent).not.toContain(HOUSEHOLD_ID);
    const previews = invitationCalls(calls, '/api/invitations/preview');
    expect(previews).toHaveLength(1);
    expect(JSON.parse(String(previews[0]?.init?.body))).toEqual(INVITE);
    expect(previews[0]?.init?.credentials).toBe('include');
    expect(previews[0]?.init?.cache).toBe('no-store');
  });

  it('hides a previous preview and rechecks the capability after sign-in', async () => {
    const calls = stubJoin({});
    const rendered = renderJoin({});
    expect(await screen.findByText('Elm Street home')).toBeInTheDocument();

    rendered.rerender(<JoinSection {...rendered.props} user={null} />);
    expect(screen.queryByText('Elm Street home')).not.toBeInTheDocument();
    expect(screen.getByText(/Sign in in this tab/i)).toBeInTheDocument();
    expect(invitationCalls(calls, '/api/invitations/preview')).toHaveLength(1);

    rendered.rerender(
      <JoinSection
        {...rendered.props}
        user={{
          id: '33333333-4444-4555-8666-777777777777',
          email: 'other@example.test',
        }}
      />,
    );
    expect(await screen.findByText('Elm Street home')).toBeInTheDocument();
    expect(invitationCalls(calls, '/api/invitations/preview')).toHaveLength(2);
  });

  it('shows a generic terminal state and clears the secret on 404', async () => {
    const calls = stubJoin({ preview: () => terminalResponse() });
    const { props } = renderJoin({});
    expect(
      await screen.findByText(/invalid or no longer available/i),
    ).toBeInTheDocument();
    expect(props.onInviteCleared).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Elm Street home')).not.toBeInTheDocument();
    expect(invitationCalls(calls, '/api/invitations/preview')).toHaveLength(1);
  });

  it('treats invitation field errors as terminal without echoing values', async () => {
    stubJoin({
      preview: () =>
        jsonResponse(
          {
            code: 'VALIDATION_FAILED',
            message: 'Check the supplied details.',
            correlationId: 'corr-field',
            fieldErrors: { secret: 'Enter a valid invitation secret.' },
          },
          400,
        ),
    });
    const { props } = renderJoin({});
    expect(
      await screen.findByText(/invalid or no longer available/i),
    ).toBeInTheDocument();
    expect(props.onInviteCleared).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('refreshes CSRF on rejection and requires an explicit retry', async () => {
    let previewCalls = 0;
    const calls = stubJoin({
      csrf: () => jsonResponse(CSRF_FRESH),
      preview: () => {
        previewCalls += 1;
        if (previewCalls === 1) {
          return jsonResponse(
            {
              code: 'CSRF_INVALID',
              message: 'Invalid CSRF token.',
              correlationId: 'corr-csrf',
            },
            403,
          );
        }
        return jsonResponse(PREVIEW);
      },
    });
    const { props } = renderJoin({ csrf: CSRF });
    expect(
      await screen.findByText(/security token was refreshed/i),
    ).toBeInTheDocument();
    expect(previewCalls).toBe(1);
    expect(props.onCsrfRefreshed).toHaveBeenCalledWith(CSRF_FRESH);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Elm Street home')).toBeInTheDocument();
    expect(previewCalls).toBe(2);
    expect(
      invitationCalls(calls, '/api/invitations/preview')[1]?.init?.headers,
    ).toMatchObject({ 'X-CSRF-TOKEN': CSRF_FRESH.token });
  });

  it('runs session recovery on 401 and keeps the capability for sign-in', async () => {
    stubJoin({
      preview: () =>
        jsonResponse(
          { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
          401,
        ),
    });
    const { props } = renderJoin({});
    await waitFor(() =>
      expect(props.onSessionExpired).toHaveBeenCalledTimes(1),
    );
    // The capability is retained through expiry; nothing terminal is shown.
    expect(props.onInviteCleared).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/invalid or no longer available/i),
    ).not.toBeInTheDocument();
  });
});

describe('accept', () => {
  it('guards duplicate submissions and succeeds once', async () => {
    let resolveAccept!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveAccept = resolve;
    });
    const calls = stubJoin({ accept: () => gate });
    const { props } = renderJoin({});
    await screen.findByRole('button', { name: 'Join household' });
    const button = screen.getByRole('button', { name: 'Join household' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Joining…' })).toBeDisabled(),
    );
    expect(invitationCalls(calls, '/api/invitations/accept')).toHaveLength(1);
    resolveAccept(jsonResponse(JOINED));
    expect(
      await screen.findByText(/You joined “Elm Street home” as MEMBER/i),
    ).toBeInTheDocument();
    expect(props.onInviteCleared).toHaveBeenCalledTimes(1);
    expect(props.onHouseholdsChanged).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Back to households' }));
    expect(props.onLeaveJoin).toHaveBeenCalledTimes(1);
  });

  it('keeps the success state after the parent discards the capability', async () => {
    stubJoin({});
    const rendered = renderJoin({});
    fireEvent.click(
      await screen.findByRole('button', { name: 'Join household' }),
    );
    expect(
      await screen.findByText(/You joined “Elm Street home” as MEMBER/i),
    ).toBeInTheDocument();
    rendered.rerender(<JoinSection {...rendered.props} invite={null} />);
    expect(
      screen.getByText(/You joined “Elm Street home” as MEMBER/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Reopen the original invitation link/i),
    ).not.toBeInTheDocument();
    expect(rendered.props.onLeaveJoin).not.toHaveBeenCalled();
  });

  it('removes joined household details when a revoked session becomes signed out', async () => {
    stubJoin({});
    const rendered = renderJoin({});
    fireEvent.click(
      await screen.findByRole('button', { name: 'Join household' }),
    );
    expect(
      await screen.findByText(/You joined “Elm Street home” as MEMBER/i),
    ).toBeInTheDocument();

    // Acceptance discarded the link, but the flow is still mounted when a
    // different browser revokes this session.
    rendered.rerender(
      <JoinSection {...rendered.props} invite={null} user={null} />,
    );
    expect(screen.queryByText(/Elm Street home/i)).not.toBeInTheDocument();
    expect(rendered.props.onLeaveJoin).toHaveBeenCalledTimes(1);

    rendered.rerender(
      <JoinSection
        {...rendered.props}
        invite={null}
        user={{
          id: '33333333-4444-4555-8666-777777777777',
          email: 'other@example.test',
        }}
      />,
    );
    expect(screen.queryByText(/Elm Street home/i)).not.toBeInTheDocument();
    expect(rendered.props.onLeaveJoin).toHaveBeenCalledTimes(1);
  });

  it('resets a prior success when a different invitation arrives', async () => {
    stubJoin({});
    const rendered = renderJoin({});
    fireEvent.click(
      await screen.findByRole('button', { name: 'Join household' }),
    );
    expect(
      await screen.findByText(/You joined “Elm Street home” as MEMBER/i),
    ).toBeInTheDocument();

    rendered.rerender(
      <JoinSection
        {...rendered.props}
        invite={{
          invitationId: '33333333-4444-4555-8666-777777777777',
          secret: SECRET,
        }}
      />,
    );

    expect(
      await screen.findByRole('button', { name: 'Join household' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/You joined “Elm Street home” as MEMBER/i),
    ).not.toBeInTheDocument();
  });

  it('checks the household collection on timeout before an explicit retry', async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/auth/csrf') return jsonResponse(CSRF);
        if (url === '/api/invitations/preview' && init?.method === 'POST') {
          return jsonResponse(PREVIEW);
        }
        if (url === '/api/invitations/accept' && init?.method === 'POST') {
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
    const onRequestReconcile = vi.fn();
    const { props } = renderJoin({ onRequestReconcile });
    await screen.findByRole('button', { name: 'Join household' });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Join household' }));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(
      screen.getByText(/outcome is unknown.*household list/i),
    ).toBeInTheDocument();
    expect(onRequestReconcile).toHaveBeenCalledTimes(1);
    expect(props.onHouseholdsChanged).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url) === '/api/invitations/accept' &&
          (init as RequestInit | undefined)?.method === 'POST',
      ),
    ).toHaveLength(1);
    vi.useRealTimers();
  });

  it('locks the explicit retry until the requested reconciliation settles', async () => {
    let acceptCalls = 0;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/auth/csrf') return jsonResponse(CSRF);
        if (url === '/api/invitations/preview' && init?.method === 'POST') {
          return jsonResponse(PREVIEW);
        }
        if (url === '/api/invitations/accept' && init?.method === 'POST') {
          acceptCalls += 1;
          if (acceptCalls === 1) {
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('Aborted.', 'AbortError'));
              });
            });
          }
          return jsonResponse(JOINED);
        }
        throw new Error(`unexpected ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    const onRequestReconcile = vi.fn();
    const rendered = renderJoin({
      reconcileVersion: 0,
      reconcileSettled: 0,
      onRequestReconcile,
    });
    await screen.findByRole('button', { name: 'Join household' });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Join household' }));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    vi.useRealTimers();
    expect(
      screen.getByText(/outcome is unknown.*household list/i),
    ).toBeInTheDocument();
    expect(onRequestReconcile).toHaveBeenCalledTimes(1);
    // Reconciliation is outstanding: the retry stays disabled with a
    // checking status, and nothing has been replayed.
    const retry = screen.getByRole('button', { name: 'Retry join' });
    expect(retry).toBeDisabled();
    expect(screen.getByText('Checking your households…')).toBeInTheDocument();
    expect(acceptCalls).toBe(1);
    // The requested reload settles: the retry unlocks and the explicit
    // second attempt succeeds exactly once.
    rendered.rerender(
      <JoinSection
        {...rendered.props}
        reconcileVersion={1}
        reconcileSettled={1}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry join' })).toBeEnabled(),
    );
    expect(
      screen.queryByText('Checking your households…'),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry join' }));
    expect(
      await screen.findByText(/You joined “Elm Street home” as MEMBER/i),
    ).toBeInTheDocument();
    expect(acceptCalls).toBe(2);
  });

  it('accepts a terminal accept response generically', async () => {
    stubJoin({ accept: () => terminalResponse() });
    const { props } = renderJoin({});
    await screen.findByRole('button', { name: 'Join household' });
    fireEvent.click(screen.getByRole('button', { name: 'Join household' }));
    expect(
      await screen.findByText(/invalid or no longer available/i),
    ).toBeInTheDocument();
    expect(props.onInviteCleared).toHaveBeenCalledTimes(1);
  });
});

describe('route states', () => {
  it('renders nothing off the join route', () => {
    const { container } = renderJoin({ joinActive: false });
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a generic terminal state for a malformed link', () => {
    renderJoin({ joinActive: true, joinInvalid: true, invite: null });
    expect(
      screen.getByText(/invalid or no longer available/i),
    ).toBeInTheDocument();
  });

  it('asks to reopen the link when the tab lost the secret', () => {
    const calls = stubJoin({});
    renderJoin({ joinActive: true, joinInvalid: false, invite: null });
    expect(
      screen.getByText(/Reopen the original invitation link/i),
    ).toBeInTheDocument();
    expect(
      calls.filter(({ url }) => url.startsWith('/api/invitations/')),
    ).toHaveLength(0);
  });
});

describe('same-tab sign-in retention', () => {
  it('keeps the capability through sign-in and previews after login', async () => {
    let authenticated = false;
    const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        calls.push({ url, init });
        if (url === '/api/auth/csrf') return jsonResponse(CSRF);
        if (url === '/api/auth/me') {
          return authenticated
            ? jsonResponse(USER)
            : jsonResponse(
                { code: 'UNAUTHENTICATED', message: 'Not signed in.' },
                401,
              );
        }
        if (url === '/api/auth/register' && init?.method === 'POST') {
          return jsonResponse(USER, 201);
        }
        if (url === '/api/auth/login' && init?.method === 'POST') {
          authenticated = true;
          return jsonResponse(USER);
        }
        if (url === '/api/households') return jsonResponse({ households: [] });
        if (url === '/api/invitations/preview' && init?.method === 'POST') {
          const body = init?.body ? JSON.parse(String(init.body)) : undefined;
          expect(body).toEqual(INVITE);
          return jsonResponse(PREVIEW);
        }
        if (url === '/api/invitations/accept' && init?.method === 'POST') {
          return jsonResponse(JOINED);
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    const onInviteCleared = vi.fn();
    const onLeaveJoin = vi.fn();
    render(
      <AuthSection
        invite={INVITE}
        joinActive
        joinInvalid={false}
        onInviteCleared={onInviteCleared}
        onLeaveJoin={onLeaveJoin}
      />,
    );
    // Signed out: generic prompt, and no preview request leaves the browser.
    expect(await screen.findByText(/Sign in in this tab/i)).toBeInTheDocument();
    expect(
      calls.filter(({ url }) => url === '/api/invitations/preview'),
    ).toHaveLength(0);

    // Sign in in the same tab: preview now loads with the retained token.
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: USER.email },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: LONG_PASSWORD },
    });
    const signInButtons = screen.getAllByRole('button', { name: 'Sign in' });
    fireEvent.click(signInButtons[signInButtons.length - 1]!);
    expect(await screen.findByText('Elm Street home')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Join household' }),
    ).toBeInTheDocument();

    // Accept: success clears the secret and offers the household list.
    fireEvent.click(screen.getByRole('button', { name: 'Join household' }));
    expect(
      await screen.findByText(/You joined “Elm Street home” as MEMBER/i),
    ).toBeInTheDocument();
    expect(onInviteCleared).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Back to households' }));
    expect(onLeaveJoin).toHaveBeenCalledTimes(1);
  });

  it('does not preview with the pre-login CSRF token', async () => {
    let authenticated = false;
    let csrfCalls = 0;
    let previewCalls = 0;
    let resolvePostLoginCsrf!: (response: Response) => void;
    const postLoginCsrf = new Promise<Response>((resolve) => {
      resolvePostLoginCsrf = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/auth/csrf') {
          csrfCalls += 1;
          return csrfCalls === 1 ? jsonResponse(CSRF) : postLoginCsrf;
        }
        if (url === '/api/auth/me') {
          return authenticated
            ? jsonResponse(USER)
            : jsonResponse(
                { code: 'UNAUTHENTICATED', message: 'Not signed in.' },
                401,
              );
        }
        if (url === '/api/auth/login' && init?.method === 'POST') {
          authenticated = true;
          return jsonResponse(USER);
        }
        if (url === '/api/households') {
          return jsonResponse({ households: [] });
        }
        if (url === '/api/invitations/preview' && init?.method === 'POST') {
          previewCalls += 1;
          expect((init.headers as Record<string, string>)['X-CSRF-TOKEN']).toBe(
            CSRF_FRESH.token,
          );
          return jsonResponse(PREVIEW);
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    render(
      <AuthSection
        invite={INVITE}
        joinActive
        joinInvalid={false}
        onInviteCleared={() => {}}
        onLeaveJoin={() => {}}
      />,
    );
    await screen.findByText(/Sign in in this tab/i);
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: USER.email },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: LONG_PASSWORD },
    });
    const signInButtons = screen.getAllByRole('button', { name: 'Sign in' });
    fireEvent.click(signInButtons[signInButtons.length - 1]!);

    await waitFor(() => expect(csrfCalls).toBe(2));
    expect(previewCalls).toBe(0);
    expect(screen.queryByText('Elm Street home')).not.toBeInTheDocument();
    resolvePostLoginCsrf(jsonResponse(CSRF_FRESH));
    expect(await screen.findByText('Elm Street home')).toBeInTheDocument();
    expect(previewCalls).toBe(1);
  });
});

describe('ordered reconciliation through the household collection', () => {
  it('settles a slow household reload before unlocking the explicit retry', async () => {
    let authenticated = false;
    let householdGets = 0;
    let resolveReload!: (response: Response) => void;
    const reloadGate = new Promise<Response>((resolve) => {
      resolveReload = resolve;
    });
    let acceptCalls = 0;
    const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        calls.push({ url, init });
        if (url === '/api/auth/csrf') return jsonResponse(CSRF);
        if (url === '/api/auth/me') {
          return authenticated
            ? jsonResponse(USER)
            : jsonResponse(
                { code: 'UNAUTHENTICATED', message: 'Not signed in.' },
                401,
              );
        }
        if (url === '/api/auth/login' && init?.method === 'POST') {
          authenticated = true;
          return jsonResponse(USER);
        }
        if (url === '/api/households') {
          householdGets += 1;
          return householdGets === 1
            ? jsonResponse({ households: [] })
            : reloadGate;
        }
        if (url === '/api/invitations/preview' && init?.method === 'POST') {
          return jsonResponse(PREVIEW);
        }
        if (url === '/api/invitations/accept' && init?.method === 'POST') {
          acceptCalls += 1;
          if (acceptCalls === 1) {
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('Aborted.', 'AbortError'));
              });
            });
          }
          return jsonResponse(JOINED);
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    render(
      <AuthSection
        invite={INVITE}
        joinActive
        joinInvalid={false}
        onInviteCleared={() => {}}
        onLeaveJoin={() => {}}
      />,
    );
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: USER.email },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: LONG_PASSWORD },
    });
    const signInButtons = screen.getAllByRole('button', { name: 'Sign in' });
    fireEvent.click(signInButtons[signInButtons.length - 1]!);
    expect(
      await screen.findByRole('button', { name: 'Join household' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Join household' }));
    vi.useFakeTimers();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    vi.useRealTimers();
    expect(
      screen.getByText(/outcome is unknown.*household list/i),
    ).toBeInTheDocument();
    // The timeout requested reconciliation: the second household load is
    // in flight, the retry stays locked, and nothing was replayed.
    await waitFor(() => expect(householdGets).toBe(2));
    expect(screen.getByRole('button', { name: 'Retry join' })).toBeDisabled();
    expect(screen.getByText('Checking your households…')).toBeInTheDocument();
    expect(acceptCalls).toBe(1);

    // The slow reload settles: the retry unlocks and the explicit second
    // attempt is the only replay.
    resolveReload(jsonResponse({ households: [JOINED] }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry join' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry join' }));
    expect(
      await screen.findByText(/You joined “Elm Street home” as MEMBER/i),
    ).toBeInTheDocument();
    expect(acceptCalls).toBe(2);
  });
});
