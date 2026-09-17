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
  patchFinancialAccount,
  postFinancialAccount,
  type CreateFinancialAccountInput,
  type CsrfToken,
  type FinancialAccount,
  type FinancialAccountCurrency,
  type FinancialAccountKind,
  type Household,
} from '../auth/client';

interface Notice {
  kind: 'info' | 'error' | 'warning';
  text: string;
  correlationId?: string | undefined;
  showRefresh?: boolean | undefined;
}

interface PendingCreate {
  key: string;
  input: CreateFinancialAccountInput;
}

interface PendingStatus {
  account: FinancialAccount;
  nextStatus: 'ACTIVE' | 'ARCHIVED';
}

interface FinancialAccountsSectionProps {
  household: Household;
  csrf: CsrfToken | null;
  onCsrfRefreshed: (token: CsrfToken) => void;
  onSessionExpired: () => void;
  onHouseholdAccessChanged: () => void;
  authorityConfirmed: boolean;
  /**
   * Called once per definitively committed account-list mutation (a
   * successful create, rename, archive, or reactivation) so a sibling
   * section can refresh its account metadata. Unknown-outcome timeouts
   * never call this: only a confirmed list change does.
   */
  onAccountListCommitted?: (() => void) | undefined;
}

const KIND_OPTIONS: Array<{ value: FinancialAccountKind; label: string }> = [
  { value: 'CASH', label: 'Cash' },
  { value: 'CHECKING', label: 'Checking' },
  { value: 'SAVINGS', label: 'Savings' },
  { value: 'CREDIT_CARD', label: 'Credit card' },
];

const CURRENCY_OPTIONS: FinancialAccountCurrency[] = [
  'BRL',
  'USD',
  'EUR',
  'GBP',
  'JPY',
  'KWD',
];

function validateName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return 'Enter an account name.';
  if ([...trimmed].length > 100) {
    return 'Account name must be at most 100 characters.';
  }
  if (/\p{Cc}/u.test(trimmed)) {
    return 'Account name must not contain control characters.';
  }
  return undefined;
}

function sortAccounts(accounts: FinancialAccount[]): FinancialAccount[] {
  return [...accounts].sort((left, right) => {
    // Numeric instants first: lexicographic ISO-8601 comparison mis-sorts
    // valid same-second forms (`...00Z` versus `...00.9Z`).
    const leftTime = Date.parse(left.createdAt);
    const rightTime = Date.parse(right.createdAt);
    if (
      !Number.isNaN(leftTime) &&
      !Number.isNaN(rightTime) &&
      leftTime !== rightTime
    ) {
      return leftTime - rightTime;
    }
    // Bytewise UUID tie-break mirrors the server's `createdAt ASC, id ASC`
    // ordering; locale-sensitive comparison must not reorder identifiers.
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

function kindLabel(kind: FinancialAccountKind): string {
  return KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
}

function statusConfirmationText(
  account: FinancialAccount,
  nextStatus: PendingStatus['nextStatus'],
): string {
  return nextStatus === 'ARCHIVED'
    ? `Archive “${account.name}”? New activity will be refused, and the account keeps its recorded history.`
    : `Make “${account.name}” active again? Its recorded history stays untouched.`;
}

export function FinancialAccountsSection({
  household,
  csrf,
  onCsrfRefreshed,
  onSessionExpired,
  onHouseholdAccessChanged,
  authorityConfirmed,
  onAccountListCommitted,
}: FinancialAccountsSectionProps) {
  const [accounts, setAccounts] = useState<FinancialAccount[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<FinancialAccountKind>('CHECKING');
  const [currency, setCurrency] = useState<FinancialAccountCurrency>('BRL');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(
    null,
  );
  const [pendingStatus, setPendingStatus] = useState<PendingStatus | null>(
    null,
  );
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editError, setEditError] = useState<string | undefined>();

  const csrfRef = useRef(csrf);
  const generationRef = useRef(0);
  const unmountedRef = useRef(false);
  const controllersRef = useRef<Set<AbortController>>(new Set());
  // Synchronous sources of truth for in-flight writes: state updates are
  // async, so guards that run right after a flag change read these refs.
  const creatingRef = useRef(false);
  const updatingRef = useRef<string | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const editNameRef = useRef<HTMLInputElement>(null);
  const statusConfirmRef = useRef<HTMLDivElement>(null);
  const statusTriggerRef = useRef<HTMLButtonElement | null>(null);

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

  async function load(generation: number, controller: AbortController) {
    setLoading(true);
    setNotice(null);
    try {
      const page = await fetchFinancialAccounts(
        household.id,
        controller.signal,
      );
      if (!current(generation) || controller.signal.aborted) return;
      setAccounts(sortAccounts(page.items));
      setHasMore(page.hasMore);
      setLoading(false);
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not load your financial accounts.',
            });
      setLoading(false);
      if (apiError.status === 401) {
        setAccounts(null);
        onSessionExpired();
        return;
      }
      if (apiError.code === 'HOUSEHOLD_NOT_FOUND') {
        setAccounts(null);
        onHouseholdAccessChanged();
        return;
      }
      setNotice({
        kind: 'error',
        text: apiError.timedOut
          ? 'Loading financial accounts timed out. Refresh to try again.'
          : apiError.message || 'Could not load your financial accounts.',
        correlationId: apiError.correlationId,
        showRefresh: true,
      });
    }
  }

  function refresh() {
    if (loading || creatingRef.current || updatingRef.current !== null) return;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    track(controller);
    void load(generation, controller).finally(() => untrack(controller));
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
    if (pendingStatus) statusConfirmRef.current?.focus();
  }, [pendingStatus]);

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
      const created = await postFinancialAccount(
        household.id,
        request.input,
        request.key,
        token,
        controller.signal,
      );
      if (!current(generation) || controller.signal.aborted) return;
      setAccounts((currentAccounts) =>
        sortAccounts([
          ...(currentAccounts ?? []).filter(
            (account) => account.id !== created.id,
          ),
          created,
        ]),
      );
      setPendingCreate(null);
      setName('');
      setFieldError(undefined);
      setNotice({
        kind: 'info',
        text: `Private account “${created.name}” is ready.`,
      });
      // The list change committed: let the sibling transaction selector
      // refetch account metadata. Unknown-outcome branches above return
      // earlier and never reach this signal.
      onAccountListCommitted?.();
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
      if (apiError.status === 401) {
        setAccounts(null);
        setPendingCreate(null);
        onSessionExpired();
        return;
      }
      if (apiError.code === 'HOUSEHOLD_NOT_FOUND') {
        setAccounts(null);
        setPendingCreate(null);
        onHouseholdAccessChanged();
        return;
      }
      if (apiError.code === 'CSRF_INVALID') {
        const refreshed = await refreshCsrf(generation, controller.signal);
        if (!current(generation) || controller.signal.aborted) return;
        setNotice({
          kind: 'error',
          text: refreshed
            ? 'Your security token was refreshed. Retry the same account request.'
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
        // The exact request and key stay retained in the durable block below;
        // this transient notice deliberately carries no actions so a later
        // notice can never strand the retained retry.
        setNotice({
          kind: 'warning',
          text: 'Account creation has an unknown outcome. Retry the same request safely, or refresh the list before retrying.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      if (apiError.fieldErrors?.name) {
        setFieldError(apiError.fieldErrors.name);
        setPendingCreate(null);
        setNotice({
          kind: 'error',
          text: 'Check the highlighted account details.',
          correlationId: apiError.correlationId,
        });
        requestAnimationFrame(() => nameRef.current?.focus());
        return;
      }
      setPendingCreate(null);
      setNotice({
        kind: 'error',
        text: apiError.message || 'Account creation could not be completed.',
        correlationId: apiError.correlationId,
      });
    } finally {
      untrack(controller);
      creatingRef.current = false;
      if (current(generation)) setCreating(false);
    }
  }

  function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (creatingRef.current || pendingCreate || !authorityConfirmed) return;
    const error = validateName(name);
    if (error) {
      setFieldError(error);
      setNotice({ kind: 'error', text: 'Check the highlighted field.' });
      requestAnimationFrame(() => nameRef.current?.focus());
      return;
    }
    const request: PendingCreate = {
      key: crypto.randomUUID(),
      input: { name: name.trim(), kind, currency },
    };
    setPendingCreate(request);
    void submitCreate(request);
  }

  async function updateAccount(
    account: FinancialAccount,
    patch: { name?: string; status?: 'ACTIVE' | 'ARCHIVED' },
  ) {
    if (updatingRef.current !== null || !authorityConfirmed) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    track(controller);
    updatingRef.current = account.id;
    setUpdatingId(account.id);
    setNotice(null);
    try {
      const token = await ensureCsrf(generation, controller.signal);
      if (!current(generation) || controller.signal.aborted) return;
      if (!token) {
        setNotice({ kind: 'error', text: 'Security setup failed. Retry.' });
        return;
      }
      const updated = await patchFinancialAccount(
        household.id,
        account.id,
        { expectedVersion: account.version, ...patch },
        token,
        controller.signal,
      );
      if (!current(generation) || controller.signal.aborted) return;
      setAccounts((currentAccounts) =>
        sortAccounts(
          (currentAccounts ?? []).map((value) =>
            value.id === updated.id ? updated : value,
          ),
        ),
      );
      setEditingId(null);
      setEditName('');
      setEditError(undefined);
      setNotice({
        kind: 'info',
        text:
          patch.name !== undefined
            ? `Account renamed to “${updated.name}”.`
            : updated.status === 'ARCHIVED'
              ? `“${updated.name}” archived. Its history is preserved.`
              : `“${updated.name}” is active again.`,
      });
      // The committed rename or status change moves selector membership or
      // labels: refresh the sibling's metadata. Stale and unknown-outcome
      // branches above return earlier and never signal.
      onAccountListCommitted?.();
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
      if (apiError.status === 401) {
        setAccounts(null);
        onSessionExpired();
        return;
      }
      if (apiError.code === 'HOUSEHOLD_NOT_FOUND') {
        setAccounts(null);
        onHouseholdAccessChanged();
        return;
      }
      if (apiError.code === 'CSRF_INVALID') {
        const refreshed = await refreshCsrf(generation, controller.signal);
        if (!current(generation) || controller.signal.aborted) return;
        setNotice({
          kind: 'error',
          text: refreshed
            ? 'Your security token was refreshed. Review the account and retry.'
            : 'Your secure request expired. Reload before retrying.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      if (apiError.code === 'FINANCIAL_ACCOUNT_NOT_FOUND') {
        // The account row is stale in this list: drop it locally and offer a
        // refresh, never a claimed success or failure.
        setAccounts((currentAccounts) =>
          (currentAccounts ?? []).filter((value) => value.id !== account.id),
        );
        if (editingId === account.id) {
          setEditingId(null);
          setEditName('');
          setEditError(undefined);
        }
        setNotice({
          kind: 'warning',
          text: 'This account is no longer available to you. Refresh accounts to see the current list.',
          correlationId: apiError.correlationId,
          showRefresh: true,
        });
        return;
      }
      if (patch.name !== undefined && apiError.fieldErrors?.name) {
        // Pure rename validation: map the server field error onto the open
        // rename form, keep the safe input, and offer no refresh action.
        setEditError(apiError.fieldErrors.name);
        requestAnimationFrame(() => editNameRef.current?.focus());
        return;
      }
      setNotice({
        kind: apiError.timedOut ? 'warning' : 'error',
        text:
          apiError.timedOut ||
          apiError.code === 'RESOURCE_VERSION_CONFLICT' ||
          apiError.code === 'FINANCE_BUSY' ||
          apiError.code === 'NETWORK_ERROR'
            ? 'The account may have changed. Refresh accounts before retrying.'
            : apiError.message || 'The account could not be updated.',
        correlationId: apiError.correlationId,
        showRefresh: true,
      });
    } finally {
      untrack(controller);
      updatingRef.current = null;
      if (current(generation)) setUpdatingId(null);
    }
  }

  function submitRename(event: FormEvent, account: FinancialAccount) {
    event.preventDefault();
    const error = validateName(editName);
    if (error) {
      setEditError(error);
      return;
    }
    void updateAccount(account, { name: editName.trim() });
  }

  function openStatusConfirm(
    account: FinancialAccount,
    trigger: HTMLButtonElement,
  ) {
    // One confirmation at a time: a second trigger must not replace the
    // open panel or steal its focus origin.
    if (
      pendingStatus !== null ||
      updatingRef.current !== null ||
      creatingRef.current ||
      loading ||
      !authorityConfirmed
    ) {
      return;
    }
    statusTriggerRef.current = trigger;
    setPendingStatus({
      account,
      nextStatus: account.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE',
    });
  }

  function cancelStatusConfirm() {
    setPendingStatus(null);
    const trigger = statusTriggerRef.current;
    statusTriggerRef.current = null;
    trigger?.focus();
  }

  function handleStatusConfirmKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelStatusConfirm();
    }
  }

  function confirmStatusChange() {
    const pending = pendingStatus;
    if (!pending || updatingRef.current !== null) return;
    setPendingStatus(null);
    statusTriggerRef.current = null;
    void updateAccount(pending.account, { status: pending.nextStatus });
  }

  const busy = loading || creating || updatingId !== null;

  return (
    <section
      className="finance-accounts"
      aria-labelledby={`finance-accounts-${household.id}`}
    >
      <div className="finance-accounts-heading">
        <div>
          <p className="eyebrow">Private to you</p>
          <h4 id={`finance-accounts-${household.id}`}>Financial accounts</h4>
        </div>
        <span className="privacy-chip">Account details private</span>
      </div>
      <p className="finance-helper">
        Other household members, including owners, cannot see these account
        names or details. No bank balance is inferred.
      </p>

      {!authorityConfirmed && (
        <p role="status" className="household-stale">
          Refresh the household before changing financial accounts.
        </p>
      )}

      {loading && accounts === null && (
        <p role="status" aria-live="polite">
          Loading your financial accounts…
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
              Refresh accounts
            </button>
          )}
        </div>
      )}

      {accounts !== null && pendingCreate !== null && (
        // Durable same-key retry affordance: it lives outside the transient
        // notice so a refresh or any later notice can never strand the
        // retained request. A refresh deliberately does not clear it — the
        // list cannot prove which unknown request committed, because
        // duplicate names are valid — so the exact request stays reconcilable
        // until a same-key retry returns a known outcome.
        <div className="finance-pending-request">
          <p>
            An earlier account creation still has an unknown result. Retry the
            exact same request with its original key, or refresh the list first.
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
              Refresh accounts
            </button>
          </div>
        </div>
      )}

      {accounts !== null && accounts.length === 0 && !loading && (
        <p className="finance-empty">No manual accounts yet.</p>
      )}

      {accounts !== null && accounts.length > 0 && (
        <ul className="finance-account-list" aria-label="Your private accounts">
          {accounts.map((account) => (
            <li
              key={account.id}
              className={`finance-account-card${
                account.status === 'ARCHIVED'
                  ? ' finance-account-card--archived'
                  : ''
              }`}
            >
              <div className="finance-account-summary">
                <div>
                  <p className="finance-account-name">{account.name}</p>
                  <p className="household-meta">
                    {kindLabel(account.kind)} · {account.currency} ·{' '}
                    {account.status === 'ACTIVE' ? 'Active' : 'Archived'}
                  </p>
                </div>
                <span className="privacy-chip">Private</span>
              </div>

              {editingId === account.id ? (
                <form
                  className="finance-rename-form"
                  onSubmit={(event) => submitRename(event, account)}
                  noValidate
                >
                  <label htmlFor={`finance-name-${account.id}`}>
                    Account name
                  </label>
                  <input
                    ref={editNameRef}
                    id={`finance-name-${account.id}`}
                    value={editName}
                    onChange={(event) => setEditName(event.target.value)}
                    disabled={busy || !authorityConfirmed}
                    aria-invalid={Boolean(editError)}
                    aria-describedby={
                      editError ? `finance-name-error-${account.id}` : undefined
                    }
                  />
                  {editError && (
                    <p
                      id={`finance-name-error-${account.id}`}
                      className="household-error"
                      role="alert"
                    >
                      {editError}
                    </p>
                  )}
                  <div className="finance-account-actions">
                    <button
                      type="submit"
                      className="household-button"
                      disabled={busy || !authorityConfirmed}
                    >
                      Save name
                    </button>
                    <button
                      type="button"
                      className="household-button household-button--secondary"
                      disabled={busy}
                      onClick={() => {
                        setEditingId(null);
                        setEditError(undefined);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <div className="finance-account-actions">
                  <button
                    type="button"
                    className="household-button household-button--secondary"
                    disabled={busy || !authorityConfirmed}
                    aria-label={`Rename ${account.name}`}
                    onClick={() => {
                      setEditingId(account.id);
                      setEditName(account.name);
                      setEditError(undefined);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="household-button household-button--secondary"
                    disabled={busy || !authorityConfirmed}
                    aria-label={
                      account.status === 'ACTIVE'
                        ? `Archive ${account.name}`
                        : `Make ${account.name} active`
                    }
                    onClick={(event) =>
                      openStatusConfirm(account, event.currentTarget)
                    }
                  >
                    {account.status === 'ACTIVE' ? 'Archive' : 'Make active'}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {hasMore && (
        <p role="status" className="finance-helper">
          Showing the first 100 accounts. Additional paging will arrive with
          larger-account support.
        </p>
      )}

      {pendingStatus && (
        <div
          ref={statusConfirmRef}
          tabIndex={-1}
          role="group"
          aria-label={`Confirm status change for ${pendingStatus.account.name}`}
          className="household-notice household-notice--warning finance-status-confirm"
          onKeyDown={handleStatusConfirmKeyDown}
        >
          <p>
            {statusConfirmationText(
              pendingStatus.account,
              pendingStatus.nextStatus,
            )}
          </p>
          <div className="finance-account-actions">
            <button
              type="button"
              className="household-button"
              disabled={busy}
              onClick={confirmStatusChange}
            >
              {pendingStatus.nextStatus === 'ARCHIVED'
                ? 'Archive account'
                : 'Make active'}
            </button>
            <button
              type="button"
              className="household-button household-button--secondary"
              disabled={busy}
              onClick={cancelStatusConfirm}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {accounts !== null && (
        <form
          className="finance-create-form"
          onSubmit={handleCreate}
          noValidate
        >
          <h5>Add a manual account</h5>
          <div className="household-field">
            <label htmlFor={`new-finance-name-${household.id}`}>
              Account name
            </label>
            <input
              ref={nameRef}
              id={`new-finance-name-${household.id}`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              disabled={busy || pendingCreate !== null || !authorityConfirmed}
              aria-invalid={Boolean(fieldError)}
              aria-describedby={
                fieldError
                  ? `new-finance-name-error-${household.id}`
                  : `new-finance-name-hint-${household.id}`
              }
            />
            <p
              id={`new-finance-name-hint-${household.id}`}
              className="household-hint"
            >
              A private label, 1–100 characters.
            </p>
            {fieldError && (
              <p
                id={`new-finance-name-error-${household.id}`}
                className="household-error"
                role="alert"
              >
                {fieldError}
              </p>
            )}
          </div>
          <div className="finance-create-grid">
            <div className="household-field">
              <label htmlFor={`new-finance-kind-${household.id}`}>
                Account type
              </label>
              <select
                id={`new-finance-kind-${household.id}`}
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value as FinancialAccountKind)
                }
                disabled={busy || pendingCreate !== null || !authorityConfirmed}
              >
                {KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="household-field">
              <label htmlFor={`new-finance-currency-${household.id}`}>
                Currency
              </label>
              <select
                id={`new-finance-currency-${household.id}`}
                value={currency}
                onChange={(event) =>
                  setCurrency(event.target.value as FinancialAccountCurrency)
                }
                disabled={busy || pendingCreate !== null || !authorityConfirmed}
              >
                {CURRENCY_OPTIONS.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="finance-helper">
            Type and currency cannot be changed later. This account starts
            private and contains no inferred balance.
          </p>
          <button
            type="submit"
            className="household-button"
            disabled={busy || pendingCreate !== null || !authorityConfirmed}
          >
            {creating ? 'Adding account…' : 'Add private account'}
          </button>
        </form>
      )}
    </section>
  );
}
