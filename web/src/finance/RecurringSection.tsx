import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  createRecurringPlan,
  fetchCsrf,
  fetchRecurringCandidates,
  fetchRecurringEvidence,
  fetchRecurringPlanObservations,
  fetchRecurringPlanProjections,
  fetchRecurringPlans,
  patchRecurringPlan,
  putRecurringReview,
  type CsrfToken,
  type Household,
} from '../auth/client';
import { FilterBar } from '../ui/FilterBar';
import {
  encodeMoneyMagnitude,
  formatMoney,
  type FinancialAccountCurrency,
} from './money';
import {
  calendarDate,
  type Cadence,
  type Candidate,
  type CandidateEvidence,
  type CandidatePage,
  type CreatePlan,
  type PlanContent,
  type PlanKind,
  type PlanObservations,
  type PlanProjection,
  type PlanProjectionPage,
  type RecurringPlan,
} from './recurring';

type Draft = {
  label: string;
  kind: PlanKind;
  matchDescription: string;
  cadence: Cadence;
  anchorOn: string;
  calendarAnchor: 'DAY_OF_MONTH' | 'END_OF_MONTH' | null;
  expectedAmount: string;
};
type Pending = { input: CreatePlan; key: string };
const kinds: PlanKind[] = ['BILL', 'SUBSCRIPTION', 'RECURRING_EXPENSE'];
const cadences: Cadence[] = [
  'WEEKLY',
  'BIWEEKLY',
  'MONTHLY',
  'QUARTERLY',
  'ANNUAL',
];
const PAGE_SIZE = 100;
function draftFromCandidate(item: Candidate): Draft {
  return {
    label: item.label,
    kind: item.suggestedKind,
    matchDescription: item.label,
    cadence: item.cadence,
    anchorOn: item.anchorOn,
    calendarAnchor: item.calendarAnchor,
    expectedAmount: '',
  };
}
function draftFromPlan(plan: RecurringPlan): Draft {
  return {
    label: plan.label,
    kind: plan.kind,
    matchDescription: plan.matchDescription,
    cadence: plan.cadence,
    anchorOn: plan.anchorOn,
    calendarAnchor: plan.calendarAnchor,
    expectedAmount: plan.expectedAmount ?? '',
  };
}
function blankDraft(): Draft {
  return {
    label: '',
    kind: 'BILL',
    matchDescription: '',
    cadence: 'MONTHLY',
    anchorOn: '',
    calendarAnchor: 'DAY_OF_MONTH',
    expectedAmount: '',
  };
}
function warning(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'INSIGHT_SNAPSHOT_STALE')
      return 'Current shared evidence changed. Old pages and candidate confirmation were cleared; reload before acting.';
    if (
      error.code === 'RESOURCE_VERSION_CONFLICT' ||
      error.code === 'RESOURCE_VERSION_EXHAUSTED'
    )
      return 'This plan or review changed. Reload its current version before submitting a new decision.';
    if (error.code === 'RECURRING_PLAN_CONFLICT')
      return 'A conflicting active plan or terminal archive prevents this change. Reload plans before deciding.';
    if (error.code === 'IDEMPOTENCY_CONFLICT')
      return 'This create key belongs to different content. Reload plans before a new creation.';
    if (error.code === 'CSRF_INVALID')
      return 'Security token expired. Refresh the token and confirm again; no automatic retry.';
    return (
      error.message ||
      'Could not complete recurring request. Reload before retrying.'
    );
  }
  return 'The request outcome is unknown. Refresh current records before another decision.';
}
function EvidenceRows({
  items,
  currency,
  onOpenTransaction,
}: {
  items: CandidateEvidence['items'];
  currency: FinancialAccountCurrency;
  onOpenTransaction: (id: string) => void;
}) {
  return (
    <div
      className="insights-scroll"
      role="region"
      aria-label="Current recurring expense evidence"
      tabIndex={0}
    >
      <table>
        <caption>
          Currently disclosed expenses only · {currency}; refunds affect
          spending in the comparison above, not recurrence occurrences
        </caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Description</th>
            <th scope="col">Amount</th>
            <th scope="col">Category</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>{item.occurredOn}</td>
              <td>{item.description}</td>
              <td>{formatMoney(item.money.amount, currency)}</td>
              <td>{item.category ?? 'Uncategorized'}</td>
              <td>
                <button
                  type="button"
                  className="household-button household-button--secondary"
                  onClick={() => onOpenTransaction(item.id)}
                >
                  Open authorized detail
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function RecurringSection({
  household,
  currency,
  reportingZone,
  refreshSignal,
  csrf,
  onCsrfRefreshed,
  onSessionExpired,
  onHouseholdAccessChanged,
  onOpenTransaction,
  onChanged,
}: {
  household: Household;
  currency: FinancialAccountCurrency;
  reportingZone: string;
  refreshSignal: number;
  csrf: CsrfToken | null;
  onCsrfRefreshed: (token: CsrfToken) => void;
  onSessionExpired: () => void;
  onHouseholdAccessChanged: () => void;
  onOpenTransaction: (id: string) => void;
  onChanged?: () => void;
}) {
  const [review, setReview] = useState<'OPEN' | 'DISMISSED'>('OPEN');
  const [candidates, setCandidates] = useState<CandidatePage | null>(null);
  const [candidateRows, setCandidateRows] = useState<Candidate[]>([]);
  const [candidateCursor, setCandidateCursor] = useState<string | null>(null);
  const [plans, setPlans] = useState<PlanProjectionPage | null>(null);
  const [planRows, setPlanRows] = useState<PlanProjection[]>([]);
  const [planCursor, setPlanCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<RecurringPlan[]>([]);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyMore, setHistoryMore] = useState(false);
  const [detail, setDetail] = useState<{
    kind: 'candidate' | 'plan';
    id: string;
  } | null>(null);
  const [evidence, setEvidence] = useState<
    CandidateEvidence | PlanObservations | null
  >(null);
  const [evidenceRows, setEvidenceRows] = useState<CandidateEvidence['items']>(
    [],
  );
  const [evidenceCursor, setEvidenceCursor] = useState<string | null>(null);
  const [editing, setEditing] = useState<RecurringPlan | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<RecurringPlan | null>(
    null,
  );
  const [source, setSource] = useState<Candidate | null>(null);
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [ack, setAck] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const noticeRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const csRef = useRef(csrf);
  const sourceRef = useRef(source);
  useEffect(() => {
    csRef.current = csrf;
  }, [csrf]);
  useEffect(() => {
    sourceRef.current = source;
  }, [source]);
  const owner = household.role === 'OWNER';
  function clearScoped() {
    generation.current++;
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
    setCandidates(null);
    setCandidateRows([]);
    setCandidateCursor(null);
    setPlans(null);
    setPlanRows([]);
    setPlanCursor(null);
    setHistory([]);
    setHistoryMore(false);
    setHistoryOffset(0);
    setDetail(null);
    setEvidence(null);
    setEvidenceRows([]);
    setEvidenceCursor(null);
    setArchiveTarget(null);
    setEditing(null);
    setSource(null);
    setDraft(blankDraft());
    setPending(null);
    setAck(false);
    setFormOpen(false);
  }
  function fail(failure: unknown): boolean {
    if (failure instanceof ApiError && failure.status === 401) {
      clearScoped();
      onSessionExpired();
      return true;
    }
    if (
      failure instanceof ApiError &&
      (failure.code === 'HOUSEHOLD_NOT_FOUND' ||
        (failure.status === 404 && failure.code !== 'RECURRING_PLAN_NOT_FOUND'))
    ) {
      clearScoped();
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
  function invalidate() {
    for (const current of controllers.current) current.abort();
    controllers.current.clear();
    generation.current++;
    setCandidates(null);
    setCandidateRows([]);
    setCandidateCursor(null);
    setPlans(null);
    setPlanRows([]);
    setPlanCursor(null);
    setHistory([]);
    setHistoryMore(false);
    setHistoryOffset(0);
    setDetail(null);
    setEvidence(null);
    setEvidenceRows([]);
    setEvidenceCursor(null);
    setArchiveTarget(null);
    if (sourceRef.current) {
      setDraft(blankDraft());
      setFormOpen(false);
      setAck(false);
    }
    setSource(null);
    setRevision((value) => value + 1);
  }
  useEffect(
    () => () => {
      generation.current++;
      for (const current of controllers.current) current.abort();
      controllers.current.clear();
    },
    [],
  );
  useEffect(() => {
    const current = ++generation.current;
    for (const item of controllers.current) item.abort();
    controllers.current.clear();
    void Promise.resolve().then(() => {
      if (generation.current !== current) return;
      setCandidates(null);
      setCandidateRows([]);
      setCandidateCursor(null);
      setPlans(null);
      setPlanRows([]);
      setPlanCursor(null);
      setHistory([]);
      setHistoryMore(false);
      setHistoryOffset(0);
      if (sourceRef.current) {
        setDraft(blankDraft());
        setFormOpen(false);
        setAck(false);
      }
      setArchiveTarget(null);
      setDetail(null);
      setEvidence(null);
      setEvidenceRows([]);
      setEvidenceCursor(null);
      setSource(null);
      setLoading(true);
      setError('');
    });
    const active = controller();
    void Promise.all([
      fetchRecurringCandidates(
        household.id,
        currency,
        review,
        PAGE_SIZE,
        undefined,
        active.signal,
      ),
      fetchRecurringPlanProjections(
        household.id,
        currency,
        PAGE_SIZE,
        undefined,
        active.signal,
      ),
      fetchRecurringPlans(
        household.id,
        currency,
        'ARCHIVED',
        PAGE_SIZE,
        0,
        active.signal,
      ),
    ])
      .then(([found, tracked, archived]) => {
        if (active.signal.aborted || generation.current !== current) return;
        setCandidates(found);
        setCandidateRows(found.items);
        setCandidateCursor(found.nextCursor);
        setPlans(tracked);
        setPlanRows(tracked.items);
        setPlanCursor(tracked.nextCursor);
        setHistory(archived.items);
        setHistoryOffset(archived.items.length);
        setHistoryMore(archived.hasMore);
      })
      .catch((failure) => {
        if (active.signal.aborted || generation.current !== current) return;
        if (!fail(failure)) setError(warning(failure));
      })
      .finally(() => {
        controllers.current.delete(active);
        if (generation.current === current && !active.signal.aborted)
          setLoading(false);
      });
    return () => active.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    household.id,
    household.role,
    currency,
    reportingZone,
    refreshSignal,
    review,
    revision,
  ]);
  useEffect(() => {
    if (error) noticeRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (message) statusRef.current?.focus();
  }, [message]);
  async function csrfToken(signal: AbortSignal): Promise<CsrfToken> {
    if (csRef.current) return csRef.current;
    const fresh = await fetchCsrf(signal);
    if (!signal.aborted) {
      csRef.current = fresh;
      onCsrfRefreshed(fresh);
    }
    return fresh;
  }
  async function runAction(
    action: (token: CsrfToken, signal: AbortSignal) => Promise<unknown>,
    success: string,
  ) {
    if (busy) return;
    const current = generation.current,
      active = controller();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const token = await csrfToken(active.signal);
      if (active.signal.aborted || current !== generation.current) return;
      await action(token, active.signal);
      if (active.signal.aborted || current !== generation.current) return;
      onChanged?.();
      invalidate();
      setEditing(null);
      setDraft(blankDraft());
      setAck(false);
      setPending(null);
      setFormOpen(false);
      setMessage(success);
    } catch (failure) {
      if (active.signal.aborted || current !== generation.current) return;
      if (failure instanceof ApiError && failure.code === 'CSRF_INVALID') {
        csRef.current = null;
        try {
          const fresh = await fetchCsrf(active.signal);
          if (current === generation.current && !active.signal.aborted) {
            csRef.current = fresh;
            onCsrfRefreshed(fresh);
          }
        } catch {
          /* Keep decision pending for explicit retry. */
        }
      }
      if (
        failure instanceof ApiError &&
        [
          'INSIGHT_SNAPSHOT_STALE',
          'RESOURCE_VERSION_CONFLICT',
          'RESOURCE_VERSION_EXHAUSTED',
          'RECURRING_PLAN_CONFLICT',
          'RECURRING_PLAN_NOT_FOUND',
        ].includes(failure.code)
      ) {
        invalidate();
        setEditing(null);
        setPending(null);
        setFormOpen(false);
        setDraft(blankDraft());
        setAck(false);
        setError(warning(failure));
        return;
      }
      if (failure instanceof ApiError && failure.status === 403) {
        setEditing(null);
        setSource(null);
        setAck(false);
        setDraft(blankDraft());
        setPending(null);
        setFormOpen(false);
      }
      if (!fail(failure)) setError(warning(failure));
    } finally {
      controllers.current.delete(active);
      setBusy(false);
    }
  }
  async function loadPage(
    which: 'candidate' | 'plan' | 'history' | 'evidence',
  ) {
    if (busy || loading) return;
    const current = generation.current,
      active = controller();
    setBusy(true);
    setError('');
    try {
      if (which === 'candidate' && candidates && candidateCursor) {
        const next = await fetchRecurringCandidates(
          household.id,
          currency,
          review,
          PAGE_SIZE,
          candidateCursor,
          active.signal,
        );
        if (current !== generation.current || active.signal.aborted) return;
        if (
          next.snapshot !== candidates.snapshot ||
          next.asOfDate !== candidates.asOfDate ||
          next.items.some((row) =>
            candidateRows.some((old) => old.merchantKey === row.merchantKey),
          )
        )
          throw new Error('Changed candidate pages');
        setCandidateRows((rows) => [...rows, ...next.items]);
        setCandidateCursor(next.nextCursor);
      } else if (which === 'plan' && plans && planCursor) {
        const next = await fetchRecurringPlanProjections(
          household.id,
          currency,
          PAGE_SIZE,
          planCursor,
          active.signal,
        );
        if (current !== generation.current || active.signal.aborted) return;
        if (
          next.snapshot !== plans.snapshot ||
          next.asOfDate !== plans.asOfDate ||
          next.items.some((row) =>
            planRows.some((old) => old.plan.id === row.plan.id),
          )
        )
          throw new Error('Changed plan pages');
        setPlanRows((rows) => [...rows, ...next.items]);
        setPlanCursor(next.nextCursor);
      } else if (which === 'history' && historyMore) {
        const next = await fetchRecurringPlans(
          household.id,
          currency,
          'ARCHIVED',
          PAGE_SIZE,
          historyOffset,
          active.signal,
        );
        if (current !== generation.current || active.signal.aborted) return;
        if (next.items.some((row) => history.some((old) => old.id === row.id)))
          throw new Error('Changed plan history');
        setHistory((rows) => [...rows, ...next.items]);
        setHistoryOffset((value) => value + next.items.length);
        setHistoryMore(next.hasMore);
      } else if (which === 'evidence' && detail && evidence && evidenceCursor) {
        const next =
          detail.kind === 'candidate'
            ? await fetchRecurringEvidence(
                household.id,
                currency,
                detail.id,
                PAGE_SIZE,
                evidenceCursor,
                active.signal,
              )
            : await fetchRecurringPlanObservations(
                household.id,
                detail.id,
                PAGE_SIZE,
                evidenceCursor,
                active.signal,
              );
        if (current !== generation.current || active.signal.aborted) return;
        if (
          next.snapshot !== evidence.snapshot ||
          next.asOfDate !== evidence.asOfDate ||
          next.items.some((row) =>
            evidenceRows.some((old) => old.id === row.id),
          )
        )
          throw new Error('Changed evidence pages');
        setEvidenceRows((rows) => [...rows, ...next.items]);
        setEvidenceCursor(next.nextCursor);
      }
    } catch (failure) {
      if (active.signal.aborted || current !== generation.current) return;
      if (!fail(failure)) {
        invalidate();
        setError(
          failure instanceof ApiError &&
            failure.code !== 'INSIGHT_SNAPSHOT_STALE'
            ? warning(failure)
            : 'Current shared records changed while paging. Old pages and evidence were cleared; reload current records.',
        );
      }
    } finally {
      controllers.current.delete(active);
      setBusy(false);
    }
  }
  async function openEvidence(kind: 'candidate' | 'plan', id: string) {
    const current = generation.current,
      active = controller();
    setDetail({ kind, id });
    setEvidence(null);
    setEvidenceRows([]);
    setEvidenceCursor(null);
    setError('');
    try {
      const result =
        kind === 'candidate'
          ? await fetchRecurringEvidence(
              household.id,
              currency,
              id,
              PAGE_SIZE,
              undefined,
              active.signal,
            )
          : await fetchRecurringPlanObservations(
              household.id,
              id,
              PAGE_SIZE,
              undefined,
              active.signal,
            );
      if (active.signal.aborted || current !== generation.current) return;
      if (
        kind === 'candidate' &&
        'candidate' in result &&
        result.candidate?.candidateFingerprint !==
          candidateRows.find((item) => item.merchantKey === id)
            ?.candidateFingerprint
      ) {
        setCandidates(null);
        setCandidateRows([]);
        setCandidateCursor(null);
      }
      if (kind === 'plan' && 'plan' in result) {
        const previous = planRows.find((row) => row.plan.id === id);
        const archived = history.find((row) => row.id === id);
        const earlier = previous?.expectation;
        if (
          (previous &&
            earlier &&
            (previous.plan.version !== result.plan.version ||
              previous.plan.status !== result.plan.status ||
              earlier.latestExpectedOn !==
                result.expectation.latestExpectedOn ||
              earlier.latestState !== result.expectation.latestState ||
              earlier.nextExpectedOn !== result.expectation.nextExpectedOn ||
              earlier.windowFrom !== result.expectation.windowFrom ||
              earlier.windowTo !== result.expectation.windowTo ||
              earlier.matchedCount !== result.expectation.matchedCount ||
              earlier.observedAmount !== result.expectation.observedAmount)) ||
          (archived &&
            (archived.version !== result.plan.version ||
              archived.status !== result.plan.status))
        ) {
          setPlans(null);
          setPlanRows([]);
          setPlanCursor(null);
          setHistory([]);
          setHistoryMore(false);
          setHistoryOffset(0);
          setEditing(null);
          setArchiveTarget(null);
          setMessage(
            'Tracked plans changed since loading. The current authorized observations below remain visible; refresh the plan list before another decision.',
          );
        }
      }
      setEvidence(result);
      setEvidenceRows(result.items);
      setEvidenceCursor(result.nextCursor);
    } catch (failure) {
      if (active.signal.aborted || current !== generation.current) return;
      setDetail(null);
      setEvidence(null);
      if (!fail(failure)) {
        if (
          failure instanceof ApiError &&
          (failure.code === 'INSIGHT_SNAPSHOT_STALE' ||
            failure.code === 'RECURRING_PLAN_NOT_FOUND')
        )
          invalidate();
        setError(warning(failure));
      }
    } finally {
      controllers.current.delete(active);
    }
  }
  function startCreate(item?: Candidate) {
    setFormOpen(true);
    setEditing(null);
    setSource(item ?? null);
    setDraft(item ? draftFromCandidate(item) : blankDraft());
    setAck(false);
    setPending(null);
    setError('');
    setMessage('');
    requestAnimationFrame(() =>
      document.getElementById('recurring-plan-label')?.focus(),
    );
  }
  function startEdit(plan: RecurringPlan) {
    setFormOpen(true);
    setEditing(plan);
    setSource(null);
    setDraft(draftFromPlan(plan));
    setAck(false);
    setPending(null);
    setError('');
    requestAnimationFrame(() =>
      document.getElementById('recurring-plan-label')?.focus(),
    );
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!owner || busy || pending) return;
    const label = draft.label.trim(),
      matchDescription = draft.matchDescription.trim();
    const codedAmount =
      draft.expectedAmount.trim() === ''
        ? null
        : encodeMoneyMagnitude(draft.expectedAmount, currency, 'positive');
    if (
      !label ||
      [...label].length > 100 ||
      !matchDescription ||
      [...matchDescription].length > 200 ||
      !calendarDate(draft.anchorOn) ||
      draft.anchorOn < '1900-01-01' ||
      draft.anchorOn > '9999-12-30' ||
      (draft.calendarAnchor === 'END_OF_MONTH' &&
        new Date(`${draft.anchorOn}T00:00:00Z`).getUTCDate() !==
          new Date(
            Date.UTC(
              Number(draft.anchorOn.slice(0, 4)),
              Number(draft.anchorOn.slice(5, 7)),
              0,
            ),
          ).getUTCDate()) ||
      (codedAmount !== null && !codedAmount.ok) ||
      !ack
    ) {
      setError(
        codedAmount !== null && !codedAmount.ok
          ? codedAmount.error
          : 'Complete valid names, schedule and disclosure acknowledgement before saving.',
      );
      return;
    }
    const fields: PlanContent = {
      label,
      kind: draft.kind,
      currency,
      matchDescription,
      cadence: draft.cadence,
      anchorOn: draft.anchorOn,
      calendarAnchor: draft.calendarAnchor,
      expectedAmount: codedAmount === null ? null : codedAmount.amount,
    };
    if (editing) {
      const changed: Record<string, unknown> = {
        expectedVersion: editing.version,
        acknowledgeHouseholdDisclosure: true,
      };
      for (const field of [
        'label',
        'kind',
        'matchDescription',
        'cadence',
        'anchorOn',
        'calendarAnchor',
        'expectedAmount',
      ] as const)
        if (fields[field] !== editing[field]) changed[field] = fields[field];
      if (
        ['cadence', 'anchorOn', 'calendarAnchor'].some((field) =>
          Object.hasOwn(changed, field),
        )
      ) {
        changed.cadence = fields.cadence;
        changed.anchorOn = fields.anchorOn;
        changed.calendarAnchor = fields.calendarAnchor;
      }
      if (Object.keys(changed).length === 2) {
        setError('Change a plan field before saving.');
        return;
      }
      void runAction(
        (token, signal) =>
          patchRecurringPlan(
            household.id,
            editing.id,
            changed as Parameters<typeof patchRecurringPlan>[2],
            token,
            signal,
          ),
        'Household plan updated.',
      );
    } else {
      const input: CreatePlan = {
        ...fields,
        acknowledgeHouseholdDisclosure: true,
        ...(source
          ? {
              candidate: {
                merchantKey: source.merchantKey,
                candidateFingerprint: source.candidateFingerprint,
              },
            }
          : {}),
      };
      const request = { input, key: crypto.randomUUID() };
      setPending(request);
      void runAction(
        (token, signal) =>
          createRecurringPlan(
            household.id,
            request.input,
            request.key,
            token,
            signal,
          ),
        'Household plan created.',
      );
    }
  }
  return (
    <section
      className="recurring-section"
      id={`insights-recurring-${household.id}`}
      tabIndex={-1}
      aria-label="Recurring expenses and household plans"
    >
      <h5>Possible recurring expenses</h5>
      <p>
        Currently shared, posted expenses only; past 36 months through today in
        the household reporting zone. This is a conservative description-group
        heuristic, not a bill, paid status, payment or cancellation. Multiple
        charges with identical normalized descriptions may not be distinguished;
        missing cycles or uncertain cadence may not be suggested. Refunds affect
        the spending comparison above, not recurrence observations. Refresh
        after ledger or disclosure changes.
      </p>
      <FilterBar
        title="Recurring expense filters"
        summary={`${review === 'OPEN' ? 'Open' : 'Dismissed'} reviews`}
        activeCount={review === 'OPEN' ? 0 : 1}
        onReset={() => setReview('OPEN')}
      >
        <label>
          Review filter{' '}
          <select
            value={review}
            onChange={(event) =>
              setReview(event.target.value as 'OPEN' | 'DISMISSED')
            }
          >
            <option value="OPEN">Open</option>
            <option value="DISMISSED">Dismissed</option>
          </select>
        </label>
      </FilterBar>
      <p>
        Your dismissals are private review preferences, not shared plans. A
        previously shared suggestion disappearing means current shared evidence
        changed or no longer qualifies; detached preferences are not readable or
        restorable until it qualifies again. At most 1,000 preferences are kept
        per member per household; old dismissals may reappear after eviction.
      </p>
      <button
        type="button"
        className="household-button household-button--secondary"
        onClick={invalidate}
      >
        Refresh recurring records
      </button>
      {error && (
        <div
          ref={noticeRef}
          tabIndex={-1}
          role="alert"
          className="household-notice household-notice--error"
        >
          {error}{' '}
          <button
            type="button"
            className="household-button"
            onClick={invalidate}
          >
            Reload current records
          </button>
        </div>
      )}
      {message && (
        <p ref={statusRef} role="status" tabIndex={-1}>
          {message}
        </p>
      )}
      {loading && <p role="status">Loading current recurring records…</p>}
      {candidates && (
        <>
          <p>
            Window [{candidates.evidenceFrom}, {candidates.evidenceTo}) · as of{' '}
            {candidates.asOfDate}, {candidates.reportingTimeZone}, {currency}.{' '}
            {candidateCursor
              ? 'Candidate list is partial.'
              : 'All qualifying candidates in this filter shown.'}
          </p>
          {candidateRows.length === 0 && (
            <p>
              No currently qualifying {review.toLowerCase()} recurring
              suggestions. Manual plans can still be created by an owner.
            </p>
          )}
          <ul className="recurring-cards">
            {candidateRows.map((item) => (
              <li key={item.merchantKey}>
                <h6>{item.label}</h6>
                <p>
                  {item.occurrenceCount} disclosed expenses (
                  {item.firstOccurredOn} to {item.lastOccurredOn}); exact
                  minimum {formatMoney(item.minAmount, currency)}, lower median{' '}
                  {formatMoney(item.medianAmount, currency)}, maximum{' '}
                  {formatMoney(item.maxAmount, currency)}.{' '}
                  {item.amountPattern === 'STABLE'
                    ? 'Amounts within 10% of the median.'
                    : 'Variable amounts; no fixed-charge inference.'}
                </p>
                <p>
                  {item.cadence.toLowerCase()} anchored {item.anchorOn}{' '}
                  {item.calendarAnchor === 'END_OF_MONTH'
                    ? 'on month end'
                    : item.calendarAnchor === 'DAY_OF_MONTH'
                      ? 'on the calendar day'
                      : ''}
                  ; allowed date deviation{' '}
                  {item.cadence === 'WEEKLY' || item.cadence === 'BIWEEKLY'
                    ? '±1'
                    : '±3'}{' '}
                  days. Category-based suggestion:{' '}
                  {item.suggestedKind.replace('_', ' ').toLowerCase()}, not a
                  confirmed contract.
                </p>
                <p>
                  Next possible slot:{' '}
                  {item.nextExpectedOn ?? 'schedule date limit'} ·{' '}
                  {item.expectationState.replace('_', ' ').toLowerCase()}. Not
                  observed does not mean unpaid, late or canceled.{' '}
                  {item.activePlanId
                    ? 'A separately authored active plan matches this description.'
                    : 'No active plan linked.'}
                </p>
                <button
                  type="button"
                  className="household-button household-button--secondary"
                  onClick={() =>
                    void openEvidence('candidate', item.merchantKey)
                  }
                >
                  View current evidence
                </button>{' '}
                <button
                  type="button"
                  className="household-button household-button--secondary"
                  disabled={busy}
                  onClick={() =>
                    void runAction(
                      (token, signal) =>
                        putRecurringReview(
                          household.id,
                          currency,
                          item.merchantKey,
                          item.candidateFingerprint,
                          item.reviewVersion,
                          item.reviewStatus === 'OPEN' ? 'DISMISSED' : 'OPEN',
                          token,
                          signal,
                        ),
                      item.reviewStatus === 'OPEN'
                        ? 'Suggestion dismissed for you.'
                        : 'Suggestion restored for you.',
                    )
                  }
                >
                  {item.reviewStatus === 'OPEN'
                    ? 'Dismiss for me'
                    : 'Restore for me'}
                </button>{' '}
                {owner && !item.activePlanId && (
                  <button
                    type="button"
                    className="household-button"
                    onClick={() => startCreate(item)}
                  >
                    Use current suggestion to draft shared plan
                  </button>
                )}
              </li>
            ))}
          </ul>
          {candidateCursor && (
            <button
              type="button"
              className="household-button"
              disabled={busy}
              onClick={() => void loadPage('candidate')}
            >
              Load more candidates
            </button>
          )}
        </>
      )}
      <h5>Tracked household bills/subscriptions</h5>
      <p>
        Explicit household-authored plans remain independently shared intent
        even if supporting transactions are later unshared; archiving does not
        erase them. Current disclosed observations are recalculated, not
        retained evidence. No plan executes a payment, verifies a charge as paid
        or cancels a subscription. Plans with identical normalized matching text
        cannot be tracked separately; enter distinct matching descriptions when
        appropriate.
      </p>
      {owner ? (
        <button
          type="button"
          className="household-button"
          onClick={() => startCreate()}
        >
          Create manual household plan
        </button>
      ) : (
        <p>
          Only a current household owner can create, edit or archive shared
          plans. All current members can review suggestions and read plans.
        </p>
      )}
      {plans && (
        <>
          <p>
            {planCursor
              ? 'Active plan list is partial; load more for all active plans.'
              : 'All active plans shown.'}
          </p>
          {planRows.length === 0 && (
            <p>No active tracked household plans in {currency}.</p>
          )}
          <ul className="recurring-cards">
            {planRows.map(({ plan, expectation }) => (
              <li id={`insights-plan-${plan.id}`} tabIndex={-1} key={plan.id}>
                <h6>
                  {plan.label} · {plan.kind.replace('_', ' ').toLowerCase()}
                </h6>
                <p>
                  Matching text (household-shared intent):{' '}
                  {plan.matchDescription}. Schedule:{' '}
                  {plan.cadence.toLowerCase()} from {plan.anchorOn}{' '}
                  {plan.calendarAnchor?.replaceAll('_', ' ').toLowerCase() ??
                    ''}
                  . Expected amount:{' '}
                  {plan.expectedAmount === null
                    ? 'unknown/variable'
                    : formatMoney(plan.expectedAmount, plan.currency)}
                  . Not counted as actual spending.
                </p>
                <p>
                  Latest scheduled slot:{' '}
                  {expectation.latestExpectedOn ?? 'not started'} ·{' '}
                  {expectation.latestState.replace('_', ' ').toLowerCase()}.{' '}
                  {expectation.latestState === 'OBSERVED'
                    ? 'One disclosed expense matched; payment is not verified.'
                    : expectation.latestState === 'AMBIGUOUS'
                      ? 'Multiple disclosed expenses matched; no charge was selected.'
                      : 'No verified payment status.'}{' '}
                  {expectation.matchedCount !== null
                    ? `${expectation.matchedCount} current matches. `
                    : ''}
                  {expectation.observedAmount !== null
                    ? `Observed expense ${formatMoney(expectation.observedAmount, plan.currency)}. `
                    : ''}
                  Next slot:{' '}
                  {expectation.nextExpectedOn ?? 'schedule date limit'}.{' '}
                  {expectation.windowFrom !== null
                    ? `Latest slot window [${expectation.windowFrom}, ${expectation.windowTo}).`
                    : ''}
                </p>
                <button
                  type="button"
                  className="household-button household-button--secondary"
                  onClick={() => void openEvidence('plan', plan.id)}
                >
                  View evidence
                </button>{' '}
                {owner && (
                  <>
                    <button
                      type="button"
                      className="household-button household-button--secondary"
                      onClick={() => startEdit(plan)}
                    >
                      Edit shared plan
                    </button>{' '}
                    <button
                      id={`recurring-archive-${plan.id}`}
                      type="button"
                      className="household-button household-button--secondary"
                      disabled={busy}
                      onClick={() => {
                        setArchiveTarget(plan);
                        requestAnimationFrame(() =>
                          document
                            .getElementById(
                              `recurring-archive-confirm-${plan.id}`,
                            )
                            ?.focus(),
                        );
                      }}
                    >
                      Archive plan
                    </button>
                    {archiveTarget?.id === plan.id &&
                      archiveTarget.version === plan.version && (
                        <div
                          className="household-notice"
                          role="group"
                          aria-label={`Archive ${plan.label} confirmation`}
                        >
                          <p>
                            Archive {plan.label}? This permanently removes it
                            from active tracking. It cannot be restored or
                            edited afterward. The independently authored
                            household intent remains readable in archived plans;
                            this does not cancel any bill or subscription.
                          </p>
                          <button
                            id={`recurring-archive-confirm-${plan.id}`}
                            type="button"
                            className="household-button"
                            disabled={busy}
                            onClick={() =>
                              void runAction(
                                (token, signal) =>
                                  patchRecurringPlan(
                                    household.id,
                                    plan.id,
                                    {
                                      expectedVersion: plan.version,
                                      status: 'ARCHIVED',
                                    },
                                    token,
                                    signal,
                                  ),
                                'Household plan archived; retained intent remains readable.',
                              )
                            }
                          >
                            Confirm archive
                          </button>{' '}
                          <button
                            type="button"
                            className="household-button household-button--secondary"
                            disabled={busy}
                            onClick={() => {
                              setArchiveTarget(null);
                              requestAnimationFrame(() =>
                                document
                                  .getElementById(
                                    `recurring-archive-${plan.id}`,
                                  )
                                  ?.focus(),
                              );
                            }}
                          >
                            Cancel archive
                          </button>
                        </div>
                      )}
                  </>
                )}
              </li>
            ))}
          </ul>
          {planCursor && (
            <button
              type="button"
              className="household-button"
              disabled={busy}
              onClick={() => void loadPage('plan')}
            >
              Load more active plans
            </button>
          )}
          {history.length > 0 && (
            <>
              <h6>Archived household plans · retained intent</h6>
              <ul className="recurring-cards">
                {history.map((plan) => (
                  <li key={plan.id}>
                    {plan.label} · {plan.kind.replace('_', ' ')} ·{' '}
                    {plan.matchDescription} · archived.{' '}
                    <button
                      type="button"
                      className="household-button household-button--secondary"
                      onClick={() => void openEvidence('plan', plan.id)}
                    >
                      View evidence
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {historyMore && (
            <button
              type="button"
              className="household-button"
              disabled={busy}
              onClick={() => void loadPage('history')}
            >
              Load more archived plans (history may be capped)
            </button>
          )}
        </>
      )}
      {detail && (
        <section
          className="insights-detail"
          aria-label="Current recurring evidence"
        >
          <h6>
            {detail.kind === 'candidate'
              ? 'Possible recurrence'
              : 'Tracked plan'}{' '}
            · current shared evidence
          </h6>
          {evidence ? (
            <>
              <p>
                Current window [{evidence.evidenceFrom}, {evidence.evidenceTo});
                as of {evidence.asOfDate}.{' '}
                {evidenceCursor
                  ? 'Evidence is partial.'
                  : 'All matching current evidence shown.'}{' '}
                Previously disclosed records do not remain available after
                unshare.
              </p>
              {'plan' in evidence && (
                <p>
                  Current plan: {evidence.plan.label} ·{' '}
                  {evidence.plan.status.toLowerCase()} · version{' '}
                  {evidence.plan.version}. Latest scheduled slot{' '}
                  {evidence.expectation.latestExpectedOn ?? 'not started'};{' '}
                  {evidence.expectation.latestState
                    .replace('_', ' ')
                    .toLowerCase()}
                  . Current evidence does not certify payment.
                </p>
              )}
              {detail.kind === 'candidate' &&
                'candidate' in evidence &&
                evidence.candidate === null && (
                  <p>
                    This description no longer qualifies as a suggestion.
                    Current disclosed expenses, if any, are shown below.
                  </p>
                )}
              {evidenceRows.length === 0 && (
                <p>No currently disclosed matching expenses.</p>
              )}
              <EvidenceRows
                items={evidenceRows}
                currency={currency}
                onOpenTransaction={onOpenTransaction}
              />
              {evidenceCursor && (
                <button
                  type="button"
                  className="household-button"
                  disabled={busy}
                  onClick={() => void loadPage('evidence')}
                >
                  Load more current evidence
                </button>
              )}
            </>
          ) : (
            <p role="status">Loading current evidence…</p>
          )}
          <button
            type="button"
            className="household-button household-button--secondary"
            onClick={() => {
              setDetail(null);
              setEvidence(null);
              setEvidenceRows([]);
              setEvidenceCursor(null);
            }}
          >
            Close evidence
          </button>
        </section>
      )}
      {owner && formOpen && (
        <form
          className="insights-detail recurring-form"
          onSubmit={submit}
          aria-label={editing ? 'Edit household plan' : 'Create household plan'}
        >
          <h6>
            {editing
              ? 'Edit retained household plan'
              : source
                ? 'Candidate-assisted plan · all fields editable'
                : 'Manual household plan'}
          </h6>
          <p>
            {source
              ? 'Prefilled only from the current disclosed candidate. You choose and can edit every field; saving checks current candidate freshness.'
              : 'Manual plans do not require a qualifying suggestion or observed charge.'}
          </p>
          <fieldset disabled={busy || pending !== null}>
            <legend>Plan fields and disclosure</legend>
            <label>
              Plan label{' '}
              <input
                id="recurring-plan-label"
                required
                maxLength={100}
                value={draft.label}
                onChange={(event) => {
                  setDraft({ ...draft, label: event.target.value });
                  setPending(null);
                }}
              />
            </label>
            <label>
              Kind{' '}
              <select
                value={draft.kind}
                onChange={(event) => {
                  setDraft({ ...draft, kind: event.target.value as PlanKind });
                  setPending(null);
                }}
              >
                {kinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind.replace('_', ' ')}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Matching description{' '}
              <input
                required
                maxLength={200}
                value={draft.matchDescription}
                onChange={(event) => {
                  setDraft({ ...draft, matchDescription: event.target.value });
                  setSource(null);
                  setPending(null);
                }}
              />
            </label>
            <label>
              Cadence{' '}
              <select
                value={draft.cadence}
                onChange={(event) => {
                  const cadence = event.target.value as Cadence;
                  setDraft({
                    ...draft,
                    cadence,
                    calendarAnchor:
                      cadence === 'WEEKLY' || cadence === 'BIWEEKLY'
                        ? null
                        : 'DAY_OF_MONTH',
                  });
                  setPending(null);
                }}
              >
                {cadences.map((cadence) => (
                  <option key={cadence}>{cadence}</option>
                ))}
              </select>
            </label>
            <label>
              Anchor date{' '}
              <input
                type="date"
                min="1900-01-01"
                max="9999-12-30"
                required
                value={draft.anchorOn}
                onChange={(event) => {
                  setDraft({ ...draft, anchorOn: event.target.value });
                  setPending(null);
                }}
              />
            </label>
            {draft.calendarAnchor !== null && (
              <label>
                Calendar anchor{' '}
                <select
                  value={draft.calendarAnchor}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      calendarAnchor: event.target.value as
                        'DAY_OF_MONTH' | 'END_OF_MONTH',
                    });
                    setPending(null);
                  }}
                >
                  <option value="DAY_OF_MONTH">
                    Day of month (clamped in shorter months)
                  </option>
                  <option value="END_OF_MONTH">
                    Month end (anchor must be last day of month)
                  </option>
                </select>
              </label>
            )}
            <label>
              Expected amount in {currency} (optional; leave blank for
              unknown/variable){' '}
              <input
                inputMode="decimal"
                value={draft.expectedAmount}
                onChange={(event) => {
                  setDraft({ ...draft, expectedAmount: event.target.value });
                  setPending(null);
                }}
              />
            </label>
            <div className="household-notice">
              <strong>Household disclosure preview</strong>
              <p>
                Current and future household members can read this retained plan
                even if any supporting transaction is later unshared. Archiving
                keeps this explicitly published intent. No evidence, source
                transaction or bank account is stored in the plan.
              </p>
              <dl>
                <dt>Label and kind</dt>
                <dd>
                  {draft.label || '(enter label)'} · {draft.kind}
                </dd>
                <dt>Currency and matching text</dt>
                <dd>
                  {currency} ·{' '}
                  {draft.matchDescription || '(enter matching text)'}
                </dd>
                <dt>Schedule</dt>
                <dd>
                  {draft.cadence} · {draft.anchorOn || '(choose date)'} ·{' '}
                  {draft.calendarAnchor ?? 'not applicable'}
                </dd>
                <dt>Expected amount</dt>
                <dd>{draft.expectedAmount || 'unknown/variable'}</dd>
              </dl>
              <label>
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(event) => {
                    setAck(event.target.checked);
                    setPending(null);
                  }}
                />{' '}
                I understand and authorize this household disclosure
              </label>
            </div>
          </fieldset>
          <button
            className="household-button"
            disabled={busy || !ack || pending !== null}
            type="submit"
          >
            {editing ? 'Save shared plan' : 'Create shared plan'}
          </button>{' '}
          <button
            className="household-button household-button--secondary"
            type="button"
            onClick={() => {
              setFormOpen(false);
              setEditing(null);
              setSource(null);
              setDraft(blankDraft());
              setAck(false);
              setPending(null);
            }}
          >
            Cancel plan form
          </button>
          {pending && (
            <p role="status">
              Create result unknown? Do not change fields before resolving it.
              Retry the identical request with its retained in-memory key, or
              reload current plans before making a new decision. An owner must
              still be authorized.
            </p>
          )}
          {pending && (
            <button
              type="button"
              className="household-button household-button--secondary"
              disabled={busy}
              onClick={() =>
                void runAction(
                  (token, signal) =>
                    createRecurringPlan(
                      household.id,
                      pending.input,
                      pending.key,
                      token,
                      signal,
                    ),
                  'Household plan confirmed.',
                )
              }
            >
              Retry same create request
            </button>
          )}
        </form>
      )}
    </section>
  );
}
