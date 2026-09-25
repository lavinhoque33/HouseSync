import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  fetchCsrf,
  fetchHouseholdMembers,
  fetchRepayment,
  fetchRepaymentEvents,
  fetchRepayments,
  postRepayment,
  postRepaymentAmendment,
  postRepaymentAmendmentDecision,
  postRepaymentDecision,
  type CsrfToken,
  type Household,
  type HouseholdMember,
  type Repayment,
  type RepaymentEvent,
  type RepaymentMoney,
} from '../auth/client';
import {
  encodeMoneyMagnitude,
  formatMoney,
  isSupportedTransactionDate,
  type FinancialAccountCurrency,
} from './money';
import {
  isFutureDateInZone,
  isSupportedReportBoundaryDate,
  resolveCalculationZone,
  todayInZone,
} from './reporting';

interface Props {
  household: Household;
  currentUserId: string;
  csrf: CsrfToken | null;
  onCsrfRefreshed: (token: CsrfToken) => void;
  onSessionExpired: () => void;
  onHouseholdAccessChanged: () => void;
  authorityConfirmed: boolean;
  reportingZone: string;
  refreshSignal: number;
  onBalancesChanged: () => void;
}
interface PendingCreate {
  key: string;
  input: { recipientUserId: string; money: RepaymentMoney; occurredOn: string };
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
const STATUSES = [
  'ALL',
  'PENDING',
  'CONFIRMED',
  'REJECTED',
  'CANCELLED',
  'VOIDED',
] as const;
const PAGE = 50;
export function RepaymentsSection({
  household,
  currentUserId,
  csrf,
  onCsrfRefreshed,
  onSessionExpired,
  onHouseholdAccessChanged,
  authorityConfirmed,
  reportingZone,
  refreshSignal,
  onBalancesChanged,
}: Props) {
  const [roster, setRoster] = useState<HouseholdMember[] | null>(null);
  const [items, setItems] = useState<Repayment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [filterStatus, setFilterStatus] =
    useState<(typeof STATUSES)[number]>('ALL');
  const [filterCurrency, setFilterCurrency] = useState<
    FinancialAccountCurrency | ''
  >('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [applied, setApplied] = useState({
    status: 'ALL' as (typeof STATUSES)[number],
    currency: '' as FinancialAccountCurrency | '',
    from: '',
    to: '',
  });
  const [recipient, setRecipient] = useState('');
  const [currency, setCurrency] = useState<FinancialAccountCurrency>('USD');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [replacementAmount, setReplacementAmount] = useState('');
  const [replacementDate, setReplacementDate] = useState('');
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(
    null,
  );
  const [detail, setDetail] = useState<Repayment | null>(null);
  const [events, setEvents] = useState<RepaymentEvent[]>([]);
  const [eventsMore, setEventsMore] = useState(false);
  const [eventsOffset, setEventsOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewRequired, setReviewRequired] = useState(false);
  const [reviewFetched, setReviewFetched] = useState(false);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const sectionHeading = useRef<HTMLHeadingElement>(null);
  const filterControl = useRef<HTMLSelectElement>(null);
  const createInFlight = useRef(false);
  const createIntent = useRef<PendingCreate | null>(null);
  const currentDetailId = useRef<string | null>(null);
  const knownRecords = useRef<Map<string, Repayment>>(new Map());
  const initialList = useRef(true);
  const detailTrigger = useRef<HTMLButtonElement | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const detailGeneration = useRef(0);
  const controllers = useRef<Set<AbortController>>(new Set());
  const csrfRef = useRef(csrf);
  const lastRefresh = useRef(refreshSignal);
  useEffect(() => {
    csrfRef.current = csrf;
  }, [csrf]);
  useEffect(() => {
    if (notice) alertRef.current?.focus();
  }, [notice]);
  const openedDetailId = detail?.id;
  useEffect(() => {
    if (openedDetailId) detailHeading.current?.focus();
  }, [openedDetailId]);
  useEffect(
    () => () => {
      generation.current++;
      detailGeneration.current++;
      for (const c of controllers.current) c.abort();
    },
    [],
  );
  function failure(error: unknown): ApiError {
    return error instanceof ApiError
      ? error
      : new ApiError({
          status: 0,
          code: 'NETWORK_ERROR',
          message:
            'Could not reach the server. Check your connection and retry.',
        });
  }
  function handleAccess(error: ApiError): boolean {
    if (error.status !== 401 && error.code !== 'HOUSEHOLD_NOT_FOUND')
      return false;
    generation.current++;
    detailGeneration.current++;
    currentDetailId.current = null;
    createIntent.current = null;
    knownRecords.current.clear();
    for (const controller of controllers.current) controller.abort();
    setItems([]);
    setRoster(null);
    setDetail(null);
    setEvents([]);
    setPendingCreate(null);
    if (error.status === 401) onSessionExpired();
    else onHouseholdAccessChanged();
    return true;
  }
  function effectiveChanged(previous: Repayment, next: Repayment): boolean {
    return (
      previous.status !== next.status ||
      previous.money.amount !== next.money.amount ||
      previous.money.currency !== next.money.currency ||
      previous.occurredOn !== next.occurredOn
    );
  }
  function rememberRecord(next: Repayment): boolean {
    const previous = knownRecords.current.get(next.id);
    knownRecords.current.set(next.id, next);
    return previous !== undefined && effectiveChanged(previous, next);
  }
  async function loadList(
    append = false,
    filters = applied,
    afterLocalCommit = false,
  ) {
    const run = ++generation.current;
    const controller = new AbortController();
    controllers.current.add(controller);
    setBusy(true);
    try {
      const page = await fetchRepayments(
        household.id,
        {
          limit: PAGE,
          offset: append ? offset : 0,
          ...(filters.status !== 'ALL' ? { status: filters.status } : {}),
          ...(filters.currency ? { currency: filters.currency } : {}),
          ...(filters.from && filters.to
            ? { from: filters.from, to: filters.to }
            : {}),
        },
        controller.signal,
      );
      if (run !== generation.current || controller.signal.aborted) return;
      if (!append) {
        const changed = page.items.some((item) => {
          const previous = knownRecords.current.get(item.id);
          return previous !== undefined && effectiveChanged(previous, item);
        });
        for (const item of page.items) knownRecords.current.set(item.id, item);
        if (initialList.current) {
          initialList.current = false;
        } else {
          if (!afterLocalCommit || changed) onBalancesChanged();
        }
      }
      setItems(
        append
          ? (prev) => {
              const seen = new Set(prev.map((item) => item.id));
              return [
                ...prev,
                ...page.items.filter((item) => !seen.has(item.id)),
              ];
            }
          : page.items,
      );
      setOffset(page.offset + page.limit);
      setHasMore(page.hasMore);
      setLoaded(true);
    } catch (error) {
      if (run !== generation.current || controller.signal.aborted) return;
      const e = failure(error);
      if (!handleAccess(e))
        setNotice(
          append
            ? 'Could not load more party activity. Earlier rows remain; retry this page.'
            : loaded
              ? 'Could not refresh party activity. Shown records may be stale. Retry.'
              : e.message,
        );
    } finally {
      controllers.current.delete(controller);
      if (run === generation.current) setBusy(false);
    }
  }
  async function loadRoster() {
    const controller = new AbortController();
    controllers.current.add(controller);
    setRoster(null);
    try {
      const result = await fetchHouseholdMembers(
        household.id,
        controller.signal,
      );
      if (!controller.signal.aborted) setRoster(result);
    } catch (error) {
      if (!controller.signal.aborted) {
        const e = failure(error);
        if (!handleAccess(e))
          setNotice(
            'Could not load current members. Refresh before recording an external payment.',
          );
      }
    } finally {
      controllers.current.delete(controller);
    }
  }
  useEffect(() => {
    // The keyed household owns this first read; synchronous request state is scoped here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadList();
    void loadRoster();
    // Keyed household instance keeps scoped state separate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (lastRefresh.current === refreshSignal) return;
    lastRefresh.current = refreshSignal;
    void loadList();
    void loadRoster();
    if (detail) void openDetail(detail.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);
  async function openDetail(id: string, forReview = false) {
    currentDetailId.current = id;
    const run = ++detailGeneration.current;
    if (reviewRequired || forReview) setReviewFetched(false);
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const next = await fetchRepayment(household.id, id, controller.signal);
      if (
        run !== detailGeneration.current ||
        controller.signal.aborted ||
        currentDetailId.current !== id
      )
        return;
      if (rememberRecord(next)) onBalancesChanged();
      setDetail(next);
      setEvents([]);
      setEventsOffset(0);
      setEventsMore(false);
      const page = await fetchRepaymentEvents(
        household.id,
        id,
        PAGE,
        0,
        controller.signal,
      );
      if (
        run !== detailGeneration.current ||
        controller.signal.aborted ||
        currentDetailId.current !== id
      )
        return;
      setEvents(page.items);
      setEventsOffset(page.limit);
      setEventsMore(page.hasMore);
      if (forReview && currentDetailId.current === id) setReviewFetched(true);
    } catch (error) {
      if (
        run !== detailGeneration.current ||
        controller.signal.aborted ||
        currentDetailId.current !== id
      )
        return;
      const e = failure(error);
      if (handleAccess(e)) return;
      if (e.code === 'REPAYMENT_NOT_FOUND') {
        setDetail(null);
        setEvents([]);
        setNotice(
          'This repayment is no longer available to you. Only its two current parties can see the record.',
        );
      } else
        setNotice(
          'Could not load the repayment and its history. Retry the detail.',
        );
    } finally {
      controllers.current.delete(controller);
    }
  }
  async function moreEvents() {
    if (!detail) return;
    const id = detail.id;
    const run = detailGeneration.current;
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const page = await fetchRepaymentEvents(
        household.id,
        id,
        PAGE,
        eventsOffset,
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        currentDetailId.current !== id ||
        run !== detailGeneration.current
      )
        return;
      setEvents((prev) => [...prev, ...page.items]);
      setEventsOffset(page.offset + page.limit);
      setEventsMore(page.hasMore);
    } catch (error) {
      if (
        controller.signal.aborted ||
        currentDetailId.current !== id ||
        run !== detailGeneration.current
      )
        return;
      const e = failure(error);
      if (!handleAccess(e))
        setNotice('Could not load older event history. Retry this page.');
    } finally {
      controllers.current.delete(controller);
    }
  }
  async function ensureCsrf(): Promise<CsrfToken> {
    if (csrfRef.current) return csrfRef.current;
    const token = await fetchCsrf();
    csrfRef.current = token;
    onCsrfRefreshed(token);
    return token;
  }
  function validateMoney(
    raw: string,
    code: FinancialAccountCurrency,
    dateValue: string,
  ): RepaymentMoney | null {
    const result = encodeMoneyMagnitude(raw, code, 'positive');
    if (!result.ok) {
      setNotice(result.error);
      return null;
    }
    if (
      !isSupportedTransactionDate(dateValue) ||
      isFutureDateInZone(dateValue, resolveCalculationZone(reportingZone).zone)
    ) {
      setNotice(
        'Choose a completed-payment date from 1900-01-01 through today in the household reporting zone.',
      );
      return null;
    }
    return { amount: result.amount, currency: code };
  }
  function committed(result: Repayment) {
    knownRecords.current.set(result.id, result);
    setDetail(result);
    setEvents([]);
    setEventsMore(false);
    setItems((prev) => [result, ...prev.filter((row) => row.id !== result.id)]);
    onBalancesChanged();
    void loadList(false, applied, true);
    void openDetail(result.id);
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (createInFlight.current || busy || !authorityConfirmed) return;
    let intent = createIntent.current ?? pendingCreate;
    if (!intent) {
      if (
        !roster?.some(
          (member) =>
            member.userId === recipient && recipient !== currentUserId,
        )
      ) {
        setNotice(
          'Choose a distinct CURRENT member. Refresh the roster if someone joined or departed.',
        );
        return;
      }
      const money = validateMoney(amount, currency, date);
      if (!money) return;
      intent = {
        key: crypto.randomUUID(),
        input: { recipientUserId: recipient, money, occurredOn: date },
      };
      setPendingCreate(intent);
      createIntent.current = intent;
    }
    createInFlight.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const result = await postRepayment(
        household.id,
        intent.input,
        intent.key,
        await ensureCsrf(),
      );
      createIntent.current = null;
      setPendingCreate(null);
      setAmount('');
      setRecipient('');
      setNotice(
        'Assertion recorded for recipient review. No money was sent by HouseSync. Avoid recording the same real payment twice.',
      );
      committed(result);
    } catch (error) {
      const problem = failure(error);
      if (handleAccess(problem)) return;
      if (problem.code === 'IDEMPOTENCY_CONFLICT') {
        createIntent.current = null;
        setPendingCreate(null);
        setNotice(
          'This creation key conflicts with a different request. No retry was sent. Review your activity before recording a genuinely new payment.',
        );
      } else if (
        problem.code === 'REPAYMENT_CONFLICT' ||
        problem.code === 'VALIDATION_FAILED'
      ) {
        setPendingCreate(null);
        createIntent.current = null;
        setNotice(
          'Recipient eligibility or payment facts changed. Refresh the current roster and review your form before creating a new assertion. ' +
            problem.message,
        );
        void loadRoster();
      } else if (problem.code === 'CSRF_INVALID') {
        try {
          const token = await fetchCsrf();
          csrfRef.current = token;
          onCsrfRefreshed(token);
          setNotice(
            'Security token refreshed. Review and retry the same unchanged assertion and key.',
          );
        } catch {
          setNotice(
            'Security setup failed. Retry the same unchanged assertion after your session recovers.',
          );
        }
      } else {
        setNotice(
          'The creation outcome may be unknown. Retry the same unchanged request with its original key; do not record it again with a new key.',
        );
      }
    } finally {
      createInFlight.current = false;
      setBusy(false);
    }
  }
  async function transition(request: (token: CsrfToken) => Promise<Repayment>) {
    if (!detail || busy || reviewRequired || !authorityConfirmed) return;
    setBusy(true);
    setNotice(null);
    try {
      committed(await request(await ensureCsrf()));
      setNotice(
        'Decision recorded. Confirmed repayments affect household-visible net balances, but amount, date and history remain party-only.',
      );
    } catch (error) {
      const e = failure(error);
      if (handleAccess(e)) return;
      setReviewRequired(true);
      setReviewFetched(false);
      setNotice(
        e.code === 'REPAYMENT_NOT_FOUND'
          ? 'This party-only record is unavailable. Reload activity to review access.'
          : 'The decision may have applied or the record changed. Fetch current details and review them before another action; nothing was resent.',
      );
      if (e.code === 'REPAYMENT_NOT_FOUND') {
        setDetail(null);
        setEvents([]);
      } else void openDetailForReview(detail.id);
    } finally {
      setBusy(false);
    }
  }
  function openDetailForReview(id: string) {
    void openDetail(id, true);
  }
  function confirmReview() {
    if (!detail || !reviewFetched) return;
    setReviewRequired(false);
    setReviewFetched(false);
    setNotice(
      'Current record loaded. Review its version, accepted amount and pending proposal before choosing a new action.',
    );
  }
  function applyFilters(event: FormEvent) {
    event.preventDefault();
    if (
      (from === '') !== (to === '') ||
      (from &&
        (!isSupportedReportBoundaryDate(from) ||
          !isSupportedReportBoundaryDate(to) ||
          from >= to))
    ) {
      setNotice(
        'Enter both valid dates as a half-open interval, with From before To.',
      );
      return;
    }
    const next = { status: filterStatus, currency: filterCurrency, from, to };
    setApplied(next);
    setItems([]);
    setNotice(null);
    void loadList(false, next);
  }
  const possible = detail?.allowedActions ?? [];
  return (
    <section
      className="repayments-section"
      aria-labelledby={`repayments-title-${household.id}`}
    >
      <h4
        ref={sectionHeading}
        tabIndex={-1}
        id={`repayments-title-${household.id}`}
        className="members-title"
      >
        External repayments · your party-only activity
      </h4>
      <p className="finance-helper">
        Record only a transfer already completed outside HouseSync. HouseSync
        sends no money, checks no bank transfer, and never automatically matches
        ledger transfers. Only sender and recipient can read an amount, date or
        event. Once both agree, household-visible net balances and suggestions
        change; other members may infer payment activity from those aggregates.
        Avoid recording one real transfer twice.
      </p>
      <form onSubmit={create} className="finance-filter-form" noValidate>
        <h5>Assert a completed payment you sent</h5>
        <label htmlFor={`repayment-recipient-${household.id}`}>
          Recipient (current household member)
        </label>
        <select
          id={`repayment-recipient-${household.id}`}
          value={recipient}
          disabled={busy || !!pendingCreate || !roster || !authorityConfirmed}
          onChange={(e) => setRecipient(e.target.value)}
        >
          <option value="">Choose member</option>
          {roster
            ?.filter((member) => member.userId !== currentUserId)
            .map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.email} · {member.userId}
              </option>
            ))}
        </select>
        <label htmlFor={`repayment-currency-${household.id}`}>Currency</label>
        <select
          id={`repayment-currency-${household.id}`}
          value={currency}
          disabled={busy || !!pendingCreate || !authorityConfirmed}
          onChange={(e) =>
            setCurrency(e.target.value as FinancialAccountCurrency)
          }
        >
          {CURRENCIES.map((code) => (
            <option key={code}>{code}</option>
          ))}
        </select>
        <label htmlFor={`repayment-amount-${household.id}`}>
          Positive exact amount
        </label>
        <input
          id={`repayment-amount-${household.id}`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          disabled={busy || !!pendingCreate || !authorityConfirmed}
        />
        <label htmlFor={`repayment-date-${household.id}`}>
          Date payment was completed
        </label>
        <input
          id={`repayment-date-${household.id}`}
          type="date"
          min="1900-01-01"
          max={todayInZone(
            resolveCalculationZone(reportingZone).zone,
            new Date(),
          )}
          value={date}
          onChange={(e) => setDate(e.target.value)}
          disabled={busy || !!pendingCreate || !authorityConfirmed}
        />
        <button
          type="submit"
          className="household-button"
          disabled={busy || !authorityConfirmed || !roster}
        >
          {pendingCreate
            ? 'Retry same assertion key'
            : 'Record assertion · no money sent'}
        </button>
        {pendingCreate && (
          <p role="status">
            Creation outcome uncertain. Draft locked to the original request
            until same-key retry succeeds or conflicts.
          </p>
        )}
      </form>
      <form onSubmit={applyFilters} className="finance-filter-form" noValidate>
        <h5>Filter your party activity</h5>
        <label htmlFor={`repayment-status-${household.id}`}>Status</label>
        <select
          ref={filterControl}
          id={`repayment-status-${household.id}`}
          value={filterStatus}
          onChange={(e) =>
            setFilterStatus(e.target.value as typeof filterStatus)
          }
        >
          {STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <label htmlFor={`repayment-filter-currency-${household.id}`}>
          Currency
        </label>
        <select
          id={`repayment-filter-currency-${household.id}`}
          value={filterCurrency}
          onChange={(e) =>
            setFilterCurrency(e.target.value as typeof filterCurrency)
          }
        >
          <option value="">All currencies</option>
          {CURRENCIES.map((code) => (
            <option key={code}>{code}</option>
          ))}
        </select>
        <label htmlFor={`repayment-from-${household.id}`}>
          From (inclusive)
        </label>
        <input
          id={`repayment-from-${household.id}`}
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <label htmlFor={`repayment-to-${household.id}`}>To (exclusive)</label>
        <input
          id={`repayment-to-${household.id}`}
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        <button
          type="submit"
          className="household-button household-button--secondary"
          disabled={busy}
        >
          Apply filters
        </button>
      </form>
      {busy && <p role="status">Updating your repayment activity…</p>}
      {notice && (
        <div
          role="alert"
          ref={alertRef}
          tabIndex={-1}
          className="household-notice household-notice--warning"
        >
          <p>{notice}</p>
          <button
            type="button"
            className="household-button household-button--secondary"
            onClick={() => {
              void loadList();
              void loadRoster();
            }}
            disabled={busy}
          >
            Refresh activity and roster
          </button>
        </div>
      )}
      {loaded && items.length === 0 && (
        <p role="status">No party-only repayments match these filters.</p>
      )}
      <ul className="member-balances-rows" aria-label="Your repayment records">
        {items.map((item) => (
          <li key={item.id} className="member-balance-row">
            <p>
              {item.senderUserId === currentUserId
                ? 'You sent'
                : 'You received'}{' '}
              {formatMoney(item.money.amount, item.money.currency)} ·{' '}
              <time dateTime={item.occurredOn}>{item.occurredOn}</time> ·{' '}
              {item.status}
            </p>
            <button
              type="button"
              className="household-button household-button--secondary"
              onClick={(e) => {
                detailTrigger.current = e.currentTarget;
                void openDetail(item.id);
              }}
            >
              Review party-only record
            </button>
          </li>
        ))}
      </ul>
      {hasMore && offset <= 10000 && (
        <button
          type="button"
          className="household-button household-button--secondary"
          disabled={busy}
          onClick={() => void loadList(true)}
        >
          Load more activity
        </button>
      )}
      {hasMore && offset > 10000 && (
        <p role="status">
          History beyond the page bound may remain. Narrow the date filters to
          find older records; this is not a complete export.
        </p>
      )}
      {detail && (
        <section
          className="repayment-detail"
          aria-labelledby={`repayment-detail-title-${detail.id}`}
        >
          <h5
            ref={detailHeading}
            tabIndex={-1}
            id={`repayment-detail-title-${detail.id}`}
          >
            Party record · version {detail.version}
          </h5>
          <p>
            Sender{' '}
            <span className="member-balance-uuid">{detail.senderUserId}</span> ·
            recipient{' '}
            <span className="member-balance-uuid">
              {detail.recipientUserId}
            </span>
          </p>
          <p>
            Accepted/asserted amount{' '}
            {formatMoney(detail.money.amount, detail.money.currency)} · date{' '}
            <time dateTime={detail.occurredOn}>{detail.occurredOn}</time> ·{' '}
            {detail.status}
          </p>
          <p>
            Pending and rejected assertions affect no balance. A confirmed
            payment changes net balance by adding its amount to the sender and
            subtracting it from the recipient. This can settle a debt, create an
            overpayment or reverse who owes whom. Later refunds or revoked
            allocations do not erase a real payment.
          </p>
          {detail.pendingAmendment && (
            <p role="status">
              Pending {detail.pendingAmendment.action} proposed by{' '}
              {detail.pendingAmendment.proposedByUserId}.{' '}
              {detail.pendingAmendment.money
                ? `${formatMoney(detail.pendingAmendment.money.amount, detail.pendingAmendment.money.currency)} on ${detail.pendingAmendment.occurredOn}`
                : 'Void the mistaken record.'}{' '}
              The current accepted amount stays effective until the other party
              confirms this proposal.
            </p>
          )}
          {roster &&
            !roster.some(
              (member) =>
                member.userId ===
                (detail.senderUserId === currentUserId
                  ? detail.recipientUserId
                  : detail.senderUserId),
            ) && (
              <p role="status">
                The other party has departed. Positive consent must wait for
                that same person to rejoin; a remaining party may reject or
                cancel a pending proposal if permitted.
              </p>
            )}
          {reviewRequired && (
            <div
              role="alert"
              className="household-notice household-notice--warning"
            >
              A versioned outcome was uncertain. Review the freshly fetched
              record and event history; do not repeat the old request.
              {!reviewFetched && (
                <button
                  className="household-button household-button--secondary"
                  type="button"
                  onClick={() => void openDetailForReview(detail.id)}
                >
                  Fetch current record and history
                </button>
              )}
              <button
                disabled={!reviewFetched}
                className="household-button household-button--secondary"
                type="button"
                onClick={confirmReview}
              >
                I reviewed the current record
              </button>
            </div>
          )}
          <div className="finance-account-actions">
            {(['CONFIRM', 'REJECT', 'CANCEL'] as const)
              .filter((action) => possible.includes(action))
              .map((action) => (
                <button
                  key={action}
                  type="button"
                  disabled={busy || reviewRequired || !authorityConfirmed}
                  className="household-button household-button--secondary"
                  onClick={() =>
                    void transition((token) =>
                      postRepaymentDecision(
                        household.id,
                        detail.id,
                        detail.version,
                        action,
                        token,
                      ),
                    )
                  }
                >
                  {action === 'CONFIRM'
                    ? 'Confirm payment received'
                    : action === 'REJECT'
                      ? 'Reject assertion'
                      : 'Cancel assertion'}
                </button>
              ))}
          </div>
          <div className="finance-account-actions">
            {possible.includes('PROPOSE_VOID') && (
              <button
                type="button"
                disabled={busy || reviewRequired || !authorityConfirmed}
                className="household-button household-button--secondary"
                onClick={() =>
                  void transition((token) =>
                    postRepaymentAmendment(
                      household.id,
                      detail.id,
                      { expectedVersion: detail.version, action: 'VOID' },
                      token,
                    ),
                  )
                }
              >
                Propose void (mistaken record only)
              </button>
            )}
          </div>
          {possible.includes('PROPOSE_REPLACEMENT') && (
            <form
              className="finance-filter-form"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                const money = validateMoney(
                  replacementAmount,
                  detail.money.currency,
                  replacementDate,
                );
                if (money)
                  void transition((token) =>
                    postRepaymentAmendment(
                      household.id,
                      detail.id,
                      {
                        expectedVersion: detail.version,
                        action: 'REPLACE',
                        money,
                        occurredOn: replacementDate,
                      },
                      token,
                    ),
                  );
              }}
            >
              <h6>Propose complete replacement · {detail.money.currency}</h6>
              <label htmlFor={`replacement-amount-${detail.id}`}>
                Corrected positive amount
              </label>
              <input
                id={`replacement-amount-${detail.id}`}
                inputMode="decimal"
                value={replacementAmount}
                onChange={(e) => setReplacementAmount(e.target.value)}
              />
              <label htmlFor={`replacement-date-${detail.id}`}>
                Date completed
              </label>
              <input
                id={`replacement-date-${detail.id}`}
                type="date"
                min="1900-01-01"
                max={todayInZone(
                  resolveCalculationZone(reportingZone).zone,
                  new Date(),
                )}
                value={replacementDate}
                onChange={(e) => setReplacementDate(e.target.value)}
              />
              <button
                className="household-button household-button--secondary"
                type="submit"
                disabled={busy || reviewRequired || !authorityConfirmed}
              >
                Propose replacement for other party to review
              </button>
            </form>
          )}
          <div className="finance-account-actions">
            {(
              [
                'CONFIRM_AMENDMENT',
                'REJECT_AMENDMENT',
                'CANCEL_AMENDMENT',
              ] as const
            )
              .filter((action) => possible.includes(action))
              .map((action) => (
                <button
                  key={action}
                  type="button"
                  disabled={busy || reviewRequired || !authorityConfirmed}
                  className="household-button household-button--secondary"
                  onClick={() =>
                    void transition((token) =>
                      postRepaymentAmendmentDecision(
                        household.id,
                        detail.id,
                        detail.version,
                        action === 'CONFIRM_AMENDMENT'
                          ? 'CONFIRM'
                          : action === 'REJECT_AMENDMENT'
                            ? 'REJECT'
                            : 'CANCEL',
                        token,
                      ),
                    )
                  }
                >
                  {action === 'CONFIRM_AMENDMENT'
                    ? 'Confirm correction (changes household balances)'
                    : action === 'REJECT_AMENDMENT'
                      ? 'Reject correction'
                      : 'Cancel your correction'}
                </button>
              ))}
          </div>
          <h6>Consent and correction history</h6>
          <ol className="member-balances-rows">
            {events.map((event) => (
              <li className="member-balance-row" key={event.version}>
                Version {event.version} · {event.eventType} by{' '}
                <span className="member-balance-uuid">{event.actorUserId}</span>{' '}
                · <time dateTime={event.recordedAt}>{event.recordedAt}</time> ·{' '}
                {event.status} ·{' '}
                {formatMoney(event.money.amount, event.money.currency)} on{' '}
                {event.occurredOn}
                {event.pendingAmendment &&
                  ` · proposed ${event.pendingAmendment.action}`}
              </li>
            ))}
          </ol>
          {eventsMore && eventsOffset <= 10000 && (
            <button
              className="household-button household-button--secondary"
              type="button"
              onClick={() => void moreEvents()}
            >
              Load older events
            </button>
          )}
          {eventsMore && eventsOffset > 10000 && (
            <p role="status">
              More history may exist beyond this page bound. This view is not a
              full audit export.
            </p>
          )}
          <button
            className="household-button household-button--secondary"
            type="button"
            onClick={() => {
              detailGeneration.current++;
              currentDetailId.current = null;
              setDetail(null);
              setEvents([]);
              const trigger = detailTrigger.current;
              if (trigger?.isConnected) trigger.focus();
              else (filterControl.current ?? sectionHeading.current)?.focus();
            }}
          >
            Close private detail
          </button>
        </section>
      )}
    </section>
  );
}
