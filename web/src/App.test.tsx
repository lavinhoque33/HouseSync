import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { NavigationMenu } from './NavigationMenu';

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn());
});

const CSRF = { token: 'csrf-token-1', headerName: 'X-CSRF-TOKEN' };
const USER = {
  id: '11111111-2222-4333-8444-555555555555',
  email: 'person@example.test',
};
const LONG_PASSWORD = 'correct horse battery staple extra';
const INVITATION_ID = '22222222-3333-4444-8555-666666666666';
const SECRET = 'hGgem9rtrw2Z_PHXg76mXTNiof78wQArhcJVnsxQK6A';
const PREVIEW = {
  householdName: 'Elm Street home',
  role: 'MEMBER',
  expiresAt: '2026-09-20T04:00:00Z',
};

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function stubApp(authenticated: { current: boolean }) {
  const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      if (url === '/actuator/health') {
        return jsonResponse({ status: 'UP', groups: ['liveness'] });
      }
      if (url === '/api/auth/csrf') return jsonResponse(CSRF);
      if (url === '/api/auth/me') {
        return authenticated.current
          ? jsonResponse(USER)
          : jsonResponse(
              { code: 'UNAUTHENTICATED', message: 'Not signed in.' },
              401,
            );
      }
      if (url === '/api/auth/login' && init?.method === 'POST') {
        authenticated.current = true;
        return jsonResponse(USER);
      }
      if (url === '/api/auth/logout') {
        authenticated.current = false;
        return new Response(null, { status: 204 });
      }
      if (url === '/api/households') return jsonResponse({ households: [] });
      if (url === '/api/invitations/preview' && init?.method === 'POST') {
        return jsonResponse(PREVIEW);
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
  return calls;
}

function go(path: string) {
  window.history.pushState(null, '', path);
}

describe('operator link lifetime', () => {
  it('strips enrollment and recovery secrets before showing their forms', async () => {
    for (const [path, heading] of [
      ['enroll', 'Enroll account'],
      ['recover', 'Recover account'],
    ] as const) {
      stubApp({ current: false });
      go(`/${path}#code=${SECRET}`);
      const view = render(<App />);
      expect(window.location.hash).toBe('');
      expect(
        await screen.findByRole('heading', { name: heading }),
      ).toBeInTheDocument();
      expect(document.body.textContent).not.toContain(SECRET);
      view.unmount();
    }
    go('/');
  });
});

describe('join route lifetime', () => {
  it('strips the fragment immediately while keeping the capability in memory', async () => {
    stubApp({ current: false });
    go(`/join/${INVITATION_ID}#invite=${SECRET}`);
    render(<App />);
    // The secret leaves the address bar on mount, but the in-memory
    // capability still drives the generic signed-out prompt.
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe(`/join/${INVITATION_ID}`);
    expect(await screen.findByText(/Sign in in this tab/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SECRET);
    expect(window.location.href).not.toContain(SECRET);
    go('/');
  });

  it('rejects a query-bearing link without activating it', async () => {
    const calls = stubApp({ current: false });
    go(`/join/${INVITATION_ID}?x=1#invite=${SECRET}`);
    render(<App />);
    expect(
      await screen.findByText(/invalid or no longer available/i),
    ).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(
      calls.filter(({ url }) => url.startsWith('/api/invitations/')),
    ).toHaveLength(0);
    go('/');
  });

  it('never sources the secret from the query string', async () => {
    const calls = stubApp({ current: false });
    go(`/join/${INVITATION_ID}?invite=${SECRET}`);
    render(<App />);
    // The query value is never treated as a capability: the link is
    // rejected as invalid and no preview request leaves the browser.
    expect(
      await screen.findByText(/invalid or no longer available/i),
    ).toBeInTheDocument();
    expect(
      calls.filter(({ url }) => url.startsWith('/api/invitations/')),
    ).toHaveLength(0);
    go('/');
  });

  it('shows the terminal state for a malformed invitation id', async () => {
    stubApp({ current: false });
    go(`/join/not-a-uuid#invite=${SECRET}`);
    render(<App />);
    expect(
      await screen.findByText(/invalid or no longer available/i),
    ).toBeInTheDocument();
    go('/');
  });

  it('asks to reopen the link when the tab lost the secret', async () => {
    stubApp({ current: false });
    go(`/join/${INVITATION_ID}`);
    render(<App />);
    expect(
      await screen.findByText(/Reopen the original invitation link/i),
    ).toBeInTheDocument();
    go('/');
  });

  it('dismisses the flow locally and returns home', async () => {
    stubApp({ current: false });
    go(`/join/${INVITATION_ID}#invite=${SECRET}`);
    render(<App />);
    expect(await screen.findByText(/Sign in in this tab/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss invitation' }));
    expect(window.location.pathname).toBe('/');
    expect(screen.queryByText(/Sign in in this tab/i)).not.toBeInTheDocument();
  });

  it('activates a join link arriving through history navigation', async () => {
    stubApp({ current: false });
    go('/');
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    go(`/join/${INVITATION_ID}#invite=${SECRET}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(await screen.findByText(/Sign in in this tab/i)).toBeInTheDocument();
    // History arrival strips the fragment exactly like the initial load.
    expect(window.location.hash).toBe('');
    expect(document.body.textContent).not.toContain(SECRET);
    go('/');
  });

  it('leaves the join route and discards the secret on explicit logout', async () => {
    stubApp({ current: false });
    go(`/join/${INVITATION_ID}#invite=${SECRET}`);
    render(<App />);
    expect(await screen.findByText(/Sign in in this tab/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: USER.email },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: LONG_PASSWORD },
    });
    const signInButtons = screen.getAllByRole('button', { name: 'Sign in' });
    fireEvent.click(signInButtons[signInButtons.length - 1]!);
    expect(await screen.findByText('Elm Street home')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Signed out.')).toBeInTheDocument();
    // Logout discarded the capability and left the route: no join UI and
    // no reopen prompt remain.
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(screen.queryByText('Household invitation')).not.toBeInTheDocument();
    expect(window.location.href).not.toContain(SECRET);
  });
});

describe('page navigation', () => {
  it('restores a requested security page after sign-in and clears the draft when leaving', async () => {
    stubApp({ current: false });
    go('/account/security');
    render(<App />);
    await screen.findByRole('heading', { name: 'Sign in' });
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: USER.email },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: LONG_PASSWORD },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const password = await screen.findByLabelText('New password');
    const signedInStatus = await screen.findByRole('status');
    await waitFor(() => expect(document.activeElement).toBe(signedInStatus));
    password.focus();
    fireEvent.change(password, { target: { value: 'first' } });
    fireEvent.change(password, { target: { value: 'first second' } });
    expect(document.activeElement).toBe(password);
    expect(window.scrollTo).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Open navigation menu' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Households' }));
    const directory = screen.getByRole('link', { name: 'Directory' });
    expect(directory).toHaveAttribute('href', '/households');
    fireEvent.click(directory);
    expect(window.location.pathname).toBe('/households');
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Households', level: 1 }),
    );
    expect(window.scrollTo).toHaveBeenCalledWith({
      top: 0,
      left: 0,
      behavior: 'instant',
    });
    expect(
      await screen.findByText(/You do not belong to a household yet/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
    window.history.replaceState(null, '', '/account/security');
    fireEvent(window, new PopStateEvent('popstate'));
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Profile Settings', level: 1 }),
    );
    expect(await screen.findByLabelText('New password')).toHaveValue('');
  });

  it('closes the three-dot menu with Escape, restoring trigger focus', async () => {
    stubApp({ current: false });
    go('/');
    render(<App />);
    const trigger = screen.getByRole('button', {
      name: 'Open navigation menu',
    });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const dialog = screen.getByRole('dialog', { name: 'Navigation' });
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(dialog).not.toHaveAttribute('open');
    expect(document.activeElement).toBe(trigger);
  });

  it('offers recovery from an unknown route without exposing household data', async () => {
    stubApp({ current: true });
    go('/missing');
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'Page not found' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Return home' })).toHaveAttribute(
      'href',
      '/',
    );
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
  });

  it('exposes all household destinations through nested disclosures and keeps the exact page active', () => {
    const householdId = '22222222-3333-4444-8555-666666666666';
    const route = {
      kind: 'household' as const,
      householdId,
      page: 'repayments' as const,
    };
    const view = render(<NavigationMenu route={route} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Open navigation menu' }),
    );
    expect(screen.getByRole('button', { name: 'Households' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(
      screen.getByRole('button', { name: 'Current household' }),
    ).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByRole('button', { name: 'Shared money' }),
    ).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Repayments' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      screen
        .getAllByRole('link')
        .filter((link) => link.getAttribute('aria-current') === 'page'),
    ).toHaveLength(1);
    for (const group of ['Finance', 'Banking', 'Management']) {
      fireEvent.click(screen.getByRole('button', { name: group }));
      expect(screen.getByRole('button', { name: group })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    }
    const destinations = [
      'overview',
      'transactions',
      'accounts',
      'connections',
      'bank-activity',
      'members',
      'invitations',
      'reviews',
      'rules',
      'balances',
      'repayments',
      'contributions',
      'insights',
    ];
    for (const page of destinations) {
      expect(
        document.querySelector(`a[href="/households/${householdId}/${page}"]`),
      ).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Current household' }));
    expect(
      screen.queryByRole('link', { name: 'Repayments' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close navigation' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Open navigation menu' }),
    );
    expect(screen.getByRole('link', { name: 'Repayments' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    view.unmount();
  });

  it('shows the creation route and clears authenticated profile identity on logout', async () => {
    stubApp({ current: true });
    go('/households/new');
    render(<App />);
    expect(
      await screen.findByRole('heading', {
        name: 'Create household',
        level: 1,
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open profile menu' }),
    );
    expect(screen.getByText(USER.email)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Account information'));
    expect(screen.getByText(`Account ID: ${USER.id}`)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Profile Settings/ }),
    ).toHaveAttribute('href', '/account/security');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Signed out.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open profile menu' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(USER.email)).not.toBeInTheDocument();
  });
});
