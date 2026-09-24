import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  CategorizationRule,
  CsrfToken,
  Household,
  TransactionCategory,
} from '../auth/client';
import { CategorizationRulesSection } from './CategorizationRulesSection';

const CSRF: CsrfToken = { token: 'csrf-token-1', headerName: 'X-CSRF-TOKEN' };
const HOUSEHOLD: Household = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  name: 'Elm Street home',
  role: 'MEMBER',
  createdAt: '2026-09-13T01:30:00Z',
};
const RULE_ID = '70000000-0000-4000-8000-000000000001';
const OTHER_RULE_ID = '70000000-0000-4000-8000-000000000002';
const SOURCE_ID = '40000000-0000-4000-8000-000000000001';
const RULES_BASE = `/api/households/${HOUSEHOLD.id}/categorization-rules`;

const CATEGORIES: TransactionCategory[] = [
  { code: 'HOUSING', label: 'Housing' },
  { code: 'GROCERIES', label: 'Food shopping' },
  { code: 'DINING', label: 'Dining' },
  { code: 'UTILITIES', label: 'Utilities' },
  { code: 'TRANSPORTATION', label: 'Transportation' },
  { code: 'SHOPPING', label: 'Shopping' },
  { code: 'ENTERTAINMENT', label: 'Entertainment' },
  { code: 'HEALTHCARE', label: 'Healthcare' },
  { code: 'TRAVEL', label: 'Travel' },
  { code: 'EDUCATION', label: 'Education' },
  { code: 'PERSONAL', label: 'Personal' },
  { code: 'HOUSEHOLD_SUPPLIES', label: 'Household supplies' },
  { code: 'SUBSCRIPTIONS', label: 'Subscriptions' },
  { code: 'INCOME', label: 'Income' },
  { code: 'TRANSFERS', label: 'Transfers' },
  { code: 'MISCELLANEOUS', label: 'Miscellaneous' },
];

function rule(overrides: Partial<CategorizationRule> = {}): CategorizationRule {
  return {
    id: RULE_ID,
    sourceTransactionId: SOURCE_ID,
    matchType: 'PROVIDER_MERCHANT',
    matchLabel: 'Corner Market',
    category: 'GROCERIES',
    status: 'ACTIVE',
    version: 0,
    createdAt: '2026-09-22T12:00:00Z',
    updatedAt: '2026-09-22T12:00:00Z',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function rulePage(
  items: CategorizationRule[],
  overrides: { limit?: number; offset?: number; hasMore?: boolean } = {},
) {
  return jsonResponse({
    items,
    limit: overrides.limit ?? 50,
    offset: overrides.offset ?? 0,
    hasMore: overrides.hasMore ?? false,
  });
}

type Call = { url: string; init?: RequestInit | undefined };

interface RouteHandlers {
  rulesGet?: (
    status: string | null,
    offset: string,
  ) => Response | Promise<Response>;
  rulePatch?: (ruleId: string) => Response | Promise<Response>;
  csrfGet?: () => Response | Promise<Response>;
}

function stubFetch(routes: RouteHandlers) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      if (url === '/api/auth/csrf') {
        return (
          routes.csrfGet?.() ??
          jsonResponse({ token: 'csrf-token-2', headerName: 'X-CSRF-TOKEN' })
        );
      }
      if (url.startsWith(`${RULES_BASE}?`)) {
        const query = new URLSearchParams(url.slice(RULES_BASE.length + 1));
        return (
          routes.rulesGet?.(query.get('status'), query.get('offset') ?? '0') ??
          rulePage([])
        );
      }
      if (url.startsWith(`${RULES_BASE}/`) && init?.method === 'PATCH') {
        const ruleId = decodeURIComponent(url.slice(RULES_BASE.length + 1));
        if (!routes.rulePatch) {
          throw new Error('unexpected PATCH categorization-rule');
        }
        return routes.rulePatch(ruleId);
      }
      throw new Error(`unexpected fetch ${url} ${init?.method ?? ''}`);
    }),
  );
  return calls;
}

function renderPanel(
  routes: RouteHandlers = {},
  options: {
    authorityConfirmed?: boolean;
    categories?: TransactionCategory[] | null;
    refreshSignal?: number;
    scopeResetSignal?: number;
  } = {},
) {
  const calls = stubFetch(routes);
  const onCsrfRefreshed = vi.fn();
  const onSessionExpired = vi.fn();
  const onHouseholdAccessChanged = vi.fn();
  const props = {
    household: HOUSEHOLD,
    csrf: CSRF,
    onCsrfRefreshed,
    onSessionExpired,
    onHouseholdAccessChanged,
    authorityConfirmed: options.authorityConfirmed ?? true,
    categories:
      options.categories === undefined ? CATEGORIES : options.categories,
    refreshSignal: options.refreshSignal ?? 0,
    scopeResetSignal: options.scopeResetSignal ?? 0,
  };
  const rendered = render(<CategorizationRulesSection {...props} />);
  return {
    ...rendered,
    calls,
    onCsrfRefreshed,
    onSessionExpired,
    onHouseholdAccessChanged,
    rerenderWith: (next: {
      refreshSignal?: number;
      scopeResetSignal?: number;
      authorityConfirmed?: boolean;
    }) =>
      rendered.rerender(
        <CategorizationRulesSection
          {...props}
          refreshSignal={next.refreshSignal ?? props.refreshSignal}
          scopeResetSignal={next.scopeResetSignal ?? props.scopeResetSignal}
          authorityConfirmed={
            next.authorityConfirmed ?? props.authorityConfirmed
          }
        />,
      ),
  };
}

const ruleGetCalls = (calls: Call[]) =>
  calls.filter(({ url }) => url.startsWith(`${RULES_BASE}?`));
const patchCalls = (calls: Call[]) =>
  calls.filter(({ init }) => init?.method === 'PATCH');

async function openCategoryEditor(label: string) {
  const row = (await screen.findByText(label)).closest('li') as HTMLLIElement;
  fireEvent.click(
    within(row).getByRole('button', { name: `Change category for ${label}` }),
  );
  return row;
}

describe('private future-match rule management', () => {
  it('lists the owner’s own rules with server labels and no raw evidence', async () => {
    const { calls } = renderPanel({
      rulesGet: () =>
        rulePage([
          rule(),
          rule({
            id: OTHER_RULE_ID,
            matchType: 'NORMALIZED_TEXT',
            matchLabel: 'Laundry service',
            category: 'HOUSEHOLD_SUPPLIES',
            status: 'INACTIVE',
            version: 2,
            updatedAt: '2026-09-21T09:00:00Z',
          }),
        ]),
    });
    const list = await screen.findByRole('list', {
      name: 'Your future-match rules',
    });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(ruleGetCalls(calls)[0]?.url).toBe(
      `${RULES_BASE}?limit=50&offset=0&status=ACTIVE`,
    );
    expect(ruleGetCalls(calls)[0]?.init?.cache).toBe('no-store');
    expect(ruleGetCalls(calls)[0]?.init?.credentials).toBe('include');
    expect(
      within(rows[0] as HTMLElement).getByText('Corner Market'),
    ).toBeInTheDocument();
    expect(
      within(rows[0] as HTMLElement).getByText(/Bank merchant/),
    ).toBeInTheDocument();
    expect(
      within(rows[0] as HTMLElement).getByText(/Category: Food shopping/),
    ).toBeInTheDocument();
    expect(
      within(rows[1] as HTMLElement).getByText(/Description text/),
    ).toBeInTheDocument();
    expect(
      within(rows[1] as HTMLElement).getByText('Deactivated'),
    ).toBeInTheDocument();
    // The private match key is never received, so it can never be rendered,
    // and a raw taxonomy token is never used as a label.
    expect(screen.queryByText('GROCERIES')).toBeNull();
  });

  it('filters by status and reloads the first page from offset zero', async () => {
    const { calls } = renderPanel({
      rulesGet: (status) =>
        status === 'INACTIVE'
          ? rulePage([
              rule({ status: 'INACTIVE', version: 1, matchLabel: 'Old gym' }),
            ])
          : rulePage([rule()]),
    });
    await screen.findByText('Corner Market');
    fireEvent.change(screen.getByLabelText('Show'), {
      target: { value: 'INACTIVE' },
    });
    expect(await screen.findByText('Old gym')).toBeInTheDocument();
    expect(screen.queryByText('Corner Market')).toBeNull();
    const gets = ruleGetCalls(calls);
    expect(gets[1]?.url).toBe(
      `${RULES_BASE}?limit=50&offset=0&status=INACTIVE`,
    );

    fireEvent.change(screen.getByLabelText('Show'), {
      target: { value: 'ALL' },
    });
    await waitFor(() =>
      expect(ruleGetCalls(calls)[2]?.url).toBe(
        `${RULES_BASE}?limit=50&offset=0`,
      ),
    );
  });

  it('pages with the loaded count and never lists the same rule twice', async () => {
    const second = rule({
      id: OTHER_RULE_ID,
      matchLabel: 'Laundry service',
      category: 'HOUSEHOLD_SUPPLIES',
      updatedAt: '2026-09-21T09:00:00Z',
    });
    const { calls } = renderPanel({
      rulesGet: (_status, offset) =>
        offset === '0'
          ? rulePage([rule()], { hasMore: true })
          : // A rule that moved between the two requests can repeat across
            // offsets; identity is the id.
            rulePage([second, rule()], { offset: 1 }),
    });
    await screen.findByText('Corner Market');
    fireEvent.click(screen.getByRole('button', { name: 'Load more rules' }));
    expect(await screen.findByText('Laundry service')).toBeInTheDocument();
    expect(screen.getAllByText('Corner Market')).toHaveLength(1);
    expect(ruleGetCalls(calls)[1]?.url).toBe(
      `${RULES_BASE}?limit=50&offset=1&status=ACTIVE`,
    );
    expect(
      screen.queryByRole('button', { name: 'Load more rules' }),
    ).toBeNull();
  });

  it('changes a rule category with the rule version and converges the row', async () => {
    const { calls } = renderPanel({
      rulesGet: () => rulePage([rule()]),
      rulePatch: () => jsonResponse(rule({ category: 'DINING', version: 1 })),
    });
    const row = await openCategoryEditor('Corner Market');
    const select = within(row).getByLabelText('Rule category');
    fireEvent.change(select, { target: { value: 'DINING' } });
    fireEvent.click(
      within(row).getByRole('button', { name: 'Save rule category' }),
    );

    expect(
      await screen.findByText(
        /Rule updated: future matches for “Corner Market” now use Dining\./,
      ),
    ).toBeInTheDocument();
    const patches = patchCalls(calls);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.url).toBe(`${RULES_BASE}/${RULE_ID}`);
    expect(JSON.parse(String(patches[0]?.init?.body))).toEqual({
      expectedVersion: 0,
      category: 'DINING',
    });
    expect(patches[0]?.init?.headers).toMatchObject({
      'X-CSRF-TOKEN': 'csrf-token-1',
    });
    expect(within(row).getByText(/Category: Dining/)).toBeInTheDocument();
    expect(within(row).queryByLabelText('Rule category')).toBeNull();
  });

  it('binds a rejected rule category to the control and keeps the draft', async () => {
    renderPanel({
      rulesGet: () => rulePage([rule()]),
      rulePatch: () =>
        jsonResponse(
          {
            code: 'VALIDATION_FAILED',
            message: 'Check the highlighted fields.',
            fieldErrors: { category: 'That category is not accepted.' },
          },
          400,
        ),
    });
    const row = await openCategoryEditor('Corner Market');
    const select = within(row).getByLabelText('Rule category');
    fireEvent.change(select, { target: { value: 'DINING' } });
    fireEvent.click(
      within(row).getByRole('button', { name: 'Save rule category' }),
    );

    expect(
      await screen.findByText('That category is not accepted.'),
    ).toBeInTheDocument();
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(select).toHaveValue('DINING');
    await waitFor(() => expect(select).toHaveFocus());
  });

  it('refreshes the list and closes the editor when the rule changed elsewhere', async () => {
    let version = 0;
    const { calls } = renderPanel({
      rulesGet: () => rulePage([rule({ version })]),
      rulePatch: () =>
        jsonResponse(
          { code: 'RESOURCE_VERSION_CONFLICT', message: 'Stale.' },
          409,
        ),
    });
    const row = await openCategoryEditor('Corner Market');
    version = 4;
    fireEvent.change(within(row).getByLabelText('Rule category'), {
      target: { value: 'DINING' },
    });
    fireEvent.click(
      within(row).getByRole('button', { name: 'Save rule category' }),
    );

    expect(
      await screen.findByText(/This rule changed on the server/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(ruleGetCalls(calls).length).toBeGreaterThanOrEqual(2),
    );
    expect(screen.queryByLabelText('Rule category')).toBeNull();
  });

  it('refreshes the security token when a rule update is rejected for CSRF', async () => {
    const { calls, onCsrfRefreshed } = renderPanel({
      rulesGet: () => rulePage([rule()]),
      rulePatch: () =>
        jsonResponse({ code: 'CSRF_INVALID', message: 'Token rejected.' }, 403),
    });
    const row = await openCategoryEditor('Corner Market');
    fireEvent.change(within(row).getByLabelText('Rule category'), {
      target: { value: 'DINING' },
    });
    fireEvent.click(
      within(row).getByRole('button', { name: 'Save rule category' }),
    );

    expect(
      await screen.findByText(/Your security token was refreshed/),
    ).toBeInTheDocument();
    expect(onCsrfRefreshed).toHaveBeenCalledTimes(1);
    expect(calls.filter(({ url }) => url === '/api/auth/csrf')).toHaveLength(1);
    // Nothing was changed server-side, so the draft stays exactly as chosen.
    expect(within(row).getByLabelText('Rule category')).toHaveValue('DINING');
  });

  it('deactivates only after an explicit confirmation', async () => {
    const { calls } = renderPanel({
      rulesGet: () => rulePage([rule()]),
      rulePatch: () => jsonResponse(rule({ status: 'INACTIVE', version: 1 })),
    });
    const row = (await screen.findByText('Corner Market')).closest(
      'li',
    ) as HTMLLIElement;
    fireEvent.click(
      within(row).getByRole('button', {
        name: 'Deactivate the rule for Corner Market',
      }),
    );
    const confirm = within(row).getByRole('group', {
      name: 'Confirm deactivating the rule for Corner Market',
    });
    // The one-way transition is explained before it is applied.
    expect(
      within(confirm).getByText(/cannot reactivate it in this version/),
    ).toBeInTheDocument();
    await waitFor(() => expect(confirm).toHaveFocus());
    expect(patchCalls(calls)).toHaveLength(0);

    fireEvent.click(
      within(confirm).getByRole('button', { name: 'Deactivate rule' }),
    );
    expect(
      await screen.findByText(
        /Rule deactivated: future entries matching “Corner Market” no longer use Food shopping\./,
      ),
    ).toBeInTheDocument();
    const patches = patchCalls(calls);
    expect(patches).toHaveLength(1);
    expect(JSON.parse(String(patches[0]?.init?.body))).toEqual({
      expectedVersion: 0,
      status: 'INACTIVE',
    });
    // The deactivated rule no longer matches the open Active filter.
    expect(screen.queryByText('Corner Market')).toBeNull();
    expect(await screen.findByText(/No active rules yet/)).toBeInTheDocument();
  });

  it('cancels the confirmation with Escape and restores focus', async () => {
    const { calls } = renderPanel({ rulesGet: () => rulePage([rule()]) });
    const row = (await screen.findByText('Corner Market')).closest(
      'li',
    ) as HTMLLIElement;
    const trigger = within(row).getByRole('button', {
      name: 'Deactivate the rule for Corner Market',
    });
    fireEvent.click(trigger);
    const confirm = within(row).getByRole('group', {
      name: 'Confirm deactivating the rule for Corner Market',
    });
    fireEvent.keyDown(confirm, { key: 'Escape' });
    await waitFor(() =>
      expect(
        within(row).queryByRole('group', {
          name: 'Confirm deactivating the rule for Corner Market',
        }),
      ).toBeNull(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(patchCalls(calls)).toHaveLength(0);
  });

  it('treats an unconfirmed deactivation as an unknown outcome and reloads', async () => {
    const { calls } = renderPanel({
      rulesGet: () => rulePage([rule()]),
      rulePatch: () =>
        jsonResponse({ code: 'FINANCE_BUSY', message: 'Busy.' }, 503),
    });
    const row = (await screen.findByText('Corner Market')).closest(
      'li',
    ) as HTMLLIElement;
    fireEvent.click(
      within(row).getByRole('button', {
        name: 'Deactivate the rule for Corner Market',
      }),
    );
    fireEvent.click(
      within(
        within(row).getByRole('group', {
          name: 'Confirm deactivating the rule for Corner Market',
        }),
      ).getByRole('button', { name: 'Deactivate rule' }),
    );

    expect(
      await screen.findByText(/The change has an unknown outcome/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(ruleGetCalls(calls).length).toBeGreaterThanOrEqual(2),
    );
    expect(
      screen.queryByRole('group', {
        name: 'Confirm deactivating the rule for Corner Market',
      }),
    ).toBeNull();
  });

  it('drops a stale row and reloads when the rule is no longer listed', async () => {
    let listed = [rule()];
    const { calls } = renderPanel({
      rulesGet: () => rulePage(listed),
      rulePatch: () =>
        jsonResponse(
          { code: 'CATEGORY_RULE_NOT_FOUND', message: 'Unavailable.' },
          404,
        ),
    });
    const row = await openCategoryEditor('Corner Market');
    listed = [];
    fireEvent.change(within(row).getByLabelText('Rule category'), {
      target: { value: 'DINING' },
    });
    fireEvent.click(
      within(row).getByRole('button', { name: 'Save rule category' }),
    );

    expect(
      await screen.findByText(/That rule is no longer in your list/),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Corner Market')).toBeNull());
    expect(ruleGetCalls(calls).length).toBeGreaterThanOrEqual(2);
  });

  it('clears private rule state and reports session loss', async () => {
    const { onSessionExpired } = renderPanel({
      rulesGet: () =>
        jsonResponse(
          { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
          401,
        ),
    });
    await waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('list')).toBeNull();
    expect(
      await screen.findByText(
        'Your rules are not loaded. Refresh the household to load them again.',
      ),
    ).toBeInTheDocument();
  });

  it('clears private rule state and reports household access loss', async () => {
    const { onHouseholdAccessChanged } = renderPanel({
      rulesGet: () =>
        jsonResponse(
          { code: 'HOUSEHOLD_NOT_FOUND', message: 'Unavailable.' },
          404,
        ),
    });
    await waitFor(() =>
      expect(onHouseholdAccessChanged).toHaveBeenCalledTimes(1),
    );
    expect(
      await screen.findByText(
        'Your rules are not loaded. Refresh the household to load them again.',
      ),
    ).toBeInTheDocument();
  });

  it('drops the retained list when the parent scope is cleared', async () => {
    const { rerenderWith } = renderPanel({
      rulesGet: () => rulePage([rule()]),
    });
    expect(await screen.findByText('Corner Market')).toBeInTheDocument();
    rerenderWith({ scopeResetSignal: 1 });
    await waitFor(() => expect(screen.queryByText('Corner Market')).toBeNull());
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('keeps mutations unavailable while household authority is unconfirmed', async () => {
    const { calls } = renderPanel(
      { rulesGet: () => rulePage([rule()]) },
      { authorityConfirmed: false },
    );
    await screen.findByText('Corner Market');
    expect(
      screen.getByText('Refresh the household before changing rules.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Deactivate the rule for Corner Market',
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', {
        name: 'Change category for Corner Market',
      }),
    ).toBeDisabled();
    expect(patchCalls(calls)).toHaveLength(0);
  });

  it('never offers a raw token when the taxonomy is unavailable', async () => {
    renderPanel({ rulesGet: () => rulePage([rule()]) }, { categories: null });
    const row = (await screen.findByText('Corner Market')).closest(
      'li',
    ) as HTMLLIElement;
    expect(
      within(row).getByText(/Category: Category unavailable/),
    ).toBeInTheDocument();
    fireEvent.click(
      within(row).getByRole('button', {
        name: 'Change category for Corner Market',
      }),
    );
    expect(within(row).getByLabelText('Rule category')).toBeDisabled();
    expect(
      within(row).getByRole('button', { name: 'Save rule category' }),
    ).toBeDisabled();
    expect(
      within(row).getByText(/Category unavailable\. Refresh/),
    ).toBeInTheDocument();
    expect(screen.queryByText('GROCERIES')).toBeNull();
  });

  it('reloads the first page when a sibling rule commit is signalled', async () => {
    let items = [rule()];
    const { calls, rerenderWith } = renderPanel({
      rulesGet: () => rulePage(items),
    });
    await screen.findByText('Corner Market');
    items = [
      rule(),
      rule({ id: OTHER_RULE_ID, matchLabel: 'Laundry service' }),
    ];
    rerenderWith({ refreshSignal: 1 });
    expect(await screen.findByText('Laundry service')).toBeInTheDocument();
    expect(ruleGetCalls(calls)[1]?.url).toBe(
      `${RULES_BASE}?limit=50&offset=0&status=ACTIVE`,
    );
  });
});
