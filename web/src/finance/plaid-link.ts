/**
 * Lazy Plaid Link loader (no npm dependency). The provider
 * script is fetched only after an explicit user gesture starts a link or
 * reconnect attempt; it is never prefetched, preloaded, or bundled.
 *
 * Token privacy: link and public tokens live in component memory only. This
 * module never reads, writes, or forwards a token — it only loads the
 * script and constructs a handler for a caller-supplied token. No
 * localStorage, sessionStorage, URL, log, or persistent state is touched.
 */

export const PLAID_LINK_SCRIPT_URL =
  'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
export const PLAID_LINK_SCRIPT_ID = 'housesync-plaid-link';

export interface PlaidLinkSuccessMetadata {
  readonly linkSessionId?: string | undefined;
}

export interface PlaidLinkExitError {
  readonly errorCode?: string | undefined;
  readonly errorMessage?: string | undefined;
  readonly displayMessage?: string | undefined;
}

export interface PlaidLinkExitMetadata {
  readonly status?: string | undefined;
  readonly linkSessionId?: string | undefined;
  readonly requestId?: string | undefined;
}

export interface PlaidLinkOptions {
  readonly token: string;
  readonly onSuccess: (
    publicToken: string,
    metadata: PlaidLinkSuccessMetadata,
  ) => void;
  readonly onExit?: (
    error: PlaidLinkExitError | null,
    metadata: PlaidLinkExitMetadata,
  ) => void;
  readonly onEvent?: (eventName: string) => void;
}

export interface PlaidLinkHandler {
  open(): void;
  destroy(): void;
}

export interface PlaidNamespace {
  create(options: PlaidLinkOptions): PlaidLinkHandler;
}

declare global {
  interface Window {
    Plaid?: PlaidNamespace | undefined;
  }
}

type ScriptState = 'idle' | 'loading' | 'ready' | 'failed';

let scriptState: ScriptState = 'idle';
let pending: Array<{
  resolve: (plaid: PlaidNamespace) => void;
  reject: (error: Error) => void;
}> = [];

/** Resettable for tests only; production code never re-arms the loader. */
export function resetPlaidLoaderForTests(): void {
  scriptState = 'idle';
  pending = [];
  if (typeof document !== 'undefined') {
    document.getElementById(PLAID_LINK_SCRIPT_ID)?.remove();
  }
}

function settleReady(plaid: PlaidNamespace): void {
  scriptState = 'ready';
  const waiting = pending;
  pending = [];
  for (const entry of waiting) entry.resolve(plaid);
}

function settleFailed(error: Error): void {
  scriptState = 'failed';
  const waiting = pending;
  pending = [];
  for (const entry of waiting) entry.reject(error);
}

/**
 * Load the Plaid Link script on demand. Safe to call concurrently: one
 * script element is ever created and every caller settles together. A
 * failure resets to idle so a later explicit retry loads again.
 */
export function loadPlaidLinkScript(
  documentRef: Document = document,
): Promise<PlaidNamespace> {
  const existing = window.Plaid;
  if (existing) {
    scriptState = 'ready';
    return Promise.resolve(existing);
  }
  if (scriptState === 'ready' && window.Plaid) {
    return Promise.resolve(window.Plaid);
  }
  return new Promise<PlaidNamespace>((resolve, reject) => {
    pending.push({ resolve, reject });
    if (scriptState === 'loading') return;
    scriptState = 'loading';
    const onLoad = () => {
      if (window.Plaid) {
        settleReady(window.Plaid);
      } else {
        settleFailed(
          new Error('The bank-link helper loaded but did not start. Retry.'),
        );
      }
    };
    const onError = () => {
      documentRef.getElementById(PLAID_LINK_SCRIPT_ID)?.remove();
      settleFailed(
        new Error(
          'The bank-link helper could not be loaded. Check your connection and retry.',
        ),
      );
    };
    try {
      let script = documentRef.getElementById(
        PLAID_LINK_SCRIPT_ID,
      ) as HTMLScriptElement | null;
      if (!script) {
        script = documentRef.createElement('script');
        script.id = PLAID_LINK_SCRIPT_ID;
        script.src = PLAID_LINK_SCRIPT_URL;
        script.async = true;
        script.referrerPolicy = 'no-referrer';
        // Plaid's official direct script does not advertise CORS, so setting
        // crossOrigin would block it. Its stable bundle also rotates, making
        // a pinned SRI hash impractical. Production instead requires the
        // reviewed provider-host CSP; this module changes no CSP itself.
        documentRef.head.appendChild(script);
      }
      script.addEventListener('load', onLoad, { once: true });
      script.addEventListener('error', onError, { once: true });
      // When reusing an in-flight element created above or elsewhere, the
      // fresh listeners settle the queue.
    } catch {
      settleFailed(
        new Error('The bank-link helper could not be started. Retry.'),
      );
    }
  });
}

/**
 * Create a Link handler for a caller-held token. The token is passed
 * straight through to the provider; this module retains no copy.
 */
export function createPlaidHandler(
  plaid: PlaidNamespace,
  options: PlaidLinkOptions,
): PlaidLinkHandler {
  return plaid.create(options);
}
