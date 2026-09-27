import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AuthSection } from './AuthSection';

const CSRF = { token: 'csrf-token-1', headerName: 'X-CSRF-TOKEN' };
const CSRF_FRESH = { token: 'csrf-token-2', headerName: 'X-CSRF-TOKEN' };
const USER = {
  id: '11111111-2222-4333-8444-555555555555',
  email: 'person@example.test',
};
const LONG_PASSWORD = 'correct horse battery staple extra';

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return headers === undefined
    ? Response.json(body, { status })
    : Response.json(body, { status, headers });
}

function csrfOk() {
  return jsonResponse(CSRF);
}

function meAnonymous() {
  return jsonResponse(
    { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
    401,
  );
}

function meAuthenticated() {
  return jsonResponse(USER);
}

function householdsEmpty() {
  return jsonResponse({ households: [] });
}

interface RouteHandlers {
  csrf?: () => Response | Promise<Response>;
  me?: () => Response | Promise<Response>;
  register?: (body?: unknown) => Response | Promise<Response>;
  recover?: (body?: unknown) => Response | Promise<Response>;
  password?: (body?: unknown) => Response | Promise<Response>;
  revoke?: () => Response | Promise<Response>;
  login?: (body?: unknown) => Response | Promise<Response>;
  logout?: () => Response | Promise<Response>;
  householdsGet?: () => Response | Promise<Response>;
}

function stubFetch(routes: RouteHandlers) {
  const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
  const mock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      if (url === '/api/auth/csrf') return routes.csrf?.() ?? csrfOk();
      if (url === '/api/auth/me') return routes.me?.() ?? meAnonymous();
      if (url === '/api/auth/register') {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        return (routes.register?.(body) ?? jsonResponse(USER, 201)) as Response;
      }
      if (url === '/api/auth/recover')
        return (
          routes.recover?.(JSON.parse(String(init?.body))) ??
          new Response(null, { status: 204 })
        );
      if (url === '/api/auth/password')
        return (
          routes.password?.(JSON.parse(String(init?.body))) ??
          new Response(null, { status: 204 })
        );
      if (url === '/api/auth/sessions/revoke')
        return routes.revoke?.() ?? new Response(null, { status: 204 });
      if (url === '/api/auth/login') {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        return (routes.login?.(body) ?? jsonResponse(USER)) as Response;
      }
      if (url === '/api/auth/logout') {
        return (routes.logout?.() ??
          new Response(null, { status: 204 })) as Response;
      }
      if (url === '/api/households') {
        return (routes.householdsGet?.() ?? householdsEmpty()) as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  );
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

async function bootAnon(routes: RouteHandlers = {}) {
  stubFetch({ me: meAnonymous, csrf: csrfOk, ...routes });
  render(<AuthSection />);
  expect(
    await screen.findByRole('heading', { name: 'Sign in' }),
  ).toBeInTheDocument();
}

function typeInto(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function clickLastButton(name: string) {
  const buttons = screen.getAllByRole('button', { name });
  const target = buttons[buttons.length - 1];
  if (!target) throw new Error(`button ${name} not found`);
  fireEvent.click(target);
}

function submitForm(name: string) {
  const buttons = screen.getAllByRole('button', { name });
  const target = buttons[buttons.length - 1];
  if (!target) throw new Error(`submit button ${name} not found`);
  fireEvent.click(target);
}

describe('auth bootstrap', () => {
  it('shows sign-in when the initial session check is anonymous', async () => {
    await bootAnon();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByText(/session ended/i)).not.toBeInTheDocument();
  });

  it('shows the household directory without account security controls', async () => {
    stubFetch({ csrf: csrfOk, me: meAuthenticated });
    render(<AuthSection route={{ kind: 'directory' }} />);
    expect(
      await screen.findByText(/You do not belong to a household yet/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Change password' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Sign out' }),
    ).not.toBeInTheDocument();
  });

  it('shows a retry state on server failure without signing out', async () => {
    const { mock } = stubFetch({
      csrf: csrfOk,
      me: () => jsonResponse({ code: 'INTERNAL_ERROR', message: 'Oops.' }, 500),
    });
    render(<AuthSection />);
    expect(
      await screen.findByRole('button', { name: 'Retry' }),
    ).toBeInTheDocument();
    mock.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/auth/csrf') return csrfOk();
      return meAnonymous();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
  });

  it('shows invitation context and dismissal on a join route without preview calls', async () => {
    const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
    const mock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        calls.push({ url, init });
        if (url === '/api/auth/csrf') return csrfOk();
        return jsonResponse({ code: 'INTERNAL_ERROR', message: 'Oops.' }, 500);
      },
    );
    vi.stubGlobal('fetch', mock);
    const onLeaveJoin = vi.fn();
    render(
      <AuthSection
        invite={{
          invitationId: '22222222-3333-4444-8555-666666666666',
          secret: 'hGgem9rtrw2Z_PHXg76mXTNiof78wQArhcJVnsxQK6A',
        }}
        joinActive
        joinInvalid={false}
        onInviteCleared={() => {}}
        onLeaveJoin={onLeaveJoin}
      />,
    );
    expect(
      await screen.findByRole('button', { name: 'Retry' }),
    ).toBeInTheDocument();
    // Invitation context is shown, but no details were loaded and no
    // preview request ever left the browser.
    expect(screen.getByText('Household invitation')).toBeInTheDocument();
    expect(
      screen.getByText(/no invitation details were loaded/i),
    ).toBeInTheDocument();
    expect(
      calls.filter(({ url }) => url.startsWith('/api/invitations/')),
    ).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss invitation' }));
    expect(onLeaveJoin).toHaveBeenCalledTimes(1);
  });

  it('shows the terminal link state on bootstrap failure for a malformed link', async () => {
    stubFetch({
      csrf: csrfOk,
      me: () => jsonResponse({ code: 'INTERNAL_ERROR', message: 'Oops.' }, 500),
    });
    render(
      <AuthSection
        invite={null}
        joinActive
        joinInvalid
        onInviteCleared={() => {}}
        onLeaveJoin={() => {}}
      />,
    );
    expect(
      await screen.findByRole('button', { name: 'Retry' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/invalid or no longer available/i),
    ).toBeInTheDocument();
  });
});

describe('operator account links', () => {
  const code = 'a'.repeat(43);
  it('requires an operator link and sends a recipient-bound enrollment code', async () => {
    const { calls } = stubFetch({
      me: meAnonymous,
      register: () => jsonResponse(USER, 201),
    });
    render(
      <AuthSection
        accountLink={{ kind: 'enroll', code, invalid: false }}
        onLeaveAccountLink={() => {}}
      />,
    );
    await screen.findByRole('heading', { name: 'Enroll account' });
    typeInto('Email', USER.email);
    typeInto('Password', LONG_PASSWORD);
    typeInto('Confirm password', LONG_PASSWORD);
    submitForm('Enroll account');
    await screen.findByText('Account created. Sign in with your new password.');
    expect(
      JSON.parse(
        String(
          calls.find(({ url }) => url === '/api/auth/register')?.init?.body,
        ),
      ),
    ).toEqual({
      email: USER.email,
      password: LONG_PASSWORD,
      enrollmentCode: code,
    });
  });

  it('rejects a spent enrollment link with operator guidance', async () => {
    stubFetch({
      me: meAnonymous,
      register: () =>
        jsonResponse(
          { code: 'ENROLLMENT_INVALID', message: 'Invalid enrollment' },
          403,
        ),
    });
    render(
      <AuthSection accountLink={{ kind: 'enroll', code, invalid: false }} />,
    );
    await screen.findByRole('heading', { name: 'Enroll account' });
    typeInto('Email', USER.email);
    typeInto('Password', LONG_PASSWORD);
    typeInto('Confirm password', LONG_PASSWORD);
    submitForm('Enroll account');
    expect(
      await screen.findByText(/Ask the operator for a new link/),
    ).toBeInTheDocument();
  });

  it('replaces a spent-link error when a different malformed link is opened', async () => {
    stubFetch({
      me: meAnonymous,
      register: () =>
        jsonResponse(
          { code: 'ENROLLMENT_INVALID', message: 'Invalid enrollment' },
          403,
        ),
    });
    const { rerender } = render(
      <AuthSection accountLink={{ kind: 'enroll', code, invalid: false }} />,
    );
    await screen.findByRole('heading', { name: 'Enroll account' });
    typeInto('Email', USER.email);
    typeInto('Password', LONG_PASSWORD);
    typeInto('Confirm password', LONG_PASSWORD);
    submitForm('Enroll account');
    expect(
      await screen.findByText(
        /enrollment link is invalid, expired, or already used/,
      ),
    ).toBeInTheDocument();

    rerender(
      <AuthSection
        accountLink={{ kind: 'enroll', code: null, invalid: true }}
      />,
    );
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This enrollment link cannot be used.',
    );
    expect(
      screen.queryByText(
        /enrollment link is invalid, expired, or already used/,
      ),
    ).not.toBeInTheDocument();
  });

  it('ignores a spent-link response that arrives after opening a different link', async () => {
    let reply!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      reply = resolve;
    });
    const { calls } = stubFetch({ me: meAnonymous, register: () => pending });
    const { rerender } = render(
      <AuthSection accountLink={{ kind: 'enroll', code, invalid: false }} />,
    );
    await screen.findByRole('heading', { name: 'Enroll account' });
    typeInto('Email', USER.email);
    typeInto('Password', LONG_PASSWORD);
    typeInto('Confirm password', LONG_PASSWORD);
    submitForm('Enroll account');
    await waitFor(() =>
      expect(calls.some(({ url }) => url === '/api/auth/register')).toBe(true),
    );

    rerender(
      <AuthSection
        accountLink={{ kind: 'enroll', code: null, invalid: true }}
      />,
    );
    await act(async () => {
      reply(
        jsonResponse(
          { code: 'ENROLLMENT_INVALID', message: 'Invalid enrollment' },
          403,
        ),
      );
    });
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This enrollment link cannot be used.',
    );
    expect(
      screen.queryByText(
        /enrollment link is invalid, expired, or already used/,
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('recovers with a single-use link and gives actionable guidance when rejected', async () => {
    const { calls } = stubFetch({
      me: meAnonymous,
      recover: () =>
        jsonResponse(
          { code: 'RECOVERY_INVALID', message: 'Invalid recovery' },
          403,
        ),
    });
    render(
      <AuthSection accountLink={{ kind: 'recover', code, invalid: false }} />,
    );
    await screen.findByRole('heading', { name: 'Recover account' });
    typeInto('Email', USER.email);
    typeInto('New password', LONG_PASSWORD);
    typeInto('Confirm new password', LONG_PASSWORD);
    submitForm('Update password');
    expect(
      await screen.findByText(
        /recovery link is invalid, expired, or already used/,
      ),
    ).toBeInTheDocument();
    expect(
      JSON.parse(
        String(
          calls.find(({ url }) => url === '/api/auth/recover')?.init?.body,
        ),
      ),
    ).toEqual({
      email: USER.email,
      recoveryCode: code,
      newPassword: LONG_PASSWORD,
    });
    expect(screen.getByLabelText('New password')).toHaveValue('');
  });
  it('refreshes a rejected recovery CSRF token without replaying or discarding inputs', async () => {
    const { calls } = stubFetch({
      me: meAnonymous,
      recover: () =>
        jsonResponse(
          { code: 'CSRF_INVALID', message: 'Invalid CSRF token.' },
          403,
        ),
    });
    render(
      <AuthSection accountLink={{ kind: 'recover', code, invalid: false }} />,
    );
    await screen.findByRole('heading', { name: 'Recover account' });
    typeInto('Email', USER.email);
    typeInto('New password', LONG_PASSWORD);
    typeInto('Confirm new password', LONG_PASSWORD);
    submitForm('Update password');
    expect(
      await screen.findByText(
        /security token was refreshed.*try recovery again/i,
      ),
    ).toBeInTheDocument();
    expect(calls.filter(({ url }) => url === '/api/auth/recover')).toHaveLength(
      1,
    );
    expect(screen.getByLabelText('Email')).toHaveValue(USER.email);
    expect(screen.getByLabelText('New password')).toHaveValue(LONG_PASSWORD);
  });

  it('completes recovery and moves to sign-in without retaining the secret', async () => {
    const leave = vi.fn();
    stubFetch({ me: meAnonymous });
    render(
      <AuthSection
        accountLink={{ kind: 'recover', code, invalid: false }}
        onLeaveAccountLink={leave}
      />,
    );
    await screen.findByRole('heading', { name: 'Recover account' });
    typeInto('Email', USER.email);
    typeInto('New password', LONG_PASSWORD);
    typeInto('Confirm new password', LONG_PASSWORD);
    submitForm('Update password');
    await screen.findByText(
      'Password updated. Sign in with your new password.',
    );
    expect(leave).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('New password')).toHaveValue('');
  });
});

describe('account security route lifetime', () => {
  it('keeps the new-password field focused while typing and clears drafts after leaving security', async () => {
    stubFetch({ me: meAuthenticated });
    const view = render(<AuthSection route={{ kind: 'security' }} />);
    const input = await screen.findByLabelText('New password');
    input.focus();
    fireEvent.change(input, { target: { value: 'first' } });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'first second' } });
    expect(document.activeElement).toBe(input);
    view.rerender(<AuthSection route={{ kind: 'home' }} />);
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
    view.rerender(<AuthSection route={{ kind: 'security' }} />);
    expect(screen.getByLabelText('New password')).toHaveValue('');
  });
});

describe('session-wide account controls', () => {
  it('changes password using CSRF and signs out after confirmed session revocation', async () => {
    const { calls } = stubFetch({ me: meAuthenticated });
    render(<AuthSection />);
    await screen.findByRole('heading', { name: 'Change password' });
    typeInto('Current password', LONG_PASSWORD);
    typeInto('New password', 'new correct horse battery staple');
    typeInto('Confirm new password', 'new correct horse battery staple');
    submitForm('Change password and sign out everywhere');
    expect(
      await screen.findByText(/Password changed. All sessions ended/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    const request = calls.find(({ url }) => url === '/api/auth/password')?.init;
    expect(request?.headers).toMatchObject({ 'X-CSRF-TOKEN': CSRF.token });
    expect(JSON.parse(String(request?.body))).toEqual({
      currentPassword: LONG_PASSWORD,
      newPassword: 'new correct horse battery staple',
    });
  });

  it('rejects incorrect current password without signing out', async () => {
    stubFetch({
      me: meAuthenticated,
      password: () =>
        jsonResponse(
          { code: 'INVALID_CREDENTIALS', message: 'Incorrect password.' },
          401,
        ),
    });
    render(<AuthSection />);
    await screen.findByRole('heading', { name: 'Change password' });
    typeInto('Current password', LONG_PASSWORD);
    typeInto('New password', 'new correct horse battery staple');
    typeInto('Confirm new password', 'new correct horse battery staple');
    submitForm('Change password and sign out everywhere');
    expect(
      await screen.findByText('Current password is incorrect.'),
    ).toBeInTheDocument();
    expect(screen.getByText(USER.email)).toBeInTheDocument();
    expect(screen.getByLabelText('Current password')).toHaveValue('');
  });

  it('revokes all sessions including the current session', async () => {
    const { calls } = stubFetch({ me: meAuthenticated });
    render(<AuthSection />);
    await screen.findByRole('button', { name: 'Sign out everywhere' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Sign out everywhere' }),
    );
    expect(
      await screen.findByText('All sessions ended. Sign in again.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    expect(
      calls.find(({ url }) => url === '/api/auth/sessions/revoke')?.init
        ?.headers,
    ).toMatchObject({ 'X-CSRF-TOKEN': CSRF.token });
  });
});

describe('login', () => {
  it('sends credentials with the CSRF header and rotates the token', async () => {
    let csrfCalls = 0;
    const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        calls.push({ url, init });
        if (url === '/api/auth/csrf') {
          csrfCalls += 1;
          return jsonResponse(csrfCalls === 1 ? CSRF : CSRF_FRESH);
        }
        if (url === '/api/auth/me') return meAnonymous();
        if (url === '/api/auth/login') {
          expect(init?.headers).toMatchObject({ 'X-CSRF-TOKEN': CSRF.token });
          expect(init?.credentials).toBe('include');
          const body = JSON.parse(String(init?.body)) as { email: string };
          expect(body.email).toBe(USER.email);
          return jsonResponse(USER);
        }
        throw new Error(`unexpected ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<AuthSection />);
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    typeInto('Email', ` ${USER.email.toUpperCase()} `);
    typeInto('Password', LONG_PASSWORD);
    clickLastButton('Sign in');
    expect(await screen.findByText(USER.email)).toBeInTheDocument();
    await waitFor(() => expect(csrfCalls).toBe(2));
  });

  it('shows a generic message for invalid credentials and clears the password', async () => {
    await bootAnon({
      login: () =>
        jsonResponse(
          {
            code: 'INVALID_CREDENTIALS',
            message: 'Check your email and password and try again.',
          },
          401,
        ),
    });
    typeInto('Email', USER.email);
    typeInto('Password', LONG_PASSWORD);
    clickLastButton('Sign in');
    expect(
      await screen.findByText('Check your email and password and try again.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue(USER.email);
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('refreshes CSRF on INVALID_CSRF and asks for an explicit retry without replaying', async () => {
    let loginCalls = 0;
    stubFetch({
      me: meAnonymous,
      csrf: csrfOk,
      login: () => {
        loginCalls += 1;
        return jsonResponse(
          { code: 'CSRF_INVALID', message: 'Invalid CSRF token.' },
          403,
        );
      },
    });
    render(<AuthSection />);
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    typeInto('Email', USER.email);
    typeInto('Password', LONG_PASSWORD);
    clickLastButton('Sign in');
    expect(
      await screen.findByText(/security token was refreshed/i),
    ).toBeInTheDocument();
    expect(loginCalls).toBe(1);
  });

  it('keeps the completed sign-in when the post-login token refresh fails', async () => {
    let csrfCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/auth/csrf') {
        csrfCalls += 1;
        if (csrfCalls === 1) return csrfOk();
        throw new TypeError('Network error');
      }
      if (url === '/api/auth/me') return meAnonymous();
      if (url === '/api/auth/login') return jsonResponse(USER);
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AuthSection />);
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    typeInto('Email', USER.email);
    typeInto('Password', LONG_PASSWORD);
    clickLastButton('Sign in');
    expect(
      await screen.findByText(
        /Signed in as .* but the security token could not be refreshed/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Sign out' }),
    ).toBeInTheDocument();
  });
});

describe('logout', () => {
  it('clears identity on success and fetches a fresh anonymous token', async () => {
    const { mock } = stubFetch({
      csrf: csrfOk,
      me: meAuthenticated,
      logout: () => new Response(null, { status: 204 }),
    });
    render(<AuthSection />);
    expect(await screen.findByText(USER.email)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Signed out.')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    expect(
      mock.mock.calls.filter(([url]) => String(url) === '/api/auth/csrf')
        .length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('preserves the session when logout fails', async () => {
    stubFetch({
      csrf: csrfOk,
      me: meAuthenticated,
      logout: () =>
        jsonResponse({ code: 'INTERNAL_ERROR', message: 'Oops.' }, 500),
    });
    render(<AuthSection />);
    expect(await screen.findByText(USER.email)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Oops.')).toBeInTheDocument();
    expect(screen.getByText(USER.email)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Sign out' }),
    ).toBeInTheDocument();
  });
});

describe('stale requests and focus expiry', () => {
  it('does not let a stale bootstrap overwrite a newer login', async () => {
    let resolveSlowMe!: (response: Response) => void;
    const slowMe = new Promise<Response>((resolve) => {
      resolveSlowMe = resolve;
    });
    let meCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/auth/csrf') return csrfOk();
      if (url === '/api/auth/me') {
        meCalls += 1;
        if (meCalls === 1) return slowMe;
        return meAnonymous();
      }
      if (url === '/api/auth/login') return jsonResponse(USER);
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AuthSection />);
    await waitFor(() => expect(meCalls).toBe(1));
    resolveSlowMe(meAnonymous());
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    typeInto('Email', USER.email);
    typeInto('Password', LONG_PASSWORD);
    clickLastButton('Sign in');
    expect(await screen.findByText(USER.email)).toBeInTheDocument();
    // A late duplicate of the first bootstrap must not sign the user out.
    fireEvent(window, new Event('blur'));
    expect(screen.getByText(USER.email)).toBeInTheDocument();
  });

  it('shows session-ended when focus recheck finds an expired session', async () => {
    stubFetch({ csrf: csrfOk, me: meAuthenticated });
    render(<AuthSection headerProfileTarget={document.body} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open profile menu' }),
    );
    expect(screen.getByRole('dialog', { name: 'Profile' })).toHaveAttribute(
      'open',
    );
    vi.mocked(fetch).mockImplementation(
      async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/auth/me') return meAnonymous();
        if (url === '/api/auth/csrf') return csrfOk();
        throw new Error(`unexpected ${url}`);
      },
    );
    fireEvent(window, new FocusEvent('focus'));
    expect(
      await screen.findByText('Your session ended. Sign in again.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open profile menu' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(USER.email)).not.toBeInTheDocument();
  });

  it('keeps the session when a focus recheck fails with a network error', async () => {
    stubFetch({ csrf: csrfOk, me: meAuthenticated });
    render(<AuthSection />);
    expect(await screen.findByText(USER.email)).toBeInTheDocument();
    vi.mocked(fetch).mockImplementation(
      async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/auth/me') throw new TypeError('Network error');
        if (url === '/api/auth/csrf') return csrfOk();
        throw new Error(`unexpected ${url}`);
      },
    );
    fireEvent(window, new FocusEvent('focus'));
    expect(
      await screen.findByText(/Could not confirm your session/),
    ).toBeInTheDocument();
    expect(screen.getByText(USER.email)).toBeInTheDocument();
  });
});

describe('foreground/background ownership', () => {
  it('completes a pending logout when focus fires mid-logout', async () => {
    let resolveLogout!: (response: Response) => void;
    const logoutGate = new Promise<Response>((resolve) => {
      resolveLogout = resolve;
    });
    let meCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/auth/csrf') return csrfOk();
      if (url === '/api/auth/me') {
        meCalls += 1;
        return meAuthenticated();
      }
      if (url === '/api/auth/logout') return logoutGate;
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AuthSection />);
    expect(await screen.findByText(USER.email)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(
      screen.getByRole('button', { name: 'Signing out…' }),
    ).toBeInTheDocument();
    // A background focus check must not supersede the active logout.
    fireEvent(window, new FocusEvent('focus'));
    resolveLogout(new Response(null, { status: 204 }));
    expect(await screen.findByText('Signed out.')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Signing out…')).not.toBeInTheDocument();
    // The ignored focus check never reached the session endpoint again.
    expect(meCalls).toBe(1);
  });

  it('keeps a fresh login when focus fires during the post-login token refresh', async () => {
    let resolveRefresh!: (response: Response) => void;
    const refreshGate = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    let csrfCalls = 0;
    let meCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/auth/csrf') {
        csrfCalls += 1;
        if (csrfCalls === 1) return csrfOk();
        return refreshGate;
      }
      if (url === '/api/auth/me') {
        meCalls += 1;
        return meAnonymous();
      }
      if (url === '/api/auth/login') return jsonResponse(USER);
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AuthSection />);
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    typeInto('Email', USER.email);
    typeInto('Password', LONG_PASSWORD);
    clickLastButton('Sign in');
    // Login completed server-side; only the token refresh is pending.
    expect(await screen.findByText(USER.email)).toBeInTheDocument();
    fireEvent(window, new FocusEvent('focus'));
    resolveRefresh(jsonResponse(CSRF_FRESH));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Sign out' }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(USER.email)).toBeInTheDocument();
    expect(
      screen.queryByText('Your session ended. Sign in again.'),
    ).not.toBeInTheDocument();
    expect(meCalls).toBe(1);
  });
});

describe('expired-session token rotation', () => {
  it('clears the stale token and uses a fresh one for the first reauth', async () => {
    const loginHeaders: Array<unknown> = [];
    let csrfCalls = 0;
    let meCalls = 0;
    const CSRF_AFTER_EXPIRY = {
      token: 'csrf-after-expiry',
      headerName: 'X-CSRF-TOKEN',
    };
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/auth/csrf') {
          csrfCalls += 1;
          if (csrfCalls === 1) return csrfOk();
          return jsonResponse(CSRF_AFTER_EXPIRY);
        }
        if (url === '/api/auth/me') {
          meCalls += 1;
          if (meCalls === 1) return meAuthenticated();
          return meAnonymous();
        }
        if (url === '/api/auth/login') {
          loginHeaders.push(init?.headers);
          return jsonResponse(USER);
        }
        throw new Error(`unexpected ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<AuthSection />);
    expect(await screen.findByText(USER.email)).toBeInTheDocument();
    fireEvent(window, new FocusEvent('focus'));
    expect(
      await screen.findByText('Your session ended. Sign in again.'),
    ).toBeInTheDocument();
    typeInto('Email', USER.email);
    typeInto('Password', LONG_PASSWORD);
    clickLastButton('Sign in');
    expect(await screen.findByText(USER.email)).toBeInTheDocument();
    expect(loginHeaders).toHaveLength(1);
    expect(loginHeaders[0]).toMatchObject({
      'X-CSRF-TOKEN': CSRF_AFTER_EXPIRY.token,
    });
  });

  it('recovers on demand when the expiry refresh itself fails', async () => {
    const loginHeaders: Array<unknown> = [];
    let csrfCalls = 0;
    let meCalls = 0;
    const CSRF_RECOVERED = {
      token: 'csrf-recovered',
      headerName: 'X-CSRF-TOKEN',
    };
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/auth/csrf') {
          csrfCalls += 1;
          if (csrfCalls === 1) return csrfOk();
          if (csrfCalls === 2) throw new TypeError('Network error');
          return jsonResponse(CSRF_RECOVERED);
        }
        if (url === '/api/auth/me') {
          meCalls += 1;
          return meCalls === 1 ? meAuthenticated() : meAnonymous();
        }
        if (url === '/api/auth/login') {
          loginHeaders.push(init?.headers);
          return jsonResponse(USER);
        }
        throw new Error(`unexpected ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<AuthSection />);
    expect(await screen.findByText(USER.email)).toBeInTheDocument();
    fireEvent(window, new FocusEvent('focus'));
    expect(
      await screen.findByText('Your session ended. Sign in again.'),
    ).toBeInTheDocument();
    typeInto('Email', USER.email);
    typeInto('Password', LONG_PASSWORD);
    clickLastButton('Sign in');
    expect(await screen.findByText(USER.email)).toBeInTheDocument();
    expect(loginHeaders[0]).toMatchObject({
      'X-CSRF-TOKEN': CSRF_RECOVERED.token,
    });
  });
});

describe('csrf rejection without replay', () => {
  it('does not replay a rejected logout and stays signed in', async () => {
    let logoutCalls = 0;
    stubFetch({
      csrf: csrfOk,
      me: meAuthenticated,
      logout: () => {
        logoutCalls += 1;
        return jsonResponse(
          { code: 'CSRF_INVALID', message: 'Invalid CSRF token.' },
          403,
        );
      },
    });
    render(<AuthSection />);
    expect(await screen.findByText(USER.email)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(
      await screen.findByText(/Try signing out again/),
    ).toBeInTheDocument();
    expect(logoutCalls).toBe(1);
    expect(screen.getByText(USER.email)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Sign out' }),
    ).toBeInTheDocument();
  });

  it('stays signed out when the post-logout token refresh fails', async () => {
    let csrfCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/auth/csrf') {
        csrfCalls += 1;
        if (csrfCalls === 1) return csrfOk();
        throw new TypeError('Network error');
      }
      if (url === '/api/auth/me') return meAuthenticated();
      if (url === '/api/auth/logout')
        return new Response(null, { status: 204 });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AuthSection />);
    expect(await screen.findByText(USER.email)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(
      await screen.findByText(/Signed out, but the security token/),
    ).toBeInTheDocument();
    // The completed server logout stands: no authenticated UI remains.
    expect(
      screen.getByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(USER.email)).not.toBeInTheDocument();
  });
});

describe('request timeouts', () => {
  it('preserves identity when logout times out and frees the button', async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/auth/csrf') return csrfOk();
        if (url === '/api/auth/me') return meAuthenticated();
        if (url === '/api/auth/logout') {
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
    render(<AuthSection />);
    expect(await screen.findByText(USER.email)).toBeInTheDocument();
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(
      screen.getByRole('button', { name: 'Signing out…' }),
    ).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(screen.getByText(/Sign-out timed out/)).toBeInTheDocument();
    expect(screen.getByText(USER.email)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Sign out' }),
    ).toBeInTheDocument();
  });
});

describe('strictmode mount lifecycle', () => {
  it('exits bootstrap and can log in after the first setup request is canceled', async () => {
    let csrfCalls = 0;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/auth/csrf') {
          csrfCalls += 1;
          if (csrfCalls === 1) {
            // The first StrictMode setup is cleaned up while pending.
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('Aborted.', 'AbortError'));
              });
            });
          }
          return csrfOk();
        }
        if (url === '/api/auth/me') return meAnonymous();
        if (url === '/api/auth/login') return jsonResponse(USER);
        throw new Error(`unexpected ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    render(
      <StrictMode>
        <AuthSection />
      </StrictMode>,
    );
    // Bootstrap must leave the loading state despite the canceled request.
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    typeInto('Email', USER.email);
    typeInto('Password', LONG_PASSWORD);
    clickLastButton('Sign in');
    expect(await screen.findByText(USER.email)).toBeInTheDocument();
  });

  it('applies no completion updates after a true unmount', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let resolveLogin!: (response: Response) => void;
      const loginGate = new Promise<Response>((resolve) => {
        resolveLogin = resolve;
      });
      const { mock } = stubFetch({
        me: meAnonymous,
        csrf: csrfOk,
        login: () => loginGate,
      });
      const { unmount } = render(<AuthSection />);
      expect(
        await screen.findByRole('heading', { name: 'Sign in' }),
      ).toBeInTheDocument();
      typeInto('Email', USER.email);
      typeInto('Password', LONG_PASSWORD);
      clickLastButton('Sign in');
      await waitFor(() =>
        expect(
          mock.mock.calls.filter(([url]) => String(url) === '/api/auth/login'),
        ).toHaveLength(1),
      );
      unmount();
      resolveLogin(jsonResponse(USER));
      await act(async () => {});
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('busy controls', () => {
  it('disables sign-out while the post-login token refresh is pending', async () => {
    let resolveRefresh!: (response: Response) => void;
    const refreshGate = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    let csrfCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/auth/csrf') {
        csrfCalls += 1;
        if (csrfCalls === 1) return csrfOk();
        return refreshGate;
      }
      if (url === '/api/auth/me') return meAnonymous();
      if (url === '/api/auth/login') return jsonResponse(USER);
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AuthSection />);
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    typeInto('Email', USER.email);
    typeInto('Password', LONG_PASSWORD);
    clickLastButton('Sign in');
    expect(await screen.findByText(USER.email)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDisabled();
    resolveRefresh(jsonResponse(CSRF_FRESH));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Sign out' }),
      ).not.toBeDisabled(),
    );
  });
});
