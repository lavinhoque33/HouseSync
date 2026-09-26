import type { InsightDimension, InsightGroup } from './insights';
import type { InsightSummary, SummaryDrivers } from './summary';
import { formatMoney } from './money';

export function SummaryView({
  summary,
  onOpenDriver,
  onFocusSection,
}: {
  summary: InsightSummary;
  onOpenDriver: (dimension: InsightDimension, group: InsightGroup) => void;
  onFocusSection: (id: string) => void;
}) {
  const money = (value: string) => formatMoney(value, summary.currency);
  const driverTable = (
    title: string,
    dimension: InsightDimension,
    drivers: SummaryDrivers,
  ) => (
    <div className="insights-summary-breakdown" key={dimension}>
      <h6>{title}</h6>
      <p>
        Largest positive and negative net changes, separately; these are
        arithmetic differences, not causes. Other includes every group not
        shown.
      </p>
      <div
        className="insights-scroll"
        role="region"
        tabIndex={0}
        aria-label={`${title} driver table`}
      >
        <table>
          <caption>
            {title} · {summary.period.month} versus{' '}
            {summary.baselinePeriod.month}, {summary.currency}
          </caption>
          <thead>
            <tr>
              <th scope="col">Direction and group</th>
              <th scope="col">Current expenses</th>
              <th scope="col">Current refunds</th>
              <th scope="col">Baseline expenses</th>
              <th scope="col">Baseline refunds</th>
              <th scope="col">Exact net change</th>
            </tr>
          </thead>
          <tbody>
            {(['increases', 'decreases'] as const).flatMap((direction) =>
              drivers[direction].map((group) => (
                <tr key={group.key}>
                  <th scope="row">
                    <button
                      type="button"
                      className="household-button household-button--secondary"
                      onClick={() => onOpenDriver(dimension, group)}
                      aria-label={`Open ${title} comparison, trend and both months' evidence for ${group.label}`}
                    >
                      {direction === 'increases' ? 'Increase' : 'Decrease'} ·{' '}
                      {group.label}
                    </button>
                  </th>
                  <td>{money(group.current.expenseTotal)}</td>
                  <td>{money(group.current.refundTotal)}</td>
                  <td>{money(group.baseline.expenseTotal)}</td>
                  <td>{money(group.baseline.refundTotal)}</td>
                  <td>{money(group.change.delta)}</td>
                </tr>
              )),
            )}
            <tr>
              <th scope="row">Other groups (both directions)</th>
              <td colSpan={4}>Residual of all groups not shown</td>
              <td>{money(drivers.otherDelta)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {drivers.increases.length === 0 && drivers.decreases.length === 0 && (
        <p>No nonzero group changes to show.</p>
      )}
      <p>
        This breakdown independently reconciles to {money(summary.change.delta)}
        . Do not add it to the other breakdown.
      </p>
    </div>
  );
  const budget = summary.budget;
  const recurring = summary.recurring;
  return (
    <section
      className="insights-summary"
      aria-label="Household Insights summary"
    >
      <h5>
        Household summary · {summary.period.month} versus{' '}
        {summary.baselinePeriod.month}
      </h5>
      <p>
        {summary.currency} · {summary.reportingTimeZone} · as of{' '}
        {summary.asOfDate}. Selected month [{summary.period.from},{' '}
        {summary.period.to}){' '}
        {summary.period.state.replace('_', ' ').toLowerCase()}; baseline [
        {summary.baselinePeriod.from}, {summary.baselinePeriod.to}){' '}
        {summary.baselinePeriod.state.replace('_', ' ').toLowerCase()}. These
        are full-calendar-month facts currently disclosed, not bank coverage or
        a forecast. Future-dated posted facts may appear.
      </p>
      <p>
        Net spending changed by {money(summary.change.delta)} (
        {summary.change.direction.toLowerCase()}) from{' '}
        {money(summary.baseline.netSpending)} to{' '}
        {money(summary.current.netSpending)}. Expenses{' '}
        {money(summary.current.expenseTotal)} versus{' '}
        {money(summary.baseline.expenseTotal)}; refunds{' '}
        {money(summary.current.refundTotal)} versus{' '}
        {money(summary.baseline.refundTotal)}. Refund growth is not fewer
        purchases. Income, separately: {money(summary.current.incomeTotal)}{' '}
        versus {money(summary.baseline.incomeTotal)}; not disposable income.
      </p>
      <p>
        {summary.change.percentChange === null
          ? `Percent change unavailable: ${summary.change.percentUnavailableReason === 'BASELINE_ZERO' ? 'zero' : 'negative'} baseline.`
          : `${summary.change.percentChange}% relative to a positive baseline.`}{' '}
        The month comparison is arithmetic, not a claim about why spending
        changed.
      </p>
      {driverTable('Category changes', 'CATEGORY', summary.categoryDrivers)}
      {driverTable(
        'Public description-group changes',
        'MERCHANT',
        summary.merchantDrivers,
      )}
      <h6>Monthly budget · {summary.period.month}</h6>
      <p>
        Targets are separately published household intent, not balances or
        affordability. An overall target overlaps categories; never add their
        remaining amounts.
      </p>
      {budget.overall ? (
        <p>
          Overall target {money(budget.overall.target.money.amount)}; actual
          expenses {money(budget.overall.actual.expenseTotal)} less refunds{' '}
          {money(budget.overall.actual.refundTotal)} ={' '}
          {money(budget.overall.actual.netSpending)} net.{' '}
          {budget.overall.status.toLowerCase()} target; signed remaining{' '}
          {money(budget.overall.remaining)}, over by{' '}
          {money(budget.overall.overBy)}
          {budget.overall.percentUsed === null
            ? '; zero target — percent unavailable.'
            : `; ${budget.overall.percentUsed}% used.`}
        </p>
      ) : (
        <p>
          No overall target set for this month (different from a zero target).
        </p>
      )}
      {budget.categories.length > 0 ? (
        <div
          className="insights-scroll insights-summary-budget"
          role="region"
          tabIndex={0}
          aria-label="Summary category budget table"
        >
          <table>
            <caption>
              Active category targets in {summary.currency},{' '}
              {summary.period.month}
            </caption>
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Target</th>
                <th scope="col">Expenses</th>
                <th scope="col">Refunds</th>
                <th scope="col">Net actual</th>
                <th scope="col">Status</th>
                <th scope="col">Signed remaining</th>
                <th scope="col">Over by</th>
                <th scope="col">Used</th>
              </tr>
            </thead>
            <tbody>
              {budget.categories.map((item) => (
                <tr key={item.target.id}>
                  <th scope="row">{item.target.bucket}</th>
                  <td>{money(item.target.money.amount)}</td>
                  <td>{money(item.actual.expenseTotal)}</td>
                  <td>{money(item.actual.refundTotal)}</td>
                  <td>{money(item.actual.netSpending)}</td>
                  <td>{item.status}</td>
                  <td>{money(item.remaining)}</td>
                  <td>{money(item.overBy)}</td>
                  <td>
                    {item.percentUsed === null
                      ? 'Unavailable (zero target)'
                      : `${item.percentUsed}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>No category targets set for this month.</p>
      )}
      <p>
        Untargeted categories (not added to overall):{' '}
        {money(budget.untargeted.expenseTotal)} expenses less{' '}
        {money(budget.untargeted.refundTotal)} refunds ={' '}
        {money(budget.untargeted.netSpending)} net.
      </p>
      <button
        type="button"
        className="household-button household-button--secondary"
        onClick={() => onFocusSection('insights-budget')}
      >
        Open monthly budget targets and management
      </button>
      <h6>
        Current recurring review and tracked plans · not historical{' '}
        {summary.period.month}
      </h6>
      <p>
        Current evidence window [{recurring.evidenceFrom},{' '}
        {recurring.evidenceTo}) as of {summary.asOfDate}.{' '}
        {recurring.openCandidateCount} open possible recurring expenses without
        an active plan; {recurring.activePlanCount} active explicitly tracked
        household plans. Suggestions are conservative, not verified
        subscriptions. Plans are household intent, not payments; expected
        amounts are excluded from spending, budget, income and debt.
      </p>
      {recurring.items.length === 0 ? (
        <p>
          No active tracked plans in {summary.currency}. An owner may still add
          a manual plan.
        </p>
      ) : (
        <ul className="recurring-cards">
          {recurring.items.map(({ plan, expectation }) => (
            <li key={plan.id}>
              <strong>{plan.label}</strong> ·{' '}
              {plan.kind.replaceAll('_', ' ').toLowerCase()} ·{' '}
              {plan.cadence.toLowerCase()}. Entered expected amount{' '}
              {plan.expectedAmount === null
                ? 'unknown/variable'
                : money(plan.expectedAmount)}
              . Latest scheduled {expectation.latestExpectedOn ?? 'not started'}
              : {expectation.latestState.replaceAll('_', ' ').toLowerCase()} (
              {expectation.matchedCount ?? 'no slot'} currently disclosed
              matches
              {expectation.observedAmount === null
                ? ''
                : `; observed expense ${money(expectation.observedAmount)}`}
              ). Next scheduled{' '}
              {expectation.nextExpectedOn ?? 'schedule date limit'}. One match
              does not verify payment; zero matches do not prove unpaid or
              canceled.{' '}
              <button
                type="button"
                className="household-button household-button--secondary"
                aria-label={`Open current plan and observations for ${plan.label}, matching ${plan.matchDescription}`}
                onClick={() => onFocusSection(`insights-plan-${plan.id}`)}
              >
                Open current plan and observations
              </button>
            </li>
          ))}
        </ul>
      )}
      {recurring.hasMore && (
        <p>
          Only the first five active plans are shown here; open the paged plan
          list to continue.
        </p>
      )}
      <button
        type="button"
        className="household-button household-button--secondary"
        onClick={() => onFocusSection('insights-recurring')}
      >
        Open current suggestions and paged active plans
      </button>
      <p>
        Contributions, member balances and settlement suggestions use separate
        allocation and repayment policies; none are combined with these
        spending, budget or expected-plan values.
      </p>
      <button
        type="button"
        className="household-button household-button--secondary"
        onClick={() => onFocusSection('insights-m5')}
      >
        Open separate contributions and settlements
      </button>
    </section>
  );
}
