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
import type {
  CategorizationOrigin,
  CategorizationReview,
  CategorizationRule,
  CategorizationState,
  FinancialAccount,
  Household,
  Transaction,
} from '../auth/client';
import { TransactionsSection } from './TransactionsSection';

const CSRF = { token: 'csrf-token-1', headerName: 'X-CSRF-TOKEN' };
const HOUSEHOLD: Household = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  name: 'Elm Street home',
  role: 'MEMBER',
  createdAt: '2026-09-13T01:30:00Z',
};
const ACTOR_ID = '30000000-0000-4000-8000-000000000001';
const CHECKING_ID = '10000000-0000-4000-8000-000000000001';
const CASH_ID = '10000000-0000-4000-8000-000000000002';
const EXPENSE_ID = '40000000-0000-4000-8000-000000000001';
const REFUND_ID = '40000000-0000-4000-8000-000000000002';
// A fixed supported date used as the entry date; it is never assumed to
// equal the runtime "today".
const FIXED_DATE = '2026-09-16';

function account(overrides: Partial<FinancialAccount> = {}): FinancialAccount {
  return {
    id: CHECKING_ID,
    householdId: HOUSEHOLD.id,
    ownerUserId: ACTOR_ID,
    name: 'Daily spending',
    kind: 'CHECKING',
    currency: 'BRL',
    source: 'MANUAL',
    visibility: 'PRIVATE',
    status: 'ACTIVE',
    version: 0,
    createdAt: '2026-09-16T12:00:00Z',
    updatedAt: '2026-09-16T12:00:00Z',
    ...overrides,
  };
}

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: EXPENSE_ID,
    householdId: HOUSEHOLD.id,
    ownerUserId: ACTOR_ID,
    accountId: CHECKING_ID,
    kind: 'EXPENSE',
    money: { amount: '-12.34', currency: 'BRL' },
    occurredOn: FIXED_DATE,
    description: 'Groceries',
    category: null,
    visibility: 'PRIVATE',
    source: 'MANUAL',
    status: 'POSTED',
    refundOfTransactionId: null,
    version: 0,
    createdAt: '2026-09-16T12:00:00Z',
    updatedAt: '2026-09-16T12:00:00Z',
    ...overrides,
  };
}

const CASH_ACCOUNT = account({
  id: CASH_ID,
  name: 'Pocket cash',
  kind: 'CASH',
  currency: 'JPY',
  status: 'ACTIVE',
});

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

interface RouteHandlers {
  accountsGet?: () => Response | Promise<Response>;
  categoriesGet?: () => Response | Promise<Response>;
  transactionsGet?: (view: 'OWN' | 'HOUSEHOLD') => Response | Promise<Response>;
  transactionsPost?: () => Response | Promise<Response>;
  transactionGet?: (transactionId: string) => Response | Promise<Response>;
  categorizationGet?: (transactionId: string) => Response | Promise<Response>;
  transactionsPatch?: (transactionId: string) => Response | Promise<Response>;
  allocationsGet?: (transactionId: string) => Response | Promise<Response>;
  allocationsPost?: (init?: RequestInit) => Response | Promise<Response>;
  allocationsPatch?: (transactionId: string) => Response | Promise<Response>;
  rulesGet?: (
    status: string | null,
    offset: string,
  ) => Response | Promise<Response>;
  rulePost?: (transactionId: string) => Response | Promise<Response>;
  rulePatch?: (ruleId: string) => Response | Promise<Response>;
  reviewsGet?: (view: string | null) => Response | Promise<Response>;
  reviewGet?: (reviewId: string) => Response | Promise<Response>;
  reviewResolve?: (reviewId: string) => Response | Promise<Response>;
  balancesGet?: () => Response | Promise<Response>;
  membersGet?: () => Response | Promise<Response>;
  settingsGet?: () => Response | Promise<Response>;
  settingsPatch?: () => Response | Promise<Response>;
  summaryGet?: (from: string, to: string) => Response | Promise<Response>;
}

type Call = { url: string; init?: RequestInit | undefined };

const CATEGORIZATION_SUFFIX = '/categorization';

const categorizationCalls = (calls: Call[]) =>
  calls.filter(({ url }) => url.endsWith(CATEGORIZATION_SUFFIX));

/**
 * Owner-only provenance state. The default is the neutral NONE
 * state with no learn offer, so a detail test that does not care about
 * classification still sees a complete, honest panel.
 */
function categorizationState(
  overrides: Partial<CategorizationState> = {},
): CategorizationState {
  return {
    transactionId: EXPENSE_ID,
    transactionVersion: 0,
    category: null,
    origin: 'NONE',
    assignedAt: '2026-09-16T12:00:00Z',
    reviewState: 'NONE',
    ruleEligible: false,
    ...overrides,
  };
}

const RULE_ID = '70000000-0000-4000-8000-000000000001';

/** Exactly the nine documented private rule fields; never a match key. */
function rule(overrides: Partial<CategorizationRule> = {}): CategorizationRule {
  return {
    id: RULE_ID,
    sourceTransactionId: EXPENSE_ID,
    matchType: 'NORMALIZED_TEXT',
    matchLabel: 'Groceries',
    category: 'GROCERIES',
    status: 'ACTIVE',
    version: 0,
    createdAt: '2026-09-22T12:00:00Z',
    updatedAt: '2026-09-22T12:00:00Z',
    ...overrides,
  };
}

const emptyRulePage = () =>
  jsonResponse({ items: [], limit: 50, offset: 0, hasMore: false });

const REVIEW_ID = '80000000-0000-4000-8000-000000000001';
const REVIEWS_BASE = `/api/households/${HOUSEHOLD.id}/categorization-reviews`;

/** Exactly the eleven documented owner-private review fields. */
function review(
  overrides: Partial<CategorizationReview> = {},
): CategorizationReview {
  return {
    id: REVIEW_ID,
    transaction: transaction(),
    evaluatedTransactionVersion: 0,
    suggestedCategory: 'GROCERIES',
    source: 'HEURISTIC',
    confidence: 'HIGH',
    reasonLabel: 'Merchant pattern matched',
    status: 'OPEN',
    version: 0,
    createdAt: '2026-09-22T12:00:00Z',
    updatedAt: '2026-09-22T12:00:00Z',
    ...overrides,
  };
}

const reviewPage = (items: CategorizationReview[], openCount = items.length) =>
  jsonResponse({ items, limit: 50, offset: 0, hasMore: false, openCount });

const reviewCalls = (calls: Call[]) =>
  calls.filter(({ url }) => url.startsWith(`${REVIEWS_BASE}?`));

const resolveCalls = (calls: Call[]) =>
  calls.filter(({ url }) => url.endsWith(`${REVIEW_ID}/resolve`));

const ALLOCATION_NOT_FOUND = () =>
  jsonResponse(
    {
      code: 'ALLOCATION_NOT_FOUND',
      message: 'No active allocation for this transaction.',
    },
    404,
  );

const CATEGORY_ITEMS = [
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

function stubFetch(routes: RouteHandlers) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      const accountBase = `/api/households/${HOUSEHOLD.id}/financial-accounts`;
      const transactionBase = `/api/households/${HOUSEHOLD.id}/transactions`;
      const categoriesUrl = `/api/households/${HOUSEHOLD.id}/transaction-categories`;
      const memberBalancesUrl = `/api/households/${HOUSEHOLD.id}/member-balances`;
      const membersUrl = `/api/households/${HOUSEHOLD.id}/members`;
      if (url === categoriesUrl) {
        return (
          routes.categoriesGet?.() ?? jsonResponse({ items: CATEGORY_ITEMS })
        );
      }
      if (url === memberBalancesUrl) {
        return routes.balancesGet?.() ?? jsonResponse({ currencies: [] });
      }
      if (url === membersUrl) {
        return routes.membersGet?.() ?? jsonResponse({ members: [] });
      }
      const settingsUrl = `/api/households/${HOUSEHOLD.id}/finance-settings`;
      const summaryBase = `/api/households/${HOUSEHOLD.id}/spending-summary`;
      if (url === settingsUrl) {
        if (init?.method === 'PATCH') {
          if (!routes.settingsPatch) {
            throw new Error('unexpected PATCH finance-settings');
          }
          return routes.settingsPatch();
        }
        return (
          routes.settingsGet?.() ??
          jsonResponse({ reportingTimeZone: 'Etc/UTC', version: 0 })
        );
      }
      if (url.startsWith(`${summaryBase}?`)) {
        const query = new URLSearchParams(url.slice(summaryBase.length + 1));
        const from = query.get('from') ?? '';
        const to = query.get('to') ?? '';
        return (
          routes.summaryGet?.(from, to) ??
          jsonResponse({
            from,
            to,
            reportingTimeZone: 'Etc/UTC',
            currencies: [],
          })
        );
      }
      if (url === `${accountBase}?limit=100&offset=0&status=ALL`) {
        return (
          routes.accountsGet?.() ??
          jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false })
        );
      }
      if (url === `${transactionBase}?limit=100&offset=0&view=OWN&status=ALL`) {
        return (
          routes.transactionsGet?.('OWN') ??
          jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false })
        );
      }
      if (
        url ===
        `${transactionBase}?limit=100&offset=0&view=HOUSEHOLD&status=ALL`
      ) {
        return (
          routes.transactionsGet?.('HOUSEHOLD') ??
          jsonResponse({ items: [], limit: 100, offset: 0, hasMore: false })
        );
      }
      if (
        url.startsWith(`${transactionBase}/`) &&
        url.endsWith('/allocation')
      ) {
        const transactionId = decodeURIComponent(
          url.slice(
            transactionBase.length + 1,
            url.length - '/allocation'.length,
          ),
        );
        if (init?.method === 'POST') {
          if (!routes.allocationsPost) {
            throw new Error('unexpected POST allocation');
          }
          return routes.allocationsPost(init);
        }
        if (init?.method === 'PATCH') {
          if (!routes.allocationsPatch) {
            throw new Error('unexpected PATCH allocation');
          }
          return routes.allocationsPatch(transactionId);
        }
        return routes.allocationsGet?.(transactionId) ?? ALLOCATION_NOT_FOUND();
      }
      if (
        url.startsWith(`${transactionBase}/`) &&
        url.endsWith(CATEGORIZATION_SUFFIX)
      ) {
        const transactionId = decodeURIComponent(
          url.slice(
            transactionBase.length + 1,
            url.length - CATEGORIZATION_SUFFIX.length,
          ),
        );
        return (
          routes.categorizationGet?.(transactionId) ??
          jsonResponse(categorizationState({ transactionId }))
        );
      }
      if (
        url.startsWith(`${transactionBase}/`) &&
        url.endsWith('/categorization-rule')
      ) {
        const transactionId = decodeURIComponent(
          url.slice(
            transactionBase.length + 1,
            url.length - '/categorization-rule'.length,
          ),
        );
        if (!routes.rulePost) {
          throw new Error('unexpected POST categorization-rule');
        }
        return routes.rulePost(transactionId);
      }
      const rulesBase = `/api/households/${HOUSEHOLD.id}/categorization-rules`;
      if (url.startsWith(`${rulesBase}?`)) {
        const query = new URLSearchParams(url.slice(rulesBase.length + 1));
        return (
          routes.rulesGet?.(query.get('status'), query.get('offset') ?? '0') ??
          emptyRulePage()
        );
      }
      if (url.startsWith(`${rulesBase}/`) && init?.method === 'PATCH') {
        const ruleId = decodeURIComponent(url.slice(rulesBase.length + 1));
        if (!routes.rulePatch) {
          throw new Error('unexpected PATCH categorization-rule');
        }
        return routes.rulePatch(ruleId);
      }
      if (url.startsWith(`${REVIEWS_BASE}/`) && url.endsWith('/resolve')) {
        const reviewId = decodeURIComponent(
          url.slice(REVIEWS_BASE.length + 1, -'/resolve'.length),
        );
        if (!routes.reviewResolve) {
          throw new Error('unexpected POST categorization-review resolve');
        }
        return routes.reviewResolve(reviewId);
      }
      if (url.startsWith(`${REVIEWS_BASE}/`)) {
        const reviewId = decodeURIComponent(url.slice(REVIEWS_BASE.length + 1));
        if (!routes.reviewGet) {
          throw new Error('unexpected GET categorization-review');
        }
        return routes.reviewGet(reviewId);
      }
      if (url.startsWith(`${REVIEWS_BASE}?`)) {
        const query = new URLSearchParams(url.slice(REVIEWS_BASE.length + 1));
        return routes.reviewsGet?.(query.get('view')) ?? reviewPage([]);
      }
      if (url === transactionBase && init?.method === 'POST') {
        if (!routes.transactionsPost) {
          throw new Error('unexpected POST transactions');
        }
        return routes.transactionsPost();
      }
      if (url.startsWith(`${transactionBase}/`) && init?.method === 'PATCH') {
        const transactionId = decodeURIComponent(
          url.slice(transactionBase.length + 1),
        );
        if (!routes.transactionsPatch) {
          throw new Error('unexpected PATCH transaction');
        }
        return routes.transactionsPatch(transactionId);
      }
      if (url.startsWith(`${transactionBase}/`)) {
        const transactionId = decodeURIComponent(
          url.slice(transactionBase.length + 1),
        );
        if (!routes.transactionGet) {
          throw new Error('unexpected GET transaction detail');
        }
        return routes.transactionGet(transactionId);
      }
      if (url === '/api/auth/csrf') {
        return jsonResponse({
          token: 'csrf-token-2',
          headerName: 'X-CSRF-TOKEN',
        });
      }
      throw new Error(`unexpected fetch ${url} ${init?.method ?? ''}`);
    }),
  );
  return calls;
}

const postCalls = (calls: Call[]) =>
  calls.filter(({ init }) => init?.method === 'POST');
const patchCalls = (calls: Call[]) =>
  calls.filter(({ init }) => init?.method === 'PATCH');

function renderSection(
  routes: RouteHandlers = {},
  options: {
    authorityConfirmed?: boolean;
    household?: Household;
    nowProvider?: () => Date;
    accountsRefreshSignal?: number;
    ledgerRefreshSignal?: number;
  } = {},
) {
  const calls = stubFetch(routes);
  const onCsrfRefreshed = vi.fn();
  const onSessionExpired = vi.fn();
  const onHouseholdAccessChanged = vi.fn();
  const household = options.household ?? HOUSEHOLD;
  const authorityConfirmed = options.authorityConfirmed ?? true;
  const nowProvider = options.nowProvider;
  const rendered = render(
    <TransactionsSection
      household={household}
      currentUserId={ACTOR_ID}
      csrf={CSRF}
      onCsrfRefreshed={onCsrfRefreshed}
      onSessionExpired={onSessionExpired}
      onHouseholdAccessChanged={onHouseholdAccessChanged}
      authorityConfirmed={authorityConfirmed}
      nowProvider={nowProvider}
      accountsRefreshSignal={options.accountsRefreshSignal ?? 0}
      ledgerRefreshSignal={options.ledgerRefreshSignal ?? 0}
    />,
  );
  return {
    ...rendered,
    calls,
    onCsrfRefreshed,
    onSessionExpired,
    onHouseholdAccessChanged,
    rerenderWithLedgerSignal: (signal: number) =>
      rendered.rerender(
        <TransactionsSection
          household={household}
          currentUserId={ACTOR_ID}
          csrf={CSRF}
          onCsrfRefreshed={onCsrfRefreshed}
          onSessionExpired={onSessionExpired}
          onHouseholdAccessChanged={onHouseholdAccessChanged}
          authorityConfirmed={authorityConfirmed}
          nowProvider={nowProvider}
          accountsRefreshSignal={options.accountsRefreshSignal ?? 0}
          ledgerRefreshSignal={signal}
        />,
      ),
    rerenderWithAccountSignal: (signal: number) =>
      rendered.rerender(
        <TransactionsSection
          household={household}
          currentUserId={ACTOR_ID}
          csrf={CSRF}
          onCsrfRefreshed={onCsrfRefreshed}
          onSessionExpired={onSessionExpired}
          onHouseholdAccessChanged={onHouseholdAccessChanged}
          authorityConfirmed={authorityConfirmed}
          nowProvider={nowProvider}
          accountsRefreshSignal={signal}
        />,
      ),
  };
}

const accountPage = (items: FinancialAccount[]) =>
  jsonResponse({ items, limit: 100, offset: 0, hasMore: false });
const transactionPage = (items: Transaction[]) =>
  jsonResponse({ items, limit: 100, offset: 0, hasMore: false });

const TRANSACTION_GET_URL = `/api/households/${HOUSEHOLD.id}/transactions?limit=100&offset=0&view=OWN&status=ALL`;

async function fillAndSubmit(
  overrides: { amount?: string; description?: string; date?: string } = {},
) {
  fireEvent.change(screen.getByLabelText('Account'), {
    target: { value: CHECKING_ID },
  });
  fireEvent.change(screen.getByLabelText('Amount'), {
    target: { value: overrides.amount ?? '12.34' },
  });
  if (overrides.date !== undefined) {
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: overrides.date },
    });
  }
  fireEvent.change(screen.getByLabelText('Description'), {
    target: { value: overrides.description ?? 'Groceries' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Record transaction' }));
}

describe('sibling account-list refresh', () => {
  it('shows a newly created account without discarding the entry draft', async () => {
    let visibleAccounts: FinancialAccount[] = [account()];
    const { rerenderWithAccountSignal } = renderSection({
      accountsGet: () => accountPage([...visibleAccounts]),
      transactionsGet: () => transactionPage([]),
    });
    await screen.findByText('No transactions yet.');

    // An in-progress draft against the known account.
    fireEvent.change(screen.getByLabelText('Account'), {
      target: { value: CHECKING_ID },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '12.34' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Draft groceries' },
    });

    // The sibling commits a new manual account; the next metadata fetch
    // serves it once the parent bumps the signal.
    visibleAccounts = [account(), { ...CASH_ACCOUNT, status: 'ACTIVE' }];
    act(() => {
      rerenderWithAccountSignal(1);
    });

    expect(
      await screen.findByRole('option', { name: 'Pocket cash · JPY' }),
    ).toBeInTheDocument();
    // No remount and no draft reset: every entered value survives.
    expect(screen.getByLabelText('Account')).toHaveValue(CHECKING_ID);
    expect(screen.getByLabelText('Amount')).toHaveValue('12.34');
    expect(screen.getByLabelText('Description')).toHaveValue('Draft groceries');
  });

  it('excludes connected accounts from manual entry without touching the draft', async () => {
    const connected: FinancialAccount = {
      ...account(),
      id: '10000000-0000-4000-8000-000000000009',
      name: 'Everyday Chequing',
      currency: 'CAD',
      source: 'CONNECTED',
    };
    let visibleAccounts: FinancialAccount[] = [account()];
    const { rerenderWithAccountSignal } = renderSection({
      accountsGet: () => accountPage([...visibleAccounts]),
      transactionsGet: () => transactionPage([]),
    });
    await screen.findByText('No transactions yet.');

    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '12.34' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Draft groceries' },
    });

    // A sibling admits a CONNECTED account: manual entry stays MANUAL-only,
    // so the selector must not offer it, and the draft must survive.
    visibleAccounts = [account(), connected];
    act(() => {
      rerenderWithAccountSignal(1);
    });
    expect(
      await screen.findByRole('option', { name: 'Daily spending · BRL' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toHaveValue('12.34');
    expect(screen.getByLabelText('Description')).toHaveValue('Draft groceries');
    expect(
      screen.queryByRole('option', { name: 'Everyday Chequing · CAD' }),
    ).toBeNull();
  });

  it('keeps the last-known selector and draft when the background refetch fails', async () => {
    let failMetadata = false;
    const { calls, rerenderWithAccountSignal } = renderSection({
      accountsGet: () =>
        failMetadata
          ? jsonResponse(
              { code: 'NETWORK_ERROR', message: 'Could not reach the server.' },
              500,
            )
          : accountPage([account()]),
      transactionsGet: () => transactionPage([]),
    });
    await screen.findByText('No transactions yet.');
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Draft groceries' },
    });

    // The background metadata fetch fails: the failure stays silent so the
    // draft keeps focus and the last-known selector survives.
    failMetadata = true;
    act(() => {
      rerenderWithAccountSignal(1);
    });

    const accountsUrl = `/api/households/${HOUSEHOLD.id}/financial-accounts?limit=100&offset=0&status=ALL`;
    await waitFor(() =>
      expect(calls.filter(({ url }) => url === accountsUrl)).toHaveLength(2),
    );
    expect(screen.getByLabelText('Description')).toHaveValue('Draft groceries');
    expect(
      screen.getByRole('option', { name: 'Daily spending · BRL' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('serves a signal that arrives before the initial metadata settles', async () => {
    const accountsUrl = `/api/households/${HOUSEHOLD.id}/financial-accounts?limit=100&offset=0&status=ALL`;
    let accountReads = 0;
    let resolveFirst: ((value: Response) => void) | null = null;
    const { calls, rerenderWithAccountSignal } = renderSection({
      accountsGet: () => {
        accountReads += 1;
        if (accountReads === 1) {
          return new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return accountPage([account(), { ...CASH_ACCOUNT, status: 'ACTIVE' }]);
      },
      transactionsGet: () => transactionPage([]),
    });

    // The sibling commits while the initial load is still in flight: the
    // signal must stay pending, never marked served and dropped.
    act(() => {
      rerenderWithAccountSignal(1);
    });

    // The initial read raced the commit and missed it...
    await act(async () => {
      resolveFirst?.(accountPage([account()]));
    });
    expect(await screen.findByText('No transactions yet.')).toBeInTheDocument();

    // ...but the parked signal drives a post-load fetch that converges.
    expect(
      await screen.findByRole('option', { name: 'Pocket cash · JPY' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.filter(({ url }) => url === accountsUrl)).toHaveLength(2),
    );
  });

  it('publishes only the newest metadata response when refreshes race', async () => {
    const resolvers: Array<(value: Response) => void> = [];
    let accountReads = 0;
    const { rerenderWithAccountSignal } = renderSection({
      accountsGet: () => {
        accountReads += 1;
        if (accountReads === 1) return accountPage([account()]);
        return new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        });
      },
      transactionsGet: () => transactionPage([]),
    });
    await screen.findByText('No transactions yet.');

    const stale = account({
      id: '10000000-0000-4000-8000-000000000003',
      name: 'Stale fund',
      kind: 'SAVINGS',
      currency: 'USD',
    });
    const newest: FinancialAccount = { ...CASH_ACCOUNT, status: 'ACTIVE' };

    act(() => {
      rerenderWithAccountSignal(1);
    });
    act(() => {
      rerenderWithAccountSignal(2);
    });
    expect(resolvers).toHaveLength(2);

    // The newest response resolves first and publishes...
    await act(async () => {
      resolvers[1]?.(accountPage([account(), newest]));
    });
    expect(
      await screen.findByRole('option', { name: 'Pocket cash · JPY' }),
    ).toBeInTheDocument();

    // ...then the superseded older response arrives late and must not
    // overwrite it.
    await act(async () => {
      resolvers[0]?.(accountPage([account(), stale]));
    });
    expect(
      screen.queryByRole('option', { name: 'Stale fund · USD' }),
    ).toBeNull();
    expect(
      screen.getByRole('option', { name: 'Pocket cash · JPY' }),
    ).toBeInTheDocument();
  });

  it('converges account metadata despite an interleaved transaction reload', async () => {
    let accountReads = 0;
    let resolveMetadata: ((value: Response) => void) | null = null;
    const { rerenderWithAccountSignal } = renderSection({
      accountsGet: () => {
        accountReads += 1;
        if (accountReads === 1) return accountPage([account()]);
        return new Promise<Response>((resolve) => {
          resolveMetadata = resolve;
        });
      },
      transactionsGet: () => transactionPage([]),
    });
    await screen.findByText('No transactions yet.');
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Draft groceries' },
    });

    // The sibling commit starts a metadata refresh that stays in flight...
    act(() => {
      rerenderWithAccountSignal(1);
    });

    // ...while a feed reload bumps the shared transaction generation. The
    // metadata fetch is decoupled from that generation, so its response
    // still publishes.
    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));

    await act(async () => {
      resolveMetadata?.(
        accountPage([account(), { ...CASH_ACCOUNT, status: 'ACTIVE' }]),
      );
    });
    expect(
      await screen.findByRole('option', { name: 'Pocket cash · JPY' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toHaveValue('Draft groceries');
  });
});

describe('transaction list', () => {
  it('renders entries with exact amounts, kinds, dates, and privacy text', async () => {
    renderSection({
      accountsGet: () => accountPage([account(), CASH_ACCOUNT]),
      transactionsGet: () =>
        transactionPage([
          transaction(),
          transaction({
            id: '40000000-0000-4000-8000-000000000003',
            kind: 'INCOME',
            money: { amount: '200.00', currency: 'BRL' },
            description: 'Salary',
            occurredOn: '2026-09-15',
          }),
          transaction({
            id: '40000000-0000-4000-8000-000000000004',
            kind: 'TRANSFER',
            money: { amount: '20', currency: 'JPY' },
            description: 'Card payment',
            occurredOn: '2026-09-14',
            accountId: CASH_ID,
          }),
          transaction({
            id: '40000000-0000-4000-8000-000000000005',
            status: 'VOIDED',
            description: 'Cancelled entry',
            money: { amount: '-5.00', currency: 'BRL' },
          }),
        ]),
    });

    await screen.findByText('Groceries');
    const card = (description: string) =>
      screen.getByText(description).closest('li') as HTMLLIElement;
    // Amount strings are exact and currency codes explicit.
    expect(
      within(card('Groceries')).getByText('-12.34 BRL'),
    ).toBeInTheDocument();
    expect(within(card('Salary')).getByText('200.00 BRL')).toBeInTheDocument();
    expect(
      within(card('Card payment')).getByText('20 JPY'),
    ).toBeInTheDocument();
    expect(
      within(card('Cancelled entry')).getByText('-5.00 BRL'),
    ).toBeInTheDocument();
    // Meta text combines kind, date, account, and status in order.
    expect(card('Groceries').textContent).toMatch(
      /Expense · 2026-09-16 · Daily spending · Posted/,
    );
    expect(card('Salary').textContent).toMatch(
      /Income · 2026-09-15 · Daily spending · Posted/,
    );
    expect(card('Card payment').textContent).toMatch(
      /Transfer · 2026-09-14 · Pocket cash · Posted/,
    );
    expect(card('Cancelled entry').textContent).toMatch(
      /Expense · 2026-09-16 · Daily spending · Voided/,
    );

    // Privacy and void state are textual, never color-only.
    expect(screen.getAllByText('Private')).toHaveLength(4);
    expect(
      screen.getByText(
        /Every entry starts private to you. Sharing is explicit/,
      ),
    ).toBeInTheDocument();
    const voidedCard = card('Cancelled entry');
    expect(
      voidedCard.classList.contains('finance-transaction-card--voided'),
    ).toBe(true);
    expect(within(voidedCard).getByText('Voided')).toBeInTheDocument();
    expect(
      within(voidedCard)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Details', 'Share']);
  });

  it('labels a refund with its linked expense from the loaded page', async () => {
    renderSection({
      transactionsGet: () =>
        transactionPage([
          transaction({
            id: REFUND_ID,
            kind: 'REFUND',
            money: { amount: '5.00', currency: 'BRL' },
            description: 'Returned one item',
            occurredOn: '2026-09-17',
            refundOfTransactionId: EXPENSE_ID,
          }),
          transaction(),
        ]),
    });
    await screen.findByText('Returned one item');
    expect(
      screen.getByText('Refund of an expense recorded on 2026-09-16'),
    ).toBeInTheDocument();
  });

  it('keeps the empty state free of synthetic totals', async () => {
    renderSection({
      transactionsGet: () => transactionPage([]),
    });
    expect(await screen.findByText('No transactions yet.')).toBeInTheDocument();
    // The spending dashboard names its per-currency rows honestly
    // ("Expense total") and shows its own empty state; the feed itself
    // fabricates no totals line.
    expect(
      screen.getByText(/No household spending in this period/),
    ).toBeInTheDocument();
    // The member-balances subsection exists for the household but its
    // empty state invents no values: balances come only from real
    // allocations, and no balance number is fabricated anywhere.
    expect(
      screen.getByText(
        /No member balances. Balances appear only after a household expense/,
      ),
    ).toBeInTheDocument();
    // No recorded money line (amount followed by a currency code) exists.
    expect(
      document.body.textContent?.match(
        /-?\d+\.\d{2,3}\s(BRL|USD|EUR|GBP|JPY|KWD)/,
      ),
    ).toBeNull();
  });

  it('reports a failed list with a refresh recovery path', async () => {
    renderSection({
      accountsGet: () =>
        jsonResponse(
          {
            code: 'NETWORK_ERROR',
            message: 'Could not reach the server.',
            correlationId: 'corr-list',
          },
          500,
        ),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not reach the server.',
    );
    expect(screen.getByText('Reference: corr-list')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Record transaction' }),
    ).toBeNull();
  });

  it('ends the session recovery on a 401 list', async () => {
    const { onSessionExpired } = renderSection({
      transactionsGet: () =>
        jsonResponse(
          { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
          401,
        ),
    });
    await waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reconciles lost household access from a generic household 404', async () => {
    const { onHouseholdAccessChanged } = renderSection({
      transactionsGet: () =>
        jsonResponse(
          { code: 'HOUSEHOLD_NOT_FOUND', message: 'Household unavailable.' },
          404,
        ),
    });
    await waitFor(() =>
      expect(onHouseholdAccessChanged).toHaveBeenCalledTimes(1),
    );
    expect(
      screen.queryByRole('button', { name: 'Record transaction' }),
    ).toBeNull();
  });

  it('defaults the date to the household-zone today, not the browser zone', async () => {
    renderSection({});
    await screen.findByText('No transactions yet.');
    const dateInput = screen.getByLabelText('Date') as HTMLInputElement;
    expect(dateInput.value).toBe(new Date().toISOString().slice(0, 10));
    expect(dateInput).toHaveAttribute('min', '1900-01-01');
    expect(dateInput).toHaveAttribute('max', '9999-12-30');
  });
});

describe('transaction creation', () => {
  it('sends the exact documented body with visibility, CSRF, and one fresh key', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () => jsonResponse(transaction(), 201),
    });
    await screen.findByText('No transactions yet.');
    await fillAndSubmit({ date: FIXED_DATE });

    expect(
      await screen.findByText(`Expense recorded: -12.34 BRL on ${FIXED_DATE}.`),
    ).toBeInTheDocument();
    const posts = postCalls(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.init?.headers).toMatchObject({
      'X-CSRF-TOKEN': CSRF.token,
    });
    const key = (posts[0]?.init?.headers as Record<string, string>)[
      'Idempotency-Key'
    ];
    expect(key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(JSON.parse(String(posts[0]?.init?.body))).toEqual({
      accountId: CHECKING_ID,
      kind: 'EXPENSE',
      money: { amount: '-12.34', currency: 'BRL' },
      occurredOn: FIXED_DATE,
      description: 'Groceries',
      visibility: 'PRIVATE',
      category: null,
    });
  });

  it('encodes income and transfer signs from the kind and direction', async () => {
    let postCount = 0;
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () => {
        postCount += 1;
        const responses: Record<
          number,
          { amount: string; kind: 'INCOME' | 'TRANSFER' }
        > = {
          1: { amount: '200.00', kind: 'INCOME' },
          2: { amount: '-50.00', kind: 'TRANSFER' },
          3: { amount: '30.00', kind: 'TRANSFER' },
        };
        const entry = responses[postCount] ?? {
          amount: '1.00',
          kind: 'TRANSFER',
        };
        return jsonResponse(
          transaction({
            id: `40000000-0000-4000-8000-00000000000${postCount + 3}`,
            kind: entry.kind,
            money: { amount: entry.amount, currency: 'BRL' },
            description: `Entry ${postCount}`,
          }),
          201,
        );
      },
    });
    await screen.findByText('No transactions yet.');

    // Income: positive magnitude, positive wire amount.
    fireEvent.change(screen.getByLabelText('Account'), {
      target: { value: CHECKING_ID },
    });
    fireEvent.change(screen.getByLabelText('Entry type'), {
      target: { value: 'INCOME' },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '200' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Salary' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record transaction' }));
    expect(
      await screen.findByText(`Income recorded: 200.00 BRL on ${FIXED_DATE}.`),
    ).toBeInTheDocument();

    // Transfer out: negative wire amount.
    fireEvent.change(screen.getByLabelText('Entry type'), {
      target: { value: 'TRANSFER' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Money out (−)' }));
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '50' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Card payment' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record transaction' }));
    expect(
      await screen.findByText(
        `Transfer recorded: -50.00 BRL on ${FIXED_DATE}.`,
      ),
    ).toBeInTheDocument();

    // Transfer in: positive wire amount.
    fireEvent.click(screen.getByRole('radio', { name: 'Money in (+)' }));
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '30.0' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'ATM deposit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record transaction' }));
    expect(
      await screen.findByText(`Transfer recorded: 30.00 BRL on ${FIXED_DATE}.`),
    ).toBeInTheDocument();

    const bodies = postCalls(calls).map(
      (call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>,
    );
    expect(bodies).toHaveLength(3);
    expect(bodies[0]?.kind).toBe('INCOME');
    expect(bodies[0]?.money).toEqual({ amount: '200.00', currency: 'BRL' });
    expect(bodies[1]?.kind).toBe('TRANSFER');
    expect(bodies[1]?.money).toEqual({ amount: '-50.00', currency: 'BRL' });
    expect(bodies[2]?.money).toEqual({ amount: '30.00', currency: 'BRL' });
  });

  it('rejects invalid amounts locally without any request', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([CASH_ACCOUNT]),
      transactionsGet: () => transactionPage([]),
    });
    await screen.findByText('No transactions yet.');
    fireEvent.change(screen.getByLabelText('Account'), {
      target: { value: CASH_ID },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Test entry' },
    });
    const expectError = async (amount: string, message: string | RegExp) => {
      fireEvent.change(screen.getByLabelText('Amount'), {
        target: { value: amount },
      });
      fireEvent.click(
        screen.getByRole('button', { name: 'Record transaction' }),
      );
      expect(await screen.findByText(message)).toBeInTheDocument();
    };

    await expectError('12,50', /Enter the amount as plain digits/);
    await expectError('12.345', 'JPY amounts have no decimal places.');
    await expectError('1.0', 'JPY amounts have no decimal places.');
    await expectError('0', 'Enter a nonzero amount.');
    await expectError('01.5', /Enter the amount as plain digits/);
    await expectError('1000000000000', 'The amount is too large.');
    await expectError('12 ', 'Remove spaces from the amount.');
    expect(postCalls(calls)).toHaveLength(0);
    expect(patchCalls(calls)).toHaveLength(0);
  });

  it('requires an account before any request is sent', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
    });
    await screen.findByText('No transactions yet.');
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '12.34' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Groceries' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record transaction' }));
    expect(await screen.findByText('Choose an account.')).toBeInTheDocument();
    expect(postCalls(calls)).toHaveLength(0);
    // The announced value preview never invents a currency.
    expect(
      screen.getByText('Choose an account to see the recorded value.'),
    ).toBeInTheDocument();
  });

  it('rejects an impossible or out-of-range date locally', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
    });
    await screen.findByText('No transactions yet.');
    fireEvent.change(screen.getByLabelText('Account'), {
      target: { value: CHECKING_ID },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '12.34' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Groceries' },
    });
    for (const bad of [
      '2026-02-30',
      '1899-12-31',
      '9999-12-31',
      'not-a-date',
    ]) {
      fireEvent.change(screen.getByLabelText('Date'), {
        target: { value: bad },
      });
      fireEvent.click(
        screen.getByRole('button', { name: 'Record transaction' }),
      );
      expect(
        await screen.findByText(
          'Enter a calendar date between 1900-01-01 and 9999-12-30.',
        ),
      ).toBeInTheDocument();
    }
    expect(postCalls(calls)).toHaveLength(0);
  });

  it('warns about a future date but records it when confirmed', async () => {
    const future = '2099-01-01';
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () =>
        jsonResponse(transaction({ occurredOn: future }), 201),
    });
    await screen.findByText('No transactions yet.');
    fireEvent.change(screen.getByLabelText('Account'), {
      target: { value: CHECKING_ID },
    });
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: future },
    });
    expect(
      await screen.findByText(
        /This date is in the future. It stays a recorded fact/,
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '12.34' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Prepaid rent' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record transaction' }));
    expect(
      await screen.findByText(`Expense recorded: -12.34 BRL on ${future}.`),
    ).toBeInTheDocument();
    expect(postCalls(calls)).toHaveLength(1);
  });

  it('describes the encoded value before submission with the currency code', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
    });
    await screen.findByText('No transactions yet.');
    fireEvent.change(screen.getByLabelText('Account'), {
      target: { value: CHECKING_ID },
    });
    expect(screen.getByText('Records nothing yet in BRL.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '12.3' },
    });
    expect(screen.getByText('Records -12.30 BRL.')).toBeInTheDocument();
  });
});

describe('refund creation', () => {
  it('originates from a posted expense and locks account, currency, and source', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      transactionsPost: () =>
        jsonResponse(
          transaction({
            id: REFUND_ID,
            kind: 'REFUND',
            money: { amount: '5.00', currency: 'BRL' },
            description: 'Returned one item',
            refundOfTransactionId: EXPENSE_ID,
          }),
          201,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Record a refund for Groceries' }),
    );
    expect(
      await screen.findByText(
        /Refund of the expense “Groceries” recorded on 2026-09-16/,
      ),
    ).toBeInTheDocument();
    // No account or entry-type select is offered in refund mode.
    expect(screen.queryByLabelText('Account')).toBeNull();
    expect(screen.queryByLabelText('Entry type')).toBeNull();

    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '5' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Returned one item' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record transaction' }));
    expect(
      await screen.findByText(`Refund recorded: 5.00 BRL on ${FIXED_DATE}.`),
    ).toBeInTheDocument();
    const body = JSON.parse(String(postCalls(calls)[0]?.init?.body)) as Record<
      string,
      unknown
    >;
    expect(body.refundOfTransactionId).toBe(EXPENSE_ID);
    expect(body.kind).toBe('REFUND');
    expect(body.money).toEqual({ amount: '5.00', currency: 'BRL' });
    // Visibility is inherited by omission, never sent explicitly.
    expect(body.visibility).toBeUndefined();
  });

  it('rejects a refund dated before its expense locally', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      transactionsPost: () =>
        jsonResponse(
          transaction({
            id: REFUND_ID,
            kind: 'REFUND',
            money: { amount: '5.00', currency: 'BRL' },
            description: 'Same-day return',
            refundOfTransactionId: EXPENSE_ID,
          }),
          201,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Record a refund for Groceries' }),
    );
    await screen.findByText(/Refund of the expense/);
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '5.00' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Too early' },
    });
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: '2026-09-15' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record transaction' }));
    expect(
      await screen.findByText(
        `The refund date cannot be before the expense date (${FIXED_DATE}).`,
      ),
    ).toBeInTheDocument();
    expect(postCalls(calls)).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: FIXED_DATE },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record transaction' }));
    expect(
      await screen.findByText(`Refund recorded: 5.00 BRL on ${FIXED_DATE}.`),
    ).toBeInTheDocument();
    expect(postCalls(calls)).toHaveLength(1);
  });

  it('maps refund conflicts to a refresh-and-check message', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      transactionsPost: () =>
        jsonResponse(
          {
            code: 'REFUND_CONFLICT',
            message: 'The expense was fully refunded.',
          },
          409,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Record a refund for Groceries' }),
    );
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '5.00' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Returned one item' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record transaction' }));
    expect(
      await screen.findByText(
        'The refund no longer matches its expense. Refresh the list and check the expense.',
      ),
    ).toBeInTheDocument();
  });
});

describe('durable creation retries', () => {
  it('retries an unknown outcome with the exact same key and payload', async () => {
    let attempts = 0;
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse(
              {
                code: 'FINANCE_BUSY',
                message: 'The household is busy; outcome may be unknown.',
                correlationId: 'corr-busy',
              },
              503,
            )
          : jsonResponse(transaction(), 201);
      },
    });
    await screen.findByText('No transactions yet.');
    await fillAndSubmit({ date: FIXED_DATE });

    expect(await screen.findByText(/unknown outcome/i)).toBeInTheDocument();
    // The failed attempt must not clear the retained request: the form
    // stays disabled so the payload cannot be edited under the live key.
    expect(screen.getByLabelText('Amount')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Retry same request' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
    expect(
      await screen.findByText(`Expense recorded: -12.34 BRL on ${FIXED_DATE}.`),
    ).toBeInTheDocument();
    const posts = postCalls(calls);
    expect(posts).toHaveLength(2);
    const firstKey = (posts[0]?.init?.headers as Record<string, string>)[
      'Idempotency-Key'
    ];
    expect(
      (posts[1]?.init?.headers as Record<string, string>)['Idempotency-Key'],
    ).toBe(firstKey);
    expect(JSON.parse(String(posts[1]?.init?.body))).toEqual(
      JSON.parse(String(posts[0]?.init?.body)),
    );
  });

  it('treats a network failure as an unknown outcome too', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await screen.findByText('No transactions yet.');
    await fillAndSubmit({ date: FIXED_DATE });
    expect(await screen.findByText(/unknown outcome/i)).toBeInTheDocument();
    expect(postCalls(calls)).toHaveLength(1);
  });

  it('refreshes the token and requires an explicit same-key retry after CSRF rejection', async () => {
    let attempts = 0;
    const { calls, onCsrfRefreshed } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse(
              { code: 'CSRF_INVALID', message: 'Security check failed.' },
              403,
            )
          : jsonResponse(transaction(), 201);
      },
    });
    await screen.findByText('No transactions yet.');
    await fillAndSubmit({ date: FIXED_DATE });
    expect(
      await screen.findByText(
        'Your security token was refreshed. Retry the same transaction request.',
      ),
    ).toBeInTheDocument();
    expect(onCsrfRefreshed).toHaveBeenCalledWith({
      token: 'csrf-token-2',
      headerName: 'X-CSRF-TOKEN',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
    expect(
      await screen.findByText(`Expense recorded: -12.34 BRL on ${FIXED_DATE}.`),
    ).toBeInTheDocument();
    const posts = postCalls(calls);
    expect(posts).toHaveLength(2);
    expect(
      (posts[0]?.init?.headers as Record<string, string>)['X-CSRF-TOKEN'],
    ).toBe('csrf-token-1');
    expect(
      (posts[1]?.init?.headers as Record<string, string>)['X-CSRF-TOKEN'],
    ).toBe('csrf-token-2');
    expect(
      (posts[1]?.init?.headers as Record<string, string>)['Idempotency-Key'],
    ).toBe(
      (posts[0]?.init?.headers as Record<string, string>)['Idempotency-Key'],
    );
  });

  it('keeps the retained same-key retry available across a deliberate refresh', async () => {
    let attempts = 0;
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse({ code: 'FINANCE_BUSY', message: 'Busy.' }, 503)
          : jsonResponse(transaction(), 201);
      },
    });
    await screen.findByText('No transactions yet.');
    await fillAndSubmit({ date: FIXED_DATE });
    expect(await screen.findByText(/unknown outcome/i)).toBeInTheDocument();

    fireEvent.click(
      screen.getAllByRole('button', { name: 'Refresh transactions' })[0]!,
    );
    expect(await screen.findByText(/unknown result/i)).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry same request' });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    expect(
      await screen.findByText(`Expense recorded: -12.34 BRL on ${FIXED_DATE}.`),
    ).toBeInTheDocument();
    const posts = postCalls(calls);
    expect(
      (posts[1]?.init?.headers as Record<string, string>)['Idempotency-Key'],
    ).toBe(
      (posts[0]?.init?.headers as Record<string, string>)['Idempotency-Key'],
    );
    expect(screen.queryByText(/unknown result/i)).toBeNull();
  });

  it('clears the retained request when a create ends in session expiry', async () => {
    const { onSessionExpired } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () =>
        jsonResponse(
          { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
          401,
        ),
    });
    await screen.findByText('No transactions yet.');
    await fillAndSubmit({ date: FIXED_DATE });
    await waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole('button', { name: 'Retry same request' }),
    ).toBeNull();
  });

  it('clears the retained request and reconciles on access loss from a create', async () => {
    const { onHouseholdAccessChanged } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () =>
        jsonResponse(
          { code: 'HOUSEHOLD_NOT_FOUND', message: 'Household unavailable.' },
          404,
        ),
    });
    await screen.findByText('No transactions yet.');
    await fillAndSubmit({ date: FIXED_DATE });
    await waitFor(() =>
      expect(onHouseholdAccessChanged).toHaveBeenCalledTimes(1),
    );
    expect(
      screen.queryByRole('button', { name: 'Retry same request' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Record transaction' }),
    ).toBeNull();
  });

  it('guards duplicate create submissions before state flushes', async () => {
    let resolvePost!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolvePost = resolve;
    });
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () => gate,
    });
    await screen.findByText('No transactions yet.');
    fireEvent.change(screen.getByLabelText('Account'), {
      target: { value: CHECKING_ID },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '12.34' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Groceries' },
    });
    const submit = screen.getByRole('button', { name: 'Record transaction' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    resolvePost(jsonResponse(transaction(), 201));
    expect(
      await screen.findByText(`Expense recorded: -12.34 BRL on ${FIXED_DATE}.`),
    ).toBeInTheDocument();
    expect(postCalls(calls)).toHaveLength(1);
  });

  it('maps a server amount error onto the field and preserves the input', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () =>
        jsonResponse(
          {
            code: 'VALIDATION_FAILED',
            message: 'Check the highlighted fields.',
            correlationId: 'corr-field',
            fieldErrors: {
              'money.amount': 'That amount is not accepted.',
            },
          },
          400,
        ),
    });
    await screen.findByText('No transactions yet.');
    await fillAndSubmit({ date: FIXED_DATE });
    expect(
      await screen.findByText('That amount is not accepted.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toHaveValue('12.34');
    expect(screen.getByLabelText('Amount')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByText('Reference: corr-field')).toBeInTheDocument();
  });

  it('maps a server category error onto the category field', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () =>
        jsonResponse(
          {
            code: 'VALIDATION_FAILED',
            message: 'Check the highlighted fields.',
            correlationId: 'corr-category',
            fieldErrors: {
              category: 'That category is not accepted.',
            },
          },
          400,
        ),
    });
    await screen.findByText('No transactions yet.');
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'GROCERIES' },
    });
    await fillAndSubmit({ date: FIXED_DATE });
    expect(
      await screen.findByText('That category is not accepted.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Category')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByText('Reference: corr-category')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry same request' }),
    ).toBeNull();
  });

  it('explains an archived-account rejection without a durable retry', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () =>
        jsonResponse(
          { code: 'ACCOUNT_ARCHIVED', message: 'Account is archived.' },
          409,
        ),
    });
    await screen.findByText('No transactions yet.');
    await fillAndSubmit({ date: FIXED_DATE });
    expect(
      await screen.findByText(
        'That account is archived now. Refresh accounts before recording here.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry same request' }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Record transaction' }),
    ).toBeEnabled();
  });

  it('offers the refresh affordance when the account or expense is gone', async () => {
    const cases: Array<[string, string]> = [
      [
        'FINANCIAL_ACCOUNT_NOT_FOUND',
        'The account for this entry is no longer available. Refresh accounts.',
      ],
      [
        'TRANSACTION_NOT_FOUND',
        'The expense this refund refers to is no longer available. Refresh the list.',
      ],
    ];
    for (const [code, text] of cases) {
      const { unmount } = renderSection({
        accountsGet: () => accountPage([account()]),
        transactionsGet: () => transactionPage([]),
        transactionsPost: () =>
          jsonResponse({ code, message: 'Missing resource.' }, 404),
      });
      await screen.findByText('No transactions yet.');
      await fillAndSubmit({ date: FIXED_DATE });
      expect(await screen.findByText(text)).toBeInTheDocument();
      // The refresh affordance recovers the missing reference; the failure
      // is known, so no durable same-key retry is retained.
      expect(
        screen.getByRole('button', { name: 'Refresh transactions' }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Retry same request' }),
      ).toBeNull();
      unmount();
    }
  });

  it('starts a fresh instance without the retained key after a keyed remount', async () => {
    let attempts = 0;
    const first = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse({ code: 'FINANCE_BUSY', message: 'Busy.' }, 503)
          : jsonResponse(transaction(), 201);
      },
    });
    await screen.findByText('No transactions yet.');
    await fillAndSubmit({ date: FIXED_DATE });
    expect(await screen.findByText(/unknown outcome/i)).toBeInTheDocument();
    const retainedKey = (
      postCalls(first.calls)[0]?.init?.headers as Record<string, string>
    )['Idempotency-Key'];
    first.unmount();

    const second = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () => jsonResponse(transaction(), 201),
    });
    expect(await screen.findByText('No transactions yet.')).toBeInTheDocument();
    expect(screen.queryByText(/unknown result/i)).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Retry same request' }),
    ).toBeNull();
    await fillAndSubmit({ date: FIXED_DATE });
    expect(
      await screen.findByText(`Expense recorded: -12.34 BRL on ${FIXED_DATE}.`),
    ).toBeInTheDocument();
    const freshKey = (
      postCalls(second.calls)[0]?.init?.headers as Record<string, string>
    )['Idempotency-Key'];
    expect(freshKey).not.toBe(retainedKey);
  });
});

describe('corrections', () => {
  const EDIT_AMOUNT =
    '#edit-transaction-amount-40000000-0000-4000-8000-000000000001';

  it('edits amount and description with the expected version', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      transactionsPatch: () =>
        jsonResponse(
          transaction({
            money: { amount: '-20.00', currency: 'BRL' },
            description: 'Weekly groceries',
            version: 1,
          }),
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Groceries' }));
    const amountInput = await screen.findByLabelText('Amount', {
      selector: '#edit-transaction-amount-40000000-0000-4000-8000-000000000001',
    });
    // The magnitude is seeded without the sign; the sign follows the kind.
    expect(amountInput).toHaveValue('12.34');
    fireEvent.change(amountInput, { target: { value: '20' } });
    fireEvent.change(
      screen.getByLabelText('Description', {
        selector:
          '#edit-transaction-description-40000000-0000-4000-8000-000000000001',
      }),
      { target: { value: 'Weekly groceries' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));

    expect(
      await screen.findByText(
        `Transaction corrected: -20.00 BRL on ${FIXED_DATE}.`,
      ),
    ).toBeInTheDocument();
    const patches = patchCalls(calls);
    expect(patches).toHaveLength(1);
    expect(JSON.parse(String(patches[0]?.init?.body))).toEqual({
      expectedVersion: 0,
      money: { amount: '-20.00', currency: 'BRL' },
      description: 'Weekly groceries',
    });
  });

  it('recovers from a stale version by closing the editor and reloading first', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      transactionsPatch: () =>
        jsonResponse(
          {
            code: 'RESOURCE_VERSION_CONFLICT',
            message: 'Stale update.',
            correlationId: 'corr-stale',
          },
          409,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Groceries' }));
    fireEvent.change(
      await screen.findByLabelText('Amount', { selector: EDIT_AMOUNT }),
      { target: { value: '20' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));

    expect(
      await screen.findByText(
        'This transaction changed on the server. The list was refreshed; review before retrying.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Reference: corr-stale')).toBeInTheDocument();
    // The stale editor is closed; a reload ran before any correction.
    expect(
      screen.queryByRole('button', { name: 'Save correction' }),
    ).toBeNull();
    const transactionGets = calls.filter(
      ({ url }) => url === TRANSACTION_GET_URL,
    );
    expect(transactionGets.length).toBeGreaterThanOrEqual(2);
  });

  it('excludes voided records from edit and void controls', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () =>
        transactionPage([transaction({ status: 'VOIDED' })]),
    });
    await screen.findByText('Groceries');
    expect(screen.queryByRole('button', { name: 'Edit Groceries' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Void Groceries' })).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: 'Record a refund for Groceries',
      }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    ).toBeEnabled();
  });

  it('maps voided-edit and refund-bound rejections to their guidance', async () => {
    const cases: Array<[Response, RegExp]> = [
      [
        jsonResponse({ code: 'TRANSACTION_VOIDED' }, 409),
        /This transaction changed on the server/,
      ],
      [
        jsonResponse({ code: 'REFUND_CONFLICT' }, 409),
        /The correction conflicts with this expense's refunds/,
      ],
    ];
    for (const [response, text] of cases) {
      const { unmount } = renderSection({
        accountsGet: () => accountPage([account()]),
        transactionsGet: () => transactionPage([transaction()]),
        transactionsPatch: () => response,
      });
      await screen.findByText('Groceries');
      fireEvent.click(screen.getByRole('button', { name: 'Edit Groceries' }));
      fireEvent.change(
        await screen.findByLabelText('Amount', { selector: EDIT_AMOUNT }),
        { target: { value: '20' } },
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
      expect(await screen.findByText(text)).toBeInTheDocument();
      unmount();
    }
  });

  it('drops a stale row and offers refresh after a not-found correction', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      transactionsPatch: () =>
        jsonResponse(
          {
            code: 'TRANSACTION_NOT_FOUND',
            message: 'Transaction is unavailable.',
            correlationId: 'corr-404',
          },
          404,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Groceries' }));
    fireEvent.change(
      await screen.findByLabelText('Amount', { selector: EDIT_AMOUNT }),
      { target: { value: '20' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    expect(
      await screen.findByText(
        'This transaction is no longer available to you. Refresh to see the current list.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Groceries')).toBeNull();
  });

  it('keeps an expense date at or before its live refunds', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () =>
        transactionPage([
          transaction(),
          transaction({
            id: REFUND_ID,
            kind: 'REFUND',
            money: { amount: '5.00', currency: 'BRL' },
            description: 'Partial return',
            occurredOn: '2026-09-18',
            refundOfTransactionId: EXPENSE_ID,
          }),
        ]),
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Groceries' }));
    fireEvent.change(
      await screen.findByLabelText('Date', {
        selector: '#edit-transaction-date-40000000-0000-4000-8000-000000000001',
      }),
      { target: { value: '2026-09-20' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    expect(
      await screen.findByText(
        'This expense has refunds on 2026-09-18; its date cannot be later.',
      ),
    ).toBeInTheDocument();
  });

  it('blocks an expense amount below its posted refunds on the loaded page', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () =>
        transactionPage([
          transaction(),
          transaction({
            id: REFUND_ID,
            kind: 'REFUND',
            money: { amount: '5.00', currency: 'BRL' },
            description: 'Partial return',
            occurredOn: '2026-09-18',
            refundOfTransactionId: EXPENSE_ID,
          }),
          // Voided refunds never count toward the documented sum bound.
          transaction({
            id: '40000000-0000-4000-8000-000000000004',
            kind: 'REFUND',
            money: { amount: '100.00', currency: 'BRL' },
            description: 'Cancelled return',
            occurredOn: '2026-09-19',
            refundOfTransactionId: EXPENSE_ID,
            status: 'VOIDED',
          }),
        ]),
      transactionsPatch: () =>
        jsonResponse(
          transaction({
            money: { amount: '-5.00', currency: 'BRL' },
            version: 1,
          }),
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Groceries' }));
    fireEvent.change(
      await screen.findByLabelText('Amount', { selector: EDIT_AMOUNT }),
      { target: { value: '4' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    expect(
      await screen.findByText(
        'This expense has posted refunds totalling 5.00 BRL on this page; the corrected amount cannot be below that total. Refunds beyond this page stay a server check.',
      ),
    ).toBeInTheDocument();
    expect(patchCalls(calls)).toHaveLength(0);

    // Meeting the known total exactly is allowed; unpaged history remains
    // a server `REFUND_CONFLICT`, not a client claim.
    fireEvent.change(
      screen.getByLabelText('Amount', { selector: EDIT_AMOUNT }),
      { target: { value: '5.00' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    expect(
      await screen.findByText(/Transaction corrected: -5\.00 BRL/),
    ).toBeInTheDocument();
    expect(patchCalls(calls)).toHaveLength(1);
    expect(JSON.parse(String(patchCalls(calls)[0]?.init?.body))).toMatchObject({
      money: { amount: '-5.00', currency: 'BRL' },
    });
  });

  it('keeps an unrelated detail open when a correction 404s', async () => {
    const OTHER_ID = '40000000-0000-4000-8000-000000000003';
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () =>
        transactionPage([
          transaction(),
          transaction({
            id: OTHER_ID,
            description: 'Bus fare',
            money: { amount: '-4.50', currency: 'BRL' },
          }),
        ]),
      transactionGet: (transactionId) =>
        jsonResponse(transaction({ id: transactionId })),
      transactionsPatch: () =>
        jsonResponse(
          {
            code: 'TRANSACTION_NOT_FOUND',
            message: 'Transaction is unavailable.',
            correlationId: 'corr-404',
          },
          404,
        ),
    });
    await screen.findByText('Groceries');
    // Open the unrelated entry's detail panel first.
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    expect(
      await screen.findByRole('group', { name: 'Details for Groceries' }),
    ).toBeInTheDocument();
    // Correct the other row; it 404s.
    fireEvent.click(screen.getByRole('button', { name: 'Edit Bus fare' }));
    fireEvent.change(
      await screen.findByLabelText('Amount', {
        selector: `#edit-transaction-amount-${OTHER_ID}`,
      }),
      { target: { value: '5' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    expect(
      await screen.findByText(
        'This transaction is no longer available to you. Refresh to see the current list.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Bus fare')).toBeNull();
    // The cleanup is scoped: the unaffected detail panel survives.
    expect(
      screen.getByRole('group', { name: 'Details for Groceries' }),
    ).toBeInTheDocument();
  });

  it('closes locally without a request when the correction changes nothing', async () => {
    const { calls } = renderSection({
      transactionsGet: () => transactionPage([transaction()]),
      transactionsPatch: () => {
        throw new Error('unexpected PATCH transaction');
      },
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Groceries' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));

    // The unchanged correction resolves locally: a status, a closed editor,
    // no `{expectedVersion}`-only request.
    expect(
      await screen.findByText(
        'The correction matches the recorded entry. Nothing to save.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Save correction' }),
    ).toBeNull();
    await waitFor(() =>
      expect(
        document.getElementById(`edit-trigger-${EXPENSE_ID}`),
      ).toHaveFocus(),
    );
    expect(patchCalls(calls)).toHaveLength(0);
  });

  it('warns about a future date in the correction form', async () => {
    renderSection({
      transactionsGet: () => transactionPage([transaction()]),
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Groceries' }));
    fireEvent.change(
      await screen.findByLabelText('Date', {
        selector: '#edit-transaction-date-40000000-0000-4000-8000-000000000001',
      }),
      { target: { value: '2099-01-01' } },
    );
    expect(
      await screen.findByText(
        /This date is in the future. It stays a recorded fact/,
      ),
    ).toBeInTheDocument();
  });

  it('restores focus to the Edit trigger after cancelling the correction', async () => {
    renderSection({
      transactionsGet: () => transactionPage([transaction()]),
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Groceries' }));
    await screen.findByLabelText('Amount', { selector: EDIT_AMOUNT });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(
        document.getElementById(`edit-trigger-${EXPENSE_ID}`),
      ).toHaveFocus(),
    );
    expect(
      screen.queryByRole('button', { name: 'Save correction' }),
    ).toBeNull();
  });
});

describe('voiding', () => {
  it('voids through an explicit keyboard-cancellable confirmation', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      transactionsPatch: () =>
        jsonResponse(transaction({ status: 'VOIDED', version: 1 })),
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Void Groceries' }));
    const panel = screen.getByRole('group', {
      name: 'Confirm void for Groceries',
    });
    expect(panel).toHaveFocus();
    expect(
      within(panel).getByText(/stays listed as voided/),
    ).toBeInTheDocument();

    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(
      screen.queryByRole('group', { name: 'Confirm void for Groceries' }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Void Groceries' }),
    ).toHaveFocus();
    expect(patchCalls(calls)).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Void Groceries' }));
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Confirm void for Groceries' }),
      ).getByRole('button', { name: 'Void transaction' }),
    );
    expect(
      await screen.findByText(
        'Transaction voided. It stays listed as voided and stops counting toward spending.',
      ),
    ).toBeInTheDocument();
    const patches = patchCalls(calls);
    expect(patches).toHaveLength(1);
    expect(JSON.parse(String(patches[0]?.init?.body))).toEqual({
      expectedVersion: 0,
      status: 'VOIDED',
    });
  });

  it('requires voiding live refunds before voiding the expense', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      transactionsPatch: () =>
        jsonResponse(
          { code: 'REFUND_CONFLICT', message: 'Live refunds exist.' },
          409,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Void Groceries' }));
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Confirm void for Groceries' }),
      ).getByRole('button', { name: 'Void transaction' }),
    );
    expect(
      await screen.findByText(
        'Void its refunds before voiding this expense. Refresh the list to see them.',
      ),
    ).toBeInTheDocument();
  });

  it('never lets a second trigger replace an open void confirmation', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () =>
        transactionPage([
          transaction(),
          transaction({
            id: '40000000-0000-4000-8000-000000000003',
            kind: 'INCOME',
            money: { amount: '200.00', currency: 'BRL' },
            description: 'Salary',
            occurredOn: '2026-09-15',
          }),
        ]),
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Void Groceries' }));
    const panel = screen.getByRole('group', {
      name: 'Confirm void for Groceries',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Void Salary' }));
    expect(
      screen.queryByRole('group', { name: 'Confirm void for Salary' }),
    ).toBeNull();
    expect(panel).toBeInTheDocument();
  });

  it('maps known stale and voided rejections to reload-first guidance', async () => {
    const cases: Array<[Response, RegExp]> = [
      [
        jsonResponse(
          { code: 'RESOURCE_VERSION_CONFLICT', message: 'Stale update.' },
          409,
        ),
        /This transaction changed on the server/,
      ],
      [
        jsonResponse(
          { code: 'RESOURCE_VERSION_EXHAUSTED', message: 'Version limit.' },
          409,
        ),
        /This transaction changed on the server/,
      ],
      [
        jsonResponse(
          { code: 'TRANSACTION_VOIDED', message: 'Already voided.' },
          409,
        ),
        /This transaction changed on the server/,
      ],
    ];
    for (const [response, text] of cases) {
      const { unmount } = renderSection({
        accountsGet: () => accountPage([account()]),
        transactionsGet: () => transactionPage([transaction()]),
        transactionsPatch: () => response,
      });
      await screen.findByText('Groceries');
      fireEvent.click(screen.getByRole('button', { name: 'Void Groceries' }));
      fireEvent.click(
        within(
          screen.getByRole('group', { name: 'Confirm void for Groceries' }),
        ).getByRole('button', { name: 'Void transaction' }),
      );
      expect(await screen.findByText(text)).toBeInTheDocument();
      // A known rejection never claims an unknown outcome or a success.
      expect(screen.queryByText(/unknown outcome/i)).toBeNull();
      expect(screen.queryByText(/Transaction voided\./)).toBeNull();
      unmount();
    }
  });

  it('maps FINANCE_BUSY contention to unknown-outcome guidance', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      transactionsPatch: () =>
        jsonResponse(
          {
            code: 'FINANCE_BUSY',
            message: 'The finance system is busy. Try again shortly.',
            correlationId: 'corr-void-busy',
          },
          503,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Void Groceries' }));
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Confirm void for Groceries' }),
      ).getByRole('button', { name: 'Void transaction' }),
    );
    expect(
      await screen.findByText(
        'The void has an unknown outcome. Refresh the list before retrying.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Transaction voided\./)).toBeNull();
    expect(screen.getByText('Reference: corr-void-busy')).toBeInTheDocument();
    // The unknown outcome forces a refresh of both loaded projections.
    await waitFor(() =>
      expect(
        calls.filter(({ url }) => url === TRANSACTION_GET_URL),
      ).toHaveLength(2),
    );
  });
});

describe('detail', () => {
  it('fetches and shows the exact documented fields', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      transactionGet: (transactionId) => {
        expect(transactionId).toBe(EXPENSE_ID);
        return jsonResponse(transaction());
      },
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Details for Groceries',
    });
    await waitFor(() => expect(panel).toHaveFocus());
    expect(within(panel).getByText('-12.34 BRL')).toBeInTheDocument();
    expect(within(panel).getByText(FIXED_DATE)).toBeInTheDocument();
    expect(within(panel).getByText('Groceries')).toBeInTheDocument();
    expect(within(panel).getByText('Posted')).toBeInTheDocument();
    expect(within(panel).getByText('None — not a refund')).toBeInTheDocument();
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Close details' }),
    );
    expect(
      screen.queryByRole('group', { name: 'Details for Groceries' }),
    ).toBeNull();
  });

  it('drops the stale row when the detail is no longer authorized', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      transactionGet: () =>
        jsonResponse(
          {
            code: 'TRANSACTION_NOT_FOUND',
            message: 'Transaction is unavailable.',
            correlationId: 'corr-detail-404',
          },
          404,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    expect(
      await screen.findByText(
        'This transaction is no longer available to you. Refresh to see the current list.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Groceries')).toBeNull();
    expect(screen.getByText('Reference: corr-detail-404')).toBeInTheDocument();
  });

  it('aborts the detail request on unmount', async () => {
    let capturedSignal: AbortSignal | null | undefined;
    const { calls, unmount } = renderSection({
      transactionsGet: () => transactionPage([transaction()]),
      transactionGet: () =>
        new Promise<Response>(() => {
          // Never resolves; the tracked controller must be aborted by the
          // unmount cleanup exactly like every other owned request.
        }),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    // The `calls` array is mutated in place by the stub, so re-reading it
    // inside waitFor observes the request once it starts.
    await waitFor(() => {
      const detailCall = calls.find(
        (call) =>
          call.url ===
          `/api/households/${HOUSEHOLD.id}/transactions/${EXPENSE_ID}`,
      );
      capturedSignal = detailCall?.init?.signal;
      expect(capturedSignal).toBeDefined();
    });
    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('ignores a late detail response after unmount', async () => {
    let resolveDetail!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveDetail = resolve;
    });
    const { unmount, onSessionExpired } = renderSection({
      transactionsGet: () => transactionPage([transaction()]),
      transactionGet: () => gate,
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    unmount();
    // A post-unmount session-loss response must not fire parent callbacks
    // or touch state: the generation guard drops the continuation.
    resolveDetail(
      jsonResponse(
        { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
        401,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it('refuses duplicate detail activation in the same flush', async () => {
    const { calls } = renderSection({
      transactionsGet: () => transactionPage([transaction()]),
      transactionGet: () => jsonResponse(transaction()),
    });
    await screen.findByText('Groceries');
    const trigger = screen.getByRole('button', {
      name: 'Details for Groceries',
    });
    // Two activations before any state flush: the synchronous ref guard
    // must keep exactly one request in flight.
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(
      await screen.findByRole('group', { name: 'Details for Groceries' }),
    ).toBeInTheDocument();
    const detailCalls = calls.filter(
      (call) =>
        call.url ===
        `/api/households/${HOUSEHOLD.id}/transactions/${EXPENSE_ID}`,
    );
    expect(detailCalls).toHaveLength(1);
  });

  it('restores focus to the Details trigger after closing the panel', async () => {
    renderSection({
      transactionsGet: () => transactionPage([transaction()]),
      transactionGet: () => jsonResponse(transaction()),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Details for Groceries',
    });
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Close details' }),
    );
    await waitFor(() =>
      expect(
        document.getElementById(`details-trigger-${EXPENSE_ID}`),
      ).toHaveFocus(),
    );
    expect(
      screen.queryByRole('group', { name: 'Details for Groceries' }),
    ).toBeNull();
  });
});

describe('authority and lifecycle', () => {
  it('keeps every transaction control unavailable until authority is confirmed', async () => {
    renderSection(
      {
        accountsGet: () => accountPage([account()]),
        transactionsGet: () => transactionPage([transaction()]),
      },
      { authorityConfirmed: false },
    );
    expect(
      await screen.findByText(
        'Refresh the household before changing transactions.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toBeDisabled();
    expect(screen.getByLabelText('Description')).toBeDisabled();
    expect(screen.getByLabelText('Entry type')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Record transaction' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Edit Groceries' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Void Groceries' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Record a refund for Groceries' }),
    ).toBeDisabled();
  });

  it('aborts the load on unmount without late updates', async () => {
    stubFetch({
      accountsGet: () => new Promise<Response>(() => {}),
      transactionsGet: () => new Promise<Response>(() => {}),
    });
    const { unmount } = render(
      <TransactionsSection
        household={HOUSEHOLD}
        currentUserId={ACTOR_ID}
        csrf={CSRF}
        onCsrfRefreshed={() => {}}
        onSessionExpired={() => {}}
        onHouseholdAccessChanged={() => {}}
        authorityConfirmed
      />,
    );
    await screen.findByText('Loading transactions…');
    unmount();
  });

  it('recovers from a canceled StrictMode setup request', async () => {
    stubFetch({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
    });
    render(
      <StrictMode>
        <TransactionsSection
          household={HOUSEHOLD}
          currentUserId={ACTOR_ID}
          csrf={CSRF}
          onCsrfRefreshed={() => {}}
          onSessionExpired={() => {}}
          onHouseholdAccessChanged={() => {}}
          authorityConfirmed
        />
      </StrictMode>,
    );
    expect(await screen.findByText('Groceries')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Record transaction' }),
    ).not.toBeDisabled();
  });
});

const CATEGORY_CHIP = 'Food shopping';

function sharedByOther(): Transaction {
  return transaction({
    id: '40000000-0000-4000-8000-000000000009',
    ownerUserId: '22222222-3333-4444-8555-666666666666',
    accountId: null,
    visibility: 'HOUSEHOLD',
    category: 'UTILITIES',
    description: 'Shared internet bill',
    money: { amount: '-89.90', currency: 'BRL' },
  });
}

describe('categories', () => {
  it('fetches the server taxonomy after household selection on mount', async () => {
    const { calls } = renderSection({});
    await screen.findByText('No transactions yet.');
    expect(
      calls.filter(({ url }) => url.endsWith('transaction-categories')),
    ).toHaveLength(1);
  });

  it('renders server-returned labels in row chips and details', async () => {
    renderSection({
      transactionsGet: () =>
        transactionPage([
          transaction({ category: 'GROCERIES' }),
          sharedByOther(),
        ]),
      transactionGet: () =>
        jsonResponse(transaction({ category: 'GROCERIES' })),
    });
    await screen.findByText('Groceries');
    const row = screen.getByText('Groceries').closest('li') as HTMLLIElement;
    expect(within(row).getByText(CATEGORY_CHIP)).toBeInTheDocument();
    fireEvent.click(
      within(row).getByRole('button', { name: 'Details for Groceries' }),
    );
    const panel = (await screen.findByText('Transaction details')).closest(
      'div',
    );
    expect(panel).not.toBeNull();
    expect(
      within(panel as HTMLElement).getAllByText(CATEGORY_CHIP),
    ).not.toHaveLength(0);
    // The server label is used verbatim; the raw token is never shown.
    expect(screen.queryByText('GROCERIES')).toBeNull();
  });

  it('sends the chosen taxonomy token on create', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsPost: () =>
        jsonResponse(transaction({ category: 'GROCERIES' }), 201),
    });
    await screen.findByText('No transactions yet.');
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'GROCERIES' },
    });
    await fillAndSubmit({ date: FIXED_DATE });
    expect(
      await screen.findByText(/Expense recorded: -12\.34 BRL/),
    ).toBeInTheDocument();
    const body = JSON.parse(String(postCalls(calls)[0]?.init?.body)) as Record<
      string,
      unknown
    >;
    expect(body.category).toBe('GROCERIES');
  });

  it('correction sets a category with the expected version', async () => {
    const { calls } = renderSection({
      transactionsGet: () => transactionPage([transaction({ version: 3 })]),
      transactionsPatch: () =>
        jsonResponse(transaction({ category: 'DINING', version: 4 })),
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Groceries' }));
    fireEvent.change(
      within(
        screen.getByText('Groceries').closest('li') as HTMLLIElement,
      ).getByLabelText('Category'),
      { target: { value: 'DINING' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    expect(
      await screen.findByText(/Transaction corrected: -12\.34 BRL/),
    ).toBeInTheDocument();
    const body = JSON.parse(String(patchCalls(calls)[0]?.init?.body)) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({ expectedVersion: 3, category: 'DINING' });
  });

  it('correction clears the category with an explicit null', async () => {
    const { calls } = renderSection({
      transactionsGet: () =>
        transactionPage([transaction({ category: 'GROCERIES', version: 1 })]),
      transactionsPatch: () =>
        jsonResponse(transaction({ category: null, version: 2 })),
    });
    await screen.findByText('Groceries');
    const row = screen.getByText('Groceries').closest('li') as HTMLLIElement;
    expect(within(row).getByText(CATEGORY_CHIP)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Groceries' }));
    fireEvent.change(
      within(
        screen.getByText('Groceries').closest('li') as HTMLLIElement,
      ).getByLabelText('Category'),
      { target: { value: '' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    expect(
      await screen.findByText(/Transaction corrected: -12\.34 BRL/),
    ).toBeInTheDocument();
    const body = JSON.parse(String(patchCalls(calls)[0]?.init?.body)) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({ expectedVersion: 1, category: null });
  });

  it('refund creation omits both category and visibility so the backend inherits', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () =>
        transactionPage([
          transaction({ money: { amount: '-100.00', currency: 'BRL' } }),
        ]),
      transactionsPost: () =>
        jsonResponse(
          transaction({
            id: REFUND_ID,
            kind: 'REFUND',
            money: { amount: '20.00', currency: 'BRL' },
            description: 'Returned one item',
            occurredOn: FIXED_DATE,
            refundOfTransactionId: EXPENSE_ID,
          }),
          201,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Record a refund for Groceries' }),
    );
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '20.00' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Returned one item' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record transaction' }));
    expect(
      await screen.findByText(/Refund recorded: 20\.00 BRL/),
    ).toBeInTheDocument();
    const body = JSON.parse(String(postCalls(calls)[0]?.init?.body)) as Record<
      string,
      unknown
    >;
    expect(body.kind).toBe('REFUND');
    expect('category' in body).toBe(false);
    expect('visibility' in body).toBe(false);
  });

  it('refund correction explains inheritance and offers no category control', async () => {
    renderSection({
      transactionsGet: () =>
        transactionPage([
          transaction({ money: { amount: '-100.00', currency: 'BRL' } }),
          transaction({
            id: REFUND_ID,
            kind: 'REFUND',
            money: { amount: '20.00', currency: 'BRL' },
            description: 'Returned one item',
            occurredOn: FIXED_DATE,
            refundOfTransactionId: EXPENSE_ID,
            category: 'GROCERIES',
          }),
        ]),
    });
    await screen.findByText('Returned one item');
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit Returned one item' }),
    );
    const row = screen
      .getByText('Returned one item')
      .closest('li') as HTMLLIElement;
    expect(
      within(row).getByText(
        /This refund inherits its category and privacy from the source expense/,
      ),
    ).toBeInTheDocument();
    expect(within(row).queryByLabelText('Category')).toBeNull();
  });
});

describe('category group previews', () => {
  it('previews whole-refund-group propagation before saving an expense category', async () => {
    renderSection({
      transactionsGet: () =>
        transactionPage([
          transaction({ money: { amount: '-100.00', currency: 'BRL' } }),
          transaction({
            id: REFUND_ID,
            kind: 'REFUND',
            money: { amount: '20.00', currency: 'BRL' },
            description: 'Returned one item',
            occurredOn: FIXED_DATE,
            refundOfTransactionId: EXPENSE_ID,
            category: 'GROCERIES',
          }),
        ]),
    });
    await screen.findByText('Returned one item');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Groceries' }));
    expect(
      screen.getByText(
        /This expense has 1 linked refund on this page. Saving applies the category to the whole refund group, including voided refunds\./,
      ),
    ).toBeInTheDocument();
  });
});

describe('feeds', () => {
  it('loads the household feed through the documented HOUSEHOLD view', async () => {
    renderSection({
      transactionsGet: (view: 'OWN' | 'HOUSEHOLD') =>
        view === 'HOUSEHOLD'
          ? transactionPage([sharedByOther()])
          : transactionPage([]),
    });
    await screen.findByText('No transactions yet.');
    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));
    expect(await screen.findByText('Shared internet bill')).toBeInTheDocument();
    const row = screen
      .getByText('Shared internet bill')
      .closest('li') as HTMLLIElement;
    expect(row.textContent).toMatch(/Shared by another member/);
    expect(within(row).getByText('Household')).toBeInTheDocument();
    // Only read-only controls are exposed for another member's entry.
    expect(
      within(row)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Details']);
    // The own feed stays empty and labelled distinctly.
    fireEvent.click(screen.getByRole('radio', { name: 'My transactions' }));
    expect(await screen.findByText('No transactions yet.')).toBeInTheDocument();
    expect(screen.queryByText('Shared internet bill')).toBeNull();
  });

  it('never exposes account labels or lookups for a redacted shared entry', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: (view: 'OWN' | 'HOUSEHOLD') =>
        view === 'HOUSEHOLD'
          ? transactionPage([sharedByOther()])
          : transactionPage([]),
      transactionGet: () => jsonResponse(sharedByOther()),
    });
    await screen.findByText('No transactions yet.');
    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));
    const row = (await screen.findByText('Shared internet bill')).closest(
      'li',
    ) as HTMLLIElement;
    // No account label for a redacted entry, while the own account label
    // stays available elsewhere for the viewer's own rows.
    expect(within(row).queryByText('Daily spending')).toBeNull();
    fireEvent.click(
      within(row).getByRole('button', {
        name: 'Details for Shared internet bill',
      }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Details for Shared internet bill',
    });
    expect(
      within(panel).getByText(
        'Hidden — account details stay private with the owner.',
      ),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(
        'Household — shared by another member; read-only for you.',
      ),
    ).toBeInTheDocument();
    // The owner UUID is the disclosed identity, never an email.
    expect(
      within(panel).getByText('22222222-3333-4444-8555-666666666666'),
    ).toBeInTheDocument();
    // Closing the redacted-safe panel restores focus to its trigger.
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Close details' }),
    );
    await waitFor(() =>
      expect(
        document.getElementById(
          `details-trigger-40000000-0000-4000-8000-000000000009`,
        ),
      ).toHaveFocus(),
    );
  });

  it('still shows account context for own entries in the household feed', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: (view: 'OWN' | 'HOUSEHOLD') =>
        view === 'HOUSEHOLD'
          ? transactionPage([
              transaction({
                visibility: 'HOUSEHOLD',
                category: 'GROCERIES',
              }),
            ])
          : transactionPage([]),
    });
    await screen.findByText('No transactions yet.');
    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));
    const row = (await screen.findByText('Groceries')).closest(
      'li',
    ) as HTMLLIElement;
    expect(row.textContent).toMatch(
      /Expense · 2026-09-16 · Daily spending · Posted/,
    );
    // Own entries keep their mutation controls, including revoke. The
    // household-visible expense also offers the distinct allocation action.
    expect(
      within(row)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Details', 'Edit', 'Void', 'Refund', 'Split', 'Make private']);
  });

  it('clears a stale shared detail and its row on a not-found detail', async () => {
    renderSection({
      transactionsGet: (view: 'OWN' | 'HOUSEHOLD') =>
        view === 'HOUSEHOLD'
          ? transactionPage([sharedByOther()])
          : transactionPage([]),
      transactionGet: () =>
        jsonResponse(
          {
            code: 'TRANSACTION_NOT_FOUND',
            message: 'Transaction is unavailable.',
            correlationId: 'corr-stale-shared',
          },
          404,
        ),
    });
    await screen.findByText('No transactions yet.');
    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));
    await screen.findByText('Shared internet bill');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Shared internet bill' }),
    );
    expect(
      await screen.findByText(
        'This transaction is no longer available to you. Refresh to see the current list.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Shared internet bill')).toBeNull();
  });

  it('shows the household-feed empty state without the own-feed text', async () => {
    renderSection({
      transactionsGet: () => transactionPage([]),
    });
    await screen.findByText('No transactions yet.');
    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));
    expect(
      await screen.findByText('No shared transactions yet.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('No transactions yet.')).toBeNull();
    // The spending dashboard names its per-currency rows honestly
    // ("Expense total") and shows its own empty state; the household feed
    // itself fabricates no totals line.
    expect(
      screen.getByText(/No household spending in this period/),
    ).toBeInTheDocument();
  });

  it('reconciles session loss from the household feed with cleared scoped data', async () => {
    const { onSessionExpired } = renderSection({
      transactionsGet: (view: 'OWN' | 'HOUSEHOLD') =>
        view === 'HOUSEHOLD'
          ? jsonResponse(
              { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
              401,
            )
          : transactionPage([]),
    });
    await screen.findByText('No transactions yet.');
    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));
    await waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
  });
});

describe('sharing', () => {
  it('requires a confirmation naming the exact disclosed fields before sharing', async () => {
    renderSection({
      transactionsGet: () => transactionPage([transaction()]),
    });
    await screen.findByText('Groceries');
    expect(
      screen.queryByRole('group', { name: /Share “Groceries”/ }),
    ).toBeNull();
    const trigger = screen.getByRole('button', {
      name: 'Share Groceries with the household',
    });
    fireEvent.click(trigger);
    const panel = await screen.findByRole('group', {
      name: 'Confirm sharing Groceries',
    });
    expect(
      within(panel).getByText('Share “Groceries” with the household?'),
    ).toBeInTheDocument();
    // Every disclosed field is named with its exact value.
    expect(within(panel).getByText('Amount')).toBeInTheDocument();
    expect(within(panel).getByText('-12.34 BRL')).toBeInTheDocument();
    expect(within(panel).getByText('Currency')).toBeInTheDocument();
    expect(within(panel).getAllByText('BRL')).not.toHaveLength(0);
    expect(within(panel).getByText('Date')).toBeInTheDocument();
    expect(within(panel).getByText('2026-09-16')).toBeInTheDocument();
    expect(within(panel).getByText('Kind')).toBeInTheDocument();
    expect(within(panel).getByText('Expense')).toBeInTheDocument();
    expect(within(panel).getByText('Description')).toBeInTheDocument();
    expect(within(panel).getAllByText('Groceries')).not.toHaveLength(0);
    expect(within(panel).getByText('Category')).toBeInTheDocument();
    expect(within(panel).getByText('Uncategorized')).toBeInTheDocument();
    expect(within(panel).getByText('Owner')).toBeInTheDocument();
    expect(within(panel).getByText(`You (${ACTOR_ID})`)).toBeInTheDocument();
    expect(within(panel).getByText('Status')).toBeInTheDocument();
    expect(within(panel).getByText('Posted')).toBeInTheDocument();
    expect(within(panel).getByText('Refund relationship')).toBeInTheDocument();
    expect(
      within(panel).getByText('None — not a refund group.'),
    ).toBeInTheDocument();
    // Current and future members can read; account details stay private.
    expect(
      within(panel).getByText(
        /Every current member will be able to read the entry exactly as recorded, and members who join later will see it too/,
      ),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(
        'Account details stay private: the account name, kind, and balances are never disclosed, and other members never see which account an entry came from.',
      ),
    ).toBeInTheDocument();
    fireEvent.keyDown(panel, { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(
      screen.queryByRole('group', { name: 'Confirm sharing Groceries' }),
    ).toBeNull();
  });

  it('sends the HOUSEHOLD visibility patch with the expected version on confirm', async () => {
    const { calls } = renderSection({
      transactionsGet: (view: 'OWN' | 'HOUSEHOLD') =>
        view === 'HOUSEHOLD'
          ? transactionPage([sharedByOther()])
          : transactionPage([transaction()]),
      transactionsPatch: () =>
        jsonResponse(transaction({ visibility: 'HOUSEHOLD', version: 1 })),
    });
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));
    await screen.findByText('Shared internet bill');
    fireEvent.click(screen.getByRole('radio', { name: 'My transactions' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Share Groceries with the household',
      }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Share with household' }),
    );
    expect(
      await screen.findByText(
        'Shared with the household. Every member can read its details; account details stay private.',
      ),
    ).toBeInTheDocument();
    const patches = patchCalls(calls);
    expect(patches).toHaveLength(1);
    expect(JSON.parse(String(patches[0]?.init?.body))).toEqual({
      expectedVersion: 0,
      visibility: 'HOUSEHOLD',
    });
    // Both loaded feeds are refreshed after a share.
    await waitFor(() => {
      const ownGets = calls.filter(({ url }) =>
        url.endsWith('view=OWN&status=ALL'),
      );
      const householdGets = calls.filter(({ url }) =>
        url.endsWith('view=HOUSEHOLD&status=ALL'),
      );
      expect(ownGets.length).toBe(2);
      expect(householdGets.length).toBe(2);
    });
  });

  it('revoke is explicit, consequential, and sends the PRIVATE patch', async () => {
    const { calls } = renderSection({
      transactionsGet: () =>
        transactionPage([transaction({ visibility: 'HOUSEHOLD' })]),
      transactionsPatch: () =>
        jsonResponse(transaction({ visibility: 'HOUSEHOLD', version: 2 })),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Make Groceries private' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Confirm making Groceries private',
    });
    expect(
      within(panel).getByText('Make “Groceries” private again?'),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(
        'Household members lose access on their next refresh. Information already read cannot be retracted.',
      ),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(
        'The whole refund group changes together: every linked refund, including voided ones, becomes private with this entry.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Make private' }),
    );
    expect(
      await screen.findByText(
        'This entry is private again. Members lose access on their next refresh; information already read is not retracted.',
      ),
    ).toBeInTheDocument();
    const patches = patchCalls(calls);
    expect(patches).toHaveLength(1);
    expect(JSON.parse(String(patches[0]?.init?.body))).toEqual({
      expectedVersion: 0,
      visibility: 'PRIVATE',
    });
  });

  it('cancelling the share confirmation restores focus to its trigger', async () => {
    renderSection({
      transactionsGet: () => transactionPage([transaction()]),
    });
    await screen.findByText('Groceries');
    const trigger = screen.getByRole('button', {
      name: 'Share Groceries with the household',
    });
    fireEvent.click(trigger);
    const panel = await screen.findByRole('group', {
      name: 'Confirm sharing Groceries',
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(
      screen.queryByRole('group', { name: 'Confirm sharing Groceries' }),
    ).toBeNull();
  });

  it('refuses to start an edit while a share confirmation is open', async () => {
    renderSection({
      transactionsGet: () => transactionPage([transaction()]),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Share Groceries with the household',
      }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Confirm sharing Groceries',
    });
    // Starting an edit would unmount the share trigger that Cancel/Escape
    // still needs for focus restoration, so the opener refuses instead.
    fireEvent.click(screen.getByRole('button', { name: 'Edit Groceries' }));
    expect(
      screen.queryByRole('button', { name: 'Save correction' }),
    ).toBeNull();
    expect(panel).toBeInTheDocument();
    // The pending confirmation stays cancellable with its trigger intact.
    fireEvent.keyDown(panel, { key: 'Escape' });
    await waitFor(() => expect(panel).not.toBeInTheDocument());
  });

  it('maps a forbidden share to an explicit failure without success', async () => {
    renderSection({
      transactionsGet: () => transactionPage([transaction()]),
      transactionsPatch: () =>
        jsonResponse(
          {
            code: 'FORBIDDEN',
            message: 'Not allowed.',
            correlationId: 'corr-403',
          },
          403,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Share Groceries with the household',
      }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Share with household' }),
    );
    expect(
      await screen.findByText(
        'Only the financial owner can change this entry.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Shared with the household/)).toBeNull();
  });

  it('maps a stale share to reload-first guidance without a replay', async () => {
    const { calls } = renderSection({
      transactionsGet: () => transactionPage([transaction()]),
      transactionsPatch: () =>
        jsonResponse(
          {
            code: 'RESOURCE_VERSION_CONFLICT',
            message: 'Stale.',
            correlationId: 'corr-version',
          },
          409,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Share Groceries with the household',
      }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Share with household' }),
    );
    expect(
      await screen.findByText(
        'This transaction changed on the server. The list was refreshed; review before retrying.',
      ),
    ).toBeInTheDocument();
    expect(patchCalls(calls)).toHaveLength(1);
    // The list reloads instead of replaying the change.
    await waitFor(() =>
      expect(
        calls.filter(({ url }) => url.endsWith('view=OWN&status=ALL')),
      ).toHaveLength(2),
    );
  });

  it('maps FINANCE_BUSY contention to unknown-outcome guidance without success', async () => {
    renderSection({
      transactionsGet: () => transactionPage([transaction()]),
      transactionsPatch: () =>
        jsonResponse(
          {
            code: 'FINANCE_BUSY',
            message: 'The finance system is busy. Try again shortly.',
            correlationId: 'corr-busy',
          },
          503,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Share Groceries with the household',
      }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Share with household' }),
    );
    expect(
      await screen.findByText(
        'The sharing change has an unknown outcome. Refresh the list before retrying.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Shared with the household/)).toBeNull();
  });
});

describe('allocations', () => {
  const MEMBER_B = '30000000-0000-4000-8000-000000000002';
  const MEMBER_C = '30000000-0000-4000-8000-000000000003';
  const ACTOR_EMAIL = 'payer@example.test';
  const MEMBER_B_EMAIL = 'member-b@example.test';
  const MEMBER_C_EMAIL = 'member-c@example.test';

  const ROSTER = [
    { userId: ACTOR_ID, email: ACTOR_EMAIL, role: 'MEMBER' },
    { userId: MEMBER_B, email: MEMBER_B_EMAIL, role: 'OWNER' },
    { userId: MEMBER_C, email: MEMBER_C_EMAIL, role: 'MEMBER' },
  ];

  function householdExpense(overrides: Partial<Transaction> = {}): Transaction {
    return transaction({
      money: { amount: '-10.00', currency: 'USD' },
      visibility: 'HOUSEHOLD',
      ...overrides,
    });
  }

  function activeAllocation(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      id: '50000000-0000-4000-8000-000000000001',
      transactionId: EXPENSE_ID,
      householdId: HOUSEHOLD.id,
      payerUserId: ACTOR_ID,
      currency: 'USD',
      originalAmount: { amount: '10.00', currency: 'USD' },
      participants: [
        { userId: ACTOR_ID, share: { amount: '3.34', currency: 'USD' } },
        { userId: MEMBER_B, share: { amount: '3.33', currency: 'USD' } },
        { userId: MEMBER_C, share: { amount: '3.33', currency: 'USD' } },
      ],
      status: 'ACTIVE',
      createdAt: '2026-09-16T12:00:00Z',
      revokedAt: null,
      transactionVersion: 1,
      ...overrides,
    };
  }

  const allocationNotFound = () =>
    jsonResponse(
      {
        code: 'ALLOCATION_NOT_FOUND',
        message: 'No active allocation for this transaction.',
      },
      404,
    );

  const allocationPostCalls = (
    calls: Array<{ url: string; init?: RequestInit | undefined }>,
  ) =>
    calls.filter(
      ({ url, init }) => init?.method === 'POST' && url.endsWith('/allocation'),
    );

  const balanceCalls = (
    calls: Array<{ url: string; init?: RequestInit | undefined }>,
  ) => calls.filter(({ url }) => url.endsWith('/member-balances'));

  it('offers the allocation action only for own posted household expenses', async () => {
    renderSection({
      transactionsGet: () =>
        transactionPage([
          householdExpense(),
          transaction({
            id: '40000000-0000-4000-8000-000000000005',
            money: { amount: '-5.00', currency: 'USD' },
            visibility: 'PRIVATE',
          }),
          transaction({
            id: '40000000-0000-4000-8000-000000000006',
            money: { amount: '-7.00', currency: 'USD' },
            visibility: 'HOUSEHOLD',
            status: 'VOIDED',
          }),
        ]),
    });
    await screen.findAllByText('Groceries');
    expect(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    ).toBeInTheDocument();
    // A private expense offers no allocation action.
    const privateRow = screen
      .getByText('-5.00 USD')
      .closest('li') as HTMLLIElement;
    expect(
      within(privateRow).queryByRole('button', { name: /Allocation/ }),
    ).toBeNull();
    // A voided expense offers no allocation action.
    const voidedRow = screen
      .getByText('-7.00 USD')
      .closest('li') as HTMLLIElement;
    expect(
      within(voidedRow).queryByRole('button', { name: /Allocation/ }),
    ).toBeNull();
  });

  it('previews exact shares with every member selected by default', async () => {
    renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => allocationNotFound(),
      membersGet: () => jsonResponse({ members: ROSTER }),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    // The payer is identified; every current member starts selected.
    expect(
      await within(panel).findByRole('checkbox', {
        name: `${ACTOR_EMAIL} — you (payer) ${ACTOR_ID}`,
      }),
    ).toBeChecked();
    expect(
      within(panel).getByRole('checkbox', {
        name: `${MEMBER_B_EMAIL} ${MEMBER_B}`,
      }),
    ).toBeChecked();
    expect(
      within(panel).getByRole('checkbox', {
        name: `${MEMBER_C_EMAIL} ${MEMBER_C}`,
      }),
    ).toBeChecked();
    // The exact equal-division preview in minor units.
    await within(panel).findByText(
      'Divides the full 10.00 USD exactly: 3.34 USD + 3.33 USD + 3.33 USD across 3 participants.',
    );
  });

  it('updates the exact preview as participants change and rejects an empty selection', async () => {
    const calls = renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => allocationNotFound(),
      membersGet: () => jsonResponse({ members: ROSTER }),
    }).calls;
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await within(panel).findByText(/3\.34 USD \+ 3\.33 USD \+ 3\.33 USD/);
    // Omitting the payer updates the exact split to the two members.
    fireEvent.click(
      within(panel).getByRole('checkbox', {
        name: `${ACTOR_EMAIL} — you (payer) ${ACTOR_ID}`,
      }),
    );
    await within(panel).findByText(
      /5\.00 USD \+ 5\.00 USD across 2 participants/,
    );
    // Unchecking everyone rejects the empty draft locally.
    fireEvent.click(
      within(panel).getByRole('checkbox', {
        name: `${MEMBER_B_EMAIL} ${MEMBER_B}`,
      }),
    );
    fireEvent.click(
      within(panel).getByRole('checkbox', {
        name: `${MEMBER_C_EMAIL} ${MEMBER_C}`,
      }),
    );
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Create allocation' }),
    );
    expect(
      await within(panel).findByText('Select at least one participant.'),
    ).toBeInTheDocument();
    expect(allocationPostCalls(calls)).toHaveLength(0);
  });

  it('creates with a fresh key, exact sorted participants, and refreshes balances', async () => {
    const calls = renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => allocationNotFound(),
      membersGet: () => jsonResponse({ members: ROSTER }),
      allocationsPost: () => jsonResponse(activeAllocation(), 201),
    }).calls;
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await waitFor(() =>
      expect(within(panel).getAllByRole('checkbox').length).toBeGreaterThan(0),
    );
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Create allocation' }),
    );
    const posts = await waitFor(() => {
      const created = allocationPostCalls(calls);
      expect(created).toHaveLength(1);
      return created;
    });
    expect(posts[0]?.url).toBe(
      `/api/households/${HOUSEHOLD.id}/transactions/${EXPENSE_ID}/allocation`,
    );
    const headers = posts[0]?.init?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(headers['X-CSRF-TOKEN']).toBe('csrf-token-1');
    expect(JSON.parse(String(posts[0]?.init?.body))).toEqual({
      expectedVersion: 0,
      participantUserIds: [ACTOR_ID, MEMBER_B, MEMBER_C],
    });
    // The outcome names the ordered shares and the new expense version.
    expect(
      await screen.findByText(
        'Allocation recorded in participant order: 3.34 USD, 3.33 USD, 3.33 USD. The expense version is now 1.',
      ),
    ).toBeInTheDocument();
    // The derived balances and both feeds refresh after creation.
    await waitFor(() =>
      expect(balanceCalls(calls).length).toBeGreaterThanOrEqual(2),
    );
  });

  it('retains the exact request for unknown outcomes and retries the same key', async () => {
    let answerCreate: (init?: RequestInit) => Response | Promise<Response> = (
      init,
    ) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted.', 'AbortError'));
        });
      });
    const calls = renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => allocationNotFound(),
      membersGet: () => jsonResponse({ members: ROSTER }),
      allocationsPost: (init) => answerCreate(init),
    }).calls;
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await waitFor(() =>
      expect(within(panel).getAllByRole('checkbox').length).toBe(3),
    );
    // From here the bounded client wait is under controlled timers.
    vi.useFakeTimers();
    try {
      fireEvent.click(
        within(panel).getByRole('button', { name: 'Create allocation' }),
      );
      // The bounded wait expires with an unknown outcome.
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(
        screen.getByText(
          'The allocation request has an unknown outcome. Retry the same request safely, or refresh the list first.',
        ),
      ).toBeInTheDocument();
      // The durable block retains the exact original request.
      expect(
        screen.getByText(
          /An earlier allocation request still has an unknown result/,
        ),
      ).toBeInTheDocument();
      // Back to real timers for the explicit same-key retry.
      vi.useRealTimers();
      answerCreate = () => jsonResponse(activeAllocation(), 200);
      fireEvent.click(
        screen.getByRole('button', { name: 'Retry same request' }),
      );
      const posts = await waitFor(() => {
        const created = allocationPostCalls(calls);
        expect(created).toHaveLength(2);
        return created;
      });
      const firstKey = (posts[0]?.init?.headers as Record<string, string>)[
        'Idempotency-Key'
      ];
      const secondKey = (posts[1]?.init?.headers as Record<string, string>)[
        'Idempotency-Key'
      ];
      expect(secondKey).toBe(firstKey);
      expect(posts[1]?.init?.body).toBe(posts[0]?.init?.body);
      // A 200 replay with the current representation is accepted.
      expect(
        await screen.findByText(
          'Allocation recorded in participant order: 3.34 USD, 3.33 USD, 3.33 USD. The expense version is now 1.',
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(
          /An earlier allocation request still has an unknown result/,
        ),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('requires an explicit retry after CSRF rejection without replaying', async () => {
    let posts = 0;
    const calls = renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => allocationNotFound(),
      membersGet: () => jsonResponse({ members: ROSTER }),
      allocationsPost: () => {
        posts += 1;
        if (posts === 1) {
          return jsonResponse(
            { code: 'CSRF_INVALID', message: 'CSRF token invalid.' },
            403,
          );
        }
        return jsonResponse(activeAllocation(), 201);
      },
    }).calls;
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await waitFor(() =>
      expect(within(panel).getAllByRole('checkbox').length).toBe(3),
    );
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Create allocation' }),
    );
    expect(
      await screen.findByText(
        'Your security token was refreshed. Retry the same allocation request.',
      ),
    ).toBeInTheDocument();
    // No auto-replay: the retry is explicit and reuses the same key.
    expect(allocationPostCalls(calls)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
    const sent = await waitFor(() => {
      const created = allocationPostCalls(calls);
      expect(created).toHaveLength(2);
      return created;
    });
    const firstKey = (sent[0]?.init?.headers as Record<string, string>)[
      'Idempotency-Key'
    ];
    const secondKey = (sent[1]?.init?.headers as Record<string, string>)[
      'Idempotency-Key'
    ];
    expect(secondKey).toBe(firstKey);
    expect(
      await screen.findByText(/Allocation recorded in participant order/),
    ).toBeInTheDocument();
  });

  it('reloads before retrying on an expense version conflict', async () => {
    renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => allocationNotFound(),
      membersGet: () => jsonResponse({ members: ROSTER }),
      allocationsPost: () =>
        jsonResponse(
          { code: 'RESOURCE_VERSION_CONFLICT', message: 'Stale expense.' },
          409,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await waitFor(() =>
      expect(within(panel).getAllByRole('checkbox').length).toBe(3),
    );
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Create allocation' }),
    );
    expect(
      await screen.findByText(
        'This expense changed on the server. The list was refreshed; review before retrying.',
      ),
    ).toBeInTheDocument();
    // The panel closed and no retained request stays reconcilable.
    expect(
      screen.queryByRole('group', { name: 'Allocation for Groceries' }),
    ).toBeNull();
    expect(
      screen.queryByText(/An earlier allocation request still has an unknown/),
    ).toBeNull();
  });

  it('supports revoke with the consequential confirmation and a fresh-key recreation', async () => {
    let created = false;
    let revoked = false;
    const calls = renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () =>
        created && !revoked
          ? jsonResponse(activeAllocation())
          : allocationNotFound(),
      membersGet: () => jsonResponse({ members: ROSTER }),
      allocationsPost: () => {
        created = true;
        return jsonResponse(activeAllocation(), 201);
      },
      allocationsPatch: () => {
        revoked = true;
        return jsonResponse(
          activeAllocation({
            status: 'REVOKED',
            revokedAt: '2026-09-17T00:00:00Z',
            transactionVersion: 2,
          }),
        );
      },
    }).calls;
    await screen.findByText('Groceries');
    // Create the first allocation.
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    let panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await waitFor(() =>
      expect(within(panel).getAllByRole('checkbox').length).toBe(3),
    );
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Create allocation' }),
    );
    await screen.findByText(/Allocation recorded in participant order/);
    expect(screen.getByText('Allocated')).toBeInTheDocument();
    // The open panel switched to the read-only active view with the
    // frozen shares, the payer, and the revoke action.
    panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    expect(
      await within(panel).findByText(
        '10.00 USD — the full amount, never a partial share',
      ),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole('button', { name: 'Revoke allocation' }),
    ).toBeInTheDocument();
    // The revoke confirmation explains balances and retained history.
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Revoke allocation' }),
    );
    const confirm = await screen.findByRole('group', {
      name: 'Confirm allocation revoke for Groceries',
    });
    expect(confirm.textContent).toMatch(
      /Member balances will no longer include this expense/,
    );
    fireEvent.click(
      within(confirm).getByRole('button', { name: 'Revoke allocation' }),
    );
    expect(
      await screen.findByText(
        'Allocation revoked. Member balances no longer include this expense; the recorded shares stay retained on the server. A new allocation needs a fresh request.',
      ),
    ).toBeInTheDocument();
    // The chip cleared and balances refreshed.
    expect(screen.queryByText('Allocated')).toBeNull();
    await waitFor(() =>
      expect(balanceCalls(calls).length).toBeGreaterThanOrEqual(3),
    );
    // The revoke patch carried the expense version and only REVOKED.
    const revokePatches = calls.filter(
      ({ url, init }) =>
        init?.method === 'PATCH' && url.endsWith('/allocation'),
    );
    expect(revokePatches).toHaveLength(1);
    expect(JSON.parse(String(revokePatches[0]?.init?.body))).toEqual({
      expectedVersion: 0,
      status: 'REVOKED',
    });
    // Recreating after revoke offers the creation form again.
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await waitFor(() =>
      expect(within(panel).getAllByRole('checkbox').length).toBe(3),
    );
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Create allocation' }),
    );
    const posts = await waitFor(() => {
      const created = allocationPostCalls(calls);
      expect(created).toHaveLength(2);
      return created;
    });
    const firstKey = (posts[0]?.init?.headers as Record<string, string>)[
      'Idempotency-Key'
    ];
    const secondKey = (posts[1]?.init?.headers as Record<string, string>)[
      'Idempotency-Key'
    ];
    expect(secondKey).not.toBe(firstKey);
  });

  it('shows the active allocation read-only to non-owners', async () => {
    renderSection({
      transactionsGet: (view: 'OWN' | 'HOUSEHOLD') =>
        view === 'HOUSEHOLD'
          ? transactionPage([sharedByOther()])
          : transactionPage([]),
      transactionGet: () => jsonResponse(sharedByOther()),
      allocationsGet: () =>
        jsonResponse(
          activeAllocation({
            transactionId: '40000000-0000-4000-8000-000000000009',
            payerUserId: '22222222-3333-4444-8555-666666666666',
            currency: 'BRL',
            originalAmount: { amount: '89.90', currency: 'BRL' },
            participants: [
              {
                userId: '22222222-3333-4444-8555-666666666666',
                share: { amount: '89.90', currency: 'BRL' },
              },
            ],
          }),
        ),
    });
    await screen.findByText('No transactions yet.');
    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));
    const row = (await screen.findByText('Shared internet bill')).closest(
      'li',
    ) as HTMLLIElement;
    // The allocated state is visible as text; no mutation controls exist.
    expect(await within(row).findByText('Allocated')).toBeInTheDocument();
    expect(
      within(row).queryByRole('button', { name: /Allocation/ }),
    ).toBeNull();
    expect(
      within(row)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Details']);
    // The detail panel describes the active allocation read-only.
    fireEvent.click(
      within(row).getByRole('button', {
        name: 'Details for Shared internet bill',
      }),
    );
    expect(
      await screen.findByText(
        'Active — the full amount is divided into recorded shares. Only the financial owner can change or revoke this allocation.',
      ),
    ).toBeInTheDocument();
    // The ordered recorded shares are visible read-only to every member.
    expect(
      await screen.findByText('Recorded shares (read-only)'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Member 22222222-3333-4444-8555-666666666666'),
    ).toBeInTheDocument();
    expect(screen.getByText('89.90 BRL')).toBeInTheDocument();
  });

  it('guides privacy revocation around an active allocation', async () => {
    renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => jsonResponse(activeAllocation()),
      transactionsPatch: () =>
        jsonResponse(
          { code: 'ALLOCATION_CONFLICT', message: 'Allocation is active.' },
          409,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Make Groceries private' }),
    );
    expect(
      await screen.findByText(
        /This expense has an active allocation. Making it private is blocked while the allocation is active/,
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Make private' }));
    expect(
      await screen.findByText(
        'The server blocked this change: an active allocation records shares for this expense. Open Allocation, revoke it, then make the entry private.',
      ),
    ).toBeInTheDocument();
  });

  it('blocks a money correction locally while the allocation is active', async () => {
    const calls = renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => jsonResponse(activeAllocation()),
    }).calls;
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Groceries' }));
    fireEvent.change(
      screen.getByLabelText('Amount', {
        selector: `#edit-transaction-amount-${EXPENSE_ID}`,
      }),
      { target: { value: '20.00' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    expect(
      await screen.findByText(
        'This expense has an active allocation; its amount cannot change while shares are recorded. Revoke the allocation first — other corrections stay allowed.',
      ),
    ).toBeInTheDocument();
    // The blocked correction never reached the server.
    expect(
      calls.filter(
        ({ url, init }) =>
          init?.method === 'PATCH' && !url.endsWith('/allocation'),
      ),
    ).toHaveLength(0);
  });

  it('reconciles the allocation and balances after the expense void succeeds', async () => {
    const calls = renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => jsonResponse(activeAllocation()),
      transactionsPatch: () =>
        jsonResponse(householdExpense({ status: 'VOIDED', version: 1 })),
    }).calls;
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByRole('button', { name: 'Void Groceries' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Void transaction' }),
    );
    expect(
      await screen.findByText(
        'Transaction voided. It stays listed as voided and stops counting toward spending.',
      ),
    ).toBeInTheDocument();
    // The deactivated allocation no longer shows on the voided entry.
    await waitFor(() => expect(screen.queryByText('Allocated')).toBeNull());
    // Balances refresh after the void.
    await waitFor(() =>
      expect(balanceCalls(calls).length).toBeGreaterThanOrEqual(2),
    );
  });

  it('clears only the affected allocation state on a stale not-found probe', async () => {
    renderSection({
      transactionsGet: () =>
        transactionPage([
          householdExpense(),
          householdExpense({
            id: '40000000-0000-4000-8000-000000000005',
            money: { amount: '-20.00', currency: 'USD' },
            description: 'Second expense',
          }),
        ]),
      allocationsGet: (transactionId: string) =>
        transactionId === EXPENSE_ID
          ? jsonResponse(activeAllocation())
          : allocationNotFound(),
    });
    await screen.findByText('Groceries');
    // The allocated entry shows its chip; the other entry was cleared by
    // its own not-found answer and stays clear, leaking nothing.
    expect(await screen.findByText('Allocated')).toBeInTheDocument();
    const secondRow = screen
      .getByText('-20.00 USD')
      .closest('li') as HTMLLIElement;
    expect(within(secondRow).queryByText('Allocated')).toBeNull();
  });

  it('moves focus to the allocation panel and restores the trigger on Escape', async () => {
    renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => jsonResponse(activeAllocation()),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await waitFor(() => expect(panel).toHaveFocus());
    fireEvent.keyDown(panel, { key: 'Escape' });
    await waitFor(() =>
      expect(
        document.getElementById(`allocation-trigger-${EXPENSE_ID}`),
      ).toHaveFocus(),
    );
  });

  it('surfaces lock contention as an unknown outcome with the retained request', async () => {
    renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => allocationNotFound(),
      membersGet: () => jsonResponse({ members: ROSTER }),
      allocationsPost: () =>
        jsonResponse({ code: 'FINANCE_BUSY', message: 'Finance busy.' }, 503),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await waitFor(() =>
      expect(within(panel).getAllByRole('checkbox').length).toBe(3),
    );
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Create allocation' }),
    );
    expect(
      await screen.findByText(
        'The allocation request has an unknown outcome. Retry the same request safely, or refresh the list first.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /An earlier allocation request still has an unknown result/,
      ),
    ).toBeInTheDocument();
  });

  it('maps participant validation failures to the participants field', async () => {
    renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => allocationNotFound(),
      membersGet: () => jsonResponse({ members: ROSTER }),
      allocationsPost: () =>
        jsonResponse(
          {
            code: 'VALIDATION_FAILED',
            message: 'Check the highlighted fields.',
            fieldErrors: {
              participantUserIds: 'Every participant must be a current member.',
            },
          },
          400,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await waitFor(() =>
      expect(within(panel).getAllByRole('checkbox').length).toBe(3),
    );
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Create allocation' }),
    );
    expect(
      await within(panel).findByText(
        'Every participant must be a current member.',
      ),
    ).toBeInTheDocument();
  });

  it('disables duplicate controls while an allocation request is pending', async () => {
    let answerCreate: (init?: RequestInit) => Response | Promise<Response> = (
      init,
    ) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted.', 'AbortError'));
        });
      });
    renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => allocationNotFound(),
      membersGet: () => jsonResponse({ members: ROSTER }),
      allocationsPost: (init) => answerCreate(init),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await waitFor(() =>
      expect(within(panel).getAllByRole('checkbox').length).toBe(3),
    );
    vi.useFakeTimers();
    try {
      fireEvent.click(
        within(panel).getByRole('button', { name: 'Create allocation' }),
      );
      // While the request is in flight, the row controls and the panel
      // submit are disabled so a duplicate cannot be sent.
      const details = screen.getByRole('button', {
        name: 'Details for Groceries',
      });
      expect(details).toBeDisabled();
      expect(
        within(panel).getByRole('button', { name: 'Creating…' }),
      ).toBeDisabled();
      vi.useRealTimers();
      answerCreate = () => jsonResponse(activeAllocation(), 201);
      // The same retained outcome reconciles after a same-key retry.
      fireEvent.click(
        screen.getByRole('button', { name: 'Retry same request' }),
      );
      await screen.findByText(/Allocation recorded in participant order/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes derived balances after a posted refund on an allocated expense', async () => {
    const calls = renderSection({
      accountsGet: () => accountPage([account({ currency: 'USD' })]),
      transactionsGet: () =>
        transactionPage([
          householdExpense(),
          transaction({
            id: '40000000-0000-4000-8000-000000000004',
            kind: 'INCOME',
            money: { amount: '5.00', currency: 'BRL' },
            description: 'Salary',
          }),
        ]),
      allocationsGet: () => allocationNotFound(),
      transactionsPost: () =>
        jsonResponse(
          transaction({
            id: '40000000-0000-4000-8000-000000000002',
            kind: 'REFUND',
            money: { amount: '1.00', currency: 'USD' },
            description: 'Returned one item',
            refundOfTransactionId: EXPENSE_ID,
          }),
          201,
        ),
    }).calls;
    await screen.findByText('Groceries');
    await waitFor(() =>
      expect(balanceCalls(calls).length).toBeGreaterThanOrEqual(1),
    );
    // Record a refund against the allocated expense.
    fireEvent.click(
      screen.getByRole('button', { name: 'Record a refund for Groceries' }),
    );
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '1.00' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Returned one item' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record transaction' }));
    await screen.findByText(/Refund recorded: 1.00 USD/);
    // The balances section refreshed after the refund.
    await waitFor(() =>
      expect(balanceCalls(calls).length).toBeGreaterThanOrEqual(2),
    );
  });

  it('clears retained allocation state when the session expires mid-request', async () => {
    const { onSessionExpired } = renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => allocationNotFound(),
      membersGet: () => jsonResponse({ members: ROSTER }),
      allocationsPost: () =>
        jsonResponse(
          { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
          401,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await waitFor(() =>
      expect(within(panel).getAllByRole('checkbox').length).toBe(3),
    );
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Create allocation' }),
    );
    await waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
    // Scoped finance state, drafts, keys, and pending callbacks cleared.
    expect(
      screen.queryByText(/An earlier allocation request still has an unknown/),
    ).toBeNull();
    expect(
      screen.queryByRole('group', { name: 'Allocation for Groceries' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Record transaction' }),
    ).toBeNull();
  });

  it('explains the forbidden allocation mutation', async () => {
    renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => allocationNotFound(),
      membersGet: () => jsonResponse({ members: ROSTER }),
      allocationsPost: () =>
        jsonResponse(
          { code: 'FORBIDDEN', message: 'Only the owner may allocate.' },
          403,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await waitFor(() =>
      expect(within(panel).getAllByRole('checkbox').length).toBe(3),
    );
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Create allocation' }),
    );
    expect(
      await screen.findByText(
        'Only the financial owner can allocate this expense.',
      ),
    ).toBeInTheDocument();
  });

  it('refreshes balances and feeds after a create with an unknown outcome', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () =>
        jsonResponse(
          { code: 'FINANCE_BUSY', message: 'Busy.', correlationId: 'corr-b' },
          503,
        ),
    });
    await screen.findByText('No transactions yet.');
    const balancesBefore = balanceCalls(calls).length;
    await fillAndSubmit({ date: FIXED_DATE });
    expect(
      await screen.findByText(
        'Transaction creation has an unknown outcome. Retry the same request safely, or refresh the list before retrying.',
      ),
    ).toBeInTheDocument();
    // The retained same-key retry survives the refresh.
    expect(screen.getByLabelText('Amount')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Retry same request' }),
    ).toBeInTheDocument();
    // A committed create changes derived balances: they refetch, and the
    // loaded feeds reload so a committed entry is never left unlisted.
    await waitFor(() =>
      expect(balanceCalls(calls).length).toBeGreaterThan(balancesBefore),
    );
    const listReloads = calls.filter(
      ({ url, init }) =>
        init?.method === 'GET' && url.includes('view=OWN&status=ALL'),
    );
    expect(listReloads.length).toBeGreaterThanOrEqual(2);
  });

  it('refreshes balances after an allocation create with an unknown outcome', async () => {
    const { calls } = renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => allocationNotFound(),
      membersGet: () => jsonResponse({ members: ROSTER }),
      allocationsPost: () =>
        jsonResponse(
          { code: 'FINANCE_BUSY', message: 'Busy.', correlationId: 'corr-a' },
          503,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await waitFor(() =>
      expect(within(panel).getAllByRole('checkbox').length).toBe(3),
    );
    const balancesBefore = balanceCalls(calls).length;
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Create allocation' }),
    );
    expect(
      await screen.findByText(
        'The allocation request has an unknown outcome. Retry the same request safely, or refresh the list first.',
      ),
    ).toBeInTheDocument();
    // The durable block keeps the same-key retry available while both
    // feeds and balances refresh against a possibly committed outcome.
    expect(
      screen.getByText(
        /An earlier allocation request still has an unknown result/,
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(balanceCalls(calls).length).toBeGreaterThan(balancesBefore),
    );
    expect(
      calls.filter(
        ({ url, init }) =>
          init?.method === 'GET' && url.includes('view=OWN&status=ALL'),
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('refreshes balances after an expense void with an unknown outcome', async () => {
    const { calls } = renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => jsonResponse(activeAllocation()),
      transactionsPatch: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await screen.findByText('Groceries');
    await screen.findByText('Allocated');
    fireEvent.click(screen.getByRole('button', { name: 'Void Groceries' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Void transaction' }),
    );
    expect(
      await screen.findByText(
        'The void has an unknown outcome. Refresh the list before retrying.',
      ),
    ).toBeInTheDocument();
    // The committed void deactivates the allocation and changes balances:
    // both refresh so nothing stale stays presented as current.
    await waitFor(() =>
      expect(balanceCalls(calls).length).toBeGreaterThanOrEqual(2),
    );
  });

  it('returns the allocation cache to unknown when a revoke has an unknown outcome', async () => {
    const { calls } = renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => jsonResponse(activeAllocation()),
      allocationsPatch: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await screen.findByText('Groceries');
    await screen.findByText('Allocated');
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    fireEvent.click(
      await within(panel).findByRole('button', { name: 'Revoke allocation' }),
    );
    const confirm = await screen.findByRole('group', {
      name: 'Confirm allocation revoke for Groceries',
    });
    fireEvent.click(
      within(confirm).getByRole('button', { name: 'Revoke allocation' }),
    );
    expect(
      await screen.findByText(
        'The revoke has an unknown outcome. Refresh the list before retrying.',
      ),
    ).toBeInTheDocument();
    // The cache entry went back to unknown instead of a confident "none":
    // the reload probe refetches and the still-active allocation keeps
    // its chip, so no committed state is ever hidden.
    await waitFor(() =>
      expect(screen.getByText('Allocated')).toBeInTheDocument(),
    );
    const allocationGets = calls.filter(
      ({ url, init }) => url.endsWith('/allocation') && init?.method === 'GET',
    );
    expect(allocationGets.length).toBeGreaterThanOrEqual(3);
    await waitFor(() =>
      expect(balanceCalls(calls).length).toBeGreaterThanOrEqual(2),
    );
  });

  it('returns the allocation cache to unknown on stale revoke versions', async () => {
    let attempts = 0;
    renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => jsonResponse(activeAllocation()),
      allocationsPatch: () => {
        attempts += 1;
        return jsonResponse(
          {
            code:
              attempts === 1
                ? 'RESOURCE_VERSION_CONFLICT'
                : 'RESOURCE_VERSION_EXHAUSTED',
            message: 'Stale expense.',
          },
          409,
        );
      },
    });
    await screen.findByText('Groceries');
    await screen.findByText('Allocated');
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    let panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    fireEvent.click(
      await within(panel).findByRole('button', { name: 'Revoke allocation' }),
    );
    let confirm = await screen.findByRole('group', {
      name: 'Confirm allocation revoke for Groceries',
    });
    fireEvent.click(
      within(confirm).getByRole('button', { name: 'Revoke allocation' }),
    );
    expect(
      await screen.findByText(
        'This expense changed on the server. The list was refreshed; review before retrying.',
      ),
    ).toBeInTheDocument();
    // The invalidated entry reconciles against the still-active server
    // state after the reload.
    await waitFor(() =>
      expect(screen.getByText('Allocated')).toBeInTheDocument(),
    );
    // A second attempt with the exhausted-version code behaves the same.
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    fireEvent.click(
      await within(panel).findByRole('button', { name: 'Revoke allocation' }),
    );
    confirm = await screen.findByRole('group', {
      name: 'Confirm allocation revoke for Groceries',
    });
    fireEvent.click(
      within(confirm).getByRole('button', { name: 'Revoke allocation' }),
    );
    expect(
      await screen.findByText(
        'This expense changed on the server. The list was refreshed; review before retrying.',
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText('Allocated')).toBeInTheDocument(),
    );
  });

  it('recovers an allocation conflict create by invalidating the cache and reloading', async () => {
    let probes = 0;
    renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => {
        probes += 1;
        // The allocation was recorded elsewhere after the local probe
        // cached "none"; the panel's own fresh GET must still answer
        // "none" so the creation form renders, and only a refetch after
        // the conflict reconciles it.
        return probes <= 2
          ? allocationNotFound()
          : jsonResponse(activeAllocation());
      },
      membersGet: () => jsonResponse({ members: ROSTER }),
      allocationsPost: () =>
        jsonResponse(
          {
            code: 'ALLOCATION_CONFLICT',
            message: 'Already allocated.',
            correlationId: 'corr-conflict',
          },
          409,
        ),
    });
    await screen.findByText('Groceries');
    await waitFor(() => expect(probes).toBe(1));
    expect(screen.queryByText('Allocated')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await waitFor(() =>
      expect(within(panel).getAllByRole('checkbox').length).toBe(3),
    );
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Create allocation' }),
    );
    expect(
      await screen.findByText(
        'This expense cannot be allocated right now. The list was refreshed; review the entry before retrying.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Reference: corr-conflict')).toBeInTheDocument();
    // The stale "none" cache entry was invalidated: the reload probe
    // reconciles to the active allocation and the chip appears again.
    await waitFor(() =>
      expect(screen.getByText('Allocated')).toBeInTheDocument(),
    );
    expect(probes).toBeGreaterThanOrEqual(3);
  });

  it('guides an idempotency conflict create to a fresh start without a retained retry', async () => {
    const calls = renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => allocationNotFound(),
      membersGet: () => jsonResponse({ members: ROSTER }),
      allocationsPost: () =>
        jsonResponse(
          {
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'The key was already used.',
            correlationId: 'corr-key',
          },
          409,
        ),
    }).calls;
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await waitFor(() =>
      expect(within(panel).getAllByRole('checkbox').length).toBe(3),
    );
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Create allocation' }),
    );
    expect(
      await screen.findByText(
        'This request key was already used with different details. Review the entry and start again.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Reference: corr-key')).toBeInTheDocument();
    // The panel closed, nothing stays retained for a same-key retry, and
    // a refresh affordance is offered.
    expect(
      screen.queryByRole('group', { name: 'Allocation for Groceries' }),
    ).toBeNull();
    expect(
      screen.queryByText(/An earlier allocation request still has an unknown/),
    ).toBeNull();
    expect(
      screen.getAllByRole('button', { name: 'Refresh transactions' }).length,
    ).toBeGreaterThan(0);
    expect(allocationPostCalls(calls)).toHaveLength(1);
  });

  it('hides the Allocated chip when a cached row stops being allocation-fetchable', async () => {
    // The server made the expense private elsewhere: the feed reload now
    // answers the private row while the local allocation cache still
    // holds the once-active allocation.
    let madePrivate = false;
    renderSection({
      transactionsGet: () =>
        transactionPage([
          madePrivate
            ? householdExpense({ visibility: 'PRIVATE' })
            : householdExpense(),
        ]),
      allocationsGet: () => jsonResponse(activeAllocation()),
      transactionsPatch: () => {
        madePrivate = true;
        return jsonResponse(
          householdExpense({ visibility: 'PRIVATE', version: 1 }),
        );
      },
    });
    await screen.findByText('Groceries');
    // The cached active allocation shows its chip on the household row.
    expect(await screen.findByText('Allocated')).toBeInTheDocument();
    // The confirm group opens with the row action, then confirms.
    fireEvent.click(
      screen.getByRole('button', { name: 'Make Groceries private' }),
    );
    const shareConfirm = await screen.findByRole('group', {
      name: 'Confirm making Groceries private',
    });
    fireEvent.click(
      within(shareConfirm).getByRole('button', { name: 'Make private' }),
    );
    expect(
      await screen.findByText(
        'This entry is private again. Members lose access on their next refresh; information already read is not retracted.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Allocated')).toBeNull());
  });

  it('previews a tiny expense with an exact zero share in the panel', async () => {
    renderSection({
      transactionsGet: () =>
        transactionPage([
          householdExpense({ money: { amount: '-0.01', currency: 'USD' } }),
        ]),
      allocationsGet: () => allocationNotFound(),
      membersGet: () => jsonResponse({ members: ROSTER.slice(0, 2) }),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    // One minor unit to the first canonical participant and an exact zero
    // share to the last, with no invented rounding.
    await within(panel).findByText(
      'Divides the full 0.01 USD exactly: 0.01 USD + 0.00 USD across 2 participants.',
    );
  });

  it('refetches the roster each time the allocation creation form opens', async () => {
    const calls = renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => allocationNotFound(),
      membersGet: () => jsonResponse({ members: ROSTER }),
    }).calls;
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await waitFor(() =>
      expect(within(panel).getAllByRole('checkbox').length).toBe(3),
    );
    // Escape closes the panel and clears the roster snapshot.
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(
      screen.queryByRole('group', { name: 'Allocation for Groceries' }),
    ).toBeNull();
    // Reopening refetches the roster instead of reusing the old snapshot.
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const reopened = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await waitFor(() =>
      expect(within(reopened).getAllByRole('checkbox').length).toBe(3),
    );
    const memberCalls = calls.filter(({ url }) => url.endsWith('/members'));
    expect(memberCalls.length).toBe(2);
  });
});

describe('reporting zone entry defaults', () => {
  // 2026-09-30T23:30Z is still 2026-09-30 in UTC but already 2026-10-01 in
  // Pacific/Kiritimati (UTC+14). The pristine default must follow the loaded
  // household zone, never the host zone or a stale initial value.
  const BOUNDARY_NOW = () => new Date('2026-09-30T23:30:00Z');

  function entryDate(): HTMLInputElement {
    return screen.getByLabelText('Date') as HTMLInputElement;
  }

  it('recomputes a pristine entry date once a non-UTC zone loads', async () => {
    renderSection(
      {
        settingsGet: () =>
          jsonResponse({ reportingTimeZone: 'Pacific/Kiritimati', version: 0 }),
      },
      { nowProvider: BOUNDARY_NOW },
    );
    await waitFor(() => expect(entryDate().value).toBe('2026-10-01'));
  });

  it('keeps the UTC date when the loaded zone is UTC', async () => {
    renderSection(
      {
        settingsGet: () =>
          jsonResponse({ reportingTimeZone: 'Etc/UTC', version: 0 }),
      },
      { nowProvider: BOUNDARY_NOW },
    );
    await waitFor(() => expect(entryDate().value).toBe('2026-09-30'));
  });

  it('preserves a user-edited entry date across a reporting zone change', async () => {
    renderSection(
      {
        settingsGet: () =>
          jsonResponse({ reportingTimeZone: 'Etc/UTC', version: 0 }),
        settingsPatch: () =>
          jsonResponse({
            reportingTimeZone: 'Pacific/Kiritimati',
            version: 1,
          }),
      },
      {
        household: { ...HOUSEHOLD, role: 'OWNER' },
        nowProvider: BOUNDARY_NOW,
      },
    );
    await waitFor(() => expect(entryDate().value).toBe('2026-09-30'));
    fireEvent.change(entryDate(), { target: { value: '2026-08-15' } });
    // Change the zone through the owner settings form.
    const settings = await screen.findByTestId('reporting-settings-section');
    fireEvent.change(within(settings).getByLabelText('Reporting time zone'), {
      target: { value: 'Pacific/Kiritimati' },
    });
    fireEvent.click(
      within(settings).getByRole('button', { name: 'Save reporting zone' }),
    );
    expect(
      await within(settings).findByText(
        /Reporting time zone updated to Pacific\/Kiritimati/,
      ),
    ).toBeInTheDocument();
    // The edited draft survives the zone change instead of being recomputed.
    expect(entryDate().value).toBe('2026-08-15');
  });
});

describe('sibling ledger refresh signal', () => {
  it('refetches the feed on a confirmation signal without discarding the manual draft', async () => {
    let pageItems: Transaction[] = [];
    const { calls, rerenderWithLedgerSignal } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage(pageItems),
    });
    await screen.findByText('No transactions yet.');
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Typed draft text' },
    });

    // A sibling bank-activity confirmation commits a CONNECTED entry.
    pageItems = [
      transaction({
        source: 'CONNECTED',
        description: 'Confirmed coffee',
        money: { amount: '-4.50', currency: 'BRL' },
      }),
    ];
    rerenderWithLedgerSignal(1);

    expect(await screen.findByText('Confirmed coffee')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toHaveValue(
      'Typed draft text',
    );
    // The signal caused a real metadata-inclusive feed refetch: the initial
    // OWN load plus one more OWN load and one more accounts read.
    const feedFetches = calls.filter(({ url }) =>
      url.includes('/transactions?'),
    );
    expect(feedFetches.length).toBeGreaterThanOrEqual(2);
    expect(
      calls.filter(({ url }) => url.includes('/financial-accounts?')).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('serves a ledger signal that arrives before the initial load settles', async () => {
    const gateControl: { release: (() => void) | null } = { release: null };
    const initialGate = new Promise<void>((resolve) => {
      gateControl.release = () => resolve();
    });
    let firstFeedLoad = true;
    let pageItems: Transaction[] = [];
    const { calls, rerenderWithLedgerSignal } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => {
        if (firstFeedLoad) {
          firstFeedLoad = false;
          return initialGate.then(() => transactionPage(pageItems));
        }
        return transactionPage(pageItems);
      },
    });

    // The signal arrives while the initial feed read is still in flight.
    rerenderWithLedgerSignal(1);
    pageItems = [
      transaction({
        source: 'CONNECTED',
        description: 'Signal arrival',
        money: { amount: '-9.99', currency: 'BRL' },
      }),
    ];
    gateControl.release?.();

    expect(await screen.findByText('Signal arrival')).toBeInTheDocument();
    // The parked signal is served by the post-load settling effect.
    await waitFor(() =>
      expect(
        calls.filter(({ url }) => url.includes('/transactions?')).length,
      ).toBeGreaterThanOrEqual(2),
    );
  });
});

describe('categorization provenance', () => {
  it('loads the owner-only provenance once when details open, never per feed row', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () =>
        transactionPage([transaction({ category: 'GROCERIES' })]),
      transactionGet: () =>
        jsonResponse(transaction({ category: 'GROCERIES' })),
      categorizationGet: (transactionId) =>
        jsonResponse(
          categorizationState({
            transactionId,
            category: 'GROCERIES',
            origin: 'PROVIDER',
            assignedAt: '2026-09-22T12:00:00Z',
          }),
        ),
    });
    await screen.findByText('Groceries');
    // A visible feed row is never a provenance probe.
    expect(categorizationCalls(calls)).toHaveLength(0);
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Details for Groceries',
    });
    expect(
      await within(panel).findByText(
        /Bank category — mapped from the connected bank data\./,
      ),
    ).toBeInTheDocument();
    expect(categorizationCalls(calls)).toHaveLength(1);
    expect(categorizationCalls(calls)[0]?.url).toBe(
      `/api/households/${HOUSEHOLD.id}/transactions/${EXPENSE_ID}/categorization`,
    );
    expect(categorizationCalls(calls)[0]?.init?.method).toBe('GET');
    // The server's assignment instant is shown verbatim.
    expect(within(panel).getByText('2026-09-22T12:00:00Z')).toBeInTheDocument();
  });

  it('points the owner at the review queue when a suggestion is open for the open entry', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      transactionGet: () => jsonResponse(transaction()),
      categorizationGet: (transactionId) =>
        jsonResponse(
          categorizationState({
            transactionId,
            category: null,
            origin: 'NONE',
            reviewState: 'OPEN',
          }),
        ),
      reviewsGet: () => reviewPage([review()], 1),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Details for Groceries',
    });
    expect(
      await within(panel).findByText(
        /HouseSync has a category suggestion for this entry\. It is waiting for your decision under “Category reviews”\./,
      ),
    ).toBeInTheDocument();
    // Only the existence of the suggestion is disclosed here; the suggestion
    // itself stays owner-private behind the queue.
    expect(within(panel).queryByText(/Food shopping/)).toBeNull();
  });

  it('never probes provenance for another member’s shared entry', async () => {
    const { calls } = renderSection({
      transactionsGet: (view: 'OWN' | 'HOUSEHOLD') =>
        view === 'HOUSEHOLD'
          ? transactionPage([sharedByOther()])
          : transactionPage([]),
      transactionGet: () => jsonResponse(sharedByOther()),
      categorizationGet: () => {
        throw new Error('a shared entry must never be probed for provenance');
      },
    });
    await screen.findByText('No transactions yet.');
    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));
    const row = (await screen.findByText('Shared internet bill')).closest(
      'li',
    ) as HTMLLIElement;
    fireEvent.click(
      within(row).getByRole('button', {
        name: 'Details for Shared internet bill',
      }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Details for Shared internet bill',
    });
    // The shared reader sees only the effective category.
    expect(within(panel).getByText('Utilities')).toBeInTheDocument();
    expect(within(panel).queryByText('Category decision')).toBeNull();
    expect(categorizationCalls(calls)).toHaveLength(0);
  });

  it('converges the open detail and provenance after a committed correction', async () => {
    let provenance = categorizationState({
      category: 'GROCERIES',
      origin: 'PROVIDER',
    });
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () =>
        transactionPage([transaction({ category: 'GROCERIES' })]),
      transactionGet: () =>
        jsonResponse(transaction({ category: 'GROCERIES' })),
      transactionsPatch: () => {
        provenance = categorizationState({
          category: 'DINING',
          origin: 'USER',
          transactionVersion: 7,
        });
        return jsonResponse(transaction({ category: 'DINING', version: 7 }));
      },
      categorizationGet: (transactionId) =>
        jsonResponse({ ...provenance, transactionId }),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Details for Groceries',
    });
    expect(await within(panel).findByText(/Bank category/)).toBeInTheDocument();

    // An unrelated manual-entry draft is in progress.
    fireEvent.change(
      screen.getByLabelText('Amount', {
        selector: `#new-transaction-amount-${HOUSEHOLD.id}`,
      }),
      { target: { value: '12.34' } },
    );
    fireEvent.change(
      screen.getByLabelText('Description', {
        selector: `#new-transaction-description-${HOUSEHOLD.id}`,
      }),
      { target: { value: 'Draft groceries' } },
    );

    const editButton = screen.getByRole('button', { name: 'Edit Groceries' });
    const row = editButton.closest('li') as HTMLLIElement;
    fireEvent.click(editButton);
    fireEvent.change(within(row).getByLabelText('Category'), {
      target: { value: 'DINING' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));

    expect(
      await screen.findByText(
        /this is your decision — automation will not replace it/,
      ),
    ).toBeInTheDocument();
    // The panel stays open on the committed entry and its provenance
    // converges to the owner's own decision.
    expect(within(panel).getByText('Dining')).toBeInTheDocument();
    expect(
      await within(panel).findByText(
        /Chosen by you — your decision; automation will not replace it\./,
      ),
    ).toBeInTheDocument();
    expect(categorizationCalls(calls)).toHaveLength(2);
    // The unrelated entry draft survives the convergence.
    expect(
      screen.getByLabelText('Amount', {
        selector: `#new-transaction-amount-${HOUSEHOLD.id}`,
      }),
    ).toHaveValue('12.34');
    expect(
      screen.getByLabelText('Description', {
        selector: `#new-transaction-description-${HOUSEHOLD.id}`,
      }),
    ).toHaveValue('Draft groceries');
    expect(JSON.parse(String(patchCalls(calls)[0]?.init?.body))).toEqual({
      expectedVersion: 0,
      category: 'DINING',
    });
  });

  it('names the durable decision when a correction clears the category', async () => {
    let provenance = categorizationState({
      category: 'GROCERIES',
      origin: 'LEGACY',
    });
    renderSection({
      transactionsGet: () =>
        transactionPage([transaction({ category: 'GROCERIES' })]),
      transactionGet: () =>
        jsonResponse(transaction({ category: 'GROCERIES' })),
      transactionsPatch: () => {
        provenance = categorizationState({
          category: null,
          origin: 'USER',
          transactionVersion: 1,
        });
        return jsonResponse(transaction({ category: null, version: 1 }));
      },
      categorizationGet: (transactionId) =>
        jsonResponse({ ...provenance, transactionId }),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Details for Groceries',
    });
    expect(
      await within(panel).findByText(
        /Existing category — recorded before you chose one\./,
      ),
    ).toBeInTheDocument();
    const editButton = screen.getByRole('button', { name: 'Edit Groceries' });
    const row = editButton.closest('li') as HTMLLIElement;
    fireEvent.click(editButton);
    fireEvent.change(within(row).getByLabelText('Category'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    expect(
      await screen.findByText(
        /Category cleared: this entry stays uncategorized because you decided so/,
      ),
    ).toBeInTheDocument();
    expect(within(panel).getByText('Uncategorized')).toBeInTheDocument();
    expect(await within(panel).findByText(/Chosen by you/)).toBeInTheDocument();
  });

  it('renders calm labels for every origin and never a raw code', async () => {
    const cases: Array<[CategorizationOrigin, RegExp]> = [
      ['NONE', /No category assigned yet/],
      ['LEGACY', /Existing category — recorded before you chose one\./],
      ['USER', /Chosen by you/],
      ['OWNER_RULE', /Your merchant rule/],
      ['PROVIDER', /Bank category/],
      ['INHERITED', /Inherited from expense/],
    ];
    for (const [origin, label] of cases) {
      const refund = origin === 'INHERITED';
      const entry = refund
        ? transaction({
            kind: 'REFUND',
            refundOfTransactionId: EXPENSE_ID,
            money: { amount: '5.00', currency: 'BRL' },
          })
        : transaction({ category: 'GROCERIES', source: 'CONNECTED' });
      const { unmount } = renderSection({
        transactionsGet: () => transactionPage([entry]),
        transactionGet: () => jsonResponse(entry),
        categorizationGet: (transactionId) =>
          jsonResponse(
            categorizationState({
              transactionId,
              category: refund ? 'GROCERIES' : null,
              origin,
            }),
          ),
      });
      await screen.findByText('Groceries');
      fireEvent.click(
        screen.getByRole('button', { name: 'Details for Groceries' }),
      );
      const panel = await screen.findByRole('group', {
        name: 'Details for Groceries',
      });
      expect(await within(panel).findByText(label)).toBeInTheDocument();
      expect(within(panel).queryByText(origin)).toBeNull();
      unmount();
    }
  });

  it('renders the connected ledger source instead of assuming manual entry', async () => {
    renderSection({
      transactionsGet: () =>
        transactionPage([transaction({ source: 'CONNECTED' })]),
      transactionGet: () => jsonResponse(transaction({ source: 'CONNECTED' })),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Details for Groceries',
    });
    expect(within(panel).getByText('Connected')).toBeInTheDocument();
    expect(within(panel).queryByText('Manual')).toBeNull();
  });

  it('keeps an unavailable decision calm and recovers on explicit retry', async () => {
    let unavailable = true;
    const { calls } = renderSection({
      transactionsGet: () =>
        transactionPage([transaction({ category: 'GROCERIES' })]),
      transactionGet: () =>
        jsonResponse(transaction({ category: 'GROCERIES' })),
      categorizationGet: () =>
        unavailable
          ? jsonResponse(
              {
                code: 'TRANSACTION_NOT_FOUND',
                message: 'Transaction is unavailable.',
              },
              404,
            )
          : jsonResponse(
              categorizationState({
                category: 'GROCERIES',
                origin: 'LEGACY',
              }),
            ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Details for Groceries',
    });
    expect(
      await within(panel).findByText('Category decision unavailable.'),
    ).toBeInTheDocument();
    // A private 404 is a calm state: no error notice, no raw code, and the
    // detail panel itself is untouched.
    expect(screen.queryByText(/no longer available to you/)).toBeNull();
    expect(screen.queryByText(/TRANSACTION_NOT_FOUND/)).toBeNull();
    unavailable = false;
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Retry category decision' }),
    );
    expect(
      await within(panel).findByText(/Existing category/),
    ).toBeInTheDocument();
    expect(categorizationCalls(calls)).toHaveLength(2);
  });

  it('never presents an out-of-date decision as the current one', async () => {
    renderSection({
      transactionsGet: () =>
        transactionPage([transaction({ category: 'GROCERIES', version: 6 })]),
      transactionGet: () =>
        jsonResponse(transaction({ category: 'GROCERIES', version: 6 })),
      categorizationGet: (transactionId) =>
        jsonResponse(
          categorizationState({
            transactionId,
            category: 'GROCERIES',
            origin: 'USER',
            transactionVersion: 5,
          }),
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Details for Groceries',
    });
    expect(
      await within(panel).findByText(
        /This decision changed on the server — retry to load the current one\./,
      ),
    ).toBeInTheDocument();
    expect(within(panel).queryByText(/Chosen by you/)).toBeNull();
  });

  it('aborts the provenance request when the panel closes', async () => {
    let releaseProvenance!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      releaseProvenance = resolve;
    });
    const { calls } = renderSection({
      transactionsGet: () =>
        transactionPage([transaction({ category: 'GROCERIES' })]),
      transactionGet: () =>
        jsonResponse(transaction({ category: 'GROCERIES' })),
      categorizationGet: () => gate,
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Details for Groceries',
    });
    expect(
      await within(panel).findByText('Loading your category decision…'),
    ).toBeInTheDocument();
    const signal = categorizationCalls(calls)[0]?.init?.signal;
    expect(signal?.aborted).toBe(false);
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Close details' }),
    );
    await waitFor(() => expect(signal?.aborted).toBe(true));
    releaseProvenance(
      jsonResponse(
        categorizationState({ category: 'GROCERIES', origin: 'LEGACY' }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(/Existing category/)).toBeNull();
  });

  it('binds and focuses the category control when the server rejects a category', async () => {
    renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([]),
      transactionsPost: () =>
        jsonResponse(
          {
            code: 'VALIDATION_FAILED',
            message: 'Check the highlighted fields.',
            correlationId: 'corr-category-focus',
            fieldErrors: { category: 'That category is not accepted.' },
          },
          400,
        ),
    });
    await screen.findByText('No transactions yet.');
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'GROCERIES' },
    });
    await fillAndSubmit({ date: FIXED_DATE });
    expect(
      await screen.findByText('That category is not accepted.'),
    ).toBeInTheDocument();
    const category = screen.getByLabelText('Category');
    expect(category).toHaveAttribute('aria-invalid', 'true');
    // The rejection is announced on, and returns focus to, the category
    // control rather than sending the user to the amount field.
    await waitFor(() => expect(category).toHaveFocus());
    expect(screen.getByLabelText('Amount')).not.toHaveFocus();
  });

  it('focuses the editor category control on a rejected correction', async () => {
    renderSection({
      transactionsGet: () =>
        transactionPage([transaction({ category: 'DINING' })]),
      transactionsPatch: () =>
        jsonResponse(
          {
            code: 'VALIDATION_FAILED',
            message: 'Check the highlighted fields.',
            fieldErrors: { category: 'That category is not accepted.' },
          },
          400,
        ),
    });
    await screen.findByText('Groceries');
    const editButton = screen.getByRole('button', { name: 'Edit Groceries' });
    const row = editButton.closest('li') as HTMLLIElement;
    fireEvent.click(editButton);
    const category = within(row).getByLabelText('Category');
    fireEvent.change(category, { target: { value: 'GROCERIES' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    expect(
      await screen.findByText('That category is not accepted.'),
    ).toBeInTheDocument();
    expect(category).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(category).toHaveFocus());
  });

  it('exposes provenance as a labelled detail with a native retry control', async () => {
    renderSection({
      transactionsGet: () =>
        transactionPage([transaction({ category: 'GROCERIES' })]),
      transactionGet: () =>
        jsonResponse(transaction({ category: 'GROCERIES' })),
      categorizationGet: () =>
        jsonResponse(
          { code: 'INTERNAL_ERROR', message: 'State is unavailable.' },
          500,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Details for Groceries',
    });
    const term = await within(panel).findByText('Category decision');
    expect(term.tagName).toBe('DT');
    // The decision belongs to the same definition list as every other detail.
    expect(term.closest('dl')).not.toBeNull();
    const retry = within(panel).getByRole('button', {
      name: 'Retry category decision',
    });
    expect(retry.tagName).toBe('BUTTON');
    expect(retry).toBeEnabled();
  });

  it('clears the open panel and private provenance on session loss', async () => {
    const { onSessionExpired } = renderSection({
      transactionsGet: () => transactionPage([transaction()]),
      transactionGet: () => jsonResponse(transaction()),
      categorizationGet: () =>
        jsonResponse(
          { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
          401,
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    await waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole('group', { name: 'Details for Groceries' }),
    ).toBeNull();
    expect(screen.queryByText('Groceries')).toBeNull();
    expect(screen.queryByText('Category decision')).toBeNull();
  });

  it('labels categories as unavailable when the taxonomy fails and retries on refresh', async () => {
    let taxonomyWorks = false;
    renderSection({
      transactionsGet: () =>
        transactionPage([transaction({ category: 'GROCERIES' })]),
      categoriesGet: () =>
        taxonomyWorks
          ? jsonResponse({ items: CATEGORY_ITEMS })
          : jsonResponse(
              { code: 'INTERNAL_ERROR', message: 'Category list is down.' },
              500,
            ),
    });
    const row = (await screen.findByText('Groceries')).closest(
      'li',
    ) as HTMLLIElement;
    // The ledger stays visible and no raw enum token is used as a label.
    expect(within(row).getByText('Category unavailable')).toBeInTheDocument();
    expect(screen.queryByText('GROCERIES')).toBeNull();
    expect(
      await screen.findByText(
        /so category names are unavailable\. Refresh to retry\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Category unavailable. Refresh the section to retry the list.',
      ),
    ).toBeInTheDocument();

    taxonomyWorks = true;
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh transactions' }),
    );
    expect(await within(row).findByText('Food shopping')).toBeInTheDocument();
    expect(within(row).queryByText('Category unavailable')).toBeNull();
  });
});
describe('explicit future-match learning', () => {
  const RULE_POST_SUFFIX = '/categorization-rule';
  const rulePostCalls = (calls: Call[]) =>
    calls.filter(({ url }) => url.endsWith(RULE_POST_SUFFIX));
  const rulesGetCalls = (calls: Call[]) =>
    calls.filter(({ url }) => url.includes('/categorization-rules?'));

  const idempotencyKeyOf = (call: Call | undefined): string | undefined =>
    (call?.init?.headers as Record<string, string> | undefined)?.[
      'Idempotency-Key'
    ];

  /** The owner's own decision with the server's learn capability. */
  function eligibleProvenance(transactionId: string) {
    return jsonResponse(
      categorizationState({
        transactionId,
        transactionVersion: 0,
        category: 'GROCERIES',
        origin: 'USER',
        ruleEligible: true,
      }),
    );
  }

  async function openEligibleDetail() {
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Details for Groceries',
    });
    const offer = await within(panel).findByRole('button', {
      name: 'Use for future matches',
    });
    return { panel, offer };
  }

  it('offers the learn action only when the server reports the capability', async () => {
    const { unmount } = renderSection({
      transactionsGet: () =>
        transactionPage([transaction({ category: 'GROCERIES' })]),
      transactionGet: () =>
        jsonResponse(transaction({ category: 'GROCERIES' })),
      categorizationGet: (transactionId) =>
        jsonResponse(
          categorizationState({
            transactionId,
            category: 'GROCERIES',
            origin: 'USER',
            ruleEligible: false,
          }),
        ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Details for Groceries',
    });
    expect(await within(panel).findByText(/Chosen by you/)).toBeInTheDocument();
    // An owner decision alone is not enough: the browser never derives a key
    // or decides eligibility for itself.
    expect(
      within(panel).queryByRole('button', { name: 'Use for future matches' }),
    ).toBeNull();
    unmount();

    const second = renderSection({
      transactionsGet: () =>
        transactionPage([transaction({ category: 'GROCERIES' })]),
      transactionGet: () =>
        jsonResponse(transaction({ category: 'GROCERIES' })),
      categorizationGet: eligibleProvenance,
    });
    await screen.findByText('Groceries');
    const { offer } = await openEligibleDetail();
    expect(offer).toBeEnabled();
    // The private match key is never received, so it can never be submitted.
    expect(rulePostCalls(second.calls)).toHaveLength(0);
  });

  it('creates the rule from the current version under a durable key', async () => {
    let eligible = true;
    const { calls } = renderSection({
      transactionsGet: () =>
        transactionPage([transaction({ category: 'GROCERIES' })]),
      transactionGet: () =>
        jsonResponse(transaction({ category: 'GROCERIES' })),
      categorizationGet: (transactionId) =>
        jsonResponse(
          categorizationState({
            transactionId,
            category: 'GROCERIES',
            origin: 'USER',
            ruleEligible: eligible,
          }),
        ),
      rulePost: () => {
        eligible = false;
        return jsonResponse(rule(), 201);
      },
    });
    await screen.findByText('Groceries');
    const { panel, offer } = await openEligibleDetail();
    fireEvent.click(offer);

    expect(
      await screen.findByText(
        /Future matches for “Groceries” now use Food shopping\./,
      ),
    ).toBeInTheDocument();
    const posts = rulePostCalls(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe(
      `/api/households/${HOUSEHOLD.id}/transactions/${EXPENSE_ID}/categorization-rule`,
    );
    expect(posts[0]?.init?.method).toBe('POST');
    expect(posts[0]?.init?.cache).toBe('no-store');
    // Exactly the transaction version travels: household, owner, match type,
    // and match key all stay server-derived.
    expect(JSON.parse(String(posts[0]?.init?.body))).toEqual({
      expectedTransactionVersion: 0,
    });
    expect(idempotencyKeyOf(posts[0])).toMatch(/^[0-9a-f-]{36}$/);
    // The committed rule converges the private list, and the spent capability
    // removes the offer instead of inviting a duplicate.
    await waitFor(() =>
      expect(rulesGetCalls(calls).length).toBeGreaterThanOrEqual(2),
    );
    await waitFor(() =>
      expect(
        within(panel).queryByRole('button', { name: 'Use for future matches' }),
      ).toBeNull(),
    );
    expect(screen.queryByText(/Retry same request/)).toBeNull();
  });

  it('keeps the committed category and the same key when the outcome is unknown', async () => {
    let outcome: 'busy' | 'created' = 'busy';
    const { calls } = renderSection({
      transactionsGet: () =>
        transactionPage([transaction({ category: 'DINING', version: 7 })]),
      transactionGet: () =>
        jsonResponse(transaction({ category: 'DINING', version: 7 })),
      categorizationGet: (transactionId) =>
        jsonResponse(
          categorizationState({
            transactionId,
            transactionVersion: 7,
            category: 'DINING',
            origin: 'USER',
            ruleEligible: true,
          }),
        ),
      rulePost: () =>
        outcome === 'busy'
          ? jsonResponse({ code: 'FINANCE_BUSY', message: 'Busy.' }, 503)
          : jsonResponse(
              rule({ category: 'DINING', matchLabel: 'Groceries' }),
              200,
            ),
    });
    await screen.findByText('Groceries');
    const { offer } = await openEligibleDetail();
    fireEvent.click(offer);

    expect(
      await screen.findByText(/has an unknown outcome/),
    ).toBeInTheDocument();
    // The already-saved category is untouched by the additive failure.
    const row = screen
      .getByRole('button', { name: 'Edit Groceries' })
      .closest('li') as HTMLLIElement;
    expect(within(row).getByText('Dining')).toBeInTheDocument();
    // The exact request stays retained: the same key is offered for retry.
    expect(screen.queryByText(/Retry same request/)).not.toBeNull();
    expect(rulePostCalls(calls)).toHaveLength(1);
    const firstKey = idempotencyKeyOf(rulePostCalls(calls)[0]);

    outcome = 'created';
    fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
    expect(
      await screen.findByText(
        /Future matches for “Groceries” now use Dining\./,
      ),
    ).toBeInTheDocument();
    const posts = rulePostCalls(calls);
    expect(posts).toHaveLength(2);
    expect(idempotencyKeyOf(posts[1])).toBe(firstKey);
    expect(JSON.parse(String(posts[1]?.init?.body))).toEqual({
      expectedTransactionVersion: 7,
    });
    expect(screen.queryByText(/Retry same request/)).toBeNull();
  });

  it('explains an existing active rule for the merchant and clears the offer', async () => {
    let eligible = true;
    const { calls } = renderSection({
      transactionsGet: () =>
        transactionPage([transaction({ category: 'GROCERIES' })]),
      transactionGet: () =>
        jsonResponse(transaction({ category: 'GROCERIES' })),
      categorizationGet: (transactionId) =>
        jsonResponse(
          categorizationState({
            transactionId,
            category: 'GROCERIES',
            origin: 'USER',
            ruleEligible: eligible,
          }),
        ),
      rulesGet: () =>
        jsonResponse({
          items: [rule({ matchLabel: 'Corner Market' })],
          limit: 50,
          offset: 0,
          hasMore: false,
        }),
      rulePost: () => {
        eligible = false;
        return jsonResponse(
          {
            code: 'CATEGORY_RULE_CONFLICT',
            message: 'An active rule already covers this merchant.',
          },
          409,
        );
      },
    });
    await screen.findByText('Groceries');
    const { panel, offer } = await openEligibleDetail();
    fireEvent.click(offer);

    expect(
      await screen.findByText(
        /You already have an active rule for this merchant/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Retry same request/)).toBeNull();
    expect(rulePostCalls(calls)).toHaveLength(1);
    await waitFor(() =>
      expect(
        within(panel).queryByRole('button', { name: 'Use for future matches' }),
      ).toBeNull(),
    );
    // The owner's own existing rule is where it is managed.
    expect(screen.getByText('Corner Market')).toBeInTheDocument();
  });

  it('refuses a stale learn attempt, closes the panel, and refreshes', async () => {
    const { calls } = renderSection({
      transactionsGet: () =>
        transactionPage([transaction({ category: 'GROCERIES' })]),
      transactionGet: () =>
        jsonResponse(transaction({ category: 'GROCERIES' })),
      categorizationGet: eligibleProvenance,
      rulePost: () =>
        jsonResponse(
          { code: 'RESOURCE_VERSION_CONFLICT', message: 'Stale.' },
          409,
        ),
    });
    await screen.findByText('Groceries');
    const { offer } = await openEligibleDetail();
    fireEvent.click(offer);

    expect(
      await screen.findByText(/This entry changed on the server/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Retry same request/)).toBeNull();
    expect(
      screen.queryByRole('group', { name: 'Details for Groceries' }),
    ).toBeNull();
    await waitFor(() =>
      expect(
        calls.filter(({ url }) => url.includes('view=OWN&status=ALL')).length,
      ).toBeGreaterThanOrEqual(2),
    );
  });

  it('reports a decision that cannot become a rule without losing the category', async () => {
    renderSection({
      transactionsGet: () =>
        transactionPage([transaction({ category: 'GROCERIES' })]),
      transactionGet: () =>
        jsonResponse(transaction({ category: 'GROCERIES' })),
      categorizationGet: eligibleProvenance,
      rulePost: () =>
        jsonResponse(
          {
            code: 'VALIDATION_FAILED',
            message: 'Check the highlighted fields.',
          },
          400,
        ),
    });
    await screen.findByText('Groceries');
    const { offer } = await openEligibleDetail();
    fireEvent.click(offer);
    expect(
      await screen.findByText(/This decision cannot become a rule right now/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Retry same request/)).toBeNull();
    // The category the owner already saved is still shown on the entry.
    const row = screen
      .getByRole('button', { name: 'Edit Groceries' })
      .closest('li') as HTMLLIElement;
    expect(within(row).getByText('Food shopping')).toBeInTheDocument();
  });

  it('drops the retained learn request when the session is lost', async () => {
    const { calls, onSessionExpired } = renderSection({
      transactionsGet: () =>
        transactionPage([transaction({ category: 'GROCERIES' })]),
      transactionGet: () =>
        jsonResponse(transaction({ category: 'GROCERIES' })),
      categorizationGet: eligibleProvenance,
      rulesGet: () =>
        jsonResponse({
          items: [rule({ matchLabel: 'Corner Market' })],
          limit: 50,
          offset: 0,
          hasMore: false,
        }),
      rulePost: () =>
        jsonResponse(
          { code: 'UNAUTHENTICATED', message: 'You are not signed in.' },
          401,
        ),
    });
    await screen.findByText('Groceries');
    // The private rule list is loaded before the loss.
    expect(await screen.findByText('Corner Market')).toBeInTheDocument();
    const { offer } = await openEligibleDetail();
    fireEvent.click(offer);

    await waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
    expect(rulePostCalls(calls)).toHaveLength(1);
    // Private rule state, the retained intent, and the open panel are gone.
    expect(screen.queryByText(/Retry same request/)).toBeNull();
    expect(
      screen.queryByRole('group', { name: 'Details for Groceries' }),
    ).toBeNull();
    await waitFor(() => expect(screen.queryByText('Corner Market')).toBeNull());
    expect(
      await screen.findByText(
        'Your rules are not loaded. Refresh the household to load them again.',
      ),
    ).toBeInTheDocument();
  });

  it('never offers the action for another member’s shared entry', async () => {
    const { calls } = renderSection({
      transactionsGet: (view: 'OWN' | 'HOUSEHOLD') =>
        view === 'HOUSEHOLD'
          ? transactionPage([sharedByOther()])
          : transactionPage([]),
      transactionGet: () => jsonResponse(sharedByOther()),
      categorizationGet: () => {
        throw new Error('a shared entry must never be probed for provenance');
      },
    });
    await screen.findByText('No transactions yet.');
    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));
    const row = (await screen.findByText('Shared internet bill')).closest(
      'li',
    ) as HTMLLIElement;
    fireEvent.click(
      within(row).getByRole('button', {
        name: 'Details for Shared internet bill',
      }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Details for Shared internet bill',
    });
    expect(
      within(panel).queryByRole('button', { name: 'Use for future matches' }),
    ).toBeNull();
    expect(rulePostCalls(calls)).toHaveLength(0);
  });
});

describe('category review queue integration', () => {
  const EDIT_CATEGORY = `#edit-transaction-category-${EXPENSE_ID}`;
  const NEW_DESCRIPTION = `#new-transaction-description-${HOUSEHOLD.id}`;

  it('exposes the owner-private review count as one entry point without probing provenance per row', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      reviewsGet: () => reviewPage([review()], 1),
    });
    await screen.findByText('Groceries');

    expect(
      await screen.findByText('1 suggestion is waiting for your decision.'),
    ).toBeInTheDocument();
    const entry = screen.getByRole('button', {
      name: 'Review suggested categories (1 waiting)',
    });
    expect(entry).toHaveAttribute(
      'aria-controls',
      `finance-reviews-queue-${HOUSEHOLD.id}`,
    );
    // A visible feed row is never a review or provenance probe.
    expect(categorizationCalls(calls)).toHaveLength(0);
    expect(reviewCalls(calls)).toHaveLength(1);

    fireEvent.click(entry);
    expect(
      await screen.findByText(/Recorded: Uncategorized/),
    ).toBeInTheDocument();
    expect(categorizationCalls(calls)).toHaveLength(0);
  });

  it('refreshes the private review count after a committed category correction', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      reviewsGet: () => reviewPage([review()], 1),
      transactionsPatch: () =>
        jsonResponse(transaction({ category: 'DINING', version: 1 })),
    });
    await screen.findByText('Groceries');
    await waitFor(() => expect(reviewCalls(calls)).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Edit Groceries' }));
    fireEvent.change(
      await screen.findByLabelText('Category', { selector: EDIT_CATEGORY }),
      { target: { value: 'DINING' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));

    expect(
      await screen.findByText(/Transaction corrected/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(reviewCalls(calls).length).toBeGreaterThanOrEqual(2),
    );
  });

  it('refreshes the private review count after a void', async () => {
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      reviewsGet: () => reviewPage([review()], 1),
      transactionsPatch: () =>
        jsonResponse(transaction({ status: 'VOIDED', version: 1 })),
    });
    await screen.findByText('Groceries');
    await waitFor(() => expect(reviewCalls(calls)).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Void Groceries' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Void transaction' }),
    );

    expect(await screen.findByText(/Transaction voided/)).toBeInTheDocument();
    await waitFor(() =>
      expect(reviewCalls(calls).length).toBeGreaterThanOrEqual(2),
    );
  });

  it('refreshes the private review count when a sibling connected admission commits', async () => {
    const { calls, rerenderWithLedgerSignal } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () => transactionPage([transaction()]),
      reviewsGet: () => reviewPage([review()], 1),
    });
    await screen.findByText('Groceries');
    await waitFor(() => expect(reviewCalls(calls)).toHaveLength(1));

    rerenderWithLedgerSignal(1);

    await waitFor(() =>
      expect(reviewCalls(calls).length).toBeGreaterThanOrEqual(2),
    );
  });

  it('converges the feed, the open detail, and provenance after a resolution without touching category-agnostic totals or the entry draft', async () => {
    let committedCategory: string | null = null;
    let committedVersion = 0;
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: () =>
        transactionPage([
          transaction({
            category: committedCategory,
            version: committedVersion,
          }),
        ]),
      transactionGet: () =>
        jsonResponse(
          transaction({
            category: committedCategory,
            version: committedVersion,
          }),
        ),
      categorizationGet: (transactionId) =>
        jsonResponse(
          categorizationState({
            transactionId,
            transactionVersion: committedVersion,
            category: committedCategory,
            origin: committedCategory === null ? 'NONE' : 'USER',
          }),
        ),
      reviewsGet: () =>
        reviewPage(
          committedCategory === null ? [review()] : [],
          committedCategory === null ? 1 : 0,
        ),
      reviewResolve: () => {
        committedCategory = 'GROCERIES';
        committedVersion = 1;
        return jsonResponse(
          review({
            status: 'ACCEPTED',
            version: 1,
            transaction: transaction({
              category: 'GROCERIES',
              version: 1,
            }),
          }),
        );
      },
    });
    await screen.findByText('Groceries');
    const balancesBefore = calls.filter(({ url }) =>
      url.endsWith('/member-balances'),
    ).length;
    const summaryBefore = calls.filter(({ url }) =>
      url.includes('/spending-summary?'),
    ).length;

    // An unrelated manual-entry draft in the same section.
    fireEvent.change(
      screen.getByLabelText('Description', { selector: NEW_DESCRIPTION }),
      { target: { value: 'Draft lunch' } },
    );
    // The owner's details for the same entry are open when the decision lands.
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Details for Groceries',
    });
    expect(within(panel).getByText('Uncategorized')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /Review suggested categories/ }),
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Review the suggestion for Groceries',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));

    expect(await screen.findByText(/Decision saved/)).toBeInTheDocument();
    await waitFor(() =>
      expect(within(panel).getByText('Food shopping')).toBeInTheDocument(),
    );
    // The committed decision is re-read as owner-only provenance, and the
    // feed was reloaded from the server.
    expect(categorizationCalls(calls).length).toBeGreaterThanOrEqual(2);
    await waitFor(() => expect(resolveCalls(calls)).toHaveLength(1));
    expect(JSON.parse(String(resolveCalls(calls)[0]?.init?.body))).toEqual({
      expectedVersion: 0,
      expectedTransactionVersion: 0,
      action: 'ACCEPT_SUGGESTION',
    });
    // Category-agnostic projections are deliberately untouched.
    expect(
      calls.filter(({ url }) => url.endsWith('/member-balances')).length,
    ).toBe(balancesBefore);
    expect(
      calls.filter(({ url }) => url.includes('/spending-summary?')).length,
    ).toBe(summaryBefore);
    // The unrelated entry draft survives the background convergence.
    expect(
      screen.getByLabelText('Description', { selector: NEW_DESCRIPTION }),
    ).toHaveValue('Draft lunch');
  });
});
