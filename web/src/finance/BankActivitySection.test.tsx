import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CsrfToken, Household } from '../auth/client';
import { BankActivitySection } from './BankActivitySection';

const CSRF: CsrfToken = { token: 'csrf-token-1', headerName: 'X-CSRF-TOKEN' };
const HOUSEHOLD: Household = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  name: 'Elm Street home',
  role: 'OWNER',
  createdAt: '2026-09-13T01:30:00Z',
};
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222';
const POSTED_ID = '11111111-1111-4111-8111-111111111111';
const PENDING_ID = '66666666-6666-4666-8666-666666666666';
const INVALID_ID = '77777777-7777-4777-8777-777777777777';
const CONFIRMED_ID = '88888888-8888-4888-8888-888888888888';
const LEDGER_ID = '55555555-5555-4555-8555-555555555555';
const NEEDS_REVIEW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCAL_ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function activity(overrides: Record<string, unknown> = {}) {
  return {
    id: POSTED_ID,
    connectionId: CONNECTION_ID,
    accountMappingId: '33333333-3333-4333-8333-333333333333',
    localAccountId: '44444444-4444-4444-8444-444444444444',
    state: 'POSTED',
    reviewState: 'UNREVIEWED',
    changeState: null,
    money: { amount: '-12.34', currency: 'USD' },
    occurredOn: '2026-09-10',
    authorizedOn: null,
    providerDescription: 'Coffee Shop',
    descriptionValid: true,
    pendingPredecessorId: null,
    invalidReason: null,
    dismissedReason: null,
    version: 0,
    ledgerTransactionId: null,
    createdAt: '2026-09-18T10:00:00Z',
    updatedAt: '2026-09-18T10:00:00Z',
    ...overrides,
  };
}

function ledgerTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: LEDGER_ID,
    householdId: HOUSEHOLD.id,
    ownerUserId: '30000000-0000-4000-8000-000000000001',
    accountId: LOCAL_ACCOUNT_ID,
    kind: 'EXPENSE',
    money: { amount: '-12.34', currency: 'USD' },
    occurredOn: '2026-09-10',
    description: 'Ledger coffee',
    category: null,
    visibility: 'PRIVATE',
    source: 'CONNECTED',
    status: 'POSTED',
    refundOfTransactionId: null,
    version: 1,
    createdAt: '2026-09-18T10:00:00Z',
    updatedAt: '2026-09-18T10:00:00Z',
    ...overrides,
  };
}

function activeAllocation(transactionId: string) {
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    transactionId,
    householdId: HOUSEHOLD.id,
    payerUserId: '30000000-0000-4000-8000-000000000001',
    currency: 'USD',
    originalAmount: { amount: '12.34', currency: 'USD' },
    participants: [
      {
        userId: '30000000-0000-4000-8000-000000000001',
        share: { amount: '12.34', currency: 'USD' },
      },
    ],
    status: 'ACTIVE',
    createdAt: '2026-09-18T10:00:00Z',
    revokedAt: null,
    transactionVersion: 1,
  };
}

interface Harness {
  calls: Array<{ url: string; init?: RequestInit | undefined }>;
  setItems: (items: unknown[]) => void;
  failSyncWith429: () => void;
  setPaging: (hasMore: boolean, extraItems: unknown[]) => void;
  setTransactions: (items: unknown[]) => void;
  setConnectionSync: (syncState: string, historyReady: boolean) => void;
  setConnections: (items: unknown[]) => void;
  setBankActivityGate: (gate: Promise<void> | null) => void;
  setLedgerTransaction: (transaction: unknown | null) => void;
  setAllocation: (allocation: unknown | null) => void;
  failNextResolveWith: (code: string, status?: number) => void;
}

function stubFetch(): Harness {
  const calls: Harness['calls'] = [];
  let syncRateLimited = false;
  let hasMorePages = false;
  let secondPage: unknown[] = [];
  let transactionItems: unknown[] = [];
  let ledgerDetail: unknown | null = ledgerTransaction();
  let allocationDetail: unknown | null = null;
  let nextResolveFailure: { code: string; status: number } | null = null;
  let nextSyncState = 'IDLE';
  let nextHistoryReady = true;
  let bankActivityGate: Promise<void> | null = null;
  let connectionItems: unknown[] = [
    {
      id: CONNECTION_ID,
      householdId: HOUSEHOLD.id,
      provider: 'PLAID',
      environment: 'SANDBOX',
      state: 'ACTIVE',
      generation: 0,
      version: 1,
      syncState: nextSyncState,
      historyReady: nextHistoryReady,
      lastSuccessfulSyncAt: '2026-09-18T11:00:00Z',
      createdAt: '2026-09-18T10:00:00Z',
      updatedAt: '2026-09-18T10:00:00Z',
    },
  ];
  let items: unknown[] = [
    activity(),
    activity({
      id: PENDING_ID,
      state: 'PENDING',
      money: { amount: '-5.00', currency: 'USD' },
      occurredOn: '2026-09-11',
      providerDescription: 'Pending charge',
    }),
    activity({
      id: INVALID_ID,
      state: 'INVALID',
      money: null,
      occurredOn: null,
      providerDescription: 'Bad currency',
      descriptionValid: false,
      invalidReason: 'UNSUPPORTED_CURRENCY',
    }),
    activity({
      id: CONFIRMED_ID,
      reviewState: 'CONFIRMED',
      ledgerTransactionId: LEDGER_ID,
    }),
  ];
  const base = `/api/households/${HOUSEHOLD.id}`;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      const method = init?.method ?? 'GET';
      if (url.startsWith(`${base}/bank-activity/`) && method === 'GET') {
        const id = url.split('/bank-activity/')[1]?.split('?')[0];
        const found = (items as Array<{ id: string }>).find(
          (item) => item.id === id,
        );
        if (!found) {
          return jsonResponse(
            { code: 'BANK_ACTIVITY_NOT_FOUND', message: 'Not found.' },
            404,
          );
        }
        return jsonResponse(found);
      }
      if (url.startsWith(`${base}/bank-activity`) && method === 'GET') {
        if (bankActivityGate) await bankActivityGate;
        const parsed = new URL(url, 'http://localhost');
        const offset = Number(parsed.searchParams.get('offset') ?? '0');
        if (offset > 0) {
          return jsonResponse({
            items: secondPage,
            limit: 100,
            offset,
            hasMore: false,
            unreviewedCount: 2,
            changedCount: 0,
          });
        }
        return jsonResponse({
          items,
          limit: 100,
          offset: 0,
          hasMore: hasMorePages,
          unreviewedCount: 2,
          changedCount: 0,
        });
      }
      if (url.startsWith(`${base}/bank-activity/`) && method === 'POST') {
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        const id = url.split('/bank-activity/')[1]?.split('/')[0];
        if (url.endsWith('/resolve')) {
          if (nextResolveFailure) {
            const failure = nextResolveFailure;
            nextResolveFailure = null;
            return jsonResponse(
              { code: failure.code, message: 'Conflict.' },
              failure.status,
            );
          }
          const updated = activity({
            id,
            reviewState: 'CONFIRMED',
            changeState: null,
            ledgerTransactionId: LEDGER_ID,
            version: 4,
            money: { amount: '-13.00', currency: 'USD' },
            occurredOn: '2026-09-12',
            providerDescription: 'Coffee Shop revised',
          });
          items = items.map((item) =>
            (item as { id: string }).id === id ? updated : item,
          );
          return jsonResponse({
            activity: updated,
            transactionId: LEDGER_ID,
            transactionVersion: 2,
          });
        }
        if (url.endsWith('/replace-ledger')) {
          const updated = activity({
            id,
            reviewState: 'CONFIRMED',
            changeState: null,
            ledgerTransactionId: LEDGER_ID,
            version: 5,
          });
          items = items.map((item) =>
            (item as { id: string }).id === id ? updated : item,
          );
          return jsonResponse(
            {
              activity: updated,
              transaction: ledgerTransaction(),
              supersededTransactionId: LEDGER_ID,
              supersededTransactionVersion: 2,
            },
            201,
          );
        }
        const decisionKind = url.endsWith('/confirm') ? 'confirm' : 'dismiss';
        if (decisionKind === 'dismiss') {
          const updated = activity({
            id: PENDING_ID,
            state: 'PENDING',
            money: { amount: '-5.00', currency: 'USD' },
            occurredOn: '2026-09-11',
            providerDescription: 'Pending charge',
            reviewState: 'DISMISSED',
            dismissedReason: payload.reason,
            version: 1,
          });
          items = items.map((item) =>
            (item as { id: string }).id === id ? updated : item,
          );
          return jsonResponse({
            activity: updated,
            transactionId: null,
            transactionVersion: null,
          });
        }
        const updated = activity({
          reviewState: 'CONFIRMED',
          ledgerTransactionId: LEDGER_ID,
          version: 1,
          descriptionValid: true,
          providerDescription: payload.description ?? 'Coffee Shop',
        });
        items = items.map((item) =>
          (item as { id: string }).id === id ? updated : item,
        );
        return jsonResponse(
          {
            activity: updated,
            transactionId: LEDGER_ID,
            transactionVersion: 0,
          },
          201,
        );
      }
      if (url.startsWith(`${base}/financial-connections`) && method === 'GET') {
        return jsonResponse({
          items: connectionItems,
          limit: 100,
          offset: 0,
          hasMore: false,
        });
      }
      if (url.startsWith(`${base}/transaction-categories`)) {
        return jsonResponse({ code: 'UNKNOWN_ERROR' }, 500);
      }
      if (url.includes('/financial-connections/') && url.endsWith('/sync')) {
        if (syncRateLimited) {
          return jsonResponse(
            {
              code: 'MANUAL_SYNC_RATE_LIMITED',
              message: 'A sync ran moments ago.',
            },
            429,
          );
        }
        return jsonResponse(
          {
            id: '99999999-9999-4999-8999-999999999999',
            operationType: 'SYNC',
            state: 'PENDING',
            connectionId: CONNECTION_ID,
            errorCode: null,
            statusUrl: `${base}/connection-operations/99999999-9999-4999-8999-999999999999`,
            createdAt: '2026-09-18T12:00:00Z',
            updatedAt: '2026-09-18T12:00:00Z',
          },
          202,
        );
      }
      if (url === '/api/auth/csrf') {
        return jsonResponse({
          token: 'csrf-token-2',
          headerName: 'X-CSRF-TOKEN',
        });
      }
      if (url.startsWith(`${base}/transactions`)) {
        if (url.includes('/allocation')) {
          if (!allocationDetail) {
            return jsonResponse(
              { code: 'ALLOCATION_NOT_FOUND', message: 'None active.' },
              404,
            );
          }
          return jsonResponse(allocationDetail);
        }
        const singlePrefix = `${base}/transactions/`;
        const single =
          url.startsWith(singlePrefix) && method === 'GET'
            ? url.slice(singlePrefix.length).split('?')[0]
            : '';
        if (single && single.length > 0 && !single.includes('/')) {
          if (!ledgerDetail) {
            return jsonResponse(
              { code: 'TRANSACTION_NOT_FOUND', message: 'Not found.' },
              404,
            );
          }
          return jsonResponse(ledgerDetail);
        }
        return jsonResponse({
          items: transactionItems,
          limit: 100,
          offset: 0,
          hasMore: false,
        });
      }
      throw new Error(`unexpected fetch ${url} ${method}`);
    }),
  );
  return {
    calls,
    setItems: (next) => {
      items = next;
    },
    failSyncWith429: () => {
      syncRateLimited = true;
    },
    setPaging: (hasMore, extra) => {
      hasMorePages = hasMore;
      secondPage = extra;
    },
    setTransactions: (next) => {
      transactionItems = next;
    },
    setConnectionSync: (syncState, historyReady) => {
      nextSyncState = syncState;
      nextHistoryReady = historyReady;
      connectionItems = connectionItems.map((item) => ({
        ...(item as Record<string, unknown>),
        syncState,
        historyReady,
      }));
    },
    setConnections: (next) => {
      connectionItems = next;
    },
    setBankActivityGate: (gate) => {
      bankActivityGate = gate;
    },
    setLedgerTransaction: (next) => {
      ledgerDetail = next;
    },
    setAllocation: (next) => {
      allocationDetail = next;
    },
    failNextResolveWith: (code, status = 409) => {
      nextResolveFailure = { code, status };
    },
  };
}

function renderSection(
  options: {
    refreshSignal?: number;
    onLedgerChanged?: () => void;
  } = {},
) {
  const harness = stubFetch();
  const onCsrfRefreshed = vi.fn();
  const onSessionExpired = vi.fn();
  const onHouseholdAccessChanged = vi.fn();
  const onLedgerChanged = options.onLedgerChanged ?? vi.fn();
  const props = {
    household: HOUSEHOLD,
    csrf: CSRF,
    onCsrfRefreshed,
    onSessionExpired,
    onHouseholdAccessChanged,
    authorityConfirmed: true as const,
    onLedgerChanged,
  };
  const rendered = render(
    <StrictMode>
      <BankActivitySection
        {...props}
        refreshSignal={options.refreshSignal ?? 0}
      />
    </StrictMode>,
  );
  return {
    harness,
    onSessionExpired,
    onLedgerChanged,
    rerenderWithSignal: (signal: number) =>
      rendered.rerender(
        <StrictMode>
          <BankActivitySection {...props} refreshSignal={signal} />
        </StrictMode>,
      ),
  };
}

async function findItemByAmount(amount: string): Promise<HTMLElement> {
  const list = await screen.findByRole('list', { name: 'Bank activity' });
  const items = within(list).getAllByRole('listitem');
  for (const item of items) {
    if (item.textContent?.includes(amount)) return item;
  }
  throw new Error(`no bank activity item for ${amount}`);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-09-18T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BankActivitySection', () => {
  it('renders badges, counts, and only the permitted actions per state', async () => {
    renderSection();
    expect(await screen.findByText(/awaiting review/)).toBeInTheDocument();

    const posted = await findItemByAmount('-12.34');
    expect(
      within(posted).getByRole('button', { name: /^Confirm bank activity/ }),
    ).toBeInTheDocument();
    expect(
      within(posted).getByRole('button', { name: /^Dismiss bank activity/ }),
    ).toBeInTheDocument();

    const pending = await findItemByAmount('-5.00');
    expect(
      within(pending).queryByRole('button', { name: /^Confirm bank activity/ }),
    ).toBeNull();
    expect(
      within(pending).getByRole('button', { name: /^Dismiss bank activity/ }),
    ).toBeInTheDocument();

    const invalid = await findItemByAmount('Amount unavailable');
    expect(
      within(invalid).queryByRole('button', { name: /^Confirm bank activity/ }),
    ).toBeNull();
    expect(within(invalid).getByText(/Quarantined/)).toBeInTheDocument();

    const confirmed = await findItemByAmount('In the ledger');
    expect(confirmed.textContent).toContain('In the ledger');
  });

  it('confirms a posted item with an idempotent exact body', async () => {
    const { harness } = renderSection();
    const posted = await findItemByAmount('-12.34');
    fireEvent.click(
      within(posted).getByRole('button', { name: /^Confirm bank activity/ }),
    );
    const form = await screen.findByRole('group', {
      name: /Add -12.34 USD on 2026-09-10 to your ledger/,
    });
    fireEvent.change(within(form).getByLabelText('Description'), {
      target: { value: 'Coffee Shop edited' },
    });
    fireEvent.click(
      within(form).getByRole('button', { name: 'Add to ledger' }),
    );

    await waitFor(() => {
      const confirmCall = harness.calls.find((call) =>
        call.url.endsWith(`/bank-activity/${POSTED_ID}/confirm`),
      );
      expect(confirmCall).toBeDefined();
      expect(confirmCall?.init?.headers).toMatchObject({
        'Idempotency-Key': expect.any(String),
      });
      expect(JSON.parse(String(confirmCall?.init?.body))).toEqual({
        expectedVersion: 0,
        kind: 'EXPENSE',
        description: 'Coffee Shop edited',
        category: null,
      });
    });
    expect(
      await screen.findByText(/Added to your private ledger/),
    ).toBeInTheDocument();
    const updated = await findItemByAmount('-12.34');
    expect(updated.textContent).toContain('In the ledger');
  });

  it('preserves an open confirm draft across an inbox refresh', async () => {
    renderSection();
    const posted = await findItemByAmount('-12.34');
    fireEvent.click(
      within(posted).getByRole('button', { name: /^Confirm bank activity/ }),
    );
    const description = await screen.findByLabelText('Description');
    fireEvent.change(description, { target: { value: 'Typed draft text' } });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh inbox' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Description')).toHaveValue(
        'Typed draft text',
      );
    });
  });

  it('requires owner text when the bank description cannot be used', async () => {
    const { harness } = renderSection();
    await screen.findByText(/awaiting review/);
    harness.setItems([
      activity({
        id: INVALID_ID,
        state: 'INVALID',
        money: null,
        occurredOn: null,
        providerDescription: 'x'.repeat(300),
        descriptionValid: false,
        invalidReason: 'OVERSCALE',
      }),
      activity({
        descriptionValid: false,
        providerDescription: 'x'.repeat(300),
      }),
    ]);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Refresh inbox' }),
      ).not.toBeDisabled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh inbox' }));
    // Wait for the refreshed row before opening its form, so the draft is
    // built from the description-invalid revision.
    await screen.findByText(/The bank description needs your own text/);
    const posted = await findItemByAmount('-12.34');
    fireEvent.click(
      within(posted).getByRole('button', { name: /^Confirm bank activity/ }),
    );
    const form = await screen.findByRole('group', {
      name: /to your ledger/,
    });
    fireEvent.click(
      within(form).getByRole('button', { name: 'Add to ledger' }),
    );
    expect(
      await screen.findByText(/Enter your own description/),
    ).toBeInTheDocument();
    expect(harness.calls.some((call) => call.url.endsWith('/confirm'))).toBe(
      false,
    );
  });

  it('dismisses a pending observation without touching the ledger', async () => {
    const { harness } = renderSection();
    const pending = await findItemByAmount('-5.00');
    fireEvent.click(
      within(pending).getByRole('button', { name: /^Dismiss bank activity/ }),
    );
    const form = await screen.findByRole('group', {
      name: /^Dismiss -5.00 USD on 2026-09-11/,
    });
    fireEvent.change(within(form).getByLabelText('Reason'), {
      target: { value: 'NOT_NEEDED' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Dismiss item' }));
    await waitFor(() => {
      const dismissCall = harness.calls.find((call) =>
        call.url.endsWith(`/bank-activity/${PENDING_ID}/dismiss`),
      );
      expect(JSON.parse(String(dismissCall?.init?.body))).toEqual({
        expectedVersion: 0,
        reason: 'NOT_NEEDED',
      });
    });
    expect(
      await screen.findByText(/Dismissed. The item stays as retained evidence/),
    ).toBeInTheDocument();
  });

  it('shows the stale indicator and honors the manual sync rate limit', async () => {
    const { harness } = renderSection();
    harness.failSyncWith429();
    // The connection's last success is inside the window; force staleness by
    // moving the clock past 24 hours.
    vi.setSystemTime(new Date('2026-09-19T12:00:00Z'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh inbox' }));
    await waitFor(() => {
      expect(
        screen.getByRole('list', { name: 'Connected bank sync controls' })
          .textContent,
      ).toContain('no successful sync in 24 hours');
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: `Sync bank connection ${CONNECTION_ID}`,
      }),
    );
    expect(
      await screen.findByText(/A sync ran moments ago/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: `Sync bank connection ${CONNECTION_ID}`,
      }),
    ).toBeDisabled();
  });

  it('confirms a categorized connected expense refund without sending a null category', async () => {
    const CREDIT_ID = '99999999-9999-4999-8999-999999999991';
    const EXPENSE_TRANSACTION_ID = '55555555-5555-4555-8555-555555555551';
    const { harness } = renderSection();
    await screen.findByText(/awaiting review/);
    harness.setItems([
      activity({
        id: CREDIT_ID,
        money: { amount: '5.00', currency: 'USD' },
        occurredOn: '2026-09-12',
        providerDescription: 'Bank credit',
      }),
    ]);
    harness.setTransactions([
      {
        id: EXPENSE_TRANSACTION_ID,
        householdId: HOUSEHOLD.id,
        ownerUserId: '30000000-0000-4000-8000-000000000001',
        accountId: '44444444-4444-4444-8444-444444444444',
        kind: 'EXPENSE',
        money: { amount: '-12.34', currency: 'USD' },
        occurredOn: '2026-09-10',
        description: 'Bank expense',
        category: 'GROCERIES',
        visibility: 'PRIVATE',
        source: 'CONNECTED',
        status: 'POSTED',
        refundOfTransactionId: null,
        version: 0,
        createdAt: '2026-09-18T10:00:00Z',
        updatedAt: '2026-09-18T10:00:00Z',
      },
    ]);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Refresh inbox' }),
      ).not.toBeDisabled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh inbox' }));
    const credit = await findItemByAmount('5.00');
    fireEvent.click(
      within(credit).getByRole('button', { name: /^Confirm bank activity/ }),
    );
    const form = await screen.findByRole('group', { name: /to your ledger/ });
    fireEvent.change(within(form).getByLabelText('Entry type'), {
      target: { value: 'REFUND' },
    });
    await screen.findByText(/Bank expense/);
    fireEvent.change(within(form).getByLabelText('Refunded expense'), {
      target: { value: EXPENSE_TRANSACTION_ID },
    });
    fireEvent.click(
      within(form).getByRole('button', { name: 'Add to ledger' }),
    );

    await waitFor(() => {
      const confirmCall = harness.calls.find((call) =>
        call.url.endsWith(`/bank-activity/${CREDIT_ID}/confirm`),
      );
      expect(confirmCall).toBeDefined();
      const body = JSON.parse(String(confirmCall?.init?.body));
      expect(body.kind).toBe('REFUND');
      expect(body.refundOfTransactionId).toBe(EXPENSE_TRANSACTION_ID);
      // Omission means INHERIT; an explicit null would conflict with the categorized expense.
      expect(body).not.toHaveProperty('category');
    });
  });

  it('shows sync worker failure and incomplete history from the connection', async () => {
    const { harness } = renderSection();
    await screen.findByText(/awaiting review/);
    harness.setConnectionSync('FAILED', false);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh inbox' }));
    await waitFor(() => {
      expect(
        screen.getByRole('list', { name: 'Connected bank sync controls' })
          .textContent,
      ).toContain('Sync failed');
    });
    expect(
      screen.getByRole('list', { name: 'Connected bank sync controls' })
        .textContent,
    ).toContain('history import incomplete');
  });

  it('loads more activity explicitly instead of silently truncating', async () => {
    const { harness } = renderSection();
    await screen.findByText(/awaiting review/);
    harness.setPaging(true, [
      activity({
        id: '99999999-9999-4999-8999-999999999992',
        money: { amount: '-7.77', currency: 'USD' },
        occurredOn: '2026-08-01',
        providerDescription: 'Older txn',
      }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh inbox' }));
    const loadMore = await screen.findByRole('button', {
      name: 'Load more activity',
    });
    fireEvent.click(loadMore);
    await screen.findByText(/Older txn/);
    // The offset is the number of already-loaded items, never a silent truncation.
    expect(
      harness.calls.some((call) => /[?&]offset=4(?:&|$)/.test(call.url)),
    ).toBe(true);
    expect(
      screen.queryByRole('button', { name: 'Load more activity' }),
    ).toBeNull();
  });

  it('surfaces needs-review rows with ledger-unchanged copy and review actions', async () => {
    const { harness } = renderSection();
    await screen.findByText(/awaiting review/);
    harness.setItems([
      activity({
        id: NEEDS_REVIEW_ID,
        state: 'POSTED',
        reviewState: 'CONFIRMED',
        changeState: 'MODIFIED',
        ledgerTransactionId: LEDGER_ID,
        money: { amount: '-13.00', currency: 'USD' },
        occurredOn: '2026-09-12',
        providerDescription: 'Coffee Shop revised',
        version: 3,
      }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh inbox' }));

    const row = await findItemByAmount('-13.00');
    expect(within(row).getByText('Needs review')).toBeInTheDocument();
    expect(row.textContent).toContain('Your ledger entry is unchanged');
    expect(
      within(row).getByRole('button', { name: /^Review bank revision/ }),
    ).toBeInTheDocument();
    expect(
      within(row).getByRole('button', { name: /^Replace ledger entry/ }),
    ).toBeInTheDocument();
    // Admitted rows offer no confirm or dismiss actions.
    expect(
      within(row).queryByRole('button', { name: /^Confirm bank activity/ }),
    ).toBeNull();
    expect(
      within(row).queryByRole('button', { name: /^Dismiss bank activity/ }),
    ).toBeNull();
  });

  it('resolves a revision with both versions and notifies the ledger', async () => {
    const onLedgerChanged = vi.fn();
    const { harness } = renderSection({ onLedgerChanged });
    await screen.findByText(/awaiting review/);
    harness.setItems([
      activity({
        id: NEEDS_REVIEW_ID,
        state: 'POSTED',
        reviewState: 'CONFIRMED',
        changeState: 'MODIFIED',
        ledgerTransactionId: LEDGER_ID,
        money: { amount: '-13.00', currency: 'USD' },
        occurredOn: '2026-09-12',
        providerDescription: 'Coffee Shop revised',
        version: 3,
      }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh inbox' }));

    const row = await findItemByAmount('-13.00');
    fireEvent.click(
      within(row).getByRole('button', { name: /^Review bank revision/ }),
    );
    const panel = await screen.findByRole('group', {
      name: /Review the bank revision/,
    });
    // The ledger entry converges without discarding the open panel.
    await within(panel).findByText(/Ledger now:/);
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Resolve revision' }),
    );

    await waitFor(() => {
      const resolveCall = harness.calls.find((call) =>
        call.url.endsWith(`/bank-activity/${NEEDS_REVIEW_ID}/resolve`),
      );
      expect(resolveCall).toBeDefined();
      expect(JSON.parse(String(resolveCall?.init?.body))).toEqual({
        expectedVersion: 3,
        expectedLedgerVersion: 1,
        action: 'KEEP_LEDGER',
      });
    });
    expect(
      await screen.findByText(/Kept your ledger entry/),
    ).toBeInTheDocument();
    // Success moves focus to the outcome notice instead of stranding it on
    // the unmounted submit button.
    expect(document.activeElement?.textContent).toContain(
      'Kept your ledger entry',
    );
    expect(onLedgerChanged).toHaveBeenCalledTimes(1);
  });

  it('blocks an allocated amount change with an allocation-conflict explanation', async () => {
    const { harness } = renderSection();
    await screen.findByText(/awaiting review/);
    harness.setLedgerTransaction(
      ledgerTransaction({ visibility: 'HOUSEHOLD', version: 2 }),
    );
    harness.setAllocation(activeAllocation(LEDGER_ID));
    harness.setItems([
      activity({
        id: NEEDS_REVIEW_ID,
        state: 'POSTED',
        reviewState: 'CONFIRMED',
        changeState: 'MODIFIED',
        ledgerTransactionId: LEDGER_ID,
        money: { amount: '-13.00', currency: 'USD' },
        occurredOn: '2026-09-12',
        providerDescription: 'Coffee Shop revised',
        version: 3,
      }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh inbox' }));

    const row = await findItemByAmount('-13.00');
    fireEvent.click(
      within(row).getByRole('button', { name: /^Review bank revision/ }),
    );
    const panel = await screen.findByRole('group', {
      name: /Review the bank revision/,
    });
    await within(panel).findByText(/active allocation/);
    fireEvent.click(within(panel).getByLabelText(/Apply the bank fields/));
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Resolve revision' }),
    );

    expect(
      await screen.findByText(/The amount is locked by the active allocation/),
    ).toBeInTheDocument();
    expect(harness.calls.some((call) => call.url.endsWith('/resolve'))).toBe(
      false,
    );
  });

  it('refetches and preserves the draft after a reconciliation conflict', async () => {
    const { harness } = renderSection();
    await screen.findByText(/awaiting review/);
    harness.setItems([
      activity({
        id: NEEDS_REVIEW_ID,
        state: 'POSTED',
        reviewState: 'CONFIRMED',
        changeState: 'MODIFIED',
        ledgerTransactionId: LEDGER_ID,
        money: { amount: '-13.00', currency: 'USD' },
        occurredOn: '2026-09-12',
        providerDescription: 'Coffee Shop revised',
        version: 3,
      }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh inbox' }));

    const row = await findItemByAmount('-13.00');
    fireEvent.click(
      within(row).getByRole('button', { name: /^Review bank revision/ }),
    );
    const panel = await screen.findByRole('group', {
      name: /Review the bank revision/,
    });
    await within(panel).findByText(/Ledger now:/);
    fireEvent.click(within(panel).getByLabelText(/Void my ledger entry/));

    harness.failNextResolveWith('RECONCILIATION_REQUIRED');
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Resolve revision' }),
    );

    // Stale versions refetch instead of resending: the typed VOID choice
    // survives and the warning asks for review of the latest.
    expect(
      await screen.findByText(/changed while you were reviewing/),
    ).toBeInTheDocument();
    expect(within(panel).getByLabelText(/Void my ledger entry/)).toBeChecked();
    expect(
      harness.calls.filter((call) => call.url.endsWith('/resolve')).length,
    ).toBe(1);
  });

  it('replaces a ledger entry atomically with allocation acknowledgement', async () => {
    const onLedgerChanged = vi.fn();
    const { harness } = renderSection({ onLedgerChanged });
    await screen.findByText(/awaiting review/);
    harness.setLedgerTransaction(
      ledgerTransaction({ visibility: 'HOUSEHOLD', version: 2 }),
    );
    harness.setAllocation(activeAllocation(LEDGER_ID));
    harness.setItems([
      activity({
        id: NEEDS_REVIEW_ID,
        state: 'POSTED',
        reviewState: 'CONFIRMED',
        changeState: 'MODIFIED',
        ledgerTransactionId: LEDGER_ID,
        money: { amount: '-13.00', currency: 'USD' },
        occurredOn: '2026-09-12',
        providerDescription: 'Coffee Shop revised',
        version: 3,
      }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh inbox' }));

    const row = await findItemByAmount('-13.00');
    fireEvent.click(
      within(row).getByRole('button', { name: /^Replace ledger entry/ }),
    );
    const panel = await screen.findByRole('group', {
      name: /Replace the ledger entry/,
    });
    await within(panel).findByText(/never copied to the replacement/);
    fireEvent.change(within(panel).getByLabelText('Description'), {
      target: { value: 'Corrected coffee' },
    });
    // The allocation-removal gate blocks submission until acknowledged.
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Replace entry' }),
    );
    expect(
      await screen.findByText(/acknowledge the removal before replacing/),
    ).toBeInTheDocument();
    fireEvent.click(
      within(panel).getByLabelText(/I understand the recorded allocation/),
    );
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Replace entry' }),
    );

    await waitFor(() => {
      const replaceCall = harness.calls.find((call) =>
        call.url.endsWith(`/bank-activity/${NEEDS_REVIEW_ID}/replace-ledger`),
      );
      expect(replaceCall).toBeDefined();
      expect(JSON.parse(String(replaceCall?.init?.body))).toEqual({
        expectedVersion: 3,
        expectedLedgerVersion: 2,
        kind: 'EXPENSE',
        description: 'Corrected coffee',
        category: null,
        acknowledgeAllocationRemoval: true,
      });
    });
    expect(
      await screen.findByText(/Replaced the ledger entry/),
    ).toBeInTheDocument();
    expect(onLedgerChanged).toHaveBeenCalledTimes(1);
  });

  it('restores focus to the matching trigger when a review panel is cancelled', async () => {
    const { harness } = renderSection();
    await screen.findByText(/awaiting review/);
    harness.setItems([
      activity({
        id: NEEDS_REVIEW_ID,
        state: 'POSTED',
        reviewState: 'CONFIRMED',
        changeState: 'MODIFIED',
        ledgerTransactionId: LEDGER_ID,
        money: { amount: '-13.00', currency: 'USD' },
        occurredOn: '2026-09-12',
        providerDescription: 'Coffee Shop revised',
        version: 3,
      }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh inbox' }));

    const row = await findItemByAmount('-13.00');
    const reviewTrigger = within(row).getByRole('button', {
      name: /^Review bank revision/,
    });
    fireEvent.click(reviewTrigger);
    const resolvePanel = await screen.findByRole('group', {
      name: /Review the bank revision/,
    });
    fireEvent.click(
      within(resolvePanel).getByRole('button', { name: 'Cancel' }),
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(reviewTrigger);
    });

    const replaceTrigger = within(row).getByRole('button', {
      name: /^Replace ledger entry/,
    });
    fireEvent.click(replaceTrigger);
    const replacePanel = await screen.findByRole('group', {
      name: /Replace the ledger entry/,
    });
    fireEvent.click(
      within(replacePanel).getByRole('button', { name: 'Cancel' }),
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(replaceTrigger);
    });
  });

  it('replaces as a refund without a category key so the source is inherited', async () => {
    const EXPENSE_TRANSACTION_ID = '55555555-5555-4555-8555-555555555551';
    const { harness } = renderSection();
    await screen.findByText(/awaiting review/);
    harness.setTransactions([
      {
        ...ledgerTransaction(),
        id: EXPENSE_TRANSACTION_ID,
        category: 'GROCERIES',
        version: 0,
      },
    ]);
    harness.setItems([
      activity({
        id: NEEDS_REVIEW_ID,
        state: 'POSTED',
        reviewState: 'CONFIRMED',
        changeState: 'MODIFIED',
        ledgerTransactionId: LEDGER_ID,
        money: { amount: '5.00', currency: 'USD' },
        occurredOn: '2026-09-12',
        providerDescription: 'Bank credit revised',
        version: 3,
      }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh inbox' }));

    const row = await findItemByAmount('5.00');
    fireEvent.click(
      within(row).getByRole('button', { name: /^Replace ledger entry/ }),
    );
    const panel = await screen.findByRole('group', {
      name: /Replace the ledger entry/,
    });
    fireEvent.change(within(panel).getByLabelText('Entry type'), {
      target: { value: 'REFUND' },
    });
    await within(panel).findByText(/Ledger coffee/);
    fireEvent.change(within(panel).getByLabelText('Refunded expense'), {
      target: { value: EXPENSE_TRANSACTION_ID },
    });
    fireEvent.change(within(panel).getByLabelText('Description'), {
      target: { value: 'Refund correction' },
    });
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Replace entry' }),
    );

    await waitFor(() => {
      const replaceCall = harness.calls.find((call) =>
        call.url.endsWith(`/bank-activity/${NEEDS_REVIEW_ID}/replace-ledger`),
      );
      expect(replaceCall).toBeDefined();
      const body = JSON.parse(String(replaceCall?.init?.body));
      expect(body.kind).toBe('REFUND');
      expect(body.refundOfTransactionId).toBe(EXPENSE_TRANSACTION_ID);
      // Omission means INHERIT; an explicit null would mismatch the
      // categorized source expense.
      expect(body).not.toHaveProperty('category');
    });
  });
});

describe('sibling refresh signals', () => {
  it('discovers a newly committed connection and inbox entry without remounting or losing drafts', async () => {
    const { harness, rerenderWithSignal } = renderSection();
    harness.setConnections([]);
    await screen.findByText(/awaiting review/);
    // Open a confirmation draft on the existing posted observation.
    const posted = await findItemByAmount('-12.34');
    fireEvent.click(
      within(posted).getByRole('button', { name: /^Confirm bank activity/ }),
    );
    const description = await screen.findByLabelText('Description');
    fireEvent.change(description, { target: { value: 'Draft confirmation' } });

    // A committed link/selection makes a connection and a new observation
    // visible; the parent bumps the refresh signal.
    const NEW_ID = '99999999-9999-4999-8999-999999999993';
    harness.setConnections([
      {
        id: CONNECTION_ID,
        householdId: HOUSEHOLD.id,
        provider: 'PLAID',
        environment: 'SANDBOX',
        state: 'ACTIVE',
        generation: 0,
        version: 1,
        syncState: 'IDLE',
        historyReady: false,
        lastSuccessfulSyncAt: null,
        createdAt: '2026-09-18T10:00:00Z',
        updatedAt: '2026-09-18T10:00:00Z',
      },
    ]);
    // Keep the drafted observation in the refreshed page alongside the new
    // one; the signal must not remount or discard the in-progress form.
    harness.setItems([
      activity(),
      activity({
        id: NEW_ID,
        occurredOn: '2026-09-12',
        providerDescription: 'Newly synced item',
      }),
    ]);
    rerenderWithSignal(1);

    expect(
      await screen.findByRole('list', { name: 'Connected bank sync controls' }),
    ).toBeInTheDocument();
    await screen.findByText(/Newly synced item/);
    // Without a remount the typed draft is still present.
    expect(screen.getByLabelText('Description')).toHaveValue(
      'Draft confirmation',
    );
  });

  it('serves a refresh signal that arrives before the initial load settles', async () => {
    const gateControl: { release: (() => void) | null } = { release: null };
    const gate = new Promise<void>((resolve) => {
      gateControl.release = () => resolve();
    });
    const { harness, rerenderWithSignal } = renderSection();
    harness.setBankActivityGate(gate);
    // The signal arrives while the initial read is still in flight.
    rerenderWithSignal(1);
    gateControl.release?.();

    await screen.findByText(/awaiting review/);
    expect(
      harness.calls.filter(({ url }) => url.includes('/bank-activity?')).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('notifies the ledger only for a successful confirmation', async () => {
    const onLedgerChanged = vi.fn();
    const { harness } = renderSection({ onLedgerChanged });
    await screen.findByText(/awaiting review/);
    const posted = await findItemByAmount('-12.34');
    fireEvent.click(
      within(posted).getByRole('button', { name: /^Confirm bank activity/ }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Add to ledger' }),
    );
    await waitFor(() => expect(onLedgerChanged).toHaveBeenCalledTimes(1));
    // Let the post-confirm refresh and busy state settle before the next
    // interaction so the dismiss control is enabled again.
    await screen.findByText(/Added to your private ledger/);
    await waitFor(() => {
      const item = screen.getByText('-5.00 USD').closest('li');
      expect(
        within(item as HTMLElement).getByRole('button', {
          name: /^Dismiss bank activity/,
        }),
      ).not.toBeDisabled();
    });

    // Dismissal never notifies the ledger.
    const pending = await findItemByAmount('-5.00');
    fireEvent.click(
      within(pending).getByRole('button', { name: /^Dismiss bank activity/ }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Dismiss item' }),
    );
    await screen.findByText(/retained evidence/);
    expect(onLedgerChanged).toHaveBeenCalledTimes(1);
    expect(
      harness.calls.some(({ url }) => url.includes('/bank-activity?')),
    ).toBe(true);
  });
});
