import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchRepayment,
  fetchRepaymentEvents,
  fetchRepayments,
  fetchSettlementSuggestions,
  postRepayment,
} from '../auth/client';
import {
  parseRepayment,
  parseRepaymentEvent,
  parseSettlementSuggestions,
} from './repayments';
const H = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  S = '11111111-1111-4111-8111-111111111111',
  R = '22222222-2222-4222-8222-222222222222',
  ID = '33333333-3333-4333-8333-333333333333';
const money = { amount: '3.00', currency: 'USD' } as const;
const record = {
  id: ID,
  householdId: H,
  senderUserId: S,
  recipientUserId: R,
  money,
  occurredOn: '2026-09-25',
  status: 'PENDING',
  version: 0,
  createdAt: '2026-09-25T10:00:00Z',
  updatedAt: '2026-09-25T10:00:00Z',
  confirmedAt: null,
  voidedAt: null,
  pendingAmendment: null,
  allowedActions: ['CANCEL'],
};
const event = {
  version: 0,
  eventType: 'CREATED',
  actorUserId: S,
  recordedAt: '2026-09-25T10:00:00Z',
  status: 'PENDING',
  money,
  occurredOn: '2026-09-25',
  pendingAmendment: null,
};
const suggestion = {
  currency: 'USD',
  snapshot: 'a'.repeat(64),
  items: [{ senderUserId: S, recipientUserId: R, money }],
  nextCursor: null,
  residuals: {
    currentDebtAfterPlan: '0.00',
    currentCreditAfterPlan: '0.00',
    departedDebt: '0.00',
    departedCredit: '0.00',
  },
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
afterEach(() => vi.unstubAllGlobals());
describe('C strict API boundary', () => {
  it('rejects extra fields, broken consent states, malformed amounts and unordered rights', () => {
    expect(parseRepayment(record)).not.toBeNull();
    expect(parseRepayment({ ...record, bankAccountId: ID })).toBeNull();
    expect(
      parseRepayment({
        ...record,
        money: { amount: '3.001', currency: 'USD' },
      }),
    ).toBeNull();
    expect(parseRepayment({ ...record, status: 'CONFIRMED' })).toBeNull();
    expect(
      parseRepayment({ ...record, allowedActions: ['REJECT', 'CONFIRM'] }),
    ).toBeNull();
    expect(
      parseRepayment({
        ...record,
        pendingAmendment: {
          action: 'VOID',
          proposedByUserId: S,
          money: null,
          occurredOn: '2026-09-25',
          createdAt: record.createdAt,
        },
      }),
    ).toBeNull();
    expect(parseRepaymentEvent(event)).not.toBeNull();
    expect(
      parseRepaymentEvent({ ...event, allowedActions: ['CONFIRM'] }),
    ).toBeNull();
    expect(
      parseRepaymentEvent({
        ...event,
        eventType: 'AMENDMENT_CONFIRMED',
        status: 'PENDING',
      }),
    ).toBeNull();
  });
  it('rejects suggestion privacy drift and wrong-currency edges while allowing aggregate magnitudes', () => {
    expect(
      parseSettlementSuggestions(
        {
          ...suggestion,
          items: [
            {
              senderUserId: S,
              recipientUserId: R,
              money: { amount: '1000000000000.00', currency: 'USD' },
            },
          ],
        },
        'USD',
      ),
    ).not.toBeNull();
    expect(
      parseSettlementSuggestions(
        {
          ...suggestion,
          items: [
            {
              senderUserId: S,
              recipientUserId: R,
              money: { amount: '3.00', currency: 'EUR' },
            },
          ],
        },
        'USD',
      ),
    ).toBeNull();
    expect(
      parseSettlementSuggestions({ ...suggestion, repaymentId: ID }, 'USD'),
    ).toBeNull();
    expect(
      parseSettlementSuggestions(
        {
          ...suggestion,
          residuals: { ...suggestion.residuals, departedDebt: '-0.00' },
        },
        'USD',
      ),
    ).toBeNull();
  });
  it('keeps an unknown-outcome key and exact request rather than choosing a second key', async () => {
    let count = 0;
    const calls: { url: string; key: string | null; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit) => {
        calls.push({
          url: input,
          key: new Headers(init.headers).get('Idempotency-Key'),
          body: init.body,
        });
        if (count++ === 0) throw new TypeError('network');
        return json(record, 200);
      }),
    );
    const input = {
        recipientUserId: R,
        money,
        occurredOn: '2026-09-25',
      } as const,
      csrf = { token: 'token', headerName: 'X-CSRF-TOKEN' };
    await expect(
      postRepayment(H, input, '44444444-4444-4444-8444-444444444444', csrf),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(
      postRepayment(H, input, '44444444-4444-4444-8444-444444444444', csrf),
    ).resolves.toMatchObject({ id: ID, status: 'PENDING' });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
  });
  it('checks pages, routes and no hidden fields on both party-only and aggregate reads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        input.includes('/settlement-suggestions')
          ? json(suggestion)
          : input.includes('/events')
            ? json({ items: [event], limit: 50, offset: 0, hasMore: false })
            : input.endsWith(`/${ID}`)
              ? json(record)
              : json({ items: [record], limit: 50, offset: 0, hasMore: false }),
      ),
    );
    expect(
      (await fetchRepayments(H, { limit: 50, offset: 0 })).items,
    ).toHaveLength(1);
    expect((await fetchRepaymentEvents(H, ID, 50, 0)).items[0]?.eventType).toBe(
      'CREATED',
    );
    expect((await fetchRepayment(H, ID)).id).toBe(ID);
    expect(
      (await fetchSettlementSuggestions(H, 'USD')).residuals.departedDebt,
    ).toBe('0.00');
    await expect(fetchRepayment(H, R)).rejects.toMatchObject({
      code: 'UNKNOWN_ERROR',
    });
  });
});
