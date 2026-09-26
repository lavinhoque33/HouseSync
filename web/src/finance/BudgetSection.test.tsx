import { useState } from 'react';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Household } from '../auth/client';
import { BudgetSection, type PendingBudgetCreate } from './BudgetSection';

const getProgress = vi.fn();
const getTargets = vi.fn();
const getTarget = vi.fn();
const post = vi.fn();
const patch = vi.fn();
vi.mock('../auth/client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  fetchBudgetProgress: (...args: unknown[]) => getProgress(...args),
  fetchBudgetTargets: (...args: unknown[]) => getTargets(...args),
  fetchBudgetTarget: (...args: unknown[]) => getTarget(...args),
  createBudgetTarget: (...args: unknown[]) => post(...args),
  patchBudgetTarget: (...args: unknown[]) => patch(...args),
}));
const home: Household = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  name: 'Home',
  role: 'OWNER',
  createdAt: '2026-01-01T00:00:00Z',
};
const csrf = { token: 'csrf' } as never;
const target = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1',
  householdId: home.id,
  month: '2026-09',
  bucket: 'OVERALL',
  money: { amount: '0.00', currency: 'USD' },
  status: 'ACTIVE',
  version: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const zero = {
  expenseTotal: '0.00',
  refundTotal: '0.00',
  netSpending: '0.00',
  expenseCount: '0',
  refundCount: '0',
};
const progress = (overall: unknown = null) => ({
  reportingTimeZone: 'Etc/UTC',
  asOfDate: '2026-09-25',
  currency: 'USD',
  policyVersion: 'BUDGETS_V1',
  snapshot: 'a'.repeat(64),
  period: {
    month: '2026-09',
    from: '2026-09-01',
    to: '2026-10-01',
    state: 'IN_PROGRESS',
  },
  totals: zero,
  overall,
  categories: [],
  untargeted: zero,
});
function BudgetHarness({
  role = 'OWNER',
  month = '2026-09',
  currency = 'USD',
}: {
  role?: Household['role'];
  month?: string;
  currency?: 'USD' | 'BRL';
}) {
  const [pending, setPending] = useState<PendingBudgetCreate | null>(null);
  return (
    <BudgetSection
      key={`${role}:${month}:${currency}`}
      household={{ ...home, role }}
      month={month}
      currency={currency}
      reportingZone="Etc/UTC"
      refreshSignal={0}
      csrf={csrf}
      onCsrfRefreshed={vi.fn()}
      onSessionExpired={vi.fn()}
      onHouseholdAccessChanged={vi.fn()}
      pending={pending}
      setPending={setPending}
    />
  );
}
function mount(role: Household['role'] = 'OWNER') {
  return render(<BudgetHarness role={role} />);
}
afterEach(() => vi.clearAllMocks());
describe('monthly household budgets', () => {
  it('keeps no target separate from deliberate zero; members see exact progress but cannot write', async () => {
    getProgress.mockResolvedValueOnce(progress()).mockResolvedValue(
      progress({
        target,
        actual: zero,
        remaining: '0.00',
        overBy: '0.00',
        percentUsed: null,
        status: 'AT',
      }),
    );
    const view = mount('MEMBER');
    expect(await screen.findByText(/No overall target set/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Refresh budget and current records',
      }),
    );
    const table = await screen.findByRole('region', {
      name: 'Exact budget progress table',
    });
    expect(within(table).getByText(/deliberate zero target/)).toBeTruthy();
    expect(within(table).getByText('Unavailable: zero target')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Create monthly target' }),
    ).toBeNull();
    view.unmount();
  });
  it('reviews creation disclosure and retries unknown outcome with the exact same body/key; success closes and focuses status', async () => {
    getProgress.mockResolvedValue(progress());
    post
      .mockRejectedValueOnce(
        new ApiError({
          status: 0,
          code: 'NETWORK_ERROR',
          message: 'Connection interrupted',
        }),
      )
      .mockResolvedValue(target);
    mount();
    await screen.findByText(/No overall target set/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Create monthly target' }),
    );
    fireEvent.change(
      screen.getByRole('textbox', { name: /Nonnegative target amount/ }),
      { target: { value: '0' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review target' }));
    expect(
      screen.getByText(/Zero is a deliberate no-spending target/),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /confirm this household-wide target/,
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Create or retry same target' }),
    );
    await screen.findByText(/Connection interrupted/);
    expect(
      screen.getByRole('button', { name: 'Review same creation' }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Review same creation' }),
    );
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /confirm this household-wide target/,
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Create or retry same target' }),
    );
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[0]?.[1]).toEqual(post.mock.calls[1]?.[1]);
    expect(post.mock.calls[0]?.[2]).toEqual(post.mock.calls[1]?.[2]);
    expect(post.mock.calls[0]?.[1].money.amount).toBe('0.00');
    const status = await screen.findByRole('status', { name: '' });
    await waitFor(() =>
      expect(screen.getByText(/target created for 2026-09/)).toBe(
        document.activeElement,
      ),
    );
    expect(status).toBeTruthy();
  });
  it('does not rotate an uncertain creation key after cancel and a new-create click', async () => {
    getProgress.mockResolvedValue(progress());
    post
      .mockRejectedValueOnce(
        new ApiError({
          status: 0,
          code: 'NETWORK_ERROR',
          message: 'Connection interrupted',
        }),
      )
      .mockResolvedValue({
        ...target,
        money: { amount: '10.00', currency: 'USD' },
        status: 'ARCHIVED',
        version: 2,
      });
    mount();
    await screen.findByText(/No overall target set/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Create monthly target' }),
    );
    fireEvent.change(
      screen.getByRole('textbox', { name: /Nonnegative target amount/ }),
      { target: { value: '8' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review target' }));
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /confirm this household-wide target/,
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Create or retry same target' }),
    );
    await screen.findByText(/Connection interrupted/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      screen.getByRole('button', { name: 'Recover pending target' }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Create monthly target' }),
    );
    expect(
      screen.getByRole('textbox', { name: /Nonnegative target amount/ }),
    ).toHaveProperty('value', '8.00');
    expect(
      screen
        .getByRole('textbox', { name: /Nonnegative target amount/ })
        .hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole('button', { name: 'Review same creation' }),
    );
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /confirm this household-wide target/,
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Create or retry same target' }),
    );
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1]?.[1]).toEqual(post.mock.calls[0]?.[1]);
    expect(post.mock.calls[1]?.[2]).toBe(post.mock.calls[0]?.[2]);
    expect(
      await screen.findByText(/already recorded and is now archived/),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Recover pending target' }),
    ).toBeNull();
  });
  it('keeps an uncertain create across applied month/currency remounts and replays its original body', async () => {
    getProgress.mockResolvedValue(progress());
    post
      .mockRejectedValueOnce(
        new ApiError({
          status: 0,
          code: 'NETWORK_ERROR',
          message: 'Connection interrupted',
        }),
      )
      .mockResolvedValue({
        ...target,
        bucket: 'DINING',
        money: { amount: '12.34', currency: 'USD' },
      });
    const view = mount();
    await screen.findByText(/No overall target set/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Create monthly target' }),
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Bucket' }), {
      target: { value: 'DINING' },
    });
    fireEvent.change(
      screen.getByRole('textbox', { name: /Nonnegative target amount/ }),
      { target: { value: '12.34' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review target' }));
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /confirm this household-wide target/,
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Create or retry same target' }),
    );
    await screen.findByText(/Connection interrupted/);
    view.rerender(<BudgetHarness month="2026-08" currency="BRL" />);
    expect(
      await screen.findByRole('button', { name: 'Recover pending target' }),
    ).toBeTruthy();
    expect(screen.getByText(/12.34 USD/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Recover pending target' }),
    );
    expect(
      screen.getByRole('textbox', { name: /Nonnegative target amount · USD/ }),
    ).toHaveProperty('value', '12.34');
    fireEvent.click(
      screen.getByRole('button', { name: 'Review same creation' }),
    );
    expect(screen.getByText(/target for 2026-09 in USD/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /confirm this household-wide target/,
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Create or retry same target' }),
    );
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1]?.[1]).toEqual(post.mock.calls[0]?.[1]);
    expect(post.mock.calls[1]?.[2]).toBe(post.mock.calls[0]?.[2]);
    expect(
      screen.queryByRole('button', { name: 'Recover pending target' }),
    ).toBeNull();
  });
  it('reloads authoritative version on stale edit and requires a newly reviewed confirmation', async () => {
    const active = {
      target,
      actual: zero,
      remaining: '0.00',
      overBy: '0.00',
      percentUsed: null,
      status: 'AT',
    };
    getProgress.mockResolvedValue(progress(active));
    getTarget.mockResolvedValue({ ...target, version: 2 });
    patch
      .mockRejectedValueOnce(
        new ApiError({
          status: 409,
          code: 'RESOURCE_VERSION_CONFLICT',
          message: 'Stale version',
        }),
      )
      .mockResolvedValue({
        ...target,
        money: { amount: '1.00', currency: 'USD' },
        version: 3,
      });
    mount();
    const edit = await screen.findByRole('button', { name: 'Edit Overall' });
    fireEvent.click(edit);
    fireEvent.change(
      screen.getByRole('textbox', { name: /Nonnegative target amount/ }),
      { target: { value: '1' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review target' }));
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /confirm this household-wide target/,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save amount' }));
    await waitFor(() => expect(getTarget).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Save amount' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review target' }));
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /confirm this household-wide target/,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save amount' }));
    await waitFor(() =>
      expect(patch.mock.calls[1]?.[2]).toMatchObject({
        expectedVersion: 2,
        amount: '1.00',
      }),
    );
  });
  it('requires terminal archive review and returns focus on cancellation', async () => {
    getProgress.mockResolvedValue(
      progress({
        target,
        actual: zero,
        remaining: '0.00',
        overBy: '0.00',
        percentUsed: null,
        status: 'AT',
      }),
    );
    patch.mockResolvedValue({ ...target, status: 'ARCHIVED', version: 1 });
    const view = mount();
    const action = await screen.findByRole('button', {
      name: 'Archive Overall',
    });
    fireEvent.click(action);
    expect(screen.getByText(/Archiving is terminal/)).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Confirm archive' })
        .hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel archive' }));
    await waitFor(() => expect(action).toBe(document.activeElement));
    expect(patch).not.toHaveBeenCalled();
    fireEvent.click(action);
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /confirm this household-wide archive/,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm archive' }));
    await waitFor(() =>
      expect(patch.mock.calls[0]?.[2]).toEqual({
        expectedVersion: 0,
        status: 'ARCHIVED',
      }),
    );
    view.unmount();
  });
  it('pauses reviewed writes while offline and refreshes on reconnect without dropping the draft', async () => {
    getProgress.mockResolvedValue(progress());
    mount();
    await screen.findByText(/No overall target set/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Create monthly target' }),
    );
    fireEvent.change(
      screen.getByRole('textbox', { name: /Nonnegative target amount/ }),
      { target: { value: '2.00' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review target' }));
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /confirm this household-wide target/,
      }),
    );
    fireEvent(window, new Event('offline'));
    expect(screen.getByText(/Offline. Budget reads may be stale/)).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Create or retry same target' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(post).not.toHaveBeenCalled();
    fireEvent(window, new Event('online'));
    await waitFor(() => expect(getProgress).toHaveBeenCalledTimes(2));
    expect(
      screen.getByRole('textbox', { name: /Nonnegative target amount/ }),
    ).toHaveProperty('value', '2.00');
  });
});
