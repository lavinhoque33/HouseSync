import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  fetchCsrf,
  fetchMe,
  postLogin,
  postLogout,
  postRegister,
  type CsrfToken,
  type SafeUser,
} from './client';
import {
  PASSWORD_HINT,
  normalizeEmail,
  validateConfirm,
  validateEmail,
  validateLoginPassword,
  validateNewPassword,
} from './validation';
import { HouseholdSection } from '../household/HouseholdSection';

type Phase = 'booting' | 'ready' | 'failed';
type Mode = 'login' | 'register';
type ForegroundKind = 'bootstrap' | 'login' | 'register' | 'logout';

interface Notice {
  kind: 'info' | 'error' | 'warning';
  text: string;
  correlationId?: string | undefined;
}

function rateLimitText(error: ApiError): string {
  if (
    typeof error.retryAfterSeconds === 'number' &&
    Number.isFinite(error.retryAfterSeconds)
  ) {
    return `Too many attempts. Try again in ${error.retryAfterSeconds} seconds.`;
  }
  return 'Too many attempts. Wait a moment and retry.';
}

function errorNotice(error: ApiError, fallback: string): Notice {
  if (error.code === 'RATE_LIMITED') {
    return {
      kind: 'error',
      text: rateLimitText(error),
      correlationId: error.correlationId,
    };
  }
  if (error.code === 'NETWORK_ERROR') {
    return { kind: 'error', text: error.message };
  }
  if (
    error.code === 'VALIDATION_FAILED' ||
    error.code === 'INVALID_CREDENTIALS' ||
    error.code === 'REGISTRATION_CONFLICT' ||
    error.code === 'UNAUTHENTICATED' ||
    error.code === 'FORBIDDEN' ||
    error.code === 'INTERNAL_ERROR' ||
    error.code === 'UNKNOWN_ERROR'
  ) {
    return {
      kind: 'error',
      text: error.message || fallback,
      correlationId: error.correlationId,
    };
  }
  return {
    kind: 'error',
    text: fallback,
    correlationId: error.correlationId,
  };
}

function timeoutNotice(kind: ForegroundKind): string {
  if (kind === 'login') {
    return 'Sign-in timed out. It may still have completed — wait a moment, then try signing in again.';
  }
  if (kind === 'register') {
    return 'Account creation timed out. It may still have completed — try signing in before creating a duplicate.';
  }
  return 'Sign-out timed out. Its outcome is unknown — you are still shown as signed in. Retry to confirm.';
}

export function AuthSection() {
  const [phase, setPhase] = useState<Phase>('booting');
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [csrf, setCsrf] = useState<CsrfToken | null>(null);
  const [user, setUser] = useState<SafeUser | null>(null);
  const [mode, setMode] = useState<Mode>('login');

  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirm, setRegConfirm] = useState('');

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [submitting, setSubmitting] = useState<'login' | 'register' | null>(
    null,
  );
  const [loggingOut, setLoggingOut] = useState(false);

  // Foreground/background ownership. Foreground auth operations own a token;
  // background session checks own a separate sequence and must never
  // supersede or strand an active foreground operation.
  const backgroundGenRef = useRef(0);
  const focusSeqRef = useRef(0);
  const opSeqRef = useRef(0);
  const activeOpRef = useRef<{ kind: ForegroundKind; token: number } | null>(
    null,
  );
  // Synchronously mirrors the user state so focus checks never read a stale
  // value through an effect lag.
  const userRef = useRef<SafeUser | null>(null);
  const focusControllerRef = useRef<AbortController | null>(null);
  const ownedControllersRef = useRef<Set<AbortController>>(new Set());
  const unmountedRef = useRef(false);

  const modeHeadingRef = useRef<HTMLHeadingElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const loginPasswordRef = useRef<HTMLInputElement>(null);

  function applyUser(next: SafeUser | null) {
    userRef.current = next;
    setUser(next);
  }

  function trackController(controller: AbortController) {
    ownedControllersRef.current.add(controller);
  }

  function untrackController(controller: AbortController) {
    ownedControllersRef.current.delete(controller);
  }

  function isActiveOp(token: number): boolean {
    return activeOpRef.current?.token === token;
  }

  function beginForeground(kind: ForegroundKind): {
    token: number;
    controller: AbortController;
  } {
    // A foreground operation supersedes older background checks: abort the
    // in-flight focus check and invalidate its generation.
    focusControllerRef.current?.abort();
    focusControllerRef.current = null;
    backgroundGenRef.current += 1;
    const token = ++opSeqRef.current;
    activeOpRef.current = { kind, token };
    const controller = new AbortController();
    trackController(controller);
    return { token, controller };
  }

  function endForeground(token: number, clearBusy: () => void) {
    if (unmountedRef.current) return;
    // Busy flags belong to the foreground token, never to the shared
    // background generation, so a background check cannot strand them.
    if (isActiveOp(token)) {
      activeOpRef.current = null;
      clearBusy();
    }
  }

  // Refresh the CSRF token after an INVALID_CSRF rejection. Returns true when
  // a fresh token is installed; the caller must still ask for an explicit
  // retry and never silently replay the rejected write.
  async function refreshTokenForRetry(
    token: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    let fresh: CsrfToken;
    try {
      fresh = await fetchCsrf(signal);
    } catch {
      return false;
    }
    if (unmountedRef.current || !isActiveOp(token)) return false;
    setCsrf(fresh);
    return true;
  }

  async function ensureCsrf(
    token: number,
    signal: AbortSignal,
  ): Promise<CsrfToken | null> {
    try {
      const fresh = await fetchCsrf(signal);
      if (unmountedRef.current || !isActiveOp(token)) return null;
      setCsrf(fresh);
      return fresh;
    } catch {
      return null;
    }
  }

  async function runBootstrap(signal: AbortSignal) {
    setPhase('booting');
    setBootstrapError(null);
    try {
      const token = await fetchCsrf(signal);
      if (unmountedRef.current || signal.aborted) return;
      setCsrf(token);
      try {
        const me = await fetchMe(signal);
        if (unmountedRef.current || signal.aborted) return;
        applyUser(me);
        setNotice(null);
        setPhase('ready');
      } catch (error) {
        if (unmountedRef.current || signal.aborted) return;
        const apiError =
          error instanceof ApiError
            ? error
            : new ApiError({
                status: 0,
                code: 'NETWORK_ERROR',
                message:
                  'Could not reach the server. Check your connection and retry.',
              });
        if (apiError.status === 401) {
          // Initial 401 is the normal anonymous state, not an error.
          applyUser(null);
          setPhase('ready');
        } else {
          setPhase('failed');
          setBootstrapError(
            apiError.code === 'NETWORK_ERROR'
              ? apiError.message
              : (apiError.message ??
                  'Could not reach the server. Check your connection and retry.'),
          );
        }
      }
    } catch (error) {
      if (unmountedRef.current || signal.aborted) return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              code: 'NETWORK_ERROR',
              message: 'Could not prepare a secure request. Retry.',
            });
      setPhase('failed');
      setBootstrapError(apiError.message);
    }
  }

  useEffect(() => {
    // StrictMode replays setup→cleanup→setup in development: the cleanup
    // marks unmount, so setup must reclaim the mounted state while the
    // previous setup's aborted controller/supserseded token still
    // invalidate its own continuations.
    unmountedRef.current = false;
    const { token, controller } = beginForeground('bootstrap');
    const owned = ownedControllersRef.current;
    void (async () => {
      try {
        await runBootstrap(controller.signal);
      } finally {
        untrackController(controller);
        endForeground(token, () => {});
      }
    })();
    return () => {
      unmountedRef.current = true;
      controller.abort();
      focusControllerRef.current?.abort();
      for (const tracked of owned) tracked.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recheck the session when the tab regains focus. Background checks use
  // their own sequence and yield to any active foreground operation.
  useEffect(() => {
    const onFocus = () => {
      if (activeOpRef.current !== null) return;
      if (userRef.current === null) return;
      focusControllerRef.current?.abort();
      const controller = new AbortController();
      trackController(controller);
      focusControllerRef.current = controller;
      const myFocus = ++focusSeqRef.current;
      const capturedGen = backgroundGenRef.current;
      void (async () => {
        try {
          const me = await fetchMe(controller.signal);
          untrackController(controller);
          if (unmountedRef.current) return;
          if (activeOpRef.current !== null) return;
          if (focusSeqRef.current !== myFocus) return;
          if (backgroundGenRef.current !== capturedGen) return;
          if (controller.signal.aborted) return;
          applyUser(me);
          setNotice((current) =>
            current?.text === 'Your session ended. Sign in again.'
              ? null
              : current,
          );
        } catch (error) {
          untrackController(controller);
          if (unmountedRef.current) return;
          if (activeOpRef.current !== null) return;
          if (focusSeqRef.current !== myFocus) return;
          if (backgroundGenRef.current !== capturedGen) return;
          if (controller.signal.aborted) return;
          if (error instanceof DOMException && error.name === 'AbortError') {
            return;
          }
          const apiError =
            error instanceof ApiError
              ? error
              : new ApiError({
                  status: 0,
                  code: 'NETWORK_ERROR',
                  message:
                    'Could not confirm your session. Check your connection.',
                });
          if (apiError.status === 401 && userRef.current !== null) {
            // An established session expired server-side. Drop the stale
            // CSRF token so the next sign-in cannot reuse it, then prepare
            // a fresh anonymous token. A refresh failure leaves the token
            // empty and the sign-in form recovers it on demand.
            applyUser(null);
            setLoginPassword('');
            setRegPassword('');
            setRegConfirm('');
            setCsrf(null);
            setNotice({
              kind: 'warning',
              text: 'Your session ended. Sign in again.',
            });
            requestAnimationFrame(() => noticeRef.current?.focus());
            const refreshController = new AbortController();
            trackController(refreshController);
            try {
              const fresh = await fetchCsrf(refreshController.signal);
              untrackController(refreshController);
              if (unmountedRef.current) return;
              if (activeOpRef.current !== null) return;
              if (focusSeqRef.current !== myFocus) return;
              if (backgroundGenRef.current !== capturedGen) return;
              setCsrf(fresh);
            } catch {
              untrackController(refreshController);
            }
          } else if (apiError.status !== 401) {
            // A network/server failure must not masquerade as confirmed expiry.
            setNotice({
              kind: 'warning',
              text: 'Could not confirm your session. Check your connection; you are still signed in.',
              correlationId: apiError.correlationId,
            });
          }
        }
      })();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      focusControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (notice && noticeRef.current) {
      noticeRef.current.focus();
    }
  }, [notice]);

  function switchMode(next: Mode) {
    if (next === mode) return;
    backgroundGenRef.current += 1;
    setMode(next);
    setFieldErrors({});
    setNotice(null);
    requestAnimationFrame(() => modeHeadingRef.current?.focus());
  }

  function toActionError(error: unknown): ApiError {
    if (error instanceof ApiError) return error;
    return new ApiError({
      status: 0,
      code: 'NETWORK_ERROR',
      message: 'Could not reach the server. Check your connection.',
    });
  }

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    if (activeOpRef.current !== null || submitting !== null || loggingOut) {
      return;
    }
    const emailError = validateEmail(loginEmail);
    const passwordError = validateLoginPassword(loginPassword);
    const nextFieldErrors: Record<string, string> = {};
    if (emailError) nextFieldErrors.loginEmail = emailError;
    if (passwordError) nextFieldErrors.loginPassword = passwordError;
    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      setNotice({ kind: 'error', text: 'Check the highlighted fields.' });
      return;
    }
    const { token, controller } = beginForeground('login');
    setFieldErrors({});
    setNotice(null);
    setSubmitting('login');
    try {
      let requestCsrf = csrf;
      if (requestCsrf === null) {
        requestCsrf = await ensureCsrf(token, controller.signal);
        if (requestCsrf === null) {
          if (unmountedRef.current || !isActiveOp(token)) return;
          setNotice({
            kind: 'error',
            text: 'Security setup is still loading. Wait a moment and retry.',
          });
          return;
        }
      }
      const credentials = {
        email: normalizeEmail(loginEmail),
        password: loginPassword,
      };
      const me = await postLogin(credentials, requestCsrf, controller.signal);
      if (unmountedRef.current || !isActiveOp(token)) return;
      // The login itself completed: record it before refreshing CSRF so a
      // post-action bootstrap failure cannot pretend the sign-in failed.
      applyUser(me);
      setLoginPassword('');
      setRegPassword('');
      setRegConfirm('');
      setNotice({ kind: 'info', text: `Signed in as ${me.email}.` });
      try {
        const fresh = await fetchCsrf(controller.signal);
        if (unmountedRef.current || !isActiveOp(token)) return;
        setCsrf(fresh);
      } catch (refreshError) {
        if (unmountedRef.current || !isActiveOp(token)) return;
        if (
          refreshError instanceof DOMException &&
          refreshError.name === 'AbortError'
        ) {
          return;
        }
        setNotice({
          kind: 'warning',
          text: `Signed in as ${me.email}, but the security token could not be refreshed. Reload before your next change.`,
        });
      }
    } catch (error) {
      if (unmountedRef.current || !isActiveOp(token)) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const apiError = toActionError(error);
      if (apiError.timedOut) {
        setNotice({ kind: 'error', text: timeoutNotice('login') });
        return;
      }
      if (apiError.code === 'CSRF_INVALID') {
        const refreshed = await refreshTokenForRetry(token, controller.signal);
        if (unmountedRef.current || !isActiveOp(token)) return;
        setNotice({
          kind: 'error',
          text: refreshed
            ? 'Your security token was refreshed. Review your details and try signing in again.'
            : 'Your session request was rejected. Reload and try signing in again.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      if (apiError.fieldErrors) {
        const mapped: Record<string, string> = {};
        if (apiError.fieldErrors.email) {
          mapped.loginEmail = apiError.fieldErrors.email;
        }
        if (apiError.fieldErrors.password) {
          mapped.loginPassword = apiError.fieldErrors.password;
        }
        setFieldErrors(mapped);
      } else {
        setFieldErrors({});
      }
      if (apiError.code === 'INVALID_CREDENTIALS') {
        setLoginPassword('');
      }
      setNotice(errorNotice(apiError, 'Sign-in could not be completed.'));
    } finally {
      untrackController(controller);
      endForeground(token, () => setSubmitting(null));
    }
  }

  async function handleRegister(event: FormEvent) {
    event.preventDefault();
    if (activeOpRef.current !== null || submitting !== null || loggingOut) {
      return;
    }
    const emailError = validateEmail(regEmail);
    const passwordError = validateNewPassword(regPassword);
    const confirmError = validateConfirm(regPassword, regConfirm);
    const nextFieldErrors: Record<string, string> = {};
    if (emailError) nextFieldErrors.regEmail = emailError;
    if (passwordError) nextFieldErrors.regPassword = passwordError;
    if (confirmError) nextFieldErrors.regConfirm = confirmError;
    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      setNotice({ kind: 'error', text: 'Check the highlighted fields.' });
      return;
    }
    const { token, controller } = beginForeground('register');
    setFieldErrors({});
    setNotice(null);
    setSubmitting('register');
    try {
      let requestCsrf = csrf;
      if (requestCsrf === null) {
        requestCsrf = await ensureCsrf(token, controller.signal);
        if (requestCsrf === null) {
          if (unmountedRef.current || !isActiveOp(token)) return;
          setNotice({
            kind: 'error',
            text: 'Security setup is still loading. Wait a moment and retry.',
          });
          return;
        }
      }
      const email = normalizeEmail(regEmail);
      await postRegister(
        { email, password: regPassword },
        requestCsrf,
        controller.signal,
      );
      if (unmountedRef.current || !isActiveOp(token)) return;
      // Registration does not authenticate: retain the email for sign-in,
      // clear every password field, and move to the sign-in form.
      setLoginEmail(email);
      setLoginPassword('');
      setRegPassword('');
      setRegConfirm('');
      setMode('login');
      setNotice({
        kind: 'info',
        text: 'Account created. Sign in with your new password.',
      });
      requestAnimationFrame(() => loginPasswordRef.current?.focus());
    } catch (error) {
      if (unmountedRef.current || !isActiveOp(token)) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const apiError = toActionError(error);
      if (apiError.timedOut) {
        setNotice({ kind: 'error', text: timeoutNotice('register') });
        return;
      }
      if (apiError.code === 'CSRF_INVALID') {
        const refreshed = await refreshTokenForRetry(token, controller.signal);
        if (unmountedRef.current || !isActiveOp(token)) return;
        setNotice({
          kind: 'error',
          text: refreshed
            ? 'Your security token was refreshed. Review your details and try creating the account again.'
            : 'Your session request was rejected. Reload and try again.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      if (apiError.fieldErrors) {
        const mapped: Record<string, string> = {};
        if (apiError.fieldErrors.email) {
          mapped.regEmail = apiError.fieldErrors.email;
        }
        if (apiError.fieldErrors.password) {
          mapped.regPassword = apiError.fieldErrors.password;
        }
        if (apiError.fieldErrors.confirmPassword) {
          mapped.regConfirm = apiError.fieldErrors.confirmPassword;
        }
        setFieldErrors(mapped);
      }
      setNotice(errorNotice(apiError, 'Registration could not be completed.'));
    } finally {
      untrackController(controller);
      endForeground(token, () => setSubmitting(null));
    }
  }

  async function handleLogout() {
    if (activeOpRef.current !== null || loggingOut || submitting !== null) {
      return;
    }
    const { token, controller } = beginForeground('logout');
    setLoggingOut(true);
    setNotice(null);
    try {
      let requestCsrf = csrf;
      if (requestCsrf === null) {
        requestCsrf = await ensureCsrf(token, controller.signal);
        if (requestCsrf === null) {
          if (unmountedRef.current || !isActiveOp(token)) return;
          setNotice({
            kind: 'error',
            text: 'Security setup is still loading. Wait a moment and retry.',
          });
          return;
        }
      }
      await postLogout(requestCsrf, controller.signal);
      if (unmountedRef.current || !isActiveOp(token)) return;
      // Logout completed server-side: clear identity first, then rebootstrap
      // an anonymous CSRF token. A refresh failure keeps the signed-out
      // state and warns instead of pretending the session survived.
      applyUser(null);
      setLoginPassword('');
      setRegPassword('');
      setRegConfirm('');
      setNotice({ kind: 'info', text: 'Signed out.' });
      try {
        const fresh = await fetchCsrf(controller.signal);
        if (unmountedRef.current || !isActiveOp(token)) return;
        setCsrf(fresh);
      } catch (refreshError) {
        if (unmountedRef.current || !isActiveOp(token)) return;
        if (
          refreshError instanceof DOMException &&
          refreshError.name === 'AbortError'
        ) {
          return;
        }
        setNotice({
          kind: 'warning',
          text: 'Signed out, but the security token could not be refreshed. Reload before signing in again.',
        });
      }
    } catch (error) {
      if (unmountedRef.current || !isActiveOp(token)) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const apiError = toActionError(error);
      if (apiError.timedOut) {
        // A timed-out logout may still have completed server-side, but the
        // client must not present an unconfirmed sign-out as success.
        setNotice({ kind: 'error', text: timeoutNotice('logout') });
        return;
      }
      if (apiError.code === 'CSRF_INVALID') {
        const refreshed = await refreshTokenForRetry(token, controller.signal);
        if (unmountedRef.current || !isActiveOp(token)) return;
        setNotice({
          kind: 'error',
          text: refreshed
            ? 'Your security token was refreshed. Try signing out again — you are still signed in.'
            : 'Sign-out was rejected. Reload and retry — you are still signed in.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      // A failed logout preserves the authenticated state.
      setNotice(
        errorNotice(apiError, 'Sign-out failed. You are still signed in.'),
      );
    } finally {
      untrackController(controller);
      endForeground(token, () => setLoggingOut(false));
    }
  }

  function retryBootstrap() {
    if (activeOpRef.current !== null) return;
    const { token, controller } = beginForeground('bootstrap');
    void (async () => {
      try {
        await runBootstrap(controller.signal);
      } finally {
        untrackController(controller);
        endForeground(token, () => {});
      }
    })();
  }

  // Confirmed household-API session expiry. Mirrors the focus-recheck
  // recovery: drop the stale user and CSRF token, show sign-in-again, and
  // prepare a fresh anonymous token. The household section unmounts with the
  // cleared user, discarding its response state. A refresh failure leaves
  // the token empty and the next sign-in recovers it on demand.
  function handleHouseholdSessionExpired() {
    if (unmountedRef.current) return;
    backgroundGenRef.current += 1;
    applyUser(null);
    setLoginPassword('');
    setRegPassword('');
    setRegConfirm('');
    setCsrf(null);
    setNotice({
      kind: 'warning',
      text: 'Your session ended. Sign in again.',
    });
    requestAnimationFrame(() => noticeRef.current?.focus());
    const refreshController = new AbortController();
    trackController(refreshController);
    void (async () => {
      try {
        const fresh = await fetchCsrf(refreshController.signal);
        untrackController(refreshController);
        if (unmountedRef.current) return;
        setCsrf(fresh);
      } catch {
        untrackController(refreshController);
      }
    })();
  }

  if (phase === 'booting') {
    return (
      <section className="auth" aria-labelledby="auth-title">
        <h2 id="auth-title">Account</h2>
        <div role="status" aria-live="polite" aria-atomic="true">
          <p>Checking your session…</p>
        </div>
      </section>
    );
  }

  if (phase === 'failed') {
    return (
      <section className="auth" aria-labelledby="auth-title">
        <h2 id="auth-title">Account</h2>
        <div role="alert" className="auth-notice auth-notice--error">
          <p>{bootstrapError ?? 'Could not reach the server.'}</p>
          <p className="auth-notice-detail">
            Your sign-in state could not be confirmed. Nothing was signed out.
          </p>
        </div>
        <button type="button" className="auth-button" onClick={retryBootstrap}>
          Retry
        </button>
      </section>
    );
  }

  if (user !== null) {
    return (
      <section className="auth" aria-labelledby="auth-title">
        <h2 id="auth-title">Account</h2>
        {notice && (
          <div
            ref={noticeRef}
            tabIndex={-1}
            role={notice.kind === 'error' ? 'alert' : 'status'}
            aria-live="polite"
            className={`auth-notice auth-notice--${notice.kind}`}
          >
            <p>{notice.text}</p>
            {notice.correlationId && (
              <p className="auth-notice-detail">
                Reference: {notice.correlationId}
              </p>
            )}
          </div>
        )}
        <div className="auth-card">
          <p className="eyebrow">Signed in</p>
          <p className="auth-email">{user.email}</p>
          <p className="auth-meta">Account ID: {user.id}</p>
          <button
            type="button"
            className="auth-button"
            onClick={() => void handleLogout()}
            disabled={loggingOut || submitting !== null}
          >
            {loggingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
        <div className="auth-card">
          <HouseholdSection
            key={user.id}
            csrf={csrf}
            onCsrfRefreshed={setCsrf}
            onSessionExpired={handleHouseholdSessionExpired}
          />
        </div>
      </section>
    );
  }

  const isLogin = mode === 'login';

  return (
    <section className="auth" aria-labelledby="auth-title">
      <h2 id="auth-title">Account</h2>
      <div
        className="auth-tabs"
        role="group"
        aria-label="Choose sign in or create account"
      >
        <button
          type="button"
          className={`auth-tab${isLogin ? ' auth-tab--active' : ''}`}
          aria-pressed={isLogin}
          disabled={submitting !== null}
          onClick={() => switchMode('login')}
        >
          Sign in
        </button>
        <button
          type="button"
          className={`auth-tab${!isLogin ? ' auth-tab--active' : ''}`}
          aria-pressed={!isLogin}
          disabled={submitting !== null}
          onClick={() => switchMode('register')}
        >
          Create account
        </button>
      </div>

      {notice && (
        <div
          ref={noticeRef}
          tabIndex={-1}
          role={notice.kind === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          className={`auth-notice auth-notice--${notice.kind}`}
        >
          <p>{notice.text}</p>
          {notice.correlationId && (
            <p className="auth-notice-detail">
              Reference: {notice.correlationId}
            </p>
          )}
        </div>
      )}

      {isLogin ? (
        <form
          className="auth-form"
          onSubmit={(event) => void handleLogin(event)}
          noValidate
        >
          <h3 ref={modeHeadingRef} tabIndex={-1} className="auth-form-title">
            Sign in
          </h3>
          <div className="auth-field">
            <label htmlFor="login-email">Email</label>
            <input
              id="login-email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              maxLength={254}
              value={loginEmail}
              onChange={(event) => setLoginEmail(event.target.value)}
              aria-invalid={Boolean(fieldErrors.loginEmail)}
              aria-describedby={
                fieldErrors.loginEmail ? 'login-email-error' : undefined
              }
            />
            {fieldErrors.loginEmail && (
              <p id="login-email-error" role="alert" className="auth-error">
                {fieldErrors.loginEmail}
              </p>
            )}
          </div>
          <div className="auth-field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              ref={loginPasswordRef}
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={loginPassword}
              onChange={(event) => setLoginPassword(event.target.value)}
              aria-invalid={Boolean(fieldErrors.loginPassword)}
              aria-describedby={
                fieldErrors.loginPassword ? 'login-password-error' : undefined
              }
            />
            {fieldErrors.loginPassword && (
              <p id="login-password-error" role="alert" className="auth-error">
                {fieldErrors.loginPassword}
              </p>
            )}
          </div>
          <button
            type="submit"
            className="auth-button"
            disabled={submitting !== null}
          >
            {submitting === 'login' ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      ) : (
        <form
          className="auth-form"
          onSubmit={(event) => void handleRegister(event)}
          noValidate
        >
          <h3 ref={modeHeadingRef} tabIndex={-1} className="auth-form-title">
            Create account
          </h3>
          <div className="auth-field">
            <label htmlFor="register-email">Email</label>
            <input
              id="register-email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              maxLength={254}
              value={regEmail}
              onChange={(event) => setRegEmail(event.target.value)}
              aria-invalid={Boolean(fieldErrors.regEmail)}
              aria-describedby={
                fieldErrors.regEmail ? 'register-email-error' : undefined
              }
            />
            {fieldErrors.regEmail && (
              <p id="register-email-error" role="alert" className="auth-error">
                {fieldErrors.regEmail}
              </p>
            )}
          </div>
          <div className="auth-field">
            <label htmlFor="register-password">Password</label>
            <input
              id="register-password"
              name="new-password"
              type="password"
              autoComplete="new-password"
              required
              value={regPassword}
              onChange={(event) => setRegPassword(event.target.value)}
              aria-invalid={Boolean(fieldErrors.regPassword)}
              aria-describedby="register-password-hint register-password-error"
            />
            <p id="register-password-hint" className="auth-hint">
              {PASSWORD_HINT}
            </p>
            {fieldErrors.regPassword && (
              <p
                id="register-password-error"
                role="alert"
                className="auth-error"
              >
                {fieldErrors.regPassword}
              </p>
            )}
          </div>
          <div className="auth-field">
            <label htmlFor="register-confirm">Confirm password</label>
            <input
              id="register-confirm"
              name="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              value={regConfirm}
              onChange={(event) => setRegConfirm(event.target.value)}
              aria-invalid={Boolean(fieldErrors.regConfirm)}
              aria-describedby={
                fieldErrors.regConfirm ? 'register-confirm-error' : undefined
              }
            />
            {fieldErrors.regConfirm && (
              <p
                id="register-confirm-error"
                role="alert"
                className="auth-error"
              >
                {fieldErrors.regConfirm}
              </p>
            )}
          </div>
          <button
            type="submit"
            className="auth-button"
            disabled={submitting !== null}
          >
            {submitting === 'register' ? 'Creating…' : 'Create account'}
          </button>
        </form>
      )}
    </section>
  );
}
