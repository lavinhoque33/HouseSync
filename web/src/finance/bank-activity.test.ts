import { describe, expect, it } from 'vitest';
import {
  confirmBankActivityBody,
  draftFor,
  dismissBankActivityBody,
  isConfirmable,
  isDismissable,
  isSyncStale,
  parseBankActivity,
  parseBankActivityDecision,
  parseBankActivityPage,
  requiresOwnerDescription,
  type BankActivity,
} from './bank-activity';

const ACTIVITY_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222';
const MAPPING_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const LEDGER_ID = '55555555-5555-4555-8555-555555555555';

function posted(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: ACTIVITY_ID,
    connectionId: CONNECTION_ID,
    accountMappingId: MAPPING_ID,
    localAccountId: ACCOUNT_ID,
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

describe('bank activity parsing', () => {
  it('parses a confirmable posted observation with exact money', () => {
    const activity = parseBankActivity(posted());
    expect(activity).toBeDefined();
    expect(activity?.money).toEqual({ amount: '-12.34', currency: 'USD' });
    expect(isConfirmable(activity as BankActivity)).toBe(true);
    expect(isDismissable(activity as BankActivity)).toBe(true);
    expect(requiresOwnerDescription(activity as BankActivity)).toBe(false);
  });

  it('parses pending, invalid, removed, and admitted rows', () => {
    const pending = parseBankActivity(
      posted({ state: 'PENDING', occurredOn: '2026-09-11' }),
    );
    expect(pending?.state).toBe('PENDING');
    expect(isConfirmable(pending as BankActivity)).toBe(false);
    expect(isDismissable(pending as BankActivity)).toBe(true);

    const invalid = parseBankActivity(
      posted({
        state: 'INVALID',
        money: null,
        occurredOn: null,
        invalidReason: 'UNSUPPORTED_CURRENCY',
        descriptionValid: false,
      }),
    );
    expect(invalid?.invalidReason).toBe('UNSUPPORTED_CURRENCY');
    expect(requiresOwnerDescription(invalid as BankActivity)).toBe(true);

    const removed = parseBankActivity(
      posted({ state: 'REMOVED', money: null, occurredOn: null }),
    );
    expect(removed?.state).toBe('REMOVED');

    const admitted = parseBankActivity(
      posted({
        reviewState: 'CONFIRMED',
        changeState: 'MODIFIED',
        ledgerTransactionId: LEDGER_ID,
        version: 3,
      }),
    );
    expect(admitted?.reviewState).toBe('CONFIRMED');
    expect(isConfirmable(admitted as BankActivity)).toBe(false);
    expect(isDismissable(admitted as BankActivity)).toBe(false);
  });

  it('rejects contract drift loudly', () => {
    expect(parseBankActivity(posted({ extra: true }))).toBeUndefined();
    expect(parseBankActivity(posted({ state: 'UNKNOWN' }))).toBeUndefined();
    expect(parseBankActivity(posted({ money: null }))).toBeUndefined();
    expect(parseBankActivity(posted({ occurredOn: null }))).toBeUndefined();
    expect(
      parseBankActivity(
        posted({ money: { amount: '-12.340', currency: 'USD' } }),
      ),
    ).toBeUndefined();
    expect(
      parseBankActivity(
        posted({ money: { amount: '-12.34', currency: 'CHF' } }),
      ),
    ).toBeUndefined();
    expect(
      parseBankActivity(posted({ changeState: 'MODIFIED' })),
    ).toBeUndefined();
    expect(
      parseBankActivity(
        posted({ reviewState: 'CONFIRMED', changeState: null }),
      ),
    ).toBeUndefined();
    expect(
      parseBankActivity(posted({ state: 'INVALID', invalidReason: null })),
    ).toBeUndefined();
    expect(
      parseBankActivity(
        posted({ reviewState: 'DISMISSED', dismissedReason: null }),
      ),
    ).toBeUndefined();
    expect(
      parseBankActivity(posted({ pendingPredecessorId: 'not-a-uuid' })),
    ).toBeUndefined();
  });

  it('parses owner-only pages and rejects impossible counts', () => {
    const page = parseBankActivityPage({
      items: [posted()],
      limit: 50,
      offset: 0,
      hasMore: false,
      unreviewedCount: 2,
      changedCount: 1,
    });
    expect(page?.unreviewedCount).toBe(2);
    expect(
      parseBankActivityPage({
        items: [],
        limit: 50,
        offset: 0,
        hasMore: false,
        unreviewedCount: -1,
        changedCount: 0,
      }),
    ).toBeUndefined();
  });

  it('parses decisions with both replay and fresh shapes', () => {
    const decision = parseBankActivityDecision({
      activity: posted({
        reviewState: 'CONFIRMED',
        ledgerTransactionId: LEDGER_ID,
      }),
      transactionId: LEDGER_ID,
      transactionVersion: 0,
    });
    expect(decision?.transactionId).toBe(LEDGER_ID);
    expect(
      parseBankActivityDecision({
        activity: posted(),
        transactionId: null,
        transactionVersion: null,
      })?.transactionVersion,
    ).toBeNull();
  });

  it('computes staleness client-side at the 24-hour threshold', () => {
    const now = Date.parse('2026-09-18T12:00:00Z');
    expect(isSyncStale(null, now)).toBe(true);
    expect(isSyncStale('2026-09-17T13:00:00Z', now)).toBe(false);
    expect(isSyncStale('2026-09-17T11:00:00Z', now)).toBe(true);
    expect(isSyncStale('not-a-time', now)).toBe(true);
  });

  it('never sends derived or sign fields in decision bodies', () => {
    const body = confirmBankActivityBody({
      expectedVersion: 2,
      kind: 'EXPENSE',
      description: 'Coffee Shop',
    });
    expect(body).toEqual({
      expectedVersion: 2,
      kind: 'EXPENSE',
      description: 'Coffee Shop',
    });

    const refund = confirmBankActivityBody({
      expectedVersion: 1,
      kind: 'REFUND',
      description: 'Refund',
      refundOfTransactionId: LEDGER_ID,
      acknowledgeDisclosure: true,
    });
    expect(refund).toEqual({
      expectedVersion: 1,
      kind: 'REFUND',
      description: 'Refund',
      refundOfTransactionId: LEDGER_ID,
      acknowledgeDisclosure: true,
    });

    const inheriting = confirmBankActivityBody({
      expectedVersion: 1,
      kind: 'REFUND',
      description: 'Refund',
    });
    expect(inheriting.refundOfTransactionId).toBeNull();
    expect(inheriting.acknowledgeDisclosure).toBe(false);
    // Omission is INHERIT: a null category would be an explicit mismatch against a categorized
    // source expense, so the refund payload never carries one.
    expect(inheriting).not.toHaveProperty('category');

    const categorizedRefund = confirmBankActivityBody({
      expectedVersion: 1,
      kind: 'REFUND',
      description: 'Refund',
      refundOfTransactionId: LEDGER_ID,
      category: 'GROCERIES',
    });
    expect(categorizedRefund.category).toBe('GROCERIES');
    const emptyRefundCategory = confirmBankActivityBody({
      expectedVersion: 1,
      kind: 'REFUND',
      description: 'Refund',
      refundOfTransactionId: LEDGER_ID,
      category: null,
    });
    expect(emptyRefundCategory).not.toHaveProperty('category');

    expect(dismissBankActivityBody(4, 'NOT_NEEDED')).toEqual({
      expectedVersion: 4,
      reason: 'NOT_NEEDED',
    });
  });

  it('builds drafts from provider evidence with a stable idempotency key', () => {
    const activity = parseBankActivity(posted()) as BankActivity;
    const draft = draftFor(activity);
    expect(draft.description).toBe('Coffee Shop');
    expect(draft.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const invalidDraft = draftFor(
      parseBankActivity(
        posted({
          descriptionValid: false,
          providerDescription: 'x'.repeat(300),
        }),
      ) as BankActivity,
    );
    expect(invalidDraft.description).toBe('');
    expect(invalidDraft.descriptionValid).toBe(false);
  });
});
