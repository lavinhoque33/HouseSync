import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  fetchCsrf,
  fetchFinanceSettings,
  patchFinanceSettings,
  type CsrfToken,
  type FinanceSettings,
  type Household,
} from '../auth/client';
import {
  resolveCalculationZone,
  validateReportingZoneInput,
} from './reporting';

interface SettingsNotice {
  kind: 'info' | 'error' | 'warning';
  text: string;
  correlationId?: string | undefined;
  showReload?: boolean | undefined;
}

interface ReportingSettingsSectionProps {
  household: Household;
  csrf: CsrfToken | null;
  onCsrfRefreshed: (token: CsrfToken) => void;
  onSessionExpired: () => void;
  onHouseholdAccessChanged: () => void;
  /**
   * Reports the authoritative zone after every successful settings load so
   * the parent can derive zone-based defaults (dashboard month, entry-date
   * warnings) without a second fetch. Called with the loaded value only;
   * an unchanged value is a React no-op for the parent.
   */
  onZoneLoaded: (zone: string) => void;
  /** False while the household list is stale; editing stays unavailable. */
  authorityConfirmed: boolean;
}

export function ReportingSettingsSection({
  household,
  csrf,
  onCsrfRefreshed,
  onSessionExpired,
  onHouseholdAccessChanged,
  onZoneLoaded,
  authorityConfirmed,
}: ReportingSettingsSectionProps) {
  const [settings, setSettings] = useState<FinanceSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<SettingsNotice | null>(null);
  /**
   * The editor draft. Null means untouched, so the input shows the last
   * loaded authoritative zone; any string (even empty) is the user's own
   * input and is preserved across every recoverable failure.
   */
  const [draft, setDraft] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  /**
   * Unknown-outcome gate: a timed-out, busy, or unreachable PATCH may still
   * have applied server-side, so saving is blocked until a fresh load
   * reconciles the version. The draft is preserved throughout.
   */
  const [needsReload, setNeedsReload] = useState(false);

  const csrfRef = useRef(csrf);
  const genRef = useRef(0);
  const unmountedRef = useRef(false);
  const ownedRef = useRef<Set<AbortController>>(new Set());
  const noticeRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const onZoneLoadedRef = useRef(onZoneLoaded);

  useEffect(() => {
    csrfRef.current = csrf;
  }, [csrf]);

  useEffect(() => {
    onZoneLoadedRef.current = onZoneLoaded;
  }, [onZoneLoaded]);

  function track(controller: AbortController) {
    ownedRef.current.add(controller);
  }

  function untrack(controller: AbortController) {
    ownedRef.current.delete(controller);
  }

  function isCurrent(generation: number): boolean {
    return !unmountedRef.current && genRef.current === generation;
  }

  function clearScopedState() {
    genRef.current += 1;
    setSettings(null);
    setLoaded(false);
    setDraft(null);
    setFieldError(undefined);
    setNeedsReload(false);
  }

  /**
   * Record freshly loaded settings: display the stored zone as
   * authoritative and report the stored value upward for zone-derived
   * defaults. The fallback warning below derives from the same stored value
   * at render time.
   */
  function adoptSettings(result: FinanceSettings) {
    setSettings(result);
    setLoaded(true);
    setNeedsReload(false);
    if (result.reportingTimeZone.length > 0) {
      onZoneLoadedRef.current(result.reportingTimeZone);
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

  async function load(signal: AbortSignal, generation: number) {
    setLoading(true);
    setNotice(null);
    try {
      const result = await fetchFinanceSettings(household.id, signal);
      if (!isCurrent(generation) || signal.aborted) return;
      adoptSettings(result);
      setNotice(null);
      setLoading(false);
    } catch (error) {
      if (!isCurrent(generation) || signal.aborted) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not load household reporting settings.',
            });
      setLoading(false);
      if (apiError.status === 401) {
        handleSessionLost();
        return;
      }
      if (apiError.code === 'HOUSEHOLD_NOT_FOUND') {
        handleAccessLost();
        return;
      }
      // A failed refresh keeps the last good zone visible with an explicit
      // stale warning; only a first load renders the error alone.
      const keepStale = loaded && settings !== null;
      setNotice({
        kind: keepStale ? 'warning' : 'error',
        text: keepStale
          ? 'Could not refresh reporting settings. The zone shown may be stale. Reload to try again.'
          : apiError.timedOut
            ? 'Loading reporting settings timed out. Reload to try again.'
            : apiError.message ||
              'Could not load household reporting settings.',
        correlationId: apiError.correlationId,
        showReload: true,
      });
    }
  }

  function startLoad(): void {
    const generation = ++genRef.current;
    const controller = new AbortController();
    track(controller);
    void (async () => {
      try {
        await load(controller.signal, generation);
      } finally {
        untrack(controller);
      }
    })();
  }

  useEffect(() => {
    unmountedRef.current = false;
    startLoad();
    const owned = ownedRef.current;
    return () => {
      unmountedRef.current = true;
      for (const tracked of owned) tracked.abort();
    };
    // Household identity is fixed for this keyed component instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (notice && noticeRef.current) noticeRef.current.focus();
  }, [notice]);

  async function ensureCsrf(
    generation: number,
    signal: AbortSignal,
  ): Promise<CsrfToken | null> {
    if (csrfRef.current) return csrfRef.current;
    try {
      const fresh = await fetchCsrf(signal);
      if (!isCurrent(generation) || signal.aborted) return null;
      csrfRef.current = fresh;
      onCsrfRefreshed(fresh);
      return fresh;
    } catch {
      return null;
    }
  }

  async function refreshCsrf(
    generation: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      const fresh = await fetchCsrf(signal);
      if (!isCurrent(generation) || signal.aborted) return false;
      csrfRef.current = fresh;
      onCsrfRefreshed(fresh);
      return true;
    } catch {
      return false;
    }
  }

  /** Reload the authoritative settings after a stale or unknown outcome. */
  async function reloadAfterConflict(
    generation: number,
    controller: AbortController,
  ): Promise<boolean> {
    try {
      const result = await fetchFinanceSettings(
        household.id,
        controller.signal,
      );
      if (!isCurrent(generation) || controller.signal.aborted) return false;
      adoptSettings(result);
      return true;
    } catch (error) {
      if (!isCurrent(generation) || controller.signal.aborted) return false;
      if (error instanceof ApiError) {
        if (error.status === 401) {
          handleSessionLost();
          return false;
        }
        if (error.code === 'HOUSEHOLD_NOT_FOUND') {
          handleAccessLost();
          return false;
        }
      }
      return false;
    }
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (saving || loading) return;
    const generation = genRef.current;
    if (settings === null) return;
    if (needsReload) {
      // The previous change has an unknown outcome: never resend blindly.
      setNotice({
        kind: 'warning',
        text: 'The previous change may or may not have applied. Reload the current settings before retrying — nothing was resent.',
        showReload: true,
      });
      return;
    }
    const validated = validateReportingZoneInput(
      draft ?? settings.reportingTimeZone,
    );
    if (!validated.ok) {
      setFieldError(validated.error);
      setNotice({ kind: 'error', text: 'Check the highlighted field.' });
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    const controller = new AbortController();
    track(controller);
    setSaving(true);
    setFieldError(undefined);
    setNotice(null);
    try {
      const requestCsrf = await ensureCsrf(generation, controller.signal);
      if (!isCurrent(generation) || controller.signal.aborted) return;
      if (requestCsrf === null) {
        setNotice({
          kind: 'error',
          text: 'Security setup is still loading. Wait a moment and retry.',
        });
        return;
      }
      const updated = await patchFinanceSettings(
        household.id,
        {
          reportingTimeZone: validated.zone,
          expectedVersion: settings.version,
        },
        requestCsrf,
        controller.signal,
      );
      if (!isCurrent(generation) || controller.signal.aborted) return;
      setSettings(updated);
      setDraft(null);
      setNeedsReload(false);
      setNotice({
        kind: 'info',
        text: `Reporting time zone updated to ${updated.reportingTimeZone}. New monthly summaries default to that zone; already requested periods are unchanged.`,
      });
      if (updated.reportingTimeZone.length > 0) {
        onZoneLoadedRef.current(updated.reportingTimeZone);
      }
    } catch (error) {
      if (!isCurrent(generation) || controller.signal.aborted) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not reach the server.',
            });
      if (apiError.status === 401) {
        handleSessionLost();
        return;
      }
      if (apiError.code === 'HOUSEHOLD_NOT_FOUND') {
        handleAccessLost();
        return;
      }
      if (apiError.code === 'FORBIDDEN') {
        // The role changed mid-session or the control was reached without
        // ownership: keep the draft and explain, never claim success.
        setNotice({
          kind: 'error',
          text: 'Only household owners can change the reporting time zone.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      if (apiError.code === 'CSRF_INVALID') {
        const refreshed = await refreshCsrf(generation, controller.signal);
        if (!isCurrent(generation) || controller.signal.aborted) return;
        setNotice({
          kind: 'error',
          text: refreshed
            ? 'Your security token was refreshed. Review the time zone and try saving again.'
            : 'Your secure request expired. Reload before retrying.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      if (
        apiError.code === 'RESOURCE_VERSION_CONFLICT' ||
        apiError.code === 'RESOURCE_VERSION_EXHAUSTED'
      ) {
        // Someone else changed the settings: reload the current version
        // first, keep the typed draft, and require an explicit retry.
        const reloaded = await reloadAfterConflict(generation, controller);
        if (!isCurrent(generation) || controller.signal.aborted) return;
        setNotice({
          kind: reloaded ? 'warning' : 'error',
          text: reloaded
            ? 'The settings changed elsewhere, so the current values were reloaded. Review your entry and try saving again.'
            : 'The settings changed elsewhere and the reload failed. Reload the settings before retrying.',
          correlationId: apiError.correlationId,
          showReload: !reloaded,
        });
        return;
      }
      if (
        apiError.timedOut ||
        apiError.code === 'FINANCE_BUSY' ||
        apiError.code === 'NETWORK_ERROR'
      ) {
        // Unknown outcome: gate saving on a fresh load rather than
        // resending a change that may already have applied.
        setNeedsReload(true);
        setNotice({
          kind: 'warning',
          text: 'The change timed out or could not be confirmed, so its outcome is unknown — nothing was resent. Reload the current settings to check before retrying.',
          correlationId: apiError.correlationId,
          showReload: true,
        });
        return;
      }
      if (apiError.fieldErrors?.reportingTimeZone) {
        setFieldError(apiError.fieldErrors.reportingTimeZone);
        setNotice({
          kind: 'error',
          text: 'Check the highlighted field.',
          correlationId: apiError.correlationId,
        });
        requestAnimationFrame(() => inputRef.current?.focus());
        return;
      }
      setNotice({
        kind: 'error',
        text:
          apiError.message ||
          'The reporting zone change could not be completed.',
        correlationId: apiError.correlationId,
      });
    } finally {
      untrack(controller);
      if (isCurrent(generation)) setSaving(false);
    }
  }

  const isOwner = household.role === 'OWNER';
  const ready = loaded && settings !== null;
  // Explicit, render-derived fallback: when the stored zone is
  // contract-valid but unsupported by this browser, local date defaults use
  // Etc/UTC with this visible warning instead of throwing. The displayed
  // stored zone stays authoritative.
  const zoneResolution =
    settings === null
      ? null
      : resolveCalculationZone(settings.reportingTimeZone);
  // The editor opens prefilled with the authoritative zone; typing starts
  // from the last loaded value, never an invented default.
  const showEditor = isOwner && ready;
  const saveDisabled =
    saving ||
    loading ||
    needsReload ||
    !authorityConfirmed ||
    settings === null;

  return (
    <div
      className="reporting-settings"
      data-testid="reporting-settings-section"
      role="region"
      aria-labelledby={`reporting-settings-title-${household.id}`}
    >
      <h4
        className="members-title"
        id={`reporting-settings-title-${household.id}`}
      >
        Reporting settings
      </h4>
      <p className="finance-helper">
        The household reporting time zone defines “today” and the default
        monthly summary period. Saved dates are never reinterpreted when the
        zone changes.
      </p>

      {loading && !loaded && !notice && (
        <p role="status" aria-live="polite">
          Loading reporting settings…
        </p>
      )}
      {loading && loaded && (
        <p role="status" className="members-status">
          Refreshing reporting settings…
        </p>
      )}

      {ready && (
        <p className="reporting-zone-line">
          Reporting time zone:{' '}
          <span className="reporting-zone-value">
            {settings.reportingTimeZone}
          </span>
        </p>
      )}
      {ready && zoneResolution?.fellBack === true && (
        <p role="status" className="household-stale">
          {`The stored reporting zone “${settings.reportingTimeZone}” is not supported by this browser for local date defaults, so monthly defaults use Etc/UTC. The stored zone shown here stays authoritative.`}
        </p>
      )}

      {notice && (
        <div
          ref={noticeRef}
          tabIndex={-1}
          role={notice.kind === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          className={`household-notice household-notice--${notice.kind}`}
        >
          <p>{notice.text}</p>
          {notice.correlationId && (
            <p className="household-notice-detail">
              Reference: {notice.correlationId}
            </p>
          )}
          {notice.showReload && (
            <button
              type="button"
              className="household-button household-button--secondary"
              onClick={startLoad}
              disabled={loading || saving}
            >
              Reload settings
            </button>
          )}
        </div>
      )}

      {ready && !isOwner && (
        <p role="status" className="finance-helper">
          Only household owners can change the reporting time zone.
        </p>
      )}

      {showEditor && (
        <form
          className="reporting-form"
          onSubmit={(event) => void handleSave(event)}
          noValidate
        >
          <div className="household-field">
            <label htmlFor={`reporting-zone-${household.id}`}>
              Reporting time zone
            </label>
            <input
              id={`reporting-zone-${household.id}`}
              ref={inputRef}
              name="reporting-zone"
              type="text"
              autoComplete="off"
              spellCheck={false}
              required
              value={draft ?? settings.reportingTimeZone}
              onChange={(event) => setDraft(event.target.value)}
              aria-invalid={Boolean(fieldError)}
              aria-describedby={
                fieldError
                  ? `reporting-zone-error-${household.id}`
                  : `reporting-zone-hint-${household.id}`
              }
              disabled={saving || loading}
            />
            <p
              id={`reporting-zone-hint-${household.id}`}
              className="household-hint"
            >
              An IANA region name such as Etc/UTC or America/Sao_Paulo. Short
              names like EST and offsets like +03:00 are not accepted.
            </p>
            {fieldError && (
              <p
                id={`reporting-zone-error-${household.id}`}
                role="alert"
                className="household-error"
              >
                {fieldError}
              </p>
            )}
          </div>
          {!authorityConfirmed && (
            <p role="status" className="household-stale">
              The household list may be out of date. Refresh it before changing
              the reporting zone.
            </p>
          )}
          {needsReload && (
            <p role="status" className="household-stale">
              Saving is paused until the current settings are reloaded, because
              the last change has an unknown outcome.
            </p>
          )}
          <button
            type="submit"
            className="household-button"
            disabled={saveDisabled}
          >
            {saving ? 'Saving…' : 'Save reporting zone'}
          </button>
        </form>
      )}
    </div>
  );
}
