import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from 'react';
import {
  ApiError,
  createBudgetTarget,
  fetchBudgetProgress,
  fetchBudgetTarget,
  fetchBudgetTargets,
  fetchCsrf,
  patchBudgetTarget,
  type CsrfToken,
  type Household,
} from '../auth/client';
import {
  isBudgetBucket,
  normalizeTargetAmount,
  type BudgetBucket,
  type BudgetProgress,
  type BudgetProgressItem,
  type BudgetTarget,
  type CreateBudgetTarget,
} from './budgets';
import { isInsightMonth } from './insights';
import { formatMoney, type FinancialAccountCurrency } from './money';

const buckets = [
  'OVERALL',
  'UNCATEGORIZED',
  'HOUSING',
  'GROCERIES',
  'DINING',
  'UTILITIES',
  'TRANSPORTATION',
  'SHOPPING',
  'ENTERTAINMENT',
  'HEALTHCARE',
  'TRAVEL',
  'EDUCATION',
  'PERSONAL',
  'HOUSEHOLD_SUPPLIES',
  'SUBSCRIPTIONS',
  'INCOME',
  'TRANSFERS',
  'MISCELLANEOUS',
];
type Draft = { month: string; bucket: BudgetBucket; amount: string };
export type PendingBudgetCreate = {
  key: string;
  input: CreateBudgetTarget;
  attempted: boolean;
};
const label = (bucket: string) =>
  bucket === 'OVERALL'
    ? 'Overall'
    : bucket === 'UNCATEGORIZED'
      ? 'Uncategorized'
      : bucket.replaceAll('_', ' ').toLowerCase();
const errorText = (error: unknown) =>
  error instanceof ApiError
    ? error.code === 'BUDGET_TARGET_CONFLICT'
      ? 'An active target already exists for this month, currency and bucket, or this target was archived. Reload and review before deciding.'
      : error.code === 'RESOURCE_VERSION_CONFLICT'
        ? 'This target changed. Its latest version has been loaded; review and confirm again.'
        : error.code === 'RESOURCE_VERSION_EXHAUSTED'
          ? 'This target has reached its version limit and cannot be changed.'
          : error.code === 'IDEMPOTENCY_CONFLICT'
            ? 'The creation key conflicts with a different request. Reload before another decision.'
            : error.code === 'CSRF_INVALID'
              ? 'Security token expired. Review and confirm again.'
              : error.message || 'Budget request failed. Reload and try again.'
    : 'The outcome is unknown. Check current records, or retry the same create request.';
const countText = (count: string, singular: string) =>
  `${count} ${singular}${count === '1' ? '' : 's'}`;
function ProgressRow({
  item,
  currency,
}: {
  item: BudgetProgressItem;
  currency: FinancialAccountCurrency;
}) {
  return (
    <tr>
      <th scope="row">{label(item.target.bucket)}</th>
      <td>
        {formatMoney(item.target.money.amount, currency)}
        {item.target.money.amount.replace('.', '').replace(/^0+/, '') === ''
          ? ' (deliberate zero target)'
          : ''}
      </td>
      <td>
        {formatMoney(item.actual.expenseTotal, currency)} expenses less{' '}
        {formatMoney(item.actual.refundTotal, currency)} refunds (
        {countText(item.actual.expenseCount, 'expense')},{' '}
        {countText(item.actual.refundCount, 'refund')})
      </td>
      <td>{formatMoney(item.actual.netSpending, currency)}</td>
      <td>{formatMoney(item.remaining, currency)}</td>
      <td>{formatMoney(item.overBy, currency)}</td>
      <td>
        {item.percentUsed === null
          ? 'Unavailable: zero target'
          : `${item.percentUsed}%`}
      </td>
      <td>{item.status}</td>
    </tr>
  );
}
export function BudgetSection({
  household,
  month,
  currency,
  reportingZone,
  refreshSignal,
  csrf,
  onCsrfRefreshed,
  onSessionExpired,
  onHouseholdAccessChanged,
  pending,
  setPending,
}: {
  household: Household;
  month: string;
  currency: FinancialAccountCurrency;
  reportingZone: string;
  refreshSignal: number;
  csrf: CsrfToken | null;
  onCsrfRefreshed: (csrf: CsrfToken) => void;
  onSessionExpired: () => void;
  onHouseholdAccessChanged: () => void;
  pending: PendingBudgetCreate | null;
  setPending: Dispatch<SetStateAction<PendingBudgetCreate | null>>;
}) {
  const owner = household.role === 'OWNER';
  const [progress, setProgress] = useState<BudgetProgress | null>(null);
  const [history, setHistory] = useState<BudgetTarget[]>([]);
  const [historyMore, setHistoryMore] = useState(false);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [draft, setDraft] = useState<Draft>({
    month,
    bucket: 'OVERALL',
    amount: '',
  });
  const [editing, setEditing] = useState<BudgetTarget | null>(null);
  const [archiving, setArchiving] = useState<BudgetTarget | null>(null);
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState(false);
  const creationCurrency =
    !editing && pending?.attempted ? pending.input.money.currency : currency;
  const [ack, setAck] = useState(false);
  const generation = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const errorRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const csrfRef = useRef(csrf);
  useEffect(() => {
    csrfRef.current = csrf;
  }, [csrf]);
  function clear() {
    generation.current++;
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
    setProgress(null);
    setHistory([]);
    setPending(null);
    setOpen(false);
    setEditing(null);
    setArchiving(null);
    setReview(false);
    setDraft({ month, bucket: 'OVERALL', amount: '' });
  }
  function handleScope(failure: unknown) {
    if (!(failure instanceof ApiError)) return false;
    if (failure.status === 401) {
      clear();
      onSessionExpired();
      return true;
    }
    if (
      failure.code === 'HOUSEHOLD_NOT_FOUND' ||
      (failure.status === 404 && failure.code !== 'BUDGET_TARGET_NOT_FOUND')
    ) {
      clear();
      onHouseholdAccessChanged();
      return true;
    }
    if (failure.status === 403) {
      clear();
      onHouseholdAccessChanged();
      return true;
    }
    return false;
  }
  function controller() {
    const next = new AbortController();
    controllers.current.add(next);
    return next;
  }
  useEffect(
    () => () => {
      generation.current++;
      for (const item of controllers.current) item.abort();
      controllers.current.clear();
    },
    [],
  );
  useEffect(() => {
    const offline = () => setOnline(false);
    const connected = () => {
      setOnline(true);
      setRevision((value) => value + 1);
    };
    window.addEventListener('offline', offline);
    window.addEventListener('online', connected);
    return () => {
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', connected);
    };
  }, []);
  useEffect(() => {
    const current = ++generation.current;
    for (const item of controllers.current) item.abort();
    controllers.current.clear();
    const request = controller();
    void Promise.resolve().then(() => {
      if (generation.current !== current) return;
      setLoading(true);
      setProgress(null);
      setHistory([]);
      setError('');
    });
    void Promise.all([
      fetchBudgetProgress(household.id, month, currency, request.signal),
      showHistory
        ? fetchBudgetTargets(
            household.id,
            month,
            currency,
            'ARCHIVED',
            100,
            0,
            request.signal,
          )
        : Promise.resolve(null),
    ])
      .then(([report, page]) => {
        if (request.signal.aborted || generation.current !== current) return;
        setProgress(report);
        if (page) {
          setHistory(page.items);
          setHistoryOffset(page.items.length);
          setHistoryMore(page.hasMore);
        }
      })
      .catch((failure: unknown) => {
        if (request.signal.aborted || generation.current !== current) return;
        if (!handleScope(failure)) setError(errorText(failure));
      })
      .finally(() => {
        controllers.current.delete(request);
        if (!request.signal.aborted && generation.current === current)
          setLoading(false);
      });
    return () => request.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    household.id,
    household.role,
    month,
    currency,
    reportingZone,
    refreshSignal,
    revision,
    showHistory,
  ]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (message) statusRef.current?.focus();
  }, [message]);
  function openCreate(prefill?: BudgetTarget) {
    setEditing(null);
    setArchiving(null);
    setReview(false);
    setAck(false);
    setError('');
    setMessage('');
    if (pending?.attempted) {
      setDraft({
        month: pending.input.month,
        bucket: pending.input.bucket,
        amount: pending.input.money.amount,
      });
    } else {
      setPending(null);
      setDraft(
        prefill
          ? { month, bucket: prefill.bucket, amount: prefill.money.amount }
          : { month, bucket: 'OVERALL', amount: '' },
      );
    }
    setOpen(true);
    window.setTimeout(() => amountRef.current?.focus(), 0);
  }
  function openEdit(item: BudgetTarget) {
    setEditing(item);
    setArchiving(null);
    if (!pending?.attempted) setPending(null);
    setReview(false);
    setAck(false);
    setError('');
    setMessage('');
    setDraft({
      month: item.month,
      bucket: item.bucket,
      amount: item.money.amount,
    });
    setOpen(true);
    window.setTimeout(() => amountRef.current?.focus(), 0);
  }
  function close() {
    setOpen(false);
    setEditing(null);
    setArchiving(null);
    if (!pending?.attempted) setPending(null);
    setReview(false);
    setAck(false);
    setError('');
    window.setTimeout(
      () => (actionRef.current ?? createRef.current)?.focus(),
      0,
    );
  }
  function prepare(event: FormEvent) {
    event.preventDefault();
    const value = normalizeTargetAmount(draft.amount, creationCurrency);
    if (
      !isInsightMonth(draft.month) ||
      !isBudgetBucket(draft.bucket) ||
      value === null
    ) {
      setError(
        'Choose a supported full month, bucket, and nonnegative amount of at most 12 whole digits at the selected currency scale.',
      );
      amountRef.current?.focus();
      return;
    }
    if (editing && value === editing.money.amount) {
      setError('Enter a different amount, or cancel the edit.');
      amountRef.current?.focus();
      return;
    }
    if (!editing && !pending?.attempted)
      setPending({
        key: crypto.randomUUID(),
        input: {
          month: draft.month,
          bucket: draft.bucket,
          money: { amount: value, currency: creationCurrency },
        },
        attempted: false,
      });
    setError('');
    setReview(true);
    setAck(false);
  }
  async function token() {
    return (
      csrfRef.current ??
      fetchCsrf().then((value) => {
        onCsrfRefreshed(value);
        return value;
      })
    );
  }
  async function reloadTarget(item: BudgetTarget) {
    try {
      const fresh = await fetchBudgetTarget(household.id, item.id);
      if (fresh.status !== 'ACTIVE') {
        setOpen(false);
        setArchiving(null);
      } else {
        setEditing(fresh);
        setArchiving((old) => (old ? fresh : null));
      }
      setRevision((value) => value + 1);
    } catch (failure) {
      if (!handleScope(failure)) setError(errorText(failure));
    }
  }
  async function submit() {
    if (!owner || !online || working || !ack || !review || !open) return;
    const value = normalizeTargetAmount(draft.amount, creationCurrency);
    if (!value || !isInsightMonth(draft.month) || !isBudgetBucket(draft.bucket))
      return;
    if (
      !editing &&
      (!pending ||
        pending.input.month !== draft.month ||
        pending.input.bucket !== draft.bucket ||
        pending.input.money.amount !== value)
    )
      return;
    const request = controller();
    const current = generation.current;
    setWorking(true);
    setError('');
    try {
      const security = await token();
      if (request.signal.aborted || generation.current !== current) return;
      if (!editing)
        setPending((current) =>
          current ? { ...current, attempted: true } : null,
        );
      const saved = editing
        ? await patchBudgetTarget(
            household.id,
            editing.id,
            { expectedVersion: editing.version, amount: value },
            security,
            request.signal,
          )
        : await createBudgetTarget(
            household.id,
            pending!.input,
            pending!.key,
            security,
            request.signal,
          );
      if (request.signal.aborted || generation.current !== current) return;
      if (!editing) setPending(null);
      setOpen(false);
      setEditing(null);
      setReview(false);
      setAck(false);
      setMessage(
        saved.status === 'ARCHIVED'
          ? `${label(saved.bucket)} creation was already recorded and is now archived; current progress is refreshing.`
          : `${label(saved.bucket)} target ${editing ? 'updated' : 'created'} for ${saved.month}. Current progress is refreshing.`,
      );
      setRevision((before) => before + 1);
    } catch (failure) {
      if (request.signal.aborted || generation.current !== current) return;
      if (handleScope(failure)) return;
      if (
        failure instanceof ApiError &&
        (failure.code === 'RESOURCE_VERSION_CONFLICT' ||
          failure.code === 'BUDGET_TARGET_CONFLICT' ||
          failure.code === 'BUDGET_TARGET_NOT_FOUND')
      ) {
        setReview(false);
        setAck(false);
        if (!editing) setPending(null);
        if (editing) await reloadTarget(editing);
        else setRevision((before) => before + 1);
      } else if (
        !(failure instanceof ApiError) ||
        failure.code === 'NETWORK_ERROR' ||
        failure.timedOut
      ) {
        // Keep an uncertain create's identical body/key. PATCH has no key:
        // inspect the current target before proposing another versioned edit.
        setReview(false);
        setAck(false);
        if (editing) await reloadTarget(editing);
        else setRevision((before) => before + 1);
      }
      setError(errorText(failure));
    } finally {
      controllers.current.delete(request);
      setWorking(false);
    }
  }
  async function archive() {
    if (!owner || !online || !archiving || !ack || working) return;
    const target = archiving;
    const request = controller();
    const current = generation.current;
    setWorking(true);
    setError('');
    try {
      const security = await token();
      if (request.signal.aborted || generation.current !== current) return;
      await patchBudgetTarget(
        household.id,
        target.id,
        { expectedVersion: target.version, status: 'ARCHIVED' },
        security,
        request.signal,
      );
      if (request.signal.aborted || generation.current !== current) return;
      setArchiving(null);
      setAck(false);
      setMessage(
        `${label(target.bucket)} target archived. Current progress is refreshing.`,
      );
      setRevision((before) => before + 1);
    } catch (failure) {
      if (request.signal.aborted || generation.current !== current) return;
      if (handleScope(failure)) return;
      if (
        failure instanceof ApiError &&
        (failure.code === 'RESOURCE_VERSION_CONFLICT' ||
          failure.code === 'BUDGET_TARGET_CONFLICT' ||
          failure.code === 'BUDGET_TARGET_NOT_FOUND')
      ) {
        setAck(false);
        await reloadTarget(target);
      } else if (
        !(failure instanceof ApiError) ||
        failure.code === 'NETWORK_ERROR' ||
        failure.timedOut
      ) {
        setAck(false);
        await reloadTarget(target);
      }
      setError(errorText(failure));
    } finally {
      controllers.current.delete(request);
      setWorking(false);
    }
  }
  async function loadHistory() {
    if (!historyMore || loading || historyOffset >= 10000) return;
    const request = controller();
    const current = generation.current;
    try {
      const page = await fetchBudgetTargets(
        household.id,
        month,
        currency,
        'ARCHIVED',
        100,
        historyOffset,
        request.signal,
      );
      if (request.signal.aborted || generation.current !== current) return;
      setHistory((rows) => [...rows, ...page.items]);
      setHistoryOffset(historyOffset + page.items.length);
      setHistoryMore(page.hasMore);
    } catch (failure) {
      if (
        !request.signal.aborted &&
        generation.current === current &&
        !handleScope(failure)
      )
        setError(errorText(failure));
    } finally {
      controllers.current.delete(request);
    }
  }
  const active = progress
    ? [progress.overall, ...progress.categories].filter(
        (item): item is BudgetProgressItem => item !== null,
      )
    : [];
  return (
    <section
      className="budget-section"
      aria-label="Monthly household budget targets"
    >
      <h5>
        Monthly budget targets · {month} · {currency}
      </h5>
      <p>
        Household planning intent, not a balance, allocation, spending limit or
        recurring template. Current disclosed POSTED expenses less refunds only;
        corrections, category changes and sharing changes restate past spending.
        Overall overlaps category targets and is never added to them. Targets
        for other months are not created automatically.
      </p>
      {progress && (
        <p>
          Full month {progress.period.from} to {progress.period.to} (exclusive),{' '}
          {progress.period.state.toLowerCase().replace('_', ' ')}; as of{' '}
          {progress.asOfDate} in {progress.reportingTimeZone}. Future-dated
          posted shared spending can appear even for future months. Totals:{' '}
          {formatMoney(progress.totals.expenseTotal, currency)} expenses less{' '}
          {formatMoney(progress.totals.refundTotal, currency)} refunds ={' '}
          {formatMoney(progress.totals.netSpending, currency)} net (
          {countText(progress.totals.expenseCount, 'expense')},{' '}
          {countText(progress.totals.refundCount, 'refund')}).
        </p>
      )}
      {owner ? (
        <button
          className="household-button"
          ref={createRef}
          type="button"
          onClick={() => openCreate()}
        >
          Create monthly target
        </button>
      ) : (
        <p>
          Only a current household owner can create, edit or archive targets.
          Members can read shared progress and history.
        </p>
      )}
      {owner && pending?.attempted && (
        <div className="budget-review" role="status">
          An earlier {label(pending.input.bucket)} target for{' '}
          {pending.input.month} (
          {formatMoney(
            pending.input.money.amount,
            pending.input.money.currency,
          )}
          ) has an unknown creation outcome. A new creation cannot start until
          its request is resolved.
          <button
            className="household-button"
            type="button"
            onClick={() => openCreate()}
          >
            Recover pending target
          </button>
        </div>
      )}
      <button
        className="household-button household-button--secondary"
        type="button"
        onClick={() => setRevision((value) => value + 1)}
      >
        Refresh budget and current records
      </button>
      {!online && (
        <p role="status">
          Offline. Budget reads may be stale; edits are paused. Reconnect to
          refresh current records. Any uncertain create keeps its exact retry
          request in memory.
        </p>
      )}
      {loading && <p role="status">Loading current budget progress…</p>}
      {error && (
        <div
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          className="household-notice household-notice--error"
        >
          {error}{' '}
          <button
            type="button"
            className="household-button"
            onClick={() => setRevision((value) => value + 1)}
          >
            Reload current budgets
          </button>
        </div>
      )}
      {message && (
        <p ref={statusRef} tabIndex={-1} role="status">
          {message}
        </p>
      )}
      {progress && (
        <>
          {!progress.overall && (
            <p>
              No overall target set. This is not a zero target; the full-month
              spending above still counts.
            </p>
          )}
          {progress.categories.length === 0 && (
            <p>
              No category targets set. Untargeted spending is still shown below.
            </p>
          )}
          {active.length > 0 && (
            <div
              className="insights-scroll"
              role="region"
              aria-label="Exact budget progress table"
              tabIndex={0}
            >
              <table>
                <caption>
                  Exact signed progress for {month}, {currency}; overall
                  overlaps category rows, not an additional amount
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Scope</th>
                    <th scope="col">Target</th>
                    <th scope="col">Expenses and refunds</th>
                    <th scope="col">Net actual</th>
                    <th scope="col">Signed remaining</th>
                    <th scope="col">Over by</th>
                    <th scope="col">Used</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {active.map((item) => (
                    <ProgressRow
                      key={item.target.id}
                      item={item}
                      currency={currency}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p>
            Without an active category target:{' '}
            {formatMoney(progress.untargeted.expenseTotal, currency)} expenses
            less {formatMoney(progress.untargeted.refundTotal, currency)}{' '}
            refunds = {formatMoney(progress.untargeted.netSpending, currency)}{' '}
            net ({countText(progress.untargeted.expenseCount, 'expense')},{' '}
            {countText(progress.untargeted.refundCount, 'refund')}). This is
            included in overall actual when an overall target exists.
          </p>
          {active.length > 0 && (
            <ul className="budget-actions">
              {active.map(({ target }) => (
                <li key={target.id}>
                  <strong>{label(target.bucket)}</strong> ·{' '}
                  {formatMoney(target.money.amount, currency)} · version{' '}
                  {target.version}
                  {owner && (
                    <>
                      {' '}
                      <button
                        className="household-button household-button--secondary"
                        type="button"
                        onClick={(event) => {
                          actionRef.current = event.currentTarget;
                          openEdit(target);
                        }}
                      >
                        Edit {label(target.bucket)}
                      </button>{' '}
                      <button
                        className="household-button household-button--secondary"
                        type="button"
                        onClick={(event) => {
                          actionRef.current = event.currentTarget;
                          setOpen(false);
                          setEditing(null);
                          setArchiving(target);
                          setAck(false);
                          setError('');
                        }}
                      >
                        Archive {label(target.bucket)}
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {owner && archiving && (
        <div className="budget-review">
          <h6>
            Archive {label(archiving.bucket)} for {archiving.month}?
          </h6>
          <p>
            Archiving is terminal. This household target stays in history but
            stops contributing to current progress; replacing it requires a new
            creation key. Shared spending does not change.
          </p>
          <label>
            <input
              type="checkbox"
              checked={ack}
              onChange={(event) => setAck(event.target.checked)}
            />{' '}
            I confirm this household-wide archive.
          </label>
          <div className="budget-actions">
            <button
              className="household-button"
              disabled={!online || !ack || working}
              type="button"
              onClick={() => void archive()}
            >
              Confirm archive
            </button>
            <button
              className="household-button household-button--secondary"
              disabled={working}
              type="button"
              onClick={close}
            >
              Cancel archive
            </button>
          </div>
        </div>
      )}
      {owner && open && (
        <div className="budget-review">
          <h6>
            {editing
              ? 'Edit'
              : pending?.attempted
                ? 'Recover or retry'
                : 'Create'}{' '}
            household budget target
          </h6>
          <form onSubmit={prepare}>
            <label>
              Target month{' '}
              <input
                type="month"
                min="1900-01"
                max="9999-11"
                value={draft.month}
                disabled={!!editing || !!pending?.attempted || working}
                onChange={(event) => {
                  setDraft({ ...draft, month: event.target.value });
                  setReview(false);
                }}
              />
            </label>
            <label>
              Bucket{' '}
              <select
                value={draft.bucket}
                disabled={!!editing || !!pending?.attempted || working}
                onChange={(event) => {
                  setDraft({ ...draft, bucket: event.target.value });
                  setReview(false);
                }}
              >
                {buckets.map((bucket) => (
                  <option value={bucket} key={bucket}>
                    {label(bucket)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Nonnegative target amount · {creationCurrency}{' '}
              <input
                ref={amountRef}
                inputMode="decimal"
                value={draft.amount}
                disabled={!!pending?.attempted || working}
                onChange={(event) => {
                  setDraft({ ...draft, amount: event.target.value });
                  setReview(false);
                }}
                placeholder={
                  creationCurrency === 'JPY'
                    ? '0'
                    : creationCurrency === 'KWD'
                      ? '0.000'
                      : '0.00'
                }
              />
            </label>
            {editing && (
              <p>
                Month, currency and bucket cannot be edited. Archive then create
                a new target to correct identity. Updating a past target changes
                today's view of that month's plan; it does not alter ledger
                records.
              </p>
            )}
            {pending?.attempted && (
              <p>
                The previous create outcome may be unknown. Check the refreshed
                progress; retry will send the exact same body and key, never
                create a second intent.
              </p>
            )}
            <button
              className="household-button"
              type="submit"
              disabled={working}
            >
              {pending?.attempted ? 'Review same creation' : 'Review target'}
            </button>
            <button
              className="household-button household-button--secondary"
              disabled={working}
              type="button"
              onClick={close}
            >
              Cancel
            </button>
          </form>
          {review && (
            <div className="budget-review">
              <p>
                Review household disclosure: all current members can see this{' '}
                {label(draft.bucket)} target for {draft.month} in{' '}
                {creationCurrency}. Amount{' '}
                {formatMoney(
                  normalizeTargetAmount(draft.amount, creationCurrency)!,
                  creationCurrency,
                )}
                .{' '}
                {editing
                  ? 'The previous amount is replaced for the entire selected month.'
                  : 'This is one target only; no future months are filled.'}{' '}
                Zero is a deliberate no-spending target, not an absent target.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(event) => setAck(event.target.checked)}
                />{' '}
                I confirm this household-wide target.
              </label>
              <button
                className="household-button"
                type="button"
                disabled={!online || !ack || working}
                onClick={() => void submit()}
              >
                {editing
                  ? 'Save amount'
                  : pending
                    ? 'Create or retry same target'
                    : 'Create target'}
              </button>
              <button
                className="household-button household-button--secondary"
                type="button"
                onClick={() => {
                  setReview(false);
                  setAck(false);
                  amountRef.current?.focus();
                }}
              >
                Back to amount
              </button>
            </div>
          )}
        </div>
      )}
      <button
        className="household-button household-button--secondary"
        type="button"
        onClick={() => setShowHistory((value) => !value)}
      >
        {showHistory ? 'Hide' : 'Show'} archived target history for {month}
      </button>
      {showHistory && (
        <div>
          <h6>Archived monthly targets</h6>
          {history.length === 0 && !loading && (
            <p>No archived targets in this selected month and currency.</p>
          )}
          <ul className="budget-actions">
            {history.map((item) => (
              <li key={item.id}>
                {label(item.bucket)} ·{' '}
                {formatMoney(item.money.amount, currency)} · archived (version{' '}
                {item.version})
                {owner && (
                  <button
                    className="household-button household-button--secondary"
                    type="button"
                    onClick={() => openCreate(item)}
                  >
                    Copy to this or another month (review first)
                  </button>
                )}
              </li>
            ))}
          </ul>
          {historyMore && historyOffset < 10000 && (
            <button
              className="household-button"
              type="button"
              onClick={() => void loadHistory()}
            >
              Load more archived targets
            </button>
          )}
          {historyMore && historyOffset >= 10000 && (
            <p>
              History is capped at offset 10000; choose another month to browse
              that month’s records.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
