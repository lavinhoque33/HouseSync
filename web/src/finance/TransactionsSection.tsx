import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  ApiError,
  fetchCsrf,
  fetchFinancialAccounts,
  fetchTransaction,
  fetchTransactions,
  patchTransaction,
  postTransaction,
  type CreateTransactionInput,
  type CsrfToken,
  type FinancialAccount,
  type Household,
  type Money,
  type Transaction,
  type TransactionKind,
} from '../auth/client';
import {
  decodeMoneyAmount,
  encodeMoneyMagnitude,
  formatMoney,
  householdZoneToday,
  isFutureDate,
  isSupportedTransactionDate,
  type MoneySign,
} from './money';

interface Notice {
  kind: 'info' | 'error' | 'warning';
  text: string;
  correlationId?: string | undefined;
  showRefresh?: boolean | undefined;
}

interface PendingCreate {
  key: string;
  input: CreateTransactionInput;
}

interface PendingVoid {
  transaction: Transaction;
}

interface FieldErrors {
  account?: string | undefined;
  amount?: string | undefined;
  date?: string | undefined;
  description?: string | undefined;
}

interface TransactionsSectionProps {
  household: Household;
  csrf: CsrfToken | null;
  onCsrfRefreshed: (token: CsrfToken) => void;
  onSessionExpired: () => void;
  onHouseholdAccessChanged: () => void;
  authorityConfirmed: boolean;
}

const KIND_OPTIONS: Array<{
  value: TransactionKind;
  label: string;
  hint: string;
}> = [
  { value: 'EXPENSE', label: 'Expense', hint: 'Money out' },
  { value: 'INCOME', label: 'Income', hint: 'Money in' },
  { value: 'REFUND', label: 'Refund', hint: 'Money returned for an expense' },
  {
    value: 'TRANSFER',
    label: 'Transfer',
    hint: 'Money in or out of this account',
  },
];

const MIN_DATE = '1900-01-01';
const MAX_DATE = '9999-12-30';

function kindLabel(kind: TransactionKind): string {
  return KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
}

function validateDescription(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return 'Enter a description.';
  if ([...trimmed].length > 200) {
    return 'Description must be at most 200 characters.';
  }
  if (/\p{Cc}/u.test(trimmed)) {
    return 'Description must not contain control characters.';
  }
  return undefined;
}

/**
 * The economic sign is encoded from the kind and, for transfers, the
 * chosen direction; the user always types a positive magnitude.
 */
function signFor(kind: TransactionKind, direction: 'OUT' | 'IN'): MoneySign {
  switch (kind) {
    case 'EXPENSE':
      return 'negative';
    case 'REFUND':
    case 'INCOME':
      return 'positive';
    case 'TRANSFER':
      return direction === 'OUT' ? 'negative' : 'positive';
  }
}

/**
 * The earliest date a corrected expense may keep: every live refund on the
 * loaded page must stay on or after the expense date. Unknown history
 * remains a server-enforced `REFUND_CONFLICT`.
 */
function earliestLiveRefundDate(
  transactions: Transaction[],
  expenseId: string,
): string | undefined {
  let earliest: string | undefined;
  for (const transaction of transactions) {
    if (
      transaction.refundOfTransactionId === expenseId &&
      transaction.status === 'POSTED' &&
      (earliest === undefined || transaction.occurredOn < earliest)
    ) {
      earliest = transaction.occurredOn;
    }
  }
  return earliest;
}

export function TransactionsSection({
  household,
  csrf,
  onCsrfRefreshed,
  onSessionExpired,
  onHouseholdAccessChanged,
  authorityConfirmed,
}: TransactionsSectionProps) {
  const [accounts, setAccounts] = useState<FinancialAccount[] | null>(null);
  const [transactions, setTransactions] = useState<Transaction[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Create-form draft state. Date defaults to the household reporting zone
  // (`Etc/UTC` before reporting settings exist), never the browser zone.
  const [createAccountId, setCreateAccountId] = useState('');
  const [createKind, setCreateKind] = useState<
    'EXPENSE' | 'INCOME' | 'TRANSFER'
  >('EXPENSE');
  const [createAmount, setCreateAmount] = useState('');
  const [createDirection, setCreateDirection] = useState<'OUT' | 'IN'>('OUT');
  const [createDate, setCreateDate] = useState(householdZoneToday());
  const [createDescription, setCreateDescription] = useState('');
  const [createFieldErrors, setCreateFieldErrors] = useState<FieldErrors>({});
  // Refund creation originates from a posted expense row and locks the
  // account, currency, and source in the form below.
  const [refundSource, setRefundSource] = useState<Transaction | null>(null);

  const [creating, setCreating] = useState(false);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(
    null,
  );

  const [detail, setDetail] = useState<Transaction | null>(null);
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editDirection, setEditDirection] = useState<'OUT' | 'IN'>('OUT');
  const [editDate, setEditDate] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editFieldErrors, setEditFieldErrors] = useState<FieldErrors>({});

  const [pendingVoid, setPendingVoid] = useState<PendingVoid | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const csrfRef = useRef(csrf);
  const generationRef = useRef(0);
  const unmountedRef = useRef(false);
  const controllersRef = useRef<Set<AbortController>>(new Set());
  const creatingRef = useRef(false);
  const updatingRef = useRef<string | null>(null);
  // Synchronous source of truth for in-flight detail fetches: state updates
  // are async, so a second activation in the same flush must be refused by
  // the ref, not the not-yet-flushed state.
  const detailLoadingRef = useRef(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  const createAccountRef = useRef<HTMLSelectElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const editAmountRef = useRef<HTMLInputElement>(null);
  const voidConfirmRef = useRef<HTMLDivElement>(null);
  const voidTriggerRef = useRef<HTMLButtonElement | null>(null);
  const detailPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    csrfRef.current = csrf;
  }, [csrf]);

  function current(generation: number): boolean {
    return !unmountedRef.current && generationRef.current === generation;
  }

  function track(controller: AbortController) {
    controllersRef.current.add(controller);
  }

  function untrack(controller: AbortController) {
    controllersRef.current.delete(controller);
  }

  async function load(
    generation: number,
    controller: AbortController,
    preserveNotice = false,
  ) {
    setLoading(true);
    if (!preserveNotice) setNotice(null);
    try {
      const [accountPage, transactionPage] = await Promise.all([
        fetchFinancialAccounts(household.id, controller.signal),
        fetchTransactions(household.id, controller.signal),
      ]);
      if (!current(generation) || controller.signal.aborted) return;
      setAccounts(accountPage.items);
      setTransactions(transactionPage.items);
      setHasMore(transactionPage.hasMore);
      setLoading(false);
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not load your transactions.',
            });
      setLoading(false);
      if (apiError.status === 401) {
        setAccounts(null);
        setTransactions(null);
        onSessionExpired();
        return;
      }
      if (apiError.code === 'HOUSEHOLD_NOT_FOUND') {
        setAccounts(null);
        setTransactions(null);
        onHouseholdAccessChanged();
        return;
      }
      setNotice({
        kind: 'error',
        text: apiError.timedOut
          ? 'Loading transactions timed out. Refresh to try again.'
          : apiError.message || 'Could not load your transactions.',
        correlationId: apiError.correlationId,
        showRefresh: true,
      });
    }
  }

  function refresh() {
    if (loading || creatingRef.current || updatingRef.current !== null) return;
    reloadTransactions();
  }

  function reloadTransactions(preserveNotice = false) {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    track(controller);
    // A reload that settles a mutation keeps that mutation's outcome
    // notice visible; manual refreshes clear notices instead.
    void load(generation, controller, preserveNotice).finally(() =>
      untrack(controller),
    );
  }

  function clearScopedState() {
    setAccounts(null);
    setTransactions(null);
    setPendingCreate(null);
    setRefundSource(null);
    setDetail(null);
    setEditingId(null);
    setPendingVoid(null);
  }

  useEffect(() => {
    unmountedRef.current = false;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    track(controller);
    void load(generation, controller).finally(() => untrack(controller));
    const controllers = controllersRef.current;
    return () => {
      unmountedRef.current = true;
      generationRef.current += 1;
      for (const owned of controllers) owned.abort();
    };
    // Household identity is fixed for this keyed component instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

  useEffect(() => {
    if (pendingVoid) voidConfirmRef.current?.focus();
  }, [pendingVoid]);

  useEffect(() => {
    if (detail) detailPanelRef.current?.focus();
  }, [detail]);

  async function ensureCsrf(
    generation: number,
    signal: AbortSignal,
  ): Promise<CsrfToken | null> {
    if (csrfRef.current) return csrfRef.current;
    try {
      const fresh = await fetchCsrf(signal);
      if (!current(generation) || signal.aborted) return null;
      csrfRef.current = fresh;
      onCsrfRefreshed(fresh);
      return fresh;
    } catch {
      return null;
    }
  }

  async function refreshCsrf(generation: number, signal: AbortSignal) {
    try {
      const fresh = await fetchCsrf(signal);
      if (!current(generation) || signal.aborted) return false;
      csrfRef.current = fresh;
      onCsrfRefreshed(fresh);
      return true;
    } catch {
      return false;
    }
  }

  function handleSessionLost() {
    clearScopedState();
    onSessionExpired();
  }

  function handleAccessLost() {
    clearScopedState();
    onHouseholdAccessChanged();
  }

  function mapCommonErrors(apiError: ApiError): boolean {
    if (apiError.status === 401) {
      handleSessionLost();
      return true;
    }
    if (apiError.code === 'HOUSEHOLD_NOT_FOUND') {
      handleAccessLost();
      return true;
    }
    return false;
  }

  function buildCreateInput():
    | { ok: true; input: CreateTransactionInput }
    | { ok: false; errors: FieldErrors } {
    const errors: FieldErrors = {};
    const source = refundSource;
    const accountId = source ? source.accountId : createAccountId;
    const account = accounts?.find((value) => value.id === accountId);
    if (!source && !createAccountId) {
      // The select's first option is an explicit placeholder.
      errors.account = 'Choose an account.';
    }
    if (!account) {
      return { ok: false, errors: { account: 'Choose an account.' } };
    }
    const kind = source ? 'REFUND' : createKind;
    const sign = signFor(kind, createDirection);
    const encoded = encodeMoneyMagnitude(createAmount, account.currency, sign);
    if (!encoded.ok) {
      errors.amount = encoded.error;
    }
    if (!isSupportedTransactionDate(createDate)) {
      errors.date = `Enter a calendar date between ${MIN_DATE} and ${MAX_DATE}.`;
    } else if (source && createDate < source.occurredOn) {
      errors.date = `The refund date cannot be before the expense date (${source.occurredOn}).`;
    }
    const description = validateDescription(createDescription);
    if (description) {
      errors.description = description;
    }
    if (Object.keys(errors).length > 0) {
      return { ok: false, errors };
    }
    // Validations passed, so the encoding is known to be ok.
    const money: Money = {
      amount: encoded.ok ? encoded.amount : '',
      currency: account.currency,
    };
    if (source) {
      // Refund visibility is inherited from the source expense by
      // omission; the exact source is carried on the payload.
      return {
        ok: true,
        input: {
          accountId: source.accountId,
          kind: 'REFUND',
          money,
          occurredOn: createDate,
          description: createDescription.trim(),
          refundOfTransactionId: source.id,
        },
      };
    }
    return {
      ok: true,
      input: {
        accountId,
        kind: createKind,
        money,
        occurredOn: createDate,
        description: createDescription.trim(),
        visibility: 'PRIVATE',
      },
    };
  }

  function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (creatingRef.current || pendingCreate || !authorityConfirmed) return;
    const built = buildCreateInput();
    if (!built.ok) {
      setCreateFieldErrors(built.errors);
      setNotice({ kind: 'error', text: 'Check the highlighted fields.' });
      // Focus the first field that needs attention.
      const focus =
        built.errors.account !== undefined
          ? createAccountRef.current
          : amountRef.current;
      requestAnimationFrame(() => focus?.focus());
      return;
    }
    setCreateFieldErrors({});
    const request: PendingCreate = {
      key: crypto.randomUUID(),
      input: built.input,
    };
    setPendingCreate(request);
    void submitCreate(request);
  }

  function resetCreateForm() {
    // Like the accounts section, a known outcome clears the entry draft
    // but keeps the chosen account, type, and direction for convenience.
    setCreateAmount('');
    setCreateDate(householdZoneToday());
    setCreateDescription('');
    setCreateFieldErrors({});
    setRefundSource(null);
  }

  function mapCreateFieldErrors(
    apiError: ApiError,
    setters: {
      setFieldErrors: (errors: FieldErrors) => void;
      focusAmount: () => void;
    },
  ): boolean {
    const fieldErrors = apiError.fieldErrors;
    if (!fieldErrors) return false;
    const mapped: FieldErrors = {};
    if (fieldErrors['money.amount']) {
      mapped.amount = fieldErrors['money.amount'];
    }
    if (fieldErrors.occurredOn) {
      mapped.date = fieldErrors.occurredOn;
    }
    if (fieldErrors.description) {
      mapped.description = fieldErrors.description;
    }
    if (Object.keys(mapped).length > 0) {
      setters.setFieldErrors(mapped);
      setters.focusAmount();
      return true;
    }
    return false;
  }

  async function submitCreate(request: PendingCreate) {
    if (creatingRef.current || !authorityConfirmed) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    track(controller);
    creatingRef.current = true;
    setCreating(true);
    setNotice(null);
    try {
      const token = await ensureCsrf(generation, controller.signal);
      if (!current(generation) || controller.signal.aborted) return;
      if (!token) {
        setNotice({
          kind: 'error',
          text: 'Security setup is still loading. Retry the same request.',
        });
        return;
      }
      const created = await postTransaction(
        household.id,
        request.input,
        request.key,
        token,
        controller.signal,
      );
      if (!current(generation) || controller.signal.aborted) return;
      setPendingCreate(null);
      resetCreateForm();
      setNotice({
        kind: 'info',
        text: `${kindLabel(created.kind)} recorded: ${formatMoney(
          created.money.amount,
          created.money.currency,
        )} on ${created.occurredOn}.`,
      });
      reloadTransactions(true);
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not reach the server.',
            });
      if (mapCommonErrors(apiError)) return;
      if (apiError.code === 'CSRF_INVALID') {
        const refreshed = await refreshCsrf(generation, controller.signal);
        if (!current(generation) || controller.signal.aborted) return;
        setNotice({
          kind: 'error',
          text: refreshed
            ? 'Your security token was refreshed. Retry the same transaction request.'
            : 'Your secure request expired. Reload before retrying.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      if (
        apiError.timedOut ||
        apiError.code === 'NETWORK_ERROR' ||
        apiError.code === 'FINANCE_BUSY'
      ) {
        // The exact request and key stay retained in the durable block
        // below; this transient notice deliberately carries no actions so
        // a later notice can never strand the retained retry.
        setNotice({
          kind: 'warning',
          text: 'Transaction creation has an unknown outcome. Retry the same request safely, or refresh the list before retrying.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      if (
        mapCreateFieldErrors(apiError, {
          setFieldErrors: setCreateFieldErrors,
          focusAmount: () => amountRef.current?.focus(),
        })
      ) {
        setPendingCreate(null);
        setNotice({
          kind: 'error',
          text: 'Check the highlighted transaction details.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      setPendingCreate(null);
      setNotice({
        kind: 'error',
        text: createFailureText(apiError),
        correlationId: apiError.correlationId,
        showRefresh:
          apiError.code === 'ACCOUNT_ARCHIVED' ||
          apiError.code === 'IDEMPOTENCY_CONFLICT' ||
          apiError.code === 'REFUND_CONFLICT',
      });
    } finally {
      untrack(controller);
      creatingRef.current = false;
      if (!unmountedRef.current) setCreating(false);
    }
  }

  function createFailureText(apiError: ApiError): string {
    switch (apiError.code) {
      case 'ACCOUNT_ARCHIVED':
        return 'That account is archived now. Refresh accounts before recording here.';
      case 'IDEMPOTENCY_CONFLICT':
        return 'This request key was already used with different details. Review the entry and start again.';
      case 'REFUND_CONFLICT':
        return 'The refund no longer matches its expense. Refresh the list and check the expense.';
      case 'FINANCIAL_ACCOUNT_NOT_FOUND':
        return 'The account for this entry is no longer available. Refresh accounts.';
      case 'TRANSACTION_NOT_FOUND':
        return 'The expense this refund refers to is no longer available. Refresh the list.';
      default:
        return (
          apiError.message || 'Transaction creation could not be completed.'
        );
    }
  }

  function beginEdit(transaction: Transaction) {
    if (updatingRef.current !== null || pendingVoid) return;
    const decoded = decodeMoneyAmount(
      transaction.money.amount,
      transaction.money.currency,
    );
    setEditingId(transaction.id);
    setEditAmount(decoded ? decoded.magnitude : '');
    setEditDirection(decoded && decoded.sign === 'negative' ? 'OUT' : 'IN');
    setEditDate(transaction.occurredOn);
    setEditDescription(transaction.description);
    setEditFieldErrors({});
    requestAnimationFrame(() => editAmountRef.current?.focus());
  }

  function cancelEdit(transactionId?: string) {
    setEditingId(null);
    setEditAmount('');
    setEditDescription('');
    setEditFieldErrors({});
    // Cancel is the initiating control's dismissal: restore focus to the
    // re-created Edit trigger. Programmatic closes (success, conflict)
    // pass no id because the outcome notice takes focus instead.
    if (transactionId) {
      requestAnimationFrame(() => {
        if (unmountedRef.current) return;
        document.getElementById(`edit-trigger-${transactionId}`)?.focus();
      });
    }
  }

  async function submitEdit(transaction: Transaction) {
    if (updatingRef.current !== null || !authorityConfirmed) return;
    const generation = generationRef.current;
    const account = accounts?.find(
      (value) => value.id === transaction.accountId,
    );
    const currency = transaction.money.currency;
    const sign =
      transaction.kind === 'TRANSFER'
        ? editDirection === 'OUT'
          ? 'negative'
          : 'positive'
        : transaction.kind === 'EXPENSE'
          ? 'negative'
          : 'positive';
    const errors: FieldErrors = {};
    const encoded = encodeMoneyMagnitude(editAmount, currency, sign);
    if (!encoded.ok) errors.amount = encoded.error;
    if (!isSupportedTransactionDate(editDate)) {
      errors.date = `Enter a calendar date between ${MIN_DATE} and ${MAX_DATE}.`;
    } else if (transaction.kind === 'REFUND') {
      const source = transactions?.find(
        (value) => value.id === transaction.refundOfTransactionId,
      );
      if (source && editDate < source.occurredOn) {
        errors.date = `The refund date cannot be before the expense date (${source.occurredOn}).`;
      }
    } else if (transaction.kind === 'EXPENSE' && account) {
      const bound = earliestLiveRefundDate(transactions ?? [], transaction.id);
      if (bound && editDate > bound) {
        errors.date = `This expense has refunds on ${bound}; its date cannot be later.`;
      }
    }
    const description = validateDescription(editDescription);
    if (description) errors.description = description;
    if (Object.keys(errors).length > 0) {
      setEditFieldErrors(errors);
      setNotice({ kind: 'error', text: 'Check the highlighted fields.' });
      requestAnimationFrame(() => editAmountRef.current?.focus());
      return;
    }
    const patch: {
      expectedVersion: number;
      money?: Money;
      occurredOn?: string;
      description?: string;
    } = { expectedVersion: transaction.version };
    // Validations passed, so the encoding is known to be ok.
    const amountString = encoded.ok ? encoded.amount : '';
    const changedMoney = amountString !== transaction.money.amount;
    const changedDate = editDate !== transaction.occurredOn;
    const changedDescription =
      editDescription.trim() !== transaction.description;
    if (!changedMoney && !changedDate && !changedDescription) {
      // An unchanged correction must not send `{expectedVersion}` only:
      // close locally with a status instead of a no-op request.
      cancelEdit(transaction.id);
      setNotice({
        kind: 'info',
        text: 'The correction matches the recorded entry. Nothing to save.',
      });
      return;
    }
    if (changedMoney) {
      patch.money = { amount: amountString, currency };
    }
    if (changedDate) patch.occurredOn = editDate;
    if (changedDescription) patch.description = editDescription.trim();
    const controller = new AbortController();
    track(controller);
    updatingRef.current = transaction.id;
    setUpdatingId(transaction.id);
    setNotice(null);
    try {
      const token = await ensureCsrf(generation, controller.signal);
      if (!current(generation) || controller.signal.aborted) return;
      if (!token) {
        setNotice({ kind: 'error', text: 'Security setup failed. Retry.' });
        return;
      }
      const updated = await patchTransaction(
        household.id,
        transaction.id,
        patch,
        token,
        controller.signal,
      );
      if (!current(generation) || controller.signal.aborted) return;
      cancelEdit();
      if (detail?.id === updated.id) setDetail(null);
      setNotice({
        kind: 'info',
        text: `Transaction corrected: ${formatMoney(
          updated.money.amount,
          updated.money.currency,
        )} on ${updated.occurredOn}.`,
      });
      reloadTransactions(true);
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not reach the server.',
            });
      if (mapCommonErrors(apiError)) return;
      if (apiError.code === 'CSRF_INVALID') {
        const refreshed = await refreshCsrf(generation, controller.signal);
        if (!current(generation) || controller.signal.aborted) return;
        setNotice({
          kind: 'error',
          text: refreshed
            ? 'Your security token was refreshed. Review the correction and retry.'
            : 'Your secure request expired. Reload before retrying.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      if (apiError.code === 'TRANSACTION_NOT_FOUND') {
        // The row is stale in this list: drop it locally and offer a
        // refresh, never a claimed success or failure.
        setTransactions((currentTransactions) =>
          (currentTransactions ?? []).filter(
            (value) => value.id !== transaction.id,
          ),
        );
        cancelEdit();
        setDetail(null);
        setNotice({
          kind: 'warning',
          text: 'This transaction is no longer available to you. Refresh to see the current list.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        return;
      }
      if (
        apiError.code === 'RESOURCE_VERSION_CONFLICT' ||
        apiError.code === 'TRANSACTION_VOIDED' ||
        apiError.code === 'RESOURCE_VERSION_EXHAUSTED' ||
        apiError.timedOut ||
        apiError.code === 'FINANCE_BUSY' ||
        apiError.code === 'NETWORK_ERROR'
      ) {
        // Stale or uncertain: the editor may no longer describe the
        // server's state, so close it and reload before any correction.
        cancelEdit();
        setDetail(null);
        setNotice({
          kind:
            apiError.timedOut || apiError.code === 'FINANCE_BUSY'
              ? 'warning'
              : 'error',
          text:
            apiError.timedOut ||
            apiError.code === 'FINANCE_BUSY' ||
            apiError.code === 'NETWORK_ERROR'
              ? 'The correction has an unknown outcome. Refresh the list before retrying.'
              : 'This transaction changed on the server. The list was refreshed; review before retrying.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        reloadTransactions(true);
        return;
      }
      if (
        mapCreateFieldErrors(apiError, {
          setFieldErrors: setEditFieldErrors,
          focusAmount: () => editAmountRef.current?.focus(),
        })
      ) {
        setNotice({
          kind: 'error',
          text: 'Check the highlighted transaction details.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      setNotice({
        kind: 'error',
        text:
          apiError.code === 'REFUND_CONFLICT'
            ? "The correction conflicts with this expense's refunds. Refresh the list and check the bound."
            : apiError.message || 'The transaction could not be corrected.',
        correlationId: apiError.correlationId,
      });
    } finally {
      untrack(controller);
      updatingRef.current = null;
      if (!unmountedRef.current) setUpdatingId(null);
    }
  }

  function openVoidConfirm(
    transaction: Transaction,
    trigger: HTMLButtonElement,
  ) {
    if (
      pendingVoid !== null ||
      updatingRef.current !== null ||
      creatingRef.current ||
      loading ||
      !authorityConfirmed
    ) {
      return;
    }
    voidTriggerRef.current = trigger;
    setPendingVoid({ transaction });
  }

  function cancelVoidConfirm() {
    setPendingVoid(null);
    const trigger = voidTriggerRef.current;
    voidTriggerRef.current = null;
    trigger?.focus();
  }

  function handleVoidConfirmKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelVoidConfirm();
    }
  }

  async function confirmVoid() {
    const pending = pendingVoid;
    if (!pending || updatingRef.current !== null) return;
    setPendingVoid(null);
    voidTriggerRef.current = null;
    const { transaction } = pending;
    const generation = generationRef.current;
    const controller = new AbortController();
    track(controller);
    updatingRef.current = transaction.id;
    setUpdatingId(transaction.id);
    setNotice(null);
    try {
      const token = await ensureCsrf(generation, controller.signal);
      if (!current(generation) || controller.signal.aborted) return;
      if (!token) {
        setNotice({ kind: 'error', text: 'Security setup failed. Retry.' });
        return;
      }
      const voided = await patchTransaction(
        household.id,
        transaction.id,
        { expectedVersion: transaction.version, status: 'VOIDED' },
        token,
        controller.signal,
      );
      if (!current(generation) || controller.signal.aborted) return;
      if (detail?.id === voided.id) setDetail(voided);
      setNotice({
        kind: 'info',
        text: `Transaction voided. It stays listed as voided and stops counting toward spending.`,
      });
      reloadTransactions(true);
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not reach the server.',
            });
      if (mapCommonErrors(apiError)) return;
      if (apiError.code === 'CSRF_INVALID') {
        const refreshed = await refreshCsrf(generation, controller.signal);
        if (!current(generation) || controller.signal.aborted) return;
        setNotice({
          kind: 'error',
          text: refreshed
            ? 'Your security token was refreshed. Review the transaction and retry the void.'
            : 'Your secure request expired. Reload before retrying.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      if (apiError.code === 'TRANSACTION_NOT_FOUND') {
        setTransactions((currentTransactions) =>
          (currentTransactions ?? []).filter(
            (value) => value.id !== transaction.id,
          ),
        );
        setNotice({
          kind: 'warning',
          text: 'This transaction is no longer available to you. Refresh to see the current list.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        return;
      }
      if (
        apiError.code === 'RESOURCE_VERSION_CONFLICT' ||
        apiError.code === 'RESOURCE_VERSION_EXHAUSTED' ||
        apiError.timedOut ||
        apiError.code === 'FINANCE_BUSY' ||
        apiError.code === 'NETWORK_ERROR'
      ) {
        setNotice({
          kind:
            apiError.timedOut || apiError.code === 'FINANCE_BUSY'
              ? 'warning'
              : 'error',
          text: 'The void has an uncertain outcome. The list was refreshed; review before retrying.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        reloadTransactions(true);
        return;
      }
      setNotice({
        kind: 'error',
        text:
          apiError.code === 'REFUND_CONFLICT'
            ? 'Void its refunds before voiding this expense. Refresh the list to see them.'
            : apiError.message || 'The transaction could not be voided.',
        correlationId: apiError.correlationId,
        showRefresh: apiError.code === 'REFUND_CONFLICT',
      });
    } finally {
      untrack(controller);
      updatingRef.current = null;
      if (!unmountedRef.current) setUpdatingId(null);
    }
  }

  async function openDetail(transaction: Transaction) {
    // The ref guards same-flush double activations; the state flag only
    // disables controls for the UI.
    if (detailLoadingRef.current || detailLoadingId !== null) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    track(controller);
    detailLoadingRef.current = true;
    setDetailLoadingId(transaction.id);
    setNotice(null);
    try {
      const fresh = await fetchTransaction(
        household.id,
        transaction.id,
        controller.signal,
      );
      // Guards block every late continuation after unmount, a household
      // replacement, or any newer generation taking over this section.
      if (!current(generation) || controller.signal.aborted) return;
      setDetail(fresh);
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not reach the server.',
            });
      if (apiError.code === 'TRANSACTION_NOT_FOUND') {
        setTransactions((currentTransactions) =>
          (currentTransactions ?? []).filter(
            (value) => value.id !== transaction.id,
          ),
        );
        setNotice({
          kind: 'warning',
          text: 'This transaction is no longer available to you. Refresh to see the current list.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
      } else if (apiError.status === 401) {
        handleSessionLost();
      } else if (apiError.code === 'HOUSEHOLD_NOT_FOUND') {
        handleAccessLost();
      } else {
        setNotice({
          kind: 'error',
          text: apiError.message || 'Could not load this transaction.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
      }
    } finally {
      untrack(controller);
      detailLoadingRef.current = false;
      if (!unmountedRef.current) setDetailLoadingId(null);
    }
  }

  function closeDetail() {
    const closing = detail;
    setDetail(null);
    // The Details trigger element persists (the panel renders after the
    // list, not in place of the row actions), so focus returns by its
    // stable id after the flush removes the panel.
    if (closing) {
      requestAnimationFrame(() => {
        if (unmountedRef.current) return;
        document.getElementById(`details-trigger-${closing.id}`)?.focus();
      });
    }
  }

  function startRefund(expense: Transaction) {
    if (updatingRef.current !== null || pendingVoid) return;
    setRefundSource(expense);
    setCreateAccountId(expense.accountId);
    setCreateKind('EXPENSE');
    setCreateAmount('');
    setCreateDate(householdZoneToday());
    setCreateDescription('');
    setCreateFieldErrors({});
    requestAnimationFrame(() => amountRef.current?.focus());
  }

  function cancelRefund() {
    setRefundSource(null);
    setCreateKind('EXPENSE');
    setCreateFieldErrors({});
  }

  const activeAccounts = (accounts ?? []).filter(
    (account) => account.status === 'ACTIVE',
  );
  const accountNameById = new Map<string, string>();
  for (const account of accounts ?? []) {
    accountNameById.set(account.id, account.name);
  }
  const selectedAccount = accounts?.find(
    (account) =>
      account.id === (refundSource ? refundSource.accountId : createAccountId),
  );
  const selectedCurrency = selectedAccount?.currency;
  const createMinDate = refundSource ? refundSource.occurredOn : MIN_DATE;
  const createFutureWarning = isFutureDate(createDate);

  const busy =
    loading || creating || updatingId !== null || detailLoadingId !== null;

  return (
    <section
      className="finance-transactions"
      aria-labelledby={`finance-transactions-${household.id}`}
    >
      <div className="finance-accounts-heading">
        <div>
          <p className="eyebrow">Private manual entries</p>
          <h4 id={`finance-transactions-${household.id}`}>Transactions</h4>
        </div>
        <span className="privacy-chip">Entries private by default</span>
      </div>
      <p className="finance-helper">
        Every entry starts private to you. There is no sharing yet: household
        disclosure arrives in a later update. Voided entries stay listed and are
        never counted.
      </p>

      {!authorityConfirmed && (
        <p role="status" className="household-stale">
          Refresh the household before changing transactions.
        </p>
      )}

      {loading && transactions === null && (
        <p role="status" aria-live="polite">
          Loading your transactions…
        </p>
      )}

      {notice && (
        <div
          ref={noticeRef}
          tabIndex={-1}
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={`household-notice household-notice--${notice.kind}`}
        >
          <p>{notice.text}</p>
          {notice.correlationId && (
            <p className="household-notice-detail">
              Reference: {notice.correlationId}
            </p>
          )}
          {notice.showRefresh && (
            <button
              type="button"
              className="household-button household-button--secondary"
              disabled={busy}
              onClick={refresh}
            >
              Refresh transactions
            </button>
          )}
        </div>
      )}

      {transactions !== null && pendingCreate !== null && (
        // Durable same-key retry affordance: it lives outside the transient
        // notice so a refresh or any later notice can never strand the
        // retained request. A refresh deliberately does not clear it — the
        // list cannot prove which unknown request committed, because
        // duplicate descriptions are valid — so the exact request stays
        // reconcilable until a same-key retry returns a known outcome.
        <div className="finance-pending-request">
          <p>
            An earlier transaction still has an unknown result. Retry the exact
            same request with its original key, or refresh the list first.
            Refreshing keeps this request available; it cannot prove which
            request was recorded.
          </p>
          <div className="finance-account-actions">
            <button
              type="button"
              className="household-button"
              disabled={busy || !authorityConfirmed}
              onClick={() => void submitCreate(pendingCreate)}
            >
              Retry same request
            </button>
            <button
              type="button"
              className="household-button household-button--secondary"
              disabled={busy}
              onClick={refresh}
            >
              Refresh transactions
            </button>
          </div>
        </div>
      )}

      {transactions !== null && transactions.length === 0 && !loading && (
        <p className="finance-empty">No transactions yet.</p>
      )}

      {transactions !== null && transactions.length > 0 && (
        <ul className="finance-transaction-list" aria-label="Your transactions">
          {transactions.map((transaction) => {
            const voided = transaction.status === 'VOIDED';
            const refundLabel = transaction.refundOfTransactionId
              ? `Refund of an expense recorded on ${
                  transactions.find(
                    (value) => value.id === transaction.refundOfTransactionId,
                  )?.occurredOn ?? 'an earlier date'
                }`
              : null;
            return (
              <li
                key={transaction.id}
                className={`finance-transaction-card${
                  voided ? ' finance-transaction-card--voided' : ''
                }`}
              >
                <div className="finance-transaction-summary">
                  <div>
                    <p className="finance-transaction-name">
                      {transaction.description}
                    </p>
                    <p className="household-meta">
                      {kindLabel(transaction.kind)} ·{' '}
                      <time dateTime={transaction.occurredOn}>
                        {transaction.occurredOn}
                      </time>{' '}
                      ·{' '}
                      {accountNameById.get(transaction.accountId) ??
                        'Your account'}{' '}
                      · {voided ? 'Voided' : 'Posted'}
                    </p>
                    {refundLabel && (
                      <p className="household-meta">{refundLabel}</p>
                    )}
                  </div>
                  <span className="finance-amount">
                    {formatMoney(
                      transaction.money.amount,
                      transaction.money.currency,
                    )}
                  </span>
                </div>
                <div className="finance-transaction-meta">
                  <span className="privacy-chip">Private</span>
                  {voided && (
                    <span className="finance-voided-chip">Voided</span>
                  )}
                </div>

                {editingId === transaction.id ? (
                  <EditForm
                    transaction={transaction}
                    currency={transaction.money.currency}
                    editAmount={editAmount}
                    editDirection={editDirection}
                    editDate={editDate}
                    editDescription={editDescription}
                    editFieldErrors={editFieldErrors}
                    busy={busy}
                    authorityConfirmed={authorityConfirmed}
                    minDate={
                      transaction.kind === 'REFUND'
                        ? (transactions.find(
                            (value) =>
                              value.id === transaction.refundOfTransactionId,
                          )?.occurredOn ?? MIN_DATE)
                        : MIN_DATE
                    }
                    onAmountChange={setEditAmount}
                    onDirectionChange={setEditDirection}
                    onDateChange={setEditDate}
                    onDescriptionChange={setEditDescription}
                    onSubmit={() => void submitEdit(transaction)}
                    onCancel={() => cancelEdit(transaction.id)}
                    editAmountRef={editAmountRef}
                  />
                ) : (
                  <div className="finance-account-actions">
                    <button
                      type="button"
                      id={`details-trigger-${transaction.id}`}
                      className="household-button household-button--secondary"
                      disabled={busy || !authorityConfirmed}
                      aria-label={`Details for ${transaction.description}`}
                      onClick={() => void openDetail(transaction)}
                    >
                      Details
                    </button>
                    {!voided && (
                      <>
                        <button
                          type="button"
                          id={`edit-trigger-${transaction.id}`}
                          className="household-button household-button--secondary"
                          disabled={busy || !authorityConfirmed}
                          aria-label={`Edit ${transaction.description}`}
                          onClick={() => beginEdit(transaction)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="household-button household-button--secondary"
                          disabled={busy || !authorityConfirmed}
                          aria-label={`Void ${transaction.description}`}
                          onClick={(event) =>
                            openVoidConfirm(transaction, event.currentTarget)
                          }
                        >
                          Void
                        </button>
                        {transaction.kind === 'EXPENSE' && (
                          <button
                            type="button"
                            className="household-button household-button--secondary"
                            disabled={busy || !authorityConfirmed}
                            aria-label={`Record a refund for ${transaction.description}`}
                            onClick={() => startRefund(transaction)}
                          >
                            Refund
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {hasMore && (
        <p role="status" className="finance-helper">
          Showing the first 100 transactions. Additional paging will arrive with
          larger-history support.
        </p>
      )}

      {pendingVoid && (
        <div
          ref={voidConfirmRef}
          tabIndex={-1}
          role="group"
          aria-label={`Confirm void for ${pendingVoid.transaction.description}`}
          className="household-notice household-notice--warning finance-void-confirm"
          onKeyDown={handleVoidConfirmKeyDown}
        >
          <p>
            Void “{pendingVoid.transaction.description}”? It stays listed as
            voided, stops counting toward spending, and can never be edited or
            restored. If it is an expense, void its refunds first.
          </p>
          <div className="finance-account-actions">
            <button
              type="button"
              className="household-button"
              disabled={busy}
              onClick={() => void confirmVoid()}
            >
              Void transaction
            </button>
            <button
              type="button"
              className="household-button household-button--secondary"
              disabled={busy}
              onClick={cancelVoidConfirm}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {detail && (
        <div
          ref={detailPanelRef}
          tabIndex={-1}
          role="group"
          aria-label={`Details for ${detail.description}`}
          className="finance-detail-panel"
        >
          <h5>Transaction details</h5>
          <dl className="finance-detail-list">
            <div>
              <dt>Description</dt>
              <dd>{detail.description}</dd>
            </div>
            <div>
              <dt>Amount</dt>
              <dd>{formatMoney(detail.money.amount, detail.money.currency)}</dd>
            </div>
            <div>
              <dt>Kind</dt>
              <dd>{kindLabel(detail.kind)}</dd>
            </div>
            <div>
              <dt>Date</dt>
              <dd>
                <time dateTime={detail.occurredOn}>{detail.occurredOn}</time>
              </dd>
            </div>
            <div>
              <dt>Account</dt>
              <dd>
                {accountNameById.get(detail.accountId) ?? detail.accountId}
              </dd>
            </div>
            <div>
              <dt>Privacy</dt>
              <dd>Private — only you can read this entry.</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{detail.status === 'POSTED' ? 'Posted' : 'Voided'}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>Manual</dd>
            </div>
            <div>
              <dt>Refund source</dt>
              <dd>
                {detail.refundOfTransactionId
                  ? detail.refundOfTransactionId
                  : 'None — not a refund'}
              </dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{detail.version}</dd>
            </div>
            <div>
              <dt>Recorded</dt>
              <dd>
                <time dateTime={detail.createdAt}>{detail.createdAt}</time>
              </dd>
            </div>
            <div>
              <dt>Last changed</dt>
              <dd>
                <time dateTime={detail.updatedAt}>{detail.updatedAt}</time>
              </dd>
            </div>
          </dl>
          <div className="finance-account-actions">
            <button
              type="button"
              className="household-button household-button--secondary"
              disabled={busy}
              onClick={closeDetail}
            >
              Close details
            </button>
          </div>
        </div>
      )}

      {transactions !== null && !loading && (
        <form
          className="finance-create-form"
          onSubmit={handleCreate}
          noValidate
        >
          <h5>Record a transaction</h5>
          {refundSource && (
            <p className="finance-refund-context">
              Refund of the expense “{refundSource.description}” recorded on{' '}
              {refundSource.occurredOn}. The account, currency, and source are
              fixed to it, and the refund inherits this expense's privacy.
            </p>
          )}
          {!refundSource && (
            <div className="household-field">
              <label htmlFor={`new-transaction-account-${household.id}`}>
                Account
              </label>
              <select
                ref={createAccountRef}
                id={`new-transaction-account-${household.id}`}
                value={createAccountId}
                onChange={(event) => {
                  setCreateAccountId(event.target.value);
                  setCreateFieldErrors({});
                }}
                disabled={busy || pendingCreate !== null || !authorityConfirmed}
                aria-invalid={Boolean(createFieldErrors.account)}
                aria-describedby={
                  createFieldErrors.account
                    ? `new-transaction-account-error-${household.id}`
                    : undefined
                }
              >
                <option value="">Choose an account…</option>
                {activeAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} · {account.currency}
                  </option>
                ))}
              </select>
              {createFieldErrors.account && (
                <p
                  id={`new-transaction-account-error-${household.id}`}
                  className="household-error"
                  role="alert"
                >
                  {createFieldErrors.account}
                </p>
              )}
            </div>
          )}
          <div className="finance-create-grid">
            <div className="household-field">
              <label htmlFor={`new-transaction-kind-${household.id}`}>
                Entry type
              </label>
              {refundSource ? (
                <p className="finance-locked-value">Refund (fixed)</p>
              ) : (
                <select
                  id={`new-transaction-kind-${household.id}`}
                  value={createKind}
                  onChange={(event) =>
                    setCreateKind(
                      event.target.value as 'EXPENSE' | 'INCOME' | 'TRANSFER',
                    )
                  }
                  disabled={
                    busy || pendingCreate !== null || !authorityConfirmed
                  }
                >
                  {KIND_OPTIONS.filter(
                    (option) => option.value !== 'REFUND',
                  ).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} — {option.hint}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="household-field">
              <span className="household-field-label">Currency</span>
              <p className="finance-locked-value">
                {selectedCurrency ??
                  (refundSource ? refundSource.money.currency : '—')}
              </p>
            </div>
          </div>
          {createKind === 'TRANSFER' && !refundSource && (
            <fieldset className="finance-direction-fieldset">
              <legend>Transfer direction</legend>
              <label className="finance-direction-option">
                <input
                  type="radio"
                  name={`transfer-direction-${household.id}`}
                  value="OUT"
                  checked={createDirection === 'OUT'}
                  onChange={() => setCreateDirection('OUT')}
                  disabled={
                    busy || pendingCreate !== null || !authorityConfirmed
                  }
                />
                <span>Money out (−)</span>
              </label>
              <label className="finance-direction-option">
                <input
                  type="radio"
                  name={`transfer-direction-${household.id}`}
                  value="IN"
                  checked={createDirection === 'IN'}
                  onChange={() => setCreateDirection('IN')}
                  disabled={
                    busy || pendingCreate !== null || !authorityConfirmed
                  }
                />
                <span>Money in (+)</span>
              </label>
            </fieldset>
          )}
          <div className="household-field">
            <label htmlFor={`new-transaction-amount-${household.id}`}>
              Amount
            </label>
            <input
              ref={amountRef}
              id={`new-transaction-amount-${household.id}`}
              value={createAmount}
              onChange={(event) => {
                setCreateAmount(event.target.value);
                setCreateFieldErrors({});
              }}
              inputMode="decimal"
              autoComplete="off"
              disabled={busy || pendingCreate !== null || !authorityConfirmed}
              aria-invalid={Boolean(createFieldErrors.amount)}
              aria-describedby={
                createFieldErrors.amount
                  ? `new-transaction-amount-hint-${household.id} new-transaction-amount-error-${household.id}`
                  : `new-transaction-amount-hint-${household.id}`
              }
            />
            <p
              id={`new-transaction-amount-hint-${household.id}`}
              className="household-hint"
            >
              {refundSource
                ? 'The returned amount, without a sign.'
                : 'Positive size only; the entry type sets the direction. Use a decimal point (12.50), not a comma.'}
            </p>
            {createFieldErrors.amount && (
              <p
                id={`new-transaction-amount-error-${household.id}`}
                className="household-error"
                role="alert"
              >
                {createFieldErrors.amount}
              </p>
            )}
            <p role="status" className="finance-amount-preview">
              {createAmountPreview()}
            </p>
          </div>
          <div className="finance-create-grid">
            <div className="household-field">
              <label htmlFor={`new-transaction-date-${household.id}`}>
                Date
              </label>
              <input
                id={`new-transaction-date-${household.id}`}
                type="date"
                value={createDate}
                min={createMinDate}
                max={MAX_DATE}
                onChange={(event) => {
                  setCreateDate(event.target.value);
                  setCreateFieldErrors({});
                }}
                disabled={busy || pendingCreate !== null || !authorityConfirmed}
                aria-invalid={Boolean(createFieldErrors.date)}
                aria-describedby={
                  createFieldErrors.date
                    ? `new-transaction-date-error-${household.id}`
                    : undefined
                }
              />
              {createFieldErrors.date && (
                <p
                  id={`new-transaction-date-error-${household.id}`}
                  className="household-error"
                  role="alert"
                >
                  {createFieldErrors.date}
                </p>
              )}
              {createFutureWarning && (
                <p role="status" className="household-hint">
                  This date is in the future. It stays a recorded fact and
                  appears in reports only when a period covers its date.
                </p>
              )}
            </div>
            <div className="household-field">
              <label htmlFor={`new-transaction-description-${household.id}`}>
                Description
              </label>
              <input
                id={`new-transaction-description-${household.id}`}
                value={createDescription}
                onChange={(event) => {
                  setCreateDescription(event.target.value);
                  setCreateFieldErrors({});
                }}
                autoComplete="off"
                disabled={busy || pendingCreate !== null || !authorityConfirmed}
                aria-invalid={Boolean(createFieldErrors.description)}
                aria-describedby={
                  createFieldErrors.description
                    ? `new-transaction-description-error-${household.id}`
                    : undefined
                }
              />
              {createFieldErrors.description && (
                <p
                  id={`new-transaction-description-error-${household.id}`}
                  className="household-error"
                  role="alert"
                >
                  {createFieldErrors.description}
                </p>
              )}
            </div>
          </div>
          <p className="finance-helper">
            {refundSource
              ? 'The refund is recorded against this expense in its account and currency.'
              : 'Privacy stays private in this update. Account and entry type cannot be changed later; a wrong one is corrected by voiding and recording a new entry.'}
          </p>
          <div className="finance-account-actions">
            <button
              type="submit"
              className="household-button"
              disabled={busy || pendingCreate !== null || !authorityConfirmed}
            >
              {creating ? 'Recording…' : 'Record transaction'}
            </button>
            {refundSource && (
              <button
                type="button"
                className="household-button household-button--secondary"
                disabled={busy || pendingCreate !== null}
                onClick={cancelRefund}
              >
                Cancel refund
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );

  function createAmountPreview(): string {
    // The preview announces the encoded value; specific validation errors
    // stay in the field's alert paragraph and are never duplicated here.
    const notRecordable = 'The entered value is not recordable yet.';
    if (refundSource) {
      if (createAmount === '') return 'Records nothing yet.';
      const encoded = encodeMoneyMagnitude(
        createAmount,
        refundSource.money.currency,
        'positive',
      );
      return encoded.ok
        ? `Records ${formatMoney(encoded.amount, refundSource.money.currency)}.`
        : notRecordable;
    }
    const account = accounts?.find((value) => value.id === createAccountId);
    if (!account) return 'Choose an account to see the recorded value.';
    if (createAmount === '')
      return `Records nothing yet in ${account.currency}.`;
    const sign = signFor(createKind, createDirection);
    const encoded = encodeMoneyMagnitude(createAmount, account.currency, sign);
    return encoded.ok
      ? `Records ${formatMoney(encoded.amount, account.currency)}.`
      : notRecordable;
  }
}

interface EditFormProps {
  transaction: Transaction;
  currency: string;
  editAmount: string;
  editDirection: 'OUT' | 'IN';
  editDate: string;
  editDescription: string;
  editFieldErrors: FieldErrors;
  busy: boolean;
  authorityConfirmed: boolean;
  minDate: string;
  onAmountChange: (value: string) => void;
  onDirectionChange: (value: 'OUT' | 'IN') => void;
  onDateChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  editAmountRef: React.RefObject<HTMLInputElement | null>;
}

function EditForm({
  transaction,
  currency,
  editAmount,
  editDirection,
  editDate,
  editDescription,
  editFieldErrors,
  busy,
  authorityConfirmed,
  minDate,
  onAmountChange,
  onDirectionChange,
  onDateChange,
  onDescriptionChange,
  onSubmit,
  onCancel,
  editAmountRef,
}: EditFormProps) {
  return (
    <form
      className="finance-edit-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      noValidate
    >
      <p className="finance-helper">
        {transaction.kind === 'TRANSFER'
          ? 'A transfer keeps its entry type; its direction and amount can be corrected.'
          : `The entry type stays ${kindLabel(transaction.kind).toLowerCase()}; the sign follows it.`}
      </p>
      {transaction.kind === 'TRANSFER' && (
        <fieldset className="finance-direction-fieldset">
          <legend>Transfer direction</legend>
          <label className="finance-direction-option">
            <input
              type="radio"
              name={`edit-transfer-direction-${transaction.id}`}
              checked={editDirection === 'OUT'}
              onChange={() => onDirectionChange('OUT')}
              disabled={busy || !authorityConfirmed}
            />
            <span>Money out (−)</span>
          </label>
          <label className="finance-direction-option">
            <input
              type="radio"
              name={`edit-transfer-direction-${transaction.id}`}
              checked={editDirection === 'IN'}
              onChange={() => onDirectionChange('IN')}
              disabled={busy || !authorityConfirmed}
            />
            <span>Money in (+)</span>
          </label>
        </fieldset>
      )}
      <div className="household-field">
        <label htmlFor={`edit-transaction-amount-${transaction.id}`}>
          Amount
        </label>
        <input
          ref={editAmountRef}
          id={`edit-transaction-amount-${transaction.id}`}
          value={editAmount}
          onChange={(event) => onAmountChange(event.target.value)}
          inputMode="decimal"
          autoComplete="off"
          disabled={busy || !authorityConfirmed}
          aria-invalid={Boolean(editFieldErrors.amount)}
          aria-describedby={
            editFieldErrors.amount
              ? `edit-transaction-amount-hint-${transaction.id} edit-transaction-amount-error-${transaction.id}`
              : `edit-transaction-amount-hint-${transaction.id}`
          }
        />
        <p
          id={`edit-transaction-amount-hint-${transaction.id}`}
          className="household-hint"
        >
          {currency} · positive size only; the sign follows the entry.
        </p>
        {editFieldErrors.amount && (
          <p
            id={`edit-transaction-amount-error-${transaction.id}`}
            className="household-error"
            role="alert"
          >
            {editFieldErrors.amount}
          </p>
        )}
      </div>
      <div className="finance-create-grid">
        <div className="household-field">
          <label htmlFor={`edit-transaction-date-${transaction.id}`}>
            Date
          </label>
          <input
            id={`edit-transaction-date-${transaction.id}`}
            type="date"
            value={editDate}
            min={minDate}
            max={MAX_DATE}
            onChange={(event) => onDateChange(event.target.value)}
            disabled={busy || !authorityConfirmed}
            aria-invalid={Boolean(editFieldErrors.date)}
            aria-describedby={
              editFieldErrors.date
                ? `edit-transaction-date-error-${transaction.id}`
                : undefined
            }
          />
          {editFieldErrors.date && (
            <p
              id={`edit-transaction-date-error-${transaction.id}`}
              className="household-error"
              role="alert"
            >
              {editFieldErrors.date}
            </p>
          )}
          {isFutureDate(editDate) && (
            <p role="status" className="household-hint">
              This date is in the future. It stays a recorded fact and appears
              in reports only when a period covers its date.
            </p>
          )}
        </div>
        <div className="household-field">
          <label htmlFor={`edit-transaction-description-${transaction.id}`}>
            Description
          </label>
          <input
            id={`edit-transaction-description-${transaction.id}`}
            value={editDescription}
            onChange={(event) => onDescriptionChange(event.target.value)}
            autoComplete="off"
            disabled={busy || !authorityConfirmed}
            aria-invalid={Boolean(editFieldErrors.description)}
            aria-describedby={
              editFieldErrors.description
                ? `edit-transaction-description-error-${transaction.id}`
                : undefined
            }
          />
          {editFieldErrors.description && (
            <p
              id={`edit-transaction-description-error-${transaction.id}`}
              className="household-error"
              role="alert"
            >
              {editFieldErrors.description}
            </p>
          )}
        </div>
      </div>
      <div className="finance-account-actions">
        <button
          type="submit"
          className="household-button"
          disabled={busy || !authorityConfirmed}
        >
          Save correction
        </button>
        <button
          type="button"
          className="household-button household-button--secondary"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
