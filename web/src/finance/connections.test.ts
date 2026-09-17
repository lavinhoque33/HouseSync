import { describe, expect, it } from 'vitest';
import {
  accountSelectionBody,
  canReconnect,
  completeNewLinkBody,
  expectedVersionBody,
  isTerminalOperationState,
  parseAccountSelectionResult,
  parseConnectionAccountMapping,
  parseConnectionAccountMappingPage,
  parseConnectionOperation,
  parseFinancialConnection,
  parseFinancialConnectionPage,
  parseLinkAttempt,
} from './connections';

const HOUSEHOLD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CONNECTION_ID = '10000000-0000-4000-8000-000000000001';
const ATTEMPT_ID = '20000000-0000-4000-8000-000000000002';
const OPERATION_ID = '30000000-0000-4000-8000-000000000003';
const MAPPING_ID = '40000000-0000-4000-8000-000000000004';

function linkAttempt(overrides: Record<string, unknown> = {}) {
  return {
    id: ATTEMPT_ID,
    flow: 'NEW',
    provider: 'PLAID',
    connectionId: null,
    linkToken: 'link-sandbox-only-in-memory',
    expiresAt: '2026-09-17T01:00:00Z',
    ...overrides,
  };
}

function operation(overrides: Record<string, unknown> = {}) {
  return {
    id: OPERATION_ID,
    operationType: 'LINK_COMPLETE',
    state: 'SUCCEEDED',
    connectionId: CONNECTION_ID,
    errorCode: null,
    statusUrl: `/api/households/${HOUSEHOLD_ID}/connection-operations/${OPERATION_ID}`,
    createdAt: '2026-09-17T00:00:00Z',
    updatedAt: '2026-09-17T00:00:01Z',
    ...overrides,
  };
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    householdId: HOUSEHOLD_ID,
    provider: 'PLAID',
    environment: 'SANDBOX',
    state: 'ACTIVE',
    generation: 0,
    version: 0,
    lastSuccessfulSyncAt: null,
    createdAt: '2026-09-17T00:00:00Z',
    updatedAt: '2026-09-17T00:00:00Z',
    ...overrides,
  };
}

function mapping(overrides: Record<string, unknown> = {}) {
  return {
    mappingId: MAPPING_ID,
    localAccountId: null,
    name: 'Everyday Chequing',
    kind: 'CHECKING',
    currency: 'CAD',
    selected: false,
    eligible: true,
    exclusionReason: null,
    ...overrides,
  };
}

describe('link attempt parser', () => {
  it('accepts the exact NEW attempt shape with a null connection', () => {
    expect(parseLinkAttempt(linkAttempt())).toEqual(linkAttempt());
  });

  it('accepts UPDATE attempts bound to a connection', () => {
    const parsed = parseLinkAttempt(
      linkAttempt({ flow: 'UPDATE', connectionId: CONNECTION_ID }),
    );
    expect(parsed?.flow).toBe('UPDATE');
    expect(parsed?.connectionId).toBe(CONNECTION_ID);
  });

  it('rejects non-Plaid providers, bad flows, and missing tokens', () => {
    expect(
      parseLinkAttempt(linkAttempt({ provider: 'OTHER' })),
    ).toBeUndefined();
    expect(parseLinkAttempt(linkAttempt({ flow: 'REFRESH' }))).toBeUndefined();
    expect(parseLinkAttempt(linkAttempt({ linkToken: '' }))).toBeUndefined();
    expect(
      parseLinkAttempt(linkAttempt({ expiresAt: 'not-a-date' })),
    ).toBeUndefined();
    expect(parseLinkAttempt(linkAttempt({ id: 'not-a-uuid' }))).toBeUndefined();
    expect(parseLinkAttempt('attempt')).toBeUndefined();
  });
});

describe('operation parser', () => {
  it('accepts every documented terminal state', () => {
    for (const state of ['PENDING', 'SUCCEEDED', 'FAILED', 'OUTCOME_UNKNOWN']) {
      expect(parseConnectionOperation(operation({ state }))?.state).toBe(state);
    }
  });

  it('keeps opaque safe error codes without interpreting them', () => {
    expect(
      parseConnectionOperation(
        operation({ state: 'OUTCOME_UNKNOWN', errorCode: 'EXCHANGE_UNKNOWN' }),
      )?.errorCode,
    ).toBe('EXCHANGE_UNKNOWN');
  });

  it('rejects unknown types, states, and non-local status URLs', () => {
    expect(
      parseConnectionOperation(operation({ operationType: 'SYNC' })),
    ).toBeUndefined();
    expect(
      parseConnectionOperation(operation({ state: 'RUNNING' })),
    ).toBeUndefined();
    expect(
      parseConnectionOperation(operation({ statusUrl: 'https://evil.test/x' })),
    ).toBeUndefined();
    expect(parseConnectionOperation(operation({ id: 42 }))).toBeUndefined();
  });

  it('marks only the documented states terminal', () => {
    expect(isTerminalOperationState('PENDING')).toBe(false);
    expect(isTerminalOperationState('SUCCEEDED')).toBe(true);
    expect(isTerminalOperationState('FAILED')).toBe(true);
    expect(isTerminalOperationState('OUTCOME_UNKNOWN')).toBe(true);
  });
});

describe('connection parser', () => {
  it('accepts the exact owner-scoped connection shape', () => {
    expect(parseFinancialConnection(connection())).toEqual(connection());
  });

  it('rejects credentials, provider identities, and bad enums', () => {
    expect(
      parseFinancialConnection(connection({ state: 'SYNCED' })),
    ).toBeUndefined();
    expect(
      parseFinancialConnection(connection({ environment: 'DEV' })),
    ).toBeUndefined();
    expect(
      parseFinancialConnection(connection({ provider: 'OTHER' })),
    ).toBeUndefined();
    expect(
      parseFinancialConnection(connection({ generation: -1 })),
    ).toBeUndefined();
    expect(
      parseFinancialConnection(connection({ version: 1.5 })),
    ).toBeUndefined();
  });

  it('parses bounded pages and rejects malformed items', () => {
    const page = parseFinancialConnectionPage({
      items: [connection()],
      limit: 100,
      offset: 0,
      hasMore: false,
    });
    expect(page?.items).toHaveLength(1);
    expect(
      parseFinancialConnectionPage({
        items: [connection({ state: 'NOPE' })],
        limit: 100,
        offset: 0,
        hasMore: false,
      }),
    ).toBeUndefined();
  });

  it('allows reconnect only on active or reauth states', () => {
    expect(canReconnect('ACTIVE')).toBe(true);
    expect(canReconnect('REAUTH_REQUIRED')).toBe(true);
    for (const state of [
      'LINKING',
      'SUSPENDED',
      'DISCONNECTING',
      'DISCONNECTED',
      'ERROR',
    ] as const) {
      expect(canReconnect(state)).toBe(false);
    }
  });
});

describe('account mapping parser', () => {
  it('accepts discovered mappings including CAD', () => {
    expect(parseConnectionAccountMapping(mapping())).toEqual(mapping());
  });

  it('rejects bad kinds, currencies, and non-local IDs', () => {
    expect(
      parseConnectionAccountMapping(mapping({ kind: 'LOAN' })),
    ).toBeUndefined();
    // Cash has no provider representation and is never eligible.
    expect(
      parseConnectionAccountMapping(mapping({ kind: 'CASH' })),
    ).toBeUndefined();
    expect(
      parseConnectionAccountMapping(mapping({ currency: 'CHF' })),
    ).toBeUndefined();
    expect(
      parseConnectionAccountMapping(mapping({ mappingId: 'remote-1' })),
    ).toBeUndefined();
    expect(
      parseConnectionAccountMapping(mapping({ selected: 'yes' })),
    ).toBeUndefined();
  });

  it('accepts backend-realistic null classifications only when ineligible with a reason', () => {
    // Unsupported loan kind: null kind, valid currency is irrelevant once
    // the kind is unknown — the backend sends the currency as discovered.
    expect(
      parseConnectionAccountMapping(
        mapping({
          kind: null,
          currency: 'USD',
          eligible: false,
          exclusionReason: 'UNSUPPORTED_KIND',
        }),
      ),
    ).toMatchObject({ kind: null, eligible: false });
    // Unsupported currency: null currency with a valid kind.
    expect(
      parseConnectionAccountMapping(
        mapping({
          kind: 'CHECKING',
          currency: null,
          eligible: false,
          exclusionReason: 'UNSUPPORTED_CURRENCY',
        }),
      ),
    ).toMatchObject({ currency: null, eligible: false });
    // Both unknown remains ineligible with the kind reason first.
    expect(
      parseConnectionAccountMapping(
        mapping({
          kind: null,
          currency: null,
          eligible: false,
          exclusionReason: 'UNSUPPORTED_KIND',
        }),
      ),
    ).toMatchObject({ kind: null, currency: null, eligible: false });
  });

  it('rejects invalid eligible-null and ineligible-without-reason shapes', () => {
    // Eligible rows must carry a complete classification and no reason.
    expect(
      parseConnectionAccountMapping(mapping({ kind: null })),
    ).toBeUndefined();
    expect(
      parseConnectionAccountMapping(mapping({ currency: null })),
    ).toBeUndefined();
    expect(
      parseConnectionAccountMapping(
        mapping({ exclusionReason: 'UNSUPPORTED_KIND' }),
      ),
    ).toBeUndefined();
    // Ineligible rows need a null side plus a non-blank reason.
    expect(
      parseConnectionAccountMapping(
        mapping({ eligible: false, exclusionReason: 'UNSUPPORTED_KIND' }),
      ),
    ).toBeUndefined();
    expect(
      parseConnectionAccountMapping(
        mapping({ kind: null, eligible: false, exclusionReason: null }),
      ),
    ).toBeUndefined();
    expect(
      parseConnectionAccountMapping(
        mapping({ kind: null, eligible: false, exclusionReason: '  ' }),
      ),
    ).toBeUndefined();
  });

  it('parses bounded mapping pages', () => {
    const page = parseConnectionAccountMappingPage({
      items: [mapping()],
      limit: 100,
      offset: 0,
      hasMore: false,
    });
    expect(page?.items).toHaveLength(1);
    expect(
      parseConnectionAccountMappingPage({
        items: ['nope'],
        limit: 100,
        offset: 0,
        hasMore: false,
      }),
    ).toBeUndefined();
  });
});

describe('selection result parser', () => {
  it('accepts CONNECTED accounts and rejects any other source', () => {
    const selected = {
      id: '50000000-0000-4000-8000-000000000005',
      name: 'Everyday Chequing',
      kind: 'CHECKING',
      currency: 'CAD',
      source: 'CONNECTED',
      status: 'ACTIVE',
      version: 0,
    };
    const parsed = parseAccountSelectionResult({
      connectionId: CONNECTION_ID,
      version: 1,
      accounts: [selected],
    });
    expect(parsed?.accounts).toEqual([selected]);
    expect(
      parseAccountSelectionResult({
        connectionId: CONNECTION_ID,
        version: 1,
        accounts: [{ ...selected, source: 'MANUAL' }],
      }),
    ).toBeUndefined();
  });
});

describe('request bodies', () => {
  it('builds the exact backend body shapes', () => {
    expect(accountSelectionBody(2, ['b', 'a'])).toEqual({
      expectedVersion: 2,
      accountMappingIds: ['b', 'a'],
    });
    expect(expectedVersionBody(3)).toEqual({ expectedVersion: 3 });
    expect(completeNewLinkBody('public-sandbox-x')).toEqual({
      publicToken: 'public-sandbox-x',
    });
  });
});
