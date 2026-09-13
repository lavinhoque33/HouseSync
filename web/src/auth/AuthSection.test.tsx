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

  it('shows the account shell with households when bootstrap finds a session', async () => {
    stubFetch({ csrf: csrfOk, me: meAuthenticated });
    render(<AuthSection />);
    expect(await screen.findByText(USER.email)).toBeInTheDocument();
    expect(screen.getByText('Households')).toBeInTheDocument();
    expect(
      await screen.findByText(/You do not belong to a household yet/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Sign out' }),
    ).toBeInTheDocument();
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

describe('registration', () => {
  it('creates an account then shows sign-in with the email retained', async () => {
    await bootAnon({ register: () => jsonResponse(USER, 201) });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    typeInto('Email', USER.email);
    typeInto('Password', LONG_PASSWORD);
    typeInto('Confirm password', LONG_PASSWORD);
    submitForm('Create account');
    expect(
      await screen.findByText(
        'Account created. Sign in with your new password.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue(USER.email);
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('validates confirmation and bounds before sending a request', async () => {
    const { mock } = stubFetch({ me: meAnonymous, csrf: csrfOk });
    render(<AuthSection />);
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    typeInto('Email', USER.email);
    typeInto('Password', 'short');
    typeInto('Confirm password', 'different');
    submitForm('Create account');
    expect(
      await screen.findByText('Check the highlighted fields.'),
    ).toBeInTheDocument();
    expect(
      mock.mock.calls.filter(([url]) => String(url).includes('/register')),
    ).toHaveLength(0);
  });

  it('shows a generic conflict for duplicate emails', async () => {
    await bootAnon({
      register: () =>
        jsonResponse(
          {
            code: 'REGISTRATION_CONFLICT',
            message: 'An account with that email already exists.',
          },
          409,
        ),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    typeInto('Email', USER.email);
    typeInto('Password', LONG_PASSWORD);
    typeInto('Confirm password', LONG_PASSWORD);
    submitForm('Create account');
    expect(
      await screen.findByText('An account with that email already exists.'),
    ).toBeInTheDocument();
  });

  it('surfaces rate limiting with the Retry-After hint', async () => {
    await bootAnon({
      register: () =>
        jsonResponse(
          { code: 'RATE_LIMITED', message: 'Too many attempts.' },
          429,
          { 'Retry-After': '45' },
        ),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    typeInto('Email', USER.email);
    typeInto('Password', LONG_PASSWORD);
    typeInto('Confirm password', LONG_PASSWORD);
    submitForm('Create account');
    expect(
      await screen.findByText(/Try again in 45 seconds/),
    ).toBeInTheDocument();
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
    render(<AuthSection />);
    expect(await screen.findByText(USER.email)).toBeInTheDocument();
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
  it('does not replay a rejected registration', async () => {
    let registerCalls = 0;
    stubFetch({
      me: meAnonymous,
      csrf: csrfOk,
      register: () => {
        registerCalls += 1;
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
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    typeInto('Email', USER.email);
    typeInto('Password', LONG_PASSWORD);
    typeInto('Confirm password', LONG_PASSWORD);
    submitForm('Create account');
    expect(
      await screen.findByText(/security token was refreshed/i),
    ).toBeInTheDocument();
    expect(registerCalls).toBe(1);
    // Inputs are preserved for the explicit retry.
    expect(screen.getByLabelText('Email')).toHaveValue(USER.email);
  });

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

  it('disables mode tabs while a registration is pending', async () => {
    let resolveRegister!: (response: Response) => void;
    const registerGate = new Promise<Response>((resolve) => {
      resolveRegister = resolve;
    });
    stubFetch({
      me: meAnonymous,
      csrf: csrfOk,
      register: () => registerGate,
    });
    render(<AuthSection />);
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    typeInto('Email', USER.email);
    typeInto('Password', LONG_PASSWORD);
    typeInto('Confirm password', LONG_PASSWORD);
    submitForm('Create account');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    resolveRegister(jsonResponse(USER, 201));
    expect(
      await screen.findByText(
        'Account created. Sign in with your new password.',
      ),
    ).toBeInTheDocument();
  });
});
