import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  fetchSettlementSuggestions,
  type Household,
  type SettlementSuggestions,
} from '../auth/client';
import { formatMoney, type FinancialAccountCurrency } from './money';

interface Props {
  household: Household;
  refreshSignal: number;
  onSessionExpired: () => void;
  onHouseholdAccessChanged: () => void;
}
const CURRENCIES: FinancialAccountCurrency[] = [
  'BRL',
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'JPY',
  'KWD',
];
export function SettlementSuggestionsSection({
  household,
  refreshSignal,
  onSessionExpired,
  onHouseholdAccessChanged,
}: Props) {
  const [currency, setCurrency] = useState<FinancialAccountCurrency>('USD');
  const [selected, setSelected] = useState<FinancialAccountCurrency | null>(
    null,
  );
  const [plan, setPlan] = useState<SettlementSuggestions | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const controllers = useRef<Set<AbortController>>(new Set());
  const lastRefresh = useRef(refreshSignal);
  const alert = useRef<HTMLDivElement>(null);
  useEffect(
    () => () => {
      generation.current++;
      for (const controller of controllers.current) controller.abort();
    },
    [],
  );
  useEffect(() => {
    if (notice) alert.current?.focus();
  }, [notice]);
  async function load(choice: FinancialAccountCurrency, cursor?: string) {
    const run = ++generation.current;
    const controller = new AbortController();
    controllers.current.add(controller);
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetchSettlementSuggestions(
        household.id,
        choice,
        50,
        cursor,
        controller.signal,
      );
      if (run !== generation.current || controller.signal.aborted) return;
      if (cursor && response.snapshot !== plan?.snapshot) {
        setPlan(null);
        setNotice('The plan changed. Start again with a fresh first page.');
        return;
      }
      setPlan(
        cursor && plan
          ? { ...response, items: [...plan.items, ...response.items] }
          : response,
      );
      setSelected(choice);
    } catch (error) {
      if (run !== generation.current || controller.signal.aborted) return;
      const problem =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not reach the server.',
            });
      if (problem.status === 401) {
        setPlan(null);
        onSessionExpired();
        return;
      }
      if (problem.code === 'HOUSEHOLD_NOT_FOUND') {
        setPlan(null);
        onHouseholdAccessChanged();
        return;
      }
      if (problem.code === 'SETTLEMENT_SNAPSHOT_STALE') {
        setPlan(null);
        setNotice(
          'Balances changed while reading this plan. Restart from the first page.',
        );
        return;
      }
      setNotice(
        cursor
          ? 'Could not load the next page. Previous suggestions may be stale; retry or restart.'
          : plan
            ? 'Could not refresh this plan. Previously shown suggestions may be stale; retry.'
            : problem.message,
      );
    } finally {
      controllers.current.delete(controller);
      if (run === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (lastRefresh.current === refreshSignal) return;
    lastRefresh.current = refreshSignal;
    if (selected) {
      // The old snapshot must disappear before a fresh household balance read.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPlan(null);
      void load(selected);
    }
    // A signal never changes the currency draft or another panel's form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);
  function submit(event: FormEvent) {
    event.preventDefault();
    setPlan(null);
    void load(currency);
  }
  return (
    <section
      className="settlement-section"
      aria-labelledby={`settlement-title-${household.id}`}
    >
      <h4 id={`settlement-title-${household.id}`} className="members-title">
        Settlement suggestions
      </h4>
      <p className="finance-helper">
        A read-only plan derived from current member balances, including
        confirmed external repayments. No money is sent, reserved or recorded
        here. A plan can change after a refund, departure or repayment; it does
        not identify who originally owed whom.
      </p>
      <form className="finance-filter-form" onSubmit={submit}>
        <label htmlFor={`settlement-currency-${household.id}`}>
          Plan currency
        </label>
        <select
          id={`settlement-currency-${household.id}`}
          value={currency}
          onChange={(event) =>
            setCurrency(event.target.value as FinancialAccountCurrency)
          }
        >
          {CURRENCIES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
        <button
          className="household-button household-button--secondary"
          disabled={busy}
          type="submit"
        >
          Show current plan
        </button>
      </form>
      {busy && <p role="status">Loading settlement suggestions…</p>}
      {notice && (
        <div
          role="alert"
          ref={alert}
          tabIndex={-1}
          className="household-notice household-notice--warning"
        >
          <p>{notice}</p>
          <button
            type="button"
            className="household-button household-button--secondary"
            disabled={busy}
            onClick={() => void load(selected ?? currency)}
          >
            Restart plan
          </button>
        </div>
      )}
      {plan && (
        <div>
          <p className="finance-helper">
            Current members only · {plan.currency} · snapshot{' '}
            {plan.snapshot.slice(0, 12)}. Departed members cannot be included in
            a suggested payment.
          </p>
          {plan.items.length === 0 && (
            <p role="status">
              No current-member transfer suggested in {plan.currency}.
            </p>
          )}
          <ul
            className="member-balances-rows"
            aria-label={`Suggested transfers in ${plan.currency}`}
          >
            {plan.items.map((item, index) => (
              <li
                className="member-balance-row"
                key={`${plan.snapshot}-${index}`}
              >
                <span className="member-balance-uuid">{item.senderUserId}</span>{' '}
                →{' '}
                <span className="member-balance-uuid">
                  {item.recipientUserId}
                </span>
                : {formatMoney(item.money.amount, item.money.currency)}
              </li>
            ))}
          </ul>
          {plan.nextCursor && (
            <button
              type="button"
              className="household-button household-button--secondary"
              disabled={busy}
              onClick={() =>
                void load(plan.currency, plan.nextCursor ?? undefined)
              }
            >
              Load more suggestions
            </button>
          )}
          <p>
            Full-plan residuals (not just this page): current debt{' '}
            {formatMoney(plan.residuals.currentDebtAfterPlan, plan.currency)},
            current credit{' '}
            {formatMoney(plan.residuals.currentCreditAfterPlan, plan.currency)},
            departed debt{' '}
            {formatMoney(plan.residuals.departedDebt, plan.currency)}, departed
            credit {formatMoney(plan.residuals.departedCredit, plan.currency)}.
            Residual amounts may remain even after all suggestions.
          </p>
        </div>
      )}
    </section>
  );
}
