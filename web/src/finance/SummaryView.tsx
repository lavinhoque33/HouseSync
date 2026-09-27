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
  const budget = summary.budget;
  const recurring = summary.recurring;
  const drivers = (
    title: string,
    dimension: InsightDimension,
    entries: SummaryDrivers,
  ) => (
    <section
      className="insights-summary-breakdown"
      key={dimension}
      aria-label={title}
    >
      <h4>{title}</h4>
      <ul className="insights-driver-list">
        {(['increases', 'decreases'] as const).flatMap((direction) =>
          entries[direction].map((group) => (
            <li className="insights-driver" key={group.key}>
              <button
                type="button"
                className="household-button household-button--secondary"
                onClick={() => onOpenDriver(dimension, group)}
                aria-label={`Open ${title} comparison, trend and both months' evidence for ${group.label}`}
              >
                {group.label}
              </button>
              <span className="insight-badge" data-tone="neutral">
                {direction === 'increases' ? 'Increase' : 'Decrease'}
              </span>
              <strong className="insight-number">
                {money(group.change.delta)}
              </strong>
              <details className="insight-notes">
                <summary>Amounts behind change</summary>
                <dl className="insight-facts">
                  <div>
                    <dt>Selected expenses</dt>
                    <dd>
                      {money(group.current.expenseTotal)} ·{' '}
                      {group.current.expenseCount} records
                    </dd>
                  </div>
                  <div>
                    <dt>Selected refunds</dt>
                    <dd>
                      {money(group.current.refundTotal)} ·{' '}
                      {group.current.refundCount} records
                    </dd>
                  </div>
                  <div>
                    <dt>Baseline expenses</dt>
                    <dd>
                      {money(group.baseline.expenseTotal)} ·{' '}
                      {group.baseline.expenseCount} records
                    </dd>
                  </div>
                  <div>
                    <dt>Baseline refunds</dt>
                    <dd>
                      {money(group.baseline.refundTotal)} ·{' '}
                      {group.baseline.refundCount} records
                    </dd>
                  </div>
                </dl>
              </details>
            </li>
          )),
        )}
      </ul>
      {entries.increases.length === 0 && entries.decreases.length === 0 && (
        <p className="insight-empty">No nonzero group changes.</p>
      )}
      <p className="insights-driver-residual">
        Other groups ·{' '}
        <strong className="insight-number">{money(entries.otherDelta)}</strong>
      </p>
      <details className="insight-notes">
        <summary>How these drivers add up</summary>
        <p>
          Largest positive and negative net changes are shown separately. Other
          includes all groups not listed. This breakdown independently
          reconciles to {money(summary.change.delta)}; do not add it to the
          other breakdown. These are arithmetic differences, not causes.
        </p>
      </details>
    </section>
  );
  return (
    <section
      className="insights-summary insight-panel"
      aria-label="Household Insights summary"
    >
      <div className="insight-panel__header">
        <h3>Overview</h3>
        <div className="insight-badges">
          <span className="insight-badge">
            {summary.period.month} vs {summary.baselinePeriod.month}
          </span>
          <span className="insight-badge">{summary.currency}</span>
          <span className="insight-badge" data-tone="neutral">
            {summary.period.state.replaceAll('_', ' ').toLowerCase()}
          </span>
          <span className="insight-badge" data-tone="neutral">
            Baseline{' '}
            {summary.baselinePeriod.state.replaceAll('_', ' ').toLowerCase()}
          </span>
        </div>
      </div>
      <div className="insight-metrics">
        {(
          [
            [
              'Net spending',
              summary.current.netSpending,
              summary.baseline.netSpending,
            ],
            [
              'Expenses',
              summary.current.expenseTotal,
              summary.baseline.expenseTotal,
            ],
            [
              'Refunds',
              summary.current.refundTotal,
              summary.baseline.refundTotal,
            ],
            [
              'Income · separate',
              summary.current.incomeTotal,
              summary.baseline.incomeTotal,
            ],
          ] as const
        ).map(([label, current, baseline]) => (
          <div className="insight-metric" key={label}>
            <span className="insight-metric__label">{label}</span>
            <strong className="insight-metric__value">{money(current)}</strong>
            <span className="insight-metric__note">
              Baseline {money(baseline)}
            </span>
          </div>
        ))}
      </div>
      <div className="insight-badges">
        <span className="insight-badge" data-tone="neutral">
          Net {summary.change.direction.toLowerCase()} ·{' '}
          {money(summary.change.delta)}
        </span>
        <span className="insight-badge" data-tone="neutral">
          {summary.change.percentChange === null
            ? `Percent unavailable: ${summary.change.percentUnavailableReason === 'BASELINE_ZERO' ? 'zero' : 'negative'} baseline`
            : `${summary.change.percentChange}% vs positive baseline`}
        </span>
        <span className="insight-badge">
          As of {summary.asOfDate} · {summary.reportingTimeZone}
        </span>
      </div>
      <details className="insight-notes">
        <summary>Period and calculation details</summary>
        <p>
          Selected month [{summary.period.from}, {summary.period.to}); baseline
          [{summary.baselinePeriod.from}, {summary.baselinePeriod.to}).
          Full-calendar-month posted facts currently disclosed, not complete
          bank coverage or a forecast. Future-dated posted facts may appear. Net
          is expenses less refunds; refund growth is not fewer purchases. Income
          is separate, not disposable income. The change is arithmetic, not an
          explanation of why spending changed.
        </p>
      </details>
      <section
        className="insights-summary-drivers"
        aria-label="Largest changes"
      >
        <h4>Largest group changes</h4>
        <div className="insights-summary-driver-grid">
          {drivers('Category changes', 'CATEGORY', summary.categoryDrivers)}
          {drivers(
            'Public description-group changes',
            'MERCHANT',
            summary.merchantDrivers,
          )}
        </div>
      </section>
      <div className="insights-summary-previews">
        <section className="insight-panel" aria-label="Monthly budget preview">
          <h4>Monthly budget · {summary.period.month}</h4>
          {budget.overall ? (
            <div className="insight-metrics">
              <div className="insight-metric">
                <span className="insight-metric__label">Overall target</span>
                <strong className="insight-metric__value">
                  {money(budget.overall.target.money.amount)}
                </strong>
                <span className="insight-metric__note">
                  {budget.overall.status.toLowerCase()} ·{' '}
                  {budget.overall.percentUsed === null
                    ? 'Percent unavailable (zero target)'
                    : `${budget.overall.percentUsed}% used`}
                </span>
              </div>
              <div className="insight-metric">
                <span className="insight-metric__label">Signed remaining</span>
                <strong className="insight-metric__value">
                  {money(budget.overall.remaining)}
                </strong>
                <span className="insight-metric__note">
                  Over by {money(budget.overall.overBy)}
                </span>
              </div>
            </div>
          ) : (
            <p className="insight-empty">
              No overall target set (different from a zero target).
            </p>
          )}
          <p>
            {budget.categories.length} category targets · untargeted net{' '}
            {money(budget.untargeted.netSpending)}
          </p>
          <details className="insight-notes">
            <summary>Budget amounts and category targets</summary>
            <p>
              Targets are household intent, not balances or affordability.
              Overall and category targets overlap; do not add their remaining
              amounts.
            </p>
            {budget.overall && (
              <p>
                Overall actual: expenses{' '}
                {money(budget.overall.actual.expenseTotal)} less refunds{' '}
                {money(budget.overall.actual.refundTotal)} = net{' '}
                {money(budget.overall.actual.netSpending)}.
              </p>
            )}
            {budget.categories.length ? (
              <div
                className="insights-scroll"
                role="region"
                tabIndex={0}
                aria-label="Summary category budget table"
              >
                <table>
                  <caption>
                    Category targets · {summary.currency},{' '}
                    {summary.period.month}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Category</th>
                      <th scope="col" className="insight-number">
                        Target
                      </th>
                      <th scope="col" className="insight-number">
                        Net actual
                      </th>
                      <th scope="col">Status</th>
                      <th scope="col" className="insight-number">
                        Signed remaining
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {budget.categories.map((item) => (
                      <tr key={item.target.id}>
                        <th scope="row">{item.target.bucket}</th>
                        <td className="insight-number">
                          {money(item.target.money.amount)}
                        </td>
                        <td className="insight-number">
                          {money(item.actual.netSpending)}
                        </td>
                        <td>
                          <span className="insight-badge">
                            {item.status.toLowerCase()}
                          </span>
                        </td>
                        <td className="insight-number">
                          {money(item.remaining)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>No category targets set.</p>
            )}
            {budget.categories.map((item) => (
              <p key={item.target.id}>
                {item.target.bucket}: expenses {money(item.actual.expenseTotal)}
                , refunds {money(item.actual.refundTotal)}, over by{' '}
                {money(item.overBy)},{' '}
                {item.percentUsed === null
                  ? 'percent unavailable (zero target)'
                  : `${item.percentUsed}% used`}
                .
              </p>
            ))}
            <p>
              Untargeted categories (not added to overall): expenses{' '}
              {money(budget.untargeted.expenseTotal)} less refunds{' '}
              {money(budget.untargeted.refundTotal)} = net{' '}
              {money(budget.untargeted.netSpending)}.
            </p>
          </details>
          <button
            type="button"
            className="household-button household-button--secondary"
            onClick={() => onFocusSection('insights-budget')}
          >
            Open monthly budget targets and management
          </button>
        </section>
        <section
          className="insight-panel"
          aria-label="Current recurring preview"
        >
          <h4>Current recurring review</h4>
          <div className="insight-badges">
            <span className="insight-badge">
              {recurring.openCandidateCount} open suggestions
            </span>
            <span className="insight-badge">
              {recurring.activePlanCount} active plans
            </span>
          </div>
          <p>
            Current evidence, not historical {summary.period.month}. Suggestions
            are not verified subscriptions; plans are intent, not payments or
            debt.
          </p>
          {recurring.items.length > 0 && (
            <details className="insight-notes">
              <summary>Preview active plans ({recurring.items.length})</summary>
              <ul className="recurring-cards">
                {recurring.items.map(({ plan, expectation }) => (
                  <li key={plan.id}>
                    <strong>{plan.label}</strong> ·{' '}
                    {plan.kind.replaceAll('_', ' ').toLowerCase()} ·{' '}
                    {plan.cadence.toLowerCase()}
                    <span className="insight-badge">
                      {expectation.latestState
                        .replaceAll('_', ' ')
                        .toLowerCase()}
                    </span>
                    <button
                      type="button"
                      className="household-button household-button--secondary"
                      aria-label={`Open current plan and observations for ${plan.label}, matching ${plan.matchDescription}`}
                      onClick={() => onFocusSection(`insights-plan-${plan.id}`)}
                    >
                      Open current plan and observations
                    </button>
                    <details className="insight-notes">
                      <summary>Schedule and observed amounts</summary>
                      <p>
                        Entered expected amount{' '}
                        {plan.expectedAmount === null
                          ? 'unknown/variable'
                          : money(plan.expectedAmount)}
                        . Latest scheduled{' '}
                        {expectation.latestExpectedOn ?? 'not started'}:{' '}
                        {expectation.matchedCount ?? 'no slot'} currently
                        disclosed matches
                        {expectation.observedAmount === null
                          ? ''
                          : `; observed expense ${money(expectation.observedAmount)}`}
                        . Next scheduled{' '}
                        {expectation.nextExpectedOn ?? 'schedule date limit'}.
                        One match does not verify payment; zero matches do not
                        prove unpaid or canceled.
                      </p>
                    </details>
                  </li>
                ))}
              </ul>
              {recurring.hasMore && (
                <p>
                  First five active plans shown; open the paged plan list to
                  continue.
                </p>
              )}
            </details>
          )}
          {recurring.items.length === 0 && (
            <p className="insight-empty">
              No active tracked plans in {summary.currency}. An owner may still
              add a manual plan.
            </p>
          )}
          <details className="insight-notes">
            <summary>Evidence and plan scope</summary>
            <p>
              Current evidence window [{recurring.evidenceFrom},{' '}
              {recurring.evidenceTo}) as of {summary.asOfDate}. Expected amounts
              are excluded from spending, budget, income and debt.
              Contributions, balances and settlements follow separate allocation
              and repayment policies.
            </p>
          </details>
          <div className="insight-actions">
            <button
              type="button"
              className="household-button household-button--secondary"
              onClick={() => onFocusSection('insights-recurring')}
            >
              Open suggestions and active plans
            </button>
            <button
              type="button"
              className="household-button household-button--secondary"
              onClick={() => onFocusSection('insights-m5')}
            >
              Open contributions and settlements
            </button>
          </div>
        </section>
      </div>
    </section>
  );
}
