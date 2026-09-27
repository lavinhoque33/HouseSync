import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { AuthSection } from './auth/AuthSection';
import {
  clearAccountLinkFragment,
  readAccountLinkRoute,
  type AccountLinkRoute,
} from './auth/route';
import {
  clearJoinFragment,
  readJoinRoute,
  type JoinRouteState,
} from './invitation/route';
import { AppLink, NavigationMenu } from './NavigationMenu';
import {
  NAVIGATION_EVENT,
  navigate,
  readAppRoute,
  type AppRoute,
} from './navigation';

const pageNames: Record<string, string> = {
  overview: 'Overview',
  transactions: 'Transactions',
  accounts: 'Accounts',
  connections: 'Bank connections',
  'bank-activity': 'Bank activity',
  members: 'Members',
  invitations: 'Invitations',
  reviews: 'Reviews',
  rules: 'Rules',
  balances: 'Balances',
  repayments: 'Repayments',
  contributions: 'Contributions',
  insights: 'Insights',
};

function routeTitle(route: AppRoute): string {
  switch (route.kind) {
    case 'home':
      return 'Home';
    case 'security':
      return 'Profile Settings';
    case 'directory':
      return 'Households';
    case 'household-create':
      return 'Create household';
    case 'household':
      return pageNames[route.page] ?? 'Household';
    case 'link':
      return 'Account and invitation link';
    case 'not-found':
      return 'Page not found';
  }
}

export function App() {
  // Invitation and operator capabilities stay in memory above authentication.
  const [joinState, setJoinState] = useState<JoinRouteState>(() =>
    readJoinRoute(),
  );
  const [accountLink, setAccountLink] = useState<AccountLinkRoute | null>(() =>
    readAccountLinkRoute(),
  );
  const [route, setRoute] = useState<AppRoute>(() => readAppRoute());
  const titleRef = useRef<HTMLHeadingElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [headerProfileTarget, setHeaderProfileTarget] =
    useState<HTMLElement | null>(null);
  const [headerInboxTarget, setHeaderInboxTarget] =
    useState<HTMLElement | null>(null);
  const lastPathRef = useRef(window.location.pathname);

  useLayoutEffect(() => {
    if (accountLink && window.location.hash) clearAccountLinkFragment();
    if (joinState.invite) clearJoinFragment(joinState.invite.invitationId);
    else if (window.location.hash.startsWith('#invite=')) {
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search,
      );
    }
    // Initial extraction must not repeat when a controlled input changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onLocation = () => {
      document
        .querySelectorAll<HTMLDialogElement>('dialog.overlay[open]')
        .forEach((dialog) => dialog.close());
      const next = readJoinRoute();
      const link = readAccountLinkRoute();
      if (link && window.location.hash) clearAccountLinkFragment();
      if (next.invite) clearJoinFragment(next.invite.invitationId);
      setAccountLink(link);
      setJoinState(next);
      setRoute(readAppRoute());
    };
    window.addEventListener('popstate', onLocation);
    window.addEventListener(NAVIGATION_EVENT, onLocation);
    return () => {
      window.removeEventListener('popstate', onLocation);
      window.removeEventListener(NAVIGATION_EVENT, onLocation);
    };
  }, []);

  useLayoutEffect(() => {
    const name = routeTitle(route);
    document.title = `${name} · HouseSync`;
    if (lastPathRef.current !== window.location.pathname) {
      lastPathRef.current = window.location.pathname;
      titleRef.current?.focus({ preventScroll: true });
      if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        mainRef.current?.animate?.(
          [
            { opacity: 0.7, transform: 'translateY(6px)' },
            { opacity: 1, transform: 'translateY(0)' },
          ],
          { duration: 180, easing: 'cubic-bezier(.22,1,.36,1)' },
        );
      }
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    }
  }, [route]);

  const handleInviteCleared = useCallback(() => {
    setJoinState((current) => ({ ...current, invite: null }));
  }, []);
  const handleLeaveJoin = useCallback(() => {
    setJoinState({ joinActive: false, joinInvalid: false, invite: null });
    navigate('/');
  }, []);
  const leaveAccountLink = useCallback(() => {
    setAccountLink(null);
    navigate('/');
  }, []);

  return (
    <div className="shell">
      <header className="site-header">
        <NavigationMenu route={route} />
        <AppLink to="/" className="identity" current={route.kind === 'home'}>
          <svg
            className="brand-mark"
            viewBox="0 0 32 32"
            fill="none"
            aria-hidden="true"
          >
            <path d="M5 15 16 5l11 10v12h-8v-8h-6v8H5Z" />
          </svg>
          <span>
            House
            <wbr />
            Sync
          </span>
        </AppLink>
        <div className="header-actions">
          <span className="header-inbox-slot" ref={setHeaderInboxTarget} />
          <span className="header-profile-slot" ref={setHeaderProfileTarget} />
        </div>
      </header>
      <main id="main-content" ref={mainRef}>
        <div className="page-intro">
          <h1 ref={titleRef} tabIndex={-1}>
            {routeTitle(route)}
          </h1>
          {route.kind === 'home' && (
            <p>
              Keep your household finances together, with room for personal
              privacy.
            </p>
          )}
          {route.kind === 'not-found' && (
            <p>
              This page is not available. <AppLink to="/">Return home</AppLink>{' '}
              or visit <AppLink to="/households">households</AppLink>.
            </p>
          )}
        </div>
        <AuthSection
          headerProfileTarget={headerProfileTarget}
          headerInboxTarget={headerInboxTarget}
          route={route}
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
        HouseSync · Mindful of the individual.
      </footer>
    </div>
  );
}
