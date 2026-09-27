import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { AuthSection } from './auth/AuthSection';
import {
  clearAccountLinkFragment,
  readAccountLinkRoute,
  type AccountLinkRoute,
} from './auth/route';
import { HealthStatus } from './HealthStatus';
import {
  clearJoinFragment,
  readJoinRoute,
  type JoinRouteState,
} from './invitation/route';

export function App() {
  // The invitation capability lives here, above the anonymous/authenticated
  // branches and the user-keyed household components, so registration and
  // sign-in within this tab never drop it. It is memory only: never web
  // storage, query, path, log, title, or analytics.
  const [joinState, setJoinState] = useState<JoinRouteState>(() =>
    readJoinRoute(),
  );
  const [accountLink, setAccountLink] = useState<AccountLinkRoute | null>(() =>
    readAccountLinkRoute(),
  );

  // Strip the fragment immediately after extraction so the secret does not
  // linger in the visible URL or history entries.
  useLayoutEffect(() => {
    if (accountLink && window.location.hash) clearAccountLinkFragment();
    if (joinState.invite) {
      clearJoinFragment(joinState.invite.invitationId);
    } else if (window.location.hash.startsWith('#invite=')) {
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const next = readJoinRoute();
      const link = readAccountLinkRoute();
      if (link && window.location.hash) clearAccountLinkFragment();
      setAccountLink(link);
      // A history entry can carry a fragment (back/forward to the original
      // link): capture the capability and strip it immediately, just like
      // the initial load.
      if (next.invite) {
        clearJoinFragment(next.invite.invitationId);
      }
      setJoinState(next);
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  const handleInviteCleared = useCallback(() => {
    setJoinState((current) => ({ ...current, invite: null }));
  }, []);

  const handleLeaveJoin = useCallback(() => {
    // Leaving the flow discards the in-memory secret; recovery is to
    // reopen the original link.
    window.history.pushState(null, '', '/');
    setJoinState({ joinActive: false, joinInvalid: false, invite: null });
  }, []);

  const leaveAccountLink = useCallback(() => {
    window.history.pushState(null, '', '/');
    setAccountLink(null);
  }, []);

  return (
    <div className="shell">
      <header className="site-header">
        <span className="identity">
          <svg
            className="brand-mark"
            viewBox="0 0 32 32"
            fill="none"
            aria-hidden="true"
          >
            <path d="M5 15 16 5l11 10v12h-8v-8h-6v8H5Z" />
          </svg>
          HouseSync
        </span>
        <span className="area-badge">Private categorization</span>
      </header>

      <main id="main-content">
        <section className="intro" aria-labelledby="welcome-title">
          <p className="eyebrow">A little more together.</p>
          <h1 id="welcome-title">A shared home for household finances.</h1>
          <p className="intro-copy">
            HouseSync is taking shape: a place to understand household spending
            together, with room for personal privacy.
          </p>
        </section>

        <section className="foundation" aria-labelledby="foundation-title">
          <div className="foundation-copy">
            <p className="eyebrow">Where we are</p>
            <h2 id="foundation-title">
              Manual finance, private bank sync, and categorization.
            </h2>
            <p>
              Accounts, sign-in, and household collaboration are available.
              Private manual accounts and transactions include categories,
              selected household sharing, exact splits, member balances, and
              per-currency spending summaries. Bank linking admits the accounts
              you choose; only entries you confirm reach the ledger. You can
              reuse your own category decisions for future exact merchant
              matches with private rules. Existing entries never change
              automatically, and no bank balance is inferred.
            </p>
          </div>
          <HealthStatus />
        </section>

        <AuthSection
          invite={joinState.invite}
          joinActive={joinState.joinActive}
          joinInvalid={joinState.joinInvalid}
          onInviteCleared={handleInviteCleared}
          onLeaveJoin={handleLeaveJoin}
          accountLink={accountLink}
          onLeaveAccountLink={leaveAccountLink}
        />
      </main>

      <footer className="site-footer">
        <p>HouseSync · Built for the household, mindful of the individual.</p>
        <p>
          Private bank sync and review — imported activity stays owner-private
          until you confirm it. Balances are never inferred.
        </p>
      </footer>
    </div>
  );
}
