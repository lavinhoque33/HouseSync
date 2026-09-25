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
const MEMBER_B = '30000000-0000-4000-8000-000000000002';
const MEMBER_C = '30000000-0000-4000-8000-000000000003';
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
  transactionsGet?: (
    view: 'OWN' | 'HOUSEHOLD',
    visibility?: string | null,
    offset?: number,
  ) => Response | Promise<Response>;
  transactionsPost?: () => Response | Promise<Response>;
  transactionGet?: (transactionId: string) => Response | Promise<Response>;
  categorizationGet?: (transactionId: string) => Response | Promise<Response>;
  transactionsPatch?: (transactionId: string) => Response | Promise<Response>;
  allocationsGet?: (transactionId: string) => Response | Promise<Response>;
  allocationsPreview?: (init?: RequestInit) => Response | Promise<Response>;
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
  aiStatusGet?: () => Response | Promise<Response>;
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
      if (url.startsWith(`/api/households/${HOUSEHOLD.id}/repayments?`)) {
        return jsonResponse({
          items: [],
          limit: 50,
          offset: 0,
          hasMore: false,
        });
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
      if (url.startsWith(`${transactionBase}?`) && init?.method === 'GET') {
        const query = new URLSearchParams(
          url.slice(transactionBase.length + 1),
        );
        const view = query.get('view');
        if (view === 'OWN' || view === 'HOUSEHOLD') {
          const offset = Number(query.get('offset'));
          return (
            routes.transactionsGet?.(view, query.get('visibility'), offset) ??
            jsonResponse({ items: [], limit: 100, offset, hasMore: false })
          );
        }
      }
      if (
        url.startsWith(`${transactionBase}/`) &&
        url.endsWith('/allocation/preview') &&
        init?.method === 'POST'
      ) {
        if (routes.allocationsPreview) return routes.allocationsPreview(init);
        return jsonResponse({
          transactionId: EXPENSE_ID,
          transactionVersion: 0,
          method: 'EQUAL',
          refundPolicy: 'EQUAL_V1',
          originalAmount: { amount: '10.00', currency: 'USD' },
          participants: [
            { userId: ACTOR_ID, share: { amount: '3.34', currency: 'USD' } },
            { userId: MEMBER_B, share: { amount: '3.33', currency: 'USD' } },
            { userId: MEMBER_C, share: { amount: '3.33', currency: 'USD' } },
          ],
          impact: {
            cumulativeRefundAmount: { amount: '0.00', currency: 'USD' },
            payerCredit: { amount: '10.00', currency: 'USD' },
            participants: [
              {
                userId: ACTOR_ID,
                cumulativeRefundShare: { amount: '0.00', currency: 'USD' },
                remainingObligation: { amount: '3.34', currency: 'USD' },
              },
              {
                userId: MEMBER_B,
                cumulativeRefundShare: { amount: '0.00', currency: 'USD' },
                remainingObligation: { amount: '3.33', currency: 'USD' },
              },
              {
                userId: MEMBER_C,
                cumulativeRefundShare: { amount: '0.00', currency: 'USD' },
                remainingObligation: { amount: '3.33', currency: 'USD' },
              },
            ],
          },
        });
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
      if (url.endsWith('/categorization-ai-work/status')) {
        // The default deployment runs no AI, so nothing is pending.
        return (
          routes.aiStatusGet?.() ??
          jsonResponse({ enabled: false, pendingCount: 0, failedCount: 0 })
        );
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

    // Privacy and void state are textual, never color-only. The state is
    // asserted on each entry, not by counting all "Private" text: the
    // visibility filter control carries its own "Private" label.
    for (const description of [
      'Groceries',
      'Salary',
      'Card payment',
      'Cancelled entry',
    ]) {
      expect(
        within(card(description)).getByText('Private'),
      ).toBeInTheDocument();
    }
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
    // An empty authoritative balance projection must not fabricate rows.
    const balances = screen.getByRole('region', { name: 'Member balances' });
    expect(await within(balances).findByRole('status')).toBeInTheDocument();
    expect(within(balances).queryByRole('list')).not.toBeInTheDocument();
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
    // Read-only means no owner actions in the panel either.
    expect(
      within(panel).queryByRole('button', { name: /from details$/ }),
    ).toBeNull();
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
  it('filters on the server, pages past 100 with dedupe, and preserves a draft', async () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      transaction({
        id: `40000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
        description: `Shared entry ${index}`,
        visibility: 'HOUSEHOLD',
        kind: 'INCOME',
        money: { amount: '1.00', currency: 'BRL' },
      }),
    );
    first[0] = { ...first[0]!, version: 2 };
    const older = transaction({
      id: '40000000-0000-4000-8000-000000001000',
      description: 'Older shared expense',
      visibility: 'HOUSEHOLD',
    });
    const { calls } = renderSection({
      accountsGet: () => accountPage([account()]),
      transactionsGet: (view, visibility, offset) => {
        if (view === 'HOUSEHOLD') return transactionPage([]);
        if (visibility === 'HOUSEHOLD') {
          return jsonResponse({
            items:
              offset === 100
                ? [
                    {
                      ...first[0]!,
                      version: 1,
                      description: 'Stale duplicate',
                    },
                    older,
                  ]
                : first,
            limit: 100,
            offset,
            hasMore: offset === 0,
          });
        }
        return transactionPage([]);
      },
    });
    await screen.findByText('No transactions yet.');
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Keep my draft' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Shared by me' }));
    expect(await screen.findByText('Shared entry 99')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Load more transactions' }),
    );
    expect(await screen.findByText('Older shared expense')).toBeInTheDocument();
    expect(
      within(
        screen.getByRole('list', { name: 'Your transactions' }),
      ).getAllByRole('listitem'),
    ).toHaveLength(101);
    expect(screen.getByText('Shared entry 0')).toBeInTheDocument();
    expect(screen.queryByText('Stale duplicate')).toBeNull();
    expect(screen.getByLabelText('Description')).toHaveValue('Keep my draft');
    expect(
      calls.some(({ url }) =>
        url.includes('offset=100&view=OWN&status=ALL&visibility=HOUSEHOLD'),
      ),
    ).toBe(true);
    expect(
      screen.queryByRole('button', { name: 'Load more transactions' }),
    ).toBeNull();
    // Rendering a full 100-row page beside the older match is the behavior
    // under test; it needs headroom under a loaded parallel run.
  }, 15000);

  it('retries a failed household page without discarding loaded rows or changing offset', async () => {
    let attempts = 0;
    const { calls } = renderSection({
      transactionsGet: (view, _visibility, offset) => {
        if (view === 'OWN') return transactionPage([]);
        if (offset === 0)
          return jsonResponse({
            items: [sharedByOther()],
            limit: 100,
            offset: 0,
            hasMore: true,
          });
        attempts++;
        return attempts === 1
          ? jsonResponse({ code: 'FINANCE_BUSY', message: 'Busy.' }, 503)
          : jsonResponse({
              items: [
                {
                  ...sharedByOther(),
                  id: '40000000-0000-4000-8000-000000000099',
                  description: 'Older shared bill',
                },
              ],
              limit: 100,
              offset: 100,
              hasMore: false,
            });
      },
    });
    await screen.findByText('No transactions yet.');
    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));
    await screen.findByText('Shared internet bill');
    fireEvent.click(
      screen.getByRole('button', { name: 'Load more transactions' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Retry next page' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Shared internet bill')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry next page' }));
    expect(await screen.findByText('Older shared bill')).toBeInTheDocument();
    expect(
      calls.filter(({ url }) => url.includes('offset=100&view=HOUSEHOLD')),
    ).toHaveLength(2);
  });

  it('navigates an older refund to its authorized source by ID, never through a visibility patch', async () => {
    const refund = transaction({
      id: REFUND_ID,
      kind: 'REFUND',
      money: { amount: '2.00', currency: 'BRL' },
      refundOfTransactionId: EXPENSE_ID,
      description: 'Old refund',
      visibility: 'HOUSEHOLD',
    });
    const { calls } = renderSection({
      transactionsGet: () => transactionPage([refund]),
      transactionGet: (id) =>
        jsonResponse(
          id === EXPENSE_ID
            ? transaction({
                visibility: 'HOUSEHOLD',
                description: 'Older source',
              })
            : refund,
        ),
    });
    await screen.findByText('Old refund');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Old refund' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Details for Old refund',
    });
    fireEvent.click(
      within(panel).getByRole('button', { name: 'View source expense' }),
    );
    expect(
      await screen.findByRole('group', { name: 'Details for Older source' }),
    ).toBeInTheDocument();
    expect(
      calls.some(({ url }) => url.endsWith(`/transactions/${EXPENSE_ID}`)),
    ).toBe(true);
    expect(patchCalls(calls)).toHaveLength(0);
  });

  it('keeps the refund visible when its source detail is no longer authorized', async () => {
    const refund = transaction({
      id: REFUND_ID,
      kind: 'REFUND',
      money: { amount: '2.00', currency: 'BRL' },
      refundOfTransactionId: EXPENSE_ID,
      description: 'Visible refund',
      visibility: 'HOUSEHOLD',
    });
    renderSection({
      transactionsGet: () => transactionPage([refund]),
      transactionGet: (id) =>
        id === EXPENSE_ID
          ? jsonResponse(
              { code: 'TRANSACTION_NOT_FOUND', message: 'Unavailable.' },
              404,
            )
          : jsonResponse(refund),
    });
    await screen.findByText('Visible refund');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Visible refund' }),
    );
    fireEvent.click(
      within(
        await screen.findByRole('group', {
          name: 'Details for Visible refund',
        }),
      ).getByRole('button', { name: 'View source expense' }),
    );
    expect(
      await screen.findByText(/This transaction is no longer available to you/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Details for Visible refund' }),
    ).toBeInTheDocument();
  });

  it('offers the owner routes to the existing actions on an off-page source expense', async () => {
    const refund = transaction({
      id: REFUND_ID,
      kind: 'REFUND',
      money: { amount: '2.00', currency: 'BRL' },
      refundOfTransactionId: EXPENSE_ID,
      description: 'Old refund',
      visibility: 'HOUSEHOLD',
    });
    const source = transaction({
      id: EXPENSE_ID,
      description: 'Older source',
      visibility: 'HOUSEHOLD',
    });
    const { calls } = renderSection({
      transactionsGet: () => transactionPage([refund]),
      transactionGet: (id) => jsonResponse(id === EXPENSE_ID ? source : refund),
    });
    await screen.findByText('Old refund');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Old refund' }),
    );
    const refundPanel = await screen.findByRole('group', {
      name: 'Details for Old refund',
    });
    // A refund never carries a visibility action of its own: the whole group
    // follows the source expense, so only its details are offered here.
    expect(
      within(refundPanel).queryByRole('button', { name: /from details$/ }),
    ).toBeNull();
    fireEvent.click(
      within(refundPanel).getByRole('button', { name: 'View source expense' }),
    );
    const sourcePanel = await screen.findByRole('group', {
      name: 'Details for Older source',
    });
    // The source has no row on the loaded page, so the panel itself carries
    // the owner's existing share and allocation routes.
    expect(
      screen.queryByRole('button', { name: 'Make Older source private' }),
    ).toBeNull();
    expect(
      within(sourcePanel).getByRole('button', {
        name: 'Make Older source private from details',
      }),
    ).toBeEnabled();
    const allocationTrigger = within(sourcePanel).getByRole('button', {
      name: 'Allocation for Older source from details',
    });
    fireEvent.click(allocationTrigger);
    expect(
      await screen.findByRole('group', {
        name: 'Allocation for Older source',
      }),
    ).toBeInTheDocument();
    expect(patchCalls(calls)).toHaveLength(0);
  });

  it('makes an off-page source expense private from its details without a refund patch', async () => {
    const refund = transaction({
      id: REFUND_ID,
      kind: 'REFUND',
      money: { amount: '2.00', currency: 'BRL' },
      refundOfTransactionId: EXPENSE_ID,
      description: 'Old refund',
      visibility: 'HOUSEHOLD',
    });
    const source = transaction({
      id: EXPENSE_ID,
      description: 'Older source',
      visibility: 'HOUSEHOLD',
    });
    const { calls } = renderSection({
      transactionsGet: () => transactionPage([refund]),
      transactionGet: (id) => jsonResponse(id === EXPENSE_ID ? source : refund),
      transactionsPatch: (id) =>
        id === EXPENSE_ID
          ? jsonResponse({ ...source, visibility: 'PRIVATE', version: 1 })
          : jsonResponse(refund),
    });
    await screen.findByText('Old refund');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Old refund' }),
    );
    fireEvent.click(
      within(
        await screen.findByRole('group', { name: 'Details for Old refund' }),
      ).getByRole('button', { name: 'View source expense' }),
    );
    const sourcePanel = await screen.findByRole('group', {
      name: 'Details for Older source',
    });
    fireEvent.click(
      within(sourcePanel).getByRole('button', {
        name: 'Make Older source private from details',
      }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Make private' }),
    );
    expect(
      await screen.findByText(
        'This entry is private again. Members lose access on their next refresh; information already read is not retracted.',
      ),
    ).toBeInTheDocument();
    // The versioned patch targets the source expense, never the refund.
    const patches = patchCalls(calls);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.url).toContain(`/transactions/${EXPENSE_ID}`);
    expect(JSON.parse(String(patches[0]?.init?.body))).toEqual({
      expectedVersion: 0,
      visibility: 'PRIVATE',
    });
  });

  it('ignores a late failed old page after changing the owner filter', async () => {
    let failOldPage!: (response: Response) => void;
    const stale = new Promise<Response>((resolve) => {
      failOldPage = resolve;
    });
    const { calls } = renderSection({
      transactionsGet: (_view, visibility, offset) => {
        if (visibility === 'PRIVATE' && offset === 100) return stale;
        if (visibility === 'PRIVATE')
          return jsonResponse({
            items: [transaction({ description: 'Private first page' })],
            limit: 100,
            offset: 0,
            hasMore: true,
          });
        if (visibility === 'HOUSEHOLD')
          return transactionPage([
            transaction({
              description: 'Shared first page',
              visibility: 'HOUSEHOLD',
            }),
          ]);
        return transactionPage([]);
      },
    });
    await screen.findByText('No transactions yet.');
    fireEvent.click(screen.getByRole('radio', { name: 'Private' }));
    await screen.findByText('Private first page');
    fireEvent.click(
      screen.getByRole('button', { name: 'Load more transactions' }),
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Shared by me' }));
    await screen.findByText('Shared first page');
    await act(async () => {
      failOldPage(
        jsonResponse({ code: 'FINANCE_BUSY', message: 'Busy.' }, 503),
      );
    });
    expect(
      screen.queryByRole('button', { name: 'Retry next page' }),
    ).toBeNull();
    expect(screen.queryByText('Private first page')).toBeNull();
    expect(calls.some(({ url }) => url.includes('visibility=PRIVATE'))).toBe(
      true,
    );
  });

  it('keeps an authorized open detail when it is absent from the filtered first page', async () => {
    let detailReads = 0;
    renderSection({
      transactionsGet: (_view, visibility) =>
        visibility === 'HOUSEHOLD'
          ? transactionPage([])
          : transactionPage([transaction()]),
      transactionGet: () => {
        detailReads++;
        return jsonResponse(transaction());
      },
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    await screen.findByRole('group', { name: 'Details for Groceries' });
    fireEvent.click(screen.getByRole('radio', { name: 'Shared by me' }));
    await screen.findByText('No transactions yet.');
    expect(
      screen.getByRole('group', { name: 'Details for Groceries' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(detailReads).toBeGreaterThanOrEqual(2));
  });

  it('clears loaded pages on a later-page access loss', async () => {
    const { onHouseholdAccessChanged } = renderSection({
      transactionsGet: (_view, _visibility, offset) =>
        offset === 0
          ? jsonResponse({
              items: [transaction()],
              limit: 100,
              offset: 0,
              hasMore: true,
            })
          : jsonResponse(
              { code: 'HOUSEHOLD_NOT_FOUND', message: 'Unavailable.' },
              404,
            ),
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Load more transactions' }),
    );
    await waitFor(() =>
      expect(onHouseholdAccessChanged).toHaveBeenCalledTimes(1),
    );
    expect(screen.queryByText('Groceries')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Load more transactions' }),
    ).toBeNull();
  });

  it('keeps the chosen visibility control enabled and focused through a deferred load', async () => {
    let resolvePrivate!: (page: Response) => void;
    const { calls } = renderSection({
      transactionsGet: (_view, visibility) =>
        visibility === 'PRIVATE'
          ? new Promise<Response>((resolve) => {
              resolvePrivate = resolve;
            })
          : transactionPage([]),
    });
    await screen.findByText('No transactions yet.');
    const privateRadio = screen.getByRole('radio', { name: 'Private' });
    privateRadio.focus();
    expect(privateRadio).toHaveFocus();
    // Space on a focused radio selects it in a browser; jsdom delivers that
    // selection as the click activation React's onChange handles, so this is
    // the keyboard path without the browser's own key handling.
    fireEvent.click(privateRadio);
    expect(privateRadio).toBeChecked();
    // jsdom never moves focus off a control it just disabled, so pin the
    // property that keeps it in a real browser: the radio stays enabled while
    // its own scoped load is in flight.
    expect(privateRadio).not.toBeDisabled();
    expect(privateRadio).toHaveFocus();
    // A different scope chosen during that load is still refused: the pending
    // page already answers for "Private", and no second request starts.
    const allRadio = screen.getByRole('radio', { name: 'All' });
    allRadio.focus();
    fireEvent.click(allRadio);
    expect(privateRadio).toBeChecked();
    expect(allRadio).not.toBeDisabled();
    expect(allRadio).toHaveFocus();
    expect(
      calls.filter(({ url }) => url.includes('visibility=PRIVATE')),
    ).toHaveLength(1);
    await act(async () => {
      resolvePrivate(
        jsonResponse({
          items: [
            transaction({ description: 'Private only', visibility: 'PRIVATE' }),
          ],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
      );
    });
    expect(await screen.findByText('Private only')).toBeInTheDocument();
    expect(privateRadio).toBeChecked();
    expect(privateRadio).not.toBeDisabled();
    expect(allRadio).toHaveFocus();
    // The settled group is operable from where the user left it: the next
    // activation switches scope for real.
    const unfilteredBefore = calls.filter(({ url }) =>
      url.endsWith('view=OWN&status=ALL'),
    ).length;
    fireEvent.click(allRadio);
    expect(allRadio).toBeChecked();
    await waitFor(() =>
      expect(
        calls.filter(({ url }) => url.endsWith('view=OWN&status=ALL')).length,
      ).toBe(unfilteredBefore + 1),
    );
  });

  it('keeps the chosen feed control enabled and focused through a deferred load', async () => {
    let resolveHousehold!: (page: Response) => void;
    const { calls } = renderSection({
      transactionsGet: (view) =>
        view === 'HOUSEHOLD'
          ? new Promise<Response>((resolve) => {
              resolveHousehold = resolve;
            })
          : transactionPage([]),
    });
    await screen.findByText('No transactions yet.');
    const householdRadio = screen.getByRole('radio', {
      name: 'Household feed',
    });
    householdRadio.focus();
    fireEvent.click(householdRadio);
    expect(householdRadio).toBeChecked();
    expect(householdRadio).not.toBeDisabled();
    expect(householdRadio).toHaveFocus();
    const ownRadio = screen.getByRole('radio', { name: 'My transactions' });
    fireEvent.click(ownRadio);
    expect(householdRadio).toBeChecked();
    expect(
      calls.filter(({ url }) => url.endsWith('view=HOUSEHOLD&status=ALL')),
    ).toHaveLength(1);
    await act(async () => {
      resolveHousehold(
        jsonResponse({
          items: [sharedByOther()],
          limit: 100,
          offset: 0,
          hasMore: false,
        }),
      );
    });
    expect(await screen.findByText('Shared internet bill')).toBeInTheDocument();
    expect(householdRadio).toBeChecked();
    expect(householdRadio).not.toBeDisabled();
    expect(ownRadio).not.toBeDisabled();
  });

  it('reaches the next page from a pager above the list, not behind every row', async () => {
    const rows = Array.from({ length: 100 }, (_, index) =>
      transaction({
        id: `40000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
        description: `Own entry ${index}`,
      }),
    );
    const { calls, container } = renderSection({
      transactionsGet: (_view, _visibility, offset) =>
        offset === 0
          ? jsonResponse({ items: rows, limit: 100, offset: 0, hasMore: true })
          : jsonResponse({
              items: [
                transaction({
                  id: '40000000-0000-4000-8000-000000000999',
                  description: 'Older own expense',
                }),
              ],
              limit: 100,
              offset: 100,
              hasMore: false,
            }),
    });
    await screen.findByText('Own entry 99');
    // The order the browser derives its sequential focus from.
    const focusable = [
      ...container.querySelectorAll<HTMLElement>(
        'button, a[href], input, select, textarea',
      ),
    ].filter(
      (element) => !element.hasAttribute('disabled') && element.tabIndex >= 0,
    );
    const firstRow = screen.getByRole('button', {
      name: 'Details for Own entry 0',
    });
    const topPager = screen.getByRole('button', {
      name: 'Load more transactions (top of list)',
    });
    const bottomPager = screen.getByRole('button', {
      name: 'Load more transactions',
    });
    // The early pager precedes row actions; the late pager follows all rows.
    expect(focusable.indexOf(topPager)).toBeLessThan(
      focusable.indexOf(firstRow),
    );
    expect(focusable.indexOf(bottomPager)).toBeGreaterThan(
      focusable.indexOf(
        screen.getByRole('button', { name: 'Details for Own entry 99' }),
      ),
    );
    topPager.focus();
    expect(topPager).toHaveFocus();
    // Enter or Space on a focused button activates it in a browser; jsdom
    // delivers that activation as the click React's onClick handles.
    fireEvent.click(topPager);
    expect(await screen.findByText('Older own expense')).toBeInTheDocument();
    expect(
      calls.filter(({ url }) => url.includes('offset=100&view=OWN')),
    ).toHaveLength(1);
    // The last page leaves no pager behind: no control is offered for a state
    // that has nothing more to load.
    expect(
      screen.queryByRole('button', {
        name: 'Load more transactions (top of list)',
      }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Load more transactions' }),
    ).toBeNull();
  });

  it('loads one page at a time from the top pager, preserves focus and retries failures', async () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      transaction({
        id: `40000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
        description: `Page one entry ${index}`,
      }),
    );
    const second = Array.from({ length: 100 }, (_, index) =>
      transaction({
        id: `40000000-0000-4000-8000-${String(index + 200).padStart(12, '0')}`,
        description: `Page two entry ${index}`,
      }),
    );
    const pending: { resolve: (page: Response) => void }[] = [];
    const { calls } = renderSection({
      transactionsGet: (_view, _visibility, offset) =>
        offset === 0
          ? jsonResponse({ items: first, limit: 100, offset: 0, hasMore: true })
          : new Promise<Response>((resolve) => pending.push({ resolve })),
    });
    await screen.findByText('Page one entry 99');
    const topPager = screen.getByRole('button', {
      name: 'Load more transactions (top of list)',
    });
    // Enter or Space on a focused button activates it in a browser; jsdom
    // delivers that activation as the click React's onClick handles.
    topPager.focus();
    fireEvent.click(topPager);
    const pageRequests = (offset: number) =>
      calls.filter(({ url }) => url.includes(`offset=${offset}&view=OWN`))
        .length;
    expect(pageRequests(100)).toBe(1);
    // While that request is in flight the control reports the state, keeps the
    // user's focus, and a repeated activation cannot start a second request.
    expect(topPager).toHaveAttribute('aria-disabled', 'true');
    expect(topPager).toHaveTextContent('Loading more…');
    expect(topPager).toHaveFocus();
    fireEvent.click(topPager);
    expect(pageRequests(100)).toBe(1);
    await act(async () => {
      pending[0]?.resolve(
        jsonResponse({ code: 'FINANCE_BUSY', message: 'Busy.' }, 503),
      );
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not load the next page. Try again. Already loaded transactions remain available.',
    );
    expect(screen.getByText('Page one entry 99')).toBeInTheDocument();
    expect(topPager).toHaveFocus();
    expect(topPager).toHaveTextContent('Retry next page');
    expect(topPager).not.toHaveAttribute('aria-disabled');
    fireEvent.click(topPager);
    expect(pageRequests(100)).toBe(2);
    await act(async () => {
      pending[1]?.resolve(
        jsonResponse({ items: second, limit: 100, offset: 100, hasMore: true }),
      );
    });
    expect(await screen.findByText('Page two entry 99')).toBeInTheDocument();
    expect(topPager).not.toHaveAttribute('aria-disabled');
    expect(topPager).toHaveTextContent('Load more transactions');
    expect(topPager).toHaveFocus();
    fireEvent.click(topPager);
    expect(pageRequests(200)).toBe(1);
    await act(async () => {
      pending[2]?.resolve(
        jsonResponse({ code: 'FINANCE_BUSY', message: 'Busy.' }, 503),
      );
    });
    expect(topPager).toHaveFocus();
    expect(topPager).toHaveTextContent('Retry next page');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not load the next page. Try again.',
    );
    fireEvent.click(topPager);
    expect(pageRequests(200)).toBe(2);
    // Reproduce a frame that runs before React commits the pager removal.
    // A focus handoff cannot depend on the timing of this callback.
    const animationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    await act(async () => {
      pending[3]?.resolve(
        jsonResponse({
          items: Array.from({ length: 26 }, (_, index) =>
            transaction({
              id: `40000000-0000-4000-8000-${String(index + 300).padStart(12, '0')}`,
              description: `Final page entry ${index}`,
            }),
          ),
          limit: 100,
          offset: 200,
          hasMore: false,
        }),
      );
    });
    animationFrame.mockRestore();
    expect(screen.getByText('Final page entry 25')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: 'Load more transactions (top of list)',
      }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Load more transactions' }),
    ).toBeNull();
    expect(
      screen.getByRole('radio', { name: 'My transactions' }),
    ).toHaveFocus();
  });

  it('does not move focus after a deferred final page when the user left the pager', async () => {
    let resolveLast!: (page: Response) => void;
    const first = Array.from({ length: 100 }, (_, index) =>
      transaction({
        id: `40000000-0000-4000-8000-${String(index + 400).padStart(12, '0')}`,
        description: `Current entry ${index}`,
      }),
    );
    renderSection({
      transactionsGet: (_view, _visibility, offset) =>
        offset === 0
          ? jsonResponse({ items: first, limit: 100, offset: 0, hasMore: true })
          : new Promise<Response>((resolve) => {
              resolveLast = resolve;
            }),
    });
    await screen.findByText('Current entry 99');
    const bottomPager = screen.getByRole('button', {
      name: 'Load more transactions',
    });
    bottomPager.focus();
    fireEvent.click(bottomPager);
    expect(bottomPager).toHaveFocus();
    const firstRow = screen.getByRole('button', {
      name: 'Details for Current entry 0',
    });
    firstRow.focus();
    await act(async () => {
      resolveLast(
        jsonResponse({
          items: [transaction({ id: '40000000-0000-4000-8000-000000000999' })],
          limit: 100,
          offset: 100,
          hasMore: false,
        }),
      );
    });
    expect(
      screen.queryByRole('button', { name: 'Load more transactions' }),
    ).toBeNull();
    expect(firstRow).toHaveFocus();
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
    // The own feed restarts at page one on the view change, so the row's
    // Share action returns only after that reload settles.
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Share Groceries with the household',
      }),
    );
    const feedGets = (view: 'OWN' | 'HOUSEHOLD') =>
      calls.filter(({ url }) => url.endsWith(`view=${view}&status=ALL`)).length;
    const ownGetsBeforeShare = feedGets('OWN');
    const householdGetsBeforeShare = feedGets('HOUSEHOLD');
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
      expect(feedGets('OWN')).toBe(ownGetsBeforeShare + 1);
      expect(feedGets('HOUSEHOLD')).toBe(householdGetsBeforeShare + 1);
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
      method: 'EQUAL',
      refundPolicy: 'EQUAL_V1',
      impact: {
        cumulativeRefundAmount: { amount: '0.00', currency: 'USD' },
        payerCredit: { amount: '10.00', currency: 'USD' },
        participants: [
          {
            userId: ACTOR_ID,
            cumulativeRefundShare: { amount: '0.00', currency: 'USD' },
            remainingObligation: { amount: '3.34', currency: 'USD' },
          },
          {
            userId: MEMBER_B,
            cumulativeRefundShare: { amount: '0.00', currency: 'USD' },
            remainingObligation: { amount: '3.33', currency: 'USD' },
          },
          {
            userId: MEMBER_C,
            cumulativeRefundShare: { amount: '0.00', currency: 'USD' },
            remainingObligation: { amount: '3.33', currency: 'USD' },
          },
        ],
      },
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

  it('refreshes all-time balances once for an externally changed allocated expense, not for unchanged or older pages', async () => {
    const otherId = '40000000-0000-4000-8000-000000000009';
    let version = 1;
    let otherVersion = 1;
    let balanceAmount = '6.66';
    const { calls } = renderSection({
      transactionsGet: () =>
        transactionPage([
          householdExpense({ version }),
          transaction({
            id: otherId,
            kind: 'INCOME',
            description: 'Other',
            money: { amount: '10.00', currency: 'USD' },
            visibility: 'HOUSEHOLD',
            version: otherVersion,
          }),
        ]),
      allocationsGet: (id) =>
        id === EXPENSE_ID
          ? jsonResponse(activeAllocation({ transactionVersion: version }))
          : allocationNotFound(),
      balancesGet: () =>
        jsonResponse({
          currencies: [
            {
              currency: 'USD',
              balances: [
                {
                  userId: ACTOR_ID,
                  membershipStatus: 'CURRENT',
                  amount: balanceAmount,
                },
                {
                  userId: MEMBER_B,
                  membershipStatus: 'CURRENT',
                  amount: balanceAmount === '6.66' ? '-6.66' : '-5.66',
                },
              ],
            },
          ],
        }),
    });
    const balances = screen.getByRole('region', { name: 'Member balances' });
    await within(balances).findByText('6.66 USD');
    await screen.findByText('Groceries');
    await waitFor(() =>
      expect(
        calls.filter(({ url }) => url.endsWith(`${EXPENSE_ID}/allocation`)),
      ).toHaveLength(1),
    );
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Unrelated draft' },
    });
    const refreshFeed = async (view: 'Household feed' | 'My transactions') => {
      const count = calls.filter(
        ({ url }) =>
          url.includes('view=OWN&status=ALL') ||
          url.includes('view=HOUSEHOLD&status=ALL'),
      ).length;
      fireEvent.click(screen.getByRole('radio', { name: view }));
      await waitFor(() =>
        expect(
          calls.filter(
            ({ url }) =>
              url.includes('view=OWN&status=ALL') ||
              url.includes('view=HOUSEHOLD&status=ALL'),
          ).length,
        ).toBeGreaterThan(count),
      );
      await waitFor(() =>
        expect(screen.getByRole('radio', { name: view })).toBeEnabled(),
      );
    };
    await refreshFeed('Household feed');
    expect(balanceCalls(calls)).toHaveLength(1);
    // Changing an unrelated income does not invalidate this allocation.
    otherVersion = 2;
    await refreshFeed('My transactions');
    expect(balanceCalls(calls)).toHaveLength(1);
    balanceAmount = '5.66';
    version = 2;
    await refreshFeed('Household feed');
    await within(balances).findByText('5.66 USD');
    expect(within(balances).queryByText('6.66 USD')).toBeNull();
    expect(balanceCalls(calls)).toHaveLength(2);
    expect(screen.getByLabelText('Description')).toHaveValue('Unrelated draft');
    await refreshFeed('My transactions');
    expect(balanceCalls(calls)).toHaveLength(2);
    version = 1;
    await refreshFeed('Household feed');
    expect(balanceCalls(calls)).toHaveLength(2);
  });

  it('coalesces two known expenses changed in one authorized feed commit into one balances refresh', async () => {
    const otherId = '40000000-0000-4000-8000-000000000009';
    let version = 1;
    const { calls } = renderSection({
      transactionsGet: () =>
        transactionPage([
          householdExpense({ version }),
          householdExpense({
            id: otherId,
            description: 'Other expense',
            version,
          }),
        ]),
      allocationsGet: (id) =>
        jsonResponse(
          activeAllocation({
            transactionId: id,
            transactionVersion: version,
          }),
        ),
    });
    await screen.findByText('Groceries');
    await screen.findByText('Other expense');
    await waitFor(() =>
      expect(screen.getAllByText('Allocated')).toHaveLength(2),
    );
    expect(balanceCalls(calls)).toHaveLength(1);
    version = 2;
    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));
    await waitFor(() => expect(balanceCalls(calls)).toHaveLength(2));
    await waitFor(() =>
      expect(
        calls.filter(({ url }) => url.endsWith('/allocation')),
      ).toHaveLength(4),
    );
    expect(balanceCalls(calls)).toHaveLength(2);
  });

  it('does not refresh balances for a version advance before an allocation is first known', async () => {
    let version = 1;
    let reads = 0;
    let finishInitial: ((response: Response) => void) | undefined;
    const { calls } = renderSection({
      transactionsGet: () => transactionPage([householdExpense({ version })]),
      allocationsGet: () => {
        reads += 1;
        if (reads === 1)
          return new Promise<Response>((resolve) => {
            finishInitial = resolve;
          });
        return jsonResponse(activeAllocation({ transactionVersion: version }));
      },
    });
    await screen.findByText('Groceries');
    await waitFor(() => expect(finishInitial).toBeDefined());
    expect(balanceCalls(calls)).toHaveLength(1);
    version = 2;
    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));
    await waitFor(() => expect(reads).toBe(2));
    await screen.findByText('Allocated');
    expect(balanceCalls(calls)).toHaveLength(1);
    await act(async () => {
      finishInitial!(jsonResponse(activeAllocation({ transactionVersion: 1 })));
    });
    expect(screen.getByText('Allocated')).toBeInTheDocument();
    expect(balanceCalls(calls)).toHaveLength(1);
  });

  it('refreshes again for a newer external refund while the previous allocation and balances reads are pending', async () => {
    let version = 1;
    let allocationReads = 0;
    let balanceReads = 0;
    let finishOldAllocation: ((response: Response) => void) | undefined;
    let finishOldBalances: ((response: Response) => void) | undefined;
    const balanceResponse = (amount: string) =>
      jsonResponse({
        currencies: [
          {
            currency: 'USD',
            balances: [
              { userId: ACTOR_ID, membershipStatus: 'CURRENT', amount },
              {
                userId: MEMBER_B,
                membershipStatus: 'CURRENT',
                amount: `-${amount}`,
              },
            ],
          },
        ],
      });
    const { calls } = renderSection({
      transactionsGet: () => transactionPage([householdExpense({ version })]),
      allocationsGet: () => {
        allocationReads += 1;
        if (allocationReads === 3)
          return new Promise<Response>((resolve) => {
            finishOldAllocation = resolve;
          });
        if (allocationReads === 4)
          return jsonResponse(
            activeAllocation({
              transactionVersion: 3,
              impact: {
                cumulativeRefundAmount: { amount: '3.00', currency: 'USD' },
                payerCredit: { amount: '7.00', currency: 'USD' },
                participants: [
                  {
                    userId: ACTOR_ID,
                    cumulativeRefundShare: { amount: '1.00', currency: 'USD' },
                    remainingObligation: { amount: '2.34', currency: 'USD' },
                  },
                  {
                    userId: MEMBER_B,
                    cumulativeRefundShare: { amount: '1.00', currency: 'USD' },
                    remainingObligation: { amount: '2.33', currency: 'USD' },
                  },
                  {
                    userId: MEMBER_C,
                    cumulativeRefundShare: { amount: '1.00', currency: 'USD' },
                    remainingObligation: { amount: '2.33', currency: 'USD' },
                  },
                ],
              },
            }),
          );
        return jsonResponse(activeAllocation());
      },
      balancesGet: () => {
        balanceReads += 1;
        if (balanceReads === 2)
          return new Promise<Response>((resolve) => {
            finishOldBalances = resolve;
          });
        return balanceResponse(balanceReads === 1 ? '6.66' : '4.66');
      },
    });
    const balances = screen.getByRole('region', { name: 'Member balances' });
    await within(balances).findByText('6.66 USD');
    await screen.findByText('Allocated');
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await within(panel).findByText(/Cumulative posted refunds: 0.00 USD/);
    expect(allocationReads).toBe(2);
    expect(balanceReads).toBe(1);

    version = 2;
    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));
    await waitFor(() => expect(finishOldAllocation).toBeDefined());
    await waitFor(() => expect(finishOldBalances).toBeDefined());
    expect(
      within(panel).queryByText(/Cumulative posted refunds: 0.00 USD/),
    ).toBeNull();
    version = 3;
    fireEvent.click(screen.getByRole('radio', { name: 'My transactions' }));
    await waitFor(() => expect(allocationReads).toBe(4));
    await within(balances).findByText('4.66 USD');
    await within(panel).findByText(/Cumulative posted refunds: 3.00 USD/);
    expect(balanceCalls(calls)).toHaveLength(3);

    await act(async () => {
      finishOldAllocation!(
        jsonResponse(activeAllocation({ transactionVersion: 2 })),
      );
      finishOldBalances!(balanceResponse('5.34'));
    });
    expect(within(balances).getByText('4.66 USD')).toBeInTheDocument();
    expect(within(balances).queryByText('5.34 USD')).toBeNull();
    expect(
      within(panel).getByText(/Cumulative posted refunds: 3.00 USD/),
    ).toBeInTheDocument();
    expect(
      within(panel).queryByText(/Cumulative posted refunds: 0.00 USD/),
    ).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));
    await waitFor(() =>
      expect(
        screen.getByRole('radio', { name: 'My transactions' }),
      ).toBeEnabled(),
    );
    version = 2;
    fireEvent.click(screen.getByRole('radio', { name: 'My transactions' }));
    await waitFor(() =>
      expect(
        screen.getByRole('radio', { name: 'Household feed' }),
      ).toBeEnabled(),
    );
    expect(balanceCalls(calls)).toHaveLength(3);
    expect(allocationReads).toBe(4);
  });

  it('reconciles cached refund impact on a newer background feed without probing unchanged rows', async () => {
    const otherId = '40000000-0000-4000-8000-000000000009';
    let expenseVersion = 1;
    let allocationReads = 0;
    let finishRefresh: ((response: Response) => void) | undefined;
    const { calls } = renderSection({
      transactionsGet: () =>
        transactionPage([
          householdExpense({ version: expenseVersion }),
          householdExpense({ id: otherId, description: 'Other', version: 1 }),
        ]),
      transactionGet: (id) =>
        jsonResponse(householdExpense({ id, version: expenseVersion })),
      allocationsGet: (id) => {
        if (id === otherId) return allocationNotFound();
        allocationReads += 1;
        if (allocationReads === 3)
          return new Promise<Response>((resolve) => {
            finishRefresh = resolve;
          });
        return jsonResponse(activeAllocation());
      },
    });
    await screen.findByText('Groceries');
    await waitFor(() =>
      expect(
        calls.filter(({ url }) => url.endsWith(`${otherId}/allocation`)),
      ).toHaveLength(1),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await within(panel).findByText(/Cumulative posted refunds: 0.00 USD/);
    expenseVersion = 2;
    await waitFor(() =>
      expect(
        screen.getByRole('radio', { name: 'Household feed' }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));
    await waitFor(() => expect(finishRefresh).toBeDefined());
    expect(
      within(panel).queryByText(/Cumulative posted refunds: 0.00 USD/),
    ).toBeNull();
    expect(
      calls.filter(({ url }) => url.endsWith(`${otherId}/allocation`)),
    ).toHaveLength(1);
    await act(async () => {
      finishRefresh!(
        jsonResponse(
          activeAllocation({
            transactionVersion: 2,
            impact: {
              cumulativeRefundAmount: { amount: '2.00', currency: 'USD' },
              payerCredit: { amount: '8.00', currency: 'USD' },
              participants: [
                {
                  userId: ACTOR_ID,
                  cumulativeRefundShare: { amount: '0.68', currency: 'USD' },
                  remainingObligation: { amount: '2.66', currency: 'USD' },
                },
                {
                  userId: MEMBER_B,
                  cumulativeRefundShare: { amount: '0.66', currency: 'USD' },
                  remainingObligation: { amount: '2.67', currency: 'USD' },
                },
                {
                  userId: MEMBER_C,
                  cumulativeRefundShare: { amount: '0.66', currency: 'USD' },
                  remainingObligation: { amount: '2.67', currency: 'USD' },
                },
              ],
            },
          }),
        ),
      );
    });
    expect(
      within(panel).getByText(/Cumulative posted refunds: 2.00 USD/),
    ).toBeInTheDocument();
    expenseVersion = 1;
    fireEvent.click(screen.getByRole('radio', { name: 'My transactions' }));
    await waitFor(() =>
      expect(
        calls.filter(({ url }) => url.includes('view=OWN&status=ALL')),
      ).toHaveLength(2),
    );
    expect(
      within(panel).getByText(/Cumulative posted refunds: 2.00 USD/),
    ).toBeInTheDocument();
    expect(
      calls.filter(({ url }) => url.endsWith(`${EXPENSE_ID}/allocation`)),
    ).toHaveLength(3);
  });

  it('rechecks a cached none only after a newer expense version reveals an external allocation', async () => {
    const otherId = '40000000-0000-4000-8000-000000000009';
    let version = 1;
    let created = false;
    const { calls } = renderSection({
      transactionsGet: () =>
        transactionPage([
          householdExpense({ version }),
          householdExpense({ id: otherId, description: 'Other', version: 1 }),
        ]),
      allocationsGet: (id) =>
        id === EXPENSE_ID && created
          ? jsonResponse(activeAllocation({ transactionVersion: 2 }))
          : allocationNotFound(),
      balancesGet: () =>
        jsonResponse(
          created
            ? {
                currencies: [
                  {
                    currency: 'USD',
                    balances: [
                      {
                        userId: ACTOR_ID,
                        membershipStatus: 'CURRENT',
                        amount: '6.66',
                      },
                      {
                        userId: MEMBER_B,
                        membershipStatus: 'CURRENT',
                        amount: '-6.66',
                      },
                    ],
                  },
                ],
              }
            : { currencies: [] },
        ),
    });
    await screen.findByText('Groceries');
    const reads = (id: string) =>
      calls.filter(({ url }) => url.endsWith(`${id}/allocation`)).length;
    await waitFor(() => expect(reads(EXPENSE_ID)).toBe(1));
    await waitFor(() => expect(reads(otherId)).toBe(1));
    const balances = screen.getByRole('region', { name: 'Member balances' });
    await within(balances).findByRole('status');
    expect(balanceCalls(calls)).toHaveLength(1);
    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));
    await waitFor(() =>
      expect(
        screen.getByRole('radio', { name: 'My transactions' }),
      ).toBeEnabled(),
    );
    expect(reads(EXPENSE_ID)).toBe(1);
    expect(balanceCalls(calls)).toHaveLength(1);
    created = true;
    version = 2;
    fireEvent.click(screen.getByRole('radio', { name: 'My transactions' }));
    await waitFor(() => expect(reads(EXPENSE_ID)).toBe(2));
    expect(reads(otherId)).toBe(1);
    expect(await screen.findByText('Allocated')).toBeInTheDocument();
    await within(balances).findByText('6.66 USD');
    expect(balanceCalls(calls)).toHaveLength(2);
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await within(panel).findByText(/Cumulative posted refunds: 0.00 USD/);
    expect(
      within(panel).queryByRole('button', { name: 'Create allocation' }),
    ).toBeNull();
  });

  it('refreshes balances after a newer source revokes its active allocation even when the impact probe returns 404', async () => {
    let version = 1;
    const { calls } = renderSection({
      transactionsGet: () => transactionPage([householdExpense({ version })]),
      allocationsGet: () =>
        version === 1 ? jsonResponse(activeAllocation()) : allocationNotFound(),
      balancesGet: () =>
        jsonResponse(
          version === 1
            ? {
                currencies: [
                  {
                    currency: 'USD',
                    balances: [
                      {
                        userId: ACTOR_ID,
                        membershipStatus: 'CURRENT',
                        amount: '6.66',
                      },
                      {
                        userId: MEMBER_B,
                        membershipStatus: 'CURRENT',
                        amount: '-6.66',
                      },
                    ],
                  },
                ],
              }
            : { currencies: [] },
        ),
    });
    const balances = screen.getByRole('region', { name: 'Member balances' });
    await within(balances).findByText('6.66 USD');
    await screen.findByText('Groceries');
    await screen.findByText('Allocated');
    await waitFor(() =>
      expect(
        calls.filter(({ url }) => url.endsWith(`${EXPENSE_ID}/allocation`)),
      ).toHaveLength(1),
    );
    version = 2;
    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));
    await within(balances).findByRole('status');
    expect(balanceCalls(calls)).toHaveLength(2);
    await waitFor(() =>
      expect(
        calls.filter(({ url }) => url.endsWith(`${EXPENSE_ID}/allocation`)),
      ).toHaveLength(2),
    );
  });

  it('reconciles an authorized off-page source detail without restoring impact from a late read', async () => {
    const refund = transaction({
      id: REFUND_ID,
      kind: 'REFUND',
      money: { amount: '2.00', currency: 'USD' },
      refundOfTransactionId: EXPENSE_ID,
      description: 'Old refund',
      visibility: 'HOUSEHOLD',
    });
    let version = 1;
    let reads = 0;
    let releaseOld: ((response: Response) => void) | undefined;
    const { calls } = renderSection({
      transactionsGet: () => transactionPage([refund]),
      transactionGet: (id) =>
        jsonResponse(
          id === EXPENSE_ID
            ? householdExpense({ description: 'Older source', version })
            : refund,
        ),
      allocationsGet: (id) => {
        if (id !== EXPENSE_ID) throw new Error('off-page source only');
        reads += 1;
        if (reads === 2)
          return new Promise<Response>((resolve) => {
            releaseOld = resolve;
          });
        if (reads === 3)
          return jsonResponse(
            { code: 'NETWORK_ERROR', message: 'Could not check allocation.' },
            503,
          );
        return jsonResponse(activeAllocation({ transactionVersion: version }));
      },
    });
    await screen.findByText('Old refund');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Old refund' }),
    );
    fireEvent.click(
      within(
        await screen.findByRole('group', { name: 'Details for Old refund' }),
      ).getByRole('button', { name: 'View source expense' }),
    );
    const sourcePanel = await screen.findByRole('group', {
      name: 'Details for Older source',
    });
    await within(sourcePanel).findByRole('region', {
      name: 'Current refund impact',
    });
    expect(reads).toBe(1);
    version = 2;
    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));
    await waitFor(() => expect(releaseOld).toBeDefined());
    expect(
      within(sourcePanel).queryByRole('region', {
        name: 'Current refund impact',
      }),
    ).toBeNull();
    version = 3;
    fireEvent.click(screen.getByRole('radio', { name: 'My transactions' }));
    await waitFor(() => expect(reads).toBe(3));
    await act(async () => {
      releaseOld!(jsonResponse(activeAllocation({ transactionVersion: 2 })));
    });
    expect(
      within(sourcePanel).queryByRole('region', {
        name: 'Current refund impact',
      }),
    ).toBeNull();
    expect(
      within(sourcePanel).getByText('3', { selector: 'dd' }),
    ).toBeInTheDocument();
    expect(
      calls.filter(({ url }) => url.endsWith(`${EXPENSE_ID}/allocation`)),
    ).toHaveLength(3);
    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));
    await waitFor(() =>
      expect(
        calls.filter(({ url }) => url.includes('view=HOUSEHOLD&status=ALL')),
      ).toHaveLength(2),
    );
    expect(reads).toBe(3);
    version = 4;
    fireEvent.click(screen.getByRole('radio', { name: 'My transactions' }));
    await waitFor(() => expect(reads).toBe(4));
    await within(sourcePanel).findByRole('region', {
      name: 'Current refund impact',
    });
    expect(
      within(sourcePanel).getByText('4', { selector: 'dd' }),
    ).toBeInTheDocument();
  });

  it('drops revoked impact, leaves failed refetch unknown, and retries on the next feed commit', async () => {
    let version = 1;
    let response: Response = jsonResponse(activeAllocation());
    let reads = 0;
    const { calls } = renderSection({
      transactionsGet: () => transactionPage([householdExpense({ version })]),
      transactionGet: () => jsonResponse(householdExpense({ version })),
      allocationsGet: () => {
        reads += 1;
        return response;
      },
    });
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Groceries' }),
    );
    await screen.findByRole('group', { name: 'Details for Groceries' });
    await screen.findByRole('region', { name: 'Current refund impact' });
    version = 2;
    response = jsonResponse(
      { code: 'NETWORK_ERROR', message: 'Could not check allocation.' },
      503,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));
    await waitFor(() => expect(reads).toBe(2));
    expect(
      screen.queryByRole('region', { name: 'Current refund impact' }),
    ).toBeNull();
    expect(screen.getByText('2', { selector: 'dd' })).toBeInTheDocument();
    version = 3;
    response = allocationNotFound();
    fireEvent.click(screen.getByRole('radio', { name: 'My transactions' }));
    await waitFor(() => expect(reads).toBe(3));
    expect(
      screen.queryByRole('region', { name: 'Current refund impact' }),
    ).toBeNull();
    expect(
      calls.filter(({ url }) => url.endsWith(`${EXPENSE_ID}/allocation`)),
    ).toHaveLength(3);
  });

  it('ignores a delayed older allocation response after a newer feed projection', async () => {
    let version = 1;
    let read = 0;
    let releaseOld: ((response: Response) => void) | undefined;
    const { calls } = renderSection({
      transactionsGet: () => transactionPage([householdExpense({ version })]),
      allocationsGet: () => {
        read += 1;
        if (read === 1)
          return new Promise<Response>((resolve) => {
            releaseOld = resolve;
          });
        return jsonResponse(activeAllocation({ transactionVersion: 2 }));
      },
    });
    await screen.findByText('Groceries');
    await waitFor(() => expect(releaseOld).toBeDefined());
    version = 2;
    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));
    await waitFor(() => expect(read).toBe(2));
    await act(async () => {
      releaseOld!(jsonResponse(activeAllocation({ transactionVersion: 1 })));
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await within(panel).findByText(/Cumulative posted refunds: 0.00 USD/);
    expect(within(panel).getByText(/2 — informational/)).toBeInTheDocument();
    expect(
      calls.filter(({ url }) => url.endsWith(`${EXPENSE_ID}/allocation`)),
    ).toHaveLength(3);
  });

  it('clears scoped impact on refresh 401 and ignores a late earlier read', async () => {
    let version = 1;
    let read = 0;
    let releaseOld: ((response: Response) => void) | undefined;
    const { onSessionExpired } = renderSection({
      transactionsGet: () => transactionPage([householdExpense({ version })]),
      allocationsGet: () => {
        read += 1;
        if (read === 1)
          return new Promise<Response>((resolve) => {
            releaseOld = resolve;
          });
        if (read === 3)
          return jsonResponse(
            { code: 'UNAUTHENTICATED', message: 'Signed out.' },
            401,
          );
        return jsonResponse(activeAllocation());
      },
    });
    await screen.findByText('Groceries');
    await waitFor(() => expect(releaseOld).toBeDefined());
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await within(panel).findByText(/Cumulative posted refunds: 0.00 USD/);
    version = 2;
    fireEvent.click(screen.getByRole('radio', { name: 'Household feed' }));
    await waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
    await act(async () => {
      releaseOld!(jsonResponse(activeAllocation()));
    });
    expect(
      screen.queryByRole('group', { name: 'Allocation for Groceries' }),
    ).toBeNull();
    expect(
      screen.queryByRole('region', { name: 'Current refund impact' }),
    ).toBeNull();
  });

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
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Preview current allocation' }),
    );
    await within(panel).findByText(/Server preview for expense version 0/);
  });

  it.each(['EQUAL', 'EXACT'] as const)(
    'keeps the %s preview focused through deferred failure and retry without duplicate requests',
    async (method) => {
      const pending: Array<(response: Response) => void> = [];
      const calls = renderSection({
        transactionsGet: () => transactionPage([householdExpense()]),
        allocationsGet: () => allocationNotFound(),
        membersGet: () => jsonResponse({ members: ROSTER }),
        allocationsPreview: () =>
          new Promise<Response>((resolve) => {
            pending.push(resolve);
          }),
      }).calls;
      await screen.findByText('Groceries');
      fireEvent.click(
        screen.getByRole('button', { name: 'Allocation for Groceries' }),
      );
      const panel = await screen.findByRole('group', {
        name: 'Allocation for Groceries',
      });
      await within(panel).findByRole('checkbox', {
        name: `${ACTOR_EMAIL} — you (payer) ${ACTOR_ID}`,
      });
      if (method === 'EXACT') {
        fireEvent.click(
          within(panel).getByRole('radio', { name: 'Exact amounts' }),
        );
        for (const member of ROSTER) {
          fireEvent.change(
            within(panel).getByRole('textbox', {
              name: `Exact share for ${member.email} (USD; zero allowed)`,
            }),
            {
              target: { value: member.userId === ACTOR_ID ? '10.00' : '0.00' },
            },
          );
        }
      }
      const previewCalls = () =>
        calls.filter(({ url }) => url.endsWith('/allocation/preview'));
      const resultBody = {
        transactionId: EXPENSE_ID,
        transactionVersion: 0,
        method,
        refundPolicy: method === 'EQUAL' ? 'EQUAL_V1' : 'EXACT_JEFFERSON_V1',
        originalAmount: { amount: '10.00', currency: 'USD' },
        participants: ROSTER.map((member) => ({
          userId: member.userId,
          share: {
            amount: member.userId === ACTOR_ID ? '10.00' : '0.00',
            currency: 'USD',
          },
        })),
        impact: {
          cumulativeRefundAmount: { amount: '0.00', currency: 'USD' },
          payerCredit: { amount: '10.00', currency: 'USD' },
          participants: ROSTER.map((member) => ({
            userId: member.userId,
            cumulativeRefundShare: { amount: '0.00', currency: 'USD' },
            remainingObligation: {
              amount: member.userId === ACTOR_ID ? '10.00' : '0.00',
              currency: 'USD',
            },
          })),
        },
      };
      const preview = within(panel).getByRole('button', {
        name: 'Preview current allocation',
      });
      preview.focus();
      fireEvent.keyDown(preview, { key: 'Enter' });
      fireEvent.click(preview);
      await waitFor(() => expect(previewCalls()).toHaveLength(1));
      const loading = within(panel).getByRole('button', {
        name: 'Previewing…',
      });
      expect(loading).toHaveFocus();
      expect(loading).toHaveAttribute('aria-disabled', 'true');
      expect(loading).toBeEnabled();
      expect(
        within(panel).getByRole('button', { name: 'Create allocation' }),
      ).toBeDisabled();
      // A second Enter activation while pending must not start another POST.
      fireEvent.keyDown(loading, { key: 'Enter' });
      fireEvent.click(loading);
      expect(previewCalls()).toHaveLength(1);
      await act(async () => {
        pending[0]!(
          jsonResponse(
            { code: 'PREVIEW_UNAVAILABLE', message: 'Try again.' },
            503,
          ),
        );
      });
      expect(preview).toHaveFocus();
      expect(preview).toHaveTextContent('Preview current allocation');
      expect(
        within(panel).getByRole('button', { name: 'Create allocation' }),
      ).toBeDisabled();

      fireEvent.click(preview);
      await waitFor(() => expect(previewCalls()).toHaveLength(2));
      expect(preview).toHaveFocus();
      await act(async () => {
        pending[1]!(jsonResponse(resultBody));
      });
      expect(preview).toHaveFocus();
      expect(
        within(panel).getByRole('button', { name: 'Create allocation' }),
      ).toBeEnabled();

      fireEvent.click(preview);
      await waitFor(() => expect(previewCalls()).toHaveLength(3));
      expect(
        within(panel).getByRole('button', { name: 'Create allocation' }),
      ).toBeDisabled();
      const cancel = within(panel).getByRole('button', { name: 'Cancel' });
      cancel.focus();
      await act(async () => {
        pending[2]!(jsonResponse(resultBody));
      });
      expect(cancel).toHaveFocus();
      expect(preview).not.toHaveFocus();
      expect(
        within(panel).getByRole('button', { name: 'Create allocation' }),
      ).toBeEnabled();
    },
  );

  it('ignores a late preview after closing and reopening the split panel', async () => {
    let finishPreview: ((response: Response) => void) | undefined;
    const calls = renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => allocationNotFound(),
      membersGet: () => jsonResponse({ members: ROSTER }),
      allocationsPreview: () =>
        new Promise<Response>((resolve) => {
          finishPreview = resolve;
        }),
    }).calls;
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await within(panel).findByRole('checkbox', {
      name: `${ACTOR_EMAIL} — you (payer) ${ACTOR_ID}`,
    });
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Preview current allocation' }),
    );
    await waitFor(() =>
      expect(
        calls.filter(({ url }) => url.endsWith('/allocation/preview')),
      ).toHaveLength(1),
    );
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const reopened = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await within(reopened).findByRole('checkbox', {
      name: `${ACTOR_EMAIL} — you (payer) ${ACTOR_ID}`,
    });
    await act(async () => {
      finishPreview!(
        jsonResponse({ code: 'FAILED', message: 'Stale preview' }, 503),
      );
    });
    expect(within(reopened).queryByText('Stale preview')).toBeNull();
    expect(
      within(reopened).getByRole('button', {
        name: 'Preview current allocation',
      }),
    ).toBeEnabled();
    expect(
      within(reopened).getByRole('button', { name: 'Create allocation' }),
    ).toBeDisabled();
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
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Preview current allocation' }),
    );
    await within(panel).findByText(/Server preview for expense version 0/);
    // Omitting the payer invalidates the previous server preview.
    fireEvent.click(
      within(panel).getByRole('checkbox', {
        name: `${ACTOR_EMAIL} — you (payer) ${ACTOR_ID}`,
      }),
    );
    expect(
      within(panel).queryByText(/Server preview for expense version/),
    ).toBeNull();
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
    expect(
      within(panel).getByRole('button', { name: 'Preview current allocation' }),
    ).toBeDisabled();
    expect(
      within(panel).getByRole('button', { name: 'Create allocation' }),
    ).toBeDisabled();
    expect(allocationPostCalls(calls)).toHaveLength(0);
  });

  it('sends exact shares only after preview and invalidates them on amount change', async () => {
    const exactShares = [
      { userId: ACTOR_ID, share: { amount: '7.00', currency: 'USD' } },
      { userId: MEMBER_B, share: { amount: '3.00', currency: 'USD' } },
    ];
    const impact = {
      cumulativeRefundAmount: { amount: '1.00', currency: 'USD' },
      payerCredit: { amount: '9.00', currency: 'USD' },
      participants: [
        {
          userId: ACTOR_ID,
          cumulativeRefundShare: { amount: '0.70', currency: 'USD' },
          remainingObligation: { amount: '6.30', currency: 'USD' },
        },
        {
          userId: MEMBER_B,
          cumulativeRefundShare: { amount: '0.30', currency: 'USD' },
          remainingObligation: { amount: '2.70', currency: 'USD' },
        },
      ],
    };
    const calls = renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => allocationNotFound(),
      membersGet: () => jsonResponse({ members: ROSTER }),
      allocationsPreview: () =>
        jsonResponse({
          transactionId: EXPENSE_ID,
          transactionVersion: 0,
          method: 'EXACT',
          refundPolicy: 'EXACT_JEFFERSON_V1',
          originalAmount: { amount: '10.00', currency: 'USD' },
          participants: exactShares,
          impact,
        }),
      allocationsPost: () =>
        jsonResponse(
          activeAllocation({
            method: 'EXACT',
            refundPolicy: 'EXACT_JEFFERSON_V1',
            participants: exactShares,
            impact,
          }),
          201,
        ),
    }).calls;
    await screen.findByText('Groceries');
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const panel = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await within(panel).findByRole('checkbox', {
      name: `${MEMBER_C_EMAIL} ${MEMBER_C}`,
    });
    fireEvent.click(
      within(panel).getByRole('radio', { name: 'Exact amounts' }),
    );
    const memberCCheckbox = within(panel).getByRole('checkbox', {
      name: `${MEMBER_C_EMAIL} ${MEMBER_C}`,
    });
    expect(memberCCheckbox).toBeChecked();
    fireEvent.click(memberCCheckbox);
    expect(memberCCheckbox).not.toBeChecked();
    expect(
      within(panel).queryByRole('textbox', {
        name: `Exact share for ${MEMBER_C_EMAIL} (USD; zero allowed)`,
      }),
    ).toBeNull();
    expect(
      within(panel).getByRole('checkbox', {
        name: `${ACTOR_EMAIL} — you (payer) ${ACTOR_ID}`,
      }),
    ).toBeChecked();
    const payerInput = within(panel).getByRole('textbox', {
      name: `Exact share for ${ACTOR_EMAIL} (USD; zero allowed)`,
    });
    const memberInput = within(panel).getByRole('textbox', {
      name: `Exact share for ${MEMBER_B_EMAIL} (USD; zero allowed)`,
    });
    expect(payerInput).toBeEnabled();
    expect(memberInput).toBeEnabled();
    fireEvent.change(payerInput, { target: { value: '7.00' } });
    fireEvent.change(memberInput, { target: { value: '2.99' } });
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Preview current allocation' }),
    );
    expect(
      await within(panel).findByText(/Shares must total exactly 10.00 USD/),
    ).toBeInTheDocument();
    const fieldError = within(panel).getByText(
      /Shares must total exactly 10.00 USD/,
    );
    expect(fieldError.id).toBe(`finance-allocation-field-error-${EXPENSE_ID}`);
    expect(memberInput).toHaveAttribute('aria-describedby', fieldError.id);
    expect(
      calls.filter(({ url }) => url.endsWith('/allocation/preview')),
    ).toHaveLength(0);
    fireEvent.change(memberInput, { target: { value: '3.00' } });
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Preview current allocation' }),
    );
    expect(
      await within(panel).findByText(/Highest-averages rounding/),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(/remaining cost 6.30 USD/),
    ).toBeInTheDocument();
    fireEvent.change(memberInput, { target: { value: '3.01' } });
    expect(
      within(panel).getByRole('button', { name: 'Create allocation' }),
    ).toBeDisabled();
    fireEvent.change(memberInput, { target: { value: '3.00' } });
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Preview current allocation' }),
    );
    await within(panel).findByText(/Server preview for expense version 0/);
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Create allocation' }),
    );
    await waitFor(() => expect(allocationPostCalls(calls)).toHaveLength(1));
    expect(
      JSON.parse(String(allocationPostCalls(calls)[0]?.init?.body)),
    ).toEqual({
      expectedVersion: 0,
      participantShares: exactShares,
    });
  });

  it('blocks creation when a concurrent refund makes preview stale', async () => {
    const calls = renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => allocationNotFound(),
      membersGet: () => jsonResponse({ members: ROSTER }),
      allocationsPreview: () =>
        jsonResponse(
          {
            code: 'RESOURCE_VERSION_CONFLICT',
            message: 'The expense changed.',
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
    await within(panel).findByRole('checkbox', {
      name: `${ACTOR_EMAIL} — you (payer) ${ACTOR_ID}`,
    });
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Preview current allocation' }),
    );
    expect(
      await within(panel).findByText(
        /expense, refund group, or allocation changed/,
      ),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole('button', { name: 'Create allocation' }),
    ).toBeDisabled();
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
      within(panel).getByRole('button', { name: 'Preview current allocation' }),
    );
    await within(panel).findByText(/Server preview for expense version 0/);
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
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Preview current allocation' }),
    );
    await within(panel).findByText(/Server preview for expense version 0/);
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
      within(panel).getByRole('button', { name: 'Preview current allocation' }),
    );
    await within(panel).findByText(/Server preview for expense version 0/);
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
      within(panel).getByRole('button', { name: 'Preview current allocation' }),
    );
    await within(panel).findByText(/Server preview for expense version 0/);
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
            impact: null,
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
      within(panel).getByRole('button', { name: 'Preview current allocation' }),
    );
    await within(panel).findByText(/Server preview for expense version 0/);
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
      within(panel).getByRole('button', { name: 'Preview current allocation' }),
    );
    await within(panel).findByText(/Server preview for expense version 0/);
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
            impact: {
              cumulativeRefundAmount: { amount: '0.00', currency: 'BRL' },
              payerCredit: { amount: '89.90', currency: 'BRL' },
              participants: [
                {
                  userId: '22222222-3333-4444-8555-666666666666',
                  cumulativeRefundShare: { amount: '0.00', currency: 'BRL' },
                  remainingObligation: { amount: '89.90', currency: 'BRL' },
                },
              ],
            },
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
    await screen.findByText('Allocated');
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
      within(panel).getByRole('button', { name: 'Preview current allocation' }),
    );
    await within(panel).findByText(/Server preview for expense version 0/);
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
      within(panel).getByRole('button', { name: 'Preview current allocation' }),
    );
    await within(panel).findByText(/Server preview for expense version 0/);
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
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Preview current allocation' }),
    );
    await within(panel).findByText(/Server preview for expense version 0/);
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
      within(panel).getByRole('button', { name: 'Preview current allocation' }),
    );
    await within(panel).findByText(/Server preview for expense version 0/);
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
      within(panel).getByRole('button', { name: 'Preview current allocation' }),
    );
    await within(panel).findByText(/Server preview for expense version 0/);
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
      within(panel).getByRole('button', { name: 'Preview current allocation' }),
    );
    await within(panel).findByText(/Server preview for expense version 0/);
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
      within(panel).getByRole('button', { name: 'Preview current allocation' }),
    );
    await within(panel).findByText(/Server preview for expense version 0/);
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
      within(panel).getByRole('button', { name: 'Preview current allocation' }),
    );
    await within(panel).findByText(/Server preview for expense version 0/);
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
    expect(
      within(panel).getByRole('button', { name: 'Preview current allocation' }),
    ).toBeEnabled();
  });

  it('refetches the roster each time the allocation creation form opens', async () => {
    let currentMembers = ROSTER;
    renderSection({
      transactionsGet: () => transactionPage([householdExpense()]),
      allocationsGet: () => allocationNotFound(),
      membersGet: () => jsonResponse({ members: currentMembers }),
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
    // Escape closes the panel and clears the roster snapshot.
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(
      screen.queryByRole('group', { name: 'Allocation for Groceries' }),
    ).toBeNull();
    currentMembers = ROSTER.slice(0, 2);
    // Reopening refetches the roster instead of reusing the old snapshot.
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocation for Groceries' }),
    );
    const reopened = await screen.findByRole('group', {
      name: 'Allocation for Groceries',
    });
    await waitFor(() =>
      expect(within(reopened).getAllByRole('checkbox')).toHaveLength(2),
    );
    expect(within(reopened).queryByText(MEMBER_C_EMAIL)).toBeNull();
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
    // The rejection is announced on the notice...
    const noticeText = screen.getByText(
      'Check the highlighted transaction details.',
    );
    const notice = noticeText.closest('[role="alert"]');
    expect(notice).not.toBeNull();
    // ...while focus lands on, and stays on, the rejected control rather
    // than the notice, even after the notice's own focus effects settle.
    await waitFor(() => expect(category).toHaveFocus());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(category).toHaveFocus();
    expect(notice).not.toHaveFocus();
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
