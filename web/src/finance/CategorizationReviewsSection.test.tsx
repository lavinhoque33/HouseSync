import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  CategorizationReview,
  CsrfToken,
  Household,
  Transaction,
  TransactionCategory,
} from '../auth/client';
import { CategorizationReviewsSection } from './CategorizationReviewsSection';

const CSRF: CsrfToken = { token: 'csrf-token-1', headerName: 'X-CSRF-TOKEN' };
const HOUSEHOLD: Household = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  name: 'Elm Street home',
  role: 'MEMBER',
  createdAt: '2026-09-13T01:30:00Z',
};
const OWNER_ID = '30000000-0000-4000-8000-000000000001';
const ACCOUNT_ID = '10000000-0000-4000-8000-000000000001';
const REVIEW_ID = '80000000-0000-4000-8000-000000000001';
const OTHER_REVIEW_ID = '80000000-0000-4000-8000-000000000002';
const TX_ID = '40000000-0000-4000-8000-000000000001';
const OTHER_TX_ID = '40000000-0000-4000-8000-000000000002';
const REVIEWS_BASE = `/api/households/${HOUSEHOLD.id}/categorization-reviews`;

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

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: TX_ID,
    householdId: HOUSEHOLD.id,
    ownerUserId: OWNER_ID,
    accountId: ACCOUNT_ID,
    kind: 'EXPENSE',
    money: { amount: '-12.34', currency: 'USD' },
    occurredOn: '2026-09-22',
    description: 'Corner Market',
    category: null,
    visibility: 'PRIVATE',
    source: 'CONNECTED',
    status: 'POSTED',
    refundOfTransactionId: null,
    version: 0,
    createdAt: '2026-09-22T11:00:00Z',
    updatedAt: '2026-09-22T11:00:00Z',
    ...overrides,
  };
}

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

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function page(
  items: CategorizationReview[],
  overrides: { openCount?: number; hasMore?: boolean } = {},
) {
  return jsonResponse({
    items,
    limit: 50,
    offset: 0,
    hasMore: overrides.hasMore ?? false,
    openCount: overrides.openCount ?? items.length,
  });
}

type Call = { url: string; init?: RequestInit | undefined };

interface RouteHandlers {
  listGet?: (
    view: string | null,
    offset: string,
    url: string,
  ) => Response | Promise<Response>;
  itemGet?: (reviewId: string) => Response | Promise<Response>;
  resolve?: (reviewId: string) => Response | Promise<Response>;
  csrfGet?: () => Response | Promise<Response>;
  aiStatusGet?: (url: string) => Response | Promise<Response>;
}

/** The documented disabled shape: no AI capability, nothing pending. */
function aiStatusDisabled() {
  return jsonResponse({ enabled: false, pendingCount: 0, failedCount: 0 });
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
      if (url.endsWith('/categorization-ai-work/status')) {
        // Owner-private AI counters; the default deployment has no AI.
        return routes.aiStatusGet?.(url) ?? aiStatusDisabled();
      }
      const reviewsIndex = url.indexOf('/categorization-reviews');
      if (reviewsIndex !== -1) {
        const rest = url.slice(reviewsIndex + '/categorization-reviews'.length);
        if (rest.endsWith('/resolve')) {
          const reviewId = decodeURIComponent(
            rest.slice(1, -'/resolve'.length),
          );
          if (!routes.resolve) throw new Error('unexpected resolve request');
          return routes.resolve(reviewId);
        }
        if (rest.startsWith('/')) {
          const reviewId = decodeURIComponent(rest.slice(1));
          if (!routes.itemGet) {
            throw new Error('unexpected review item request');
          }
          return routes.itemGet(reviewId);
        }
        const query = new URLSearchParams(rest.slice(1));
        return (
          routes.listGet?.(
            query.get('view'),
            query.get('offset') ?? '0',
            url,
          ) ?? page([])
        );
      }
      throw new Error(`unexpected fetch ${url} ${init?.method ?? ''}`);
    }),
  );
  return calls;
}

interface RenderOptions {
  authorityConfirmed?: boolean;
  categories?: TransactionCategory[] | null;
  refreshSignal?: number;
  scopeResetSignal?: number;
  csrf?: CsrfToken | null;
  household?: Household;
}

function renderSection(
  routes: RouteHandlers = {},
  options: RenderOptions = {},
) {
  const calls = stubFetch(routes);
  const onCsrfRefreshed = vi.fn();
  const onSessionExpired = vi.fn();
  const onHouseholdAccessChanged = vi.fn();
  const onTransactionChanged = vi.fn();
  const element = (overrides: RenderOptions = {}) => (
    <CategorizationReviewsSection
      household={overrides.household ?? options.household ?? HOUSEHOLD}
      csrf={overrides.csrf ?? options.csrf ?? CSRF}
      onCsrfRefreshed={onCsrfRefreshed}
      onSessionExpired={onSessionExpired}
      onHouseholdAccessChanged={onHouseholdAccessChanged}
      authorityConfirmed={
        overrides.authorityConfirmed ?? options.authorityConfirmed ?? true
      }
      categories={
        overrides.categories !== undefined
          ? overrides.categories
          : options.categories !== undefined
            ? options.categories
            : CATEGORIES
      }
      refreshSignal={overrides.refreshSignal ?? options.refreshSignal ?? 0}
      scopeResetSignal={
        overrides.scopeResetSignal ?? options.scopeResetSignal ?? 0
      }
      onTransactionChanged={onTransactionChanged}
    />
  );
  const view = render(element());
  return {
    calls,
    view,
    onCsrfRefreshed,
    onSessionExpired,
    onHouseholdAccessChanged,
    onTransactionChanged,
    rerender: (overrides: RenderOptions = {}) => {
      view.rerender(element(overrides));
    },
  };
}

function resolveCalls(calls: Call[]) {
  return calls.filter((call) => call.url.endsWith('/resolve'));
}

function bodyOf(call: Call | undefined): unknown {
  return JSON.parse(String(call?.init?.body));
}

function headerOf(call: Call | undefined, name: string): string | undefined {
  const headers = call?.init?.headers as
    Record<string, string> | undefined | Headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  return headers[name];
}

/** Opens the queue and the one suggestion it holds. */
async function openReviewDetail() {
  fireEvent.click(
    await screen.findByRole('button', { name: /Review suggested categories/ }),
  );
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Review the suggestion for Corner Market',
    }),
  );
}

describe('categorization review queue', () => {
  it('exposes one private entry point with the owner open count and loads no queue rows until opened', async () => {
    const { calls } = renderSection({
      listGet: () =>
        page(
          [
            review(),
            review({
              id: OTHER_REVIEW_ID,
              transaction: transaction({
                id: OTHER_TX_ID,
                description: 'Transit pass',
              }),
            }),
          ],
          { openCount: 2 },
        ),
    });

    expect(
      await screen.findByText('2 suggestions are waiting for your decision.'),
    ).toBeInTheDocument();
    const entry = screen.getByRole('button', {
      name: 'Review suggested categories (2 waiting)',
    });
    expect(entry).toHaveAttribute('aria-expanded', 'false');
    // The count comes from one owner-scoped page request, not one per row.
    const listCalls = calls.filter((call) => call.url.startsWith(REVIEWS_BASE));
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]?.url).toBe(
      `${REVIEWS_BASE}?limit=50&offset=0&view=OPEN`,
    );
    expect(screen.queryByText('Corner Market')).not.toBeInTheDocument();

    fireEvent.click(entry);
    expect(entry).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText('Corner Market')).toBeInTheDocument();
  });

  it('separates the recorded category from the suggestion and offers exactly the four decisions', async () => {
    const { calls } = renderSection({
      listGet: () => page([review()], { openCount: 1 }),
    });
    await openReviewDetail();

    const detail = screen.getByRole('group', {
      name: /Suggestion for “Corner Market”/,
    });
    expect(within(detail).getByText('Recorded category')).toBeInTheDocument();
    expect(
      within(detail).getByText(/this entry has no category yet/),
    ).toBeInTheDocument();
    expect(within(detail).getByText('Food shopping')).toBeInTheDocument();
    expect(
      within(detail).getByText('Merchant pattern matched'),
    ).toBeInTheDocument();
    expect(
      within(detail).getByText(/Built-in merchant match/),
    ).toBeInTheDocument();
    expect(
      within(detail).getByText(/fixed built-in list of recognized merchants/),
    ).toBeInTheDocument();
    expect(
      within(detail).getByText(/High confidence band/),
    ).toBeInTheDocument();
    // Confidence is explained as a band, never as certainty or a probability.
    expect(within(detail).getByText(/not certainty/)).toBeInTheDocument();

    const options = within(detail).getAllByRole('radio');
    expect(options).toHaveLength(4);
    expect(
      within(detail).getByRole('radio', {
        name: 'Accept the suggestion — Food shopping',
      }),
    ).toBeChecked();
    expect(
      within(detail).getByRole('radio', { name: 'Keep it uncategorized' }),
    ).toBeEnabled();
    expect(
      within(detail).getByRole('radio', {
        name: /Keep the recorded category/,
      }),
    ).toBeDisabled();
    // Nothing is applied by opening the queue.
    expect(resolveCalls(calls)).toHaveLength(0);
  });

  it('applies an accepted suggestion with both versions and converges the feed, list, and count', async () => {
    const resolved = review({
      status: 'ACCEPTED',
      version: 1,
      transaction: transaction({ category: 'GROCERIES', version: 1 }),
    });
    let listCalls = 0;
    const { calls, onTransactionChanged } = renderSection({
      listGet: () => {
        listCalls += 1;
        return listCalls === 1
          ? page([review()], { openCount: 1 })
          : page([], { openCount: 0 });
      },
      resolve: () => jsonResponse(resolved),
    });
    await openReviewDetail();

    fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));

    await waitFor(() => expect(resolveCalls(calls)).toHaveLength(1));
    const decision = resolveCalls(calls)[0];
    expect(decision?.init?.method).toBe('POST');
    expect(decision?.url).toBe(`${REVIEWS_BASE}/${REVIEW_ID}/resolve`);
    expect(bodyOf(decision)).toEqual({
      expectedVersion: 0,
      expectedTransactionVersion: 0,
      action: 'ACCEPT_SUGGESTION',
    });
    expect(headerOf(decision, 'Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(headerOf(decision, 'X-CSRF-TOKEN')).toBe('csrf-token-1');

    expect(
      await screen.findByText(
        /Decision saved\. Corner Market is now Food shopping/,
      ),
    ).toBeInTheDocument();
    expect(onTransactionChanged).toHaveBeenCalledWith(
      expect.objectContaining({ id: TX_ID, category: 'GROCERIES', version: 1 }),
    );
    // The waiting list and the private count converge on the committed state.
    expect(
      await screen.findByText('No suggestions are waiting for your decision.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: 'Review the suggestion for Corner Market',
      }),
    ).not.toBeInTheDocument();
    expect(listCalls).toBeGreaterThan(1);
  });

  it('never rewrites a preserved keep choice when a refresh makes it inapplicable', async () => {
    let listCalls = 0;
    const { calls, rerender } = renderSection({
      listGet: () => {
        listCalls += 1;
        return listCalls === 1
          ? page(
              [review({ transaction: transaction({ category: 'DINING' }) })],
              { openCount: 1 },
            )
          : page(
              [
                review({
                  version: 2,
                  evaluatedTransactionVersion: 1,
                  transaction: transaction({ category: null, version: 1 }),
                }),
              ],
              { openCount: 1 },
            );
      },
    });
    await openReviewDetail();

    fireEvent.click(
      screen.getByRole('radio', {
        name: 'Keep the recorded category — Dining',
      }),
    );

    // A background refresh reports that the entry no longer has a category.
    rerender({ refreshSignal: 1 });
    await waitFor(() =>
      expect(
        screen.getByRole('radio', {
          name: 'Keep the recorded category — Uncategorized',
        }),
      ).toBeDisabled(),
    );

    // The preserved decision is never silently turned into a different one:
    // the choice stays selected and an explicit new choice is required.
    expect(
      screen.getByRole('radio', {
        name: 'Keep the recorded category — Uncategorized',
      }),
    ).toBeChecked();
    expect(
      screen.getByRole('radio', {
        name: 'Accept the suggestion — Food shopping',
      }),
    ).not.toBeChecked();
    expect(
      screen.getByText(
        /this entry has no category to keep now\. Choose the decision you want/,
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This entry has no recorded category, so there is nothing to keep.',
    );
    expect(calls.filter((call) => call.url.endsWith('/resolve'))).toHaveLength(
      0,
    );
  });

  it('moves focus into the detail on open, back to the row on close, and onto the outcome notice after a resolution', async () => {
    const { calls } = renderSection({
      listGet: () => page([review()], { openCount: 1 }),
      resolve: () => jsonResponse(review({ status: 'KEPT', version: 1 })),
    });
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Review suggested categories/,
      }),
    );
    const trigger = screen.getByRole('button', {
      name: 'Review the suggestion for Corner Market',
    });
    fireEvent.click(trigger);
    const detail = screen.getByRole('group', {
      name: /Suggestion for “Corner Market”/,
    });
    await waitFor(() => expect(detail).toHaveFocus());

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', {
          name: 'Review the suggestion for Corner Market',
        }),
      ).toHaveFocus(),
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Review the suggestion for Corner Market',
      }),
    );
    fireEvent.click(
      screen.getByRole('radio', { name: 'Keep it uncategorized' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));
    await waitFor(() => expect(resolveCalls(calls)).toHaveLength(1));
    const notice = await screen.findByText(/Decision saved/);
    // The stable outcome notice owns focus after a resolution.
    await waitFor(() =>
      expect(notice.closest('[role="status"]')).toHaveFocus(),
    );
  });

  it('requires a taxonomy choice for a chosen category and sends exactly that decision', async () => {
    const { calls } = renderSection({
      listGet: () => page([review()], { openCount: 1 }),
      resolve: () =>
        jsonResponse(
          review({
            status: 'CHOSEN',
            version: 1,
            transaction: transaction({ category: 'DINING', version: 1 }),
          }),
        ),
    });
    await openReviewDetail();

    fireEvent.click(
      screen.getByRole('radio', { name: 'Choose a different category' }),
    );
    const select = screen.getByLabelText('Category for this decision');
    fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));
    expect(
      await screen.findByText('Choose a category for this decision.'),
    ).toBeInTheDocument();
    expect(resolveCalls(calls)).toHaveLength(0);
    await waitFor(() => expect(select).toHaveFocus());

    fireEvent.change(select, { target: { value: 'DINING' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));
    await waitFor(() => expect(resolveCalls(calls)).toHaveLength(1));
    expect(bodyOf(resolveCalls(calls)[0])).toEqual({
      expectedVersion: 0,
      expectedTransactionVersion: 0,
      action: 'CHOOSE_CATEGORY',
      category: 'DINING',
    });
  });

  it('sends the three-field keep-uncategorized decision for an entry with no category', async () => {
    const { calls } = renderSection({
      listGet: () => page([review()], { openCount: 1 }),
      resolve: () => jsonResponse(review({ status: 'KEPT', version: 1 })),
    });
    await openReviewDetail();

    fireEvent.click(
      screen.getByRole('radio', { name: 'Keep it uncategorized' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));

    await waitFor(() => expect(resolveCalls(calls)).toHaveLength(1));
    expect(bodyOf(resolveCalls(calls)[0])).toEqual({
      expectedVersion: 0,
      expectedTransactionVersion: 0,
      action: 'KEEP_UNCATEGORIZED',
    });
    expect(
      await screen.findByText(/your decision; automation will not replace it/),
    ).toBeInTheDocument();
  });

  it('offers keep-current only for an entry that has a category and preserves it on save', async () => {
    const categorized = review({
      transaction: transaction({ category: 'DINING' }),
    });
    const { calls } = renderSection({
      listGet: () => page([categorized], { openCount: 1 }),
      resolve: () =>
        jsonResponse(
          review({
            status: 'KEPT',
            version: 1,
            transaction: transaction({ category: 'DINING', version: 1 }),
          }),
        ),
    });
    await openReviewDetail();

    expect(
      screen.getByRole('radio', {
        name: 'Keep the recorded category — Dining',
      }),
    ).toBeEnabled();
    const keepUncategorized = screen.getByRole('radio', {
      name: 'Keep it uncategorized',
    });
    expect(keepUncategorized).toBeDisabled();
    expect(
      screen.getByText(
        'This entry already has a category, so it cannot be kept uncategorized.',
      ),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('radio', {
        name: 'Keep the recorded category — Dining',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));
    await waitFor(() => expect(resolveCalls(calls)).toHaveLength(1));
    expect(bodyOf(resolveCalls(calls)[0])).toEqual({
      expectedVersion: 0,
      expectedTransactionVersion: 0,
      action: 'KEEP_CURRENT',
    });
  });

  it('refetches a stale suggestion on a version conflict, keeps the chosen draft, and retries with the fresh versions', async () => {
    const fresh = review({
      version: 3,
      evaluatedTransactionVersion: 2,
      transaction: transaction({ version: 2 }),
    });
    const { calls } = renderSection({
      listGet: () => page([review()], { openCount: 1 }),
      itemGet: (reviewId) => {
        expect(reviewId).toBe(REVIEW_ID);
        return jsonResponse(fresh);
      },
      resolve: () =>
        jsonResponse(
          { code: 'RESOURCE_VERSION_CONFLICT', message: 'Changed.' },
          409,
        ),
    });
    await openReviewDetail();

    fireEvent.click(
      screen.getByRole('radio', { name: 'Choose a different category' }),
    );
    const select = screen.getByLabelText('Category for this decision');
    fireEvent.change(select, { target: { value: 'SHOPPING' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));

    expect(
      await screen.findByText(
        /changed on the server. The latest state was reloaded/,
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        calls.some((call) => call.url === `${REVIEWS_BASE}/${REVIEW_ID}`),
      ).toBe(true),
    );
    // The draft choice survives the conflict and the refetch, and the reloaded
    // versions are what the next decision is guarded by.
    expect(screen.getByLabelText('Category for this decision')).toHaveValue(
      'SHOPPING',
    );
    expect(screen.queryByText(/Decision saved/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));
    await waitFor(() => expect(resolveCalls(calls)).toHaveLength(2));
    expect(bodyOf(resolveCalls(calls)[1])).toEqual({
      expectedVersion: 3,
      expectedTransactionVersion: 2,
      action: 'CHOOSE_CATEGORY',
      category: 'SHOPPING',
    });
  });

  it('binds and focuses the affected control when the server rejects the decision', async () => {
    const { calls } = renderSection({
      listGet: () => page([review()], { openCount: 1 }),
      resolve: () =>
        jsonResponse(
          {
            code: 'VALIDATION_FAILED',
            message: 'The request was rejected.',
            fieldErrors: { category: 'Choose a supported category.' },
          },
          400,
        ),
    });
    await openReviewDetail();

    fireEvent.click(
      screen.getByRole('radio', { name: 'Choose a different category' }),
    );
    const select = screen.getByLabelText('Category for this decision');
    fireEvent.change(select, { target: { value: 'DINING' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));

    expect(
      await screen.findByText('Choose a supported category.'),
    ).toBeInTheDocument();
    expect(select).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(select).toHaveFocus());
    // The rejected choice is retained, so the owner fixes and resends it.
    expect(select).toHaveValue('DINING');
    expect(resolveCalls(calls)).toHaveLength(1);
  });

  it('retains the exact same-key decision on an unknown outcome and proves it with a same-key retry', async () => {
    let resolveAttempts = 0;
    const { calls } = renderSection({
      listGet: () => page([review()], { openCount: 1 }),
      resolve: () => {
        resolveAttempts += 1;
        if (resolveAttempts === 1) {
          throw new TypeError('Failed to fetch');
        }
        return jsonResponse(
          review({
            status: 'KEPT',
            version: 1,
            transaction: transaction({ version: 1 }),
          }),
        );
      },
    });
    await openReviewDetail();

    fireEvent.click(
      screen.getByRole('radio', { name: 'Keep it uncategorized' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));

    const pending = await screen.findByRole('group', {
      name: 'Unresolved category review decision',
    });
    expect(within(pending).getByText(/Corner Market/)).toBeInTheDocument();
    const first = resolveCalls(calls)[0];
    expect(headerOf(first, 'Idempotency-Key')).toBeTruthy();

    fireEvent.click(
      within(pending).getByRole('button', { name: 'Retry this decision' }),
    );
    await waitFor(() => expect(resolveAttempts).toBe(2));
    const retry = resolveCalls(calls)[1];
    expect(headerOf(retry, 'Idempotency-Key')).toBe(
      headerOf(first, 'Idempotency-Key'),
    );
    expect(bodyOf(retry)).toEqual(bodyOf(first));
    // The retained intent is only cleared by a known outcome.
    await waitFor(() =>
      expect(
        screen.queryByRole('group', {
          name: 'Unresolved category review decision',
        }),
      ).not.toBeInTheDocument(),
    );
    expect(await screen.findByText(/Decision saved/)).toBeInTheDocument();
  });

  it('never claims success or failure when a 200 response drifts from the contract', async () => {
    const { calls } = renderSection({
      listGet: () => page([review()], { openCount: 1 }),
      resolve: () =>
        jsonResponse(
          review({
            status: 'SETTLED' as CategorizationReview['status'],
          }),
        ),
    });
    await openReviewDetail();

    fireEvent.click(
      screen.getByRole('radio', { name: 'Keep it uncategorized' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));

    expect(
      await screen.findByRole('group', {
        name: 'Unresolved category review decision',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Decision saved/)).not.toBeInTheDocument();
    // The exact intent is retained for a same-key retry.
    expect(resolveCalls(calls)).toHaveLength(1);
    expect(
      await screen.findByText(
        /The decision has an unknown outcome\. Retry the exact same decision with its original key/,
      ),
    ).toBeInTheDocument();
  });

  it('closes the decision form honestly when a refresh reports the open suggestion as resolved', async () => {
    let listCalls = 0;
    const { rerender } = renderSection({
      listGet: () => {
        listCalls += 1;
        return listCalls === 1
          ? page([review()], { openCount: 1 })
          : page([], { openCount: 0 });
      },
      itemGet: () =>
        jsonResponse(
          review({
            status: 'KEPT',
            version: 3,
            transaction: transaction({ version: 2 }),
          }),
        ),
    });
    await openReviewDetail();
    expect(
      screen.getByRole('button', { name: 'Save decision' }),
    ).toBeInTheDocument();

    rerender({ refreshSignal: 1 });

    expect(
      await screen.findByText(
        /no longer waiting for review, so the decision form was closed/,
      ),
    ).toBeInTheDocument();
    // Nothing claims that this browser's decision is what resolved it.
    expect(
      screen.queryByText(/Your earlier decision is recorded/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Save decision' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('group', {
        name: /Suggestion for “Corner Market”/,
      }),
    ).not.toBeInTheDocument();
  });

  it('shows the current state without claiming an unproven outcome when the suggestion is no longer open', async () => {
    let resolveAttempts = 0;
    const decidedElsewhere = review({
      status: 'CHOSEN',
      version: 4,
      transaction: transaction({ category: 'DINING', version: 3 }),
    });
    const { calls } = renderSection({
      listGet: () => page([review()], { openCount: 1 }),
      itemGet: () => jsonResponse(decidedElsewhere),
      resolve: () => {
        resolveAttempts += 1;
        throw new TypeError('Failed to fetch');
      },
    });
    await openReviewDetail();

    fireEvent.click(
      screen.getByRole('radio', { name: 'Keep it uncategorized' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));
    const pending = await screen.findByRole('group', {
      name: 'Unresolved category review decision',
    });

    fireEvent.click(
      within(pending).getByRole('button', { name: 'Reload the queue' }),
    );

    expect(
      await screen.findByText(
        /no longer waiting for review, so it left the waiting list/,
      ),
    ).toBeInTheDocument();
    // The read cannot attribute that state to this intent, so nothing is
    // claimed and the retained decision stays available for the one proof.
    expect(
      screen.queryByText(/Your earlier decision is recorded/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('group', {
        name: 'Unresolved category review decision',
      }),
    ).toBeInTheDocument();
    // There is no open suggestion left to decide on.
    expect(
      screen.queryByRole('group', {
        name: /Suggestion for “Corner Market”/,
      }),
    ).not.toBeInTheDocument();
    expect(resolveAttempts).toBe(1);
    expect(calls.filter((call) => call.url.endsWith('/resolve'))).toHaveLength(
      1,
    );
  });

  it('drops every private row and ignores an in-flight response after a scope clear', async () => {
    const pending: { complete?: (response: Response) => void } = {};
    let listCalls = 0;
    const { rerender } = renderSection({
      listGet: () => {
        listCalls += 1;
        if (listCalls === 1) return page([review()], { openCount: 1 });
        return new Promise<Response>((resolve) => {
          pending.complete = resolve;
        });
      },
    });
    await openReviewDetail();
    expect(await screen.findByText('Corner Market')).toBeInTheDocument();

    // A reload is in flight when the scope is cleared.
    rerender({ refreshSignal: 1 });
    await waitFor(() => expect(listCalls).toBe(2));
    rerender({ scopeResetSignal: 1 });

    expect(screen.queryByText('Corner Market')).not.toBeInTheDocument();
    expect(screen.queryByText('Food shopping')).not.toBeInTheDocument();
    expect(
      screen.getByText('Your suggestions are not loaded.'),
    ).toBeInTheDocument();

    // The response that was already in flight is dropped with the scope: a
    // late answer can never publish private suggestions into a cleared panel.
    pending.complete?.(page([review()], { openCount: 4 }));
    await waitFor(() =>
      expect(screen.queryByText('Corner Market')).not.toBeInTheDocument(),
    );
    expect(
      screen.getByText('Your suggestions are not loaded.'),
    ).toBeInTheDocument();
  });

  it('treats an expired session on a decision as a session loss and clears the queue', async () => {
    const { onSessionExpired } = renderSection({
      listGet: () => page([review()], { openCount: 1 }),
      resolve: () =>
        jsonResponse({ code: 'UNAUTHENTICATED', message: 'Sign in.' }, 401),
    });
    await openReviewDetail();

    fireEvent.click(
      screen.getByRole('radio', { name: 'Keep it uncategorized' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));

    await waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Corner Market')).not.toBeInTheDocument();
    expect(screen.queryByText(/Food shopping/)).not.toBeInTheDocument();
  });

  it('reports lost household access instead of rendering an empty queue', async () => {
    const { onHouseholdAccessChanged } = renderSection({
      listGet: () =>
        jsonResponse({ code: 'HOUSEHOLD_NOT_FOUND', message: 'Gone.' }, 404),
    });

    await waitFor(() =>
      expect(onHouseholdAccessChanged).toHaveBeenCalledTimes(1),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.getByText('Your suggestions are not loaded.'),
    ).toBeInTheDocument();
  });

  it('drops a suggestion that is gone on resolve and reloads the queue without claiming success', async () => {
    let listCalls = 0;
    const { calls } = renderSection({
      listGet: () => {
        listCalls += 1;
        return listCalls === 1
          ? page([review()], { openCount: 1 })
          : page([], { openCount: 0 });
      },
      resolve: () =>
        jsonResponse(
          { code: 'CATEGORY_REVIEW_NOT_FOUND', message: 'Gone.' },
          404,
        ),
    });
    await openReviewDetail();

    fireEvent.click(
      screen.getByRole('radio', { name: 'Keep it uncategorized' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));

    expect(
      await screen.findByText(
        'That suggestion is no longer available to you. The queue was reloaded.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Decision saved/)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: 'Review the suggestion for Corner Market',
        }),
      ).not.toBeInTheDocument(),
    );
    expect(listCalls).toBeGreaterThan(1);
    expect(resolveCalls(calls)).toHaveLength(1);
  });

  it('treats the shared privacy-preserving 404 as an unavailable suggestion too', async () => {
    let listCalls = 0;
    const { calls } = renderSection({
      listGet: () => {
        listCalls += 1;
        return listCalls === 1
          ? page([review()], { openCount: 1 })
          : page([], { openCount: 0 });
      },
      resolve: () =>
        jsonResponse(
          { code: 'TRANSACTION_NOT_FOUND', message: 'Unavailable.' },
          404,
        ),
    });
    await openReviewDetail();

    fireEvent.click(
      screen.getByRole('radio', { name: 'Keep it uncategorized' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));

    expect(
      await screen.findByText(
        'That suggestion is no longer available to you. The queue was reloaded.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Decision saved/)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: 'Review the suggestion for Corner Market',
        }),
      ).not.toBeInTheDocument(),
    );
    expect(resolveCalls(calls)).toHaveLength(1);
  });

  it('lists resolved suggestions as history without offering a decision form', async () => {
    const { calls } = renderSection({
      listGet: (view) =>
        view === 'HISTORY'
          ? page(
              [
                review({
                  status: 'KEPT',
                  version: 1,
                  transaction: transaction({ category: 'DINING', version: 1 }),
                }),
              ],
              { openCount: 0 },
            )
          : page([review()], { openCount: 1 }),
    });
    await openReviewDetail();

    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));
    fireEvent.change(screen.getByLabelText('Show'), {
      target: { value: 'HISTORY' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(
      await screen.findByRole('button', {
        name: 'See the resolution for Corner Market',
      }),
    ).toBeInTheDocument();
    expect(calls.some((call) => call.url.includes('view=HISTORY'))).toBe(true);
    fireEvent.click(
      screen.getByRole('button', {
        name: 'See the resolution for Corner Market',
      }),
    );
    const detail = screen.getByRole('group', {
      name: /Suggestion for “Corner Market”/,
    });
    expect(
      within(detail).getByText(
        /This suggestion was resolved \(You kept your own decision for this entry\)/,
      ),
    ).toBeInTheDocument();
    expect(
      within(detail).queryByRole('button', { name: 'Save decision' }),
    ).not.toBeInTheDocument();
    expect(within(detail).queryAllByRole('radio')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(
      await screen.findByRole('button', {
        name: 'Review the suggestion for Corner Market',
      }),
    ).toBeInTheDocument();
  });

  it('converges the count on a parent refresh signal without discarding a chosen category draft', async () => {
    let listCalls = 0;
    const { rerender } = renderSection({
      listGet: () => {
        listCalls += 1;
        return listCalls === 1
          ? page([review()], { openCount: 1 })
          : page([review()], { openCount: 2 });
      },
    });
    await openReviewDetail();

    fireEvent.click(
      screen.getByRole('radio', { name: 'Choose a different category' }),
    );
    fireEvent.change(screen.getByLabelText('Category for this decision'), {
      target: { value: 'SHOPPING' },
    });

    rerender({ refreshSignal: 1 });

    expect(
      await screen.findByText('2 suggestions are waiting for your decision.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Category for this decision')).toHaveValue(
      'SHOPPING',
    );
    expect(listCalls).toBeGreaterThan(1);
  });
});

const AI_STATUS_URL = `/api/households/${HOUSEHOLD.id}/categorization-ai-work/status`;
const AI_REVIEW_ID = '80000000-0000-4000-8000-000000000009';

function aiStatusCalls(calls: Call[]) {
  return calls.filter((call) =>
    call.url.endsWith('/categorization-ai-work/status'),
  );
}

/** One settled AI suggestion, exactly as the owner-private queue shows it. */
function aiReview(): CategorizationReview {
  return review({
    id: AI_REVIEW_ID,
    transaction: transaction({ id: OTHER_TX_ID, description: 'Transit pass' }),
    source: 'AI',
    confidence: 'MEDIUM',
    reasonLabel: 'Model suggestion',
  });
}

describe('owner-visible AI work status', () => {
  it('announces pending AI work privately and converges the settled AI suggestion without losing a draft', async () => {
    let listCalls = 0;
    let statusCalls = 0;
    const firstStatus: { release?: (response: Response) => void } = {};
    const { calls } = renderSection({
      aiStatusGet: (url) => {
        expect(url).toBe(AI_STATUS_URL);
        statusCalls += 1;
        if (statusCalls === 1) {
          // Held until the owner's own decision is drafted below, so the
          // pending backlog and its bounded poll run under the fake clock.
          return new Promise<Response>((resolve) => {
            firstStatus.release = resolve;
          });
        }
        return jsonResponse({ enabled: true, pendingCount: 0, failedCount: 0 });
      },
      listGet: () => {
        listCalls += 1;
        return listCalls === 1
          ? page([review()], { openCount: 1 })
          : page([aiReview(), review()], { openCount: 2 });
      },
    });
    expect(
      await screen.findByText('1 suggestion is waiting for your decision.'),
    ).toBeInTheDocument();

    vi.useFakeTimers();
    firstStatus.release?.(
      jsonResponse({ enabled: true, pendingCount: 1, failedCount: 0 }),
    );
    await act(() => vi.advanceTimersByTimeAsync(0));

    // The pending backlog is owner-visible before the queue is even opened.
    expect(
      screen.getByText(
        /asking an optional AI model for a category suggestion on 1 of your entries/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/nothing changes until you decide/),
    ).toBeInTheDocument();

    // The manual decision stays available while work is pending, and the
    // owner starts one that must survive the later convergence.
    fireEvent.click(
      screen.getByRole('button', { name: /Review suggested categories/ }),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Review the suggestion for Corner Market',
      }),
    );
    expect(
      screen.getByRole('radio', { name: 'Keep it uncategorized' }),
    ).toBeEnabled();
    fireEvent.click(
      screen.getByRole('radio', { name: 'Choose a different category' }),
    );
    fireEvent.change(screen.getByLabelText('Category for this decision'), {
      target: { value: 'SHOPPING' },
    });

    // Work settles: the bounded poll notices and the private queue converges.
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    vi.useRealTimers();

    expect(
      screen.queryByText(/asking an optional AI model/),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByText('2 suggestions are waiting for your decision.'),
    ).toBeInTheDocument();
    // The unrelated draft survived the asynchronous refresh.
    expect(screen.getByLabelText('Category for this decision')).toHaveValue(
      'SHOPPING',
    );
    expect(listCalls).toBeGreaterThan(1);
    // Nothing is polled once no work is pending.
    expect(aiStatusCalls(calls)).toHaveLength(2);

    // The settled work shows up as a source=AI suggestion in the same queue.
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Review the suggestion for Transit pass',
      }),
    );
    const aiDetail = screen.getByRole('group', {
      name: /Suggestion for “Transit pass”/,
    });
    expect(within(aiDetail).getByText(/AI suggestion/)).toBeInTheDocument();
    expect(
      within(aiDetail).getByText(
        /optional AI model from a normalized description/,
      ),
    ).toBeInTheDocument();
    expect(
      within(aiDetail).getByText(/Medium confidence band/),
    ).toBeInTheDocument();
    expect(within(aiDetail).getByText('Model suggestion')).toBeInTheDocument();
  });

  it('keeps polling across a queue reload and converges the settled AI suggestion', async () => {
    let listCalls = 0;
    let statusCalls = 0;
    const firstStatus: { release?: (response: Response) => void } = {};
    const { calls, rerender } = renderSection({
      aiStatusGet: () => {
        statusCalls += 1;
        if (statusCalls === 1) {
          return new Promise<Response>((resolve) => {
            firstStatus.release = resolve;
          });
        }
        return jsonResponse(
          statusCalls === 2
            ? { enabled: true, pendingCount: 1, failedCount: 0 }
            : { enabled: true, pendingCount: 0, failedCount: 0 },
        );
      },
      listGet: () => {
        listCalls += 1;
        return listCalls < 3
          ? page([review()], { openCount: 1 })
          : page([aiReview(), review()], { openCount: 2 });
      },
    });
    expect(
      await screen.findByText('1 suggestion is waiting for your decision.'),
    ).toBeInTheDocument();

    vi.useFakeTimers();
    firstStatus.release?.(
      jsonResponse({ enabled: true, pendingCount: 1, failedCount: 0 }),
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(
      screen.getByText(/category suggestion on 1 of your entries/),
    ).toBeInTheDocument();

    // A view switch reloads the C queue (a new queue generation) and a
    // sibling commit re-reads the counters with the queue; neither may strand
    // the pending poll or discard the read the owner is waiting on.
    fireEvent.click(
      screen.getByRole('button', { name: /Review suggested categories/ }),
    );
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));
    fireEvent.change(screen.getByLabelText('Show'), {
      target: { value: 'HISTORY' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    rerender({ refreshSignal: 1 });
    expect(statusCalls).toBe(2);

    // Work settles, and the poll that survived the reload notices it.
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    vi.useRealTimers();

    expect(statusCalls).toBe(3);
    expect(aiStatusCalls(calls)).toHaveLength(3);
    expect(
      screen.queryByText(/asking an optional AI model/),
    ).not.toBeInTheDocument();
    // The settled suggestion converged into the shown page and its count.
    expect(await screen.findByText('Transit pass')).toBeInTheDocument();
    expect(
      screen.getByText('2 suggestions are waiting for your decision.'),
    ).toBeInTheDocument();
    expect(listCalls).toBeGreaterThanOrEqual(3);
  });

  it('publishes a status read that is in flight while the queue reloads', async () => {
    let statusCalls = 0;
    const gatedRead: { release?: (response: Response) => void } = {};
    const { rerender } = renderSection({
      aiStatusGet: () => {
        statusCalls += 1;
        if (statusCalls === 1) return aiStatusDisabled();
        return new Promise<Response>((resolve) => {
          gatedRead.release = resolve;
        });
      },
      listGet: () => page([review()], { openCount: 1 }),
    });
    expect(
      await screen.findByText('1 suggestion is waiting for your decision.'),
    ).toBeInTheDocument();

    // A sibling commit starts a status read; a queue reload (view switch)
    // commits while that read is still in flight.
    rerender({ refreshSignal: 1 });
    expect(statusCalls).toBe(2);
    fireEvent.click(
      screen.getByRole('button', { name: /Review suggested categories/ }),
    );
    const filters = screen.getByRole('button', { name: /^Filters/ });
    await waitFor(() => expect(filters).not.toBeDisabled());
    fireEvent.click(filters);
    fireEvent.change(screen.getByLabelText('Show'), {
      target: { value: 'HISTORY' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    // The read still publishes, so the owner sees the pending backlog instead
    // of a panel whose progress was silently discarded by the reload.
    await act(async () => {
      gatedRead.release?.(
        jsonResponse({ enabled: true, pendingCount: 1, failedCount: 0 }),
      );
    });
    expect(
      screen.getByText(/category suggestion on 1 of your entries/),
    ).toBeInTheDocument();
  });

  it('ignores a stale failed status read that lands after a newer success', async () => {
    let statusCalls = 0;
    const older: { release?: (response: Response) => void } = {};
    const { rerender, onSessionExpired } = renderSection({
      aiStatusGet: () => {
        statusCalls += 1;
        if (statusCalls === 1) return aiStatusDisabled();
        if (statusCalls === 2) {
          return new Promise<Response>((resolve) => {
            older.release = resolve;
          });
        }
        return jsonResponse({ enabled: true, pendingCount: 1, failedCount: 0 });
      },
      listGet: () => page([review()], { openCount: 1 }),
    });
    expect(
      await screen.findByText('1 suggestion is waiting for your decision.'),
    ).toBeInTheDocument();

    // An older status read is still in flight when a newer read answers for
    // the same scope.
    rerender({ refreshSignal: 1 });
    expect(statusCalls).toBe(2);
    rerender({ refreshSignal: 2 });
    expect(statusCalls).toBe(3);
    expect(
      await screen.findByText(/category suggestion on 1 of your entries/),
    ).toBeInTheDocument();

    // The stale read's expired-session answer arrives last: it must not clear
    // the panel the newer read already answered.
    await act(async () => {
      older.release?.(
        jsonResponse({ code: 'UNAUTHENTICATED', message: 'Sign in.' }, 401),
      );
    });
    expect(onSessionExpired).not.toHaveBeenCalled();
    expect(
      screen.getByText(/category suggestion on 1 of your entries/),
    ).toBeInTheDocument();
    expect(
      screen.getByText('1 suggestion is waiting for your decision.'),
    ).toBeInTheDocument();
  });

  it('states a terminal AI failure safely and leaves the manual decision available', async () => {
    renderSection({
      aiStatusGet: () =>
        jsonResponse({ enabled: true, pendingCount: 0, failedCount: 1 }),
      listGet: () => page([review()], { openCount: 1 }),
    });

    expect(
      await screen.findByText(
        /No AI suggestion could be produced for 1 of your entries/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Nothing was changed — choose a category yourself whenever you are ready/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/asking an optional AI model/),
    ).not.toBeInTheDocument();

    await openReviewDetail();
    expect(
      screen.getByRole('radio', {
        name: 'Accept the suggestion — Food shopping',
      }),
    ).toBeEnabled();
    expect(
      screen.getByRole('radio', { name: 'Choose a different category' }),
    ).toBeEnabled();
    expect(
      screen.getByRole('radio', { name: 'Keep it uncategorized' }),
    ).toBeEnabled();
  });

  it('shows no progress and polls nothing while the capability is disabled', async () => {
    // The fake clock is installed before the panel mounts, so any timer it
    // arms is visible to the advance below.
    vi.useFakeTimers();
    const { calls } = renderSection({
      aiStatusGet: () => aiStatusDisabled(),
      listGet: () => page([review()], { openCount: 1 }),
    });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(
      screen.getByText('1 suggestion is waiting for your decision.'),
    ).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    vi.useRealTimers();

    // One read decides the capability; a disabled deployment is never polled.
    expect(aiStatusCalls(calls)).toHaveLength(1);
    expect(
      screen.queryByText(/asking an optional AI model/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/No AI suggestion/)).not.toBeInTheDocument();
  });

  it('rejects a drifted status payload without showing progress or touching the queue', async () => {
    renderSection({
      aiStatusGet: () =>
        jsonResponse({
          enabled: true,
          pendingCount: 1,
          failedCount: 0,
          providerError: 'rate limited by the model provider',
        }),
      listGet: () => page([review()], { openCount: 1 }),
    });

    expect(
      await screen.findByText('1 suggestion is waiting for your decision.'),
    ).toBeInTheDocument();
    // A payload the contract does not describe is never rendered, so no
    // private provider detail can reach the owner through a drifted body.
    expect(
      screen.queryByText(/asking an optional AI model/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/rate limited by the model provider/),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await openReviewDetail();
    expect(screen.getByText('Merchant pattern matched')).toBeInTheDocument();
  });

  it('renders no progress for counts this browser cannot represent exactly', async () => {
    renderSection({
      aiStatusGet: () =>
        jsonResponse({
          enabled: true,
          pendingCount: Number.MAX_SAFE_INTEGER + 1,
          failedCount: 1,
        }),
      listGet: () => page([review()], { openCount: 1 }),
    });

    expect(
      await screen.findByText('1 suggestion is waiting for your decision.'),
    ).toBeInTheDocument();
    // An oversized 64-bit count is drift, so neither notice renders and no
    // imprecise backlog number reaches the owner.
    expect(
      screen.queryByText(/asking an optional AI model/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/No AI suggestion/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await openReviewDetail();
    expect(screen.getByText('Merchant pattern matched')).toBeInTheDocument();
  });

  it('keeps the review queue working when the status read fails', async () => {
    renderSection({
      aiStatusGet: () =>
        jsonResponse({ code: 'UNKNOWN_ERROR', message: 'Boom.' }, 500),
      listGet: () => page([review()], { openCount: 1 }),
    });

    expect(
      await screen.findByText('1 suggestion is waiting for your decision.'),
    ).toBeInTheDocument();
    // A supplementary status failure is not a queue failure.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/Boom/)).not.toBeInTheDocument();

    await openReviewDetail();
    expect(screen.getByText('Merchant pattern matched')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save decision' })).toBeEnabled();
  });

  it('drops the private AI progress and ignores a late status response after a scope clear', async () => {
    let statusCalls = 0;
    const gated: { complete?: (response: Response) => void } = {};
    const { rerender } = renderSection({
      listGet: () => page([review()], { openCount: 1 }),
      aiStatusGet: () => {
        statusCalls += 1;
        if (statusCalls === 1) {
          return jsonResponse({
            enabled: true,
            pendingCount: 2,
            failedCount: 0,
          });
        }
        return new Promise<Response>((resolve) => {
          gated.complete = resolve;
        });
      },
    });
    expect(
      await screen.findByText(/category suggestions on 2 of your entries/),
    ).toBeInTheDocument();

    // A sibling commit re-reads the counters, and that read is still in
    // flight when the whole scope is cleared.
    rerender({ refreshSignal: 1 });
    await waitFor(() => expect(statusCalls).toBe(2));
    rerender({ scopeResetSignal: 1 });

    expect(
      screen.queryByText(/asking an optional AI model/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('Your suggestions are not loaded.'),
    ).toBeInTheDocument();

    // The late answer cannot publish private progress into the new scope.
    gated.complete?.(
      jsonResponse({ enabled: true, pendingCount: 5, failedCount: 1 }),
    );
    await act(async () => {});
    expect(
      screen.queryByText(/asking an optional AI model/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/No AI suggestions could be produced/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('Your suggestions are not loaded.'),
    ).toBeInTheDocument();
  });

  it('cannot render another household’s AI result after a switch', async () => {
    const otherHousehold: Household = {
      ...HOUSEHOLD,
      id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    };
    const gated: { complete?: (response: Response) => void } = {};
    const first = renderSection({
      listGet: () => page([review()], { openCount: 1 }),
      aiStatusGet: () =>
        new Promise<Response>((resolve) => {
          gated.complete = resolve;
        }),
    });

    // The owner switches households while the first household's status read
    // is still in flight: the parent remounts the section for the new one.
    first.view.unmount();
    const second = renderSection(
      { listGet: () => page([], { openCount: 0 }) },
      { household: otherHousehold },
    );
    expect(
      await screen.findByText('No suggestions are waiting for your decision.'),
    ).toBeInTheDocument();

    gated.complete?.(
      jsonResponse({ enabled: true, pendingCount: 4, failedCount: 0 }),
    );
    await act(async () => {});

    expect(
      screen.queryByText(/asking an optional AI model/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Corner Market')).not.toBeInTheDocument();
    // The new household's reads are scoped to the new household alone.
    expect(aiStatusCalls(second.calls)).toHaveLength(1);
    expect(
      aiStatusCalls(second.calls).every((call) =>
        call.url.includes(otherHousehold.id),
      ),
    ).toBe(true);
  });
});
