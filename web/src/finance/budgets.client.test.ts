import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBudgetTarget } from '../auth/client';

const householdId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const input = {
  month: '2026-09',
  bucket: 'GROCERIES',
  money: { amount: '10.00', currency: 'USD' as const },
};
const archived = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1',
  householdId,
  month: '2026-09',
  bucket: 'GROCERIES',
  money: { amount: '12.00', currency: 'USD' },
  status: 'ARCHIVED',
  version: 2,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-20T00:00:00Z',
};
afterEach(() => vi.unstubAllGlobals());
describe('budget durable create replay', () => {
  it('accepts the latest edited and archived representation while resending the original creation intent', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(archived), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const replay = await createBudgetTarget(
      householdId,
      input,
      '11111111-2222-4333-8444-555555555555',
      { token: 'csrf-token', headerName: 'X-CSRF-TOKEN' },
    );
    expect(replay.status).toBe('ARCHIVED');
    expect(replay.money.amount).toBe('12.00');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`/api/households/${householdId}/budget-targets`);
    expect(JSON.parse(init.body)).toEqual(input);
    expect(init.headers['Idempotency-Key']).toBe(
      '11111111-2222-4333-8444-555555555555',
    );
  });
});
