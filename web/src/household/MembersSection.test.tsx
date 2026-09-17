import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Household } from '../auth/client';
import { MembersSection } from './MembersSection';

const CSRF = { token: 'csrf-token-1', headerName: 'X-CSRF-TOKEN' };
const CSRF_FRESH = { token: 'csrf-token-2', headerName: 'X-CSRF-TOKEN' };
const HOUSEHOLD = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  name: 'Elm Street home',
  role: 'OWNER' as const,
  createdAt: '2026-09-13T01:30:00Z',
};
const MEMBER_HOUSEHOLD = { ...HOUSEHOLD, role: 'MEMBER' as const };
const ACTOR = {
  userId: '11111111-2222-4333-8444-555555555555',
  email: 'owner@example.test',
  role: 'OWNER' as const,
};
const OTHER = {
  userId: '22222222-3333-4444-8555-666666666666',
  email: 'member@example.test',
  role: 'MEMBER' as const,
};
const CO_OWNER = {
  userId: '33333333-4444-4555-8666-777777777777',
  email: 'coowner@example.test',
  role: 'OWNER' as const,
};

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

interface RouteHandlers {
  csrf?: () => Response | Promise<Response>;
  membersGet?: () => Response | Promise<Response>;
  membersPatch?: (
    userId?: string,
    body?: unknown,
  ) => Response | Promise<Response>;
  membersDelete?: (userId?: string) => Response | Promise<Response>;
  leavePost?: () => Response | Promise<Response>;
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
      const members = `/api/households/${HOUSEHOLD.id}/members`;
      if (url === members && (init?.method ?? 'GET') === 'GET') {
        return (routes.membersGet?.() ??
          jsonResponse({ members: [ACTOR] })) as Response;
      }
      if (url.startsWith(`${members}/`) && init?.method === 'PATCH') {
        if (!routes.membersPatch) throw new Error('unexpected PATCH member');
        const userId = decodeURIComponent(url.slice(members.length + 1));
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        return routes.membersPatch(userId, body) as Response;
      }
      if (url.startsWith(`${members}/`) && init?.method === 'DELETE') {
        if (!routes.membersDelete) throw new Error('unexpected DELETE member');
        return routes.membersDelete(
          decodeURIComponent(url.slice(members.length + 1)),
        ) as Response;
      }
      if (url === `/api/households/${HOUSEHOLD.id}/leave`) {
        if (!routes.leavePost) throw new Error('unexpected POST leave');
        return routes.leavePost() as Response;
      }
      throw new Error(`unexpected fetch ${url} ${init?.method ?? ''}`);
    },
  );
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

function renderSection(household: Household, routes: RouteHandlers = {}) {
  const { calls } = stubFetch(routes);
  const onSessionExpired = vi.fn();
  const onCsrfRefreshed = vi.fn();
  const onHouseholdAccessChanged = vi.fn();
  const rendered = render(
    <MembersSection
      household={household}
      currentUserId={ACTOR.userId}
      csrf={CSRF}
      onCsrfRefreshed={onCsrfRefreshed}
      onSessionExpired={onSessionExpired}
      onHouseholdAccessChanged={onHouseholdAccessChanged}
    />,
  );
  return {
    ...rendered,
    calls,
    onSessionExpired,
    onCsrfRefreshed,
    onHouseholdAccessChanged,
  };
}

const membersCalls = (
  calls: Array<{ url: string; init?: RequestInit | undefined }>,
) => calls.filter(({ url }) => url.endsWith('/members'));

const PROMOTE_NAME = 'Make member@example.test an owner of Elm Street home';

function promoteButton(): HTMLElement {
  return screen.getByRole('button', { name: PROMOTE_NAME });
}

describe('roster visibility', () => {
  it('shows every roster member and marks the signed-in actor', async () => {
    stubFetch({ membersGet: () => jsonResponse({ members: [ACTOR, OTHER] }) });
    render(
      <MembersSection
        household={MEMBER_HOUSEHOLD}
        currentUserId={ACTOR.userId}
        csrf={CSRF}
        onCsrfRefreshed={() => {}}
        onSessionExpired={() => {}}
        onHouseholdAccessChanged={() => {}}
      />,
    );
    expect(
      await screen.findByText('owner@example.test (you)'),
    ).toBeInTheDocument();
    expect(screen.getByText('member@example.test')).toBeInTheDocument();
    expect(screen.getAllByText(/^Role: /)).toHaveLength(2);
    expect(
      screen.getByRole('button', { name: 'Leave Elm Street home' }),
    ).toBeInTheDocument();
  });

  it('offers leave without owner controls for a member-role household', async () => {
    stubFetch({ membersGet: () => jsonResponse({ members: [ACTOR] }) });
    render(
      <MembersSection
        household={MEMBER_HOUSEHOLD}
        currentUserId={ACTOR.userId}
        csrf={CSRF}
        onCsrfRefreshed={() => {}}
        onSessionExpired={() => {}}
        onHouseholdAccessChanged={() => {}}
      />,
    );
    await screen.findByText('owner@example.test (you)');
    expect(screen.queryByRole('button', { name: /Make owner/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove / })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Leave Elm Street home' }),
    ).toBeInTheDocument();
  });
});

describe('owner controls', () => {
  it('offers role and removal controls only for other members', async () => {
    stubFetch({
      membersGet: () => jsonResponse({ members: [ACTOR, OTHER, CO_OWNER] }),
    });
    render(
      <MembersSection
        household={HOUSEHOLD}
        currentUserId={ACTOR.userId}
        csrf={CSRF}
        onCsrfRefreshed={() => {}}
        onSessionExpired={() => {}}
        onHouseholdAccessChanged={() => {}}
      />,
    );
    expect(
      await screen.findByRole('button', {
        name: 'Make member@example.test an owner of Elm Street home',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Change coowner@example.test to a member of Elm Street home',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Remove member@example.test from Elm Street home',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Remove coowner@example.test from Elm Street home',
      }),
    ).toBeInTheDocument();
    // The signed-in owner's own row offers no mutation controls.
    expect(
      screen.queryByRole('button', {
        name: 'Remove owner@example.test from Elm Street home',
      }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: 'Change owner@example.test to a member of Elm Street home',
      }),
    ).toBeNull();
  });
});

describe('confirmations and successful writes', () => {
  it('confirms promotion, sends a strict PATCH, and reconciles authority', async () => {
    let promoted = false;
    const { calls, onHouseholdAccessChanged } = renderSection(HOUSEHOLD, {
      membersGet: () =>
        jsonResponse({
          members: promoted
            ? [ACTOR, { ...OTHER, role: 'OWNER' }]
            : [ACTOR, OTHER],
        }),
      membersPatch: () => {
        promoted = true;
        return jsonResponse({ ...OTHER, role: 'OWNER' });
      },
    });
    await screen.findByRole('button', { name: PROMOTE_NAME });
    fireEvent.click(promoteButton());
    const panel = screen.getByRole('group', {
      name: 'Confirm role change in Elm Street home',
    });
    expect(panel).toHaveFocus();
    expect(
      screen.getByText(/Make member@example.test an owner/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Make owner' }));
    await screen.findByText('member@example.test is now an owner.');
    const patches = calls.filter(({ init }) => init?.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]?.url).toBe(
      `/api/households/${HOUSEHOLD.id}/members/${OTHER.userId}`,
    );
    expect(patches[0]?.init?.credentials).toBe('include');
    expect(patches[0]?.init?.cache).toBe('no-store');
    expect(patches[0]?.init?.headers).toMatchObject({
      'X-CSRF-TOKEN': CSRF.token,
    });
    expect(JSON.parse(String(patches[0]?.init?.body))).toEqual({
      role: 'OWNER',
    });
    // The optimistic row is display data only: the roster reloads and the
    // household collection is asked to reconcile.
    await waitFor(() => expect(membersCalls(calls)).toHaveLength(2));
    expect(onHouseholdAccessChanged).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole('button', {
        name: 'Change member@example.test to a member of Elm Street home',
      }),
    ).toBeInTheDocument();
  });

  it('cancels with Escape and returns focus to the trigger without a request', async () => {
    const { calls } = renderSection(HOUSEHOLD, {
      membersGet: () => jsonResponse({ members: [ACTOR, OTHER] }),
    });
    const trigger = await screen.findByRole('button', {
      name: 'Make member@example.test an owner of Elm Street home',
    });
    fireEvent.click(trigger);
    const panel = screen.getByRole('group', {
      name: 'Confirm role change in Elm Street home',
    });
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(
      screen.queryByRole('group', {
        name: 'Confirm role change in Elm Street home',
      }),
    ).toBeNull();
    expect(trigger).toHaveFocus();
    expect(calls.filter(({ init }) => init?.method === 'PATCH')).toHaveLength(
      0,
    );
  });

  it('guards duplicate submissions while a role change is pending', async () => {
    let resolvePatch!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    const { calls } = renderSection(HOUSEHOLD, {
      membersGet: () => jsonResponse({ members: [ACTOR, OTHER] }),
      membersPatch: () => gate,
    });
    await screen.findByRole('button', {
      name: 'Make member@example.test an owner of Elm Street home',
    });
    fireEvent.click(promoteButton());
    const confirmButton = screen.getByRole('button', { name: 'Make owner' });
    fireEvent.click(confirmButton);
    // A second confirm in the same batch must not start another write.
    fireEvent.click(confirmButton);
    resolvePatch(jsonResponse({ ...OTHER, role: 'OWNER' }));
    expect(
      await screen.findByText('member@example.test is now an owner.'),
    ).toBeInTheDocument();
    expect(calls.filter(({ init }) => init?.method === 'PATCH')).toHaveLength(
      1,
    );
  });

  it('removes another member after confirmation and reloads the roster', async () => {
    let removed = false;
    const { calls, onHouseholdAccessChanged } = renderSection(HOUSEHOLD, {
      membersGet: () =>
        jsonResponse({ members: removed ? [ACTOR] : [ACTOR, OTHER] }),
      membersDelete: () => {
        removed = true;
        return new Response(null, { status: 204 });
      },
    });
    await screen.findByRole('button', {
      name: 'Remove member@example.test from Elm Street home',
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove member@example.test from Elm Street home',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove member' }));
    expect(
      await screen.findByText(/was removed from the household/),
    ).toBeInTheDocument();
    expect(screen.queryByText('member@example.test')).toBeNull();
    const deletes = calls.filter(({ init }) => init?.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.url).toBe(
      `/api/households/${HOUSEHOLD.id}/members/${OTHER.userId}`,
    );
    expect(deletes[0]?.init?.headers).toMatchObject({
      'X-CSRF-TOKEN': CSRF.token,
    });
    await waitFor(() => expect(membersCalls(calls)).toHaveLength(2));
    expect(onHouseholdAccessChanged).toHaveBeenCalledTimes(1);
  });

  it('leaves after confirmation, drops the controls, and refreshes the collection', async () => {
    const { calls, onHouseholdAccessChanged } = renderSection(
      MEMBER_HOUSEHOLD,
      {
        membersGet: () => jsonResponse({ members: [ACTOR] }),
        leavePost: () => new Response(null, { status: 204 }),
      },
    );
    const leave = await screen.findByRole('button', {
      name: 'Leave Elm Street home',
    });
    fireEvent.click(leave);
    expect(
      screen.getByRole('group', { name: 'Confirm leaving in Elm Street home' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Leave household' }));
    expect(
      await screen.findByText('You left “Elm Street home”.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Leave Elm Street home' }),
    ).toBeNull();
    expect(
      screen.queryByRole('list', { name: 'Household members' }),
    ).toBeNull();
    const leaves = calls.filter(
      ({ url, init }) =>
        url === `/api/households/${HOUSEHOLD.id}/leave` &&
        init?.method === 'POST',
    );
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.init?.body).toBeUndefined();
    expect(onHouseholdAccessChanged).toHaveBeenCalledTimes(1);
  });
});

describe('timeout and unknown outcome', () => {
  it('reports an unknown leave outcome and gates retry until the roster settles', async () => {
    let rosterCalls = 0;
    let resolveReload!: (response: Response) => void;
    const reloadGate = new Promise<Response>((resolve) => {
      resolveReload = resolve;
    });
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/auth/csrf') return jsonResponse(CSRF);
        if (url.endsWith('/members')) {
          rosterCalls += 1;
          return rosterCalls === 1
            ? jsonResponse({ members: [ACTOR] })
            : reloadGate;
        }
        if (url === `/api/households/${HOUSEHOLD.id}/leave`) {
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
      <MembersSection
        household={MEMBER_HOUSEHOLD}
        currentUserId={ACTOR.userId}
        csrf={CSRF}
        onCsrfRefreshed={() => {}}
        onSessionExpired={() => {}}
        onHouseholdAccessChanged={() => {}}
      />,
    );
    const leaveButton = await screen.findByRole('button', {
      name: 'Leave Elm Street home',
    });
    await waitFor(() => expect(leaveButton).toBeEnabled());
    vi.useFakeTimers();
    fireEvent.click(leaveButton);
    fireEvent.click(screen.getByRole('button', { name: 'Leave household' }));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(
      screen.getByText(/Leaving timed out\. Its outcome is unknown/),
    ).toBeInTheDocument();
    // Nothing was silently replayed; reconciliation started immediately.
    expect(rosterCalls).toBe(2);
    expect(
      fetchMock.mock.calls.filter(
        ([url]) => String(url) === `/api/households/${HOUSEHOLD.id}/leave`,
      ),
    ).toHaveLength(1);
    vi.useRealTimers();
    // The settled roster reconciles the unknown outcome: the notice clears
    // and writes unlock only after the fresh roster arrived.
    resolveReload(jsonResponse({ members: [ACTOR] }));
    await waitFor(() =>
      expect(screen.queryByText(/outcome is unknown/i)).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Leave Elm Street home' }),
      ).not.toBeDisabled(),
    );
  });

  it('reports an unknown role-change outcome without replaying', async () => {
    let getCalls = 0;
    let resolveReload!: (response: Response) => void;
    const reloadGate = new Promise<Response>((resolve) => {
      resolveReload = resolve;
    });
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/auth/csrf') return jsonResponse(CSRF);
        if (url.endsWith('/members')) {
          getCalls += 1;
          return getCalls === 1
            ? jsonResponse({ members: [ACTOR, OTHER] })
            : reloadGate;
        }
        if (url === `/api/households/${HOUSEHOLD.id}/members/${OTHER.userId}`) {
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
      <MembersSection
        household={HOUSEHOLD}
        currentUserId={ACTOR.userId}
        csrf={CSRF}
        onCsrfRefreshed={() => {}}
        onSessionExpired={() => {}}
        onHouseholdAccessChanged={() => {}}
      />,
    );
    await screen.findByRole('button', { name: PROMOTE_NAME });
    vi.useFakeTimers();
    fireEvent.click(promoteButton());
    fireEvent.click(screen.getByRole('button', { name: 'Make owner' }));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(
      screen.getByText(/The role change timed out\. Its outcome is unknown/),
    ).toBeInTheDocument();
    const patches = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(patches).toHaveLength(1);
    // Both reconciliations ran: the roster reload is in flight and the
    // collection was requested before any retry becomes possible.
    expect(getCalls).toBe(2);
    vi.useRealTimers();
    resolveReload(jsonResponse({ members: [ACTOR, OTHER] }));
    await waitFor(() =>
      expect(screen.queryByText(/outcome is unknown/i)).not.toBeInTheDocument(),
    );
    expect(promoteButton()).not.toBeDisabled();
  });
});

describe('stale access and conflicts', () => {
  it('reconciles collection and roster so stale owner controls disappear on FORBIDDEN', async () => {
    let getCalls = 0;
    let resolveReload!: (response: Response) => void;
    const reloadGate = new Promise<Response>((resolve) => {
      resolveReload = resolve;
    });
    const { onHouseholdAccessChanged } = renderSection(HOUSEHOLD, {
      membersGet: () => {
        getCalls += 1;
        if (getCalls === 1) return jsonResponse({ members: [ACTOR, OTHER] });
        return reloadGate;
      },
      membersPatch: () =>
        jsonResponse(
          {
            code: 'FORBIDDEN',
            message: 'Only owners may change roles.',
            correlationId: 'corr-role',
          },
          403,
        ),
    });
    await screen.findByRole('button', { name: PROMOTE_NAME });
    fireEvent.click(promoteButton());
    fireEvent.click(screen.getByRole('button', { name: 'Make owner' }));
    // The reconciliations explain themselves while the confirming reload is
    // still pending; writes stay gated meanwhile.
    expect(
      await screen.findByText(/access to this household may have changed/i),
    ).toBeInTheDocument();
    expect(screen.getByText('Reference: corr-role')).toBeInTheDocument();
    expect(getCalls).toBe(2);
    expect(onHouseholdAccessChanged).toHaveBeenCalledTimes(1);
    // While the confirming roster reload is gated, the stale-write controls
    // are hidden instead of active.
    expect(screen.queryByRole('button', { name: PROMOTE_NAME })).toBeNull();
    // The reconciled roster shows the actor as a plain member: the stale
    // owner controls disappear instead of lingering.
    resolveReload(
      jsonResponse({ members: [{ ...ACTOR, role: 'MEMBER' }, OTHER] }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: PROMOTE_NAME })).toBeNull(),
    );
  });

  it('drops roster data and refreshes the household list on HOUSEHOLD_NOT_FOUND after a write', async () => {
    const { onHouseholdAccessChanged } = renderSection(MEMBER_HOUSEHOLD, {
      membersGet: () => jsonResponse({ members: [ACTOR] }),
      leavePost: () =>
        jsonResponse(
          {
            code: 'HOUSEHOLD_NOT_FOUND',
            message: 'Household not found.',
            correlationId: 'corr-hh',
          },
          404,
        ),
    });
    await screen.findByRole('button', { name: 'Leave Elm Street home' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Leave Elm Street home' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Leave household' }));
    expect(
      await screen.findByText(/access to this household may have changed/),
    ).toBeInTheDocument();
    expect(screen.queryByText('owner@example.test (you)')).toBeNull();
    expect(onHouseholdAccessChanged).toHaveBeenCalledTimes(1);
  });

  it('drops a stale member row and refreshes after MEMBERSHIP_NOT_FOUND', async () => {
    let getCalls = 0;
    let resolveReload!: (response: Response) => void;
    const reloadGate = new Promise<Response>((resolve) => {
      resolveReload = resolve;
    });
    const { calls } = renderSection(HOUSEHOLD, {
      membersGet: () => {
        getCalls += 1;
        return getCalls === 1
          ? jsonResponse({ members: [ACTOR, OTHER] })
          : reloadGate;
      },
      membersDelete: () =>
        jsonResponse(
          {
            code: 'MEMBERSHIP_NOT_FOUND',
            message: 'Membership not found.',
            correlationId: 'corr-member',
          },
          404,
        ),
    });
    await screen.findByRole('button', {
      name: 'Remove member@example.test from Elm Street home',
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove member@example.test from Elm Street home',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove member' }));
    expect(
      await screen.findByText(/no longer in this household/),
    ).toBeInTheDocument();
    expect(screen.queryByText('member@example.test')).toBeNull();
    expect(getCalls).toBe(2);
    // The stale roster stays gated until the automatic reload settles.
    expect(
      screen.getByRole('button', { name: 'Leave Elm Street home' }),
    ).toBeDisabled();
    resolveReload(jsonResponse({ members: [ACTOR] }));
    await waitFor(() => expect(membersCalls(calls)).toHaveLength(2));
    // The outcome notice stays readable after the settled reload and makes
    // no present-tense refresh claim; writes unlock again.
    const outcome = screen.getByText(/no longer in this household/);
    expect(outcome).toBeInTheDocument();
    expect(outcome).not.toHaveTextContent(/is being refreshed/);
    expect(
      screen.getByRole('button', { name: 'Leave Elm Street home' }),
    ).not.toBeDisabled();
  });

  it('protects the last owner with LAST_OWNER_REQUIRED and reconciles', async () => {
    let getCalls = 0;
    let resolveReload!: (response: Response) => void;
    const reloadGate = new Promise<Response>((resolve) => {
      resolveReload = resolve;
    });
    const { onHouseholdAccessChanged } = renderSection(HOUSEHOLD, {
      membersGet: () => {
        getCalls += 1;
        return getCalls === 1
          ? jsonResponse({ members: [ACTOR, CO_OWNER] })
          : reloadGate;
      },
      membersPatch: () =>
        jsonResponse(
          {
            code: 'LAST_OWNER_REQUIRED',
            message: 'A household must keep an owner.',
            correlationId: 'corr-owner',
          },
          409,
        ),
    });
    const demote = await screen.findByRole('button', {
      name: 'Change coowner@example.test to a member of Elm Street home',
    });
    fireEvent.click(demote);
    fireEvent.click(screen.getByRole('button', { name: 'Change to member' }));
    expect(
      await screen.findByText(
        /is this household's only owner, so the role cannot change/,
      ),
    ).toBeInTheDocument();
    expect(getCalls).toBe(2);
    expect(onHouseholdAccessChanged).toHaveBeenCalledTimes(1);
    // The invariant stands after the settled reload: the outcome notice
    // stays readable with the remedy and no present-tense refresh claim,
    // and the control returns against current data.
    resolveReload(jsonResponse({ members: [ACTOR, CO_OWNER] }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', {
          name: 'Change coowner@example.test to a member of Elm Street home',
        }),
      ).not.toBeDisabled(),
    );
    const invariant = screen.getByText(
      /is this household's only owner, so the role cannot change/,
    );
    expect(invariant).toBeInTheDocument();
    expect(invariant).not.toHaveTextContent(/is being refreshed/);
  });

  it('ignores a second trigger while a confirmation is open', async () => {
    const { calls } = renderSection(HOUSEHOLD, {
      membersGet: () => jsonResponse({ members: [ACTOR, OTHER] }),
      membersPatch: () => jsonResponse({ ...OTHER, role: 'OWNER' }),
      membersDelete: () => new Response(null, { status: 204 }),
    });
    const promoteTrigger = await screen.findByRole('button', {
      name: PROMOTE_NAME,
    });
    const removeTrigger = screen.getByRole('button', {
      name: 'Remove member@example.test from Elm Street home',
    });
    fireEvent.click(promoteTrigger);
    const panel = screen.getByRole('group', {
      name: 'Confirm role change in Elm Street home',
    });
    // A second trigger is ignored: the open confirmation and its focus
    // origin stay unchanged.
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove member@example.test from Elm Street home',
      }),
    );
    expect(
      screen.getByText(/Make member@example.test an owner/),
    ).toBeInTheDocument();
    expect(removeTrigger).not.toHaveFocus();
    // Cancelling restores focus to the first trigger and sends nothing.
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(promoteTrigger).toHaveFocus();
    expect(calls.filter(({ init }) => init?.method === 'PATCH')).toHaveLength(
      0,
    );
    expect(calls.filter(({ init }) => init?.method === 'DELETE')).toHaveLength(
      0,
    );
  });
});

describe('session, csrf, and roster gating', () => {
  it('runs sign-in-again recovery and clears the roster on 401', async () => {
    const { onSessionExpired } = renderSection(HOUSEHOLD, {
      membersGet: () =>
        jsonResponse(
          { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
          401,
        ),
    });
    await waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole('list', { name: 'Household members' }),
    ).toBeNull();
  });

  it('refreshes CSRF on rejection and requires an explicit confirm before retry', async () => {
    let patchCalls = 0;
    let promoted = false;
    const { calls } = renderSection(HOUSEHOLD, {
      // No csrf fetch happens before the rejection: the section starts with
      // the token passed as a prop, so the first fetch is the recovery.
      csrf: () => jsonResponse(CSRF_FRESH),
      membersGet: () =>
        jsonResponse({
          members: promoted
            ? [ACTOR, { ...OTHER, role: 'OWNER' }]
            : [ACTOR, OTHER],
        }),
      membersPatch: () => {
        patchCalls += 1;
        if (patchCalls === 1) {
          return jsonResponse(
            { code: 'CSRF_INVALID', message: 'Invalid CSRF token.' },
            403,
          );
        }
        promoted = true;
        return jsonResponse({ ...OTHER, role: 'OWNER' });
      },
    });
    await screen.findByRole('button', { name: PROMOTE_NAME });
    fireEvent.click(promoteButton());
    fireEvent.click(screen.getByRole('button', { name: 'Make owner' }));
    expect(
      await screen.findByText(/security token was refreshed/i),
    ).toBeInTheDocument();
    expect(patchCalls).toBe(1);
    // The rejected write is never replayed silently: an explicit confirm
    // runs the retry with the refreshed token.
    fireEvent.click(promoteButton());
    fireEvent.click(screen.getByRole('button', { name: 'Make owner' }));
    expect(
      await screen.findByText('member@example.test is now an owner.'),
    ).toBeInTheDocument();
    const patches = calls.filter(({ init }) => init?.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect(patches[1]?.init?.headers).toMatchObject({
      'X-CSRF-TOKEN': CSRF_FRESH.token,
    });
  });

  it('keeps a failed roster refresh stale with every write gated', async () => {
    let getCalls = 0;
    let patchCalls = 0;
    let promoted = false;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/auth/csrf') return jsonResponse(CSRF);
        if (url.endsWith('/members')) {
          getCalls += 1;
          if (getCalls === 2) {
            return jsonResponse(
              {
                code: 'INTERNAL_ERROR',
                message: 'Something went wrong. Retry.',
                correlationId: 'corr-roster',
              },
              500,
            );
          }
          return jsonResponse({
            members: promoted
              ? [ACTOR, { ...OTHER, role: 'OWNER' }]
              : [ACTOR, OTHER],
          });
        }
        if (
          url === `/api/households/${HOUSEHOLD.id}/members/${OTHER.userId}` &&
          init?.method === 'PATCH'
        ) {
          patchCalls += 1;
          promoted = true;
          return jsonResponse({ ...OTHER, role: 'OWNER' });
        }
        throw new Error(`unexpected ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MembersSection
        household={HOUSEHOLD}
        currentUserId={ACTOR.userId}
        csrf={CSRF}
        onCsrfRefreshed={() => {}}
        onSessionExpired={() => {}}
        onHouseholdAccessChanged={() => {}}
      />,
    );
    await screen.findByRole('button', { name: PROMOTE_NAME });
    fireEvent.click(promoteButton());
    fireEvent.click(screen.getByRole('button', { name: 'Make owner' }));
    await screen.findByText('member@example.test is now an owner.');
    // The confirming roster reload fails: the stale roster stays visible,
    // but the write controls are gone and the recovery button appears.
    expect(
      await screen.findByText('Something went wrong. Retry.'),
    ).toBeInTheDocument();
    // The retained roster is explicitly marked stale while writes stay
    // gated.
    expect(
      screen.getByText(/previously loaded members, which may be out of date/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: PROMOTE_NAME })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Leave Elm Street home' }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh members' }));
    expect(
      await screen.findByRole('button', {
        name: 'Change member@example.test to a member of Elm Street home',
      }),
    ).toBeInTheDocument();
    expect(getCalls).toBe(3);
    expect(patchCalls).toBe(1);
  });
});

describe('mount lifecycle', () => {
  it('applies no roster updates after a true unmount', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let resolveGet!: (response: Response) => void;
      const gate = new Promise<Response>((resolve) => {
        resolveGet = resolve;
      });
      const { mock } = stubFetch({ membersGet: () => gate });
      const { unmount } = render(
        <MembersSection
          household={HOUSEHOLD}
          currentUserId={ACTOR.userId}
          csrf={CSRF}
          onCsrfRefreshed={() => {}}
          onSessionExpired={() => {}}
          onHouseholdAccessChanged={() => {}}
        />,
      );
      await waitFor(() => expect(mock).toHaveBeenCalled());
      unmount();
      resolveGet(jsonResponse({ members: [ACTOR, OTHER] }));
      await act(async () => {});
      expect(errorSpy).not.toHaveBeenCalled();
      expect(screen.queryByText('member@example.test')).toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('recovers from a canceled StrictMode setup request', async () => {
    stubFetch({ membersGet: () => jsonResponse({ members: [ACTOR, OTHER] }) });
    render(
      <StrictMode>
        <MembersSection
          household={MEMBER_HOUSEHOLD}
          currentUserId={ACTOR.userId}
          csrf={CSRF}
          onCsrfRefreshed={() => {}}
          onSessionExpired={() => {}}
          onHouseholdAccessChanged={() => {}}
        />
      </StrictMode>,
    );
    expect(
      await screen.findByText('owner@example.test (you)'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Leave Elm Street home' }),
    ).not.toBeDisabled();
  });
});
