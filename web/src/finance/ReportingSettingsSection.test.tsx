import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CsrfToken, Household } from '../auth/client';
import { ReportingSettingsSection } from './ReportingSettingsSection';

const CSRF: CsrfToken = { token: 'csrf-token-1', headerName: 'X-CSRF-TOKEN' };
const OWNER_HOUSEHOLD: Household = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  name: 'Elm Street home',
  role: 'OWNER',
  createdAt: '2026-09-13T01:30:00Z',
};
const MEMBER_HOUSEHOLD: Household = { ...OWNER_HOUSEHOLD, role: 'MEMBER' };

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

interface RouteHandlers {
  settingsGet?: () => Response | Promise<Response>;
  settingsPatch?: (
    body: unknown,
    init?: RequestInit,
  ) => Response | Promise<Response>;
  csrfGet?: () => Response | Promise<Response>;
}

function stubFetch(routes: RouteHandlers) {
  const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      const settingsUrl = `/api/households/${OWNER_HOUSEHOLD.id}/finance-settings`;
      if (url === settingsUrl && (init?.method ?? 'GET') === 'GET') {
        return (
          routes.settingsGet?.() ??
          jsonResponse({ reportingTimeZone: 'Etc/UTC', version: 0 })
        );
      }
      if (url === settingsUrl && init?.method === 'PATCH') {
        if (!routes.settingsPatch) throw new Error('unexpected PATCH settings');
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        return routes.settingsPatch(body, init);
      }
      if (url === '/api/auth/csrf') {
        return (
          routes.csrfGet?.() ??
          jsonResponse({ token: 'csrf-token-2', headerName: 'X-CSRF-TOKEN' })
        );
      }
      throw new Error(`unexpected fetch ${url} ${init?.method ?? ''}`);
    }),
  );
  return calls;
}

function renderSection(
  routes: RouteHandlers = {},
  household: Household = OWNER_HOUSEHOLD,
) {
  const calls = stubFetch(routes);
  const onCsrfRefreshed = vi.fn();
  const onSessionExpired = vi.fn();
  const onHouseholdAccessChanged = vi.fn();
  const onZoneLoaded = vi.fn();
  render(
    <StrictMode>
      <ReportingSettingsSection
        household={household}
        csrf={CSRF}
        onCsrfRefreshed={onCsrfRefreshed}
        onSessionExpired={onSessionExpired}
        onHouseholdAccessChanged={onHouseholdAccessChanged}
        onZoneLoaded={onZoneLoaded}
        authorityConfirmed
      />
    </StrictMode>,
  );
  return {
    calls,
    onCsrfRefreshed,
    onSessionExpired,
    onHouseholdAccessChanged,
    onZoneLoaded,
  };
}

const patchBodies = (
  calls: Array<{ url: string; init?: RequestInit | undefined }>,
) =>
  calls
    .filter(({ init }) => init?.method === 'PATCH')
    .map(({ init }) => JSON.parse(String(init?.body)));

describe('reporting settings section', () => {
  it('shows the actual zone to every member with a labelled region', async () => {
    renderSection(
      {
        settingsGet: () =>
          jsonResponse({ reportingTimeZone: 'America/Sao_Paulo', version: 2 }),
      },
      MEMBER_HOUSEHOLD,
    );
    const region = screen.getByRole('region', {
      name: 'Reporting settings',
    });
    expect(
      await within(region).findByText('America/Sao_Paulo'),
    ).toBeInTheDocument();
    expect(
      within(region).getByText(/Only household owners can change/),
    ).toBeInTheDocument();
  });

  it('hides editing controls from non-owners', async () => {
    renderSection({}, MEMBER_HOUSEHOLD);
    const region = await screen.findByTestId('reporting-settings-section');
    await within(region).findByText('Etc/UTC');
    expect(
      within(region).queryByRole('button', { name: 'Save reporting zone' }),
    ).toBeNull();
    expect(within(region).queryByLabelText('Reporting time zone')).toBeNull();
  });

  it('reports the authoritative zone upward after loading', async () => {
    const { onZoneLoaded } = renderSection({
      settingsGet: () =>
        jsonResponse({ reportingTimeZone: 'America/Sao_Paulo', version: 2 }),
    });
    await screen.findByText('America/Sao_Paulo');
    await waitFor(() =>
      expect(onZoneLoaded).toHaveBeenCalledWith('America/Sao_Paulo'),
    );
  });

  it('warns explicitly when the host cannot compute with the stored zone', async () => {
    // Region-shaped and contract-valid, but unknown to the browser ICU: the
    // stored value stays displayed and reported upward, while local date
    // defaults fall back explicitly instead of crashing.
    const { onZoneLoaded } = renderSection({
      settingsGet: () =>
        jsonResponse({ reportingTimeZone: 'Mars/Olympus', version: 2 }),
    });
    const region = await screen.findByTestId('reporting-settings-section');
    expect(await within(region).findByText('Mars/Olympus')).toBeInTheDocument();
    const warning = await within(region).findByRole('status');
    expect(warning).toHaveTextContent(/not supported by this browser/);
    expect(warning).toHaveTextContent(/monthly defaults use Etc\/UTC/);
    await waitFor(() =>
      expect(onZoneLoaded).toHaveBeenCalledWith('Mars/Olympus'),
    );
  });

  it('saves a new zone with exactly the zone plus expected version', async () => {
    const { calls, onZoneLoaded } = renderSection({
      settingsGet: () =>
        jsonResponse({ reportingTimeZone: 'Etc/UTC', version: 4 }),
      settingsPatch: (body) => {
        expect(body).toEqual({
          reportingTimeZone: 'America/Sao_Paulo',
          expectedVersion: 4,
        });
        return jsonResponse({
          reportingTimeZone: 'America/Sao_Paulo',
          version: 5,
        });
      },
    });
    const region = await screen.findByTestId('reporting-settings-section');
    await within(region).findByText('Etc/UTC');
    fireEvent.change(within(region).getByLabelText('Reporting time zone'), {
      target: { value: 'America/Sao_Paulo' },
    });
    fireEvent.click(
      within(region).getByRole('button', { name: 'Save reporting zone' }),
    );
    expect(
      await within(region).findByText(
        /Reporting time zone updated to America\/Sao_Paulo/,
      ),
    ).toBeInTheDocument();
    expect(patchBodies(calls)).toEqual([
      { reportingTimeZone: 'America/Sao_Paulo', expectedVersion: 4 },
    ]);
    const patchCall = calls.find(({ init }) => init?.method === 'PATCH');
    expect(patchCall?.init?.headers).toMatchObject({
      'X-CSRF-TOKEN': CSRF.token,
    });
    await waitFor(() =>
      expect(onZoneLoaded).toHaveBeenCalledWith('America/Sao_Paulo'),
    );
  });

  it('rejects short aliases locally and preserves the input', async () => {
    const { calls } = renderSection();
    const region = await screen.findByTestId('reporting-settings-section');
    await within(region).findByText('Etc/UTC');
    const input = within(region).getByLabelText(
      'Reporting time zone',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'EST' } });
    fireEvent.click(
      within(region).getByRole('button', { name: 'Save reporting zone' }),
    );
    expect(
      await within(region).findByText(
        'Enter an IANA region time zone such as Etc/UTC or America/Sao_Paulo. Short names like EST and offsets like +03:00 are not accepted.',
      ),
    ).toBeInTheDocument();
    // The recoverable failure keeps the typed value for correction.
    expect(
      (within(region).getByLabelText('Reporting time zone') as HTMLInputElement)
        .value,
    ).toBe('EST');
    expect(patchBodies(calls)).toEqual([]);
  });

  it('keeps the draft when the server rejects the zone value', async () => {
    renderSection({
      settingsPatch: () =>
        jsonResponse(
          {
            code: 'VALIDATION_FAILED',
            message: 'Check the highlighted fields.',
            fieldErrors: { reportingTimeZone: 'Unknown time zone.' },
          },
          400,
        ),
    });
    const region = await screen.findByTestId('reporting-settings-section');
    await within(region).findByText('Etc/UTC');
    fireEvent.change(within(region).getByLabelText('Reporting time zone'), {
      target: { value: 'Mars/Olympus' },
    });
    fireEvent.click(
      within(region).getByRole('button', { name: 'Save reporting zone' }),
    );
    expect(
      await within(region).findByText('Unknown time zone.'),
    ).toBeInTheDocument();
    expect(
      (within(region).getByLabelText('Reporting time zone') as HTMLInputElement)
        .value,
    ).toBe('Mars/Olympus');
  });

  it('reloads before offering a correction after a stale version', async () => {
    let version = 4;
    const { calls } = renderSection({
      settingsGet: () =>
        jsonResponse({ reportingTimeZone: 'Etc/UTC', version }),
      settingsPatch: (body) => {
        const expected = (body as { expectedVersion: number }).expectedVersion;
        if (expected !== version) {
          return jsonResponse(
            {
              code: 'RESOURCE_VERSION_CONFLICT',
              message: 'The settings changed; reload before retrying.',
              correlationId: 'corr-stale',
            },
            409,
          );
        }
        version += 1;
        return jsonResponse({ reportingTimeZone: 'Etc/UTC', version });
      },
    });
    const region = await screen.findByTestId('reporting-settings-section');
    await within(region).findByText('Etc/UTC');
    // A concurrent change lands between load and save.
    version = 7;
    fireEvent.change(within(region).getByLabelText('Reporting time zone'), {
      target: { value: 'America/Sao_Paulo' },
    });
    fireEvent.click(
      within(region).getByRole('button', { name: 'Save reporting zone' }),
    );
    expect(
      await within(region).findByText(
        /The settings changed elsewhere, so the current values were reloaded/,
      ),
    ).toBeInTheDocument();
    // The typed draft survives the reload for an explicit retry.
    expect(
      (within(region).getByLabelText('Reporting time zone') as HTMLInputElement)
        .value,
    ).toBe('America/Sao_Paulo');
    // The explicit retry carries the reloaded version, not a blind resend.
    fireEvent.click(
      within(region).getByRole('button', { name: 'Save reporting zone' }),
    );
    await waitFor(() =>
      expect(patchBodies(calls)).toEqual([
        { reportingTimeZone: 'America/Sao_Paulo', expectedVersion: 4 },
        { reportingTimeZone: 'America/Sao_Paulo', expectedVersion: 7 },
      ]),
    );
  });

  it('gates saving on a reload after a timed-out change', async () => {
    let patchCalls = 0;
    stubFetch({
      settingsGet: () =>
        jsonResponse({ reportingTimeZone: 'Etc/UTC', version: 9 }),
      settingsPatch: (_body, init) => {
        patchCalls += 1;
        // A real fetch rejects when the bounded client wait aborts it; the
        // hanging request models a change whose outcome stays unknown.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted.', 'AbortError'));
          });
        });
      },
    });
    const onZoneLoaded = vi.fn();
    render(
      <ReportingSettingsSection
        household={OWNER_HOUSEHOLD}
        csrf={CSRF}
        onCsrfRefreshed={vi.fn()}
        onSessionExpired={vi.fn()}
        onHouseholdAccessChanged={vi.fn()}
        onZoneLoaded={onZoneLoaded}
        authorityConfirmed
      />,
    );
    const region = await screen.findByTestId('reporting-settings-section');
    await within(region).findByText('Etc/UTC');
    // Fake timers start only once the initial load has settled: the
    // queries above need the real timer-based polling.
    vi.useFakeTimers();
    try {
      fireEvent.change(within(region).getByLabelText('Reporting time zone'), {
        target: { value: 'America/Sao_Paulo' },
      });
      fireEvent.click(
        within(region).getByRole('button', { name: 'Save reporting zone' }),
      );
      await act(() => vi.advanceTimersByTimeAsync(11_000));
      expect(
        within(region).getByText(/outcome is unknown/),
      ).toBeInTheDocument();
      expect(patchCalls).toBe(1);
      // Saving stays paused: the timed-out change is never resent blindly.
      expect(
        within(region).getByRole('button', { name: 'Save reporting zone' }),
      ).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
    // Reloading reconciles the version and re-enables an explicit retry.
    const regionAfter = screen.getByTestId('reporting-settings-section');
    fireEvent.click(
      within(regionAfter).getByRole('button', { name: 'Reload settings' }),
    );
    await waitFor(() =>
      expect(
        within(regionAfter).getByRole('button', {
          name: 'Save reporting zone',
        }),
      ).not.toBeDisabled(),
    );
    // The draft survived the reload for review before retrying.
    expect(
      (
        within(regionAfter).getByLabelText(
          'Reporting time zone',
        ) as HTMLInputElement
      ).value,
    ).toBe('America/Sao_Paulo');
    expect(patchCalls).toBe(1);
  });

  it('refreshes CSRF and requires an explicit retry without resending', async () => {
    let patchCalls = 0;
    const { onCsrfRefreshed } = renderSection({
      settingsPatch: () => {
        patchCalls += 1;
        return jsonResponse(
          { code: 'CSRF_INVALID', message: 'Bad token.' },
          403,
        );
      },
    });
    const region = await screen.findByTestId('reporting-settings-section');
    await within(region).findByText('Etc/UTC');
    fireEvent.change(within(region).getByLabelText('Reporting time zone'), {
      target: { value: 'America/Sao_Paulo' },
    });
    fireEvent.click(
      within(region).getByRole('button', { name: 'Save reporting zone' }),
    );
    expect(
      await within(region).findByText(/security token was refreshed/),
    ).toBeInTheDocument();
    expect(onCsrfRefreshed).toHaveBeenCalledTimes(1);
    // No automatic resend: exactly one PATCH went out.
    expect(patchCalls).toBe(1);
    expect(
      (within(region).getByLabelText('Reporting time zone') as HTMLInputElement)
        .value,
    ).toBe('America/Sao_Paulo');
  });

  it('explains forbidden edits without claiming success', async () => {
    renderSection({
      settingsPatch: () =>
        jsonResponse({ code: 'FORBIDDEN', message: 'Owners only.' }, 403),
    });
    const region = await screen.findByTestId('reporting-settings-section');
    await within(region).findByText('Etc/UTC');
    fireEvent.change(within(region).getByLabelText('Reporting time zone'), {
      target: { value: 'America/Sao_Paulo' },
    });
    fireEvent.click(
      within(region).getByRole('button', { name: 'Save reporting zone' }),
    );
    expect(
      await within(region).findByText(
        'Only household owners can change the reporting time zone.',
      ),
    ).toBeInTheDocument();
  });

  it('keeps the loaded zone visible when a conflict reload fails', async () => {
    // Armed only when the save below runs, so the StrictMode double-mount
    // loads succeed and exactly the conflict reload fails.
    let failReload = false;
    renderSection({
      settingsGet: () => {
        if (failReload) {
          return jsonResponse({ code: 'FINANCE_BUSY', message: 'Busy.' }, 503);
        }
        return jsonResponse({ reportingTimeZone: 'Etc/UTC', version: 1 });
      },
      settingsPatch: () =>
        jsonResponse(
          {
            code: 'RESOURCE_VERSION_CONFLICT',
            message: 'The settings changed; reload before retrying.',
          },
          409,
        ),
    });
    const region = await screen.findByTestId('reporting-settings-section');
    await within(region).findByText('Etc/UTC');
    failReload = true;
    fireEvent.change(within(region).getByLabelText('Reporting time zone'), {
      target: { value: 'America/Sao_Paulo' },
    });
    fireEvent.click(
      within(region).getByRole('button', { name: 'Save reporting zone' }),
    );
    const notice = await within(region).findByRole('alert');
    expect(notice).toHaveTextContent(/reload failed/);
    expect(
      within(notice).getByRole('button', { name: 'Reload settings' }),
    ).toBeInTheDocument();
    // The last good zone stays presented instead of blanking.
    expect(within(region).getByText('Etc/UTC')).toBeInTheDocument();
  });

  it('reconciles session expiry and lost access by clearing scoped state', async () => {
    const expired = renderSection({
      settingsGet: () =>
        jsonResponse(
          { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
          401,
        ),
    });
    await waitFor(() =>
      expect(expired.onSessionExpired).toHaveBeenCalledTimes(1),
    );

    const removed = renderSection({
      settingsGet: () =>
        jsonResponse(
          { code: 'HOUSEHOLD_NOT_FOUND', message: 'Household is unavailable.' },
          404,
        ),
    });
    await waitFor(() =>
      expect(removed.onHouseholdAccessChanged).toHaveBeenCalledTimes(1),
    );
  });

  it('recovers from a timed-out first load with a reload action', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_input: string | URL | Request, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('Aborted.', 'AbortError'));
              });
            }),
        ),
      );
      render(
        <ReportingSettingsSection
          household={OWNER_HOUSEHOLD}
          csrf={CSRF}
          onCsrfRefreshed={vi.fn()}
          onSessionExpired={vi.fn()}
          onHouseholdAccessChanged={vi.fn()}
          onZoneLoaded={vi.fn()}
          authorityConfirmed
        />,
      );
      await act(() => vi.advanceTimersByTimeAsync(11_000));
      const region = screen.getByTestId('reporting-settings-section');
      expect(
        within(region).getByText(
          'Loading reporting settings timed out. Reload to try again.',
        ),
      ).toBeInTheDocument();
      expect(
        within(region).getByRole('button', { name: 'Reload settings' }),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
