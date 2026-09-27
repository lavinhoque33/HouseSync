import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  fetchCsrf,
  fetchMe,
  postLogin,
  postLogout,
  postRegister,
  postRecover,
  postChangePassword,
  postRevokeSessions,
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
import { JoinSection } from '../invitation/JoinSection';
import type { PendingInvite } from '../invitation/route';
import type { AccountLinkRoute } from './route';

type Phase = 'booting' | 'ready' | 'failed';
type ForegroundKind =
  | 'bootstrap'
  | 'login'
  | 'register'
  | 'recover'
  | 'password'
  | 'revoke'
  | 'logout';

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

export interface AuthSectionProps {
  /**
   * Capability extracted from the `/join/{id}#invite={secret}` route. Owned
   * by the application root above this section so registration, sign-in,
   * and user-keyed household branches never drop it mid-flow. It lives in
   * memory only and is never written to web storage.
   */
  invite?: PendingInvite | null | undefined;
  joinActive?: boolean | undefined;
  joinInvalid?: boolean | undefined;
  onInviteCleared?: (() => void) | undefined;
  onLeaveJoin?: (() => void) | undefined;
  accountLink?: AccountLinkRoute | null | undefined;
  onLeaveAccountLink?: (() => void) | undefined;
}

export function AuthSection({
  invite = null,
  joinActive = false,
  joinInvalid = false,
  onInviteCleared = () => {},
  onLeaveJoin = () => {},
  accountLink = null,
  onLeaveAccountLink = () => {},
}: AuthSectionProps = {}) {
  const [phase, setPhase] = useState<Phase>('booting');
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [csrf, setCsrf] = useState<CsrfToken | null>(null);
  const [user, setUser] = useState<SafeUser | null>(null);

  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirm, setRegConfirm] = useState('');
  const [recoverEmail, setRecoverEmail] = useState('');
  const [recoverPassword, setRecoverPassword] = useState('');
  const [recoverConfirm, setRecoverConfirm] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newConfirm, setNewConfirm] = useState('');

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [submitting, setSubmitting] = useState<
    'login' | 'register' | 'recover' | 'password' | 'revoke' | null
  >(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [invitationRequestsReady, setInvitationRequestsReady] = useState(true);
  // Bumped when the join flow accepts an invitation so the household
  // collection below reloads and shows the newly joined household.
  // `householdsSettled` records the latest requested reload that settled;
  // the join flow unlocks its explicit accept retry only after the version
  // it requested settles, enforcing reconciliation-before-retry order.
  const [householdsVersion, setHouseholdsVersion] = useState(0);
  const [householdsSettled, setHouseholdsSettled] = useState(0);

  // Foreground/background ownership. Foreground auth operations own a token;
  // background session checks own a separate sequence and must never
  // supersede or strand an active foreground operation.
  const backgroundGenRef = useRef(0);
  const focusSeqRef = useRef(0);
  const opSeqRef = useRef(0);
  const activeOpRef = useRef<{
    kind: ForegroundKind;
    token: number;
    controller: AbortController;
  } | null>(null);
  // Synchronously mirrors the user state so focus checks never read a stale
  // value through an effect lag.
  const userRef = useRef<SafeUser | null>(null);
  const focusControllerRef = useRef<AbortController | null>(null);
  const ownedControllersRef = useRef<Set<AbortController>>(new Set());
  const unmountedRef = useRef(false);

  const modeHeadingRef = useRef<HTMLHeadingElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const loginPasswordRef = useRef<HTMLInputElement>(null);

  // Guarded render-time reset prevents a previous link's alert or typed
  // credentials from appearing on the next link, without erasing the success
  // notice when leaving the link after completion.
  const [previousLink, setPreviousLink] = useState<AccountLinkRoute | null>(
    accountLink,
  );
  const linkKind = accountLink?.kind;
  const linkCode = accountLink?.code;
  const linkInvalid = accountLink?.invalid;
  if (
    previousLink?.kind !== linkKind ||
    previousLink?.code !== linkCode ||
    previousLink?.invalid !== linkInvalid
  ) {
    setPreviousLink(accountLink);
    setSubmitting(null);
    setRegPassword('');
    setRegConfirm('');
    setRecoverPassword('');
    setRecoverConfirm('');
    if (accountLink) {
      setNotice(null);
      setFieldErrors({});
      setRegEmail('');
      setRecoverEmail('');
    }
  }

  // An earlier request may finish after a route change. Abort its transport
  // and invalidate its ownership before it can post an error on the new link.
  useEffect(() => {
    const active = activeOpRef.current;
    if (active?.kind !== 'register' && active?.kind !== 'recover') return;
    activeOpRef.current = null;
    active.controller.abort();
  }, [linkKind, linkCode, linkInvalid]);

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
    const controller = new AbortController();
    activeOpRef.current = { kind, token, controller };
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
      setInvitationRequestsReady(false);
      applyUser(me);
      setLoginPassword('');
      setRegPassword('');
      setRegConfirm('');
      setNotice({ kind: 'info', text: `Signed in as ${me.email}.` });
      // The login itself is visible immediately, but invitation preview waits
      // for this refresh so it cannot submit the pre-authentication CSRF token.
      try {
        const fresh = await fetchCsrf(controller.signal);
        if (unmountedRef.current || !isActiveOp(token)) return;
        setCsrf(fresh);
        setInvitationRequestsReady(true);
      } catch (refreshError) {
        if (unmountedRef.current || !isActiveOp(token)) return;
        if (
          refreshError instanceof DOMException &&
          refreshError.name === 'AbortError'
        ) {
          return;
        }
        setCsrf(null);
        setInvitationRequestsReady(true);
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
        { email, password: regPassword, enrollmentCode: accountLink!.code! },
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
      onLeaveAccountLink();
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
      setNotice(
        apiError.code === 'ENROLLMENT_INVALID'
          ? {
              kind: 'error',
              text: 'This enrollment link is invalid, expired, or already used. Ask the operator for a new link.',
            }
          : errorNotice(apiError, 'Enrollment could not be completed.'),
      );
    } finally {
      untrackController(controller);
      endForeground(token, () => setSubmitting(null));
    }
  }

  async function handleRecover(event: FormEvent) {
    event.preventDefault();
    if (!accountLink?.code || activeOpRef.current) return;
    const errors: Record<string, string> = {};
    const emailError = validateEmail(recoverEmail);
    const passwordError = validateNewPassword(recoverPassword);
    const confirmError = validateConfirm(recoverPassword, recoverConfirm);
    if (emailError) errors.recoverEmail = emailError;
    if (passwordError) errors.recoverPassword = passwordError;
    if (confirmError) errors.recoverConfirm = confirmError;
    if (Object.keys(errors).length) {
      setFieldErrors(errors);
      setNotice({ kind: 'error', text: 'Check the highlighted fields.' });
      return;
    }
    const { token, controller } = beginForeground('recover');
    setSubmitting('recover');
    setFieldErrors({});
    setNotice(null);
    try {
      const requestCsrf = csrf ?? (await ensureCsrf(token, controller.signal));
      if (!requestCsrf) {
        setNotice({ kind: 'error', text: 'Security setup failed. Retry.' });
        return;
      }
      await postRecover(
        {
          email: normalizeEmail(recoverEmail),
          recoveryCode: accountLink.code,
          newPassword: recoverPassword,
        },
        requestCsrf,
        controller.signal,
      );
      if (unmountedRef.current || !isActiveOp(token)) return;
      setLoginEmail(normalizeEmail(recoverEmail));
      setRecoverPassword('');
      setRecoverConfirm('');
      onLeaveAccountLink();
      setNotice({
        kind: 'info',
        text: 'Password updated. Sign in with your new password.',
      });
      requestAnimationFrame(() => loginPasswordRef.current?.focus());
    } catch (error) {
      if (unmountedRef.current || !isActiveOp(token)) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const apiError = toActionError(error);
      if (apiError.code === 'CSRF_INVALID') {
        const refreshed = await refreshTokenForRetry(token, controller.signal);
        if (unmountedRef.current || !isActiveOp(token)) return;
        setNotice({
          kind: 'error',
          text: refreshed
            ? 'Your security token was refreshed. Review your details and try recovery again.'
            : 'Your security token was rejected. Reload the original recovery link and try again.',
          correlationId: apiError.correlationId,
        });
        return;
      }
      setRecoverPassword('');
      setRecoverConfirm('');
      setNotice(
        apiError.code === 'RECOVERY_INVALID'
          ? {
              kind: 'error',
              text: 'This recovery link is invalid, expired, or already used. Ask the operator for a new link.',
            }
          : {
              kind: 'error',
              text: apiError.timedOut
                ? 'Recovery outcome is unknown. Try signing in with your new password before requesting a new link.'
                : 'Recovery could not be confirmed. Check your connection or contact the operator.',
              correlationId: apiError.correlationId,
            },
      );
    } finally {
      untrackController(controller);
      endForeground(token, () => setSubmitting(null));
    }
  }

  async function handleAccountAction(
    kind: 'password' | 'revoke',
    event?: FormEvent,
  ) {
    event?.preventDefault();
    if (activeOpRef.current || !userRef.current) return;
    if (kind === 'password') {
      const errors: Record<string, string> = {};
      const currentError = validateLoginPassword(currentPassword);
      const passwordError = validateNewPassword(newPassword);
      const confirmError = validateConfirm(newPassword, newConfirm);
      if (currentError) errors.currentPassword = currentError;
      if (passwordError) errors.newPassword = passwordError;
      if (confirmError) errors.newConfirm = confirmError;
      if (Object.keys(errors).length) {
        setFieldErrors(errors);
        setNotice({ kind: 'error', text: 'Check the highlighted fields.' });
        return;
      }
    }
    const { token, controller } = beginForeground(kind);
    setSubmitting(kind);
    setFieldErrors({});
    setNotice(null);
    try {
      const requestCsrf = csrf ?? (await ensureCsrf(token, controller.signal));
      if (!requestCsrf) {
        setNotice({ kind: 'error', text: 'Security setup failed. Retry.' });
        return;
      }
      if (kind === 'password') {
        await postChangePassword(
          { currentPassword, newPassword },
          requestCsrf,
          controller.signal,
        );
      } else {
        await postRevokeSessions(requestCsrf, controller.signal);
      }
      if (unmountedRef.current || !isActiveOp(token)) return;
      applyUser(null);
      setCsrf(null);
      setCurrentPassword('');
      setNewPassword('');
      setNewConfirm('');
      setLoginPassword('');
      setRegPassword('');
      setRegConfirm('');
      if (joinActive) onLeaveJoin();
      if (accountLink) onLeaveAccountLink();
      setNotice({
        kind: 'info',
        text:
          kind === 'password'
            ? 'Password changed. All sessions ended. Sign in with your new password.'
            : 'All sessions ended. Sign in again.',
      });
      try {
        const fresh = await fetchCsrf(controller.signal);
        if (unmountedRef.current || !isActiveOp(token)) return;
        setCsrf(fresh);
      } catch {
        if (unmountedRef.current || !isActiveOp(token)) return;
        setNotice({
          kind: 'warning',
          text: 'Sessions ended. Reload before signing in again.',
        });
      }
    } catch (error) {
      if (unmountedRef.current || !isActiveOp(token)) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const apiError = toActionError(error);
      setCurrentPassword('');
      setNewPassword('');
      setNewConfirm('');
      if (apiError.fieldErrors?.newPassword) {
        setFieldErrors({ newPassword: apiError.fieldErrors.newPassword });
      }
      if (apiError.code === 'CSRF_INVALID')
        await refreshTokenForRetry(token, controller.signal);
      if (unmountedRef.current || !isActiveOp(token)) return;
      if (apiError.status === 401 && apiError.code !== 'INVALID_CREDENTIALS') {
        handleHouseholdSessionExpired();
      } else {
        setNotice({
          kind: 'error',
          text:
            apiError.code === 'INVALID_CREDENTIALS'
              ? 'Current password is incorrect.'
              : apiError.timedOut || apiError.code === 'NETWORK_ERROR'
                ? 'Outcome unknown. Check whether your session is still active before retrying.'
                : apiError.code === 'CSRF_INVALID'
                  ? 'Security token refreshed. Review and try again.'
                  : apiError.code === 'VALIDATION_FAILED'
                    ? 'Check the highlighted fields and choose a new password.'
                    : 'Request failed. Your session may still be active.',
          correlationId: apiError.correlationId,
        });
      }
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
      // Explicit logout discards the in-memory invitation secret and leaves
      // the join route, so a signed-out tab never retains a capability.
      if (joinActive) {
        onLeaveJoin();
      }
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
        {joinActive && (
          <div className="join-notice">
            <h3>Household invitation</h3>
            {joinInvalid || !invite ? (
              <p>
                This invitation link is invalid or no longer available. Ask the
                household owner for a new link.
              </p>
            ) : (
              <p>
                You opened a household invitation link, but your session state
                could not be confirmed, so no invitation details were loaded.
                Retry above, or dismiss the invitation to continue without it.
              </p>
            )}
            <button
              type="button"
              className="household-button household-button--secondary"
              onClick={onLeaveJoin}
            >
              Dismiss invitation
            </button>
          </div>
        )}
      </section>
    );
  }

  function joinFlow() {
    if (!joinActive) return null;
    return (
      <JoinSection
        invite={invite}
        joinActive={joinActive}
        joinInvalid={joinInvalid}
        csrf={csrf}
        user={user}
        onCsrfRefreshed={setCsrf}
        onSessionExpired={handleHouseholdSessionExpired}
        onInviteCleared={onInviteCleared}
        onLeaveJoin={onLeaveJoin}
        onHouseholdsChanged={() =>
          setHouseholdsVersion((version) => version + 1)
        }
        reconcileVersion={householdsVersion}
        reconcileSettled={householdsSettled}
        authenticatedRequestsReady={invitationRequestsReady}
        onRequestReconcile={() =>
          setHouseholdsVersion((version) => version + 1)
        }
      />
    );
  }

  if (user !== null) {
    return (
      <section className="auth" aria-labelledby="auth-title">
        <h2 id="auth-title">Account</h2>
        {joinFlow()}
        {accountLink && (
          <div className="auth-card">
            <p role="status">
              You are already signed in. To use an operator-issued{' '}
              {accountLink.kind === 'enroll' ? 'enrollment' : 'recovery'} link,
              first sign out and reopen the original link.
            </p>
            <button
              type="button"
              className="auth-button"
              onClick={onLeaveAccountLink}
            >
              Dismiss account link
            </button>
          </div>
        )}
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
          <form
            className="auth-form"
            onSubmit={(event) => void handleAccountAction('password', event)}
            noValidate
          >
            <h3>Change password</h3>
            <div className="auth-field">
              <label htmlFor="current-password">Current password</label>
              <input
                id="current-password"
                type="password"
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                aria-invalid={Boolean(fieldErrors.currentPassword)}
                aria-describedby={
                  fieldErrors.currentPassword
                    ? 'current-password-error'
                    : undefined
                }
              />
              {fieldErrors.currentPassword && (
                <p
                  id="current-password-error"
                  role="alert"
                  className="auth-error"
                >
                  {fieldErrors.currentPassword}
                </p>
              )}
            </div>
            <div className="auth-field">
              <label htmlFor="new-password">New password</label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                aria-invalid={Boolean(fieldErrors.newPassword)}
                aria-describedby="new-password-hint new-password-error"
              />
              <p id="new-password-hint" className="auth-hint">
                {PASSWORD_HINT}
              </p>
              {fieldErrors.newPassword && (
                <p id="new-password-error" role="alert" className="auth-error">
                  {fieldErrors.newPassword}
                </p>
              )}
            </div>
            <div className="auth-field">
              <label htmlFor="new-confirm">Confirm new password</label>
              <input
                id="new-confirm"
                type="password"
                autoComplete="new-password"
                required
                value={newConfirm}
                onChange={(event) => setNewConfirm(event.target.value)}
                aria-invalid={Boolean(fieldErrors.newConfirm)}
                aria-describedby={
                  fieldErrors.newConfirm ? 'new-confirm-error' : undefined
                }
              />
              {fieldErrors.newConfirm && (
                <p id="new-confirm-error" role="alert" className="auth-error">
                  {fieldErrors.newConfirm}
                </p>
              )}
            </div>
            <button
              type="submit"
              className="auth-button"
              disabled={submitting !== null || loggingOut}
            >
              {submitting === 'password'
                ? 'Changing…'
                : 'Change password and sign out everywhere'}
            </button>
          </form>
          <p className="auth-hint">
            Lost access to your password? Contact the operator for an assisted
            recovery link; your email alone cannot authorize recovery.
          </p>
          <button
            type="button"
            className="auth-button"
            disabled={submitting !== null || loggingOut}
            onClick={() => void handleAccountAction('revoke')}
          >
            {submitting === 'revoke'
              ? 'Ending sessions…'
              : 'Sign out everywhere'}
          </button>
        </div>
        <div className="auth-card">
          <HouseholdSection
            key={user.id}
            csrf={csrf}
            onCsrfRefreshed={setCsrf}
            onSessionExpired={handleHouseholdSessionExpired}
            refreshSignal={householdsVersion}
            onRefreshSettled={setHouseholdsSettled}
            currentUserId={user.id}
            onHouseholdReconcile={() =>
              setHouseholdsVersion((version) => version + 1)
            }
          />
        </div>
      </section>
    );
  }

  const isLogin =
    accountLink?.kind !== 'enroll' && accountLink?.kind !== 'recover';

  return (
    <section className="auth" aria-labelledby="auth-title">
      <h2 id="auth-title">Account</h2>
      {joinFlow()}
      {!accountLink && (
        <p className="auth-hint">
          New here or lost your password? Contact the HouseSync operator for a
          private enrollment or recovery link. Email alone is not proof of
          account ownership.
        </p>
      )}
      {accountLink && (
        <div className="auth-card">
          {accountLink.invalid || !accountLink.code ? (
            <p role="alert">
              This {accountLink.kind === 'enroll' ? 'enrollment' : 'recovery'}{' '}
              link cannot be used. Ask the operator for a new link.
            </p>
          ) : (
            <p>
              Use the email address associated with this operator-issued{' '}
              {accountLink.kind === 'enroll' ? 'enrollment' : 'recovery'} link.
            </p>
          )}
          <button
            type="button"
            className="auth-button"
            onClick={onLeaveAccountLink}
          >
            Back to sign in
          </button>
        </div>
      )}

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

      {isLogin || !accountLink?.code || accountLink.invalid ? (
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
      ) : accountLink.kind === 'enroll' ? (
        <form
          className="auth-form"
          onSubmit={(event) => void handleRegister(event)}
          noValidate
        >
          <h3 ref={modeHeadingRef} tabIndex={-1} className="auth-form-title">
            Enroll account
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
            {submitting === 'register' ? 'Creating…' : 'Enroll account'}
          </button>
        </form>
      ) : (
        <form
          className="auth-form"
          onSubmit={(event) => void handleRecover(event)}
          noValidate
        >
          <h3 className="auth-form-title">Recover account</h3>
          <div className="auth-field">
            <label htmlFor="recover-email">Email</label>
            <input
              id="recover-email"
              type="email"
              autoComplete="email"
              inputMode="email"
              maxLength={254}
              required
              value={recoverEmail}
              onChange={(event) => setRecoverEmail(event.target.value)}
              aria-invalid={Boolean(fieldErrors.recoverEmail)}
              aria-describedby={
                fieldErrors.recoverEmail ? 'recover-email-error' : undefined
              }
            />
            {fieldErrors.recoverEmail && (
              <p id="recover-email-error" role="alert" className="auth-error">
                {fieldErrors.recoverEmail}
              </p>
            )}
          </div>
          <div className="auth-field">
            <label htmlFor="recover-password">New password</label>
            <input
              id="recover-password"
              type="password"
              autoComplete="new-password"
              required
              value={recoverPassword}
              onChange={(event) => setRecoverPassword(event.target.value)}
              aria-invalid={Boolean(fieldErrors.recoverPassword)}
              aria-describedby="recover-password-hint recover-password-error"
            />
            <p id="recover-password-hint" className="auth-hint">
              {PASSWORD_HINT}
            </p>
            {fieldErrors.recoverPassword && (
              <p
                id="recover-password-error"
                role="alert"
                className="auth-error"
              >
                {fieldErrors.recoverPassword}
              </p>
            )}
          </div>
          <div className="auth-field">
            <label htmlFor="recover-confirm">Confirm new password</label>
            <input
              id="recover-confirm"
              type="password"
              autoComplete="new-password"
              required
              value={recoverConfirm}
              onChange={(event) => setRecoverConfirm(event.target.value)}
              aria-invalid={Boolean(fieldErrors.recoverConfirm)}
              aria-describedby={
                fieldErrors.recoverConfirm ? 'recover-confirm-error' : undefined
              }
            />
            {fieldErrors.recoverConfirm && (
              <p id="recover-confirm-error" role="alert" className="auth-error">
                {fieldErrors.recoverConfirm}
              </p>
            )}
          </div>
          <button
            className="auth-button"
            type="submit"
            disabled={submitting !== null}
          >
            {submitting === 'recover' ? 'Updating…' : 'Update password'}
          </button>
        </form>
      )}
    </section>
  );
}
